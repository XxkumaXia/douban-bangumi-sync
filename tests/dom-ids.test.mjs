// DOM id 交叉校验：页面里 JS 引用的元素，HTML 里必须真的存在
// 运行：node tests/dom-ids.test.mjs
//
// 为什么要有这一套：扩展页面是「HTML + 模块 JS」两张皮，改 HTML 时漏删一个 id、
// 或者 JS 里手滑写错一个 id，加载时只会静默失败（$() 返回 null，事件绑不上，按钮点了没反应）。
// 这种 bug 在安装后的界面上表现得毫无征兆，靠肉眼 review 很难发现，所以用脚本钉住。

import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};

const ui = new URL('../src/ui/', import.meta.url);

const PAGES = [
  { html: 'sync.html', js: 'sync.js' },
  { html: 'options.html', js: 'options.js' },
  { html: 'popup.html', js: 'popup.js' },
];

// 有些元素是 JS 往 innerHTML 里塞进去的（演练面板的复制/下载按钮、popup 的「确认写入」等），
// HTML 静态文本里没有。这批 id 同样算合法来源，否则会产生一堆假警报。
const idsOf = (html) => {
  const set = new Set();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1]);
  return set;
};

// JS 里两种取元素写法都算：$(...) 和 document.getElementById(...)
const refsOf = (js) => {
  const set = new Set();
  const re = /(?:\$|getElementById)\(\s*'([A-Za-z0-9_-]+)'\s*\)/g;
  let m;
  while ((m = re.exec(js))) set.add(m[1]);
  return set;
};

// 动态拼出来的 id（如 `tab-${k}`）没法静态校验，跳过含 ${ 的写法
const dynamicRefs = (js) => /\$\([^)]*\$\{/.test(js);

for (const p of PAGES) {
  const html = readFileSync(new URL(p.html, ui), 'utf8');
  const js = readFileSync(new URL(p.js, ui), 'utf8');
  const staticIds = idsOf(html);
  const injectedIds = idsOf(js);
  const ids = new Set([...staticIds, ...injectedIds]);
  const refs = refsOf(js);
  const missing = [...refs].filter((r) => !ids.has(r));

  console.log(
    `=== ${p.html}：HTML 静态 ${staticIds.size} 个 id，JS 注入 ${injectedIds.size} 个，JS 引用 ${refs.size} 个 ===`
  );
  eq(`${p.html}：JS 引用的 id 在 HTML 里都存在`, missing, []);
  if (dynamicRefs(js)) console.log(`   （${p.js} 里有动态拼接的 id，已跳过那部分）`);

  // div 平衡：手写 HTML 最常见的低级错误，会让整页布局塌掉
  const open = (html.match(/<div\b/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  eq(`${p.html}：div 开闭标签配平`, open, close);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
