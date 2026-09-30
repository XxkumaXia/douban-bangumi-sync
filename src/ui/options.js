import { send, sendStream } from './lib/msg.js';
import { confirmDialog, notify, installErrorGuard } from './lib/dialog.js';
import { goToPage } from './lib/nav.js';
import {
  previewTable,
  previewReverseTable,
  roundTripLossless,
  normalizeCustomMap,
  inspectCustomMap,
  DEFAULT_CUSTOM_MAP,
} from '../core/rating.js';

const $ = (id) => document.getElementById(id);
installErrorGuard();
let settings = null;
// 数字 uid：优先用于拼收藏列表链接，避免中文昵称打不开
let bgmUid = '';
// 表单有没有改动过。用于离开页面前提醒（程序化给 .value/.checked 赋值不会触发事件，所以只有真人操作会计数）
let dirty = false;
document.addEventListener('input', () => (dirty = true), true);
document.addEventListener('change', () => (dirty = true), true);

/**
 * 个人主页/收藏这类链接必须带用户名，没用户名时置灰并去掉 href，避免点到 404
 * @param {string} [username] 已知用户名；不传则读输入框
 */
function updateBgmLinks(username) {
  // 优先顺序：显式传入 > 已记录的数字 uid > 输入框当前值
  const u = String(username || bgmUid || $('bgmUsername')?.value || '').trim();
  const id = encodeURIComponent(u);
  // 收藏列表页用 /anime/list/{用户名或uid}/{状态} 形式：wish=想看 do=在看 collect=看过
  const map = {
    bgmHomeLink: u ? `https://bgm.tv/${id}/` : null,
    bgmWishLink: u ? `https://bgm.tv/anime/list/${id}/wish` : null,
    bgmDoLink: u ? `https://bgm.tv/anime/list/${id}/do` : null,
    bgmCollectLink: u ? `https://bgm.tv/anime/list/${id}/collect` : null,
  };
  for (const [linkId, href] of Object.entries(map)) {
    const el = $(linkId);
    if (!el) continue;
    if (href) {
      el.href = href;
      el.style.opacity = '';
      el.title = href;
    } else {
      el.removeAttribute('href');
      el.style.opacity = '0.45';
      el.title = '需要先填用户名或点「检查授权」';
    }
  }
}

async function load() {
  settings = await send({ type: 'SETTINGS_GET' });
  $('bgmToken').value = settings.bgmAccessToken || '';
  $('bgmUsername').value = settings.bgmUsername || '';
  bgmUid = settings.bgmUserId || '';
  updateBgmLinks();
  $('bgmClientId').value = settings.bgmClientId || '';
  $('bgmClientSecret').value = settings.bgmClientSecret || '';
  $('bgmRefresh').value = settings.bgmRefreshToken || '';
  $('doubanUid').value = settings.doubanUid || '';
  $('writeChannel').value = settings.doubanWriteChannel || 'auto';

  $('siteMovie').checked = !!settings.doubanSites?.movie;
  $('siteBook').checked = !!settings.doubanSites?.book;
  $('siteMusic').checked = !!settings.doubanSites?.music;

  $('fStatus').checked = !!settings.syncStatus;
  $('fRating').checked = !!settings.syncRating;
  $('fComment').checked = !!settings.syncComment;
  $('fTags').checked = !!settings.syncTags;

  $('cAnime').checked = !!settings.categories?.anime;
  $('cReal').checked = !!settings.categories?.real;
  $('cBook').checked = !!settings.categories?.book;
  $('cMusic').checked = !!settings.categories?.music;
  $('cGame').checked = !!settings.categories?.game;

  $('conflict').value = settings.conflictPolicy || 'newer';
  $('ratingMode').value = settings.ratingMode || 'step';
  writeCustomMap(settings.customRatingMap);
  $('allowClear').checked = !!settings.allowClear;
  $('ratingOnlyWhenDone').checked = settings.doubanRatingOnlyWhenDone !== false;

  $('autoTh').value = settings.autoAcceptThreshold ?? 0.82;
  $('candTh').value = settings.candidateThreshold ?? 0.45;
  $('writeDelay').value = settings.writeDelayMs ?? 1200;
  $('readDelay').value = settings.readDelayMs ?? 800;
  $('maxItems').value = settings.maxItemsPerList ?? 0;

  renderRatingPreview();
  dirty = false;
}

function collect() {
  return {
    bgmAccessToken: $('bgmToken').value.trim(),
    bgmUsername: $('bgmUsername').value.trim(),
    bgmUserId: String(bgmUid || ''),
    bgmClientId: $('bgmClientId').value.trim(),
    bgmClientSecret: $('bgmClientSecret').value.trim(),
    bgmRefreshToken: $('bgmRefresh').value.trim(),
    doubanUid: $('doubanUid').value.trim(),
    doubanWriteChannel: $('writeChannel').value,
    doubanSites: {
      movie: $('siteMovie').checked,
      book: $('siteBook').checked,
      music: $('siteMusic').checked,
    },
    syncStatus: $('fStatus').checked,
    syncRating: $('fRating').checked,
    syncComment: $('fComment').checked,
    syncTags: $('fTags').checked,
    categories: {
      anime: $('cAnime').checked,
      real: $('cReal').checked,
      book: $('cBook').checked,
      music: $('cMusic').checked,
      game: $('cGame').checked,
    },
    conflictPolicy: $('conflict').value,
    ratingMode: $('ratingMode').value,
    // 存规整后的值，避免把空串/超范围数字写进设置里
    customRatingMap: normalizeCustomMap(readCustomMap()),
    allowClear: $('allowClear').checked,
    doubanRatingOnlyWhenDone: $('ratingOnlyWhenDone').checked,
    autoAcceptThreshold: clamp01($('autoTh').value, 0.82),
    candidateThreshold: clamp01($('candTh').value, 0.45),
    writeDelayMs: Number($('writeDelay').value) || 0,
    readDelayMs: Number($('readDelay').value) || 0,
    maxItemsPerList: Number($('maxItems').value) || 0,
  };
}

function clamp01(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.min(1, n));
}

/** 生成 1★~5★ 五个输入框（只在自定义模式下显示） */
function buildCustomMapInputs() {
  const host = $('customMapRow');
  host.innerHTML = [1, 2, 3, 4, 5]
    .map(
      (s) =>
        `<span class="cm-cell"><label class="tiny-text" for="cm${s}">${s}★</label>` +
        `<input type="number" id="cm${s}" min="1" max="10" step="1" /></span>`
    )
    .join('');
  for (let s = 1; s <= 5; s++) {
    $(`cm${s}`).addEventListener('input', renderRatingPreview);
  }
}

function readCustomMap() {
  return [1, 2, 3, 4, 5].map((s) => $(`cm${s}`).value);
}

function writeCustomMap(map) {
  const arr = normalizeCustomMap(map);
  for (let s = 1; s <= 5; s++) $(`cm${s}`).value = arr[s - 1];
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderRatingPreview() {
  const mode = $('ratingMode').value;
  const custom = readCustomMap();
  $('customMapField').hidden = mode !== 'custom';

  const rows = previewTable(mode, custom);
  const rev = previewReverseTable(mode, custom);
  const { starSafe, scoreSafe, collided } = roundTripLossless(mode, custom);

  const table =
    `<table><thead><tr><th>豆瓣</th><th>→ Bangumi</th><th>→ 回豆瓣</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${r.douban} 星</td><td>${r.bgm} 分</td><td>${r.back} 星</td></tr>`).join('') +
    `</tbody></table>`;

  // 反向表才是自定义模式的关键：正向由用户定义，反向是推导出来的，必须让用户看见
  const revTable =
    `<div class="tiny-text" style="margin:6px 0 2px">反向（Bangumi 分 → 豆瓣星，由上表推导）</div>` +
    `<table><thead><tr><th>Bangumi</th><th>→ 豆瓣</th><th>→ 回 Bangumi</th></tr></thead><tbody>` +
    rev.map((r) => `<tr><td>${r.bgm} 分</td><td>${r.douban} 星</td><td>${r.back} 分</td></tr>`).join('') +
    `</tbody></table>`;

  let notes = '';
  if (mode === 'custom') {
    const { issues } = inspectCustomMap(custom);
    if (issues.length) {
      notes += `<div class="hint" style="color:#b26a00">${issues.map((t) => `· ${esc(t)}`).join('<br />')}</div>`;
    }
  }
  notes += starSafe
    ? `<div class="hint">星级 → 分数 → 星级 往返无损。</div>`
    : `<div class="hint" style="color:#b26a00">注意：星级往返有损，${rows
        .filter((r) => r.back !== r.douban)
        .map((r) => `${r.douban}★→${r.bgm}分→${r.back}★`)
        .join('、')}。来回同步时评分会漂移。</div>`;
  notes += scoreSafe
    ? `<div class="hint">分数 → 星级 → 分数 往返也无损（每个分数都有独立档位）。</div>`
    : `<div class="hint">分数 → 星级 → 分数 <b>必然有精度损失</b>：10 分制压成 5 星制后，${collided
        .slice(0, 4)
        .map((c) => `${c.from} 分→${c.to} 星→${c.back} 分`)
        .join('、')}${collided.length > 4 ? ' 等' : ''}。两边反复互相覆盖会有轻微漂移，建议固定一个方向作权威源。</div>`;

  $('ratingHint').innerHTML = table + revTable + notes;
}

$('ratingMode').addEventListener('change', renderRatingPreview);

$('btnCustomReset').addEventListener('click', () => {
  writeCustomMap(DEFAULT_CUSTOM_MAP);
  renderRatingPreview();
});

$('btnCustomFromStep').addEventListener('click', () => {
  // 阶梯值：1★=2 分，每档 +2
  writeCustomMap([2, 4, 6, 8, 10]);
  renderRatingPreview();
});

$('btnSave').addEventListener('click', async () => {
  try {
    await send({ type: 'SETTINGS_SET', payload: collect() });
    dirty = false;
    $('saveMsg').textContent = '已保存';
    setTimeout(() => ($('saveMsg').textContent = ''), 2500);
  } catch (e) {
    $('saveMsg').textContent = `保存失败: ${e.message}`;
  }
});

// 用户名一改，个人主页/收藏链接跟着变
$('bgmUsername').addEventListener('input', () => updateBgmLinks($('bgmUsername').value));

$('btnBgmCheck').addEventListener('click', async () => {
  $('bgmStatus').textContent = '检查中…';
  try {
    // 先落盘再检查，避免用户填了没保存
    await send({ type: 'SETTINGS_SET', payload: collect() });
    const r = await send({ type: 'BGM_AUTH_CHECK' });
    $('bgmStatus').innerHTML = r.ok
      ? `<span class="tag ok">已授权</span> ${r.nickname || ''} @${r.username || ''}`
      : `<span class="tag danger">失败</span> ${r.error}`;
    if (r.ok && r.username) {
      // 反查出的用户名回填输入框，省得下次再点一次授权才知道
      if (!$('bgmUsername').value.trim()) $('bgmUsername').value = r.username;
      // 记住数字 uid：昵称是中文时，用昵称拼出来的列表页链接会 404
      if (r.id != null) {
        bgmUid = String(r.id);
        await send({ type: 'SETTINGS_SET', payload: { bgmUserId: bgmUid } });
      }
      updateBgmLinks(bgmUid || r.username);
    }
  } catch (e) {
    $('bgmStatus').textContent = `检查失败: ${e.message}`;
  }
});

$('btnBgmRefresh').addEventListener('click', async () => {
  $('refreshStatus').textContent = '刷新中…';
  try {
    await send({ type: 'SETTINGS_SET', payload: collect() });
    const r = await send({ type: 'BGM_REFRESH' });
    $('refreshStatus').innerHTML = `<span class="tag ok">成功</span> 新 token 已写入`;
    $('bgmToken').value = r.access_token || $('bgmToken').value;
  } catch (e) {
    $('refreshStatus').innerHTML = `<span class="tag danger">失败</span> ${e.message}`;
  }
});

$('btnProbeRead').addEventListener('click', async () => {
  $('probeOut').innerHTML = '<div class="muted tiny-text">检查中…</div>';
  try {
    await send({ type: 'SETTINGS_SET', payload: collect() });
    const r = await send({ type: 'PROBE_DOUBAN', payload: { site: 'movie' } });
    renderProbe(r);
  } catch (e) {
    $('probeOut').innerHTML = `<div class="tag danger">检查失败: ${e.message}</div>`;
  }
});

$('btnProbeWrite').addEventListener('click', async () => {
  const id = $('probeId').value.trim();
  if (!id) {
    $('probeOut').innerHTML = '<div class="tag warn">请先填一个豆瓣条目 ID</div>';
    return;
  }
  $('probeOut').innerHTML = '<div class="muted tiny-text">构造中…</div>';
  try {
    await send({ type: 'SETTINGS_SET', payload: collect() });
    const r = await send({
      type: 'PROBE_DOUBAN_WRITE',
      payload: { site: 'movie', subjectId: id, status: 'done', rating: 0, comment: '', dryRun: true },
    });
    const attempts = r.attempts || [];
    const allChecks = attempts.flatMap((a) => a.checks || []);
    const badChecks = allChecks.filter((c) => !c.ok);

    // 结论先给出来：演练只能判定"构造正确"，判定不了"豆瓣会接受"
    const verdict = r.ready
      ? `<div class="step"><span class="tag ok">构造通过</span> <b>${attempts.length} 个策略的请求都构造完整</b>
         <span class="muted tiny-text">（ck 已取到、URL 与表单字段齐全）</span></div>`
      : `<div class="step"><span class="tag warn">构造有问题</span> <b>${badChecks.length} 项检查未通过</b>
         <span class="muted tiny-text">见下方红色项</span></div>`;

    const checksHtml = attempts
      .map(
        (a) =>
          `<div class="step"><div><b>${a.key}</b> <span class="muted">${a.label}</span></div>` +
          (a.checks || [])
            .map(
              (c) =>
                `<div class="tiny-text" style="margin-left:8px">${c.ok ? '<span class="tag ok">✓</span>' : '<span class="tag danger">✗</span>'} ${escapeHtml(
                  c.name
                )} <span class="muted">${escapeHtml(String(c.detail || ''))}</span></div>`
            )
            .join('') +
          `<div class="tiny-text muted" style="white-space:pre-wrap;margin-left:8px">${escapeHtml(
            a.request ? `${a.request.method || 'POST'} ${a.request.url}\n${JSON.stringify(a.request.form, null, 1)}` : ''
          )}</div></div>`
      )
      .join('');

    $('probeOut').innerHTML =
      verdict +
      checksHtml +
      `<div class="hint">
         <b>演练能判定什么：</b>请求构造是否正确 —— ck 取到了没、URL 和表单字段齐不齐。<br />
         <b>演练判定不了什么：</b>豆瓣会不会接受。登录态过期、风控、接口改版都会让真实写入失败，
         而这些只有真发一次请求才知道。<br />
         <b>要确认真的能写：</b>到同步面板挑<b>一条无关紧要的条目</b>真同步一次，然后打开豆瓣条目页看状态/评分是否变了。
         Bangumi 侧会自动回读校验并在结果里标注是否已确认。
       </div>`;
  } catch (e) {
    $('probeOut').innerHTML = `<div class="tag danger">构造失败: ${e.message}</div>`;
  }
});

// 分享字段：豆瓣没公开文档，只能读它自己的收藏弹窗来拿真实字段名。
// 这一项只做 GET，不会写任何东西。
$('btnProbeShare').addEventListener('click', async () => {
  const id = $('probeId').value.trim();
  if (!/^\d+$/.test(id)) {
    $('probeOut').innerHTML = '<div class="tag warn">先在下面填一个豆瓣条目 ID（纯数字）再检查</div>';
    return;
  }
  $('probeOut').innerHTML = '<div class="muted tiny-text">读取豆瓣收藏弹窗中…</div>';
  try {
    const r = await send({ type: 'PROBE_SHARE_FIELD', payload: { site: 'movie', subjectId: id } });
    const f = r.found;
    if (f?.name) {
      $('probeOut').innerHTML =
        `<div class="step"><span class="tag ok">已识别</span> <b>分享字段：${escapeHtml(f.name)}</b>` +
        ` <span class="muted tiny-text">提交值 ${escapeHtml(f.value)} · 定位方式 ${escapeHtml(f.via)}` +
        `${f.checked ? ' · 豆瓣网页端默认勾选' : ''}</span></div>` +
        `<div class="hint">开启「同步内容 → 写入豆瓣时同时分享到豆瓣广播」后，写入时会附上 <code>${escapeHtml(f.name)}=${escapeHtml(f.value)}</code>。结果已记住，之后不再重复读取。</div>`;
    } else {
      $('probeOut').innerHTML =
        `<div class="step"><span class="tag warn">没识别出来</span> <b>分享字段</b></div>` +
        `<div class="hint">可能是：这条 ID 不是电影条目、需要先登录豆瓣、或豆瓣改版把弹窗换成前端渲染了。` +
        `开关即使打开，读不到字段也只会写收藏、不发广播，并在结果里说明。<br />` +
        `想弄清楚的话：在豆瓣条目页点「收藏」，F12 → Network 找 <code>/j/subject/${escapeHtml(id)}/interest</code>，` +
        `看 Form Data 里多出来的那个勾选字段叫什么。</div>`;
    }
  } catch (e) {
    $('probeOut').innerHTML = `<div class="tag danger">检查失败: ${escapeHtml(e.message)}</div>`;
  }
});

// 收藏表单字段：把豆瓣自己渲染的表单原样读出来。
// 状态字段到底叫 status 还是 interest、评分字段叫什么，只能实测 —— 猜错了最典型的后果
// 就是「在看被写成看过」这类无声错误。这一项同样只做 GET。
$('btnProbeForm').addEventListener('click', async () => {
  const id = $('probeId').value.trim();
  if (!/^\d+$/.test(id)) {
    $('probeOut').innerHTML = '<div class="tag warn">先在下面填一个豆瓣条目 ID（纯数字）再读取</div>';
    return;
  }
  $('probeOut').innerHTML = '<div class="muted tiny-text">读取豆瓣收藏表单中…</div>';
  try {
    const r = await send({ type: 'PROBE_INTEREST_FORM', payload: { site: 'movie', subjectId: id } });
    if (!r?.ok) {
      $('probeOut').innerHTML =
        `<div class="step"><span class="tag warn">没读到</span> <b>收藏表单</b></div>` +
        `<div class="hint">${escapeHtml(r?.reason || '未知原因')}<br />` +
        `需要：已登录豆瓣、且这条 ID 是真实的条目 ID。也可以去豆瓣条目页手动点一次「收藏」，` +
        `F12 → Network 里找 <code>/j/subject/${escapeHtml(id)}/interest</code> 看真实的 Form Data。</div>`;
      return;
    }
    const line = (f) =>
      `<div class="tiny-text">· <code>${escapeHtml(f.name)}</code> <span class="muted">${escapeHtml(
        f.type
      )}</span>${f.value ? ` = ${escapeHtml(f.value)}` : ''}${f.checked ? ' （默认勾选）' : ''}</div>`;
    const sf = r.statusField;
    const rf = r.ratingField;
    const pf = r.privateField;
    // 实测见过的情况：电影条目的弹窗里只有 wish / collect 两个 radio，没有「在看」。
    // 这不一定代表豆瓣不接受「在看」（写入后回读校验能给出答案），但值得当面说清楚，
    // 免得用户以为「没这个选项 = 同步不了在看」。
    const opts = sf?.options || [];
    const hasDoing = opts.some((o) => String(o).toLowerCase() === 'do');
    const doingNote =
      sf && !hasDoing
        ? `<div class="hint"><b>这份表单里没有「在看」这一项</b>（可选值只有 ${escapeHtml(opts.join(' / '))}）。` +
          `这不代表豆瓣不接受「在看」—— 弹窗按条目类型渲染，接口往往另有取值。` +
          `要确认，挑一条「在看」的条目真同步一次，看结果里的<b>回读校验</b>：豆瓣那边显示什么就是什么。</div>`
        : '';
    $('probeOut').innerHTML =
      `<div class="step"><span class="tag ${sf ? 'ok' : 'warn'}">${sf ? '已识别' : '未识别'}</span>` +
      ` <b>状态字段</b> ${sf ? `<code>${escapeHtml(sf.name)}</code>（${escapeHtml(sf.kind)}）` : '没在表单里找到状态字段'}` +
      (sf?.options?.length ? ` <span class="muted tiny-text">可选值：${escapeHtml(sf.options.join(' / '))}</span>` : '') +
      `</div>` +
      `<div class="step"><span class="tag ${rf ? 'ok' : 'warn'}">${rf ? '已识别' : '未识别'}</span>` +
      ` <b>评分字段</b> ${rf ? `<code>${escapeHtml(rf.name)}</code>（${escapeHtml(rf.kind)}）` : '表单里没看到评分字段'}` +
      (rf?.options?.length ? ` <span class="muted tiny-text">可选值：${escapeHtml(rf.options.join(' / '))}</span>` : '') +
      `</div>` +
      `<div class="step"><span class="tag ${pf ? 'ok' : 'warn'}">${pf ? '已识别' : '未识别'}</span>` +
      ` <b>仅自己可见字段</b> ${pf ? `<code>${escapeHtml(pf.name)}</code>（${escapeHtml(pf.kind)}）` : '表单里没看到隐私字段'}</div>` +
      doingNote +
      `<div class="hint">${r.applied ? `已记住字段名（状态 <code>${escapeHtml(r.applied)}</code>），之后的写入请求会同时带上实测名和兼容名。` : '未识别到状态字段，写入仍使用默认字段名。'}` +
      `表单共 ${r.fields.length} 个字段，弹窗 HTML ${r.htmlLength} 字符。</div>` +
      `<details><summary class="tiny-text muted">展开全部字段（${r.fields.length}）</summary>` +
      r.fields.map(line).join('') +
      `</details>`;
  } catch (e) {
    $('probeOut').innerHTML = `<div class="tag danger">读取失败: ${escapeHtml(e.message)}</div>`;
  }
});

$('btnProbeRules').addEventListener('click', async () => {
  $('probeOut').innerHTML = '<div class="muted tiny-text">检查中…</div>';
  try {
    const r = await send({ type: 'PROBE_HEADER_RULES' });
    $('probeOut').innerHTML =
      `<div class="step">${r.count > 0 ? '<span class="tag ok">已安装</span>' : '<span class="tag danger">未安装</span>'} <b>请求头规则</b> <span class="muted tiny-text">共 ${r.count} 条，${r.hasOrigin ? '含 Origin' : '仅 Referer'}</span></div>` +
      r.sample
        .map(
          (s) =>
            `<div class="tiny-text muted">· ${escapeHtml(s.path)} → ${s.headers.join(', ')}</div>`
        )
        .join('') +
      (r.count
        ? ''
        : `<div class="hint">规则缺失时豆瓣可能因 Referer 校验拒绝写入。到设置页点一次保存，或重新加载扩展即可安装。</div>`);
  } catch (e) {
    $('probeOut').innerHTML = `<div class="tag danger">检查失败: ${e.message}</div>`;
  }
});

function renderProbe(r) {
  const tagOf = (s) => {
    if (s.level === 'warn') return '<span class="tag warn">注意</span>';
    if (s.level === 'ok' || s.ok) return '<span class="tag ok">通过</span>';
    return '<span class="tag danger">失败</span>';
  };
  const steps = (r.steps || [])
    .map(
      (s) =>
        `<div class="step">${tagOf(s)} <b>${s.name}</b> <span class="muted tiny-text">${escapeHtml(String(s.detail || ''))}</span></div>`
    )
    .join('');
  const sample = (r.sample || [])
    .map(
      (s) =>
        `<div class="tiny-text">· ${escapeHtml(s.title)} <span class="muted">${s.year || '?'} / ${s.category} / ${s.status} / ${s.rating || '无评分'}</span></div>`
    )
    .join('');
  $('probeOut').innerHTML =
    steps +
    shareLine(r.share) +
    (sample ? `<div class="divider"></div><div class="tiny-text">解析样例：</div>${sample}` : '') +
    (r.ok
      ? ''
      : `<div class="hint">
           读取失败按这个顺序排查：<br />
           ① <b>浏览器里没登录豆瓣</b>（或登录态过期）—— 打开 <a href="https://www.douban.com" target="_blank">douban.com</a> 登录一次，刷新后再点本项检查；<br />
           ② <b>触发风控/验证码</b> —— 在浏览器里手动过一次验证，或把翻页间隔调大；<br />
           ③ <b>豆瓣改版导致选择器失配</b> —— 把「解析列表页」那一步的详情发出来，即可针对性修选择器。
         </div>`);
}

/**
 * 演练结果里「分享到广播」那一行：明确说清这次会不会附带分享参数。
 * 只说「成功」不够 —— 分享字段读不到时收藏照样能写成功，广播却不会出现，
 * 不写清楚就会被当成"广播没生效"反复试。
 */
function shareLine(share) {
  if (!share?.requested) return '';
  const cls = share.applied ? 'ok' : 'warn';
  const detail = share.applied
    ? `会附带 <code>${escapeHtml(share.field.name)}=${escapeHtml(share.field.value)}</code>（字段名来源：${escapeHtml(share.field.via)}）`
    : escapeHtml(share.note || '开关已开，但没读到分享字段 —— 本次只写收藏，不发广播');
  return `<div class="step"><span class="tag ${cls}">分享广播</span> <b>${share.applied ? '已附上' : '未附上'}</b> <span class="muted tiny-text">${detail}</span></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('btnClearMap').addEventListener('click', async () => {
  const go = await confirmDialog({
    title: '清空映射表',
    message: '下次需要重新逐条确认对应关系。',
    okText: '清空',
    danger: true,
  });
  if (!go) return;
  await send({ type: 'MAPPING_CLEAR' });
  notify('已清空映射表');
});
$('btnClearSnap').addEventListener('click', async () => {
  await send({ type: 'CLEAR_SNAPSHOT' });
  notify('已清空扫描结果');
});
$('btnClearLog').addEventListener('click', async () => {
  await send({ type: 'LOG_CLEAR' });
  notify('已清空日志');
});
$('btnReset').addEventListener('click', async () => {
  const go = await confirmDialog({
    title: '恢复默认设置',
    message: 'Token 也会一并清空。',
    okText: '恢复默认',
    danger: true,
  });
  if (!go) return;
  await send({ type: 'SETTINGS_RESET' });
  await load();
  notify('已恢复默认');
});

// ---------------------------------------------------------------- 一键同步

// 准备阶段的结果：确认写入时要带上，避免用户改了设置后按老计划写
let quickPlan = null;

function dirLabel(dir) {
  if (dir === 'toBgm') return '豆瓣 → Bangumi';
  if (dir === 'toDouban') return 'Bangumi → 豆瓣';
  if (dir === 'mixed') return '双向';
  return '待定';
}

/**
 * 离开设置页去同步面板。
 *
 * 现在两边都开在扩展自己的标签页里、又是同源，直接原地跳转即可 ——
 * 不用 tabs.create，那样每点一次就多一个标签页。浏览器的后退按钮可以直接退回设置页。
 *
 * 唯一要处理的是：原地点跳转会把没保存的改动丢掉，所以先问一句。
 */
async function leaveToSync() {
  if (dirty) {
    const save = await confirmDialog({
      title: '设置还没保存',
      message: '表单里有改动还没保存。\n确定 = 先保存再跳转；取消 = 直接跳转（改动会丢失）。',
      okText: '保存并跳转',
      cancelText: '直接跳转',
    });
    if (save) {
      try {
        await send({ type: 'SETTINGS_SET', payload: collect() });
        dirty = false;
      } catch (e) {
        notify(`保存失败：${e.message}`, { ok: false });
        return;
      }
    }
  }
  goToPage('src/ui/sync.html');
}

$('btnQuickPanel').addEventListener('click', leaveToSync);
$('btnOpenPanel').addEventListener('click', leaveToSync);

$('btnQuickPrepare').addEventListener('click', async () => {
  const out = $('quickOut');
  const btn = $('btnQuickPrepare');
  btn.disabled = true;
  $('btnQuickRun').disabled = true;
  quickPlan = null;
  out.innerHTML = '<div class="muted tiny-text">扫描并匹配中…首次较慢，请保持豆瓣页面开着</div>';
  try {
    await send({ type: 'SETTINGS_SET', payload: collect() });
    const r = await sendStream({ type: 'QUICK_SYNC', payload: { confirm: false } }, (p) => {
      if (p.message) out.innerHTML = `<div class="muted tiny-text">${escapeHtml(p.message)}</div>`;
    });
    quickPlan = r;
    const lines = (r.preview || [])
      .map(
        (p) =>
          `<div class="tiny-text">· ${escapeHtml(p.title)} <span class="muted">${dirLabel(p.dir)} · ${escapeHtml(
            (p.fields || []).join('/')
          )}</span></div>`
      )
      .join('');
    out.innerHTML =
      `<div class="step"><span class="tag ok">准备完成</span> 共 ${r.total} 条，
        <b>将写入 ${r.todo} 条</b>（→Bangumi ${r.toBgm} / →豆瓣 ${r.toDouban}），
        待人工确认 ${r.needConfirm} 条，无需处理 ${r.skipped} 条</div>` +
      (r.todo
        ? `<div class="tiny-text" style="margin-top:6px">写入预览${r.preview.length < r.todo ? `（前 ${r.preview.length} 条）` : ''}：</div>${lines}`
        : `<div class="hint">两边已经一致，没有需要写入的内容。</div>`) +
      (r.needConfirm
        ? `<div class="hint">有 ${r.needConfirm} 条没匹配上、需要人工指定对应条目，到同步面板的「待确认匹配」里处理。</div>`
        : '');
    $('btnQuickRun').disabled = !(r.todo > 0);
  } catch (e) {
    out.innerHTML = `<div class="tag danger">准备失败</div> ${escapeHtml(e.message)}`;
  } finally {
    btn.disabled = false;
  }
});

$('btnQuickRun').addEventListener('click', async () => {
  if (!quickPlan) return;
  const { todo, toBgm, toDouban } = quickPlan;
  const go = await confirmDialog({
    title: '确认写入',
    message: `即将写入 ${todo} 条（→Bangumi ${toBgm} / →豆瓣 ${toDouban}）。\n豆瓣写入不可逆。`,
    okText: '确定写入',
    danger: true,
  });
  if (!go) return;
  const btn = $('btnQuickRun');
  const out = $('quickOut');
  btn.disabled = true;
  out.innerHTML = '<div class="muted tiny-text">写入中…</div>';
  try {
    const r = await sendStream({ type: 'QUICK_SYNC', payload: { confirm: true } }, (p) => {
      if (p.done) out.innerHTML = `<div class="muted tiny-text">写入 ${p.done}/${p.total} ${escapeHtml(p.entry?.title || '')}</div>`;
    });
    const fails = [];
    for (const e of r.results || []) for (const x of e.results || []) if (!x.ok) fails.push(`${e.title}: ${x.error || '失败'}`);
    out.innerHTML =
      `<div class="step"><span class="tag ${r.failCount ? 'warn' : 'ok'}">执行完成</span> 成功 ${r.okCount}，失败 ${r.failCount}</div>` +
      (fails.length ? `<div class="tiny-text">${escapeHtml(fails.slice(0, 8).join('\n'))}</div>` : '') +
      `<div class="hint">豆瓣侧建议打开条目页抽查一两条确认是否写入成功。</div>`;
    $('btnQuickRun').disabled = true;
    quickPlan = null;
  } catch (e) {
    out.innerHTML = `<div class="tag danger">写入失败</div> ${escapeHtml(e.message)}`;
    btn.disabled = true;
  }
});

// 先建好 1★~5★ 输入框，load() 才能往里填值
buildCustomMapInputs();
load();
