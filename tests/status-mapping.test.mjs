// 收藏状态三步映射 与 面板「跳过/方向」判定
// 运行：node tests/status-mapping.test.mjs
//
// 为什么单独开一套：
//   1. 用户实测反馈「Bangumi→豆瓣 时在看被同步成看过」。追下来主链路映射是对的，
//      但散布着几处「取不到就默认成看过」的兜底（`?? 2`、`|| 'done'`、漏传 status），
//      这些才是把「在看」变成「看过」的真凶 —— 而且静默，查不出来。这套测试把它们钉死。
//   2. 面板上「跳过」会把 selected 全置 false，而空数组的 every() 恒为 true，
//      导致按钮高亮错乱、看着像整条被重置。这里覆盖各种勾选组合。

import { DOUBAN_STATUS, DOUBAN_STATUS_REVERSE, BGM_TYPE, BGM_TYPE_REVERSE } from '../src/core/normalize.js';

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

// ---------------------------------------------------------------- 状态三方对应表本身

console.log('=== 状态对应表 ===');
eq('豆瓣 wish → 内部 wish', DOUBAN_STATUS.wish, 'wish');
eq('豆瓣 do → 内部 doing（在看）', DOUBAN_STATUS.do, 'doing');
eq('豆瓣 collect → 内部 done（看过）', DOUBAN_STATUS.collect, 'done');

eq('内部 doing → 豆瓣参数 do', DOUBAN_STATUS_REVERSE.doing, 'do');
eq('内部 wish → 豆瓣参数 wish', DOUBAN_STATUS_REVERSE.wish, 'wish');
eq('内部 done → 豆瓣参数 collect', DOUBAN_STATUS_REVERSE.done, 'collect');

eq('Bangumi type 1 → 想看', BGM_TYPE[1], 'wish');
eq('Bangumi type 2 → 看过', BGM_TYPE[2], 'done');
eq('Bangumi type 3 → 在看', BGM_TYPE[3], 'doing');

eq('内部 wish → Bangumi type 1', BGM_TYPE_REVERSE.wish, 1);
eq('内部 done → Bangumi type 2', BGM_TYPE_REVERSE.done, 2);
eq('内部 doing → Bangumi type 3', BGM_TYPE_REVERSE.doing, 3);

// 往返一致性：任一侧出发，绕一圈必须回到原状态
for (const [bgmType, inner] of Object.entries(BGM_TYPE)) {
  if (Number(bgmType) > 3) continue; // 4/5（搁置/抛弃）尚未纳入同步
  eq(`往返 type ${bgmType}`, BGM_TYPE_REVERSE[inner], Number(bgmType));
}
for (const [doubanParam, inner] of Object.entries(DOUBAN_STATUS)) {
  if (typeof inner !== 'string') continue;
  eq(`往返 ${doubanParam}`, DOUBAN_STATUS_REVERSE[inner], doubanParam);
}

// ---------------------------------------------------------------- 面板方向/跳过判定

console.log('=== 面板方向判定 ===');
const { currentDirection } = await import('../src/ui/lib/direction.js');

const diff = (direction, selected = true) => ({ field: 'status', direction, selected });

eq('全部奔赴 Bangumi', currentDirection([diff('toBgm'), diff('toBgm')]), 'toBgm');
eq('全部奔赴 豆瓣', currentDirection([diff('toDouban'), diff('toDouban')]), 'toDouban');
eq('两个方向混着 → mixed', currentDirection([diff('toBgm'), diff('toDouban')]), 'mixed');

// 核心回归：全不选时必须判成 none，不能因为空数组 every() 恒真而落到 toBgm
eq('全部跳过 → none（不能误判成 toBgm）', currentDirection([diff('toDouban', false), diff('toDouban', false)]), 'none');
eq('原本 toBgm 全部跳过 → 也是 none', currentDirection([diff('toBgm', false)]), 'none');
eq('空 diffs → none', currentDirection([]), 'none');
eq('undefined → none', currentDirection(undefined), 'none');

// 部分勾选：只勾其中一条，方向应取那条自己的
eq('只留一条 toDouban', currentDirection([diff('toDouban'), diff('toDouban', false)]), 'toDouban');
eq('只留一条 toBgm', currentDirection([diff('toBgm'), diff('toDouban', false)]), 'toBgm');
eq('跳过后重新勾选，方向仍是原来那条', currentDirection([diff('toDouban', false), diff('toDouban')]), 'toDouban');

// ---------------------------------------------------------------- 批量选择的语义
//
// 用户反馈：点「全部跳过」之后所有条目都显示成「跳过」，看着像匹配结果被重置了；
// 而「全部 豆瓣→Bangumi」会把每条每个字段的方向都强行掰过去，包括本来该反向的那些。
// 现在的语义：全选/取消全选只动勾选；「只选 X」按**匹配完的建议方向**挑，其余只取消勾选。
const { suggestedDirection } = await import('../src/ui/lib/direction.js');
const syncCore = await import('../src/core/sync.js');

const mkDiff = (field, suggested, direction = suggested, selected = true) => ({
  field,
  suggested,
  direction,
  selected,
});

console.log('=== 建议方向（不受手动改动影响）===');
eq('建议全往 Bangumi', suggestedDirection([mkDiff('status', 'toBgm')]), 'toBgm');
eq('建议全往豆瓣', suggestedDirection([mkDiff('status', 'toDouban')]), 'toDouban');
eq('建议混着 → mixed', suggestedDirection([mkDiff('status', 'toBgm'), mkDiff('rating', 'toDouban')]), 'mixed');
eq('没有建议 → none', suggestedDirection([mkDiff('status', null, null, false)]), 'none');
eq('空 → none', suggestedDirection([]), 'none');
// 关键：界面上把方向改成 toDouban 之后，建议仍然是 toBgm
eq(
  '手动改过方向后，建议方向不变',
  suggestedDirection([mkDiff('status', 'toBgm', 'toDouban')]),
  'toBgm'
);

console.log('=== 只选某个方向：按建议挑，其余只取消勾选 ===');
const pair = {
  diffs: [
    mkDiff('status', 'toBgm'),
    mkDiff('rating', 'toDouban'),
    mkDiff('comment', 'toBgm'),
  ],
};
eq('只往 Bangumi 的挑出 2 条', syncCore.selectBySuggestion(pair, 'toBgm'), 2);
eq('挑中的都勾上', pair.diffs.filter((d) => d.selected).map((d) => d.field), ['status', 'comment']);
eq('没挑中的方向原样保留（不重置匹配结果）', pair.diffs.find((d) => d.field === 'rating').direction, 'toDouban');

const pair2 = { diffs: [mkDiff('status', 'toBgm'), mkDiff('rating', 'toDouban')] };
eq('只往豆瓣的挑出 1 条', syncCore.selectBySuggestion(pair2, 'toDouban'), 1);
eq('toBgm 那条被取消勾选', pair2.diffs.find((d) => d.field === 'status').selected, false);
eq('但它的方向还是 toBgm（没被改写）', pair2.diffs.find((d) => d.field === 'status').direction, 'toBgm');

console.log('=== 全选 / 取消全选：只动勾选，不碰方向 ===');
const pair3 = { diffs: [mkDiff('status', 'toBgm', 'toBgm', false), mkDiff('rating', 'toDouban', 'toDouban', false)] };
syncCore.setPairSelected(pair3, true);
eq('全选：都勾上', pair3.diffs.map((d) => d.selected), [true, true]);
eq('全选：方向一个都没改', pair3.diffs.map((d) => d.direction), ['toBgm', 'toDouban']);
syncCore.setPairSelected(pair3, false);
eq('取消全选：都取消', pair3.diffs.map((d) => d.selected), [false, false]);
eq('取消全选：方向依然原样', pair3.diffs.map((d) => d.direction), ['toBgm', 'toDouban']);
// 没有方向的字段（需手动定）不该被「全选」勾上 —— 勾了同步时也不会执行，纯误导
const pair4 = { diffs: [mkDiff('status', null, null, false), mkDiff('rating', 'toBgm', 'toBgm', false)] };
syncCore.setPairSelected(pair4, true);
eq('全选：待定方向的字段保持不勾', pair4.diffs.map((d) => d.selected), [false, true]);

// ---------------------------------------------------------------- 写入侧：状态不许被猜成「看过」

console.log('=== 未知状态必须报错，不能默认成看过 ===');

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
globalThis.chrome = {
  cookies: { get: async () => ({ value: 'ck' }), getAll: async () => [{ value: 'ck' }] },
  storage: {
    // 带上 token，否则合法状态也会在缺 token 那一步抛错 ——
    // 那样「未知状态必须报错」这条会因为别的原因通过，等于没测到。
    // 注意 storage 的结构是 { settings: {...} }，不是扁平的
    local: { get: async () => ({ settings: { bgmAccessToken: 'test-token' } }), set: async () => {} },
  },
  runtime: { getContexts: async () => [], sendMessage: async () => ({}) },
};

const bgm = await import('../src/adapters/bangumi.js');
const { writeInterest } = await import('../src/adapters/douban.js');

// Bangumi：以前是 BGM_TYPE_REVERSE[status] ?? 2，而 2 就是「看过」
//
// 光断言「抛错」不够严 —— mock 的 fetch 就算接住了请求，后续环节也可能因为别的原因报错，
// 那样 bug 回来了测试还是绿的。所以同时盯住「有没有真的发出去」：
// 正确行为是根本不该发这个请求。
let posts = [];
globalThis.fetch = async (url, init = {}) => {
  posts.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), body: init.body });
  return { ok: true, status: 200, text: async () => '{}' };
};

let threw = null;
posts = [];
try {
  await bgm.writeCollection(1, { status: 'unknown', ratingStars: 0 });
} catch (e) {
  threw = e.message;
}
truthy('写 Bangumi：状态未知时抛错', typeof threw === 'string' && threw.length > 0);
truthy('写 Bangumi：错误信息里带上收到的状态值', threw?.includes('unknown'));
eq('写 Bangumi：状态未知时压根不发请求（不能悄悄写成看过）', posts.length, 0);

threw = null;
posts = [];
try {
  await bgm.writeCollection(1, { ratingStars: 0 });
} catch (e) {
  threw = e.message;
}
truthy('写 Bangumi：完全不传状态也抛错（而不是默认看过）', typeof threw === 'string');
eq('写 Bangumi：不传状态时也不发请求', posts.length, 0);

// 对照：合法状态必须真的发出去，且 type 落在正确的那一档
for (const [inner, bgmType] of [
  ['wish', 1],
  ['done', 2],
  ['doing', 3],
]) {
  posts = [];
  await bgm.writeCollection(1, { status: inner, ratingStars: 0 });
  eq(`写 Bangumi：${inner} 发出请求`, posts.length, 1);
  truthy(`写 Bangumi：${inner} → type ${bgmType}`, JSON.parse(posts[0].body).type === bgmType);
}

// 豆瓣：状态缺失时表单里不能再没有 status 字段
const noStatus = await writeInterest({ site: 'movie', subjectId: '1', status: null }, { dryRun: true }).catch((e) => e);
truthy('写豆瓣：状态缺失时报错', noStatus instanceof Error);
truthy('写豆瓣：给出可操作的建议（去勾同步状态）', /收藏状态|同步内容/.test(String(noStatus.message)));

// 三种正常状态必须各自落在正确的豆瓣参数上
for (const [inner, doubanParam] of [
  ['wish', 'wish'],
  ['doing', 'do'],
  ['done', 'collect'],
]) {
  const r = await writeInterest({ site: 'movie', subjectId: '1', status: inner }, { dryRun: true });
  eq(`豆瓣参数：${inner} → ${doubanParam}`, r.attempts[0].request.form.status, doubanParam);
}

// ---------------------------------------------------------------- writeBgm 不再硬写 'done'

console.log('=== writeBgm 的状态兜底 ===');
const { executePlan } = await import('../src/core/sync.js');

const mkD = (status) => ({
  source: 'douban',
  id: 'douban:1',
  title: '条目',
  status,
  rating: 0,
  comment: '',
  tags: [],
  doubanSite: 'movie',
  category: 'real',
  rawRating: 0,
});

// 只同步标签时，Bangumi 侧状态应来自源侧（豆瓣），而不是被硬写成 'done'
// （以前 payload.status 兜底成 'done'，用户只想加个标签就把记录标成看过）
const plan = [
  {
    key: 'douban:1',
    title: '条目',
    subjectId: 1001,
    douban: mkD('doing'),
    bangumi: null,
    diffs: [{ field: 'tags', selected: true, direction: 'toBgm', rawDouban: ['x'], rawBangumi: [] }],
  },
];
const out = await executePlan(plan, { writeDelayMs: 0, ratingMode: 'step' }, { dryRun: true });
const bgmReq = out.results[0].results.find((x) => x.target === 'bangumi');
eq('只同步标签时，Bangumi 状态取源侧的 doing（不是硬写成 done）', bgmReq.request.body.status, 'doing');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
