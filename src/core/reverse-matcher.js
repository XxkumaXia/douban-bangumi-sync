// 反向匹配：Bangumi 条目 -> 豆瓣条目
//
// 正向匹配（matcher.js）解决的是「豆瓣有、Bangumi 没有」——拿豆瓣标题去 Bangumi 搜。
// 这里解决反过来的方向：「Bangumi 有收藏、豆瓣列表里找不到」的孤儿条目。
// 这类条目以前只能逐条点「搜豆瓣」人工补，量一大就没法处理，所以做成可批量跑的。
//
// 搜索函数由调用方注入（service-worker 传 searchDoubanSubject），
// 因为豆瓣搜索要用到 chrome 的 fetch + offscreen 解析，本模块保持可独立测试。
import { titleScore, extractYear, normalizeTitle, splitTitleParts } from '../lib/strutil.js';

/** Bangumi 分类 -> 该去哪个豆瓣站点搜 */
export function categoryToSite(category) {
  if (category === 'book') return 'book';
  if (category === 'music') return 'music';
  // 动画 / 三次元 / 游戏在豆瓣都落在影视站
  return 'movie';
}

/**
 * 选搜索关键词：中文名优先，其次主标题，最后原名
 * 拿中文名搜豆瓣命中率最高（豆瓣条目名以中文为主）
 */
export function pickReverseKeyword(bgm) {
  const cn = /[\u4e00-\u9fa5]/.test(bgm?.title || '') ? bgm.title : '';
  return String(cn || bgm?.title || bgm?.originalTitle || '').trim();
}

/** 豆瓣搜索结果 -> 归一化候选（拆出主标题与原名，便于分别比对） */
export function normalizeDoubanCandidate(cand) {
  const { mainTitle, originalTitle } = splitTitleParts(cand?.title);
  return {
    id: String(cand.id ?? '').trim(),
    title: String(cand.title || '').trim(),
    mainTitle,
    originalTitle,
    year: Number(cand.year) || extractYear(cand.title) || extractYear(cand.intro) || null,
    url: cand.url || '',
    intro: String(cand.intro || '').slice(0, 200),
  };
}

/**
 * Bangumi 条目与一个豆瓣候选的匹配得分 0..1
 * 关键在于把两边的标题都拆成「主标题 / 原名」再交叉比对，
 * 否则 "进击的巨人 最终季 / 進撃の巨人 The Final Season" 这种会被原名稀释成低分。
 */
export function scoreDoubanCandidate(bgm, cand) {
  const c = normalizeDoubanCandidate(cand);

  const candTitles = [c.mainTitle, c.originalTitle, c.title].filter(Boolean);
  const bgmTitles = [bgm?.title, bgm?.originalTitle].filter(Boolean);

  let best = 0;
  for (const s of bgmTitles) {
    for (const t of candTitles) {
      best = Math.max(best, titleScore(s, t));
    }
  }

  // 年份校验：完全一致加分，差 2 年以上明显减分
  const by = Number(bgm?.year) || null;
  if (by && c.year) {
    const diff = Math.abs(by - c.year);
    if (diff === 0) best += 0.04;
    else if (diff === 1) best += 0.01;
    else if (diff === 2) best -= 0.06;
    else best -= 0.2;
  }

  // 类型一致性：豆瓣搜索结果的 intro 里常带「动画」等类型词
  if (c.intro && bgm?.category) {
    const wantAnime = bgm.category === 'anime';
    const looksAnime = /动画/.test(c.intro);
    if (wantAnime && looksAnime) best += 0.03;
    else if (!wantAnime && /纪录|真人|综艺|电视剧/.test(c.intro)) best += 0.03;
  }

  // 归一化后完全相等，直接认定命中
  if (
    bgmTitles.some((s) => {
      const ns = normalizeTitle(s);
      return ns && candTitles.some((t) => ns === normalizeTitle(t));
    })
  ) {
    best = Math.max(best, 0.95);
  }

  return Math.max(0, Math.min(1, best));
}

/**
 * 为一个 Bangumi 孤儿条目求解对应的豆瓣条目
 * @param {object} bgm 归一化后的 Bangumi 记录（需 title / originalTitle / year / category / subjectId）
 * @param {object} settings
 * @param {{searchDouban: Function}} deps 注入的搜索实现
 * @returns {Promise<{status:'matched'|'candidate'|'unmatched', douban?, confidence?, candidates?, reason?}>}
 */
export async function resolveReverse(bgm, settings, deps = {}) {
  const { searchDouban } = deps;
  if (typeof searchDouban !== 'function') {
    return { status: 'unmatched', reason: '未提供搜索实现' };
  }

  const keyword = pickReverseKeyword(bgm);
  if (!keyword) return { status: 'unmatched', reason: '标题为空，无法搜索' };
  if (!bgm?.subjectId) return { status: 'unmatched', reason: '缺少 Bangumi subjectId' };

  const site = categoryToSite(bgm.category);

  let items = [];
  try {
    const r = await searchDouban({ keyword, site });
    items = r?.items || [];
  } catch (e) {
    return { status: 'unmatched', reason: `搜索失败: ${e.message}` };
  }
  if (!items.length) return { status: 'unmatched', reason: '豆瓣没搜到候选' };

  const scored = items
    .map((c) => ({ c, score: scoreDoubanCandidate(bgm, c) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const auto = settings?.autoAcceptThreshold ?? 0.82;
  const cand = settings?.candidateThreshold ?? 0.45;
  const shape = (s) => ({
    id: String(s.c.id),
    title: s.c.title,
    year: normalizeDoubanCandidate(s.c).year,
    url: s.c.url,
    score: s.score,
  });

  if (best.score >= auto) {
    return {
      status: 'matched',
      douban: shape(best),
      confidence: best.score,
      reason: '自动反查匹配',
      candidates: scored.slice(0, 5).map(shape),
    };
  }
  if (best.score >= cand) {
    return {
      status: 'candidate',
      douban: shape(best),
      confidence: best.score,
      reason: '置信度不足，需要人工确认',
      candidates: scored.slice(0, 8).map(shape),
    };
  }
  return {
    status: 'unmatched',
    confidence: best.score,
    reason: `最高置信度 ${best.score.toFixed(2)} 低于阈值 ${cand}`,
    candidates: scored.slice(0, 3).map(shape),
  };
}
