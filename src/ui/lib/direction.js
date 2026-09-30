/**
 * 同步面板的方向判定逻辑。
 *
 * 单独放在这里是为了能单测 —— sync.js 顶层会跑 installErrorGuard()，
 * 在 node 里直接 import 会因为拿不到 window 而崩。纯逻辑不掺副作用。
 */

/**
 * 一组 diffs 当前应显示成什么方向。
 *
 * @param {Array<{selected:boolean, direction:string|null}>} diffs
 * @returns {'toBgm'|'toDouban'|'mixed'|'none'}
 *
 * 坑（踩过）：原来是 `diffs.filter(x => x.selected).map(...).every(...)`，
 * 「跳过」把 selected 全置 false 后数组变空，而**空数组的 every() 恒为 true**，
 * 于是「已跳过」被显示成「豆瓣 → Bangumi」高亮。数据没坏，界面却在骗人。
 * 所以必须先判长度，再比较。
 */
export function currentDirection(diffs) {
  const selected = (diffs || []).filter((x) => x.selected);
  if (!selected.length) return 'none';
  const dirs = selected.map((x) => x.direction);
  if (dirs.every((x) => x === 'toBgm')) return 'toBgm';
  if (dirs.every((x) => x === 'toDouban')) return 'toDouban';
  return 'mixed';
}

/**
 * 这条「匹配完之后本来该往哪边同步」—— 取的是原始建议（diff.suggested），
 * 不是当前界面上的方向。批量「只选 豆瓣→Bangumi」按它筛。
 *
 * @param {Array<{suggested?:string|null, direction?:string|null}>} diffs
 * @returns {'toBgm'|'toDouban'|'mixed'|'none'}
 */
export function suggestedDirection(diffs) {
  const dirs = (diffs || [])
    .map((x) => (x.suggested !== undefined ? x.suggested : x.direction))
    .filter(Boolean);
  if (!dirs.length) return 'none';
  if (dirs.every((x) => x === 'toBgm')) return 'toBgm';
  if (dirs.every((x) => x === 'toDouban')) return 'toDouban';
  return 'mixed';
}
