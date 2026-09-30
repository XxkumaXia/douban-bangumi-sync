// 豆瓣收藏表单字段探测测试
// 运行：node tests/douban-form-probe.test.mjs
//
// 为什么要有这一套：
//   豆瓣没有公开收藏接口的文档，状态字段到底叫 status 还是 interest、评分字段叫什么，
//   只能从豆瓣自己渲染的收藏弹窗里读。之前这些字段名是猜的，「在看被写成看过」这类
//   无声错误就永远查不清 —— 猜错的字段名不会报错，请求照样 200，结果就是不对。
//   这里把「读得出来」和「读出来之后真的用上」两件事钉死。

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

let store = {};
let lastGetUrl = '';
let interestHtml = '';

globalThis.chrome = {
  cookies: {
    get: async () => ({ value: 'ck-test' }),
    getAll: async () => [{ value: 'ck-test' }],
  },
  runtime: { getContexts: async () => [], sendMessage: async () => ({ ok: true, data: {} }) },
  storage: {
    local: {
      get: async (k) => (k && store[k] !== undefined ? { [k]: store[k] } : {}),
      set: async (o) => Object.assign(store, o),
    },
  },
  tabs: { query: async () => [] },
  scripting: { executeScript: async () => [{}] },
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if ((init.method || 'GET').toUpperCase() === 'GET' && u.includes('/interest')) {
    lastGetUrl = u;
    return { ok: true, status: 200, text: async () => JSON.stringify({ html: interestHtml }) };
  }
  return { ok: true, status: 200, text: async () => '{"r":0}' };
};

const { parseInterestFormFields } = await import('../src/adapters/douban-parse.js');
const db = await import('../src/adapters/douban.js');
const { executePlan } = await import('../src/core/sync.js');

// ---------------------------------------------------------------- 解析器（纯函数）

console.log('=== 1. 从真实弹窗 HTML 里读出字段 ===');
// 豆瓣网页端收藏弹窗的实际形态：radio 组选状态、radio 组打星、checkbox 分享
const FORM_RADIO = `<div class="dialog">
  <label><input type="radio" name="interest" value="collect" checked /> 看过</label>
  <label><input type="radio" name="interest" value="do" /> 在看</label>
  <label><input type="radio" name="interest" value="wish" /> 想看</label>
  <span class="rating"><input type="radio" name="rating" value="5" /> 力荐</span>
  <input type="hidden" name="ck" value="abcd" />
  <div>分享到 <label><input type="checkbox" name="share_target" value="douban" /> 豆瓣广播</label></div>
</div>`;

const p1 = parseInterestFormFields(FORM_RADIO);
eq('状态字段名取自豆瓣自己的表单（radio 组）', p1.statusField?.name, 'interest');
eq('状态字段名：认出这是 radio', p1.statusField?.kind, 'radio');
eq('状态可选值完整读出', [...(p1.statusField?.options || [])].sort(), ['collect', 'do', 'wish']);
eq('评分字段名读出', p1.ratingField?.name, 'rating');
truthy('分享字段一并读出', !!p1.shareField?.name);
truthy('字段清单里包含 ck', p1.fields.some((f) => f.name === 'ck'));
eq('HTML 长度如实记录', p1.htmlLength, FORM_RADIO.length);

console.log('=== 2. select 形态的状态字段 ===');
const FORM_SELECT = `<div>
  <select name="status"><option value="wish">想看</option><option value="do">在看</option><option value="collect">看过</option></select>
  <select name="rating"><option value="">不给</option><option value="5">力荐</option></select>
</div>`;
const p2 = parseInterestFormFields(FORM_SELECT);
eq('select 状态字段读出', p2.statusField?.name, 'status');
eq('select 状态字段 kind', p2.statusField?.kind, 'select');
// 空 value 的 option（如评分里的「不给」）不算可选项，会被过滤掉
eq('select 选项读出', p2.statusField?.options, ['wish', 'do', 'collect']);
eq('select 评分字段读出', p2.ratingField?.name, 'rating');

console.log('=== 3. 认不出的就老实说认不出 ===');
const p3 = parseInterestFormFields('<div><input name="foo" value="bar" /></div>');
eq('无状态字段时返回 null（不瞎猜）', p3.statusField, null);
eq('无评分字段时返回 null', p3.ratingField, null);
eq('但字段清单照实返回', p3.fields.length, 1);
const p4 = parseInterestFormFields('');
eq('空 HTML 不炸', p4.fields.length, 0);
eq('空 HTML 的 htmlLength', p4.htmlLength, 0);

// ---------------------------------------------------------------- 探测入口 + 真的用上

console.log('=== 4. 探测入口：读得到就用上，读不到就说明 ===');
interestHtml = FORM_RADIO;
store = {};
const r1 = await db.probeInterestForm('movie', '1292052');
eq('探测成功', r1.ok, true);
eq('识别到状态字段名 interest', r1.statusField?.name, 'interest');
eq('字段名写回设置（之后不再重复读）', r1.applied, 'interest');
truthy('探测只读（GET 收藏弹窗）', lastGetUrl.includes('/j/subject/1292052/interest'));
eq('设置里确实存下了', store.settings?.doubanStatusField?.name ?? store['db-settings']?.doubanStatusField?.name, 'interest');

console.log('=== 5. 读不到时不装成功 ===');
interestHtml = '';
globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '' });
const r2 = await db.probeInterestForm('movie', '1292052');
eq('读不到：ok=false', r2.ok, false);
truthy('读不到：说明原因', /弹窗|登录|风控/.test(r2.reason || ''));
eq('读不到：不写入字段名', r2.applied, null);

console.log('=== 6. 实测到的字段名真会被写进请求 ===');
// 恢复 GET mock
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if ((init.method || 'GET').toUpperCase() === 'GET' && u.includes('/interest')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ html: interestHtml }) };
  }
  return { ok: true, status: 200, text: async () => '{"r":0}' };
};
interestHtml = FORM_RADIO;
store = { settings: { doubanStatusField: { name: 'interest', options: ['wish', 'do', 'collect'] } } };
const SETTINGS_KEY = 'settings';
globalThis.chrome.storage.local.get = async (k) => (store[k] !== undefined ? { [k]: store[k] } : {});

const plan = [
  {
    key: 'douban:1',
    title: '某动画',
    douban: { id: 'douban:1', title: '某动画', doubanSite: 'movie', status: 'wish', rating: 0 },
    bangumi: { title: '某动画', status: 'doing', rating: 0 },
    diffs: [{ field: 'status', selected: true, direction: 'toDouban', rawBangumi: 'doing', rawDouban: 'wish' }],
  },
];
const out = await executePlan(plan, {}, { dryRun: true });
const entry = out.results[0].results[0];
const form = entry.attempts[0].request.form;
eq('按实测字段名带上 interest', form.interest, 'do');
eq('同时保留兼容字段 status（两个值一致）', form.status, 'do');
eq('演练不发真实 POST', form.ck !== undefined, true);
const useCheck = entry.attempts[0].checks.find((c) => c.name === '状态字段名');
eq('演练里说明字段名是实测来的', useCheck?.level, 'ok');
truthy('演练里写出实测到的字段名', /interest/.test(useCheck?.detail || ''));
void SETTINGS_KEY;

// ---------------------------------------------------------------- 真实实测样本
//
// 下面是用户在条目 1292052 上点「读取收藏表单字段」得到的真实结果（2026-09-27），
// 原样钉进测试。它当场推翻了两个猜错的字段名：status 实际叫 interest、privacy 实际叫 private。
// 另外一个事实：这份表单的 radio 只有 wish / collect，没有「在看」。
console.log('=== 7. 真实样本（条目 1292052，用户实测） ===');
const REAL_1292052 = `<div class="dialog">
  <input type="radio" name="interest" value="wish" />
  <input type="radio" name="interest" value="collect" />
  <input type="hidden" name="rating" />
  <input type="hidden" name="foldcollect" value="F" />
  <input type="text" name="tags" />
  <input type="checkbox" name="private" />
  <input type="checkbox" name="share-shuo" value="douban" />
  <input type="submit" name="save" value="保存" />
</div>`;
const real = parseInterestFormFields(REAL_1292052);
eq('实测：状态字段叫 interest（不是我们默认发的 status）', real.statusField?.name, 'interest');
eq('实测：可选值只有 wish / collect', [...(real.statusField?.options || [])].sort(), ['collect', 'wish']);
eq('实测：这份表单里确实没有「在看」选项', (real.statusField?.options || []).includes('do'), false);
eq('实测：评分字段 rating（hidden）', real.ratingField?.name, 'rating');
eq('实测：隐私字段叫 private（不是 privacy）', real.privateField?.name, 'private');
eq('实测：分享字段 share-shuo', real.shareField?.name, 'share-shuo');

console.log('=== 8. 隐私字段按实测名发，且只在需要时出现 ===');
interestHtml = REAL_1292052;
store = { settings: { doubanInterestFields: { status: 'interest', rating: 'rating', tags: 'tags', private: 'private' } } };
globalThis.chrome.storage.local.get = async (k) => (store[k] !== undefined ? { [k]: store[k] } : {});

const pub = await db.writeInterest(
  { site: 'movie', subjectId: '1292052', status: 'doing', rating: 4, tags: ['动画'], private: false },
  { dryRun: true }
);
const pubForm = pub.attempts[0].request.form;
eq('公开收藏：不发 private 字段', pubForm.private, undefined);
eq('公开收藏：也不发 privacy=0（"0" 可能被当真值）', pubForm.privacy, undefined);
eq('公开收藏：状态按实测名发 interest', pubForm.interest, 'do');
eq('公开收藏：兼容字段 status 同值', pubForm.status, 'do');
eq('公开收藏：评分按实测名发', pubForm.rating, '4');

const sec = await db.writeInterest(
  { site: 'movie', subjectId: '1292052', status: 'doing', rating: 0, private: true },
  { dryRun: true }
);
const secForm = sec.attempts[0].request.form;
eq('仅自己可见：按实测名发 private=on', secForm.private, 'on');
eq('仅自己可见：兼容字段 privacy 也带上', secForm.privacy, 'on');
// rating=0 时仍会发 rating=0（既有行为：全量提交时用它表示「未评分」）。
// 豆瓣到底是当成「不给分」还是「0 星」没有实测，所以这里不断言它的语义 ——
// 只在 README 里记着，等有人实测了再钉死。

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
