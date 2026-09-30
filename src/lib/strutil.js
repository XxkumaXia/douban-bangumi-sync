// 字符串工具：标题归一化、相似度、年份提取

const FULLWIDTH_OFFSET = 0xfee0;

/** 全角转半角 */
export function toHalfWidth(s) {
  return String(s || '').replace(/[\uff01-\uff5e]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - FULLWIDTH_OFFSET)
  );
}

/** 片假名转平假名，用于日原标题比较 */
export function kataToHira(s) {
  return String(s || '').replace(/[\u30a1-\u30f6]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

/** 提取标题里的年份（4 位，19xx/20xx） */
export function extractYear(s) {
  const m = String(s || '').match(/(19\d{2}|20\d{2})/);
  return m ? Number(m[1]) : null;
}

// 需要剥离的干扰词：季数后缀、媒介标记、常见副标题
const NOISE_PATTERNS = [
  /第[一二三四五六七八九十\d]+季/g,
  /\bseason\s*\d+/gi,
  /\b(part|episode|ep|vol|volume)\s*\d+/gi,
  /[（(\[【][^）)\]】]{0,12}[）)\]】]/g, // 括号内容
  /剧场版/g,
  /movie\s*edition/gi,
  /tv\s*版/gi,
  /[·・:：\-–—~～]/g,
];

/**
 * 标题归一化：小写、全角转半角、片假名统一、去标点空格、去噪音词
 * 用于匹配比较，不用于展示
 */
export function normalizeTitle(s) {
  let t = toHalfWidth(s || '');
  t = kataToHira(t);
  t = t.toLowerCase();
  for (const p of NOISE_PATTERNS) {
    t = t.replace(p, ' ');
  }
  // 去除所有非字母数字非 CJK 的字符
  t = t.replace(/[^0-9a-z\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\uac00-\ud7af]/g, '');
  return t.trim();
}

/** 只做轻度清洗，保留可读形式，用于展示与调试 */
export function cleanTitle(s) {
  return toHalfWidth(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 拆「主标题 / 原名」
 * 豆瓣与 Bangumi 的标题常见形态：
 *   "攻壳机动队 / Ghost in the Shell 1995"
 *   "进击的巨人 最终季 / 進撃の巨人 The Final Season"
 * 匹配时两边要拆开分别比对——整串直接算相似度会被原名稀释，导致明明是同一部作品却打低分。
 * @param {string} raw
 * @returns {{mainTitle: string, originalTitle: string}}
 */
export function splitTitleParts(raw) {
  const s = String(raw || '').trim();
  let main = s;
  let original = '';

  const slash = s.split(/\s*[\/／]\s*/);
  if (slash.length >= 2) {
    const first = slash[0].trim();
    const rest = slash.slice(1).join(' / ').trim();
    if (/[\u4e00-\u9fa5]/.test(first)) {
      // 第一段是中文：中文当主标题，其余拼成原名
      main = first;
      original = rest;
    } else if (/[\u4e00-\u9fa5]/.test(rest)) {
      // 第一段是拉丁文、后面才是中文：反过来
      main = rest;
      original = first;
    } else {
      main = first;
      original = rest;
    }
  }

  // 去掉尾部年份（原名里带的年份对匹配只有干扰）
  main = main.replace(/\s*(19\d{2}|20\d{2})\s*$/, '').trim();
  original = original.replace(/\s*(19\d{2}|20\d{2})\s*$/, '').trim();
  return { mainTitle: main, originalTitle: original };
}

/** Levenshtein 编辑距离 */
export function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const m = s.length;
  const n = t.length;
  if (m * n > 4000000) return Math.max(m, n); // 防爆炸
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** 归一化相似度 0..1 */
export function similarity(a, b) {
  const s = normalizeTitle(a);
  const t = normalizeTitle(b);
  if (!s || !t) return 0;
  if (s === t) return 1;
  const maxLen = Math.max(s.length, t.length);
  const dist = editDistance(s, t);
  return Math.max(0, 1 - dist / maxLen);
}

/** 包含关系加成：短标题完整出现在长标题里 */
export function containment(a, b) {
  const s = normalizeTitle(a);
  const t = normalizeTitle(b);
  if (!s || !t) return 0;
  return s.includes(t) || t.includes(s) ? 1 : 0;
}

/** 综合标题得分 0..1 */
export function titleScore(a, b) {
  const sim = similarity(a, b);
  const cont = containment(a, b);
  // 相似度为主，包含关系做加成
  return Math.min(1, sim * 0.75 + cont * 0.25 + (cont ? 0.1 : 0));
}
