// 统一数据模型：把豆瓣和 Bangumi 的差异抹平成同一种结构
//
// 内部状态统一为: wish(想看) / doing(在看) / done(看过)
// 内部分类统一为: anime / real / book / music / game
// 内部评分统一为: 0..5 的「星」语义（豆瓣原生）；Bangumi 侧在适配层做 1..10 ↔ 0..5 换算
//                 另存 rawRating 保留原站原始值，避免来回换算丢精度

/** 豆瓣 status 参数 <-> 内部状态 */
export const DOUBAN_STATUS = {
  wish: 'wish',
  do: 'doing',
  collect: 'done',
};

export const DOUBAN_STATUS_REVERSE = {
  wish: 'wish',
  doing: 'do',
  done: 'collect',
};

/** Bangumi collection type <-> 内部状态 */
export const BGM_TYPE = {
  1: 'wish',
  2: 'done',
  3: 'doing',
  4: 'on_hold',
  5: 'dropped',
};

export const BGM_TYPE_REVERSE = {
  wish: 1,
  done: 2,
  doing: 3,
};

/** Bangumi subject_type <-> 内部分类 */
export const BGM_SUBJECT_TYPE = {
  1: 'book',
  2: 'anime',
  3: 'music',
  4: 'game',
  6: 'real',
};

export const BGM_SUBJECT_TYPE_REVERSE = {
  book: 1,
  anime: 2,
  music: 3,
  game: 4,
  real: 6,
};

export const CATEGORY_LABEL = {
  anime: '动画',
  real: '三次元',
  book: '图书',
  music: '音乐',
  game: '游戏',
};

export const STATUS_LABEL = {
  wish: '想看',
  doing: '在看',
  done: '看过',
};

/** 豆瓣站点 <-> 内部分类 */
export const DOUBAN_SITE = {
  movie: { host: 'movie.douban.com', category: 'real', label: '影视' },
  book: { host: 'book.douban.com', category: 'book', label: '读书' },
  music: { host: 'music.douban.com', category: 'music', label: '音乐' },
};

/**
 * 由豆瓣 intro 行的类型串推断 Bangumi 分类
 * intro 形如 "1995 / 日本 / 动画 动作 科幻"
 */
export function guessCategoryFromIntro(intro, fallback = 'real') {
  const s = String(intro || '');
  if (/动画/.test(s)) return 'anime';
  if (/纪录片|真人秀|综艺/.test(s)) return 'real';
  return fallback;
}

/** 创建一条归一化记录 */
export function makeItem(partial) {
  return {
    source: partial.source, // 'douban' | 'bangumi'
    id: String(partial.id),
    title: partial.title || '',
    originalTitle: partial.originalTitle || '',
    year: partial.year ?? null,
    category: partial.category || 'real',
    status: partial.status || 'wish',
    rating: partial.rating ?? 0, // 0..5
    rawRating: partial.rawRating ?? 0, // 原站原始刻度
    comment: partial.comment || '',
    tags: partial.tags || [],
    updatedAt: partial.updatedAt || null, // ISO 日期字符串
    url: partial.url || '',
    // 仅 Bangumi
    subjectId: partial.subjectId ?? null,
    subjectType: partial.subjectType ?? null,
    // 仅豆瓣
    doubanSite: partial.doubanSite || null,
    doubanSubType: partial.doubanSubType || '',
  };
}

/** 把时间统一成可比较的数字；无法解析返回 0 */
export function timeValue(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** 是否「有实质内容」——避免把一条空记录覆盖掉另一条有内容的 */
export function isEmptyRecord(item) {
  return !item || (!item.rating && !item.comment && !item.tags.length);
}
