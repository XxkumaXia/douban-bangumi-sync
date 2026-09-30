// 请求头规则：给扩展自己发出的豆瓣请求补上 Referer
//
// 为什么必须是动态规则而不是 manifest 里的静态规则集：
//   静态规则无法用 chrome.runtime.id 限定发起者，会连带改写用户在豆瓣网页上的正常 XHR 的
//   Referer，破坏网站自身功能（点赞、标记等按钮）。
//   这里用动态规则 + 精确到接口路径的 urlFilter，把影响面压到最小。

const BASE_ID = 9000;

// [host, referer, 需要匹配的路径前缀列表]
const TARGETS = [
  ['movie.douban.com', 'https://movie.douban.com/mine', ['/mine', '/j/', '/subject/']],
  ['book.douban.com', 'https://book.douban.com/mine', ['/mine', '/j/', '/subject/']],
  ['music.douban.com', 'https://music.douban.com/mine', ['/mine', '/j/', '/subject/']],
  ['m.douban.com', 'https://m.douban.com/', ['/rexxar/']],
  ['frodo.douban.com', 'https://m.douban.com/', ['/api/']],
  ['search.douban.com', 'https://search.douban.com/', ['/']],
];

function buildRules(withOrigin) {
  const rules = [];
  let id = BASE_ID;
  for (const [host, referer, prefixes] of TARGETS) {
    for (const p of prefixes) {
      const headers = [{ header: 'Referer', operation: 'set', value: referer }];
      if (withOrigin) {
        headers.push({ header: 'Origin', operation: 'set', value: new URL(referer).origin });
      }
      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: headers },
        condition: {
          requestDomains: [host],
          urlFilter: `|https://${host}${p}`,
          resourceTypes: ['xmlhttprequest'],
        },
      });
    }
  }
  return rules;
}

function allIds() {
  return buildRules(true).map((r) => r.id);
}

/** 安装规则；带 Origin 的版本失败时自动回退到只设 Referer */
export async function installHeaderRules() {
  const ids = allIds();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: buildRules(true) });
    return { ok: true, originHeader: true, count: ids.length };
  } catch (e) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    } catch {
      /* ignore */
    }
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: buildRules(false) });
    return { ok: true, originHeader: false, count: ids.length, note: `Origin 头不允许修改，已降级: ${e.message}` };
  }
}

/** 自检：规则是否真的装上了 */
export async function inspectHeaderRules() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const mine = rules.filter((r) => r.id >= BASE_ID && r.id < BASE_ID + 200);
  return {
    count: mine.length,
    hasOrigin: mine.some((r) => r.action.requestHeaders?.some((h) => h.header === 'Origin')),
    sample: mine.slice(0, 3).map((r) => ({
      path: r.condition.urlFilter,
      headers: r.action.requestHeaders.map((h) => h.header),
    })),
  };
}
