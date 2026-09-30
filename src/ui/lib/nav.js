// 扩展内部页面之间的跳转
//
// 之前这里一律用 chrome.tabs.create —— 结果就是每次从设置页进同步面板都多开一个标签页，
// 来回几次满屏都是。现在设置页/同步面板都开在独立标签页里（manifest 的 options_ui.open_in_tab），
// 彼此又都是 chrome-extension://<同一个扩展 id>/ 同源，本来就可以直接原地导航，
// 浏览器前进/后退也能用。

/**
 * 跳到扩展内的另一个页面。
 *
 * - 当前页与目标页**同源**（都在本扩展里）→ 原地跳转，不新开标签页
 * - 否则（popup、或者被浏览器框着不允许自身导航的情况）→ 退回新开标签页
 *
 * @param {string} path 相对扩展根目录的路径，例如 'src/ui/sync.html'
 * @param {{newTab?: boolean}} [opts] 传 newTab: true 强制新开标签页
 * @returns {'same-tab' | 'already' | 'new-tab'} 实际走的哪条路，便于测试与排错
 */
export function goToPage(path, opts = {}) {
  const url = chrome.runtime.getURL(path);
  let target;
  try {
    target = new URL(url);
  } catch {
    chrome.tabs.create({ url });
    return 'new-tab';
  }

  if (!opts.newTab) {
    try {
      const loc = window.location;
      // 同源 = 协议 + host 都一致（chrome-extension://<id>）。
      // popup.html 也是同源，但它没法安全地导航自身（ popup 会关闭），所以调用方传 newTab。
      if (loc.protocol === target.protocol && loc.host === target.host) {
        if (loc.pathname === target.pathname) return 'already';
        loc.assign(target.href);
        return 'same-tab';
      }
    } catch {
      // 某些宿主会禁止读取 location（极少见），落到下面的兜底
    }
  }

  chrome.tabs.create({ url });
  return 'new-tab';
}

/** popup 这类必须新开标签页的地方用它，语义更清楚 */
export function openInNewTab(path) {
  return goToPage(path, { newTab: true });
}
