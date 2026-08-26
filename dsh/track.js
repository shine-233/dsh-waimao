// 打开/点击追踪（自托管版）：像素注入 + 链接包裹 + 事件落盘。
//
// 前提：dsh 只绑 127.0.0.1，收件人的邮件客户端打不到本机。所以追踪需要用户
// 提供一个「公网入口」——用 caddy/nginx/cloudflared 把一个域名反代到本机
// 3080 端口，然后 config.track.publicBaseUrl 填这个域名。未配置时追踪静默
// 关闭（不注入像素、不包裹链接）。
//
// 安全：px/click 路由不走回环围栏（邮件客户端在公网），但 ID 是 24 位随机
// 十六进制（不可枚举），点击只允许 302 到发送时登记过的 URL（防开放重定向），
// 响应不携带任何用户数据。
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR, readConfig } from './config.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'tracking.json');
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export function trackingEnabled() {
  const base = String(readConfig().track?.publicBaseUrl ?? '').trim();
  return base !== '' ? base.replace(/\/+$/, '') : '';
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.records ? parsed : { records: {} };
  } catch {
    return { records: {} };
  }
}

function save(db) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

function secret() {
  return readConfig().track?.secret || 'waimao-track-secret';
}

function clickIdOf(trackId, url) {
  return createHmac('sha256', secret()).update(`${trackId}|${url}`).digest('hex').slice(0, 16);
}

/** 创建一条追踪记录（每封邮件一条）。 */
export function createTracking({ leadId, to, subject }) {
  const id = randomBytes(12).toString('hex'); // 24 hex
  const db = load();
  db.records[id] = {
    leadId: leadId ?? null,
    to,
    subject: String(subject ?? '').slice(0, 120),
    createdAt: new Date().toISOString(),
    opens: [],
    clicks: [],
    links: {}, // clickId -> url
  };
  prune(db);
  save(db);
  return { id, record: db.records[id] };
}

function prune(db) {
  const ids = Object.keys(db.records);
  if (ids.length > 5000) {
    for (const id of ids.slice(0, ids.length - 5000)) {
      delete db.records[id];
    }
  }
}

/**
 * 把纯文本正文转成带追踪的 HTML（像素 + 链接包裹）。
 * URL 必须在 HTML 转义"之前"的原文上提取登记——先转义再匹配的话，
 * 带 & 的查询参数会变成 &amp; 存进链接表，点击后 302 到坏地址。
 * @returns {{html: string, clickMap: Record<string,string>}}
 */
export function buildTrackedHtml({ text, trackId, base }) {
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const urlRe = /https?:\/\/[^\s<>"')]+/g;
  const db = load();
  const record = db.records[trackId];
  const clickMap = {};
  const raw = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const match of raw.matchAll(urlRe)) {
    const clean = match[0].replace(/[.,;:!?]+$/, '');
    const tail = match[0].slice(clean.length);
    const cid = clickIdOf(trackId, clean);
    clickMap[cid] = clean;
    parts.push(escape(raw.slice(last, match.index)));
    parts.push(`<a href="${base}/waimao/click?c=${cid}">${escape(clean)}</a>${escape(tail)}`);
    last = match.index + match[0].length;
  }
  parts.push(escape(raw.slice(last)));
  const html = parts.join('');
  if (record) {
    Object.assign(record.links, clickMap);
    save(db);
  }
  const pixel = `<img src="${base}/waimao/px?id=${trackId}" width="1" height="1" alt="" style="display:none">`;
  const withBody = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${pixel}</body>`)
    : `${html}${pixel}`;
  return {
    html: `<html><body style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap">${withBody}</body></html>`,
    clickMap,
  };
}

export function recordOpen(id, userAgent) {
  const db = load();
  const record = db.records[id];
  if (!record) {
    return false;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (record.opens.includes(today)) {
    return false; // 同一天只计一次
  }
  record.opens.push(today);
  save(db);
  audit('track.open', { leadId: record.leadId, to: record.to, day: today }, 'track');
  return true;
}

/** 返回应重定向的 URL；未知/未登记的点击一律 null（防开放重定向）。 */
export function recordClick(clickId) {
  const db = load();
  for (const record of Object.values(db.records)) {
    const url = record.links?.[clickId];
    if (url) {
      const today = new Date().toISOString().slice(0, 10);
      record.clicks.push({ url, day: today });
      if (record.clicks.length > 100) {
        record.clicks = record.clicks.slice(-100);
      }
      save(db);
      audit('track.click', { leadId: record.leadId, url, day: today }, 'track');
      return url;
    }
  }
  return null;
}

export function isValidTrackId(id) {
  return /^[0-9a-f]{24}$/.test(String(id ?? ''));
}

export function isValidClickId(id) {
  return /^[0-9a-f]{16}$/.test(String(id ?? ''));
}

/** 追踪汇总（stats_report 用）。 */
export function trackStats() {
  const db = load();
  const records = Object.values(db.records);
  const opened = records.filter((record) => record.opens.length > 0);
  const clicked = records.filter((record) => record.clicks.length > 0);
  return {
    trackedEmails: records.length,
    opened: opened.length,
    openRate: records.length > 0 ? `${Math.round((opened.length / records.length) * 100)}%` : '-',
    clicked: clicked.length,
    clickRate: records.length > 0 ? `${Math.round((clicked.length / records.length) * 100)}%` : '-',
  };
}

export const PIXEL = PIXEL_GIF;
