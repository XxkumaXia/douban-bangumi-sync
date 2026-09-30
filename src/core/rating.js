// 评分换算：豆瓣 1-5 星 <-> Bangumi 1-10 分
//
// 三种模式：
//   step   阶梯 —— 1★=2分 2★=4分 … 5★=10分（默认）
//   linear 线性 —— 星级/5*10 四舍五入
//   custom 自定义 —— 用户自己填 1★~5★ 各对应多少 Bangumi 分
//
// 正向（星 → 分）由用户直接定义；反向（分 → 星）由正向表泛化推导：
// 分数落在哪一档的上界内就归到那一星。step 模式正是这套规则在 [2,4,6,8,10] 上的特例。

/** 阶梯映射：豆瓣星 -> Bangumi 分 */
const STEP_D2B = { 0: 0, 1: 2, 2: 4, 3: 6, 4: 8, 5: 10 };

/** 自定义模式的默认表，等价于阶梯模式。索引 0..4 对应 1★~5★ */
export const DEFAULT_CUSTOM_MAP = [2, 4, 6, 8, 10];

export const RATING_MODES = ['step', 'linear', 'custom'];

export const RATING_MODE_LABEL = {
  step: '阶梯（1★=2分，每档 +2）',
  linear: '线性（星级 ×2）',
  custom: '自定义（自己定每档分数）',
};

function stepB2D(n) {
  if (!n) return 0;
  if (n <= 2) return 1;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  if (n <= 8) return 4;
  return 5;
}

/**
 * 规整自定义表：长度固定 5，每档 1-10 整数。
 * 非法或缺失的档位用默认值补齐 —— 保证换算永远返回有效数字，不会因脏数据中断同步。
 */
export function normalizeCustomMap(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  for (let i = 0; i < 5; i++) {
    const n = Math.round(Number(raw[i]));
    out.push(Number.isFinite(n) && n >= 1 && n <= 10 ? n : DEFAULT_CUSTOM_MAP[i]);
  }
  return out;
}

/**
 * 诊断用户填的表（设置页提示用）
 * @returns {{map:number[], issues:string[], monotonic:boolean}}
 */
export function inspectCustomMap(input) {
  const map = normalizeCustomMap(input);
  const raw = Array.isArray(input) ? input : [];
  const issues = [];

  if (raw.length !== 5) {
    issues.push(`需要 5 个档位（1★~5★），当前填了 ${raw.length} 个，缺失的已按默认补齐`);
  }
  for (let i = 0; i < 5; i++) {
    const n = raw[i] === '' || raw[i] == null ? NaN : Math.round(Number(raw[i]));
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      issues.push(`${i + 1}★ 需要是 1-10 的整数，已回退为 ${DEFAULT_CUSTOM_MAP[i]} 分`);
    }
  }
  let monotonic = true;
  for (let i = 1; i < 5; i++) {
    if (map[i] < map[i - 1]) {
      monotonic = false;
      break;
    }
  }
  if (!monotonic) {
    issues.push('分数应随星级递增（例如 3★ 不低于 2★），否则反向换算结果会不符合直觉');
  }
  return { map, issues, monotonic };
}

/** 反向推导：Bangumi 分 -> 豆瓣星（自定义表） */
function customB2D(n, map) {
  for (let s = 1; s <= 5; s++) {
    if (n <= map[s - 1]) return s;
  }
  return 5;
}

/** 豆瓣星 -> Bangumi 分 */
export function doubanToBgm(stars, mode = 'step', custom = null) {
  const s = clampInt(stars, 0, 5);
  if (!s) return 0;
  if (mode === 'linear') return clampInt(Math.round((s / 5) * 10), 1, 10);
  if (mode === 'custom') return normalizeCustomMap(custom)[s - 1];
  return STEP_D2B[s] ?? 0;
}

/** Bangumi 分 -> 豆瓣星 */
export function bgmToDouban(score, mode = 'step', custom = null) {
  const n = clampInt(score, 0, 10);
  if (!n) return 0;
  if (mode === 'linear') return clampInt(Math.round((n / 10) * 5), 1, 5);
  if (mode === 'custom') return customB2D(n, normalizeCustomMap(custom));
  return stepB2D(n);
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}

/** 正向换算预览表：豆瓣 1-5 星 → Bangumi 分 → 回豆瓣，用于设置页展示 */
export function previewTable(mode = 'step', custom = null) {
  const rows = [];
  for (let s = 1; s <= 5; s++) {
    const bgmScore = doubanToBgm(s, mode, custom);
    rows.push({ douban: s, bgm: bgmScore, back: bgmToDouban(bgmScore, mode, custom) });
  }
  return rows;
}

/** 反向换算预览表：Bangumi 1-10 分 → 豆瓣星 → 回 Bangumi */
export function previewReverseTable(mode = 'step', custom = null) {
  const rows = [];
  for (let n = 1; n <= 10; n++) {
    const stars = bgmToDouban(n, mode, custom);
    rows.push({ bgm: n, douban: stars, back: doubanToBgm(stars, mode, custom) });
  }
  return rows;
}

/**
 * 往返损耗检查
 * 两个方向分别看：
 *   starSafe  —— 豆瓣 1-5 星 → Bangumi 分 → 回豆瓣，是否还原
 *   scoreSafe —— Bangumi 1-10 分 → 豆瓣星 → 回 Bangumi，是否还原
 * 后者在有多个 Bangumi 分数落在同一档星级时必然有损，这是 10 分制压到 5 星制的固有精度损失
 */
export function roundTripLossless(mode = 'step', custom = null) {
  const starSafe = previewTable(mode, custom).every((r) => r.back === r.douban);
  let scoreSafe = true;
  const collided = [];
  for (let n = 1; n <= 10; n++) {
    const stars = bgmToDouban(n, mode, custom);
    const back = doubanToBgm(stars, mode, custom);
    if (back !== n) {
      scoreSafe = false;
      collided.push({ from: n, to: stars, back });
    }
  }
  return { starSafe, scoreSafe, collided };
}

/**
 * 把设置里的评分配置打包成统一的换算上下文，避免各调用点漏传自定义表
 * @param {object} settings
 */
export function ratingContext(settings = {}) {
  const mode = RATING_MODES.includes(settings.ratingMode) ? settings.ratingMode : 'step';
  return { mode, custom: normalizeCustomMap(settings.customRatingMap) };
}
