// 条目匹配：豆瓣条目 -> Bangumi subject
// 三级：映射表缓存(精确) > 搜索候选打分 > 人工确认
import { searchSubjects } from '../adapters/bangumi.js';
import { titleScore, extractYear, splitTitleParts, toHalfWidth } from '../lib/strutil.js';
import { BGM_SUBJECT_TYPE_REVERSE } from './normalize.js';

/** 豆瓣分类 -> 允许匹配的 Bangumi subject_type */
function targetSubjectTypes(category) {
  switch (category) {
    case 'anime':
      return [2, 6]; // 动画优先，也允许落到三次元（真人剧场版）
    case 'real':
      return [6, 2];
    case 'book':
      return [1];
    case 'music':
      return [3];
    case 'game':
      return [4];
    default:
      return [2, 6];
  }
}

/**
 * 对一个豆瓣条目求解 Bangumi 对应条目
 * @returns {Promise<{status:'matched'|'candidate'|'unmatched'|'skipped', subject?, confidence?, candidates?, reason?}>}
 */
export async function resolve(item, mapping, settings) {
  // 1) 缓存映射
  const cached = mapping[item.id];
  if (cached?.mode === 'skip') {
    return { status: 'skipped', reason: '已在映射表中标记为跳过' };
  }
  if (cached?.subjectId && cached.mode === 'manual') {
    return {
      status: 'matched',
      subject: {
        id: cached.subjectId,
        name: cached.name || '',
        name_cn: cached.nameCn || '',
        url: `https://bgm.tv/subject/${cached.subjectId}`,
        category: cached.category || item.category,
      },
      confidence: 1,
      reason: '人工确认过的映射',
    };
  }
  if (cached?.subjectId && cached.mode === 'auto') {
    return {
      status: 'matched',
      subject: {
        id: cached.subjectId,
        name: cached.name || '',
        name_cn: cached.nameCn || '',
        url: `https://bgm.tv/subject/${cached.subjectId}`,
        category: cached.category || item.category,
      },
      confidence: cached.confidence ?? 0.9,
      reason: '缓存的自动匹配',
    };
  }

  // 2) 搜索
  const types = targetSubjectTypes(item.category);
  const keyword = pickKeyword(item);
  if (!keyword) return { status: 'unmatched', reason: '标题为空，无法搜索' };

  let list = [];
  try {
    list = await searchSubjects(keyword, types);
  } catch (e) {
    return { status: 'unmatched', reason: `搜索失败: ${e.message}` };
  }
  if (!list.length) {
    // 放宽到不带类型过滤再搜一次
    try {
      list = await searchSubjects(keyword, []);
    } catch {
      list = [];
    }
  }
  if (!list.length) return { status: 'unmatched', reason: 'Bangumi 上没有搜索到候选' };

  const scored = list
    .map((c) => ({ c, score: scoreCandidate(item, c) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const auto = settings.autoAcceptThreshold ?? 0.82;
  const cand = settings.candidateThreshold ?? 0.45;

  if (best.score >= auto) {
    return {
      status: 'matched',
      subject: best.c,
      confidence: best.score,
      reason: '自动匹配',
      candidates: scored.slice(0, 5).map((s) => ({ ...s.c, score: s.score })),
    };
  }
  if (best.score >= cand) {
    return {
      status: 'candidate',
      subject: best.c,
      confidence: best.score,
      reason: '置信度不足，需要人工确认',
      candidates: scored.slice(0, 8).map((s) => ({ ...s.c, score: s.score })),
    };
  }
  return {
    status: 'unmatched',
    confidence: best.score,
    reason: `最高置信度 ${best.score.toFixed(2)} 低于阈值 ${cand}`,
    candidates: scored.slice(0, 3).map((s) => ({ ...s.c, score: s.score })),
  };
}

export function pickKeyword(item) {
  // 豆瓣标题常写成「中文名 / 原名」一整串，拿整串去 Bangumi 搜会把原名也塞进关键词，
  // 召回反而不准（这也是「明明有这条却搜不到」的常见原因）。先拆出主标题。
  const parts = splitTitleParts(item.title);
  const main = parts.mainTitle || '';
  // 中文主标题优先；没有中文就用原名
  const cn = /[\u4e00-\u9fa5]/.test(main) ? main : '';
  return (cn || main || item.title || item.originalTitle || '').trim();
}

/** 只去标点和空格，保留括号里的文字（「剧场版」这种区分信息不能被洗掉） */
function looseKey(s) {
  return toHalfWidth(s || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

export function scoreCandidate(item, cand) {
  // 两边标题都要拆成「主标题 / 原名」再交叉比对：
  // 豆瓣是「中文 / 原名」一整串，Bangumi 是 name_cn + name 两个字段，
  // 整串对整串算相似度会被另一半语言稀释，同一部作品也能打出低分。
  const dParts = splitTitleParts(item.title);
  const sources = [dParts.mainTitle, item.title, item.originalTitle, dParts.originalTitle].filter(Boolean);
  const bParts = splitTitleParts(cand.name_cn);
  const titles = [cand.name_cn, bParts.mainTitle, cand.name, bParts.originalTitle].filter(Boolean);

  let best = 0;
  for (const s of sources) {
    for (const t of titles) {
      best = Math.max(best, titleScore(s, t));
    }
  }

  // 年份校验。差 3 年以上基本是同名不同作品（老片翻新、同名著第二版），
  // 这种不能自动采纳 —— 压到候选区让用户自己看一眼
  let yearFar = false;
  const cy = extractYear(cand.date);
  if (item.year && cy) {
    const diff = Math.abs(item.year - cy);
    if (diff === 0) best += 0.04;
    else if (diff === 1) best += 0.01;
    else if (diff === 2) best -= 0.06;
    else {
      best -= 0.2;
      yearFar = true;
    }
  }

  // 类型一致性（豆瓣分类是猜的，权重压低）
  if (cand.category === item.category) best += 0.03;
  else best -= 0.04;

  // 完全相等直接拉满：中日任意一侧对上就算命中。
  // 用 looseKey 而不是 normalizeTitle —— 后者会连「剧场版」「第 X 季」一起洗掉，
  // 那会把不同的作品拉平成同一个（真人剧场版 vs TV 版就是这么被误判的）。
  if (sources.some((s) => { const k = looseKey(s); return k && titles.some((t) => k === looseKey(t)); })) {
    best = Math.max(best, 0.95);
  }

  // 年份差得离谱时，标题再像也不给自动采纳（0.82 阈值之上）—— 落到候选区等人确认
  if (yearFar) best = Math.min(best, 0.7);

  return Math.max(0, Math.min(1, best));
}

export { BGM_SUBJECT_TYPE_REVERSE };
