// 差异对比：把两侧的收藏列表配成对，逐字段算出需要同步什么、往哪个方向同步
import { timeValue, STATUS_LABEL, makeItem } from './normalize.js';

export const FIELD_LABEL = {
  status: '状态',
  rating: '评分',
  comment: '评价',
  tags: '标签',
};

// 状态推进度，用于时间不可比时的兜底判断
const STATUS_RANK = { wish: 1, doing: 2, done: 3 };

/**
 * 生成同步计划
 * @param {Array} doubanItems
 * @param {Array} bgmItems
 * @param {object} mapping  { [doubanId]: {subjectId, mode, ...} }
 * @param {object} settings
 * @returns {Array} pairs
 */
export function buildPlan(doubanItems, bgmItems, mapping, settings) {
  const enabledFields = {
    status: !!settings.syncStatus,
    rating: !!settings.syncRating,
    comment: !!settings.syncComment,
    tags: !!settings.syncTags,
  };
  const allowClear = !!settings.allowClear;

  const bgmById = new Map();
  for (const b of bgmItems) bgmById.set(b.subjectId, b);

  // 映射表里已经指向的 Bangumi 条目：不能再被算作「Bangumi 独有」
  const mappedSubjectIds = new Set(
    Object.values(mapping || {})
      .filter((m) => m?.subjectId && m.mode !== 'skip')
      .map((m) => Number(m.subjectId))
  );

  // 豆瓣条目 -> Bangumi subjectId
  const linkOf = (dItem) => {
    const m = mapping[dItem.id];
    return m?.subjectId ? Number(m.subjectId) : null;
  };

  const pairs = [];
  const usedBgm = new Set();

  for (const d of doubanItems) {
    const sid = linkOf(d);
    const b = sid != null ? bgmById.get(sid) || null : null;
    if (b) usedBgm.add(b.subjectId);

    const pair = {
      key: d.id,
      douban: d,
      bangumi: b,
      subjectId: sid,
      match: null,
      diffs: [],
      flags: [],
    };

    if (!b) {
      pair.flags.push(sid == null ? 'unmatched' : 'missing-in-bangumi');
      // 目标侧还没有这条收藏：整条新增过去（注意不能走 buildFullDiffs，那边以「两边都有值」为前提）
      if (sid != null) {
        pair.diffs = buildCreateDiffs(d, 'toBgm', enabledFields);
      }
    } else {
      pair.diffs = buildFullDiffs(d, b, enabledFields, allowClear, decideDirection(d, b, settings));
    }
    pairs.push(pair);
  }

  // Bangumi 上有、但没和任何豆瓣条目配上的
  for (const b of bgmItems) {
    if (usedBgm.has(b.subjectId) || mappedSubjectIds.has(b.subjectId)) continue;
    const pair = {
      key: b.id,
      douban: null,
      bangumi: b,
      subjectId: b.subjectId,
      match: null,
      diffs: [],
      flags: ['missing-in-douban'],
    };
    pairs.push(pair);
  }

  // 映射表里记录了豆瓣条目、但豆瓣当前没有收藏（属于「新增到豆瓣」场景）
  const doubanKeys = new Set(doubanItems.map((d) => d.id));
  for (const [doubanId, m] of Object.entries(mapping || {})) {
    if (!m?.subjectId || m.mode === 'skip') continue;
    if (doubanKeys.has(doubanId)) continue;
    const b = bgmById.get(Number(m.subjectId));
    if (!b || usedBgm.has(b.subjectId)) continue;
    usedBgm.add(b.subjectId);

    const subjectId = String(doubanId).replace(/^douban:/, '');
    const site = m.site || 'movie';
    const ghost = makeItem({
      source: 'douban',
      id: doubanId,
      title: m.nameCn || m.name || b.title || '',
      year: b.year,
      category: b.category,
      status: null,
      rating: 0,
      comment: '',
      tags: [],
      updatedAt: null,
      url: `https://${site}.douban.com/subject/${subjectId}/`,
      doubanSite: site,
    });

    const diffs = buildCreateDiffs(b, 'toDouban', enabledFields);

    pairs.push({
      key: doubanId,
      douban: ghost,
      bangumi: b,
      subjectId: Number(m.subjectId),
      match: { status: 'matched', confidence: m.confidence ?? 1, reason: '映射表（豆瓣侧尚无收藏）' },
      diffs,
      flags: ['douban-not-collected'],
    });
  }

  return pairs;
}

/** 逐字段比较 */
function buildFullDiffs(d, b, enabledFields, allowClear, defaultDirection) {
  const out = [];

  // 状态
  if (enabledFields.status) {
    const dv = d?.status || null;
    const bv = b?.status || null;
    if (dv && bv && dv !== bv) {
      out.push(makeDiff('status', dv, bv, defaultDirection));
    } else if (dv && !bv && b) {
      // 对方有记录但没状态（不该发生），按默认方向补
      out.push(makeDiff('status', dv, bv, defaultDirection || 'toBgm'));
    }
  }

  // 评分
  if (enabledFields.rating) {
    const dv = Number(d?.rating) || 0;
    const bv = Number(b?.rating) || 0;
    if (dv !== bv) {
      if (dv && !bv) {
        out.push(makeDiff('rating', dv, bv, 'toBgm'));
      } else if (!dv && bv) {
        if (allowClear) out.push(makeDiff('rating', dv, bv, 'toDouban', '豆瓣无评分，开启「允许清空」才会清除 Bangumi 评分'));
      } else if (dv && bv) {
        out.push(makeDiff('rating', dv, bv, defaultDirection));
      }
    }
  }

  // 评价（短评）
  if (enabledFields.comment) {
    const dv = (d?.comment || '').trim();
    const bv = (b?.comment || '').trim();
    if (dv !== bv) {
      if (dv && !bv) out.push(makeDiff('comment', dv, bv, 'toBgm'));
      else if (!dv && bv) {
        if (allowClear) out.push(makeDiff('comment', dv, bv, 'toDouban', '豆瓣无短评，开启「允许清空」才会清除 Bangumi 短评'));
      } else out.push(makeDiff('comment', dv, bv, defaultDirection));
    }
  }

  // 标签
  if (enabledFields.tags) {
    const dv = (d?.tags || []).slice().sort();
    const bv = (b?.tags || []).slice().sort();
    if (dv.join('|') !== bv.join('|')) {
      if (dv.length && !bv.length) out.push(makeDiff('tags', dv, bv, 'toBgm'));
      else if (!dv.length && bv.length) {
        if (allowClear) out.push(makeDiff('tags', dv, bv, 'toDouban', '豆瓣无标签'));
      } else out.push(makeDiff('tags', dv, bv, defaultDirection));
    }
  }

  return out;
}

/**
 * 「目标侧还没有这条记录」时用的差异构造：把源侧所有启用的字段整条推过去
 * @param {object} item 源侧记录（归一化）
 * @param {'toBgm'|'toDouban'} dir
 */
function buildCreateDiffs(item, dir, enabledFields) {
  const out = [];
  // dir 决定源侧的值该落在哪一列，另一列留空
  const mk = (field, value) =>
    dir === 'toBgm' ? makeDiff(field, value, null, dir) : makeDiff(field, null, value, dir);
  if (enabledFields.status && item.status) out.push(mk('status', item.status));
  if (enabledFields.rating && item.rating) out.push(mk('rating', item.rating));
  if (enabledFields.comment && item.comment) out.push(mk('comment', item.comment));
  if (enabledFields.tags && item.tags?.length) out.push(mk('tags', item.tags));
  return out;
}

function makeDiff(field, doubanValue, bangumiValue, direction, note) {
  return {
    field,
    label: FIELD_LABEL[field],
    doubanValue: formatValue(field, doubanValue),
    bangumiValue: formatValue(field, bangumiValue),
    rawDouban: doubanValue,
    rawBangumi: bangumiValue,
    direction,
    // 匹配完之后「本来就该怎么同步」的原始建议，之后无论用户怎么改方向/勾选都不变。
    // 存在的理由：批量选择要按原始建议来筛（「只选 豆瓣→Bangumi」= 选出本来就该往那边走的），
    // 而一旦用户在界面上改过方向，direction 就不是建议了 —— 没有这份快照就筛不出来。
    suggested: direction,
    note: note || '',
    selected: direction != null,
  };
}

function formatValue(field, v) {
  if (field === 'status') return STATUS_LABEL[v] || v || '—';
  if (field === 'rating') return v ? `${v} 星` : '未评分';
  if (field === 'tags') return Array.isArray(v) && v.length ? v.join('、') : '无';
  if (field === 'comment') return v ? String(v) : '无';
  return v;
}

/** 两侧都有记录时，决定默认同步方向 */
function decideDirection(d, b, settings) {
  const policy = settings.conflictPolicy || 'newer';
  if (policy === 'douban') return 'toBgm';
  if (policy === 'bangumi') return 'toDouban';
  if (policy === 'manual') return null;

  // newer：比更新时间
  const dt = timeValue(d.updatedAt);
  const bt = timeValue(b.updatedAt);
  if (dt || bt) {
    if (dt === bt) return null;
    return dt > bt ? 'toBgm' : 'toDouban';
  }
  // 时间都拿不到，退回「状态更靠后的那侧为准」
  const dr = STATUS_RANK[d.status] || 0;
  const br = STATUS_RANK[b.status] || 0;
  if (dr !== br) return dr > br ? 'toBgm' : 'toDouban';
  return null;
}

/** 汇总统计 */
export function summarize(pairs) {
  const s = {
    total: pairs.length,
    matched: 0,
    unmatched: 0,
    needConfirm: 0,
    toBgm: 0,
    toDouban: 0,
    manual: 0,
    noDiff: 0,
  };
  for (const p of pairs) {
    if (p.flags.includes('unmatched')) s.unmatched++;
    else if (p.bangumi || p.subjectId) s.matched++;
    if (p.flags.includes('unmatched') && !p.subjectId) s.needConfirm++;
    const dirs = p.diffs.filter((x) => x.selected).map((x) => x.direction);
    if (!p.diffs.length) s.noDiff++;
    else if (dirs.includes('toBgm')) s.toBgm++;
    else if (dirs.includes('toDouban')) s.toDouban++;
    else s.manual++;
  }
  return s;
}
