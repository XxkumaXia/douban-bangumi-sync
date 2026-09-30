// 豆瓣写入路径测试：演练必须真的不写、分享字段按实测结果注入
// 运行：node tests/douban-write.test.mjs
//
// 为什么要有这一套：
//   1. 「演练不发送任何写请求」是给用户的承诺，而标签页注入通道是真的把请求发出去。
//      曾经有个 bug：auto 通道下演练会走到标签页兜底，结果设置页的「写入演练」
//      真的在豆瓣上写了一条收藏。这里用 mock 把它钉死。
//   2. 「分享到广播」的字段名是从豆瓣弹窗里读出来的，注入逻辑要能被验证。

const DIALOG_WITH_SHARE = `<div class="dialog">
  <label><input type="radio" name="interest" value="collect" checked /> 看过</label>
  <label><input type="checkbox" name="privacy" value="1" /> 仅自己可见</label>
  <div>分享到 <label><input type="checkbox" name="share_target" value="douban" checked /> 豆瓣广播</label></div>
</div>`;

const DIALOG_WITHOUT_SHARE = `<div class="dialog">
  <label><input type="radio" name="interest" value="collect" checked /> 看过</label>
</div>`;

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

// ---------------------------------------------------------------- mock 环境

let fetches = [];
let tabQueries = 0;
let injections = 0;
let dialogHtml = DIALOG_WITH_SHARE;
// 回读接口（verifyInterest）返回的收藏状态，测试里用它模拟「豆瓣那边实际是什么状态」
let verifyStatus = 'collect';

globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  const entry = { url: String(url), method, body: init.body };
  fetches.push(entry);
  if (method === 'GET' && entry.url.includes('rexxar')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: verifyStatus }) };
  }
  if (method === 'GET' && entry.url.includes('/interest')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ html: dialogHtml }) };
  }
  return { ok: true, status: 200, text: async () => '{"r":0}' };
};

globalThis.chrome = {
  cookies: {
    get: async () => ({ value: 'ck-test' }),
    getAll: async () => [{ value: 'ck-test' }],
  },
  runtime: {
    getContexts: async () => [],
    sendMessage: async () => ({ ok: true, data: {} }),
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    query: async () => {
      tabQueries++;
      return [{ id: 1, url: 'https://movie.douban.com/' }];
    },
  },
  scripting: {
    executeScript: async () => {
      injections++;
      return [{}];
    },
  },
};

const { writeInterest, probeShareField } = await import('../src/adapters/douban.js');

const reset = () => {
  fetches = [];
  tabQueries = 0;
  injections = 0;
  dialogHtml = DIALOG_WITH_SHARE;
};

const posts = () => fetches.filter((f) => f.method === 'POST').length;
const forms = () => fetches.filter((f) => f.method === 'POST').map((f) => String(f.body || ''));

// ---------------------------------------------------------------- 演练绝不写入

reset();
const dry = await writeInterest(
  { site: 'movie', subjectId: '1292052', status: 'done', rating: 5, comment: 'x' },
  { dryRun: true }
);
eq('演练：构造出 3 个候选请求', dry.attempts.length, 3);
eq('演练：一次 POST 都没发', posts(), 0);
eq('演练：没有走标签页注入', injections, 0);
eq('演练：没有找标签页（那是写入通道的第一步）', tabQueries, 0);
eq('演练：请求里带上了 ck', dry.attempts[0].request.form.ck, 'ck-test');

// 显式 channel=tab 时也必须拦住
reset();
await writeInterest({ site: 'movie', subjectId: '1292052', status: 'done' }, { dryRun: true, channel: 'tab' });
eq('演练 + channel=tab：也不注入', injections, 0);
eq('演练 + channel=tab：也不 POST', posts(), 0);

// ---------------------------------------------------------------- 分享字段注入

reset();
const shared = await writeInterest(
  { site: 'movie', subjectId: '1292052', status: 'done', share: true },
  { dryRun: true }
);
eq('分享开关开：演练结果里标注已附上', shared.share.applied, true);
eq('分享开关开：用的是从弹窗读到的字段名', shared.share.field.name, 'share_target');
eq('分享开关开：提交值取自弹窗', shared.share.field.value, 'douban');
const shareForm = shared.attempts[0].request.form;
eq('分享开关开：表单里带上了该字段', shareForm.share_target, 'douban');
eq('分享开关开：收藏状态照常提交', shareForm.status, 'collect');
eq('分享开关开：演练依然不发 POST', posts(), 0);

// 开关关闭时不带该字段
reset();
const noShare = await writeInterest({ site: 'movie', subjectId: '1292052', status: 'done' }, { dryRun: true });
eq('开关关闭：不附带分享字段', 'share_target' in noShare.attempts[0].request.form, false);
eq('开关关闭：share.requested 为假', noShare.share.requested, false);

// 读不到字段：不能静默，要说清楚「只写收藏、不发广播」
reset();
dialogHtml = DIALOG_WITHOUT_SHARE;
await probeShareField('movie', '1292052'); // 清掉进程内缓存并用这份弹窗
const missing = await writeInterest({ site: 'movie', subjectId: '1292052', status: 'done', share: true }, { dryRun: true });
eq('读不到字段：applied 为假', missing.share.applied, false);
eq('读不到字段：给出说明而不是静默', typeof missing.share.note === 'string' && missing.share.note.length > 0, true);
eq('读不到字段：表单里确实没有分享参数', 'share_target' in missing.attempts[0].request.form, false);

// ---------------------------------------------------------------- 真实写入（非演练）

reset();
const written = await writeInterest(
  { site: 'movie', subjectId: '1292052', status: 'done', share: true },
  { strategy: 'j-interest' }
);
eq('真实写入：发出了 POST', posts(), 1);
eq('真实写入：POST 打向网页端接口', /\/j\/subject\/1292052\/interest$/.test(fetches.find((f) => f.method === 'POST').url), true);
truthy('真实写入：表单里带上了分享字段', forms()[0].includes('share_target=douban'));
truthy('真实写入：结果标记为成功', written.ok && written.used === 'j-interest');

// ---------------------------------------------------------------- executePlan 的演练路径

// 这一组盯的是「演练结果给谁看」。以前 core/sync.js 的 writeDouban 在 dryRun 时
// 直接短路返回抽象的 args，页面上什么都看不到，只能去 F12 翻 console ——
// 等于演练白点了。现在必须走真实的请求构造，且依然是零写入。
const { executePlan } = await import('../src/core/sync.js');

const makePlan = (over = {}) => [
  {
    key: 'douban:1292052',
    title: '肖申克的救赎',
    subjectId: 1292052,
    douban: { id: 'douban:1292052', title: '肖申克的救赎', doubanSite: 'movie', status: 'wish', rating: 0 },
    bangumi: { title: '肖申克的救赎', status: 'wish', rating: 0 },
    diffs: [{ field: 'status', selected: true, direction: 'toDouban', rawBangumi: 'done', rawDouban: 'done' }],
    ...over,
  },
];

reset();
const planDry = await executePlan(makePlan(), {}, { dryRun: true });
const dEntry = planDry.results[0].results[0];
eq('计划演练：豆瓣条目进入结果', dEntry.target, 'douban');
// 用 ?. 而不是直接取下标：改动被回退时这里报 FAIL（其余用例照跑），
// 而不是抛 TypeError 把后面的测试全带崩
const dAttempts = dEntry?.attempts || [];
eq('计划演练：产出真实构造的请求（不再是空壳 args）', dAttempts.length, 3);
// 刻意不用正则字面量：写文件时 `\/` 容易被转义成 `/`，正则就退化成恒真表达式，
// 断言变成永远通过的摆设。直接比对字符串既安全，失败时也能一眼看出差在哪。
eq('计划演练：带出真实 URL', dAttempts[0]?.request?.url, 'https://movie.douban.com/j/subject/1292052/interest');
eq('计划演练：带出 ck', dAttempts[0]?.request?.form?.ck, 'ck-test');
// 检查项有 5 条：URL / 条目ID / ck / 内容 / 状态与评分是否冲突
eq('计划演练：每条请求都有静态检查项', dAttempts.every((a) => a.checks.length === 6), true);
eq('计划演练：静态检查全过（URL/ID/ck/内容）', dAttempts.every((a) => a.checks.every((c) => c.ok)), true);
eq('计划演练：依然一次 POST 都没发', posts(), 0);
eq('计划演练：依然没走标签页注入', injections, 0);
eq('计划演练：依然没有查标签页', tabQueries, 0);

// 逐条分享的选择要能落到演练结果里 —— 这是同步面板能勾出来的东西
reset();
const planShare = await executePlan(makePlan({ shareBroadcast: true }), {}, { dryRun: true });
const sEntry = planShare.results[0].results[0];
eq('逐条分享：演练结果标注 requested', sEntry?.share?.requested, true);
eq('逐条分享：演练结果标注已附上', sEntry?.share?.applied, true);
eq('逐条分享：表单里真的带上了该字段', sEntry?.attempts?.[0]?.request?.form?.share_target, 'douban');
eq('逐条分享：演练依然不发 POST', posts(), 0);

// 取不到 ck 时：演练必须报失败，不能悄悄当成功
reset();
const cookiesGet = globalThis.chrome.cookies.get;
globalThis.chrome.cookies.get = async () => null;
globalThis.chrome.cookies.getAll = async () => [];
const planNoCk = await executePlan(makePlan(), {}, { dryRun: true });
const nEntry = planNoCk.results[0].results[0];
globalThis.chrome.cookies.get = cookiesGet;
eq('取不到 ck：演练判定为失败（不是假装成功）', nEntry.ok, false);
truthy('取不到 ck：把原因说清楚', /ck|CSRF/.test(nEntry.error || ''));
eq('取不到 ck：当然也没发请求', posts(), 0);

// ---------------------------------------------------------------- 「在看 + 评分」的默认行为
//
// 曾经默认「写在看/想看时剥离评分」，理由是「豆瓣只让看过打分，带 rating 会升级成看过」。
// 但那条因果链是推断出来的，没有实测依据，而用户在豆瓣实测「在看」是可以打分的。
// 没有证据就不该默认替用户丢数据 —— 现在默认原样写，剥离做成可选项。
// 真正兜底的是写入后的回读校验：状态被改写了会直接标红报出来。
// 默认值本身就是契约：测试里传的 settings 会盖掉默认值，所以这里单独钉一次。
// 曾经默认是 true（默认剥离评分），依据是「豆瓣只让看过打分」—— 那是推断，用户在豆瓣
// 实测「在看」可以打分，没有证据就不该默认丢数据。
const { DEFAULT_SETTINGS } = await import('../src/lib/storage.js');
eq('默认设置：不默认剥离「在看/想看」的评分', DEFAULT_SETTINGS.doubanRatingOnlyWhenDone, false);

const doingPlan = [
  {
    key: 'douban:1',
    title: '某动画',
    douban: { id: 'douban:1', title: '某动画', doubanSite: 'movie', status: 'wish', rating: 0 },
    bangumi: { title: '某动画', status: 'doing', rating: 4 },
    diffs: [
      { field: 'status', selected: true, direction: 'toDouban', rawBangumi: 'doing', rawDouban: 'wish' },
      { field: 'rating', selected: true, direction: 'toDouban', rawBangumi: 4, rawDouban: 0 },
    ],
  },
];

reset();
const unguarded = await executePlan(doingPlan, {}, { dryRun: true });
const uEntry = unguarded.results[0].results[0];
eq('默认：在看+评分，状态照写 doing', uEntry.request.args.status, 'doing');
eq('默认：在看+评分，评分照写（用户在看可以打分）', uEntry.request.args.rating, 4);
eq('默认：不产生剥离提示', uEntry.ratingNote, null);
eq('默认：发给豆瓣的状态是 do', uEntry.attempts[0].request.form.status, 'do');
eq('默认：豆瓣表单里带上 rating', uEntry.attempts[0].request.form.rating, '4');
const statusCheck = uEntry.attempts[0].checks.find((c) => c.name === '状态与评分');
eq('默认：演练照实展示状态与评分（不做因果断言）', statusCheck?.ok, true);
truthy('默认：检查项里写清状态是「在看」', /在看/.test(statusCheck?.detail || ''));
const fieldCheck = uEntry.attempts[0].checks.find((c) => c.name === '状态字段名');
eq('默认：未实测字段名时给出提醒（warn 但不阻塞）', fieldCheck?.level, 'warn');
eq('默认：字段名提醒不阻塞发送', fieldCheck?.ok, true);

// 用户主动开启保护：只写状态、剥离评分，并说明原因
reset();
const guarded = await executePlan(doingPlan, { doubanRatingOnlyWhenDone: true }, { dryRun: true });
const gEntry = guarded.results[0].results[0];
eq('开启保护：状态照写 doing', gEntry.request.args.status, 'doing');
eq('开启保护：评分被剥离', gEntry.request.args.rating, 0);
truthy('开启保护：把剥离原因说清楚', /只在看过时写评分/.test(gEntry.ratingNote || ''));
eq('开启保护：发给豆瓣的状态仍是 do', gEntry.attempts[0].request.form.status, 'do');

// 目标是「看过」时，评分必须照常写 —— 保护不能误伤正常场景
reset();
const donePlan = [
  {
    ...doingPlan[0],
    diffs: [
      { field: 'status', selected: true, direction: 'toDouban', rawBangumi: 'done', rawDouban: 'wish' },
      { field: 'rating', selected: true, direction: 'toDouban', rawBangumi: 5, rawDouban: 0 },
    ],
  },
];
const doneRes = await executePlan(donePlan, {}, { dryRun: true });
eq('看过+评分：评分照写', doneRes.results[0].results[0].request.args.rating, 5);
eq('看过+评分：不产生剥离提示', doneRes.results[0].results[0].ratingNote, null);

// ---------------------------------------------------------------- 写入后回读校验
//
// 豆瓣「接口返回成功」和「页面上看得见的结果」是两回事。状态尤甚：
// 只有写完之后回读一次，才分得清是我们发错了值，还是豆瓣自己改的。
reset();
verifyStatus = 'collect'; // 豆瓣上实际是「看过」，而我们要写的是「在看」
const verifyRes = await executePlan(doingPlan, { writeDelayMs: 0 }, {});
const vEntry = verifyRes.results[0].results[0];
eq('回读：把豆瓣实际状态带回来（collect→done）', vEntry.verify?.status, 'done');
eq('回读：状态不一致时如实标记，不假装成功', vEntry.statusMismatch, true);

reset();
verifyStatus = 'do'; // 豆瓣上确实是「在看」，与目标一致
const verifyOk = await executePlan(doingPlan, { writeDelayMs: 0 }, {});
const okEntry = verifyOk.results[0].results[0];
eq('回读：一致时 statusMismatch 为假', okEntry.statusMismatch, false);
eq('回读：豆瓣原始状态值也带回来了', okEntry.verify?.rawStatus, 'do');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
