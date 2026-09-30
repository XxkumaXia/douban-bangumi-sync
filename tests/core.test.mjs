// 核心逻辑回归测试：评分换算、标题匹配、差异对比
// 运行：node tests/core.test.mjs
import {
  doubanToBgm,
  bgmToDouban,
  roundTripLossless,
  normalizeCustomMap,
  inspectCustomMap,
  previewTable,
  previewReverseTable,
  ratingContext,
  DEFAULT_CUSTOM_MAP,
} from '../src/core/rating.js';
import { similarity, titleScore, normalizeTitle, extractYear } from '../src/lib/strutil.js';
import { buildPlan, summarize } from '../src/core/diff.js';
import { makeItem } from '../src/core/normalize.js';
import { resolve } from '../src/core/matcher.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const truthy = (name, v) => { if (v) pass++; else { fail++; console.log(`FAIL ${name} -> ${v}`); } };

console.log('=== 1. 评分换算 ===');
eq('step 1星->2分', doubanToBgm(1, 'step'), 2);
eq('step 3星->6分', doubanToBgm(3, 'step'), 6);
eq('step 5星->10分', doubanToBgm(5, 'step'), 10);
eq('10分->5星', bgmToDouban(10, 'step'), 5);
eq('9分->5星', bgmToDouban(9, 'step'), 5);
eq('2分->1星', bgmToDouban(2, 'step'), 1);
eq('0星->0分', doubanToBgm(0, 'step'), 0);
eq('linear 5星->10分', doubanToBgm(5, 'linear'), 10);
eq('linear 3星->6分', doubanToBgm(3, 'linear'), 6);
const rt = roundTripLossless('step');
truthy('step 星级往返无损', rt.starSafe);
eq('step 分数往返有损(固有精度问题)', rt.scoreSafe, false);
console.log('   10分制压成5星制的有损档位: ' + rt.collided.map((c) => `${c.from}->${c.to}->${c.back}`).join(', '));

console.log('=== 1b. 自定义换算表 ===');
eq('默认自定义表=阶梯', DEFAULT_CUSTOM_MAP, [2, 4, 6, 8, 10]);
eq('自定义表与阶梯一致', previewTable('custom', DEFAULT_CUSTOM_MAP), previewTable('step'));
eq('自定义表反向与阶梯一致', previewReverseTable('custom', DEFAULT_CUSTOM_MAP), previewReverseTable('step'));

// 用户自定义：3★=5分（觉得 6 分偏高），5★=9分（10 分神作才给）
const CUSTOM = [2, 4, 5, 7, 9];
eq('custom 3星->5分', doubanToBgm(3, 'custom', CUSTOM), 5);
eq('custom 5星->9分', doubanToBgm(5, 'custom', CUSTOM), 9);
eq('custom 1星->2分', doubanToBgm(1, 'custom', CUSTOM), 2);
// 反向由正向表推导：不超过该档上界即归该星
eq('custom 5分->3星', bgmToDouban(5, 'custom', CUSTOM), 3);
eq('custom 6分->4星', bgmToDouban(6, 'custom', CUSTOM), 4);
eq('custom 7分->4星', bgmToDouban(7, 'custom', CUSTOM), 4);
eq('custom 8分->5星', bgmToDouban(8, 'custom', CUSTOM), 5);
eq('custom 10分->5星', bgmToDouban(10, 'custom', CUSTOM), 5);
eq('custom 1分->1星(低于最低档仍记1星)', bgmToDouban(1, 'custom', CUSTOM), 1);
eq('custom 0分->0星', bgmToDouban(0, 'custom', CUSTOM), 0);
eq('custom 0星->0分', doubanToBgm(0, 'custom', CUSTOM), 0);

// 脏数据不能让换算崩掉
eq('缺档位用默认值补齐', normalizeCustomMap([1]), [1, 4, 6, 8, 10]);
eq('超范围回退默认', normalizeCustomMap([99, 0, -3, 'x', null]), [2, 4, 6, 8, 10]);
eq('null 输入得到默认表', normalizeCustomMap(null), DEFAULT_CUSTOM_MAP);
eq('小数四舍五入', normalizeCustomMap([2.4, 3.6, 6, 8, 10]), [2, 4, 6, 8, 10]);
eq('脏数据换算仍有效', doubanToBgm(3, 'custom', ['x']), 6);
truthy('脏数据换算结果在 1-10', [1, 2, 3, 4, 5].every((s) => {
  const v = doubanToBgm(s, 'custom', [null, null, null, null, null]);
  return Number.isInteger(v) && v >= 1 && v <= 10;
}));

// 诊断
{
  const ok = inspectCustomMap([2, 4, 6, 8, 10]);
  eq('合法表无问题', ok.issues.length, 0);
  truthy('合法表单调递增', ok.monotonic);
  const bad = inspectCustomMap([2, 9, 3, 7, 10]);
  truthy('非递增会被诊断', bad.issues.some((t) => t.includes('递增')));
  eq('非递增 monotonic=false', bad.monotonic, false);
  truthy('长度不足会被诊断', inspectCustomMap([2, 4]).issues.some((t) => t.includes('5 个档位')));
  truthy('超范围会被诊断', inspectCustomMap([2, 4, 6, 8, 99]).issues.some((t) => t.includes('1-10')));
  // 诊断返回的表始终是规整过的
  eq('诊断返回规整表', inspectCustomMap([2, 4, 6, 8, 99]).map, [2, 4, 6, 8, 10]);
}

// 自定义模式同样满足"星级往返无损"（正向是用户直接定义的，反向按上界归档必然还原）
{
  const r = roundTripLossless('custom', CUSTOM);
  truthy('custom 星级往返无损', r.starSafe);
  eq('custom 分数往返有损(固有)', r.scoreSafe, false);
}
{
  // 极端自定义：全部同档，反向全归 1 星 → 星级往返必然有损，UI 应提示
  const flat = [10, 10, 10, 10, 10];
  eq('全 10 分: 5星->10分', doubanToBgm(5, 'custom', flat), 10);
  eq('全 10 分: 10分->1星(命中最低档)', bgmToDouban(10, 'custom', flat), 1);
  eq('全同档星级往返有损', roundTripLossless('custom', flat).starSafe, false);
}

// ratingContext 统一打包，避免调用点漏传自定义表
eq('context 默认 step', ratingContext({}).mode, 'step');
eq('context 保留自定义表', ratingContext({ ratingMode: 'custom', customRatingMap: CUSTOM }).custom, CUSTOM);
eq('context 非法模式回退 step', ratingContext({ ratingMode: 'nonsense' }).mode, 'step');
eq('context 表缺失时给默认值', ratingContext({ ratingMode: 'custom' }).custom, DEFAULT_CUSTOM_MAP);

console.log('=== 2. 标题匹配 ===');
eq('归一化去空格', normalizeTitle('进击的巨人 最终季'), '进击的巨人最终季');
eq('全角转半角', normalizeTitle('ＧＩＮＴＡＭＡ'), 'gintama');
eq('片假名转平假名', normalizeTitle('ワンピース'), normalizeTitle('わんぴーす'));
eq('提取年份', extractYear('1995 / 日本 / 动画'), 1995);
truthy('完全相同相似度=1', similarity('攻壳机动队', '攻壳机动队') === 1);
truthy('完全相同得分=1', titleScore('进击的巨人', '进击的巨人') === 1);
truthy('带副标题仍高分', titleScore('进击的巨人 最终季', '进击的巨人') > 0.7);
truthy('不相干低分', titleScore('攻壳机动队', '你的名字') < 0.3);
truthy('拉丁原名匹配', titleScore('Ghost in the Shell', 'GHOST IN THE SHELL') === 1);

console.log('=== 3. 差异计划 ===');
const settings = { syncStatus: true, syncRating: true, syncComment: false, syncTags: false, conflictPolicy: 'newer', allowClear: false };
const d1 = makeItem({ source: 'douban', id: 'douban:1', title: '攻壳机动队', year: 1995, category: 'anime', status: 'done', rating: 5, rawRating: 5, updatedAt: '2024-05-01', doubanSite: 'movie' });
const b1 = makeItem({ source: 'bangumi', id: 'bgm:100', subjectId: 100, title: '攻壳机动队', year: 1995, category: 'anime', status: 'done', rating: 4, rawRating: 8, updatedAt: '2024-01-01' });

{
  const p = buildPlan([d1], [b1], { 'douban:1': { subjectId: 100, mode: 'auto' } }, settings);
  eq('配对数', p.length, 1);
  const ratingDiff = p[0].diffs.find((x) => x.field === 'rating');
  truthy('评分差异存在', !!ratingDiff);
  eq('较新一侧(豆瓣)为准', ratingDiff.direction, 'toBgm');
  eq('状态相同不产生差异', p[0].diffs.filter((x) => x.field === 'status').length, 0);
}

{
  const p = buildPlan([{ ...d1, updatedAt: '2023-01-01' }], [b1], { 'douban:1': { subjectId: 100, mode: 'auto' } }, settings);
  eq('Bangumi 较新则方向反向', p[0].diffs.find((x) => x.field === 'rating').direction, 'toDouban');
}

{
  const d2 = makeItem({ source: 'douban', id: 'douban:2', title: 'X', category: 'anime', status: 'done', rating: 0, updatedAt: '2024-06-01' });
  const b2 = makeItem({ source: 'bangumi', id: 'bgm:2', subjectId: 2, title: 'X', category: 'anime', status: 'wish', rating: 5, rawRating: 10, updatedAt: '2024-01-01' });
  const p = buildPlan([d2], [b2], { 'douban:2': { subjectId: 2, mode: 'auto' } }, settings);
  eq('豆瓣无评分时不清空对方', p[0].diffs.filter((x) => x.field === 'rating').length, 0);
  eq('状态差异仍在', p[0].diffs.filter((x) => x.field === 'status').length, 1);
}

{
  const p = buildPlan([], [b1], { 'douban:999': { subjectId: 100, mode: 'manual', nameCn: '攻壳机动队', category: 'anime' } }, settings);
  eq('幽灵条目生成（豆瓣未收藏）', p.length, 1);
  truthy('标记 douban-not-collected', p[0].flags.includes('douban-not-collected'));
  eq('幽灵条目方向只能 toDouban', p[0].diffs.every((x) => x.direction === 'toDouban'), true);
}

{
  const b3 = makeItem({ source: 'bangumi', id: 'bgm:3', subjectId: 3, title: '孤品', category: 'anime', status: 'done', rating: 4, rawRating: 8 });
  const p = buildPlan([], [b3], {}, settings);
  truthy('标记 missing-in-douban', p[0].flags.includes('missing-in-douban'));
}

{
  // 关键场景：已手动指定映射，但 Bangumi 侧还没这条收藏 —— 必须能整条新增过去
  const d4 = makeItem({ source: 'douban', id: 'douban:4', title: '待新增', category: 'anime', status: 'wish', rating: 3, comment: '备注', tags: ['a'], doubanSite: 'movie' });
  const p = buildPlan([d4], [], { 'douban:4': { subjectId: 500, mode: 'manual' } }, { ...settings, syncComment: true, syncTags: true });
  eq('未知收藏也能生成差异', p.length, 1);
  truthy('不会什么都不同步', p[0].diffs.length > 0);
  eq('全部指向 Bangumi', p[0].diffs.every((x) => x.direction === 'toBgm'), true);
  eq('状态带过去了', p[0].diffs.find((x) => x.field === 'status').rawDouban, 'wish');
  eq('评分带过去了', p[0].diffs.find((x) => x.field === 'rating').rawDouban, 3);
  eq('短评带过去了', p[0].diffs.find((x) => x.field === 'comment').rawDouban, '备注');
}

{
  // 幽灵条目（豆瓣未收藏）反向：值应落在 bangumi 列
  const b5 = makeItem({ source: 'bangumi', id: 'bgm:5', subjectId: 5, title: '反推样本', category: 'anime', status: 'doing', rating: 5, rawRating: 10, comment: 'bgm 短评', tags: ['x'] });
  const p = buildPlan([], [b5], { 'douban:555': { subjectId: 5, mode: 'manual' } }, { ...settings, syncComment: true, syncTags: true });
  const g = p.find((x) => x.key === 'douban:555');
  truthy('幽灵条目存在', !!g);
  eq('幽灵条目方向', g.diffs.every((x) => x.direction === 'toDouban'), true);
  eq('值落在 bangumi 列', g.diffs.find((x) => x.field === 'status').rawBangumi, 'doing');
  eq('豆瓣列留空', g.diffs.find((x) => x.field === 'status').rawDouban, null);
  eq('Bangumi 独有不会被重复计入', p.filter((x) => x.flags.includes('missing-in-douban')).length, 0);
}

{
  const s = summarize(buildPlan([d1], [b1], { 'douban:1': { subjectId: 100, mode: 'auto' } }, settings));
  eq('summary.total', s.total, 1);
  eq('summary.toBgm', s.toBgm, 1);
}

console.log('=== 4. 匹配（走映射缓存，不发网络请求）===');
const r1 = await resolve(d1, { 'douban:1': { subjectId: 100, mode: 'manual', nameCn: '攻壳机动队', category: 'anime' } }, settings);
eq('人工映射直接命中', r1.status, 'matched');
eq('人工映射置信度1', r1.confidence, 1);
const r2 = await resolve(d1, { 'douban:1': { mode: 'skip' } }, settings);
eq('跳过标记生效', r2.status, 'skipped');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
