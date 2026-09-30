// Bangumi 适配器：基于官方 API v0，读写收藏、搜索条目
import {
  BGM_TYPE,
  BGM_TYPE_REVERSE,
  BGM_SUBJECT_TYPE,
  BGM_SUBJECT_TYPE_REVERSE,
  makeItem,
} from '../core/normalize.js';
import { bgmToDouban, doubanToBgm } from '../core/rating.js';
import { getSettings, saveSettings } from '../lib/storage.js';

const API = 'https://api.bgm.tv';
const OAUTH_BASE = 'https://bgm.tv/oauth';
const UA = 'DoubanBgmSync/0.1 (Chrome Extension)';

class BgmError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'BgmError';
    this.status = status;
    this.body = body;
  }
}

async function api(path, options = {}) {
  const settings = await getSettings();
  const token = settings.bgmAccessToken;
  if (!token) throw new BgmError('未配置 Bangumi Access Token，请到设置页填写', 0);

  const headers = {
    'User-Agent': UA,
    ...(options.headers || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.json !== undefined) headers['Content-Type'] = 'application/json';

  const init = {
    method: options.method || 'GET',
    headers,
    credentials: 'omit',
  };
  if (options.json !== undefined) init.body = JSON.stringify(options.json);
  if (options.body !== undefined) init.body = options.body;

  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg = data && (data.description || data.message || data.error_description) || text || res.statusText;
    throw new BgmError(`Bangumi API ${res.status}: ${msg}`, res.status, data);
  }
  return data;
}

/** 用 refresh_token 换新 token */
export async function refreshToken() {
  const s = await getSettings();
  if (!s.bgmRefreshToken || !s.bgmClientId || !s.bgmClientSecret) {
    throw new BgmError('缺少 refresh_token 或 client_id/client_secret，无法自动续期', 0);
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: s.bgmClientId,
    client_secret: s.bgmClientSecret,
    refresh_token: s.bgmRefreshToken,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  });
  const res = await fetch(`${OAUTH_BASE}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: body.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new BgmError(`刷新 token 失败 ${res.status}: ${data?.error_description || res.statusText}`, res.status, data);
  }
  await saveSettings({
    bgmAccessToken: data.access_token,
    bgmRefreshToken: data.refresh_token || s.bgmRefreshToken,
    bgmExpiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  });
  return data;
}

/** 带一次自动重试（token 过期时刷新再试）的请求 */
async function apiWithRetry(path, options = {}) {
  try {
    return await api(path, options);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      try {
        await refreshToken();
        return await api(path, options);
      } catch (e2) {
        throw e2;
      }
    }
    throw e;
  }
}

/** 当前登录用户信息 */
export async function getMe() {
  return apiWithRetry('/v0/me');
}

/**
 * 拉取用户收藏
 * @param {object} opts { types:number[] (collection type 1/2/3), subjectTypes:number[], limit, onProgress, max }
 */
export async function fetchCollections(opts = {}) {
  const s = await getSettings();
  const username = s.bgmUsername || (await getMe()).username;
  const subjectTypes = opts.subjectTypes?.length ? opts.subjectTypes : [1, 2, 3, 4, 6];
  const types = opts.types?.length ? opts.types : [1, 2, 3];
  const limit = opts.limit || 50;
  const out = [];
  const seen = new Set();

  for (const st of subjectTypes) {
    for (const ct of types) {
      let offset = 0;
      let total = Infinity;
      while (offset < total) {
        const data = await apiWithRetry(
          `/v0/users/${encodeURIComponent(username)}/collections?subject_type=${st}&type=${ct}&limit=${limit}&offset=${offset}`
        );
        const list = data?.data || [];
        total = data?.total ?? list.length;
        if (!list.length) break;
        for (const raw of list) {
          const sid = raw.subject_id ?? raw.subject?.id;
          if (sid == null || seen.has(sid)) continue;
          seen.add(sid);
          out.push(toItem(raw, st, s.ratingMode, s.customRatingMap));
        }
        offset += list.length;
        if (typeof opts.onProgress === 'function') {
          opts.onProgress({ source: 'bangumi', count: out.length, subjectType: st, type: ct });
        }
        if (opts.max && out.length >= opts.max) break;
        if (list.length < limit) break;
        await sleep(opts.delayMs ?? 250);
      }
      if (opts.max && out.length >= opts.max) break;
    }
    if (opts.max && out.length >= opts.max) break;
  }
  return out;
}

function toItem(raw, subjectTypeFallback, ratingMode = 'step', customRatingMap = null) {
  const sub = raw.subject || {};
  const subjectId = raw.subject_id ?? sub.id;
  const st = sub.type ?? raw.subject_type ?? subjectTypeFallback;
  const category = BGM_SUBJECT_TYPE[st] || 'real';
  const bgmRate = Number(raw.rate) || 0;
  return makeItem({
    source: 'bangumi',
    id: `bgm:${subjectId}`,
    subjectId: Number(subjectId),
    subjectType: Number(st),
    title: sub.name_cn || sub.name || '',
    originalTitle: sub.name || '',
    year: parseYear(sub.date || sub.air_date),
    category,
    status: BGM_TYPE[raw.type] || 'wish',
    // 统一到 0-5 星语义。必须跟随用户选的换算模式，否则 Bangumi→豆瓣 方向会与写入方向不一致，凭空产生差异
    rating: bgmToDouban(bgmRate, ratingMode, customRatingMap),
    rawRating: bgmRate,
    comment: raw.comment || '',
    tags: raw.tags || [],
    updatedAt: raw.updated_at || null,
    url: `https://bgm.tv/subject/${subjectId}`,
  });
}

function parseYear(d) {
  if (!d) return null;
  const m = String(d).match(/(19\d{2}|20\d{2})/);
  return m ? Number(m[1]) : null;
}

/**
 * 写入收藏
 * @param {object} item 归一化记录（目标为 Bangumi 侧的值）
 */
export async function writeCollection(
  subjectId,
  { status, ratingStars, comment, tags, ratingMode = 'step', customRatingMap = null }
) {
  // 以前这里写的是 `BGM_TYPE_REVERSE[status] ?? 2`，而 2 就是「看过」——
  // 一个认不出来的状态会被静默写成看过，用户的「在看」就这么没了，还查不出原因。
  // 状态是可以丢失/损坏的，但绝不能猜：认不出来就报错，让调用方看得见。
  const type = BGM_TYPE_REVERSE[status];
  if (type == null) {
    throw new Error(`写 Bangumi 失败：无法识别的收藏状态「${status}」（合法值：wish/doing/done）。本次未写入`);
  }
  const payload = { type };
  const bgmRate = doubanToBgm(ratingStars, ratingMode, customRatingMap);
  if (bgmRate) payload.rate = bgmRate;
  if (comment != null) payload.comment = comment;
  if (Array.isArray(tags) && tags.length) payload.tags = tags;

  // Bangumi 的 PATCH 对 rate 有已知问题，统一用 POST 全量覆盖
  return apiWithRetry(`/v0/users/-/collections/${subjectId}`, {
    method: 'POST',
    json: payload,
  });
}

/** 删除收藏（可选能力，暂不暴露给 UI） */
export async function deleteCollection(subjectId) {
  return apiWithRetry(`/v0/users/-/collections/${subjectId}`, { method: 'DELETE' });
}

/** 搜索条目，返回候选 */
export async function searchSubjects(keyword, subjectTypes = [2]) {
  const body = { keyword };
  if (subjectTypes?.length) body.filter = { type: subjectTypes };
  const data = await apiWithRetry('/v0/search/subjects', {
    method: 'POST',
    json: body,
  });
  const list = data?.data || [];
  return list.map((it) => ({
    id: it.id,
    name: it.name || '',
    name_cn: it.name_cn || '',
    date: it.date || '',
    type: it.type,
    category: BGM_SUBJECT_TYPE[it.type] || 'real',
    url: `https://bgm.tv/subject/${it.id}`,
    score: it.score ?? null,
    image: it.image || null,
  }));
}

/** 获取单个条目的当前收藏（用于写入后校验） */
export async function getCollection(subjectId) {
  try {
    const s = await getSettings();
    const raw = await apiWithRetry(`/v0/users/-/collections/${subjectId}`);
    return raw ? toItem(raw, raw.subject?.type, s.ratingMode, s.customRatingMap) : null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** 自检：验证 token 有效性 */
export async function checkAuth() {
  try {
    const me = await getMe();
    return { ok: true, username: me.username, nickname: me.nickname, id: me.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { BGM_SUBJECT_TYPE_REVERSE };
