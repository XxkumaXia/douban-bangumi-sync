// 扩展内部页面跳转（nav.js）：同源就原地走，不同源/强制时才新开标签页
//
// 之前 options→sync 一律 chrome.tabs.create，每点一次多一个标签页。
// 这组用例把「什么时候跳转、什么时候新开」钉住，避免以后又改回去。
// 运行：node tests/nav.test.mjs

const EXT_ID = 'omcjcndhdofkgamcminekeclnbppochh';
const ORIGIN = `chrome-extension://${EXT_ID}`;

let pass = 0,
  fail = 0;
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
    console.log(`FAIL ${name} -> ${v}`);
  }
};

let assigned = [];
let created = [];

function setupLocation({
  protocol = 'chrome-extension:',
  host = EXT_ID,
  pathname = '/src/ui/options.html',
} = {}) {
  assigned = [];
  created = [];
  globalThis.window = {
    location: { protocol, host, pathname, href: '', assign: (u) => assigned.push(u) },
  };
  globalThis.chrome = {
    runtime: { getURL: (p) => `${ORIGIN}/${p.replace(/^\//, '')}` },
    tabs: { create: (o) => created.push(o.url) },
  };
}

const { goToPage, openInNewTab } = await import('../src/ui/lib/nav.js');

// ---------------------------------------------------------------- 同源 → 原地跳转
setupLocation();
eq('同源不同路径：原地跳转', goToPage('src/ui/sync.html'), 'same-tab');
eq('调用了 location.assign 一次', assigned.length, 1);
ok0(assigned[0] === `${ORIGIN}/src/ui/sync.html`, '跳转到同步面板的正确 URL');
eq('没有新开标签页', created.length, 0);

// ---------------------------------------------------------------- 同一页 → 什么都不做
setupLocation({ pathname: '/src/ui/sync.html' });
eq('已经在目标页：不重复跳转', goToPage('src/ui/sync.html'), 'already');
eq('没有多余导航', assigned.length, 0);
eq('也没有新开标签页', created.length, 0);

// ---------------------------------------------------------------- 反向：sync → options
setupLocation({ pathname: '/src/ui/sync.html' });
eq('同步面板回设置页也是原地跳转', goToPage('src/ui/options.html'), 'same-tab');
ok0(assigned[0].endsWith('/src/ui/options.html'), '反向跳转目标正确');

// ---------------------------------------------------------------- 不同源 → 新开标签页
setupLocation({ protocol: 'https:', host: 'example.com', pathname: '/foo' });
eq('非扩展页面里的跳转：退回新开标签页', goToPage('src/ui/sync.html'), 'new-tab');
eq('创建了标签页', created.length, 1);
eq('没有尝试原地导航', assigned.length, 0);

// ---------------------------------------------------------------- 强制新开（popup 场景）
setupLocation();
eq('newTab: true 强制新开', goToPage('src/ui/sync.html', { newTab: true }), 'new-tab');
eq('创建了标签页', created.length, 1);
eq('没有原地导航', assigned.length, 0);

// ---------------------------------------------------------------- popup 语义糖
setupLocation();
eq('openInNewTab 必定新开标签页', openInNewTab('src/ui/sync.html'), 'new-tab');
eq('创建了标签页', created.length, 1);
ok0(created[0].endsWith('/src/ui/sync.html'), 'popup 打开的 URL 正确');

// ---------------------------------------------------------------- getURL 异常时兜底
setupLocation();
globalThis.chrome.runtime.getURL = () => 'not-a-url';
goToPage('src/ui/sync.html');
eq('getURL 返回非法值时兜底新开标签页，不抛错', created.length, 1);

// ------------------------------------------------- 守卫：不允许绕过 nav.js 直接开内部页面
// 一旦有人重新写出 chrome.tabs.create({ url: getURL('src/ui/...') })，
// 设置页每次进同步面板就又多开一个标签页 —— 这里直接让测试挂掉
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const uiDir = fileURLToPath(new URL('../src/ui/', import.meta.url)); // 项目路径含空格/中文，必须这样取
const offenders = [];
for (const f of fs.readdirSync(uiDir)) {
  const p = path.join(uiDir, f);
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(p, 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 去行注释
  if (/chrome\s*\.\s*tabs\s*\.\s*create/.test(code)) offenders.push(f);
}
eq('UI 层不该再出现裸的 chrome.tabs.create（一律走 nav.js）', offenders, []);

function ok0(v, name) {
  truthy(name, v);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
