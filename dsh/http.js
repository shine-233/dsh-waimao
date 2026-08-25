// 回环路由的公共件：与 dsh 自身 /api 相同的信任围栏（host 必须是回环、
// 拒绝跨站），JSON 读写工具，以及 webhook 的 token 校验。
import { readConfig } from './config.js';

/** localhost / [::1] / 127.0.0.0/8 —— 与 dsh 的 /api 围栏一致。 */
export function isLoopbackHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }
  const parts = String(hostname ?? '').split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

export function isTrustedRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== 'string' || host === '') {
    return false;
  }
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHost(hostUrl.hostname)) {
    return false;
  }
  if (req.headers?.['sec-fetch-site'] === 'cross-site') {
    return false;
  }
  const origin = req.headers?.origin;
  if (origin === undefined) {
    return true;
  }
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Webhook 信任：Evolution 服务端不带 Origin，用共享 token 校验
 * （?token=... 或 x-webhook-token 头）。token 未配置时一律拒绝。
 */
export function isTrustedWebhook(req, url) {
  const token = readConfig().webhookToken;
  if (!token) {
    return false;
  }
  const presented = url.searchParams.get('token') ?? req.headers?.['x-webhook-token'];
  return typeof presented === 'string' && presented.length > 0 && presented === token;
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

const BODY_LIMIT = 512 * 1024;

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
