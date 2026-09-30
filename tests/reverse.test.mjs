// 反向匹配（Bangumi 条目 -> 豆瓣条目）回归测试
// 运行：node tests/reverse.test.mjs
import {
  categoryToSite,
  pickReverseKeyword,
  scoreDoubanCandidate,
  normalizeDoubanCandidate,
  resolveReverse,
} from '../src/core/reverse-matcher.js';
import { splitTitleParts } from '../src/lib/strutil.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const truthy = (name, v) => { if (v) pass++; else { fail++; console.log(`FAIL ${name} -> ${v}`); } };
const near = (name, got, want, tol = 1e-6) => {
  if (Math.abs(got - want) <= tol) pass++;
  else { fail++; console.log(`FAIL ${name}\n   got  ${got}\n   want ${want}`); }
};

console.log('=== 1. 标题拆分 ===');
eq('中文原名', splitTitleParts('攻壳机动队 / Ghost in the Shell'), {
  mainTitle: '攻壳机动队',
  originalTitle: 'Ghost in the Shell',
});
eq('带尾部年份', splitTitleParts('攻壳机动队 / Ghost in the Shell 1995'), {
  mainTitle: '攻壳机动队',
  originalTitle: 'Ghost in the Shell',
});
eq('原名在前', splitTitleParts('Ghost in the Shell / 攻壳机动队'), {
  mainTitle: '攻壳机动队',
  originalTitle: 'Ghost in the Shell',
});
eq('无分隔符', splitTitleParts('进击的巨人'), { mainTitle: '进击的巨人', originalTitle: '' });
eq('全角斜杠', splitTitleParts('你的名字。／君の名は。'), {
  mainTitle: '你的名字。',
  originalTitle: '君の名は。',
});

console.log('=== 2. 分类 -> 豆瓣站点 ===');
eq('动画走影视', categoryToSite('anime'), 'movie');
eq('三次元走影视', categoryToSite('real'), 'movie');
eq('游戏走影视', categoryToSite('game'), 'movie');
eq('图书走读书', categoryToSite('book'), 'book');
eq('音乐走音乐', categoryToSite('music'), 'music');

console.log('=== 3. 关键词选取 ===');
eq('中文名优先', pickReverseKeyword({ title: '进击的巨人', originalTitle: '進撃の巨人' }), '进击的巨人');
eq('无中文用主标题', pickReverseKeyword({ title: 'Ghost in the Shell', originalTitle: '' }), 'Ghost in the Shell');
eq('主标题空退回原名', pickReverseKeyword({ title: '', originalTitle: 'Kimi no Na wa' }), 'Kimi no Na wa');
eq('全空', pickReverseKeyword({}), '');

console.log('=== 4. 候选归一化 ===');
const nc = normalizeDoubanCandidate({
  id: 25986788,
  title: '进击的巨人 最终季 / 進撃の巨人 The Final Season',
  year: null,
  intro: '2020 / 日本 / 动画',
});
eq('拆出主标题', nc.mainTitle, '进击的巨人 最终季');
eq('拆出原名', nc.originalTitle, '進撃の巨人 The Final Season');
eq('从 intro 补年份', nc.year, 2020);
eq('id 转字符串', nc.id, '25986788');

console.log('=== 5. 打分：关键回归（原名不该稀释命中分数）===');
// 这正是「明明豆瓣一搜就搜得到」却被判为不匹配的场景
const bgmGiant = { title: '进击的巨人 最终季', originalTitle: '進撃の巨人 The Final Season', year: 2020, category: 'anime', subjectId: 300000 };
const candGiant = {
  id: '25986788',
  title: '进击的巨人 最终季 / 進撃の巨人 The Final Season',
  year: 2020,
  intro: '2020 / 日本 / 动画 动作',
  url: 'https://movie.douban.com/subject/25986788/',
};
const sGiant = scoreDoubanCandidate(bgmGiant, candGiant);
truthy(`完全同名应达到自动采纳阈值 (${sGiant.toFixed(2)})`, sGiant >= 0.82);

// 纯日文原名也能对上
const bgmKimi = { title: '你的名字。', originalTitle: '君の名は。', year: 2016, category: 'anime', subjectId: 1 };
const candKimi = { id: '26611891', title: '你的名字。', year: 2016, intro: '2016 / 日本 / 动画', url: '' };
truthy(`中文名命中 (${scoreDoubanCandidate(bgmKimi, candKimi).toFixed(2)})`, scoreDoubanCandidate(bgmKimi, candKimi) >= 0.82);

// 年份差太多要明显扣分
const bgmOld = { title: '攻壳机动队', originalTitle: 'Ghost in the Shell', year: 1995, category: 'anime', subjectId: 2 };
const candSame = { id: '1', title: '攻壳机动队', year: 1995, intro: '1995 / 日本 / 动画', url: '' };
const candFar = { id: '2', title: '攻壳机动队', year: 2017, intro: '2017 / 美国 / 科幻', url: '' };
truthy('同年应高于跨年', scoreDoubanCandidate(bgmOld, candSame) > scoreDoubanCandidate(bgmOld, candFar));

// 完全不相关
const bgmX = { title: '进击的巨人', originalTitle: '', year: 2013, category: 'anime', subjectId: 3 };
const candY = { id: '3', title: '肖申克的救赎', year: 1994, intro: '1994 / 美国 / 犯罪', url: '' };
truthy(`不相关应低于候选阈值 (${scoreDoubanCandidate(bgmX, candY).toFixed(2)})`, scoreDoubanCandidate(bgmX, candY) < 0.45);

// 分数必须落在 0..1
truthy('分数上限', scoreDoubanCandidate(bgmGiant, candGiant) <= 1);
truthy('分数下限', scoreDoubanCandidate(bgmX, candY) >= 0);

console.log('=== 6. resolveReverse ===');
const settings = { autoAcceptThreshold: 0.82, candidateThreshold: 0.45 };

const rMatch = await resolveReverse(bgmGiant, settings, {
  searchDouban: async () => ({ items: [candGiant] }),
});
eq('命中->matched', rMatch.status, 'matched');
eq('返回豆瓣条目 id', rMatch.douban.id, '25986788');
truthy('带置信度', rMatch.confidence >= 0.82);

const rCand = await resolveReverse(bgmGiant, settings, {
  searchDouban: async () => ({ items: [{ id: '9', title: '进击的巨人 剧场版', year: 2014, intro: '', url: '' }] }),
});
truthy('中等分->candidate 或 matched', ['candidate', 'matched'].includes(rCand.status));

const rNone = await resolveReverse(bgmGiant, settings, { searchDouban: async () => ({ items: [] }) });
eq('搜不到->unmatched', rNone.status, 'unmatched');

const rErr = await resolveReverse(bgmGiant, settings, {
  searchDouban: async () => { throw new Error('被风控'); },
});
eq('搜索抛错->unmatched', rErr.status, 'unmatched');
truthy('错误信息带原因', /被风控/.test(rErr.reason));

const rNoImpl = await resolveReverse(bgmGiant, settings, {});
eq('没注入搜索实现->unmatched', rNoImpl.status, 'unmatched');

const rNoTitle = await resolveReverse({ title: '', originalTitle: '', subjectId: 5 }, settings, {
  searchDouban: async () => ({ items: [] }),
});
eq('空标题->unmatched', rNoTitle.status, 'unmatched');

const rNoSubj = await resolveReverse({ title: 'x', subjectId: null }, settings, {
  searchDouban: async () => ({ items: [] }),
});
eq('缺 subjectId->unmatched', rNoSubj.status, 'unmatched');

console.log('=== 7. 搜索站点按分类走 ===');
const seen = [];
await resolveReverse({ title: '某书', category: 'book', subjectId: 7 }, settings, {
  searchDouban: async (q) => { seen.push(q.site); return { items: [] }; },
});
eq('图书搜 book 站', seen[0], 'book');
await resolveReverse({ title: '某专辑', category: 'music', subjectId: 8 }, settings, {
  searchDouban: async (q) => { seen.push(q.site); return { items: [] }; },
});
eq('音乐搜 music 站', seen[1], 'music');

near('  sanity: 同名打分接近满分', scoreDoubanCandidate(bgmKimi, candKimi), 0.95 + 0.04 + 0.03, 0.2);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
