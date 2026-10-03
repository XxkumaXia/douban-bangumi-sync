// 同步面板的端到端冒烟：用 jsdom 加载真实的 sync.html，mock 掉后台通信后 import 真实的 sync.js。
// 运行：node tests/sync-panel.test.mjs
//
// 这一套盯的是「页面能不能真的用」，而不是单个函数：
//   1. 搜索栏改的是显示，绝不能顺手改掉勾选（改坏了会静默同步错条目）；
//   2. 批量按钮的作用范围要跟着搜索走；
//   3. 新加的按钮（批量反查 Bangumi / 搜 Bangumi）必须真的挂在页面上 ——
//      页面是 HTML + 模块 JS 两张皮，漏绑一个事件就是「点了没反应」，肉眼极难发现。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const jsdomPath = process.env.JSDOM_PATH || 'jsdom';
const { JSDOM } = await import(jsdomPath);

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const html = fs.readFileSync(path.join(root, 'src/ui/sync.html'), 'utf8');

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};
const truthy = (name, v) => {
  if (v) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} -> ${JSON.stringify(v)}`);
  }
};

// ---------------------------------------------------------------- 测试数据

const douban = [
  {
    id: 'douban:1',
    source: 'douban',
    title: '进击的巨人 最终季',
    originalTitle: '進撃の巨人 The Final Season',
    year: 2020,
    category: 'anime',
    status: 'done',
    rating: 5,
    comment: '',
    tags: [],
    updatedAt: '2023-01-01T00:00:00Z',
    url: 'https://movie.douban.com/subject/1/',
    doubanSite: 'movie',
    doubanSubType: '',
    rawRating: 5,
    subjectId: null,
    subjectType: null,
  },
  {
    id: 'douban:2',
    source: 'douban',
    title: '攻壳机动队',
    originalTitle: 'Ghost in the Shell',
    year: 1995,
    category: 'anime',
    status: 'wish',
    rating: 0,
    comment: '',
    tags: [],
    updatedAt: '2023-02-01T00:00:00Z',
    url: 'https://movie.douban.com/subject/2/',
    doubanSite: 'movie',
    doubanSubType: '',
    rawRating: 0,
    subjectId: null,
    subjectType: null,
  },
  // douban:3 没建任何对应 —— 它会落进「待确认匹配」
  {
    id: 'douban:3',
    source: 'douban',
    title: '钢之炼金术师',
    originalTitle: '鋼の錬金術師',
    year: 2003,
    category: 'anime',
    status: 'done',
    rating: 5,
    comment: '',
    tags: [],
    updatedAt: '2023-05-01T00:00:00Z',
    url: 'https://movie.douban.com/subject/3/',
    doubanSite: 'movie',
    doubanSubType: '',
    rawRating: 5,
    subjectId: null,
    subjectType: null,
  },
];

// bgm:11 通过映射表对上 douban:2（两边都有记录，才有差异可同步）；
// bgm:22 没对上任何豆瓣条目，属于「Bangumi 独有」
const bangumi = [
  {
    id: 'bgm:11',
    source: 'bangumi',
    title: '攻壳机动队',
    originalTitle: 'GHOST IN THE SHELL',
    year: 1995,
    category: 'anime',
    status: 'doing',
    rating: 4,
    comment: '',
    tags: [],
    updatedAt: '2023-03-01T00:00:00Z',
    url: 'https://bgm.tv/subject/11',
    doubanSite: null,
    doubanSubType: '',
    rawRating: 8,
    subjectId: 11,
    subjectType: 2,
  },
  {
    id: 'bgm:22',
    source: 'bangumi',
    title: '进击的巨人',
    originalTitle: '進撃の巨人',
    year: 2013,
    category: 'anime',
    status: 'wish',
    rating: 0,
    comment: '',
    tags: [],
    updatedAt: '2023-04-01T00:00:00Z',
    url: 'https://bgm.tv/subject/22',
    doubanSite: null,
    doubanSubType: '',
    rawRating: 0,
    subjectId: 22,
    subjectType: 2,
  },
  {
    id: 'bgm:33',
    source: 'bangumi',
    title: '进击的巨人 最终季',
    originalTitle: '進撃の巨人 The Final Season',
    year: 2020,
    category: 'anime',
    status: 'wish',
    rating: 0,
    comment: '',
    tags: [],
    updatedAt: '2022-01-01T00:00:00Z',
    url: 'https://bgm.tv/subject/33',
    doubanSite: null,
    doubanSubType: '',
    rawRating: 0,
    subjectId: 33,
    subjectType: 2,
  },
];

// douban:1 ↔ bgm:33、douban:2 ↔ bgm:11 都已建立对应（两边都有记录，才会产生差异）
const mapping = {
  'douban:1': { subjectId: 33, name: '進撃の巨人 The Final Season', nameCn: '进击的巨人 最终季', mode: 'auto', confidence: 0.9 },
  'douban:2': { subjectId: 11, name: 'GHOST IN THE SHELL', nameCn: '攻壳机动队', mode: 'auto', confidence: 0.9 },
};

const snapshot = {
  scannedAt: new Date().toISOString(),
  douban,
  bangumi,
  meta: { doubanTotal: douban.length, bgmTotal: bangumi.length },
};

const settings = {
  syncStatus: true,
  syncRating: true,
  syncComment: false,
  syncTags: false,
  conflictPolicy: 'newer',
  allowClear: false,
  categories: { anime: true, real: true, book: false, music: false, game: false },
};

// ---------------------------------------------------------------- DOM 环境

const dom = new JSDOM(html, { url: 'https://example.org/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;
// navigator 在 Node 里是只读的 getter，别去覆盖它；演练面板的复制按钮只是可选能力

// 后台通信：只回应读取类消息，写入类按需记录
const sent = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      sent.push(msg.type);
      if (msg.type === 'SETTINGS_GET') return cb({ ok: true, data: settings });
      if (msg.type === 'SNAPSHOT_GET') return cb({ ok: true, data: snapshot });
      if (msg.type === 'MAPPING_GET') return cb({ ok: true, data: mapping });
      if (msg.type === 'LOG_GET') return cb({ ok: true, data: [] });
      return cb({ ok: true, data: null });
    },
    connect: () => ({
      onMessage: { addListener() {} },
      onDisconnect: { addListener() {} },
      postMessage() {},
      disconnect() {},
    }),
  },
};

const $ = (id) => document.getElementById(id);
const pairCount = (tabId) => $(tabId).querySelectorAll('.pair').length;

// import 即相当于打开同步面板（sync.js 顶层会 loadAll + renderAll）
await import(pathToFileURL(path.join(root, 'src/ui/sync.js')).href);
await new Promise((r) => setTimeout(r, 0)); // 等 loadAll 的 Promise 链走完

console.log('=== 1. 页面渲染 ===');
truthy('差异列表渲染出了条目', pairCount('tab-diff') >= 1);
truthy('待确认匹配里列出了豆瓣条目', pairCount('tab-confirm') >= 1);
truthy('Bangumi 独有里列出了孤儿条目', pairCount('tab-orphan') >= 1);
truthy('待确认页签有「批量反查 Bangumi」按钮', !!$('btnForwardAll'));
truthy('Bangumi 独有页签有「批量反查豆瓣」按钮', !!$('btnReverseAll'));
truthy('每条待确认条目都有「搜 Bangumi」', $('tab-confirm').querySelectorAll('[data-fsearch]').length >= 1);

console.log('=== 2. 搜索栏只改显示，不动勾选 ===');
const beforeSel = $('selLine').textContent;
const totalDiff = pairCount('tab-diff');
truthy('搜索框存在', !!$('q'));

$('q').value = '攻壳';
$('q').dispatchEvent(new window.Event('input'));
eq('搜索后只剩命中的条目', pairCount('tab-diff'), 1);
eq('差异列表里的确是「攻壳机动队」', $('tab-diff').textContent.includes('攻壳机动队'), true);
eq('搜索不动勾选（将写入项不变）', $('selLine').textContent, beforeSel);
truthy('顶部显示筛选计数', /筛出 1 \/ \d+ 条/.test($('qLine').textContent));
truthy('批量按钮标注了作用范围', /批量只作用于筛出的 1 条/.test($('bulkLine').textContent));

console.log('=== 3. 清除搜索后全部回来 ===');
$('btnClearQ').dispatchEvent(new window.Event('click'));
eq('清除后条目数恢复', pairCount('tab-diff'), totalDiff);
eq('清除后不再显示筛选计数', $('qLine').textContent, '');

console.log('=== 4. 批量按钮跟着筛选走 ===');
$('q').value = '攻壳';
$('q').dispatchEvent(new window.Event('input'));
document.querySelector('[data-bulk="none"]').dispatchEvent(new window.Event('click'));
$('btnClearQ').dispatchEvent(new window.Event('click'));
const activeOf = (key) => $(`tab-diff`).querySelector(`[data-key="${key}"] .dirbtn.active`)?.dataset.dir;
eq('筛出的那条被设为跳过', activeOf('douban:2'), 'none');
truthy('没被筛出的那条不受影响', activeOf('douban:1') !== 'none');

console.log('=== 5. 批量选择：全选/取消全选只动勾选，按方向选只挑建议的 ===');
// 数据说明：douban:1 两侧都有值且豆瓣更新 → 建议「豆瓣→Bangumi」；
//           douban:2 是 Bangumi 更新 → 建议「Bangumi→豆瓣」。两种建议各占一条。
const clickBulk = (v) => document.querySelector(`[data-bulk="${v}"]`).dispatchEvent(new window.Event('click'));
const selText = () => $('selLine').textContent;
const selNums = () => {
  const m = /将写入 (\d+) 项（→Bangumi (\d+) \/ →豆瓣 (\d+)）/.exec(selText());
  return m ? { total: +m[1], toBgm: +m[2], toDouban: +m[3] } : null;
};

$('btnClearQ').dispatchEvent(new window.Event('click')); // 从上一节的搜索里退出
clickBulk('all');
const allSel = selText();
truthy('全选后有可写入项', selNums().total > 0);

clickBulk('none');
eq('取消全选：没有勾选任何项', selNums().total, 0);
clickBulk('all');
eq('再全选：数量完全恢复（取消全选没改方向、没动匹配结果）', selText(), allSel);

clickBulk('pick-toBgm');
eq('只选 豆瓣→Bangumi：不选反向那些', selNums().toDouban, 0);
truthy('只选 豆瓣→Bangumi：把该方向的都选上了', selNums().toBgm > 0);
clickBulk('pick-toDouban');
eq('只选 Bangumi→豆瓣：不选反向那些', selNums().toBgm, 0);
truthy('只选 Bangumi→豆瓣：把该方向的都选上了', selNums().toDouban > 0);

// 只选之后切回全选，两边应同时回来 —— 证明「只选」没把另一边删掉
clickBulk('all');
truthy('只选之后仍能全选回来（方向没被抹掉）', selNums().toBgm > 0 && selNums().toDouban > 0);

truthy(
  '按钮上写明各方向条数',
  /只选 豆瓣→Bangumi（\d+）/.test(document.querySelector('[data-bulk="pick-toBgm"]').textContent)
);
truthy('页面上有「全选」而不是「全部跳过」', document.body.textContent.includes('全选'));
eq('「全部跳过」这个说法已经不在页面上', /全部跳过/.test(document.body.textContent), false);

console.log('=== 6. 搜不到时给出说明而不是空白 ===');
$('q').value = '不存在的作品名';
$('q').dispatchEvent(new window.Event('input'));
eq('差异页签为空', pairCount('tab-diff'), 0);
truthy('提示里说明被筛掉了多少条', /被筛掉/.test($('tab-diff').textContent));
$('btnClearQ').dispatchEvent(new window.Event('click'));

console.log('=== 7. 分类筛选：一键只看某一类收藏 ===');
const clickFilter = (k) =>
  document.querySelector(`[data-filter="${k}"]`).dispatchEvent(new window.Event('click'));
const diffKeys = () =>
  [...$('tab-diff').querySelectorAll('[data-key]')].map((e) => e.dataset.key);
// 数据说明：douban:1 豆瓣 done / Bangumi wish；douban:2 豆瓣 wish / Bangumi doing。
// 两端状态不一致，所以按「任一侧命中」判定：douban:1 同时算 wish 和 done，douban:2 同时算 wish 和 doing。
const allDiff = diffKeys().slice();
const countOf = (k) => document.querySelector(`[data-count="${k}"]`).textContent;

truthy('分类按钮挂在页面上', !!document.querySelector('[data-filter="doing"]'));
truthy('按钮上写明各分类条数', /^\(\d+\)$/.test(countOf('doing')));
eq('「在看」计数正确', countOf('doing'), '(1)');
eq('「看过」计数正确', countOf('done'), '(1)');
eq('「想看」两侧都占，所以是 2', countOf('wish'), '(2)');

clickFilter('doing');
eq('只看「在看」：只剩 Bangumi 侧在看的那一对', diffKeys(), ['douban:2']);
// 计数必须始终反映「这一页里各类各有多少条」，和正在看哪一类无关。
// 曾经这里的计数走了带分类的筛选函数，于是选中「在看」后「全部」变成 55→46、其余被压成 0，
// 数字看起来像在乱跳（用户截图报的正是这个）。这段守卫就是那个 bug 的回归。
eq('选「在看」后「全部」计数不变', countOf('all'), '(2)');
eq('选「在看」后「想看」计数不变', countOf('wish'), '(2)');
eq('选「在看」后「在看」计数不变', countOf('doing'), '(1)');
eq('选「在看」后「看过」计数不变', countOf('done'), '(1)');
clickFilter('done');
eq('只看「看过」：只剩豆瓣侧看过的那一对', diffKeys(), ['douban:1']);
eq('选「看过」后「全部」计数仍不变', countOf('all'), '(2)');
eq('选「看过」后「在看」计数仍不变', countOf('doing'), '(1)');
clickFilter('wish');
eq('只看「想看」：两侧任一侧想看的都算', diffKeys().sort(), allDiff.slice().sort());

// 分类筛选必须和搜索栏一样只改显示 —— 隐藏的条目如果顺手被取消勾选，
// 用户切回「全部」时发现选好的东西没了，而且不会有任何提示
const selBefore = $('selLine').textContent;
clickFilter('doing');
eq('分类筛选不动勾选（隐藏的条目仍保持选中）', $('selLine').textContent, selBefore);
truthy('顶部说明当前筛掉了什么', /只看「在看」/.test($('filterLine').textContent));
truthy('筛选计数带上分类名', /分类「在看」/.test($('qLine').textContent));

// 再点一次已选中的分类 = 取消筛选，回到全部
clickFilter('doing');
eq('再点同一个分类回到全部', diffKeys().sort(), allDiff.slice().sort());
eq('回到全部后不再显示分类提示', $('filterLine').textContent, '');
truthy('当前分类有高亮', document.querySelector('[data-filter="all"]').classList.contains('active'));

// 分类与搜索词叠加：两个条件都要满足
$('q').value = '攻壳';
$('q').dispatchEvent(new window.Event('input'));
clickFilter('done');
eq('搜索「攻壳」+ 只看「看过」：没有同时满足的', pairCount('tab-diff'), 0);
truthy('空列表说明是两个条件叠加筛掉的', /分类「看过」/.test($('tab-diff').textContent));

$('btnClearQ').dispatchEvent(new window.Event('click'));
eq('清除搜索会一并解除分类筛选', diffKeys().sort(), allDiff.slice().sort());

console.log('=== 8. 方向筛选：点「只选某方向」时中间的列表也跟着收窄 ===');
// 需求原话：「批量选择之后还得一个一个找哪些是选中的」。
// 数据：douban:1 建议 toBgm、douban:2 建议 toDouban，各一条。
clickBulk('pick-toBgm');
eq('只选 豆瓣→Bangumi：列表只剩这个方向', diffKeys(), ['douban:1']);
truthy('该按钮进入按下态', document.querySelector('[data-bulk="pick-toBgm"]').classList.contains('active'));
eq('另一个方向按钮没被误高亮', document.querySelector('[data-bulk="pick-toDouban"]').classList.contains('active'), false);
truthy('顶部说明当前被方向收窄', /方向「豆瓣→Bangumi」/.test($('qLine').textContent));
truthy('批量提示交代了列表只显示哪个方向', /列表仅显示「豆瓣→Bangumi」/.test($('bulkLine').textContent));

// 切到另一个方向：列表换过去，且「另一个方向的勾」要被清掉（这正是范围不能含方向筛选的原因）
const bgmBtnText = document.querySelector('[data-bulk="pick-toBgm"]').textContent;
clickBulk('pick-toDouban');
eq('切到 Bangumi→豆瓣：列表换成该方向', diffKeys(), ['douban:2']);
eq('切方向后另一方向的条数不变（计数没被筛选污染）', document.querySelector('[data-bulk="pick-toBgm"]').textContent, bgmBtnText);
eq('切方向后另一个方向不再有勾选', selNums().toBgm, 0);
truthy('切方向后新方向有勾选', selNums().toDouban > 0);

// 再点同一个按钮 = 放开收窄，回到全部（勾选保持）
clickBulk('pick-toDouban');
eq('再点同一个：列表回到全部', diffKeys().sort(), allDiff.slice().sort());
eq('放开后按钮不再按下', document.querySelector('[data-bulk="pick-toDouban"]').classList.contains('active'), false);

// 「全选」要一并放开收窄，否则会出现「明明全选了、列表还缺一半」
clickBulk('pick-toBgm');
eq('收窄状态下列表确实变少了', diffKeys(), ['douban:1']);
clickBulk('all');
eq('点「全选」会把方向收窄一并放开', diffKeys().sort(), allDiff.slice().sort());

// 方向筛选只影响差异页签：切走要自动放开，切回来不能还缺一块
clickBulk('pick-toBgm');
eq('（切页签前）列表已收窄', diffKeys(), ['douban:1']);
document.querySelector('.tabs button[data-tab="confirm"]').dispatchEvent(new window.Event('click'));
eq('切到别的页签后方向筛选放开、列表恢复', diffKeys().sort(), allDiff.slice().sort());
eq('按钮也不再按下', document.querySelector('[data-bulk="pick-toBgm"]').classList.contains('active'), false);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
