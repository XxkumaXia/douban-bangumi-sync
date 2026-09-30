// 后台服务：扫描两侧列表、跑条目匹配、执行同步、接口自检
import * as db from '../adapters/douban.js';
import * as bgm from '../adapters/bangumi.js';
import { resolve } from '../core/matcher.js';
import { resolveReverse } from '../core/reverse-matcher.js';
import { executePlan, persistMatch, persistManualMatch, persistSkip } from '../core/sync.js';
import { buildPlan } from '../core/diff.js';
import { BGM_SUBJECT_TYPE_REVERSE } from '../core/normalize.js';
import { installHeaderRules, inspectHeaderRules } from './header-rules.js';
import { getSettings, saveSettings, resetSettings, getMapping, getSnapshot, saveSnapshot, clearSnapshot, clearMapping, clearAll, appendLog, getLog, clearLog } from '../lib/storage.js';

const STATE = {
  scanning: false,
  matched: 0,
  abort: null,
  // 一键同步的「准备结果」缓存：prepare 与 confirm 之间不重复扫描
  prepared: null,
};

// 准备结果的有效期：超过就重新扫一遍，避免按着很旧的快照写入
const PREPARED_TTL = 10 * 60 * 1000;

// ---------------------------------------------------------------- 消息

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// 长连接：扫描期间推送进度
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sync') return;
  port.onMessage.addListener(async (msg) => {
    const send = (payload) => {
      try {
        port.postMessage({ id: msg.id, ...payload });
      } catch {
        /* 端口已关闭 */
      }
    };
    try {
      const data = await handle(msg, send);
      send({ type: 'done', data });
    } catch (e) {
      send({ type: 'error', error: String(e?.message || e) });
    }
  });
});

async function handle(msg, progress) {
  switch (msg.type) {
    case 'SETTINGS_GET':
      return getSettings();
    case 'SETTINGS_SET':
      return saveSettings(msg.payload);
    case 'SETTINGS_RESET':
      return resetSettings();
    case 'MAPPING_GET':
      return getMapping();
    case 'MAPPING_MANUAL': {
      const { doubanId, subject } = msg.payload;
      await persistManualMatch(doubanId, subject);
      return { ok: true };
    }
    case 'MAPPING_SKIP': {
      await persistSkip(msg.payload.doubanId);
      return { ok: true };
    }
    case 'MAPPING_CLEAR':
      await clearMapping();
      return { ok: true };
    case 'SNAPSHOT_GET':
      return getSnapshot();
    case 'CLEAR_SNAPSHOT':
      await clearSnapshot();
      return { ok: true };
    case 'LOG_GET':
      return getLog();
    case 'LOG_CLEAR':
      await clearLog();
      return { ok: true };
    case 'CLEAR_ALL':
      await clearAll();
      return { ok: true };
    case 'BGM_AUTH_CHECK':
      return bgm.checkAuth();
    case 'BGM_REFRESH':
      return bgm.refreshToken();
    case 'PROBE_DOUBAN':
      return db.probeRead(msg.payload?.site || 'movie');
    case 'PROBE_DOUBAN_WRITE':
      return db.probeWrite(msg.payload || {});
    case 'PROBE_BGM':
      return bgm.checkAuth();
    case 'PROBE_HEADER_RULES':
      return inspectHeaderRules();
    case 'PROBE_SHARE_FIELD':
      // 只读：GET 一次豆瓣收藏弹窗，解析出「分享到广播」的真实字段名
      return db.probeShareField(msg.payload?.site || 'movie', String(msg.payload?.subjectId || ''));
    case 'PROBE_INTEREST_FORM':
      // 只读：把豆瓣自己渲染的收藏表单字段原样读出来（状态/评分字段到底叫什么）
      return db.probeInterestForm(msg.payload?.site || 'movie', String(msg.payload?.subjectId || ''));
    case 'INSTALL_HEADER_RULES':
      return installHeaderRules();
    case 'DOUBAN_SEARCH_SUBJECT':
      return searchDoubanSubject(msg.payload);
    case 'SCAN':
      return scanAll(progress);
    case 'MATCH':
      return runMatch(msg.payload?.items, progress, msg.payload?.keys);
    case 'MATCH_FORWARD':
      // 待确认条目的批量反查 Bangumi：只对指定条目跑（通常是搜索筛出来的那几条）
      return runMatch(null, progress, msg.payload?.keys, { onlyUnmatched: true });
    case 'MATCH_ONE':
      // 单条「搜 Bangumi」：只搜这一条，把候选原样带回去给用户点选
      return matchOne(msg.payload?.key);
    case 'MATCH_REVERSE':
      return runReverseMatch(msg.payload, progress);
    case 'QUICK_SYNC':
      return quickSync(msg.payload, progress);
    case 'SYNC':
      return runSync(msg.payload, progress);
    default:
      throw new Error(`未知消息类型: ${msg.type}`);
  }
}

// ---------------------------------------------------------------- 扫描

async function scanAll(progress) {
  if (STATE.scanning) throw new Error('已有扫描在进行中');
  STATE.scanning = true;
  STATE.abort = new AbortController();
  const signal = STATE.abort.signal;

  const settings = await getSettings();
  const emit = (p) => progress?.({ type: 'progress', ...p });
  const log = (m) => appendLog(m);

  try {
    // --- 豆瓣 ---
    emit({ stage: 'douban', message: '开始抓取豆瓣…' });
    const doubanItems = [];
    const doubanMeta = {};
    const statuses = ['wish', 'do', 'collect'];
    for (const site of Object.keys(settings.doubanSites || {})) {
      if (!settings.doubanSites[site]) continue;
      for (const st of statuses) {
        if (signal.aborted) break;
        emit({ stage: 'douban', message: `豆瓣 ${site} / ${st}` });
        try {
          const r = await db.fetchList({
            site,
            status: st,
            signal,
            onProgress: (p) => emit({ stage: 'douban', message: `豆瓣 ${site}/${st} 第 ${p.page} 页，累计 ${p.count} 条`, ...p }),
          });
          doubanItems.push(...r.items);
          doubanMeta[site] = { uid: r.uid, selector: r.matchedSelector };
          log(`豆瓣 ${site}/${st} 抓到 ${r.items.length} 条`);
        } catch (e) {
          log(`豆瓣 ${site}/${st} 抓取失败: ${e.message}`);
          emit({ stage: 'douban', message: `豆瓣 ${site}/${st} 失败: ${e.message}`, error: true });
          if (e.code === 'BLOCKED') throw e;
        }
      }
    }

    // --- Bangumi ---
    emit({ stage: 'bangumi', message: '开始抓取 Bangumi…' });
    const subjectTypes = Object.entries(settings.categories || {})
      .filter(([, on]) => on)
      .map(([c]) => BGM_SUBJECT_TYPE_REVERSE[c])
      .filter(Boolean);
    const bgmItems = await bgm.fetchCollections({
      subjectTypes,
      types: [1, 2, 3],
      onProgress: (p) => emit({ stage: 'bangumi', message: `Bangumi 累计 ${p.count} 条`, ...p }),
      delayMs: 250,
    });
    log(`Bangumi 抓到 ${bgmItems.length} 条`);

    // --- 过滤分类 ---
    const allowed = new Set(Object.entries(settings.categories || {}).filter(([, v]) => v).map(([k]) => k));
    const filteredDouban = doubanItems.filter((i) => allowed.has(i.category));
    const filteredBgm = bgmItems.filter((i) => allowed.has(i.category));

    const snapshot = {
      scannedAt: new Date().toISOString(),
      douban: filteredDouban,
      bangumi: filteredBgm,
      meta: { douban: doubanMeta, doubanTotal: doubanItems.length, bgmTotal: bgmItems.length },
    };
    await saveSnapshot(snapshot);
    log(`扫描完成：豆瓣 ${filteredDouban.length} / Bangumi ${filteredBgm.length}（已按分类过滤）`);
    emit({ stage: 'done', message: '扫描完成' });
    return snapshot;
  } finally {
    STATE.scanning = false;
    STATE.abort = null;
  }
}

// ---------------------------------------------------------------- 匹配

/**
 * 豆瓣条目 -> Bangumi 条目
 * @param {Array|null} items 传入则用这批条目，否则取快照里的豆瓣列表
 * @param {Function} progress
 * @param {string[]|null} keys 只处理这几个豆瓣条目（搜索筛选 / 待确认批量反查时用）
 * @param {object} opts { onlyUnmatched: 只处理映射表里还没有对应的 }
 */
async function runMatch(items, progress, keys = null, opts = {}) {
  const settings = await getSettings();
  const mapping = await getMapping();
  let list = items || (await getSnapshot())?.douban || [];
  if (keys?.length) {
    const set = new Set(keys);
    list = list.filter((i) => set.has(i.id));
  }
  if (opts.onlyUnmatched) list = list.filter((i) => !mapping[i.id]?.subjectId);
  const out = [];
  let i = 0;
  for (const item of list) {
    i++;
    if (mapping[item.id]?.subjectId) continue;
    progress?.({ type: 'progress', stage: 'match', index: i, total: list.length, message: `匹配 ${item.title}` });
    try {
      const r = await resolve(item, mapping, settings);
      out.push({ key: item.id, title: item.title, ...r });
      if (r.status === 'matched' && r.subject?.id) {
        await persistMatch(item.id, r.subject, r.confidence);
        mapping[item.id] = { subjectId: r.subject.id, mode: 'auto', confidence: r.confidence };
      }
    } catch (e) {
      out.push({ key: item.id, title: item.title, status: 'unmatched', reason: e.message });
    }
    await new Promise((r) => setTimeout(r, 320)); // 搜索接口限流
  }
  const matched = out.filter((o) => o.status === 'matched').length;
  const candidate = out.filter((o) => o.status === 'candidate').length;
  const unmatched = out.filter((o) => o.status !== 'matched' && o.status !== 'candidate').length;
  await appendLog(`正向匹配完成：自动建立对应 ${matched} 条，待确认 ${candidate} 条，未找到 ${unmatched} 条`);
  return {
    total: list.length,
    matched,
    candidate,
    unmatched,
    // candidates 是老字段名，同步面板的「自动匹配」还在用；out 是同一份数据
    candidates: out,
    out,
    mapping: await getMapping(),
  };
}

/**
 * 单条豆瓣条目反查 Bangumi（待确认页签里的「搜 Bangumi」）。
 * 与批量反查的差别：只跑这一条，并且把候选原样带回去让用户点，不擅自替他决定。
 */
async function matchOne(key) {
  const settings = await getSettings();
  const mapping = await getMapping();
  const snap = (await getSnapshot()) || {};
  const item = (snap.douban || []).find((i) => i.id === key);
  if (!item) throw new Error('快照里找不到这条豆瓣条目，请先「扫描两侧」');

  const r = await resolve(item, mapping, settings);
  const out = { key: item.id, title: item.title, ...r };
  if (r.status === 'matched' && r.subject?.id) {
    await persistMatch(item.id, r.subject, r.confidence);
    out.linked = true;
  }
  return { ...out, mapping: await getMapping() };
}

// ---------------------------------------------------------------- 反向匹配

/**
 * 给「Bangumi 有收藏、但豆瓣侧没对应」的孤儿条目批量反查豆瓣。
 * 以前这些只能逐条点「搜豆瓣」，量一大根本处理不完。
 * @param {object} payload { limit?: number }  limit>0 时只处理前 N 条（先小批量试水）
 */
async function runReverseMatch(payload, progress) {
  const settings = await getSettings();
  const mapping = await getMapping();
  const snap = (await getSnapshot()) || {};
  const bgmItems = snap.bangumi || [];

  // 已经被映射表指向过的 Bangumi 条目不算孤儿
  const mappedSubjects = new Set(
    Object.values(mapping || {})
      .filter((m) => m?.subjectId && m.mode !== 'skip')
      .map((m) => Number(m.subjectId))
  );
  // 已占用掉的豆瓣条目：防止两个 Bangumi 条目抢同一个豆瓣 ID 互相覆盖
  const takenDoubanIds = new Set(
    Object.keys(mapping || {})
      .filter((k) => mapping[k]?.subjectId && mapping[k].mode !== 'skip')
      .map((k) => String(k).replace(/^douban:/, ''))
  );

  let orphans = bgmItems.filter((b) => !mappedSubjects.has(Number(b.subjectId)));
  // 只反查指定条目：同步面板搜索栏筛过之后，「批量反查豆瓣」应该只作用于筛出来的那几条
  if (payload?.keys?.length) {
    const set = new Set(payload.keys);
    orphans = orphans.filter((b) => set.has(b.id));
  }
  const limit = Number(payload?.limit) || 0;
  const targets = limit > 0 ? orphans.slice(0, limit) : orphans;

  // 豆瓣搜索比 Bangumi 更容易限流，间隔取「翻页间隔」但不少于 1s
  const delay = Math.max(Number(settings.readDelayMs) || 800, 1000);

  const out = [];
  let linked = 0;
  let candidate = 0;
  let unmatched = 0;
  let i = 0;

  for (const b of targets) {
    i++;
    progress?.({
      type: 'progress',
      stage: 'reverse',
      index: i,
      total: targets.length,
      message: `反查 ${b.title}`,
    });
    try {
      const r = await resolveReverse(b, settings, { searchDouban: searchDoubanSubject });
      const rec = { key: b.id, title: b.title, status: r.status, confidence: r.confidence ?? 0, douban: r.douban || null, candidates: r.candidates || [], reason: r.reason || '' };

      if (r.status === 'matched' && r.douban?.id && !takenDoubanIds.has(String(r.douban.id))) {
        // 映射表是「豆瓣ID -> Bangumi subject」，这里 Bangumi 侧就是条目本身
        await persistMatch(
          `douban:${r.douban.id}`,
          { id: b.subjectId, name: b.originalTitle || '', name_cn: b.title || '', category: b.category },
          r.confidence
        );
        takenDoubanIds.add(String(r.douban.id));
        mappedSubjects.add(Number(b.subjectId));
        linked++;
        rec.linked = true;
      } else if (r.status === 'matched' && r.douban?.id) {
        // 这个豆瓣条目已经被别的 Bangumi 条目占了，不能覆盖
        rec.linked = false;
        rec.status = 'conflict';
        rec.reason = `豆瓣条目 ${r.douban.id} 已对应到别的 Bangumi 条目`;
        unmatched++;
      } else {
        if (r.status === 'candidate') candidate++;
        else unmatched++;
      }
      out.push(rec);
    } catch (e) {
      unmatched++;
      out.push({ key: b.id, title: b.title, status: 'error', confidence: 0, candidates: [], reason: e.message });
    }
    await new Promise((r) => setTimeout(r, delay));
  }

  await appendLog(`反向匹配完成：自动建立对应 ${linked} 条，待确认 ${candidate} 条，未找到 ${unmatched} 条`);
  return { total: targets.length, orphanTotal: orphans.length, linked, candidate, unmatched, out, mapping: await getMapping() };
}

// ---------------------------------------------------------------- 一键同步

/**
 * 一键同步：扫描 -> 双向匹配 -> 生成计划 ->（确认后）写入
 * 分两步是为了安全：第一次只算不写，把「要写多少条、往哪边写」给出来让用户确认；
 * 计划缓存在 STATE.prepared，确认这一步不再重复扫描。
 */
async function quickSync(payload = {}, progress) {
  const emit = (p) => progress?.({ type: 'progress', ...p });
  const { confirm = false, limitReverse = 0 } = payload;

  let prepared = STATE.prepared;
  const fresh = prepared && Date.now() - prepared.at < PREPARED_TTL;

  if (!fresh) {
    if (STATE.scanning) throw new Error('已有扫描在进行中');
    emit({ stage: 'scan', message: '扫描两侧…', index: 0, total: 3 });
    await scanAll(emit);

    emit({ stage: 'match', message: '自动匹配（豆瓣 → Bangumi）…', index: 1, total: 3 });
    await runMatch(null, emit);

    emit({ stage: 'reverse', message: '反查孤儿（Bangumi → 豆瓣）…', index: 2, total: 3 });
    await runReverseMatch({ limit: limitReverse }, emit);

    emit({ stage: 'plan', message: '计算差异…', index: 3, total: 3 });
    prepared = await buildPrepared();
    STATE.prepared = prepared;
  }

  if (!confirm) {
    return { phase: 'preview', ...prepared.summary, preview: prepared.preview, preparedAt: prepared.at };
  }

  const settings = await getSettings();
  const pairs = prepared.pairs;
  const todo = pairs.filter((p) => p.diffs.some((d) => d.selected && d.direction));
  if (!todo.length) {
    return { phase: 'done', ...prepared.summary, okCount: 0, failCount: 0, results: [], message: '没有需要同步的内容' };
  }

  const out = await executePlan(todo, settings, {
    dryRun: false,
    signal: STATE.abort?.signal,
    onProgress: (p) => emit({ stage: 'write', ...p }),
    onLog: (m) => appendLog(m),
  });
  const okCount = out.results.reduce((n, r) => n + r.results.filter((x) => x.ok).length, 0);
  const failCount = out.results.reduce((n, r) => n + r.results.filter((x) => !x.ok).length, 0);
  await appendLog(`一键同步完成：成功 ${okCount}，失败 ${failCount}`);

  // 写完计划就失效了，下次必须重新扫描
  STATE.prepared = null;
  return { phase: 'done', ...prepared.summary, okCount, failCount, results: out.results };
}

/** 由当前快照 + 映射表算出同步计划与统计摘要 */
async function buildPrepared() {
  const [settings, snapshot, mapping] = await Promise.all([getSettings(), getSnapshot(), getMapping()]);
  const pairs = buildPlan(snapshot?.douban || [], snapshot?.bangumi || [], mapping, settings);

  const todo = pairs.filter((p) => p.diffs.some((d) => d.selected && d.direction));
  const toBgm = pairs.filter((p) => p.diffs.some((d) => d.selected && d.direction === 'toBgm')).length;
  const toDouban = pairs.filter((p) => p.diffs.some((d) => d.selected && d.direction === 'toDouban')).length;
  const needConfirm = pairs.filter((p) => p.flags.includes('unmatched') && !p.subjectId).length;

  const preview = todo.slice(0, 20).map((p) => {
    const dirs = p.diffs.filter((d) => d.selected && d.direction).map((d) => d.direction);
    return {
      title: p.douban?.title || p.bangumi?.title || '(无标题)',
      dir: dirs.includes('toBgm') && dirs.includes('toDouban') ? 'mixed' : dirs[0] || null,
      fields: p.diffs.filter((d) => d.selected && d.direction).map((d) => d.label || d.field),
    };
  });

  return {
    at: Date.now(),
    pairs,
    summary: {
      total: pairs.length,
      todo: todo.length,
      toBgm,
      toDouban,
      needConfirm,
      skipped: pairs.length - todo.length,
    },
    preview,
  };
}

// ---------------------------------------------------------------- 执行

async function runSync(payload, progress) {
  const settings = await getSettings();
  const pairs = payload?.pairs || [];
  const dryRun = !!payload?.dryRun;
  const out = await executePlan(pairs, settings, {
    dryRun,
    signal: STATE.abort?.signal,
    onProgress: (p) => progress?.({ type: 'progress', stage: 'sync', ...p }),
    onLog: (m) => appendLog(m),
  });
  const okCount = out.results.reduce((n, r) => n + r.results.filter((x) => x.ok).length, 0);
  const failCount = out.results.reduce((n, r) => n + r.results.filter((x) => !x.ok).length, 0);
  await appendLog(`执行完成：成功 ${okCount}，失败 ${failCount}${dryRun ? '（演练）' : ''}`);
  return { ...out, okCount, failCount };
}

// ---------------------------------------------------------------- 豆瓣反查

/**
 * 在豆瓣搜一个关键词，返回候选条目（用于 Bangumi -> 豆瓣 方向建立映射）
 * best-effort：豆瓣搜索页结构会变，失败就返回空让用户手动填 ID
 */
// 豆瓣全站搜索的 cat 参数：电影 1002 / 书籍 1001 / 音乐 1003
const SEARCH_CAT = { movie: 1002, book: 1001, music: 1003 };

async function searchDoubanSubject({ keyword, site = 'movie' }) {
  const siteKey = site === 'book' ? 'book' : site === 'music' ? 'music' : 'movie';
  const q = encodeURIComponent(keyword);

  // 豆瓣搜索有好几个入口，且页面结构会变（SSR DOM / React 空壳+JSON 都可能）。
  // 逐个尝试，任何一个能解析出结果就用它，并把尝试过程带回去便于排查。
  const urls = [
    `https://search.douban.com/${siteKey}/subject_search?search_text=${q}`,
    `https://${siteKey}.douban.com/subject_search?search_text=${q}`,
    `https://www.douban.com/search?cat=${SEARCH_CAT[siteKey]}&q=${q}`,
  ];

  const attempts = [];
  for (const url of urls) {
    let res;
    let text;
    try {
      ({ res, text } = await db.doubanFetch(url));
    } catch (e) {
      attempts.push({ url, error: String(e.message) });
      continue;
    }
    const blocked = db.detectBlocked(res, text);
    if (blocked.blocked) {
      attempts.push({ url, blocked: blocked.reason });
      continue;
    }
    await db.ensureOffscreen();
    const resp = await chrome.runtime.sendMessage({
      type: 'PARSE_DOUBAN_SEARCH',
      payload: { html: text, site: siteKey },
    });
    const items = resp?.data?.items || [];
    if (items.length) {
      return { ok: true, items, url, via: resp?.data?.via, attempts };
    }
    attempts.push({ url, status: res.status, bytes: text.length, parsed: 0, error: resp?.error || null });
  }

  return {
    ok: false,
    items: [],
    attempts,
    reason: '豆瓣搜索页没解析出结果（页面结构可能变了，或被风控拦截）',
  };
}

// ---------------------------------------------------------------- 生命周期

async function bootstrapRules(logIt = true) {
  try {
    const r = await installHeaderRules();
    if (logIt) {
      await appendLog(
        `请求头规则已安装 ${r.count} 条${r.originHeader ? '（含 Origin）' : '（仅 Referer）'}${r.note ? ` · ${r.note}` : ''}`
      );
    }
    return r;
  } catch (e) {
    if (logIt) await appendLog(`请求头规则安装失败：${e.message}（豆瓣写入可能因缺 Referer 被拒）`);
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await bootstrapRules();
  await appendLog('扩展已安装，请先到设置页配置 Bangumi Token');
});

chrome.runtime.onStartup.addListener(() => bootstrapRules(false));

// 冷启动也确保规则在位（开发模式重新加载扩展后动态规则会丢）
bootstrapRules(false);

// service worker 在扫描期间不断有 fetch 与端口消息，通常不会被休眠；
// 这里只是额外做一个轻量自唤醒，避免长时间无网络往来的间隔里被回收
setInterval(() => {
  if (!STATE.scanning) return;
  chrome.runtime.getPlatformInfo().catch(() => {});
}, 20000);
