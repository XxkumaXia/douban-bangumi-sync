// 页面内确认框回归测试 + 「不许再用原生 confirm/alert」的守卫
//
// 背景：设置页被嵌在 chrome://extensions 的选项方框里时，Chrome 会拦掉原生模态框，
// 按钮点下去毫无反应也没有报错。所以 UI 层一律用自绘浮层，这个测试防止回退。
// 运行：node tests/ui-dialog.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const jsdomPath = process.env.JSDOM_PATH || 'jsdom';
const { JSDOM } = await import(jsdomPath);

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const truthy = (name, v) => { if (v) pass++; else { fail++; console.log(`FAIL ${name} -> ${v}`); } };

console.log('=== 1. 守卫：UI 里不许出现原生 confirm/alert/prompt ===');

/** 去掉注释后再查，否则会把说明文字里的 confirm() 也算进去 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return d.name.endsWith('.js') ? [p] : [];
  });
}

const uiFiles = walk(path.join(root, 'src/ui'));
truthy('扫到 UI 文件', uiFiles.length >= 4);
const offenders = [];
for (const f of uiFiles) {
  const code = stripComments(fs.readFileSync(f, 'utf8'));
  const m = code.match(/\b(window\.)?(confirm|alert|prompt)\s*\(/g);
  if (m) offenders.push(`${path.relative(root, f)}: ${m.join(', ')}`);
}
eq('没有原生模态框调用', offenders, []);

console.log('=== 2. 建立 DOM 环境 ===');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.org/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
// 不要覆盖 globalThis.setTimeout：jsdom 的 window.setTimeout 内部会回到全局 setTimeout，
// 包一层会无限递归。dialog.js 用的是全局 setTimeout，Node 原生的即可。

const { confirmDialog, notify, installErrorGuard } = await import('../src/ui/lib/dialog.js');

const tick = () => new Promise((r) => window.setTimeout(r, 0));

console.log('=== 3. confirmDialog ===');

// 点「确定」
let p = confirmDialog({ title: '标题', message: '内容', okText: '写入' });
truthy('浮层已插入', !!document.querySelector('.dlg-mask'));
eq('标题渲染', document.querySelector('.dlg-title').textContent, '标题');
eq('内容渲染', document.querySelector('.dlg-msg').textContent, '内容');
eq('按钮文案', document.querySelector('.dlg-ok').textContent, '写入');
document.querySelector('.dlg-ok').click();
eq('点确定 -> true', await p, true);
truthy('浮层已移除', !document.querySelector('.dlg-mask'));

// 点「取消」
p = confirmDialog({ title: 'x' });
document.querySelector('.dlg-cancel').click();
eq('点取消 -> false', await p, false);

// 点遮罩空白处 = 取消
p = confirmDialog({ title: 'x' });
document.querySelector('.dlg-mask').click();
eq('点遮罩 -> false', await p, false);

// Esc = 取消（捕获阶段监听）
p = confirmDialog({ title: 'x' });
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
eq('Esc -> false', await p, false);

// Enter = 确定
p = confirmDialog({ title: 'x' });
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
eq('Enter -> true', await p, true);

// 事件监听要清理干净，不能每弹一次就多挂一个
let leaks = 0;
for (let i = 0; i < 3; i++) {
  const q = confirmDialog({ title: 'x' });
  document.querySelector('.dlg-cancel').click();
  await q;
  leaks++;
}
eq('连续弹 3 次均正常关闭', leaks, 3);

// 消息里的 HTML 必须被转义，不能注入
p = confirmDialog({ title: 'x', message: '<img src=x onerror="1">' });
truthy('不生成注入的元素', !document.querySelector('.dlg-mask img'));
truthy('按纯文本呈现', document.querySelector('.dlg-msg').textContent.includes('<img src=x'));
document.querySelector('.dlg-cancel').click();
await p;

// 同一时刻只留一个：先前的按取消处理，避免确认框叠罗汉
const p1 = confirmDialog({ title: 'first' });
const p2 = confirmDialog({ title: 'second' });
eq('先打开的自动取消', await p1, false);
eq('同时只剩一个浮层', document.querySelectorAll('.dlg-mask').length, 1);
document.querySelector('.dlg-ok').click();
eq('后打开的仍可确认', await p2, true);

console.log('=== 4. notify ===');
const t = notify('已清空');
eq('提示文案', t.textContent, '已清空');
truthy('带成功样式', t.className.includes('dlg-toast-ok'));
const t2 = notify('出错了', { ok: false });
truthy('失败样式', t2.className.includes('dlg-toast-bad'));
eq('提示挂在 body 上', document.body.contains(t), true);

console.log('=== 5. installErrorGuard ===');
installErrorGuard();
const before = document.querySelectorAll('.dlg-toast').length;
const ev = new window.Event('unhandledrejection');
ev.reason = new Error('后台连接中断');
window.dispatchEvent(ev);
await tick();
truthy('未捕获的 Promise 错误会显出来', document.querySelectorAll('.dlg-toast').length > before);
truthy(
  '提示里带错误原文',
  [...document.querySelectorAll('.dlg-toast')].some((n) => n.textContent.includes('后台连接中断'))
);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
