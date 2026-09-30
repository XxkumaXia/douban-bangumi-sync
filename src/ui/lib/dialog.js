// 页面内自绘的确认框 / 提示条
//
// 为什么不用原生 confirm()/alert()：
// 当设置页被嵌在 chrome://extensions 的「扩展程序选项」方框里时（open_in_tab 不为 true 的情况），
// 页面并不托管在自己的标签页里，Chrome 会拦掉原生模态框 —— 调用直接失效。
// 表现就是按钮点下去毫无反应，也没有任何报错，非常难排查。
// 所以统一改成往 DOM 里插一个浮层，任何宿主环境（独立标签页 / 嵌入框 / 弹窗）都可用。

const MASK_CLASS = 'dlg-mask';
let activeClose = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 页面内确认框
 * @param {{title?:string, message?:string, okText?:string, cancelText?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts = {}) {
  const {
    title = '请确认',
    message = '',
    okText = '确定',
    cancelText = '取消',
    danger = false,
  } = opts;

  // 同一时刻只保留一个：先前没关掉的按「取消」处理
  if (activeClose) activeClose(false);

  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = MASK_CLASS;
    mask.innerHTML =
      `<div class="dlg-box" role="dialog" aria-modal="true">` +
      `<div class="dlg-title">${esc(title)}</div>` +
      (message ? `<div class="dlg-msg">${esc(message)}</div>` : '') +
      `<div class="dlg-actions">` +
      `<button class="dlg-cancel">${esc(cancelText)}</button>` +
      `<button class="primary dlg-ok${danger ? ' dlg-danger' : ''}">${esc(okText)}</button>` +
      `</div></div>`;

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      activeClose = null;
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      resolve(val);
    };
    activeClose = finish;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    };

    mask.querySelector('.dlg-ok').addEventListener('click', () => finish(true));
    mask.querySelector('.dlg-cancel').addEventListener('click', () => finish(false));
    mask.addEventListener('click', (e) => {
      if (e.target === mask) finish(false);
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(mask);
    mask.querySelector('.dlg-ok').focus();
  });
}

/** 轻提示，几秒后自动消失 */
export function notify(message, { ok = true, timeout = 3200 } = {}) {
  const el = document.createElement('div');
  el.className = `dlg-toast ${ok ? 'dlg-toast-ok' : 'dlg-toast-bad'}`;
  el.textContent = String(message ?? '');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), timeout);
  return el;
}

/**
 * 兜底：任何未捕获的错误都显出来
 * 否则在嵌入框里出错时页面只是「点了没反应」，用户和开发者都看不到原因
 */
export function installErrorGuard() {
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message || String(e.reason || '未知错误');
    notify(`操作失败：${msg}`, { ok: false, timeout: 6000 });
  });
  window.addEventListener('error', (e) => {
    if (e.message) notify(`脚本错误：${e.message}`, { ok: false, timeout: 6000 });
  });
}
