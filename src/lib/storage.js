// 持久化：设置、条目映射表、同步快照、日志

const KEY_SETTINGS = 'settings';
const KEY_MAPPING = 'mapping'; // { [doubanId]: { subjectId, title, nameCn, confidence, mode:'auto'|'manual'|'skip' } }
const KEY_SNAPSHOT = 'snapshot'; // 最近一次扫描结果
const KEY_LOG = 'log';

export const DEFAULT_SETTINGS = {
  // Bangumi
  bgmAccessToken: '',
  bgmRefreshToken: '',
  bgmExpiresAt: 0,
  bgmUsername: '',
  bgmUserId: '', // 数字 uid，收藏列表页链接优先用它（中文昵称作 URL 标识会失效）
  bgmClientId: '',
  bgmClientSecret: '',
  // 豆瓣
  doubanUid: '', // 留空则解析 /mine 页面自动识别
  // 同步字段开关
  syncStatus: true,
  syncRating: true,
  syncComment: false, // 默认关：短评属于个人表达，误写不可逆，需用户显式开启
  syncTags: false,
  // 分类开关：默认动画 + 三次元
  categories: {
    anime: true,
    real: true,
    book: false,
    music: false,
    game: false,
  },
  // 豆瓣站点开关
  doubanSites: {
    movie: true,
    book: false,
    music: false,
  },
  // 冲突策略: 'newer' 以更新时间较新的为准 | 'manual' 全部手动 | 'douban' 一律以豆瓣为准 | 'bangumi' 一律以 Bangumi 为准
  conflictPolicy: 'newer',
  // 评分换算模式: 'step' 阶梯 | 'linear' 线性 | 'custom' 自定义
  ratingMode: 'step',
  // 自定义换算表：索引 0..4 对应 1★~5★，值为 Bangumi 1-10 分。只在 ratingMode='custom' 时生效
  customRatingMap: [2, 4, 6, 8, 10],
  // 允许用空值覆盖有值（清空对方评分/短评），默认关闭
  allowClear: false,
  // 写入豆瓣时，目标状态不是「看过」就先不写评分（可选项，默认关）。
  // 曾经默认开过，理由是「豆瓣只让看过打分，带 rating 会把在看升级成看过」——
  // 但那是我根据现象推的，没有实测依据，而用户在豆瓣实测「在看」是可以打分的。
  // 既然没有证据，就不该默认替用户丢数据：现在改成默认关，需要的人自己在设置页打开。
  doubanRatingOnlyWhenDone: false,
  // 「一键同步」这类没有逐条界面的路径，写入豆瓣时是否顺带分享到豆瓣广播。
  // 默认关闭：广播会推给关注者，误发不可逆。
  // 同步面板不走这里 —— 那里是逐条勾选（pairs[].shareBroadcast），默认也是不分享。
  shareToBroadcast: false,
  // 从豆瓣收藏弹窗里实测到的「分享到广播」字段（豆瓣无公开文档，靠读它自己的弹窗HTML得到）。
  // 形如 { name, value, via }；为 null 表示还没探测过或没识别出来
  doubanShareField: null,
  // 自动匹配接受阈值
  autoAcceptThreshold: 0.82,
  // 低于此分不放进待确认列表，直接跳过
  candidateThreshold: 0.45,
  // 每次写入之间的间隔毫秒，防止触发风控
  writeDelayMs: 1200,
  // 抓取分页间隔毫秒
  readDelayMs: 800,
  // 豆瓣写入策略顺序
  doubanWriteStrategy: 'auto',
  // 豆瓣写入通道: 'auto' 先后台请求、失败再注入标签页 | 'background' 只用后台 | 'tab' 只注入标签页
  doubanWriteChannel: 'auto',
  // 最大抓取条数（每站每状态），0 为不限
  maxItemsPerList: 0,
};

export async function getSettings() {
  const obj = await chrome.storage.local.get(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(obj[KEY_SETTINGS] || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [KEY_SETTINGS]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [KEY_SETTINGS]: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS };
}

export async function getMapping() {
  const obj = await chrome.storage.local.get(KEY_MAPPING);
  return obj[KEY_MAPPING] || {};
}

export async function saveMapping(mapping) {
  await chrome.storage.local.set({ [KEY_MAPPING]: mapping });
}

export async function upsertMapping(doubanId, entry) {
  const m = await getMapping();
  m[String(doubanId)] = entry;
  await saveMapping(m);
  return m;
}

export async function clearMapping() {
  await chrome.storage.local.remove(KEY_MAPPING);
}

export async function getSnapshot() {
  const obj = await chrome.storage.local.get(KEY_SNAPSHOT);
  return obj[KEY_SNAPSHOT] || null;
}

export async function saveSnapshot(snap) {
  await chrome.storage.local.set({ [KEY_SNAPSHOT]: snap });
}

export async function clearSnapshot() {
  await chrome.storage.local.remove(KEY_SNAPSHOT);
}

export async function appendLog(lines) {
  if (!Array.isArray(lines)) lines = [lines];
  const obj = await chrome.storage.local.get(KEY_LOG);
  const cur = obj[KEY_LOG] || [];
  const stamp = new Date().toISOString();
  const next = cur.concat(
    lines.map((l) => (typeof l === 'string' ? { t: stamp, msg: l } : { t: stamp, ...l }))
  );
  await chrome.storage.local.set({ [KEY_LOG]: next.slice(-800) });
  return next;
}

export async function getLog() {
  const obj = await chrome.storage.local.get(KEY_LOG);
  return obj[KEY_LOG] || [];
}

export async function clearLog() {
  await chrome.storage.local.remove(KEY_LOG);
}

export async function clearAll() {
  await chrome.storage.local.remove([KEY_MAPPING, KEY_SNAPSHOT, KEY_LOG]);
}

/** 估算已用存储（字节） */
export async function usageBytes() {
  return new Promise((resolve) => {
    if (chrome.storage.local.getBytesInUse) {
      chrome.storage.local.getBytesInUse(null, resolve);
    } else {
      resolve(0);
    }
  });
}
