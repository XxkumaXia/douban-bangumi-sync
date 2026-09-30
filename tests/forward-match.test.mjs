// 正向匹配（豆瓣条目 -> Bangumi 条目）测试
// 运行：node tests/forward-match.test.mjs
//
// 为什么单独一份：待确认匹配里「豆瓣条目搜不到 Bangumi」是被吐槽最多的地方。
// 两个根因都是标题形态问题，互不相关，必须分别钉住：
//   1. 关键词：豆瓣标题常写成「中文 / 原名」一整串，把整串丢给 Bangumi 搜索会明显掉召回。
//   2. 打分：两边标题都得拆成「主标题 / 原名」再交叉比对，否则同一部作品被另一半语言稀释成低分。
// 反向（Bangumi -> 豆瓣）的对称逻辑在 tests/reverse.test.mjs 里。

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

const { pickKeyword, scoreCandidate } = await import('../src/core/matcher.js');

// ---------------------------------------------------------------- 1. 搜索关键词

console.log('=== 1. 关键词选取（决定 Bangumi 能不能搜到） ===');

eq(
  '关键词：中文 / 原名 的整串只取中文主标题',
  pickKeyword({ title: '攻壳机动队 / Ghost in the Shell', originalTitle: 'Ghost in the Shell' }),
  '攻壳机动队'
);
eq(
  '关键词：带季数的中文标题保留季数（别把作品号洗掉）',
  pickKeyword({ title: '进击的巨人 最终季 / 進撃の巨人 The Final Season' }),
  '进击的巨人 最终季'
);
eq(
  '关键词：纯原名标题时退回原名',
  pickKeyword({ title: 'Ghost in the Shell', originalTitle: 'Ghost in the Shell' }),
  'Ghost in the Shell'
);
eq('关键词：标题为空时不硬凑', pickKeyword({ title: '', originalTitle: '' }), '');

// ---------------------------------------------------------------- 2. 打分

console.log('=== 2. 打分：同一部作品必须打高分 ===');

const bgm1 = {
  id: 1,
  name: '進撃の巨人 The Final Season',
  name_cn: '进击的巨人 最终季',
  date: '2020-12-06',
  type: 2,
  category: 'anime',
  url: 'https://bgm.tv/subject/1',
};
const doubanFull = {
  title: '进击的巨人 最终季 / 進撃の巨人 The Final Season',
  originalTitle: '進撃の巨人 The Final Season',
  year: 2020,
  category: 'anime',
};

const s1 = scoreCandidate(doubanFull, bgm1);
truthy(`整串标题（含原名）也能认出是同一部（得分 ${s1.toFixed(2)}）`, s1 >= 0.82);

// 回归：以前豆瓣标题是「中文」、候选只有日文名，靠原名交叉比对才能拉起来
const doubanCnOnly = { title: '进击的巨人 最终季', originalTitle: '', year: 2020, category: 'anime' };
const s2 = scoreCandidate(doubanCnOnly, bgm1);
truthy(`中文标题对中日双名候选（得分 ${s2.toFixed(2)}）`, s2 >= 0.82);

// 原名对原名
const doubanOrig = { title: '某作品', originalTitle: 'Ghost in the Shell', year: 1995, category: 'anime' };
const bgmOrig = { id: 2, name: 'Ghost in the Shell', name_cn: '', date: '1995-11-18', type: 2, category: 'anime' };
const s3 = scoreCandidate(doubanOrig, bgmOrig);
truthy(`原名与原名相等直接命中（得分 ${s3.toFixed(2)}）`, s3 >= 0.95);

// 标点差异不该影响命中：「你的名字。」vs「你的名字」
const s4 = scoreCandidate(
  { title: '你的名字。', originalTitle: '', year: 2016, category: 'anime' },
  { id: 3, name: '君の名は。', name_cn: '你的名字', date: '2016-08-26', type: 2, category: 'anime' }
);
truthy(`标点差异不影响命中（得分 ${s4.toFixed(2)}）`, s4 >= 0.95);

console.log('=== 3. 打分：不同作品不能被拉平 ===');

// 「剧场版 / 第 X 季」这类词在标题归一化里算噪音（反向匹配也是这套规则，不去动它），
// 因此下面这种情况按既有设计就是同一部作品 —— 这里把它钉住，防止有人改打分时误伤
const s5 = scoreCandidate(
  { title: '攻壳机动队', originalTitle: '', year: 1995, category: 'anime' },
  { id: 4, name: 'GHOST IN THE SHELL 攻殻機動隊', name_cn: '攻壳机动队 剧场版', date: '1995-11-18', type: 2, category: 'anime' }
);
truthy(`噪音词（剧场版）按既有规则归入同一部（得分 ${s5.toFixed(2)}）`, s5 >= 0.82);

// 季数不同也不能拉满
const s6 = scoreCandidate(
  { title: '进击的巨人', originalTitle: '', year: 2013, category: 'anime' },
  { id: 5, name: '進撃の巨人 The Final Season', name_cn: '进击的巨人 最终季', date: '2020-12-06', type: 2, category: 'anime' }
);
truthy(`不同季不被当成同一部（得分 ${s6.toFixed(2)}，不该拉满）`, s6 < 0.95);

// 年份差太远要明显减分
const s7 = scoreCandidate(
  { title: '攻壳机动队', originalTitle: '', year: 1995, category: 'anime' },
  { id: 6, name: '攻殻機動隊', name_cn: '攻壳机动队', date: '2015-01-01', type: 2, category: 'anime' }
);
truthy(`年份差 20 年要被扣分（得分 ${s7.toFixed(2)}）`, s7 < 0.95);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
