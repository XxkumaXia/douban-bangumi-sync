// 豆瓣适配器：没有公开 API，只能走网页端通道
// 读取：解析 mine 列表页 DOM（解析在 offscreen document 里做，service worker 没有 DOMParser）
// 写入：模拟网页端 interest 提交接口 + cookie 里的 ck(CNZZ CSRF token)，多策略探测
import { DOUBAN_STATUS_REVERSE, DOUBAN_SITE } from '../core/normalize.js';
import { findShareCheckbox, parseInterestFormFields } from './douban-parse.js';
import { getSettings, saveSettings } from '../lib/storage.js';

const PAGE_SIZE = 15;

// ---------------------------------------------------------------- 基础请求

export async function doubanFetch(url, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    credentials: 'include', // 关键：带上 .douban.com 的登录 cookie
    redirect: 'follow',
    headers: {
      Accept: opts.accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...(opts.headers || {}),
    },
  };
  if (opts.form) {
    init.body = new URLSearchParams(opts.form).toString();
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  } else if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers['Content-Type'] = 'application/json';
  } else if (opts.body !== undefined) {
    init.body = opts.body;
  }

  const res = await fetch(url, init);
  const text = await res.text();
  return { res, text, ok: res.ok, status: res.status, url: res.url };
}

/** 判断返回是不是登录墙 / 验证码 / 风控页 */
export function detectBlocked(res, text) {
  if (res.url && /accounts\.douban\.com|passport\.douban\.com|\/accounts\/login/.test(res.url)) {
    return { blocked: true, reason: '未登录或登录态失效，请先在浏览器里登录豆瓣' };
  }
  if (res.status === 403) return { blocked: true, reason: '403 拒绝访问，可能触发风控' };
  if (res.status === 429) return { blocked: true, reason: '429 请求过于频繁，请降低频率后重试' };
  if (/sec\.douban\.com|验证码|captcha|检测到有异常请求/.test(text || '')) {
    return { blocked: true, reason: '触发验证码或异常请求拦截，请在浏览器里手动过一次验证' };
  }
  if (/\u8bf7\u5148\u767b\u5f55|login_required/.test(text || '')) {
    return { blocked: true, reason: '页面提示需要登录' };
  }
  return { blocked: false };
}

// ---------------------------------------------------------------- 解析通道

/** 创建（或复用）offscreen document，用来拿到 DOMParser */
export async function ensureOffscreen() {
  const existing = await chrome.runtime
    .getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    .catch(() => []);
  if (!existing?.length) {
    try {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/parse.html',
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: '豆瓣列表页是 HTML，需要 DOMParser 提取条目信息',
      });
    } catch (e) {
      if (!/already exists|Only a single/i.test(String(e.message))) throw e;
    }
  }
  // 文档刚创建时脚本可能还没注册监听，轮询 ping 直到就绪
  for (let i = 0; i < 30; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'PARSE_PING' });
      if (r?.ok) return true;
    } catch {
      /* 还没就绪 */
    }
    await sleep(80);
  }
  throw new Error('offscreen 解析文档启动失败');
}

/** 把 HTML 丢给 offscreen 解析 */
async function parseHtml(html, site, status) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({
    type: 'PARSE_DOUBAN_LIST',
    payload: { html, site, status },
  });
  if (!resp?.ok) throw new Error(resp?.error || '解析失败');
  return resp.data;
}

// ---------------------------------------------------------------- ck

/** 读取豆瓣 CSRF token（cookie 名 ck） */
export async function getCk() {
  for (const site of ['movie', 'book', 'music']) {
    const host = DOUBAN_SITE[site].host;
    const c = await chrome.cookies.get({ url: `https://${host}/`, name: 'ck' });
    if (c?.value) return c.value;
  }
  const any = await chrome.cookies.getAll({ domain: 'douban.com', name: 'ck' });
  return any?.[0]?.value || '';
}

// ---------------------------------------------------------------- 读取

function listUrl(site, status, start) {
  const host = DOUBAN_SITE[site].host;
  return `https://${host}/mine?status=${status}&start=${start}&type=list`;
}

/**
 * 抓取一个豆瓣列表（某站点 + 某状态）的全部条目
 */
export async function fetchList(opts) {
  const { site, status, maxPages = 1000, onProgress, signal } = opts;
  const settings = await getSettings();
  const delay = settings.readDelayMs ?? 800;
  const max = settings.maxItemsPerList || 0;

  const all = [];
  const seen = new Set();
  let start = 0;
  let page = 0;
  let nextHref = null;
  let uid = null;
  let matchedSelector = null;

  while (page < maxPages) {
    if (signal?.aborted) break;
    const url = nextHref
      ? new URL(nextHref, `https://${DOUBAN_SITE[site].host}/mine`).toString()
      : listUrl(site, status, start);

    const { res, text } = await doubanFetch(url);
    const blocked = detectBlocked(res, text);
    if (blocked.blocked) {
      throw Object.assign(new Error(blocked.reason), { code: 'BLOCKED' });
    }

    const parsed = await parseHtml(text, site, status);
    matchedSelector = parsed.matchedSelector || matchedSelector;
    if (parsed.userUid) uid = parsed.userUid;

    let added = 0;
    for (const it of parsed.items) {
      const key = it.id;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(it);
      added++;
    }

    if (typeof onProgress === 'function') {
      onProgress({ site, status, page: page + 1, count: all.length, added });
    }

    if (max && all.length >= max) break;
    if (!parsed.items.length) break; // 空页，结束
    if (added === 0 && page > 0) break; // 整页重复，说明到底了
    if (!parsed.nextUrl) {
      // 没有 next 链接时按固定步长推进
      if (parsed.items.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
    } else {
      nextHref = parsed.nextUrl;
      const m = String(parsed.nextUrl).match(/start=(\d+)/);
      start = m ? Number(m[1]) : start + PAGE_SIZE;
    }

    page++;
    await sleep(delay);
  }

  return { items: all, uid, matchedSelector };
}

/**
 * 读取单个条目的当前收藏状态
 * 首选移动端 rexxar 接口，失败则退回抓条目页 DOM
 */
export async function readInterest(site, subjectId) {
  const kind = site === 'book' ? 'book' : site === 'music' ? 'music' : 'movie';
  const url = `https://m.douban.com/rexxar/api/v2/${kind}/${subjectId}/interest`;
  try {
    const { res, text } = await doubanFetch(url, { accept: 'application/json' });
    if (res.ok) {
      const data = JSON.parse(text);
      return { ok: true, via: 'rexxar', data };
    }
  } catch {
    /* fall through */
  }
  return { ok: false, via: null, data: null };
}

// 回读接口里见到的状态值 -> 内部状态。豆瓣各套接口的叫法不统一
// （网页端 wish/do/collect，部分接口用 wish/doing/done），两边都收下
// 豆瓣收藏状态值的中文名，只用于把演练结果说清楚
const DOUBAN_STATUS_LABEL = { wish: '想看', do: '在看', collect: '看过' };

const READ_STATUS_MAP = {
  wish: 'wish',
  do: 'doing',
  doing: 'doing',
  collect: 'done',
  done: 'done',
};

/**
 * 写入后回读：豆瓣「接口返回成功」不等于「真的写对了」。
 * 用户报的「Bangumi 的『在看』同步过去变成了『看过』」，只有回读才分得清
 * 是我们发错了状态值，还是豆瓣自己把状态改了 —— 所以校验结果一律原样带回去，
 * 认不出的原文字段也贴出来，不做猜测。
 *
 * @returns {Promise<{ok:boolean, status?:string|null, rawStatus?:string|null, raw?:string, reason?:string}>}
 */
export async function verifyInterest(site, subjectId) {
  const r = await readInterest(site, subjectId);
  if (!r.ok || !r.data) {
    return { ok: false, reason: '回读失败（没能取到豆瓣上的当前收藏状态），本次未做校验' };
  }
  const raw = r.data || {};
  const rawStatus = raw.status ?? raw.interest_status ?? raw.state ?? null;
  return {
    ok: true,
    status: READ_STATUS_MAP[String(rawStatus || '').toLowerCase()] || null,
    rawStatus: rawStatus == null ? null : String(rawStatus),
    raw: JSON.stringify(raw).slice(0, 300),
  };
}

// ---------------------------------------------------------------- 分享到广播

// 探测结果在本进程内缓存，避免每条都去 GET 一次弹窗
let shareFieldCache = null;

/**
 * 只读地取一次豆瓣收藏弹窗的 HTML。
 * 这是唯一能拿到豆瓣真实表单字段名的入口 —— 它是豆瓣自己渲染给自家前端用的。
 * @returns {Promise<string>} 拿不到时返回空串
 */
async function fetchInterestHtml(site, subjectId) {
  const host = DOUBAN_SITE[site || 'movie'].host;
  const url = `https://${host}/j/subject/${subjectId}/interest`;
  try {
    const { res, text } = await doubanFetch(url, { accept: 'application/json, text/html, */*' });
    if (!res.ok) return '';
    let html = text || '';
    try {
      const j = JSON.parse(html);
      // 网页端这个接口返回 JSON，弹窗 HTML 在 html 字段里
      if (j && typeof j.html === 'string') html = j.html;
    } catch {
      /* 直接就是 HTML */
    }
    return html;
  } catch {
    return '';
  }
}

/**
 * 自检：把豆瓣自己渲染的收藏表单字段原样读出来。
 *
 * 用途是回答那些只能靠实测的问题 —— 状态字段到底叫 status 还是 interest、
 * 评分字段叫什么、以及表单里是否真的带评分控件。以前这些全是猜的，
 * 「在看被写成看过」就只能编一个理由。现在让豆瓣自己说，识别结果存进 settings，
 * 之后的写入请求按实测到的字段名发。
 *
 * @returns {Promise<{ok:boolean, reason?:string, htmlLength:number, fields:Array, statusField:object|null, ratingField:object|null, shareField:object|null, applied:string|null}>}
 */
export async function probeInterestForm(site, subjectId) {
  const html = await fetchInterestHtml(site, subjectId);
  if (!html) {
    return {
      ok: false,
      reason: '没能读到豆瓣收藏弹窗（条目 ID 不对、未登录、或被风控拦截）',
      htmlLength: 0,
      fields: [],
      statusField: null,
      ratingField: null,
      shareField: null,
      applied: null,
    };
  }
  const parsed = parseInterestFormFields(html);
  // 一次把语义字段的真名都记下来：status / rating / tags / private。
  // 认不出某一项就留 null —— 该项回落默认名，宁可可能失效也不瞎填。
  const nameOf = (f) => f?.name || null;
  const fields = {
    status: nameOf(parsed.statusField),
    rating: nameOf(parsed.ratingField),
    tags: parsed.fields.some((f) => f.name === 'tags') ? 'tags' : null,
    private: nameOf(parsed.privateField),
  };
  await saveSettings({
    doubanInterestFields: fields,
    doubanStatusField: parsed.statusField ? { name: parsed.statusField.name, options: parsed.statusField.options } : null,
  });
  return { ok: true, ...parsed, fields: parsed.fields, applied: fields.status };
}

/**
 * 找出「分享到豆瓣广播」的真实字段名。
 *
 * 豆瓣没有公开它自己的收藏接口文档，字段名只能从它自己渲染的收藏弹窗里读出来。
 * 读取顺序：内存缓存 → settings 里上次探测到的 → 现场 GET 一次弹窗 HTML 解析。
 * 现场探测成功就写回 settings，之后不再重复请求。
 *
 * @returns {Promise<{name:string, value:string, checked:boolean, via:string}|null>} 识别不出时返回 null
 */
export async function resolveShareField(site, subjectId, { refresh = false } = {}) {
  if (!refresh) {
    if (shareFieldCache) return shareFieldCache;
    const saved = (await getSettings()).doubanShareField;
    if (saved?.name) {
      shareFieldCache = saved;
      return saved;
    }
  }

  const html = await fetchInterestHtml(site, subjectId);
  if (!html) return null;

  const found = findShareCheckbox(html);
  if (found?.name) {
    await saveSettings({ doubanShareField: found });
    shareFieldCache = found;
  }
  return found;
}

/** 自检用：显式重探一次，并带回原文长度好判断接口有没有返回东西 */
export async function probeShareField(site, subjectId) {
  shareFieldCache = null;
  const before = (await getSettings()).doubanShareField;
  const found = await resolveShareField(site, subjectId, { refresh: true });
  return { found, cachedBefore: before };
}

// ---------------------------------------------------------------- 写入

/**
 * 写入策略清单。按顺序尝试，成功的那个会被记进 settings.doubanWriteStrategy
 * mode: 'form' 表单提交 | 'json' JSON 提交
 */
export const WRITE_STRATEGIES = [
  {
    key: 'j-interest',
    label: '网页端 /j/subject/{id}/interest',
    build: (ctx) => ({
      url: `https://${ctx.host}/j/subject/${ctx.subjectId}/interest`,
      mode: 'form',
      form: buildForm(ctx),
    }),
  },
  {
    key: 'rexxar-interest',
    label: '移动端 rexxar interest',
    build: (ctx) => ({
      url: `https://m.douban.com/rexxar/api/v2/${ctx.kind}/${ctx.subjectId}/interest`,
      mode: 'form',
      form: buildForm(ctx),
    }),
  },
  {
    key: 'frodo-interest',
    label: '移动端 frodo interest',
    build: (ctx) => ({
      url: `https://frodo.douban.com/api/v2/${ctx.kind}/${ctx.subjectId}/interest`,
      mode: 'form',
      form: { ...buildForm(ctx), apiKey: '0dad551ec0f84ed02907ff5c42e8ec70' },
    }),
  },
];

// 我们给字段起的默认名 -> 豆瓣表单里的语义。默认名是猜的，实测名从豆瓣自己的弹窗里读
// （2026-09-27 用户实测 1292052：status 实际叫 interest、privacy 实际叫 private）
const FIELD_DEFAULTS = { status: 'status', rating: 'rating', tags: 'tags', private: 'privacy' };

/**
 * 写一个字段：默认名照发，实测到的真名也发一份。
 * 服务端会忽略不认识的字段，所以「两个都发」既不会因为改名而失效，也不会因为猜错而静默丢设置。
 */
function putField(f, key, ctx, value) {
  const def = FIELD_DEFAULTS[key];
  f[def] = value;
  const real = ctx.fields?.[key];
  if (real && real !== def) f[real] = value;
}

function buildForm(ctx) {
  // 状态不再允许「缺席」：表单里没有 status 字段时，豆瓣会按它自己的默认处理，
  // 实践表现为被标成「看过」—— 用户的「在看」就是这么丢的。与其猜，不如拒绝写入。
  if (!DOUBAN_STATUS_REVERSE[ctx.status]) {
    throw new Error(
      `写豆瓣失败：拿不到这条要写成的收藏状态（收到「${ctx.status}」，合法值 wish/doing/done）。` +
        `到设置页把「同步内容 → 收藏状态」勾上再试`
    );
  }
  const f = { ck: ctx.ck };
  putField(f, 'status', ctx, DOUBAN_STATUS_REVERSE[ctx.status]);
  if (ctx.rating != null) putField(f, 'rating', ctx, String(ctx.rating));
  if (ctx.comment != null) f.comment = ctx.comment;
  if (ctx.tags?.length) putField(f, 'tags', ctx, ctx.tags.join(' '));
  // 「仅自己可见」是个 checkbox：豆瓣只认「字段出现且为真」（实测字段名 private）。
  // 不发就是公开，这比发 privacy=0 安全 —— 万一豆瓣把字符串 "0" 当真值，
  // 你的收藏会被悄悄设成仅自己可见，而且没有任何报错。
  if (ctx.private) putField(f, 'private', ctx, 'on');
  // 「分享到豆瓣广播」：字段名是从豆瓣自己的收藏弹窗里实测读出来的（见 resolveShareField），
  // 不是写死的猜测。只有开关打开、且真的读到了字段名，才会带上这个参数。
  if (ctx.shareField?.name) f[ctx.shareField.name] = ctx.shareField.value || 'on';
  return f;
}

/**
 * 标签页通道：把请求交给一个已打开的豆瓣页面，在页面上下文里发出去。
 * 这样 cookie 与 Referer/Origin 都由浏览器按真实站点规则生成，是最可靠的一条路。
 * 代价是需要用户至少开着一个豆瓣页面。
 */
export async function writeViaTab(req) {
  const tabs = await chrome.tabs.query({ url: ['https://*.douban.com/*'] });
  if (!tabs.length) {
    return { ok: false, error: '没有打开的豆瓣页面，标签页通道不可用' };
  }
  // 优先挑界面站（movie/book/music），没有就用任意豆瓣页
  const preferred = tabs.find((t) => /^https:\/\/(movie|book|music)\.douban\.com/.test(t.url || '')) || tabs[0];

  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: preferred.id },
      world: 'MAIN', // 页面上下文，带着站点真实的 origin
      args: [req],
      func: async (r) => {
        try {
          const res = await fetch(r.url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: new URLSearchParams(r.form).toString(),
          });
          const text = await res.text();
          return { ok: res.ok, status: res.status, text: text.slice(0, 400) };
        } catch (e) {
          return { ok: false, status: 0, text: String(e && e.message) };
        }
      },
    });
    return out?.result || { ok: false, error: '注入执行无返回' };
  } catch (e) {
    return { ok: false, error: `注入失败: ${e.message}` };
  }
}

/**
 * 写入一次收藏（内部状态/评分/短评）
 * @param {object} args { site, subjectId, status, rating(1-5), comment, tags }
 * @param {object} opts { strategy: 'auto'|策略key|'tab', dryRun, useTab }
 */
export async function writeInterest(args, opts = {}) {
  const settings = await getSettings();
  const site = args.site || 'movie';
  const host = DOUBAN_SITE[site].host;
  const kind = site === 'book' ? 'book' : site === 'music' ? 'music' : 'movie';
  const ck = await getCk();
  if (!ck) throw new Error('取不到豆瓣 ck（CSRF token），请确认已在浏览器登录豆瓣');

  // 分享到广播：开关打开时才去解析字段名（解析要发一次 GET，不做无谓请求）
  const wantShare = args.share ?? settings.shareToBroadcast ?? false;
  let shareField = null;
  let shareNote = null;
  if (wantShare) {
    shareField = args.shareField || (await resolveShareField(site, args.subjectId));
    if (!shareField) {
      shareNote = '没能从豆瓣收藏弹窗里识别出「分享到广播」的字段名，本次不会附带该参数（收藏本身照常写入）';
    }
  }

  const ctx = {
    host,
    kind,
    subjectId: args.subjectId,
    status: args.status,
    // 实测到的字段名（设置页「读取收藏表单字段」探测后写入 settings.doubanInterestFields）
    fields: {
      status: settings.doubanInterestFields?.status || settings.doubanStatusField?.name || null,
      rating: settings.doubanInterestFields?.rating || null,
      tags: settings.doubanInterestFields?.tags || null,
      private: settings.doubanInterestFields?.private || null,
    },
    rating: args.rating ?? null,
    comment: args.comment ?? null,
    tags: args.tags || [],
    private: !!args.private,
    shareField,
    ck,
  };

  // 通道模式：background 只走后台请求；tab 只走标签页注入；auto 先后台、失败再试标签页
  const channel = opts.channel || settings.doubanWriteChannel || 'auto';

  let order =
    opts.strategy && opts.strategy !== 'auto'
      ? WRITE_STRATEGIES.filter((s) => s.key === opts.strategy)
      : WRITE_STRATEGIES;
  if (channel === 'tab') order = [WRITE_STRATEGIES[0]];

  const attempts = [];

  // 分享到广播的最终情况：给调用方一句能直接显示的话，别让它猜
  const shareInfo = () => ({
    requested: !!wantShare,
    applied: !!shareField?.name,
    field: shareField ? { name: shareField.name, value: shareField.value, via: shareField.via } : null,
    note: shareNote,
  });

  if (channel === 'tab' && !opts.dryRun) {
    const req = order[0].build(ctx);
    const r = await writeViaTab(req);
    attempts.push({ key: 'tab', label: '标签页注入', ok: r.ok, status: r.status, detail: r.text || r.error });
    if (r.ok) return { ok: true, used: 'tab', attempts, share: shareInfo() };
    return { ok: false, used: null, attempts, share: shareInfo() };
  }

  for (const st of order) {
    const req = st.build(ctx);
    if (opts.dryRun) {
      attempts.push({ key: st.key, label: st.label, dryRun: true, request: req, checks: checkRequest(req, ctx) });
      continue;
    }
    try {
      const { res, text } = await doubanFetch(req.url, {
        method: 'POST',
        form: req.mode === 'form' ? req.form : undefined,
        json: req.mode === 'json' ? req.form : undefined,
        accept: 'application/json, text/plain, */*',
      });
      const blocked = detectBlocked(res, text);
      const parsed = safeJson(text);
      const looksOk = res.ok && !blocked.blocked && !/^{"?error/.test(text || '');
      attempts.push({
        key: st.key,
        label: st.label,
        status: res.status,
        ok: looksOk,
        blocked: blocked.blocked,
        reason: blocked.reason || null,
        response: parsed,
      });
      if (looksOk) {
        if (settings.doubanWriteStrategy !== st.key) {
          await saveSettings({ doubanWriteStrategy: st.key });
        }
        return { ok: true, used: st.key, attempts, response: parsed, share: shareInfo() };
      }
    } catch (e) {
      attempts.push({ key: st.key, label: st.label, ok: false, error: String(e.message) });
    }
  }

  // 后台通道全军覆没：auto 模式下退到标签页注入再试一次
  //
  // 注意 !opts.dryRun：标签页注入是真的把请求发出去，演练绝不能走这条路。
  // （曾经的 bug：auto 通道下没拦住，导致设置页的「检查豆瓣写入（演练）」会真的写一条收藏）
  if (channel === 'auto' && !opts.dryRun) {
    const req = WRITE_STRATEGIES[0].build(ctx);
    const r = await writeViaTab(req);
    attempts.push({ key: 'tab', label: '标签页注入（兜底）', ok: r.ok, status: r.status, detail: r.text || r.error });
    if (r.ok) {
      await saveSettings({ doubanWriteChannel: 'tab' });
      return { ok: true, used: 'tab', attempts, share: shareInfo() };
    }
  }

  return { ok: false, used: null, attempts, share: shareInfo() };
}

/**
 * 演练专用：静态检查构造出的请求是否「看起来可发送」。
 *
 * 重要边界：这只能证明**请求构造正确**，不能证明豆瓣会接受。
 * 豆瓣是否放行取决于登录态、风控、接口是否还在 —— 那只有真发一次才知道。
 */
export function checkRequest(req, ctx = {}) {
  const checks = [];
  // level: 'ok' | 'warn' | 'fail'。warn 表示「能发，但有隐患」，不影响 ready 判定
  const add = (name, ok, detail, level) =>
    checks.push({ name, ok, detail, level: level || (ok ? 'ok' : 'fail') });
  const url = String(req?.url || '');
  const form = req?.form || {};

  add('URL 指向豆瓣接口', /^https:\/\/[a-z0-9.-]+\.douban\.com\//i.test(url), url || '(空)');
  add(
    'URL 含条目 ID',
    ctx.subjectId ? url.includes(String(ctx.subjectId)) : false,
    ctx.subjectId ? String(ctx.subjectId) : '未提供条目 ID'
  );
  add(
    '表单带 ck（CSRF）',
    !!form.ck,
    form.ck ? `${String(form.ck).slice(0, 4)}…（已取到）` : '缺失 —— 豆瓣会直接拒绝'
  );
  const payloadKeys = Object.keys(form).filter((k) => k !== 'ck' && k !== 'apiKey');
  add(
    '表单有实际内容',
    payloadKeys.length > 0,
    payloadKeys.length ? payloadKeys.join(', ') : '只有 ck，没有任何要写入的字段'
  );

  // 状态 + 评分同时提交时的提示。
  // 注意：这一条不是「豆瓣会把它升级成看过」的结论 —— 那是我之前的猜测，没有实测依据，
  // 且用户在豆瓣实测「在看」是可以打分的。所以这里只做如实展示，不做因果断言：
  // 真出了状态被改写，由写入后的回读校验（verifyInterest）报出来。
  const st = String(form.status || '');
  const rating = Number(form.rating || 0);
  // ok 恒为 true：只提醒、不阻塞。ready 的判定是 checks.every(c => c.ok)
  add(
    '状态与评分',
    true,
    `状态 ${st || '(缺失)'}（${DOUBAN_STATUS_LABEL[st] || '未知'}）` +
      (rating ? ` + 评分 ${rating}` : ' · 无评分'),
    'ok'
  );

  // 状态字段名是不是实测过的：没实测就提醒去读一次，别让字段名错得无声无息。
  // 实测证据：2026-09-27 用户在条目 1292052 上读到的是 interest（不是 status）
  const statusField = ctx.fields?.status;
  add(
    '状态字段名',
    true,
    statusField
      ? `按实测到的字段名发送：${statusField}（另有兼容字段 status）`
      : '用默认字段名 status —— 建议到设置页点「读取收藏表单字段」实测一次',
    statusField ? 'ok' : 'warn'
  );
  return checks;
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return String(t || '').slice(0, 300);
  }
}

// ---------------------------------------------------------------- 自检

/** 只读自检：验证登录态、ck、列表页结构是否还能解析 */
export async function probeRead(site = 'movie') {
  const result = { site, steps: [] };
  // level: ok | warn | fail —— warn 只在界面上提示，不影响整体通过与否
  const push = (name, ok, detail, level) =>
    result.steps.push({ name, ok, detail, level: level || (ok ? 'ok' : 'fail') });

  // 豆瓣标签页状态：写入的「标签页通道」依赖它；实践上浏览器里开着豆瓣页面时整条链路更稳
  const doubanTabs = await chrome.tabs
    .query({ url: ['https://*.douban.com/*'] })
    .catch(() => []);
  push(
    '豆瓣页面',
    doubanTabs.length > 0,
    doubanTabs.length
      ? `已打开 ${doubanTabs.length} 个豆瓣页面，标签页写入通道可用`
      : '当前没有打开豆瓣页面。读取一般仍能通过，但写入被拒时无法回退到标签页通道；建议先在浏览器打开并登录豆瓣',
    doubanTabs.length > 0 ? 'ok' : 'warn'
  );

  const ck = await getCk();
  push('读取 ck', !!ck, ck ? `ck=${ck.slice(0, 6)}…` : '未取到，可能未登录');

  const host = DOUBAN_SITE[site].host;
  const url = `https://${host}/mine?status=collect`;
  let res;
  let text;
  try {
    ({ res, text } = await doubanFetch(url));
  } catch (e) {
    push('访问列表页', false, e.message);
    result.ok = false;
    return result;
  }
  const blocked = detectBlocked(res, text);
  push('访问列表页', !blocked.blocked, blocked.reason || `HTTP ${res.status}, ${text.length} 字节`);

  if (blocked.blocked) {
    result.ok = false;
    return result;
  }

  let parsed = null;
  try {
    parsed = await parseHtml(text, site, 'collect');
  } catch (e) {
    push('解析列表页', false, e.message);
    result.ok = false;
    return result;
  }
  push(
    '解析列表页',
    parsed.items.length > 0,
    `选择器 ${parsed.matchedSelector || '未命中'}，解析出 ${parsed.items.length} 条` +
      (parsed.userUid ? `，识别到 uid ${parsed.userUid}` : '')
  );
  result.ok = parsed.items.length > 0;
  result.sample = parsed.items.slice(0, 3);
  result.matchedSelector = parsed.matchedSelector;
  return result;
}

/** 写入自检：默认 dryRun，只构造请求不发送 */
export async function probeWrite({ site = 'movie', subjectId, status = 'done', rating = 0, comment = '', dryRun = true } = {}) {
  if (!subjectId) return { ok: false, error: '需要提供一个豆瓣条目 ID' };

  // ck 单独先取一次：取不到时 writeInterest 会抛错，这里先拿到状态好给出明确结论
  const ck = await getCk();
  const out = await writeInterest({ site, subjectId, status, rating, comment }, { dryRun });

  const attempts = out.attempts || [];
  // ready 只表示「请求构造得完整」，不代表豆瓣会接受
  const ready = attempts.length > 0 && attempts.every((a) => (a.checks || []).every((c) => c.ok));

  return {
    ok: true,
    dryRun,
    ck: !!ck,
    constructed: attempts.length,
    ready,
    // 演练永远不会真正写入，用这个字段显式表达，避免调用方把 ok 误读成"写入成功"
    written: false,
    ...out,
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
