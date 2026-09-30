// 设置页评分换算 UI 的端到端验证：用 jsdom 加载真实的 options.html，
// mock 掉 chrome 通信后 import 真实的 options.js，检查自定义换算表的渲染与收集是否正常工作。
// 运行：JSDOM_PATH=file:///.../jsdom/lib/api.js node tests/options-rating.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const jsdomPath = process.env.JSDOM_PATH || 'jsdom';
const { JSDOM } = await import(jsdomPath);

// 用 fileURLToPath 而非 URL.pathname：中文路径下 pathname 是百分号编码的，拼出来读不到文件
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const html = fs.readFileSync(path.join(root, 'src/ui/options.html'), 'utf8');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const truthy = (name, v) => { if (v) pass++; else { fail++; console.log(`FAIL ${name} -> ${v}`); } };

// --- 建立 DOM 环境 ---
const dom = new JSDOM(html, { url: 'https://example.org/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;

// --- mock chrome 通信：只回应设置读写 ---
const store = {
  ratingMode: 'custom',
  customRatingMap: [1, 3, 5, 7, 9],
};
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      if (msg.type === 'SETTINGS_GET') return cb({ ok: true, data: store });
      if (msg.type === 'SETTINGS_SET') {
        Object.assign(store, msg.payload); // 后台是 merge 语义，mock 要一致
        return cb({ ok: true, data: { ...store } });
      }
      return cb({ ok: true, data: null });
    },
  },
};

// options.js 顶层就会执行 buildCustomMapInputs() + load()，import 即相当于打开设置页
await import(pathToFileURL(path.join(root, 'src/ui/options.js')).href);

const $ = (id) => document.getElementById(id);

console.log('=== 1. 自定义表输入框已生成 ===');
for (let s = 1; s <= 5; s++) truthy(`cm${s} 输入框存在`, !!$(`cm${s}`));
eq('输入框数量', document.querySelectorAll('#customMapRow input[type=number]').length, 5);
eq('按设置回填的自定义表', [1, 2, 3, 4, 5].map((s) => $(`cm${s}`).value), ['1', '3', '5', '7', '9']);

console.log('=== 2. 自定义模式下显示换算表 ===');
eq('模式下拉=custom', $('ratingMode').value, 'custom');
eq('自定义表区块可见', $('customMapField').hidden, false);
const hint = $('ratingHint').innerHTML;
truthy('渲染了正向表', hint.includes('→ Bangumi'));
truthy('渲染了反向表', hint.includes('反向'));
truthy('正向表含自定义值 3★=5分', hint.includes('<td>3 星</td><td>5 分</td>'));
// 反向由正向推导：1分→1★、2分→2★、4分→3★、6分→4★、9分→5★
truthy('反向表 4分→3星', hint.includes('<td>4 分</td><td>3 星</td>'));
truthy('反向表 9分→5星', hint.includes('<td>9 分</td><td>5 星</td>'));

console.log('=== 3. 切换模式会隐藏自定义区块 ===');
$('ratingMode').value = 'step';
$('ratingMode').dispatchEvent(new window.Event('change'));
eq('切到阶梯后隐藏', $('customMapField').hidden, true);
truthy('阶梯模式提示仍在', $('ratingHint').innerHTML.includes('→ Bangumi'));

console.log('=== 4. 改数字实时更新预览 ===');
$('ratingMode').value = 'custom';
$('ratingMode').dispatchEvent(new window.Event('change'));
$('cm3').value = '6';
$('cm3').dispatchEvent(new window.Event('input'));
truthy('改 3★=6 后预览同步', $('ratingHint').innerHTML.includes('<td>3 星</td><td>6 分</td>'));

console.log('=== 5. 非法输入会被诊断且换算不崩 ===');
$('cm5').value = '99';
$('cm5').dispatchEvent(new window.Event('input'));
truthy('超范围有提示', $('ratingHint').innerHTML.includes('1-10'));
$('cm2').value = '';
$('cm2').dispatchEvent(new window.Event('input'));
truthy('空值有提示', $('ratingHint').innerHTML.includes('1-10'));
truthy('非法输入下表格仍渲染', $('ratingHint').innerHTML.includes('</table>'));

console.log('=== 6. 一键填值按钮 ===');
$('btnCustomReset').dispatchEvent(new window.Event('click'));
eq('恢复默认=阶梯值', [1, 2, 3, 4, 5].map((s) => $(`cm${s}`).value), ['2', '4', '6', '8', '10']);
$('btnCustomFromStep').dispatchEvent(new window.Event('click'));
eq('用阶梯值', [1, 2, 3, 4, 5].map((s) => $(`cm${s}`).value), ['2', '4', '6', '8', '10']);

console.log('=== 7. 保存时写入的是规整后的值 ===');
$('cm1').value = '';
$('cm1').dispatchEvent(new window.Event('input'));
$('btnSave').dispatchEvent(new window.Event('click'));
await new Promise((r) => setTimeout(r, 30));
eq('空档位被规整为默认值', store.customRatingMap, [2, 4, 6, 8, 10]);
eq('模式一并保存', store.ratingMode, 'custom');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
