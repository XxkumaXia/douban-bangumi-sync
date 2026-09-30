// 豆瓣列表页解析回归测试
// 需要 jsdom：npm i -D jsdom
// 运行：node tests/parse.test.mjs
import { parseListPage, normalizeInterestJson, findShareCheckbox } from '../src/adapters/douban-parse.js';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  const fallback = process.env.JSDOM_PATH;
  if (!fallback) {
    console.log('跳过：未安装 jsdom。执行 `npm i -D jsdom` 后重跑，或设置环境变量 JSDOM_PATH 指向 jsdom/lib/api.js');
    process.exit(0);
  }
  ({ JSDOM } = await import(fallback));
}

const { window } = new JSDOM('<!doctype html><body></body>');
globalThis.DOMParser = window.DOMParser;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};

const html = `<!doctype html><html><body>
<div id="db-global-nav"><a href="https://www.douban.com/people/1234567/">我的豆瓣</a></div>
<div class="article">
  <ul class="list-view">
    <li class="subject">
      <div class="pic"><a href="https://movie.douban.com/subject/1292052/" title="攻壳机动队">
        <img src="https://img9.doubanio.com/view/photo/s_ratio_poster/public/p2513565141.jpg" title="攻壳机动队"></a></div>
      <div class="info"><ul>
        <li class="title"><a href="https://movie.douban.com/subject/1292052/" title="攻壳机动队">攻壳机动队 / Ghost in the Shell <span class="year">1995</span></a></li>
        <li class="intro">1995 / 日本 / 动画 动作 科幻</li>
        <li><span class="rating5-t" title="力荐"></span> <span class="date">2019-03-02</span></li>
        <li class="tags">标签: 科幻 押井守</li>
        <li class="comment">短评: 赛博朋克的源头</li>
      </ul></div>
    </li>
    <li class="subject">
      <div class="pic"><a href="https://movie.douban.com/subject/27010768/" title="寄生虫">
        <img src="x.jpg" title="寄生虫"></a></div>
      <div class="info"><ul>
        <li class="title"><a href="https://movie.douban.com/subject/27010768/" title="寄生虫">寄生虫 <span class="year">2019</span></a></li>
        <li class="intro">2019 / 韩国 / 剧情 喜剧</li>
        <li><span class="rating4-t" title="推荐"></span> <span class="date">2019-08-11</span></li>
        <li class="tags">标签: 韩国</li>
      </ul></div>
    </li>
    <li class="subject">
      <div class="pic"><a href="https://movie.douban.com/subject/1111111/" title="未评分样本">
        <img src="y.jpg" title="未评分样本"></a></div>
      <div class="info"><ul>
        <li class="title"><a href="https://movie.douban.com/subject/1111111/">未评分样本</a></li>
        <li class="intro">2024 / 中国 / 剧集</li>
        <li><span class="date">2024-02-01</span></li>
      </ul></div>
    </li>
  </ul>
</div>
<div class="paginator"><span class="prev">前页</span><span class="thispage">1</span><span class="next"><a href="?start=15&amp;status=collect">后页&gt;</a></span></div>
</body></html>`;

console.log('=== 豆瓣列表页解析 ===');
const r = parseListPage(html, 'movie', 'collect');
eq('解析条数', r.items.length, 3);
eq('命中选择器', r.matchedSelector, 'li.subject');
eq('识别 uid', r.userUid, '1234567');
eq('下一页链接', r.nextUrl, '?start=15&status=collect');

const a = r.items[0];
eq('标题(中文)', a.title, '攻壳机动队');
eq('原名', a.originalTitle, 'Ghost in the Shell');
eq('年份', a.year, 1995);
eq('分类推断=动画', a.category, 'anime');
eq('状态', a.status, 'done');
eq('评分', a.rating, 5);
eq('标签', a.tags, ['科幻', '押井守']);
eq('短评', a.comment, '赛博朋克的源头');
eq('日期', a.updatedAt, '2019-03-02');
eq('id', a.id, 'douban:1292052');
eq('站点', a.doubanSite, 'movie');

eq('第二部标题', r.items[1].title, '寄生虫');
eq('第二部评分', r.items[1].rating, 4);
eq('非动画归为三次元', r.items[1].category, 'real');
eq('未评分=0', r.items[2].rating, 0);
eq('无原名时为空', r.items[2].originalTitle, '');
eq('剧集归为三次元', r.items[2].category, 'real');

console.log('=== 状态映射 ===');
eq('wish -> wish', parseListPage(html, 'movie', 'wish').items[0].status, 'wish');
eq('do -> doing', parseListPage(html, 'movie', 'do').items[0].status, 'doing');

console.log('=== 图书站 ===');
const bk = parseListPage(html.replace(/movie\.douban\.com/g, 'book.douban.com'), 'book', 'collect');
eq('图书分类', bk.items[0].category, 'book');
eq('图书站点', bk.items[0].doubanSite, 'book');

console.log('=== 兜底形态 ===');
const alt = parseListPage(
  `<div class="item"><a href="https://movie.douban.com/subject/333/"><img title="兜底标题"></a>
   <span class="date">2020-01-01</span></div>`,
  'movie',
  'collect'
);
eq('兜底选择器命中', alt.matchedSelector, 'div.item');
eq('兜底标题', alt.items[0].title, '兜底标题');

const empty = parseListPage('<div>nothing here</div>', 'movie', 'collect');
eq('空页面返回 0 条', empty.items.length, 0);
eq('空页面选择器为 null', empty.matchedSelector, null);

console.log('=== rexxar interest 响应归一化 ===');
eq('status collect', normalizeInterestJson({ status: 'collect', rating: { value: 5 }, comment: 'x' }).status, 'done');
eq('rating 对象取 value', normalizeInterestJson({ status: 'wish', rating: { value: 4 } }).rating, 4);
eq('rating 裸数字', normalizeInterestJson({ status: 'do', rating: 3 }).rating, 3);
eq('rating 在 rate 字段', normalizeInterestJson({ status: 'do', rate: 5 }).rating, 5);
eq('未知 status 返回 null', normalizeInterestJson({ status: 'weird' }).status, null);

console.log('=== 分享到广播字段解析 ===');
// 豆瓣收藏弹窗的真实结构：(radio) 收藏状态、(checkbox) 仅自己可见、底部一行「分享到 ☑ 豆瓣广播」
const DIALOG = `
<div class="dialog">
  <label>给个评价吧 <input type="radio" name="rating" value="5" /></label>
  <label><input type="radio" name="interest" value="collect" checked /> 看过</label>
  <label><input type="checkbox" id="chk-private" name="privacy" value="1" /> 仅自己可见</label>
  <div class="share-row">分享到
    <label><input type="checkbox" name="share_target" value="douban" checked /> 豆瓣广播</label>
    <a>去绑定新浪微博</a>
  </div>
  <input type="hidden" name="ck" value="abc" />
</div>`;

const found = findShareCheckbox(DIALOG);
eq('找到分享字段', found.name, 'share_target');
eq('带上提交值', found.value, 'douban');
eq('勾选状态一并带出（豆瓣网页端默认勾选）', found.checked, true);
eq('定位方式标为「分享到」就近', found.via, 'nearby-分享到');

// 「仅自己可见」在「分享到」之前，不能被误选
eq('不会误选到前面的 privacy', findShareCheckbox(DIALOG).name !== 'privacy', true);

// 只在「分享到」前面的勾选框 → 不该认
eq(
  '「分享到」之前的勾选框不算数',
  findShareCheckbox(`<input type="checkbox" name="privacy" checked /> 仅自己可见 <div>分享到</div>`),
  null
);

// 没有「分享到」字样时退回按字段名找
const byName = findShareCheckbox(`<input type="checkbox" name="share_broadcast" value="1" checked />`);
eq('按字段名兜底', byName.name, 'share_broadcast');
eq('兜底定位方式', byName.via, 'field-name');
eq('checkbox 无 value 时提交 on', findShareCheckbox(`<input type="checkbox" name="share" />`).value, 'on');

// 再退一步：靠「豆瓣广播」文字附近找
const byText = findShareCheckbox(`<span>豆瓣广播</span><input type="checkbox" name="xxx" value="y" />`);
eq('按广播文字就近兜底', byText.name, 'xxx');
eq('就近兜底定位方式', byText.via, 'nearby-广播');

// 属性写法兼容 + 边界
eq('单引号属性', findShareCheckbox(`分享到 <input type='checkbox' name='share_a' value='1'>`).name, 'share_a');
eq('无引号属性', findShareCheckbox(`分享到 <input type=checkbox name=share_b value=1>`).name, 'share_b');
eq('没有勾选框就返回 null', findShareCheckbox(`<div>分享到 <span>豆瓣广播</span></div>`), null);
eq('空 HTML 返回 null', findShareCheckbox(''), null);
eq('null 输入返回 null', findShareCheckbox(null), null);
eq('没有 name 的 input 被跳过', findShareCheckbox(`分享到 <input type="checkbox" checked />`), null);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
