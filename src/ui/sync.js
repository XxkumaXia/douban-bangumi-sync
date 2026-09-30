import { send, sendStream } from './lib/msg.js';
import { confirmDialog, notify, installErrorGuard } from './lib/dialog.js';
import { goToPage } from './lib/nav.js';
import { currentDirection } from './lib/direction.js';
import { buildPlan, summarize, FIELD_LABEL } from '../core/diff.js';
import { setPairDirection, setPairSelected, selectBySuggestion, suggestionOf } from '../core/sync.js';
import { suggestedDirection } from './lib/direction.js';
import { STATUS_LABEL, CATEGORY_LABEL } from '../core/normalize.js';

const $ = (id) => document.getElementById(id);
installErrorGuard();

const state = {
  settings: null,
  snapshot: null,
  mapping: {},
  pairs: [],
  matchReport: null,
  reverseReport: null,
  tab: 'diff',
  busy: false,
  // 勾了「分享到豆瓣广播」的条目 key。默认空 = 都不分享（广播发出去撤不回，必须显式勾）
  shareSet: new Set(),
  // 最近一次演练的完整结果，供复制/下载使用
  lastDry: null,
  // 搜索栏关键词：只影响「显示哪些条目」，不动任何勾选
  query: '',
  // 分类筛选：all / wish / doing / done。同样只影响显示，不动勾选
  statusFilter: 'all',
  // 待确认条目反查 Bangumi 的结果：{ [pairKey]: { status, candidates, reason } }
  forwardReport: {},
};

// ---------------------------------------------------------------- 加载

async function loadAll() {
  [state.settings, state.snapshot, state.mapping] = await Promise.all([
    send({ type: 'SETTINGS_GET' }),
    send({ type: 'SNAPSHOT_GET' }),
    send({ type: 'MAPPING_GET' }),
  ]);
  recompute();
  renderAll();
}

function recompute() {
  if (!state.snapshot) {
    state.pairs = [];
    return;
  }

  // 先把用户手工设过的「方向 / 跳过」记下来。
  // buildPlan 每次都会重建 pairs，diffs 全部按默认全选 —— 不回填的话，
  // 执行完一次同步（会重新算差异）用户之前设置的跳过就全被冲掉了。
  const prev = new Map();
  for (const p of state.pairs || []) {
    const byField = {};
    for (const d of p.diffs) {
      if (d.field) byField[d.field] = { selected: d.selected, direction: d.direction };
    }
    prev.set(p.key, byField);
  }

  state.pairs = buildPlan(state.snapshot.douban || [], state.snapshot.bangumi || [], state.mapping, state.settings);

  // 回填：已经同步成功的差异这次不会再出现；没成功的保持用户之前的取舍
  for (const p of state.pairs) {
    const old = prev.get(p.key);
    if (!old) continue;
    for (const d of p.diffs) {
      const o = old[d.field];
      if (!o) continue;
      d.selected = o.selected;
      d.direction = o.direction;
    }
  }
}

function renderAll() {
  renderStats();
  renderDiff();
  renderConfirm();
  renderOrphan();
  renderQueryLine();
  renderFilterCounts();
}

// ---------------------------------------------------------------- 搜索过滤

/** 一条 pair 是否命中搜索词：豆瓣/Bangumi 的标题、原名、条目 ID 都算 */
function matchQuery(p) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    p.douban?.title,
    p.douban?.originalTitle,
    p.bangumi?.title,
    p.bangumi?.originalTitle,
    p.douban?.id,
    p.bangumi?.subjectId,
  ]
    .filter((x) => x != null && x !== '')
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/**
 * 一条 pair 是否落在当前选中的收藏分类里。
 * 按**任一侧**判定：豆瓣「看过」+ Bangumi「在看」这种本身就有差异的条目，
 * 选「在看」和选「看过」都该出现 —— 它两边都占，硬选一边会让它从视野里消失。
 */
function matchStatus(p) {
  const f = state.statusFilter;
  if (!f || f === 'all') return true;
  return p.douban?.status === f || p.bangumi?.status === f;
}

/** 当前筛选条件（搜索词 + 分类）下可见的条目（批量操作的作用范围） */
function visiblePairs() {
  return state.pairs.filter((p) => matchQuery(p) && matchStatus(p));
}

/** 在已有筛选条件上再叠加搜索词与分类 */
function withFilters(list) {
  return list.filter((p) => matchQuery(p) && matchStatus(p));
}

/** 正在筛选吗（用于决定空列表时该说什么、批量按钮要不要标注范围） */
function isFiltering() {
  return !!state.query.trim() || state.statusFilter !== 'all';
}

/** 筛掉的原因，说人话：「搜索词」/「分类：在看」/ 两者都有 */
function filterDesc() {
  const parts = [];
  if (state.query.trim()) parts.push(`搜索词「${state.query.trim()}」`);
  if (state.statusFilter !== 'all') parts.push(`分类「${STATUS_LABEL[state.statusFilter] || state.statusFilter}」`);
  return parts.join(' + ');
}

const FILTER_KEYS = ['all', 'wish', 'doing', 'done'];

/**
 * 分类按钮上写明各分类有多少条。
 *
 * 计数只叠搜索词，**绝不叠分类本身** —— 这里刻意不过 withFilters()：
 * 那个函数会一起套用当前分类，于是选中「在看」后「全部」会跟着变成在看的总数、
 * 其余分类被压成 0，看起来像「数字乱跳」。这个 bug 真出现过（用户截图：全部 55 → 46）。
 * 数字应当始终反映「这个页签里各类收藏各有多少条」，和你正在看哪一类无关。
 */
function renderFilterCounts() {
  const base = pairsOfTab(state.tab).filter(matchQuery);
  for (const k of FILTER_KEYS) {
    const n =
      k === 'all'
        ? base.length
        : base.filter((p) => p.douban?.status === k || p.bangumi?.status === k).length;
    const span = document.querySelector(`[data-count="${k}"]`);
    if (span) span.textContent = `(${n})`;
  }
  document.querySelectorAll('[data-filter]').forEach((b) =>
    b.classList.toggle('active', b.dataset.filter === state.statusFilter)
  );
  const line = $('filterLine');
  if (line) {
    line.textContent =
      state.statusFilter === 'all'
        ? ''
        : `只看「${STATUS_LABEL[state.statusFilter] || state.statusFilter}」的条目，其它条目暂时隐藏（勾选不变）`;
  }
}

/** 当前页签对应的条目全集（不含筛选），供计数和空态提示用 */
function pairsOfTab(tab) {
  if (tab === 'confirm') return state.pairs.filter((p) => !p.subjectId && p.douban);
  if (tab === 'orphan') return state.pairs.filter((p) => p.flags.includes('missing-in-douban'));
  return state.pairs.filter((p) => p.diffs.length);
}

function renderQueryLine() {
  const vis = visiblePairs().length;
  const line = $('qLine');
  if (line) {
    line.textContent = isFiltering() ? `筛出 ${vis} / ${state.pairs.length} 条（${filterDesc()}）` : '';
  }
  const bulk = $('bulkLine');
  if (bulk) {
    bulk.textContent = isFiltering() ? `（批量只作用于筛出的 ${vis} 条）` : '';
  }
}

function renderStats() {
  const s = summarize(state.pairs);
  const meta = state.snapshot?.meta;
  const scanned = state.snapshot?.scannedAt ? state.snapshot.scannedAt.slice(0, 16).replace('T', ' ') : '未扫描';
  $('statLine').innerHTML =
    `豆瓣 ${state.snapshot?.douban?.length ?? 0} · Bangumi ${state.snapshot?.bangumi?.length ?? 0} · ` +
    `映射 ${Object.keys(state.mapping).length} · 待处理 ${s.toBgm + s.toDouban + s.manual} · 待确认 ${s.needConfirm} · 扫描于 ${scanned}`;
  $('cDiff').textContent = state.pairs.filter((p) => p.diffs.length).length;
  $('cConfirm').textContent = countConfirm();
  $('cOrphan').textContent = state.pairs.filter((p) => p.flags.includes('missing-in-douban')).length;
  $('statusLine').textContent = meta?.doubanTotal
    ? `原始豆瓣 ${meta.doubanTotal} 条，按分类过滤后 ${state.snapshot.douban.length} 条`
    : '就绪';
}

function countConfirm() {
  return state.pairs.filter((p) => p.flags.includes('unmatched') && !p.subjectId).length;
}

// ---------------------------------------------------------------- 差异列表

function renderDiff() {
  const host = $('tab-diff');
  const list = withFilters(state.pairs.filter((p) => p.diffs.length));
  if (!list.length) {
    host.innerHTML = isFiltering()
      ? `<div class="empty">没有符合${escapeHtml(filterDesc())}的差异条目（共 ${state.pairs.filter((p) => p.diffs.length).length} 条差异被筛掉）</div>`
      : `<div class="empty">没有需要同步的差异。先点「扫描两侧」，再点「自动匹配」。</div>`;
    updateSelLine();
    updateShareLine();
    renderBulkCounts();
    return;
  }

  host.innerHTML = list.map(renderPair).join('');

  list.forEach((p) => {
    const root = host.querySelector(`[data-key="${cssEscape(p.key)}"]`);
    if (!root) return;
    root.querySelectorAll('[data-dir]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dir = btn.dataset.dir === 'none' ? null : btn.dataset.dir;
        setPairDirection(p, dir);
        // 整个列表重画：方向一变，「分享广播」勾选框该不该出现也跟着变。
        // 只 toggle class 的话，改成「→豆瓣」后勾选框不会冒出来。
        const y = window.scrollY;
        renderDiff();
        window.scrollTo(0, y);
      });
    });
    root.querySelectorAll('input[data-idx]').forEach((cb) => {
      cb.addEventListener('change', () => {
        p.diffs[Number(cb.dataset.idx)].selected = cb.checked;
        updateSelLine();
      });
    });
    const shareBox = root.querySelector('input[data-share]');
    shareBox?.addEventListener('change', () => {
      if (shareBox.checked) state.shareSet.add(p.key);
      else state.shareSet.delete(p.key);
      updateShareLine();
    });
  });
  updateSelLine();
  updateShareLine();
  renderBulkCounts();
}

/**
 * 批量按钮上直接写明「这个方向有多少条」。
 * 数字按**建议方向**算（不是当前勾选），否则用户点完一次数字就变了，反而看不出原本的分布。
 * 一条里同时有两边建议的字段时，两个按钮都会把它算进去 —— 那是事实，不是 bug。
 */
function renderBulkCounts() {
  const list = withFilters(state.pairs.filter((p) => p.diffs.length));
  let toBgm = 0;
  let toDouban = 0;
  for (const p of list) {
    if (p.diffs.some((d) => suggestionOf(d) === 'toBgm')) toBgm++;
    if (p.diffs.some((d) => suggestionOf(d) === 'toDouban')) toDouban++;
  }
  const set = (v, text) => {
    const b = document.querySelector(`[data-bulk="${v}"]`);
    if (b) b.textContent = text;
  };
  set('pick-toBgm', `只选 豆瓣→Bangumi（${toBgm}）`);
  set('pick-toDouban', `只选 Bangumi→豆瓣（${toDouban}）`);
}

function renderPair(p) {
  const d = p.douban;
  const b = p.bangumi;
  // 注意：不能写成 dirs.every(...) —— 全部取消勾选后 dirs 是空数组，
  // 而空数组的 every() 恒为 true，会把「跳过/未选」错误地显示成「豆瓣 → Bangumi」高亮。
  // （以前就是这个 bug：点了跳过，按钮反而跳回第一个方向，像是把整条重置了）
  const cur = currentDirection(p.diffs);

  const flags = p.flags
    .map((f) => {
      const map = {
        unmatched: '<span class="tag warn">未匹配</span>',
        'missing-in-bangumi': '<span class="tag warn">Bangumi 无收藏</span>',
        'missing-in-douban': '<span class="tag warn">豆瓣无收藏</span>',
        'douban-not-collected': '<span class="tag">待新增到豆瓣</span>',
      };
      return map[f] || '';
    })
    .join(' ');

  // 只有确实会往豆瓣写的时候，「分享到广播」才有意义
  const writesDouban = p.diffs.some((x) => x.selected && x.direction === 'toDouban');
  const shareBox = writesDouban
    ? `<label class="share-box" title="勾上后，这条写入豆瓣时会同时发一条豆瓣广播。广播会被关注者看到，且发出后撤不回来，所以默认不勾">
         <input type="checkbox" data-share="1" ${state.shareSet.has(p.key) ? 'checked' : ''} /> 分享广播
       </label>`
    : '';

  const rows = p.diffs
    .map(
      (x, i) => `<tr>
        <td style="width:28px"><input type="checkbox" data-idx="${i}" ${x.selected ? 'checked' : ''} /></td>
        <td style="width:56px" class="muted">${FIELD_LABEL[x.field]}</td>
        <td>${escapeHtml(String(x.doubanValue ?? '—'))}</td>
        <td>${escapeHtml(String(x.bangumiValue ?? '—'))}</td>
        <td class="muted tiny-text">${directionLabel(x.direction)}${changedMark(x)}${x.note ? ` · ${escapeHtml(x.note)}` : ''}</td>
      </tr>`
    )
    .join('');

  return `<div class="pair" data-key="${cssEscape(p.key)}">
    <div class="row between">
      <div>
        <span class="title">${escapeHtml(d?.title || b?.title || '(无标题)')}</span>
        ${d?.year ? `<span class="muted tiny-text">${d.year}</span>` : ''}
        ${flags}
      </div>
      <div class="row">
        ${shareBox}
        <button class="tiny dirbtn ${cur === 'toBgm' ? 'active' : ''}" data-dir="toBgm">豆瓣 → Bangumi</button>
        <button class="tiny dirbtn ${cur === 'toDouban' ? 'active' : ''}" data-dir="toDouban">Bangumi → 豆瓣</button>
        <button class="tiny dirbtn ${cur === 'none' ? 'active' : ''}" data-dir="none">跳过</button>
      </div>
    </div>
    <div class="cols">
      <div class="side douban">
        <div class="tiny-text muted">豆瓣${d?.doubanSite ? ` · ${siteLabel(d.doubanSite)}` : ''}</div>
        <div class="tiny-text">${d ? sideText(d) : '<span class="muted">无记录</span>'}</div>
        ${d?.url ? `<a class="tiny-text" href="${d.url}" target="_blank">打开条目</a>` : ''}
      </div>
      <div class="side bangumi">
        <div class="tiny-text muted">Bangumi${b?.category ? ` · ${CATEGORY_LABEL[b.category] || b.category}` : ''}</div>
        <div class="tiny-text">${b ? sideText(b) : '<span class="muted">无记录</span>'}</div>
        ${b?.url ? `<a class="tiny-text" href="${b.url}" target="_blank">打开条目</a>` : ''}
      </div>
    </div>
    <table style="margin-top:8px">
      <thead><tr><th></th><th>字段</th><th>豆瓣</th><th>Bangumi</th><th>方向</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function sideText(it) {
  const parts = [];
  if (it.status) parts.push(STATUS_LABEL[it.status] || it.status);
  parts.push(it.rating ? `${it.rating} 星` : '未评分');
  if (it.comment) parts.push(`评价：${truncate(it.comment, 40)}`);
  if (it.tags?.length) parts.push(`标签：${it.tags.join('、')}`);
  if (it.updatedAt) parts.push(`更新于 ${String(it.updatedAt).slice(0, 10)}`);
  return escapeHtml(parts.join(' · '));
}

function siteLabel(s) {
  return { movie: '影视', book: '读书', music: '音乐' }[s] || s;
}

function directionLabel(dir) {
  if (dir === 'toBgm') return '豆瓣 → Bangumi';
  if (dir === 'toDouban') return 'Bangumi → 豆瓣';
  return '待定';
}

/**
 * 这条字段的方向被手动改过的话，把「原建议」标出来。
 * 不然用户点「只选 豆瓣→Bangumi」时，看到某个字段被勾上会很困惑 —— 明明刚选的是另一个方向。
 */
function changedMark(x) {
  const sug = suggestionOf(x);
  if (!sug || x.direction === sug) return '';
  return ` <span class="tiny-text" title="匹配完的建议方向是 ${directionLabel(sug)}，已被手动改过">（原建议 ${directionLabel(sug)}）</span>`;
}

function updateSelLine() {
  const todo = state.pairs.reduce((n, p) => n + p.diffs.filter((d) => d.selected && d.direction).length, 0);
  const toBgm = state.pairs.reduce((n, p) => n + p.diffs.filter((d) => d.selected && d.direction === 'toBgm').length, 0);
  const toDouban = state.pairs.reduce((n, p) => n + p.diffs.filter((d) => d.selected && d.direction === 'toDouban').length, 0);
  $('selLine').textContent = `将写入 ${todo} 项（→Bangumi ${toBgm} / →豆瓣 ${toDouban}）`;
}

// ---------------------------------------------------------------- 演练结果面板

/**
 * 演练结果渲染。
 *
 * 以前这些信息只 console.log 到 F12，页面上只有一行「演练完成 成功 X 失败 Y」——
 * 用户点了「演练」根本不知道去哪看。这里把每条请求的真实 URL、表单、静态检查项、
 * 分享广播状态全部铺开，另外提供复制/下载，能直接从页面上看明白。
 */
async function renderDryResult(payload) {
  const results = payload?.results || [];
  state.lastDry = payload;

  const count = results.reduce((n, e) => n + (e.results?.length || 0), 0);
  const cDry = $('cDry');
  if (cDry) cDry.textContent = count ? `(${count})` : '';

  if (!count) {
    $('tab-dry').innerHTML = `<div class="empty">还没有演练记录。先在「差异」页签勾选要同步的条目，再点底部「演练」。</div>`;
    return;
  }

  const rows = results.map((e) => {
    const items = (e.results || [])
      .map((x) => {
        const badge =
          x.ok === false
            ? '<span class="tag danger">构造失败</span>'
            : '<span class="tag ok">已就绪</span>';

        if (x.error) {
          return `<div class="dry-item">
            <div class="row"><span class="tag ${x.target === 'douban' ? 'douban' : 'bangumi'}">${TARGET_LABEL[x.target] || x.target}</span>${badge}</div>
            <div class="tiny-text">${escapeHtml(x.error)}</div>
          </div>`;
        }

        if (x.target === 'bangumi') {
          const req = x.request || {};
          const body = { ...(req.body || {}) };
          delete body.customRatingMap;
          return `<div class="dry-item">
            <div class="row">
              <span class="tag bangumi">Bangumi</span>${badge}
              ${x.request?.convertedRate ? `<span class="muted tiny-text"> ${escapeHtml(String(x.request.body?.ratingStars || 0))}★ → ${escapeHtml(String(x.request.convertedRate))} 分</span>` : ''}
            </div>
            <div class="tiny-text mono">POST ${escapeHtml(req.url || '/v0/users/-/collections/{id}')}</div>
            <pre class="dry-body">${escapeHtml(JSON.stringify(body, null, 2))}</pre>
          </div>`;
        }

        // 豆瓣：attempts 里是各条备选通道构造出的真实请求 + 静态检查
        const attempts = x.attempts || [];
        const share = x.share;
        // 「目标状态不是看过 → 本次不写评分」这件事必须让用户看见，
        // 否则他会以为评分丢了，其实是豆瓣那条「只有看过能打分」的规则挡下来的
        const ratingRow = x.ratingNote
          ? `<div class="tiny-text"><span class="tag warn">未写评分</span> ${escapeHtml(x.ratingNote)}</div>`
          : '';
        const shareRow = share?.requested
          ? `<div class="tiny-text">分享广播：${
              share.applied
                ? `<span class="tag ok">已附上</span> <code>${escapeHtml(share.field.name)}=${escapeHtml(share.field.value)}</code> <span class="muted">字段名来源：${escapeHtml(share.field.via)}</span>`
                : `<span class="tag warn">未附上</span> <span class="muted">${escapeHtml(share.note || '没读到分享字段')}</span>`
            }</div>`
          : `<div class="tiny-text muted">分享广播：未勾选</div>`;

        const attemptsHtml = attempts
          .map((a) => {
            const form = a.request?.form || {};
            const masked = { ...form };
            if (masked.ck) masked.ck = `${String(masked.ck).slice(0, 4)}…（已取到）`;
            const checks = (a.checks || [])
              .map((c) => {
                // warn 是「能发但有隐患」（比如状态在看却带评分），单独用黄色，别混进绿色
                const cls = c.level === 'warn' ? 'warn' : c.ok ? 'ok' : 'bad';
                const mark = c.level === 'warn' ? '!' : c.ok ? '✓' : '✕';
                return `<span class="dry-check ${cls}" title="${escapeHtml(c.detail || '')}">${mark} ${escapeHtml(c.name)}</span>`;
              })
              .join('');
            return `<div class="dry-attempt">
              <div class="tiny-text"><b>${escapeHtml(a.label)}</b></div>
              <div class="tiny-text mono">POST ${escapeHtml(a.request?.url || '')}</div>
              <pre class="dry-body">${escapeHtml(JSON.stringify(masked, null, 2))}</pre>
              <div class="row" style="gap:6px;flex-wrap:wrap">${checks}</div>
            </div>`;
          })
          .join('');

        return `<div class="dry-item">
          <div class="row"><span class="tag douban">豆瓣</span>${badge}</div>
          ${ratingRow}
          ${shareRow}
          ${attemptsHtml || '<div class="tiny-text muted">没有可构造的写入通道</div>'}
        </div>`;
      })
      .join('');

    return `<div class="pair">
      <div class="title">${escapeHtml(e.title || '(无标题)')}</div>
      ${items}
    </div>`;
  });

  const summary =
    `<div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <span class="tag ${payload.failCount ? 'warn' : 'ok'}">演练完成</span>
      <span class="tiny-text">成功 ${payload.okCount} / 失败 ${payload.failCount} · 共 ${count} 条请求</span>
      <span style="flex:1"></span>
      <button class="tiny" id="btnDryCopy">复制全部 JSON</button>
      <button class="tiny" id="btnDryDownload">下载 JSON</button>
    </div>` +
    `<div class="hint" style="margin-bottom:10px">演练模式下<b>一个请求都没发出去</b>，下面是真正执行时会发的那几个请求。
     豆瓣列出多条是因为有三条备选通道（网页端 / rexxar 移动端 / frodo 移动端），
     实际执行时按顺序试到第一个成功的为止。</div>`;

  $('tab-dry').innerHTML = summary + rows.join('');

  $('btnDryCopy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.lastDry, null, 2));
      notify('已复制到剪贴板');
    } catch {
      notify('复制失败，浏览器拒绝了剪贴板权限', { ok: false });
    }
  });
  $('btnDryDownload')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.lastDry, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dry-run-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

const TARGET_LABEL = { douban: '豆瓣', bangumi: 'Bangumi' };

/** 工具栏上「会分享几条」的提示 */
function updateShareLine() {
  // 「分享广播」勾选框只在方向为 Bangumi→豆瓣 时才渲染。
  // 一条 →豆瓣 的都没有时，用户会在页面上找不到那个框 —— 与其让他去翻文档，
  // 不如在这里直接说清楚前置条件。
  const eligible = state.pairs.filter((p) => p.diffs.some((d) => d.selected && d.direction === 'toDouban'));
  const n = eligible.filter((p) => state.shareSet.has(p.key)).length;

  if (!eligible.length) {
    $('shareLine').innerHTML = state.pairs.length
      ? '<span class="muted">需先把方向设为「Bangumi → 豆瓣」才有「分享广播」可选</span>'
      : '都不发广播';
    return;
  }
  $('shareLine').textContent = n
    ? `已选 ${n} 条会发广播（广播发了撤不回，注意）`
    : `都不发广播（${eligible.length} 条可发）`;
}

// ---------------------------------------------------------------- 待确认匹配

function renderConfirm() {
  const host = $('tab-confirm');
  const list = withFilters(state.pairs.filter((p) => !p.subjectId && p.douban));
  const total = state.pairs.filter((p) => !p.subjectId && p.douban).length;
  if (!list.length) {
    host.innerHTML = isFiltering()
      ? `<div class="empty">没有符合${escapeHtml(filterDesc())}的待确认条目（共 ${total} 条被筛掉）</div>`
      : `<div class="empty">没有待确认的条目</div>`;
    return;
  }

  // 「Bangumi 独有」那边有批量反查豆瓣，这边的豆瓣条目同样需要一条对称的路：
  // 拿豆瓣标题去 Bangumi 搜，把候选直接列出来点选 —— 光靠「自动匹配」不够，
  // 它只在置信度够高时自动采纳，落在待确认里的正是它没把握的那些。
  host.innerHTML =
    `<div class="row" style="margin-bottom:8px">
       <button class="primary" id="btnForwardAll">批量反查 Bangumi</button>
       <span class="muted tiny-text">拿豆瓣标题逐个去 Bangumi 搜，够确信的自动建立对应，
       其余把候选列在下面点选${isFiltering() ? `（当前只反查筛出的 ${list.length} 条）` : ''}。</span>
     </div>` +
    `<div class="hint" style="margin-bottom:8px">这些是豆瓣有收藏、但没能在 Bangumi 上定下对应条目的记录。
     可以直接填 Bangumi 条目 ID，或点「搜 Bangumi」让扩展搜候选。
     <b>自动搜不到时，点「去 Bangumi 搜」自己找</b>，把地址里的数字 ID 粘回输入框。</div>` +
    list
      .map(
        (p) => `<div class="pair" data-ckey="${cssEscape(p.key)}">
      <div><span class="title">${escapeHtml(p.douban.title)}</span>
        <span class="muted tiny-text">${p.douban.year || '?'} · ${CATEGORY_LABEL[p.douban.category] || p.douban.category}${p.douban.originalTitle ? ` · ${escapeHtml(p.douban.originalTitle)}` : ''}</span></div>
      <div class="row" style="margin-top:8px">
        <input type="text" placeholder="直接填 Bangumi subject ID" style="width:190px" data-input="${cssEscape(p.key)}" />
        <button class="tiny" data-manual="${cssEscape(p.key)}">确定</button>
        <button class="tiny" data-fsearch="${cssEscape(p.key)}">搜 Bangumi</button>
        <button class="tiny" data-skip="${cssEscape(p.key)}">跳过此条</button>
        <a class="tiny-text" href="https://bgm.tv/subject_search/${encodeURIComponent(p.douban.title)}" target="_blank">去 Bangumi 搜</a>
      </div>
      <div class="tiny-text" data-fresult="${cssEscape(p.key)}" style="margin-top:6px">${forwardCandidatesHtml(p)}</div>
    </div>`
      )
      .join('');

  host.querySelectorAll('[data-manual]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.manual;
      const input = host.querySelector(`[data-input="${cssEscape(key)}"]`);
      const id = (input?.value || '').trim();
      if (!id || !/^\d+$/.test(id)) return notify('请填数字形式的 Bangumi subject ID', { ok: false });
      await send({ type: 'MAPPING_MANUAL', payload: { doubanId: key, subject: { id: Number(id) } } });
      await loadAll();
    })
  );
  host.querySelectorAll('[data-skip]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await send({ type: 'MAPPING_SKIP', payload: { doubanId: btn.dataset.skip } });
      await loadAll();
    })
  );

  $('btnForwardAll')?.addEventListener('click', () => runForwardAll(list));

  // 单条「搜 Bangumi」：只搜这一条，候选列在条目下面
  host.querySelectorAll('[data-fsearch]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.fsearch;
      const pair = list.find((p) => p.key === key);
      if (!pair) return;
      const out = host.querySelector(`[data-fresult="${cssEscape(key)}"]`);
      out.textContent = '搜索中…';
      try {
        const r = await send({ type: 'MATCH_ONE', payload: { key: pair.douban.id } });
        state.forwardReport[key] = r;
        renderConfirm();
        if (!r.candidates?.length) {
          notify(`没搜到候选：${r.reason || 'Bangumi 无结果'}`, { ok: false });
        }
      } catch (e) {
        state.forwardReport[key] = { status: 'error', reason: e.message, candidates: [] };
        renderConfirm();
      }
    })
  );

  // 候选「用它」：直接写映射表
  host.querySelectorAll('[data-fpick]').forEach((b) =>
    b.addEventListener('click', async () => {
      const key = b.dataset.fpick;
      const pair = list.find((p) => p.key === key);
      if (!pair) return;
      await send({
        type: 'MAPPING_MANUAL',
        payload: {
          doubanId: pair.douban.id,
          subject: {
            id: Number(b.dataset.id),
            name: b.dataset.name || '',
            name_cn: b.dataset.cn || '',
            category: pair.douban.category || '',
          },
        },
      });
      await loadAll();
    })
  );
}

/** 待确认条目下面已经搜到过的 Bangumi 候选 */
function forwardCandidatesHtml(p) {
  // 优先用单条搜索的结果，其次用「自动匹配」留下的候选
  const rec = state.forwardReport[p.key] || state.matchReport?.candidates?.find((c) => c.key === p.key);
  if (!rec) return '';
  if (rec.status === 'matched' && rec.linked) {
    return `<span class="tag ok">已自动对应</span> 
      <a href="${rec.subject?.url || '#'}" target="_blank">${escapeHtml(rec.subject?.name_cn || rec.subject?.name || '')}</a>
      <span class="muted">置信度 ${(rec.confidence ?? 0).toFixed(2)}</span>`;
  }
  if (!rec.candidates?.length) {
    return `<span class="muted">反查未找到：${escapeHtml(rec.reason || '无候选')}</span>`;
  }
  return `${escapeHtml(rec.reason || '候选如下')}（置信度从高到低）：
    ${rec.candidates
      .slice(0, 6)
      .map(
        (c) =>
          `<div class="cand"><a href="${c.url || `https://bgm.tv/subject/${c.id}`}" target="_blank">${escapeHtml(c.name_cn || c.name || '')}</a>
            <span class="muted tiny-text">${escapeHtml(c.name || '')} · ${c.date ? String(c.date).slice(0, 4) : '?'} · ${(c.score ?? 0).toFixed(2)}</span>
            <button class="tiny" data-fpick="${cssEscape(p.key)}" data-id="${c.id}" data-cn="${escapeHtml(c.name_cn || '')}" data-name="${escapeHtml(c.name || '')}">用它</button></div>`
      )
      .join('')}`;
}

/** 批量反查 Bangumi：对当前（筛选后的）待确认条目逐个搜 Bangumi */
async function runForwardAll(list) {
  if (state.busy) return;
  const keys = list.map((p) => p.douban.id).filter(Boolean);
  if (!keys.length) return notify('没有需要反查的条目', { ok: false });
  const go = await confirmDialog({
    title: '批量反查 Bangumi',
    message:
      `将对 ${keys.length} 条豆瓣条目逐个搜索 Bangumi，置信度够高的自动建立对应。\n` +
      `Bangumi 搜索有限流，量大时会比较慢。`,
    okText: '开始反查',
  });
  if (!go) return;

  setBusy(true, '反查 Bangumi 中…');
  setBar(0);
  try {
    const r = await sendStream({ type: 'MATCH_FORWARD', payload: { keys } }, (p) => {
      $('progressLine').textContent = p.message || `反查 ${p.index}/${p.total}`;
      if (p.total) setBar((p.index / p.total) * 100);
    });
    state.matchReport = { matched: r.matched, candidates: r.out || [] };
    state.forwardReport = {};
    for (const o of r.out || []) state.forwardReport[o.key] = o;
    state.mapping = r.mapping || (await send({ type: 'MAPPING_GET' }));
    recompute();
    renderAll();
    $('progressLine').innerHTML =
      `<span class="tag ${r.matched ? 'ok' : 'warn'}">反查完成</span> ` +
      `自动建立对应 <b>${r.matched}</b> 条，待确认 ${r.candidate} 条，未找到 ${r.unmatched} 条` +
      (r.candidate ? `<span class="muted tiny-text">（候选已列在下面，点「用它」即可）</span>` : '');
  } catch (e) {
    $('progressLine').innerHTML = `<span class="tag danger">反查失败</span> ${escapeHtml(e.message)}`;
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- Bangumi 独有

function renderOrphan() {
  const host = $('tab-orphan');
  const all = state.pairs.filter((p) => p.flags.includes('missing-in-douban'));
  const list = withFilters(all);
  if (!list.length) {
    host.innerHTML = isFiltering()
      ? `<div class="empty">没有符合${escapeHtml(filterDesc())}的 Bangumi 独有条目（共 ${all.length} 条被筛掉）</div>`
      : `<div class="empty">Bangumi 上的收藏都已和豆瓣条目建立对应</div>`;
    return;
  }
  host.innerHTML =
    `<div class="row" style="margin-bottom:8px">
       <button class="primary" id="btnReverseAll">批量反查豆瓣</button>
       <span class="muted tiny-text">拿 Bangumi 标题逐个去豆瓣搜，置信度够高的自动建立对应，
       剩下的把候选直接列在下面供你点选——不用再一条条点「搜豆瓣」。
       ${isFiltering() ? `当前只反查筛出的 ${list.length} 条。` : ''}</span>
     </div>` +
    `<div class="hint" style="margin-bottom:8px">这些是 Bangumi 有收藏、但没能在豆瓣列表里找到对应条目的记录。
     要在豆瓣侧新建收藏，需要先指定它对应的豆瓣条目 ID。<br />
     <b>「搜豆瓣」解析不到结果时，点「去豆瓣搜」在豆瓣页面里自己找</b>，把条目地址里的数字 ID 粘回输入框即可——这条路永远可用。</div>` +
    list
      .map(
        (p) => `<div class="pair" data-okey="${cssEscape(p.key)}">
        <div><span class="title">${escapeHtml(p.bangumi?.title || '')}</span>
          <span class="muted tiny-text">${p.bangumi?.year || '?'} · ${STATUS_LABEL[p.bangumi?.status] || ''}${p.bangumi?.rating ? ` · ${p.bangumi.rating} 星` : ''}</span></div>
        <div class="row" style="margin-top:8px">
          <input type="text" placeholder="豆瓣条目 ID" style="width:170px" data-oinput="${cssEscape(p.key)}" />
          <button class="tiny" data-olink="${cssEscape(p.key)}">建立对应</button>
          <button class="tiny" data-osearch="${cssEscape(p.key)}">搜豆瓣</button>
          <a class="tiny" href="${manualSearchUrl(p)}" target="_blank">去豆瓣搜</a>
          <a class="tiny-text" href="${p.bangumi?.url || '#'}" target="_blank">Bangumi 条目</a>
        </div>
        ${reverseCandidatesHtml(p)}
        <div class="tiny-text" data-oresult="${cssEscape(p.key)}"></div>
      </div>`
      )
      .join('');

  $('btnReverseAll')?.addEventListener('click', () => runReverseAll(list));
  host.querySelectorAll('[data-rpick]').forEach((b) =>
    b.addEventListener('click', async () => {
      const key = b.dataset.rpick;
      const pair = list.find((p) => p.key === key);
      if (!pair) return;
      await send({
        type: 'MAPPING_MANUAL',
        payload: {
          doubanId: `douban:${b.dataset.id}`,
          subject: { id: pair.bangumi.subjectId, name: pair.bangumi.originalTitle, name_cn: pair.bangumi.title, category: pair.bangumi.category },
        },
      });
      await loadAll();
    })
  );

  host.querySelectorAll('[data-olink]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.olink;
      const pair = list.find((p) => p.key === key);
      const input = host.querySelector(`[data-oinput="${cssEscape(key)}"]`);
      const id = (input?.value || '').trim();
      if (!id || !/^\d+$/.test(id)) return notify('请填数字形式的豆瓣条目 ID', { ok: false });
      await send({
        type: 'MAPPING_MANUAL',
        payload: { doubanId: `douban:${id}`, subject: { id: pair.bangumi.subjectId, name: pair.bangumi.originalTitle, name_cn: pair.bangumi.title, category: pair.bangumi.category } },
      });
      await loadAll();
    })
  );

  host.querySelectorAll('[data-osearch]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const key = btn.dataset.osearch;
      const pair = list.find((p) => p.key === key);
      const out = host.querySelector(`[data-oresult="${cssEscape(key)}"]`);
      const keyword = pair.bangumi.title || pair.bangumi.originalTitle || '';
      out.textContent = `搜索中…（关键词：${keyword}）`;
      try {
        const r = await send({
          type: 'DOUBAN_SEARCH_SUBJECT',
          payload: { keyword, site: categoryToSite(pair.bangumi.category) },
        });
        if (!r.items?.length) {
          const why = (r.attempts || [])
            .map((a) => `· ${a.url}${a.blocked ? ` 被拦：${a.blocked}` : a.error ? ` 出错：${a.error}` : ` HTTP ${a.status ?? '?'} / ${a.bytes ?? '?'} 字节，解析出 0 条`}`)
            .join('<br />');
          out.innerHTML =
            `<span class="tag warn">没搜到</span> ${escapeHtml(r.reason || '')}<br />` +
            `<span class="muted">试试换关键词，或点「去豆瓣搜」自己在豆瓣页面里找，把地址里的数字 ID 粘回输入框。</span>` +
            (why ? `<div class="muted" style="margin-top:4px">${why}</div>` : '');
          return;
        }
        const viaTag = r.via === 'json' ? '<span class="tag ok">内嵌数据</span>' : r.via === 'dom' ? '<span class="tag ok">页面结构</span>' : '';
        out.innerHTML =
          `${viaTag} 搜到 ${r.items.length} 条：<br />` +
          r.items
            .slice(0, 6)
            .map(
              (it) =>
                `<div class="cand"><a href="${it.url}" target="_blank">${escapeHtml(it.title)}</a>
               <span class="muted tiny-text">${it.year || '?'}</span>
               <button class="tiny" data-pick="${cssEscape(key)}" data-id="${it.id}">用它</button></div>`
            )
            .join('');
        out.querySelectorAll('[data-pick]').forEach((b) =>
          b.addEventListener('click', async () => {
            await send({
              type: 'MAPPING_MANUAL',
              payload: { doubanId: `douban:${b.dataset.id}`, subject: { id: pair.bangumi.subjectId, name: pair.bangumi.originalTitle, name_cn: pair.bangumi.title, category: pair.bangumi.category } },
            });
            await loadAll();
          })
        );
      } catch (e) {
        out.textContent = `搜索失败: ${e.message}`;
      }
    })
  );
}

function categoryToSite(cat) {
  return cat === 'book' ? 'book' : cat === 'music' ? 'music' : 'movie';
}

/** 批量反查后留下的结果里，找某一条的记录 */
function reverseResultFor(key) {
  return state.reverseReport?.out?.find((o) => o.key === key) || null;
}

/** 把批量反查给出的候选直接列在条目下面，点「用它」即可建立对应 */
function reverseCandidatesHtml(p) {
  const rec = reverseResultFor(p.key);
  if (!rec) return '';
  if (rec.status === 'matched' && rec.linked) {
    return `<div class="tiny-text" style="margin-top:6px"><span class="tag ok">已自动对应</span>
      <a href="${rec.douban?.url || '#'}" target="_blank">${escapeHtml(rec.douban?.title || '')}</a>
      <span class="muted">${rec.douban?.year || '?'} · 置信度 ${(rec.confidence ?? 0).toFixed(2)}</span></div>`;
  }
  if (!rec.candidates?.length) {
    return `<div class="tiny-text muted" style="margin-top:6px">反查未找到：${escapeHtml(rec.reason || '无候选')}</div>`;
  }
  return `<div class="tiny-text" style="margin-top:6px">
      ${rec.status === 'conflict' ? `<span class="tag warn">豆瓣条目已被占用</span> ` : ''}
      ${escapeHtml(rec.reason || '候选如下')}：
      ${rec.candidates
        .slice(0, 5)
        .map(
          (c) =>
            `<div class="cand"><a href="${c.url || '#'}" target="_blank">${escapeHtml(c.title)}</a>
              <span class="muted tiny-text">${c.year || '?'} · ${(c.score ?? 0).toFixed(2)}</span>
              <button class="tiny" data-rpick="${cssEscape(p.key)}" data-id="${c.id}">用它</button></div>`
        )
        .join('')}
    </div>`;
}

async function runReverseAll(list) {
  if (state.busy) return;
  const targets = list || state.pairs.filter((p) => p.flags.includes('missing-in-douban'));
  const n = targets.length;
  if (!n) return notify('没有需要反查的条目', { ok: false });
  const go = await confirmDialog({
    title: '批量反查豆瓣',
    message:
      `将对 ${n} 条 Bangumi 独有条目逐个搜索豆瓣，置信度够高的自动建立对应。\n` +
      `豆瓣搜索有频率限制，量大时会比较慢。`,
    okText: '开始反查',
  });
  if (!go) return;

  setBusy(true, '反查中…');
  setBar(0);
  try {
    const r = await sendStream({ type: 'MATCH_REVERSE', payload: { keys: targets.map((p) => p.key) } }, (p) => {
      $('progressLine').textContent = p.message || `反查 ${p.index}/${p.total}`;
      if (p.total) setBar((p.index / p.total) * 100);
    });
    state.reverseReport = r;
    state.mapping = r.mapping || (await send({ type: 'MAPPING_GET' }));
    recompute();
    renderAll();
    $('progressLine').innerHTML =
      `<span class="tag ${r.linked ? 'ok' : 'warn'}">反查完成</span> ` +
      `自动建立对应 <b>${r.linked}</b> 条，待确认 ${r.candidate} 条，未找到 ${r.unmatched} 条` +
      (r.candidate ? `<span class="muted tiny-text">（待确认的候选已列在下面，点「用它」即可）</span>` : '');
  } catch (e) {
    $('progressLine').innerHTML = `<span class="tag danger">反查失败</span> ${escapeHtml(e.message)}`;
  } finally {
    setBusy(false);
  }
}

/** 手动兜底：直接打开豆瓣搜索页，让用户自己找条目（自动解析失效时这条路永远可用） */
function manualSearchUrl(p) {
  const site = categoryToSite(p?.bangumi?.category);
  const kw = p?.bangumi?.title || p?.bangumi?.originalTitle || '';
  return `https://search.douban.com/${site}/subject_search?search_text=${encodeURIComponent(kw)}`;
}

// ---------------------------------------------------------------- 日志

async function renderLog() {
  const log = await send({ type: 'LOG_GET' });
  $('tab-log').innerHTML =
    `<div class="row" style="margin-bottom:8px"><button class="tiny" id="btnClearLog">清空日志</button></div>` +
    `<pre class="log">${escapeHtml(log.map((l) => `[${String(l.t).slice(11, 19)}] ${l.msg}`).join('\n') || '（暂无）')}</pre>`;
  $('btnClearLog')?.addEventListener('click', async () => {
    await send({ type: 'LOG_CLEAR' });
    renderLog();
  });
}

// ---------------------------------------------------------------- 操作

function setBusy(busy, text) {
  state.busy = busy;
  ['btnScan', 'btnMatch', 'btnDry', 'btnRun', 'btnReverseAll'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy;
  });
  if (text) $('progressLine').textContent = text;
}

function setBar(pct) {
  $('bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

$('btnScan').addEventListener('click', async () => {
  setBusy(true, '准备扫描…');
  setBar(0);
  try {
    const snap = await sendStream({ type: 'SCAN' }, (p) => {
      $('progressLine').textContent = p.message || '';
      if (p.stage === 'done') setBar(100);
      else if (p.stage === 'bangumi') setBar(60);
      else setBar(20 + Math.min(30, (p.count || 0) / 5));
    });
    state.snapshot = snap;
    state.mapping = await send({ type: 'MAPPING_GET' });
    recompute();
    renderAll();
    $('progressLine').textContent = `扫描完成：豆瓣 ${snap.douban.length} 条，Bangumi ${snap.bangumi.length} 条`;
  } catch (e) {
    $('progressLine').innerHTML = `<span class="tag danger">扫描失败</span> ${escapeHtml(e.message)}`;
  } finally {
    setBusy(false);
  }
});

$('btnMatch').addEventListener('click', async () => {
  setBusy(true, '匹配中…');
  try {
    const r = await sendStream({ type: 'MATCH' }, (p) => {
      $('progressLine').textContent = p.message || `匹配 ${p.index}/${p.total}`;
      if (p.total) setBar((p.index / p.total) * 100);
    });
    state.mapping = r.mapping || (await send({ type: 'MAPPING_GET' }));
    state.matchReport = r;
    recompute();
    renderAll();
    $('progressLine').innerHTML =
      `匹配完成：自动采纳 ${r.matched} 条，待确认 ${r.candidates.filter((c) => c.status === 'candidate').length} 条，` +
      `无候选 ${r.candidates.filter((c) => c.status === 'unmatched').length} 条`;
  } catch (e) {
    $('progressLine').innerHTML = `<span class="tag danger">匹配失败</span> ${escapeHtml(e.message)}`;
  } finally {
    setBusy(false);
  }
});

$('btnReload').addEventListener('click', () => {
  recompute();
  renderAll();
});

// ---------------------------------------------------------------- 搜索栏

$('q').addEventListener('input', () => {
  state.query = $('q').value || '';
  renderAll();
});
$('btnClearQ').addEventListener('click', () => {
  $('q').value = '';
  state.query = '';
  state.statusFilter = 'all';
  renderAll();
});

// 分类筛选：只想看某一类收藏时一键收窄列表。
// 与搜索栏一样只改显示 —— 隐藏掉的条目勾选状态原样保留，切回「全部」就都回来。
document.querySelectorAll('[data-filter]').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.statusFilter = btn.dataset.filter === state.statusFilter ? 'all' : btn.dataset.filter;
    renderAll();
  })
);

// 原地跳转而不是 tabs.create：两边同为扩展自己的页面、同源，
// 就地导航不会多开标签页，浏览器后退按钮也能退回同步面板
$('btnOpenOptions').addEventListener('click', () => {
  goToPage('src/ui/options.html');
});

// 批量勾选「分享到广播」：只作用于真会往豆瓣写的条目 ——
// 往 Bangumi 写的东西，不存在发豆瓣广播这回事，别让用户白勾
document.querySelectorAll('[data-sharebulk]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const on = btn.dataset.sharebulk === 'all';
    for (const p of visiblePairs()) {
      const writesDouban = p.diffs.some((d) => d.selected && d.direction === 'toDouban');
      if (on) {
        if (writesDouban) state.shareSet.add(p.key);
      } else {
        state.shareSet.delete(p.key);
      }
    }
    if (on && !state.shareSet.size) {
      notify('没有「→豆瓣」的条目，没有可以分享的对象', { ok: false });
      return;
    }
    const y = window.scrollY;
    renderDiff();
    window.scrollTo(0, y);
  })
);

// 批量按钮的语义（改过一次，原因值得记下来）：
// 旧的「全部 豆瓣→Bangumi」是**改写**——把筛出来的每条每个字段的方向都掰成 toBgm，
// 于是原本该反向同步的字段也被一起翻过去，用户看到的「全部跳过」则把方向也清掉了。
// 现在拆成两类：
//   all / none        只动勾选，方向一个都不改（取消全选 ≠ 重置匹配结果）
//   pick-toBgm / …    按「匹配完的建议方向」挑选，其余只取消勾选、保留原方向
document.querySelectorAll('[data-bulk]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const v = btn.dataset.bulk;
    // 只作用于搜索筛出来的条目：正在筛选时，用户要的是「对这几条做」而不是动全部
    for (const p of visiblePairs()) {
      if (v === 'all') setPairSelected(p, true);
      else if (v === 'none') setPairSelected(p, false);
      else if (v === 'pick-toBgm') selectBySuggestion(p, 'toBgm');
      else if (v === 'pick-toDouban') selectBySuggestion(p, 'toDouban');
    }
    renderDiff();
  })
);

async function runSync(dryRun) {
  if (state.busy) return;
  const todo = state.pairs.filter((p) => p.diffs.some((d) => d.selected && d.direction));
  if (!todo.length) return notify('没有勾选任何要同步的项', { ok: false });

  // 逐条的「分享到广播」选择落到 pair 上，后台执行时照此办理。
  // 只有真会往豆瓣写的条才算数，否则等于让用户以为发了广播其实没发。
  for (const p of todo) {
    p.shareBroadcast = state.shareSet.has(p.key) && p.diffs.some((d) => d.selected && d.direction === 'toDouban');
  }
  const shareCount = todo.filter((p) => p.shareBroadcast).length;

  if (!dryRun) {
    const go = await confirmDialog({
      title: '执行同步',
      message:
        `即将写入 ${todo.length} 条记录。\n豆瓣写入不可逆，建议先用「演练」看清请求内容。` +
        (shareCount
          ? `\n\n其中 ${shareCount} 条会同时发到豆瓣广播 —— 广播会被关注者看到，且发出后撤不回来。`
          : ''),
      okText: '确定写入',
      danger: true,
    });
    if (!go) return;
  }

  setBusy(true, dryRun ? '演练中…' : '执行中…');
  setBar(0);
  try {
    const r = await sendStream(
      { type: 'SYNC', payload: { pairs: todo, dryRun } },
      (p) => {
        $('progressLine').textContent = `${p.done || 0}/${p.total || 0} ${p.entry?.title || ''}`;
        if (p.total) setBar((p.done / p.total) * 100);
      }
    );
    const fails = [];
    const mismatches = [];
    for (const e of r.results) {
      for (const x of e.results) {
        if (!x.ok) fails.push(`${e.title}: ${x.error || '失败'}`);
        if (x.statusMismatch) {
          mismatches.push(
            `${e.title}: 期望「${STATUS_LABEL[x.request?.status] || x.request?.status || '?'}」，` +
              `豆瓣回读「${STATUS_LABEL[x.verify?.status] || x.verify?.rawStatus || '未知'}」`
          );
        }
      }
    }
    $('progressLine').innerHTML =
      `<span class="tag ${fails.length ? 'warn' : 'ok'}">${dryRun ? '演练' : '执行'}完成</span> ` +
      `成功 ${r.okCount}，失败 ${r.failCount}`;
    if (dryRun) {
      // 完整明细进「演练结果」页签，不再让用户去翻 F12 控制台
      console.log('[dry-run]', r.results);
      await renderDryResult(r);
      await switchTab('dry');
      $('progressLine').innerHTML +=
        ` <span class="muted tiny-text">完整结果见「演练结果」页签</span>`;
    }
    if (fails.length) {
      $('progressLine').innerHTML += `<div class="tiny-text">${escapeHtml(fails.slice(0, 8).join('\n'))}</div>`;
    }
    if (mismatches.length) {
      // 写完回读对不上：说明「接口说成功」和「页面上看到的不一样」。
      // 常见原因是豆瓣自己把带评分的收藏升级成「看过」，也有可能是这次写入根本没生效。
      // 与其悄悄过去，不如把证据摆出来，用户能拿它去对豆瓣页面上实际显示的状态。
      $('progressLine').innerHTML +=
        `<div class="tiny-text" style="color:#b42318;margin-top:4px">` +
        `<b>${mismatches.length} 条状态校验不符</b>（写入后回读豆瓣，实际状态与预期不一致）：<br />` +
        `${escapeHtml(mismatches.slice(0, 8).join('\n'))}<br />` +
        `<span class="muted">常见原因：豆瓣只让「看过」打分，带评分提交会被它升级成「看过」；` +
        `也可能是这条写入没真正生效。到豆瓣页面上核对该条目的实际状态。</span></div>`;
    }
  } catch (e) {
    $('progressLine').innerHTML = `<span class="tag danger">失败</span> ${escapeHtml(e.message)}`;
  } finally {
    setBusy(false);
    if (!dryRun) await loadAll();
  }
}

$('btnDry').addEventListener('click', () => runSync(true));
$('btnRun').addEventListener('click', () => runSync(false));

const TAB_KEYS = ['diff', 'confirm', 'orphan', 'log', 'dry'];

async function switchTab(t) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  TAB_KEYS.forEach((k) => $(`tab-${k}`).classList.toggle('hidden', k !== t));
  renderFilterCounts(); // 各分类的条数随页签变，切页签要重算
  if (t === 'log') await renderLog();
}

document.querySelectorAll('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

// ---------------------------------------------------------------- utils

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(s, n) {
  return String(s).length > n ? `${String(s).slice(0, n)}…` : String(s);
}

// 用作属性选择器时避免引号/特殊字符破坏
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

loadAll().catch((e) => {
  $('statusLine').innerHTML = `<span class="tag danger">加载失败</span> ${escapeHtml(e.message)}`;
});
