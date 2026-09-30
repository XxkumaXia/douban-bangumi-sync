/** 与后台 service worker 通信 */

export function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('后台无响应（service worker 可能已休眠，重试一次）'));
      if (resp.ok) return resolve(resp.data);
      reject(new Error(resp.error || '未知错误'));
    });
  });
}

/**
 * 长连接：用于扫描/同步这类需要持续回报进度的任务
 * @param {object} msg
 * @param {(progress:object)=>void} onProgress
 */
export function sendStream(msg, onProgress) {
  const port = chrome.runtime.connect({ name: 'sync' });
  return new Promise((resolve, reject) => {
    let settled = false;
    port.onMessage.addListener((m) => {
      if (m.type === 'progress') {
        onProgress?.(m);
        return;
      }
      if (m.type === 'done') {
        settled = true;
        port.disconnect();
        resolve(m.data);
      } else if (m.type === 'error') {
        settled = true;
        port.disconnect();
        reject(new Error(m.error));
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new Error('后台连接中断'));
    });
    port.postMessage(msg);
  });
}
