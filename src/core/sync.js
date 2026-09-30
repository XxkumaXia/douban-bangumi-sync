// 同步执行引擎：把差异计划落地到两边
import * as bgm from '../adapters/bangumi.js';
import * as db from '../adapters/douban.js';
import { doubanToBgm } from './rating.js';
import { STATUS_LABEL } from './normalize.js';
import { upsertMapping } from '../lib/storage.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 执行同步计划
 * @param {Array} pairs buildPlan 的产物（diffs[].selected 决定要不要执行）
 * @param {object} settings
 * @param {object} opts { dryRun, onProgress, signal, onLog }
 */
export async function executePlan(pairs, settings, opts = {}) {
  const { dryRun = false, onProgress, onLog, signal } = opts;
  const delay = settings.writeDelayMs ?? 1200;
  const results = [];
  let done = 0;

  for (const pair of pairs) {
    if (signal?.aborted) break;
    const todo = pair.diffs.filter((d) => d.selected && d.direction);
    if (!todo.length) {
      done++;
      continue;
    }
    const todoBgm = todo.filter((d) => d.direction === 'toBgm');
    const todoDouban = todo.filter((d) => d.direction === 'toDouban');
    const entry = { key: pair.key, title: pair.douban?.title || pair.bangumi?.title || '', results: [] };

    if (todoBgm.length && pair.subjectId) {
      entry.results.push(await writeBgm(pair, todoBgm, settings, dryRun));
    }
    if (todoDouban.length && pair.douban) {
      entry.results.push(await writeDouban(pair, todoDouban, settings, dryRun));
    }

    // 回读发现状态对不上：这是「我们以为写对了、其实没写对」的唯一证据，
    // 必须落到日志里，否则事后根本无从查起
    for (const r of entry.results) {
      if (r?.statusMismatch) {
        onLog?.(
          `状态校验不符：${entry.title} 期望 ${STATUS_LABEL[r.request?.status] || r.request?.status}，` +
            `豆瓣回读为 ${STATUS_LABEL[r.verify?.status] || r.verify?.rawStatus || '未知'}`
        );
      }
    }

    results.push(entry);
    done++;
    onProgress?.({ done, total: pairs.length, entry });
    if (!dryRun && delay) await sleep(delay);
  }

  return { results, aborted: !!signal?.aborted };
}

async function writeBgm(pair, diffs, settings, dryRun) {
  const payload = {};
  const pick = (field) => diffs.find((d) => d.field === field);
  const statusDiff = pick('status');
  const ratingDiff = pick('rating');
  const commentDiff = pick('comment');
  const tagsDiff = pick('tags');

  // 目标侧现有值兜底，避免 Bangumi 把没指定的字段清掉。
  //
  // 注意别再兜底成 'done'（以前是 `cur?.status || 'done'`，而 'done' 就是「看过」）：
  // 用户只想同步标签时，一条 Bangumi 记录会被莫名其妙地标成看过。
  // 取不到就如实传 'unknown'，让 bangumi.js 那边明确报错，而不是偷偷写个错的。
  const cur = pair.bangumi;
  payload.status = statusDiff ? statusDiff.rawDouban : cur?.status || pair.douban?.status || 'unknown';
  payload.ratingStars = ratingDiff ? Number(ratingDiff.rawDouban) : Number(cur?.rating) || 0;
  payload.comment = commentDiff ? commentDiff.rawDouban : cur?.comment || '';
  payload.tags = tagsDiff ? tagsDiff.rawDouban || [] : cur?.tags || [];

  const body = {
    subjectId: pair.subjectId,
    status: payload.status,
    ratingStars: payload.ratingStars,
    comment: payload.comment,
    tags: payload.tags,
    ratingMode: settings.ratingMode || 'step',
    customRatingMap: settings.customRatingMap,
  };

  if (dryRun) {
    return {
      target: 'bangumi',
      ok: true,
      dryRun: true,
      request: {
        method: 'POST',
        url: `/v0/users/-/collections/${pair.subjectId}`,
        body,
        // 换算后的实际分值：演练时让用户能直接核对自定义表是否符合预期
        convertedRate: payload.ratingStars
          ? doubanToBgm(payload.ratingStars, settings.ratingMode, settings.customRatingMap)
          : 0,
      },
    };
  }
  try {
    await bgm.writeCollection(pair.subjectId, body);
    return { target: 'bangumi', ok: true, request: body };
  } catch (e) {
    return { target: 'bangumi', ok: false, error: e.message, request: body };
  }
}

async function writeDouban(pair, diffs, settings, dryRun) {
  const d = pair.douban;
  const pick = (field) => diffs.find((x) => x.field === field);
  const statusDiff = pick('status');
  const ratingDiff = pick('rating');
  const commentDiff = pick('comment');
  const tagsDiff = pick('tags');

  const site = d.doubanSite || 'movie';
  const subjectId = String(d.id).replace(/^douban:/, '');

  // 豆瓣 interest 接口每次都是全量提交，没变的字段用豆瓣侧现有值补上
  // 状态优先取 Bangumi 侧的真相：
  //   1. 有状态差异 → 用 Bangumi 的值（本次就是要把状态同步过去）
  //   2. 没差异但豆瓣已有记录 → 保留豆瓣现状，别动它（比如用户没勾「状态」时）
  //   3. 豆瓣连记录都没有（纯新增）→ 用 Bangumi 的值，整条本来就是从那边来的
  // 取不到就老实传 null，由 buildForm 明确报错，绝不猜成「看过」
  const targetStatus = statusDiff ? statusDiff.rawBangumi : d?.status || pair.bangumi?.status || null;

  // 可选项：目标状态不是「看过」时先不写评分（设置页「同步内容」里可开，默认关）。
  //
  // 这里曾经默认开启，理由是「豆瓣只让看过打分，带 rating 会把在看升级成看过」，
  // 用户在豆瓣实测「在看」是可以打分的，而那条因果链本来就没有实测依据 ——
  // 没有证据就不该默认替用户丢掉评分，所以改成默认关闭，需要的人自己开。
  let rating = ratingDiff ? Number(ratingDiff.rawBangumi) : Number(d.rating) || 0;
  let ratingNote = null;
  if (rating && targetStatus && targetStatus !== 'done' && settings.doubanRatingOnlyWhenDone === true) {
    ratingNote =
      `目标状态是「${STATUS_LABEL[targetStatus] || targetStatus}」，本次不写评分（原 ${rating} 星）：` +
      `已开启「只在看过时写评分」。评分要一起同步的话，到设置页关掉这个选项。`;
    rating = 0;
  }

  const args = {
    site,
    subjectId,
    status: targetStatus,
    rating,
    comment: commentDiff ? commentDiff.rawBangumi : d.comment || '',
    tags: tagsDiff ? tagsDiff.rawBangumi || [] : d.tags || [],
    // 分享到广播：逐条优先（同步面板里每条可以单独勾），没给就用设置里的默认值
    share: pair.shareBroadcast ?? !!settings.shareToBroadcast,
  };

  if (dryRun) {
    // 演练也要走真实的请求构造流程：拿到 ck、列出各条备选通道的实际 URL 与表单、
    // 并静态检查一遍。writeInterest 内部保证 dryRun 时一次 POST 都不发。
    //
    // 以前这里是直接短路、只返回抽象的 args，结果演练里根本看不到真实 URL/表单，
    // 「分享到广播」也永远显示不出状态 —— 演练看不到东西就等于没演练。
    try {
      const out = await db.writeInterest(args, {
        dryRun: true,
        strategy: settings.doubanWriteStrategy || 'auto',
      });
      return {
        target: 'douban',
        ok: true,
        dryRun: true,
        attempts: out.attempts,
        share: out.share,
        ratingNote,
        request: { site, subjectId, args },
      };
    } catch (e) {
      // 连请求都构造不出来（绝大多数是取不到 ck）—— 这本身就是最重要的演练结论，
      // 必须原样报出来，不能悄悄当成成功。
      return {
        target: 'douban',
        ok: false,
        dryRun: true,
        error: e.message,
        ratingNote,
        request: { site, subjectId, args },
      };
    }
  }
  try {
    const out = await db.writeInterest(args, { strategy: settings.doubanWriteStrategy || 'auto' });
    const res = {
      target: 'douban',
      ok: out.ok,
      used: out.used,
      error: out.ok ? null : JSON.stringify(out.attempts),
      share: out.share,
      ratingNote,
      request: args,
    };
    // 写完回读一次：豆瓣「返回成功」和「真的写对了」是两回事。
    // 尤其状态 —— 用户报的「在看被同步成看过」只有回读才看得出来到底是我们发错了值，
    // 还是豆瓣自己改的。校验不符时不假装成功，明确报出来。
    if (out.ok && targetStatus) {
      try {
        const v = await db.verifyInterest(site, subjectId);
        res.verify = v;
        res.statusMismatch = !!v?.status && v.status !== targetStatus;
      } catch (e) {
        res.verify = { ok: false, reason: e.message };
      }
    }
    return res;
  } catch (e) {
    return { target: 'douban', ok: false, error: e.message, ratingNote, request: args };
  }
}

/** 把整条 pair 的方向统一改成 dir（'toBgm' | 'toDouban' | null 表示跳过） */
/** 原始建议方向：匹配完就定下来了，界面上怎么改都不影响它 */
export function suggestionOf(d) {
  return d.suggested !== undefined ? d.suggested : d.direction;
}

export function setPairDirection(pair, dir) {
  for (const d of pair.diffs) {
    if (dir === null) {
      d.selected = false;
    } else {
      d.direction = dir;
      d.selected = true;
    }
  }
  return pair;
}

/**
 * 只勾选「本来就该往 dir 方向同步」的字段，其余取消勾选。
 *
 * 与 setPairDirection 的区别很关键：那个是**改写**整条的方向（会把原本该反向的字段也掰过去），
 * 这个是**筛选** —— 按匹配结果的原始建议挑出来，不匹配的不动方向、只是不勾选。
 * 用户要的「全部 豆瓣→Bangumi = 选中所有原本该由豆瓣→Bangumi 的」就是这一个。
 *
 * @returns {number} 勾选上的字段数
 */
export function selectBySuggestion(pair, dir) {
  let n = 0;
  for (const d of pair.diffs) {
    if (suggestionOf(d) === dir) {
      d.direction = dir;
      d.selected = true;
      n++;
    } else {
      // 只取消勾选，方向原样留着 —— 「取消选择」不该顺手改掉匹配结果
      d.selected = false;
    }
  }
  return n;
}

/**
 * 全选 / 取消全选：只动勾选，一个方向都不改。
 * 全选时没有方向的字段（需要手动定方向）保持不勾 —— 勾了同步时也不会执行，属误导。
 */
export function setPairSelected(pair, on) {
  for (const d of pair.diffs) d.selected = !!on && !!d.direction;
  return pair;
}

/** 匹配结果写回映射表 */
export async function persistMatch(doubanId, subject, confidence) {
  await upsertMapping(doubanId, {
    subjectId: Number(subject.id),
    name: subject.name || '',
    nameCn: subject.name_cn || '',
    category: subject.category || '',
    confidence,
    mode: 'auto',
    updatedAt: Date.now(),
  });
}

/** 人工指定映射 */
export async function persistManualMatch(doubanId, subject) {
  await upsertMapping(doubanId, {
    subjectId: Number(subject.id),
    name: subject.name || '',
    nameCn: subject.name_cn || '',
    category: subject.category || '',
    confidence: 1,
    mode: 'manual',
    updatedAt: Date.now(),
  });
}

export async function persistSkip(doubanId) {
  await upsertMapping(doubanId, { mode: 'skip', updatedAt: Date.now() });
}

export { doubanToBgm };
