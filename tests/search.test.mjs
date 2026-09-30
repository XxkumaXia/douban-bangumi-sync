// 豆瓣搜索页解析回归测试
// 需要 jsdom：npm i -D jsdom
// 运行：node tests/search.test.mjs
import { parseSearchPage } from '../src/adapters/douban-parse.js';

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
const truthy = (name, v) => { if (v) pass++; else { fail++; console.log(`FAIL ${name} -> ${v}`); } };

// ---------------------------------------------------------------- 1. SSR DOM
{
  const html = `<!doctype html><html><body>
    <div id="db-global-nav"><a href="https://movie.douban.com/subject/9999999/">导航里的链接不该被算成结果</a></div>
    <div id="content">
      <div class="result">
        <div class="scb">
          <div class="title"><h3><a href="https://movie.douban.com/subject/1292052/">攻壳机动队 Ghost in the Shell</a></h3></div>
          <div class="subject">1995 / 日本 / 动画 动作 科幻</div>
        </div>
      </div>
      <div class="result">
        <div class="scb">
          <div class="title"><h3><a href="https://movie.douban.com/subject/26607686/">攻壳机动队 新剧场版</a></h3></div>
          <div class="subject">2015 / 日本 / 动画</div>
        </div>
      </div>
    </div>
    <div class="footer"><a href="https://movie.douban.com/subject/1111111/">页脚不该被算成结果</a></div>
  </body></html>`;
  const { items, via } = parseSearchPage(html, 'movie');
  eq('DOM 模式 via', via, 'dom');
  eq('抓到 2 条', items.length, 2);
  eq('首条 id', items[0].id, '1292052');
  eq('首条标题', items[0].title, '攻壳机动队 Ghost in the Shell');
  eq('首条年份', items[0].year, 1995);
  truthy('首条 url 正确', items[0].url === 'https://movie.douban.com/subject/1292052/');
  truthy('排除导航链接', !items.some((i) => i.id === '9999999'));
  truthy('排除页脚链接', !items.some((i) => i.id === '1111111'));
}

// ---------------------------------------------------------------- 2. 内嵌 JSON（扁平）
{
  const html = `<!doctype html><html><body><div id="root"></div>
    <script>window.__DATA__ = {"total":2,"items":[
      {"id":"1292052","title":"攻壳机动队","year":"1995","abstract":"1995 / 日本 / 动画"},
      {"id":"26607686","title":"攻壳机动队 新剧场版","year":"2015"}
    ]};</script>
  </body></html>`;
  const { items, via } = parseSearchPage(html, 'movie');
  eq('JSON 模式 via', via, 'json');
  eq('JSON 抓到 2 条', items.length, 2);
  eq('JSON 首条 id', items[0].id, '1292052');
  eq('JSON 首条标题', items[0].title, '攻壳机动队');
  eq('JSON 年份转数字', items[0].year, 1995);
}

// ---------------------------------------------------------------- 3. 嵌套 target 结构
{
  const html = `<!doctype html><html><body><div id="root"></div>
    <script>window.__DATA__ = {"items":[
      {"target":{"id":1292052,"title":"攻壳机动队","card_subtitle":"1995 / 日本"}}
    ]};</script>
  </body></html>`;
  const { items, via } = parseSearchPage(html, 'movie');
  eq('嵌套 target via', via, 'json');
  eq('嵌套 target 抓到 1 条', items.length, 1);
  eq('嵌套 target id', items[0].id, '1292052');
  eq('嵌套 target 标题', items[0].title, '攻壳机动队');
  eq('从 card_subtitle 提取年份', items[0].year, 1995);
}

// ---------------------------------------------------------------- 4. __INITIAL_STATE__
{
  const html = `<!doctype html><html><body><div id="root"></div>
    <script>window.__INITIAL_STATE__ = {"searchResult":{"list":[
      {"id":"35267224","title":"进击的巨人 最终季","year":2020}
    ]}};</script>
  </body></html>`;
  const { items, via } = parseSearchPage(html, 'movie');
  eq('INITIAL_STATE via', via, 'json');
  eq('INITIAL_STATE 抓到 1 条', items.length, 1);
  eq('INITIAL_STATE 标题', items[0].title, '进击的巨人 最终季');
}

// ---------------------------------------------------------------- 5. JSON 里含花括号的字符串（括号配对的边界）
{
  const html = `<!doctype html><html><body><div id="root"></div>
    <script>window.__DATA__ = {"items":[
      {"id":"1","title":"测试{a}b{c}标题","year":"2020"}
    ]};</script>
  </body></html>`;
  const { items, via } = parseSearchPage(html, 'movie');
  eq('花括号内容 via', via, 'json');
  eq('花括号不影响解析', items[0]?.title, '测试{a}b{c}标题');
}

// ---------------------------------------------------------------- 6. 空壳页面（什么都没有）
{
  const html = `<!doctype html><html><body><div id="root"></div><script>window.__DATA__ = {};</script></body></html>`;
  const { items, via } = parseSearchPage(html, 'movie');
  eq('空壳无结果', items.length, 0);
  eq('空壳 via 为 null', via, null);
}

// ---------------------------------------------------------------- 7. 传 Document 对象也要能用
{
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body><div class="result"><div class="title">
      <a href="https://book.douban.com/subject/1000001/">三体</a></div>
      <div class="subject">2008 / 中国 / 科幻</div></div></body>`,
    'text/html'
  );
  const { items } = parseSearchPage(doc, 'book');
  eq('传 Document 也能解析', items.length, 1);
  eq('book 站点 url', items[0].url, 'https://book.douban.com/subject/1000001/');
}

// ---------------------------------------------------------------- 8. 去重（同一 id 出现多次）
{
  const html = `<!doctype html><body>
    <a href="https://movie.douban.com/subject/1292052/">第一次</a>
    <a href="https://movie.douban.com/subject/1292052/?from=subject-page">第二次</a>
    <a href="https://movie.douban.com/subject/1292053/">另一条</a>
  </body>`;
  const { items } = parseSearchPage(html, 'movie');
  eq('同 id 只保留一条', items.length, 2);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
