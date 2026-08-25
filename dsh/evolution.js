// Evolution API 客户端（自托管 WhatsApp 网关）。只依赖 global fetch。
// 兼容 v2 的常见路径；webhook 载荷同时兼容 v1.8/v2 的两种形状。
import { readConfig } from './config.js';

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
