// Evolution API 客户端（自托管 WhatsApp 网关）。只依赖 global fetch。
// 兼容 v2 的常见路径；webhook 载荷同时兼容 v1.8/v2 的两种形状。
import { readConfig } from './config.js';
import { audit } from './audit.js';
import { spinText } from './content.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';

function requireEvo(config) {
  const { baseURL, apiKey, instance } = config.evolution;
  if (!apiKey || !instance) {
    throw new Error(
      'Evolution API 未配置：请在 ~/.waimao/config.json 填写 evolution.apiKey 与 evolution.instance',
    );
  }
  const base = String(baseURL ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    throw new Error(`evolution.baseURL 无效: ${baseURL}`);
  }
  return { base, apiKey, instance };
}

async function evoFetch(path, { method = 'GET', body, signal } = {}) {
  const { base, apiKey, instance } = requireEvo(readConfig());
  const url = `${base}${path.replace('{instance}', encodeURIComponent(instance))}`;
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      apikey: apiKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.message ?? payload?.raw ?? text.slice(0, 300);
    throw new Error(`Evolution API ${response.status} ${path}: ${detail}`);
  }
  return payload;
}

/** 发送文本。number 用国际格式数字（不带 +，如 5215512345678）。 */
export async function sendText(number, text, signal) {
  const digits = String(number ?? '').replace(/[^\d]/g, '');
  if (digits.length < 8) {
    throw new Error(`invalid phone number: ${number}`);
  }
  if (!String(text ?? '').trim()) {
    throw new Error('refusing to send empty text');
  }
  return evoFetch('/message/sendText/{instance}', {
    method: 'POST',
    body: { number: digits, text: String(text) },
    signal,
  });
}

/**
 * 发送媒体（图片/PDF/文档）。media 传 http(s) URL 或 base64（不带 data: 前缀）。
 * mediatype: image | document | video | audio
 */
export async function sendMedia(number, { media, mediatype = 'document', filename = 'file', caption = '' }, signal) {
  const digits = String(number ?? '').replace(/[^\d]/g, '');
  if (digits.length < 8) {
    throw new Error(`invalid phone number: ${number}`);
  }
  const isUrl = /^https?:\/\//i.test(String(media));
  // Evolution API v2 发送负载是扁平结构：{ number, mediatype, media, fileName?, caption }。
  // mediaMessage:{base64,filename} 是 webhook 接收载荷的形状，发出去会失败
  const body = {
    number: digits,
    mediatype,
    media: isUrl ? String(media) : String(media).replace(/^data:[^;]+;base64,/, ''),
    fileName: String(filename),
    caption: String(caption ?? ''),
  };
  return evoFetch('/message/sendMedia/{instance}', { method: 'POST', body, signal });
}

/* ------------------------------------------------------------------ */
/* 群发频控：每日上限 + 随机间隔 + 失败熔断。状态存 data/broadcast.json  */
/* ------------------------------------------------------------------ */

const BROADCAST_STATE = join(DATA_DIR, 'broadcast.json');

/** 本地日期（群发日上限按本机时区翻转，不用 UTC——北京用户早8点重置是错的）。 */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function loadBroadcastState() {
  try {
    const parsed = JSON.parse(readFileSync(BROADCAST_STATE, 'utf8'));
    return parsed?.date === localToday() ? { consecutiveFailures: 0, ...parsed, date: localToday() } : { date: localToday(), sentToday: 0, consecutiveFailures: 0 };
  } catch {
    return { date: localToday(), sentToday: 0, consecutiveFailures: 0 };
  }
}

function saveBroadcastState(state) {
  mkdirSync(dirname(BROADCAST_STATE), { recursive: true, mode: 0o700 });
  const tmp = `${BROADCAST_STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  renameSync(tmp, BROADCAST_STATE);
}

export function broadcastBudget() {
  const config = readConfig();
  const state = loadBroadcastState();
  const cap = config.wa?.dailyBroadcastCap ?? 200;
  return { sentToday: state.sentToday, cap, remaining: Math.max(0, cap - state.sentToday), circuitOpen: (state.consecutiveFailures ?? 0) >= 3 };
}

/**
 * 受控群发。targets: [{number, text, media?}]。
 * 每条之间随机延迟 [minDelaySec, maxDelaySec]；超每日上限即停；连续 3 次
 * 发送失败即熔断（大概率被风控，继续会加重）。
 * onProgress(sent, total, lastResult) 回调供工具层上报。
 */
export async function broadcast(targets, { onProgress, signal } = {}) {
  const config = readConfig();
  const cap = config.wa?.dailyBroadcastCap ?? 200;
  const minDelay = (config.wa?.minDelaySec ?? 20) * 1000;
  const maxDelay = (config.wa?.maxDelaySec ?? 90) * 1000;
  const state = loadBroadcastState();
  const results = [];
  // 熔断状态持久化：原来只是函数内变量，重启进程即清零绕过熔断
  let consecutiveFailures = state.consecutiveFailures ?? 0;
  for (const target of targets) {
    if (state.sentToday >= cap) {
      results.push({ number: target.number, skipped: `daily cap ${cap} reached` });
      break;
    }
    if (consecutiveFailures >= 3) {
      results.push({ number: target.number, skipped: 'circuit breaker open (3+ consecutive failures) — 排查后明天再试' });
      break;
    }
    if (signal?.aborted) {
      results.push({ number: target.number, skipped: 'aborted' });
      break;
    }
    try {
      const result = target.media
        ? await sendMedia(target.number, target.media)
        : await sendText(target.number, spinText(target.text));
      state.sentToday += 1;
      consecutiveFailures = 0;
      state.consecutiveFailures = 0;
      saveBroadcastState(state);
      results.push({ number: target.number, ok: true });
      audit('wa.broadcast.send', { number: target.number }, 'agent');
    } catch (error) {
      consecutiveFailures += 1;
      state.consecutiveFailures = consecutiveFailures;
      saveBroadcastState(state);
      results.push({ number: target.number, ok: false, error: String(error?.message ?? error).slice(0, 150) });
      audit('wa.broadcast.fail', { number: target.number, consecutive: consecutiveFailures, error: String(error?.message ?? error).slice(0, 150) }, 'agent');
      if (consecutiveFailures >= 3) {
        results.push({ aborted: '3 consecutive failures — circuit breaker, stop broadcasting' });
        break;
      }
    }
    onProgress?.(results.filter((item) => item.ok).length, targets.length, results.at(-1));
    if (minDelay > 0) {
      const delay = minDelay + Math.floor(Math.random() * Math.max(1, maxDelay - minDelay));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { results, sentToday: loadBroadcastState().sentToday, cap };
}

/** 最近会话列表。v2 同时接受 GET/POST，这里 GET 失败回退 POST。 */
export async function findChats(signal) {
  try {
    return await evoFetch('/chat/findChats/{instance}', { signal });
  } catch (error) {
    if (String(error?.message).includes('404') || String(error?.message).includes('405')) {
      return evoFetch('/chat/findChats/{instance}', { method: 'POST', body: {}, signal });
    }
    throw error;
  }
}

/** 某个会话的历史消息。 */
export async function findMessages(remoteJid, limit = 20, signal) {
  return evoFetch('/chat/findMessagesByChat/{instance}', {
    method: 'POST',
    body: { remoteJid, offset: 0, limit: Math.min(Math.max(limit, 1), 100) },
    signal,
  });
}

function extractText(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }
  return String(
    message.conversation ??
      message.extendedTextMessage?.text ??
      message.imageMessage?.caption ??
      message.videoMessage?.caption ??
      message.documentMessage?.caption ??
      '',
  ).trim();
}

/**
 * Normalize an Evolution webhook payload into [{id, chatJid, sender, name,
 * text, ts, fromMe}]. Handles v1.8 (data object) and v2 (data array) shapes.
 */
export function normalizeWebhook(payload) {
  const out = [];
  const events = Array.isArray(payload) ? payload : [payload];
  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }
    if (event.event && !String(event.event).startsWith('messages.')) {
      continue;
    }
    const raw = Array.isArray(event.data) ? event.data : [event.data];
    for (const item of raw) {
      const key = item?.key ?? item?.message?.key;
      const id = key?.id;
      const text = extractText(item?.message ?? item);
      if (!id || text === '') {
        continue;
      }
      out.push({
        id: String(id),
        chatJid: String(key?.remoteJid ?? item?.remoteJid ?? ''),
        sender: String(key?.participant ?? key?.remoteJid ?? ''),
        name: String(item?.pushName ?? ''),
        text,
        fromMe: key?.fromMe === true,
        ts: new Date(Number(item?.messageTimestamp ?? 0) * 1000 || Date.now()).toISOString(),
      });
    }
  }
  return out;
}

/** 把 findMessages 的返回归一化成与 webhook 相同的条目。 */
export function normalizeHistory(payload, chatJid) {
  const records = Array.isArray(payload?.messages?.records)
    ? payload.messages.records
    : Array.isArray(payload)
      ? payload
      : [];
  const out = [];
  for (const item of records) {
    const key = item?.key ?? {};
    const id = key?.id;
    const text = extractText(item?.message ?? item);
    if (!id || text === '') {
      continue;
    }
    out.push({
      id: String(id),
      chatJid: String(key?.remoteJid ?? chatJid ?? ''),
      sender: String(key?.participant ?? key?.remoteJid ?? ''),
      name: String(item?.pushName ?? ''),
      text,
      fromMe: key?.fromMe === true,
      ts: new Date(Number(item?.messageTimestamp ?? 0) * 1000 || Date.now()).toISOString(),
    });
  }
  return out;
}

/**
 * WhatsApp 扫码接入：实例未连接时返回二维码（base64）/配对码；
 * 已连接时 Evolution 返回 4xx 且文案含 open/connected，归一化为 connected。
 * 返回: { connected, qrcodeBase64?, pairingCode?, state? }
 */
export async function connectInstance(signal) {
  const { base, apiKey, instance } = requireEvo(readConfig());
  const url = `${base}/instance/connect/${encodeURIComponent(instance)}`;
  const response = await fetch(url, {
    headers: { apikey: apiKey },
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  if (response.ok) {
    const qr = payload?.qrcode;
    const qrcodeBase64 = typeof qr === 'string' ? qr : (qr?.base64 ?? null);
    const pairingCode = qr?.pairingCode ?? payload?.pairingCode ?? null;
    const state = payload?.instance?.state ?? null;
    if (qrcodeBase64 || pairingCode) {
      return { connected: false, qrcodeBase64, pairingCode, state };
    }
    return { connected: state === 'open', state, qrcodeBase64: null, pairingCode: null };
  }
  if ([400, 403, 404, 409].includes(response.status) && /open|connected|already/i.test(text)) {
    return { connected: true, state: 'open' };
  }
  throw new Error(`Evolution API ${response.status} /instance/connect: ${payload?.error?.message ?? payload?.message ?? text.slice(0, 200)}`);
}

/** 查询实例连接状态。 */
export async function connectionState(signal) {
  const payload = await evoFetch('/instance/connectionState/{instance}', { signal });
  const state = payload?.instance?.state ?? payload?.state ?? 'unknown';
  return { state, connected: state === 'open' };
}
