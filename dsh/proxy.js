// 零依赖代理支持：大陆网络环境下 DuckDuckGo/Google 直连不通，需要走本地
// 代理（Clash 等）。Node 22 的 fetch 不读系统代理，所以这里手写 HTTPS over
// CONNECT 隧道，返回一个与 fetch Response 同形的最小对象（ok/status/text）。
// 未配置代理时原样走 fetch。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { URL } from 'node:url';

/**
 * 解析代理地址：显式配置优先，其次标准环境变量。只接受 http(s) 代理。
 * @returns {string} 归一化的 http://host[:port] 或空串
 */
export function resolveProxy(explicit) {
  const raw = String(
    explicit ??
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      '',
  ).trim();
  if (raw === '') {
    return '';
  }
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (!/^https?:$/.test(url.protocol)) {
      return '';
    }
    const auth = url.username ? `${encodeURIComponent(url.username)}:${encodeURIComponent(url.password)}@` : '';
    return `http://${auth}${url.hostname}:${url.port || 80}`;
  } catch {
    return '';
  }
}

function collect(resp) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    resp.on('data', (chunk) => chunks.push(chunk));
    resp.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        ok: resp.statusCode >= 200 && resp.statusCode < 300,
        status: resp.statusCode,
        headers: resp.headers,
        text: async () => text,
        // 调用方（serp.js / dossier.js）在两种路径上都用 response.json()，
        // 这里不提供的话走代理时直接 TypeError
        json: async () => JSON.parse(text),
      });
    });
    resp.on('error', reject);
  });
}

/**
 * 与 fetch(url, init) 同参，返回 {ok, status, text(), json()}。
 * @param {string} proxy 空 = 直连 fetch；http(s) 代理 = CONNECT 隧道
 * 代理路径手动跟随 3xx（裸 http.request 不自动重定向，RDAP 的 rdap.org 依赖它）
 */
export async function httpFetch(target, init = {}, proxy = '', depth = 0) {
  const response = proxy ? await requestThroughProxy(target, init, proxy) : await fetch(target, init);
  const location = response.headers?.location;
  if (
    proxy && depth < 3 && location &&
    [301, 302, 303, 307, 308].includes(response.status)
  ) {
    return httpFetch(new URL(location, target).href, init, proxy, depth + 1);
  }
  return response;
}

function requestThroughProxy(target, init, proxy) {
  const t = new URL(target);
  const p = new URL(proxy);
  const signal = init.signal;
  return new Promise((resolve, reject) => {
    const finish = reject;
    if (t.protocol === 'http:') {
      // 普通经代理 HTTP：绝对 URI 直接转发
      const req = http.request(
        {
          host: p.hostname,
          port: p.port || 80,
          method: init.method ?? 'GET',
          path: t.href,
          headers: { ...init.headers, host: t.host },
          signal,
        },
        (resp) => collect(resp).then(resolve, finish),
      );
      req.on('error', finish);
      if (init.body != null) {
        req.write(init.body);
      }
      req.end();
      return;
    }
    // HTTPS：先 CONNECT 建隧道，再在 TLS 之上发请求
    const port = t.port || 443;
    const connect = http.request({
      host: p.hostname,
      port: p.port || 80,
      method: 'CONNECT',
      path: `${t.hostname}:${port}`,
      headers: { host: `${t.hostname}:${port}` },
      signal,
    });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: t.hostname });
      tlsSocket.on('error', finish);
      const req = https.request(
        {
          host: t.hostname,
          method: init.method ?? 'GET',
          path: `${t.pathname}${t.search}`,
          headers: { ...init.headers, host: t.host },
          createConnection: () => tlsSocket,
          agent: false,
          signal,
        },
        (resp) => {
          // 响应结束后主动关掉自建的隧道 socket，否则进程可能挂住不退出。
          const done = (fn, value) => {
            resp.destroy();
            fn(value);
          };
          collect(resp).then(
            (value) => done(resolve, value),
            (error) => done(finish, error),
          );
        },
      );
      req.on('error', finish);
      if (init.body != null) {
        req.write(init.body);
      }
      req.end();
    });
    connect.on('error', finish);
    connect.end();
  });
}

/** 网络层失败时的统一提示（大陆网络最常见的坑）。 */
export function networkHint(error, hasProxy) {
  const code = String(error?.cause?.code ?? error?.code ?? '');
  if (code.includes('TIMEOUT') || code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return hasProxy
      ? `（代理 ${hasProxy} 连接失败，请确认代理软件在运行）`
      : '（直连失败：大陆网络请在 ~/.waimao/config.json 的 serp.proxy 填本地代理，如 http://127.0.0.1:7890）';
  }
  return '';
}
