// 豆瓣列表页解析（纯函数，需要 DOM 环境：offscreen document 或页面上下文）
// 不依赖任何 chrome API，可以直接在浏览器控制台里对着真实页面调用来调试
import { guessCategoryFromIntro, makeItem } from '../core/normalize.js';
import { splitTitleParts } from '../lib/strutil.js';

// 豆瓣评星球对应的 title 文案，用于兜底提取星级
const RATING_TITLE = {
  很差: 1,
  较差: 2,
  还行: 3,
  推荐: 4,
  力荐: 5,
};

// 新版豆瓣列表可能用的几个容器，逐个尝试
const ITEM_SELECTORS = [
  'li.subject',
  'div.subject-item',
  'div.doulist-item',
  'li.media',
  'div.item',
];

/**
 * 解析一个豆瓣「我的」列表页
 * @param {Document|string} input
 * @param {string} site 'movie' | 'book' | 'music'
 * @param {string} status 'wish' | 'do' | 'collect'
 * @returns {{items: Array, nextUrl: string|null, userUid: string|null, total: number|null, matchedSelector: string|null}}
 */
export function parseListPage(input, site = 'movie', status = 'collect') {
  const doc = typeof input === 'string' ? new DOMParser().parseFromString(input, 'text/html') : input;

  let nodes = [];
  let matchedSelector = null;
  for (const sel of ITEM_SELECTORS) {
    const found = Array.from(doc.querySelectorAll(sel));
    // 过滤掉明显不是条目的（比如侧栏的 li）
    const valid = found.filter((n) => n.querySelector('a[href*="/subject/"]'));
    if (valid.length) {
      nodes = valid;
      matchedSelector = sel;
      break;
    }
  }

  const items = nodes.map((n) => parseItem(n, site, status)).filter(Boolean);

  return {
    items,
    nextUrl: findNextUrl(doc),
    userUid: extractUid(doc),
    total: extractTotal(doc),
    matchedSelector,
  };
}

function parseItem(node, site, status) {
  const link = node.querySelector('a[href*="/subject/"]');
  if (!link) return null;

  const href = link.getAttribute('href') || '';
  const idMatch = href.match(/\/subject\/(\d+)/);
  if (!idMatch) return null;
  const id = idMatch[1];

  // 标题：优先 .title 下的链接文本，其次 img/a 的 title 属性
  const titleNode = node.querySelector('.title a') || link;
  const titleRaw = (titleNode.textContent || '').replace(/\s+/g, ' ').trim();
  const titleAttr = (node.querySelector('img[title]')?.getAttribute('title') || link.getAttribute('title') || '').trim();

  const { mainTitle, originalTitle } = splitTitle(titleRaw || titleAttr);

  // 年份：.title 里的 span.year，其次 intro 前 4 位
  const yearNode = node.querySelector('.title .year, .year');
  let year = yearNode ? Number((yearNode.textContent || '').replace(/[^\d]/g, '')) || null : null;

  const intro = (node.querySelector('.intro')?.textContent || '').replace(/\s+/g, ' ').trim();
  if (!year) {
    const m = intro.match(/(19\d{2}|20\d{2})/);
    year = m ? Number(m[1]) : null;
  }

  // 评分
  const rating = extractRating(node);

  // 日期
  const dateNode = node.querySelector('.date');
  const updatedAt = normalizeDate(dateNode ? dateNode.textContent : '');

  // 标签
  const tagsNode = node.querySelector('.tags');
  const tags = tagsNode
    ? tagsNode.textContent
        .replace(/^标签[:：]?/, '')
        .split(/[\s,，、]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // 短评
  const commentNode = node.querySelector('.comment');
  const comment = commentNode ? commentNode.textContent.replace(/^短评[:：]?/, '').trim() : '';

  const category = site === 'book' ? 'book' : site === 'music' ? 'music' : guessCategoryFromIntro(intro, 'real');

  return makeItem({
    source: 'douban',
    id: `douban:${id}`,
    title: mainTitle,
    originalTitle,
    year,
    category,
    status: status === 'do' ? 'doing' : status === 'collect' ? 'done' : 'wish',
    rating,
    rawRating: rating,
    comment,
    tags,
    updatedAt,
    url: `https://${site}.douban.com/subject/${id}/`,
    doubanSite: site,
    doubanSubType: intro,
  });
}

// 标题拆分逻辑与反向匹配共用（见 lib/strutil.js），这里直接复用，避免两边算法漂移
function splitTitle(raw) {
  return splitTitleParts(raw);
}

function extractRating(node) {
  // 形态 1: <span class="rating5-t">
  const span = node.querySelector('span[class*="rating"], span[class*="allstar"]');
  if (span) {
    const cls = span.className || '';
    let m = cls.match(/rating(\d+)-t/);
    if (m) return Number(m[1]);
    m = cls.match(/allstar(\d+)/);
    if (m) return Math.round(Number(m[1]) / 10);
    const title = span.getAttribute('title');
    if (title && RATING_TITLE[title]) return RATING_TITLE[title];
  }
  // 形态 2: 节点文本里出现 "5星"
  const text = node.textContent || '';
  const star = text.match(/([1-5])\s*星/);
  if (star) return Number(star[1]);
  return 0;
}

function normalizeDate(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = t.match(/(19\d{2}|20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) {
    const [_, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const y = t.match(/(19\d{2}|20\d{2})/);
  return y ? `${y[1]}-01-01` : null;
}

function findNextUrl(doc) {
  const candidates = [
    doc.querySelector('.paginator .next a'),
    doc.querySelector('span.next a'),
    doc.querySelector('.next'),
  ].filter(Boolean);
  for (const el of candidates) {
    const href = el.getAttribute ? el.getAttribute('href') : null;
    if (href && href !== '#') return href;
  }
  // 兜底：找 rel=next
  const rel = doc.querySelector('link[rel="next"]');
  if (rel) return rel.getAttribute('href');
  return null;
}

function extractUid(doc) {
  const a = doc.querySelector('a[href*="www.douban.com/people/"], a[href*="/mine"]');
  if (a) {
    const m = (a.getAttribute('href') || '').match(/\/people\/([^/?#]+)/);
    if (m) return m[1];
  }
  const script = doc.body?.textContent || '';
  const m2 = script.match(/"uid"\s*:\s*"?(\d+)"?/);
  return m2 ? m2[1] : null;
}

function extractTotal(doc) {
  const t = doc.querySelector('.subject-num, .count, .paginator .thispage');
  if (!t) return null;
  const m = t.textContent.match(/\d+/);
  return m ? Number(m[0]) : null;
}

// ---------------------------------------------------------------- 搜索页

/** 新版搜索页把结果塞在这些全局变量里（页面是 React 空壳时只有这条路能拿到数据） */
const SEARCH_JSON_HINTS = ['__DATA__', '__INITIAL_STATE__', '__NUXT__', 'window.__props'];

/**
 * 解析豆瓣搜索结果页
 * 两种情况都要覆盖：① SSR 出来的 DOM；② React 空壳 + 内嵌 JSON
 * @param {Document|string} input
 * @param {string} site 'movie' | 'book' | 'music'
 * @returns {{items: Array, via: 'json'|'dom'|null}}
 */
export function parseSearchPage(input, site = 'movie') {
  const doc = typeof input === 'string' ? new DOMParser().parseFromString(input, 'text/html') : input;
  const host = site === 'book' ? 'book.douban.com' : site === 'music' ? 'music.douban.com' : 'movie.douban.com';

  const fromJson = tryExtractFromJson(doc, host);
  if (fromJson.length) return { items: fromJson, via: 'json' };

  const items = extractFromDom(doc, host);
  return { items, via: items.length ? 'dom' : null };
}

/** 从 <script> 里的全局变量提取结果 */
function tryExtractFromJson(doc, host) {
  const out = [];
  const seen = new Set();
  for (const s of doc.querySelectorAll('script')) {
    const t = s.textContent || '';
    if (!SEARCH_JSON_HINTS.some((h) => t.includes(h))) continue;
    for (const hint of SEARCH_JSON_HINTS) {
      let idx = t.indexOf(hint);
      while (idx >= 0) {
        const obj = extractJsonObject(t, idx);
        if (obj) collectItems(obj, out, seen, host);
        idx = t.indexOf(hint, idx + 1);
      }
    }
    if (out.length >= 20) break;
  }
  return out.slice(0, 20);
}

/** 括号配对提取一个完整 JSON 对象，比正则可靠（JSON 里嵌套和字符串里的花括号都能处理） */
function extractJsonObject(text, from) {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 在任意嵌套结构里递归搜集「有 id 又有 title」的条目 */
function collectItems(node, out, seen, host) {
  if (out.length >= 20) return;
  if (Array.isArray(node)) {
    for (const it of node) collectItems(it, out, seen, host);
    return;
  }
  if (!node || typeof node !== 'object') return;

  const t = node.target && typeof node.target === 'object' ? node.target : node;
  const id = t.id ?? t.subject_id ?? t.sid;
  const title = t.title ?? t.name ?? t.card_title;
  const idOk = id !== undefined && id !== null && /^\d+$/.test(String(id));
  const titleOk = typeof title === 'string' && title.trim().length > 0;

  if (idOk && titleOk && !seen.has(String(id))) {
    seen.add(String(id));
    out.push({
      id: String(id),
      title: title.trim(),
      year: Number(t.year || t.release_year) || extractYearish(t),
      url: t.url || `https://${host}/subject/${id}/`,
      intro: String(t.abstract || t.card_subtitle || t.subtitle || t.intro || '').slice(0, 120),
    });
  }

  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectItems(v, out, seen, host);
  }
}

function extractYearish(t) {
  const s = String(t?.card_subtitle || t?.abstract || t?.subtitle || '');
  const m = s.match(/(19\d{2}|20\d{2})/);
  return m ? Number(m[1]) : null;
}

/** DOM 兜底：抓所有 /subject/ 链接，排除导航与页脚 */
function extractFromDom(doc, host) {
  const seen = new Set();
  const items = [];
  const SKIP_ROOTS = '#db-global-nav, .nav, .nav-global, #db-nav-movie, #db-nav-book, #db-nav-music, .footer, #footer, .aside, .side';

  for (const a of doc.querySelectorAll('a[href*="/subject/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/subject\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    if (a.closest(SKIP_ROOTS)) continue;

    // 往上找几层，取最能代表这条结果的文本块
    let node = a;
    let text = '';
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length > text.length) text = t;
      if (t.length > 30) break;
    }
    const title = (a.textContent || '').replace(/\s+/g, ' ').trim() || text.slice(0, 40);
    if (!title) continue;

    seen.add(id);
    items.push({
      id,
      title,
      year: (() => {
        const ym = text.match(/(19\d{2}|20\d{2})/);
        return ym ? Number(ym[1]) : null;
      })(),
      url: `https://${host}/subject/${id}/`,
      intro: text.slice(0, 120),
    });
    if (items.length >= 20) break;
  }
  return items;
}

/** 解析单条目收藏状态（rexxar / j 接口返回的 JSON 到归一化状态） */
export function normalizeInterestJson(data) {
  if (!data) return null;
  const status = data.status || data.interest_status || data.type;
  const map = { wish: 'wish', do: 'doing', collect: 'done', doing: 'doing', done: 'done', watched: 'done' };
  const rating = data.rating?.value ?? data.rating ?? data.rate ?? 0;
  return {
    status: map[status] || null,
    rating: Number(rating) || 0,
    comment: data.comment || '',
    tags: data.tags || [],
  };
}

// ---------------------------------------------------------------- 分享到广播字段

/** 把 <input ...> 标签的属性抠出来 */
function inputAttrs(tag) {
  const get = (n) => {
    const m = tag.match(new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? m[1] ?? m[2] ?? m[3] ?? '' : '';
  };
  return {
    name: get('name'),
    value: get('value'),
    id: get('id'),
    // 没写 type 的 input 默认是 text
    type: (get('type') || 'text').toLowerCase(),
    checked: /\bchecked\b/i.test(tag),
    tag,
  };
}

/**
 * 从豆瓣「添加收藏」弹窗的 HTML 里，找出「分享到豆瓣广播」那个勾选框的真实字段名。
 *
 * 为什么是解析而不是写死参数名：豆瓣没有公开这个接口的文档，
 * 字段名（叫 share 还是 share_status 还是别的）只能从它自己渲染出来的弹窗里读。
 * 写死一个猜的名字，出错了会静默失败——请求照样发出去，广播就是不出现，最难查。
 *
 * 定位顺序（先精后粗）：
 *   1. 「分享到」字样之后 400 字符内的第一个勾选框（截图里 checkbox 就紧跟在这四个字右边）
 *   2. name 里带 share / broadcast 字样的勾选框
 *   3. 「豆瓣广播」字样前后 300 字符内的勾选框
 *
 * @param {string} html 弹窗 HTML（可能是 /j/subject/{id}/interest 返回的 JSON 里的 html 字段）
 * @returns {{name:string, value:string, checked:boolean, id:string, via:string}|null}
 */
export function findShareCheckbox(html) {
  const src = String(html || '');
  if (!src) return null;

  const all = [...src.matchAll(/<input\b[^>]*>/gi)].map((m) => inputAttrs(m[0])).filter((a) => a.name);
  if (!all.length) return null;

  const pick = (a, via) => ({
    name: a.name,
    // checkbox 不写 value 时，表单提交的就是 "on"
    value: a.value || 'on',
    checked: a.checked,
    id: a.id,
    via,
  });

  const isBox = (a) => a.type === 'checkbox' || a.type === 'radio';

  // 1) 「分享到」后面的勾选框
  const share = /分享到/.exec(src);
  if (share) {
    const limit = share.index + 400;
    const hit = all.find((a) => isBox(a) && src.indexOf(a.tag) > share.index && src.indexOf(a.tag) < limit);
    if (hit) return pick(hit, 'nearby-分享到');
  }

  // 2) 字段名自己就带 share/broadcast
  const named = all.find((a) => isBox(a) && /share|broadcast|bcast/i.test(a.name));
  if (named) return pick(named, 'field-name');

  // 3) 「豆瓣广播」附近的勾选框
  const bc = /豆瓣广播|同步到广播/.exec(src);
  if (bc) {
    const hit = all.find((a) => {
      if (!isBox(a)) return false;
      const i = src.indexOf(a.tag);
      return Math.abs(i - bc.index) < 300;
    });
    if (hit) return pick(hit, 'nearby-广播');
  }

  return null;
}

// 豆瓣收藏表单里「状态」字段可能取到的值（网页端 wish/do/collect，部分接口 wish/doing/done）
const STATUS_VALUES = new Set(['wish', 'do', 'doing', 'done', 'collect', 'watched', 'watching']);

/**
 * 把豆瓣收藏弹窗 HTML 里的表单字段全部读出来。
 *
 * 存在的理由：豆瓣没有公开收藏接口的文档，字段名（状态到底叫 status 还是 interest、
 * 评分叫 rating 还是 score）只能从它自己渲染的弹窗里读。之前我们是按猜的名字发请求，
 * 「在看」被写成「看过」这类问题就只能靠猜原因 —— 现在改成让豆瓣自己说。
 *
 * @param {string} html 弹窗 HTML（/j/subject/{id}/interest 返回的 JSON 里的 html 字段）
 * @returns {{
 *   fields: Array<{name:string,type:string,value:string,checked:boolean}>,
 *   statusField: {name:string, kind:string, options:string[]}|null,
 *   ratingField: {name:string, kind:string, options:string[]}|null,
 *   shareField: {name:string, value:string}|null,
 *   htmlLength: number
 * }}
 */
export function parseInterestFormFields(html) {
  const src = String(html || '');
  const fields = [...src.matchAll(/<input\b[^>]*>/gi)]
    .map((m) => inputAttrs(m[0]))
    .filter((a) => a.name)
    .map(({ name, type, value, checked }) => ({ name, type, value, checked }));

  // <select name="x"><option value="a">…</option></select>
  const selects = [];
  for (const m of src.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = m[1].match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const nameVal = name ? name[1] ?? name[2] ?? name[3] : '';
    if (!nameVal) continue;
    const options = [...m[2].matchAll(/<option\b[^>]*>/gi)]
      .map((o) => o[0].match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i))
      .filter(Boolean)
      .map((v) => v[1] ?? v[2] ?? v[3] ?? '')
      .filter(Boolean);
    selects.push({ name: nameVal, type: 'select', value: '', checked: false, options });
  }
  fields.push(...selects);

  // 同名 radio 归成一组，值取全集
  const radioGroups = new Map();
  for (const f of fields) {
    if (f.type !== 'radio') continue;
    const g = radioGroups.get(f.name) || [];
    if (f.value) g.push(f.value);
    radioGroups.set(f.name, g);
  }

  const optionsOf = (f) => f.options || radioGroups.get(f.name) || (f.value ? [f.value] : []);

  // 状态字段：名字带 status/interest/type，或者可选值里出现了豆瓣的状态词
  const statusField =
    fields.find((f) => /^(status|interest|interest_status|state|type|action)$/i.test(f.name) && optionsOf(f).some((v) => STATUS_VALUES.has(String(v).toLowerCase()))) ||
    fields.find((f) => optionsOf(f).some((v) => STATUS_VALUES.has(String(v).toLowerCase()))) ||
    null;
  const ratingField =
    fields.find((f) => /^(rating|rate|score|star|stars)$/i.test(f.name)) ||
    fields.find((f) => /rating|score|rate|star/i.test(f.name)) ||
    null;
  // 「仅自己可见」：实测字段名是 private（checkbox）。我们以前发的是 privacy，
  // 猜错不会报错，只会导致设置静默失效 —— 所以同样要读出来
  const privateField =
    fields.find((f) => /^(private|privacy|is_private|hidden|secret)$/i.test(f.name)) ||
    fields.find((f) => /private|privacy|secret/i.test(f.name)) ||
    null;

  const pick = (f) =>
    f
      ? {
          name: f.name,
          kind: f.type,
          options: [...new Set(optionsOf(f))],
          current: f.type === 'select' ? (f.options || []).find(Boolean) || null : f.value || null,
        }
      : null;

  return {
    fields: fields.map(({ name, type, value, checked }) => ({ name, type, value, checked })),
    statusField: pick(statusField),
    ratingField: pick(ratingField),
    privateField: pick(privateField),
    shareField: findShareCheckbox(src),
    htmlLength: src.length,
  };
}
