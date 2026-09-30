// offscreen document：service worker 没有 DOMParser，借用这里的 DOM 环境解析豆瓣 HTML
import { parseListPage, parseSearchPage } from '../adapters/douban-parse.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PARSE_DOUBAN_LIST') {
    try {
      const { html, site, status } = msg.payload;
      const data = parseListPage(html, site, status);
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (msg?.type === 'PARSE_DOUBAN_SEARCH') {
    try {
      const { html, site } = msg.payload;
      const { items, via } = parseSearchPage(html, site);
      sendResponse({ ok: true, data: { items, via } });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }

  if (msg?.type === 'PARSE_PING') {
    sendResponse({ ok: true });
  }
});
