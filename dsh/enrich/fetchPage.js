// 抓取结果页 HTML（走 httpFetch 代理隧道），带大小/时间上限与内容类型守卫。
import { httpFetch, networkHint, resolveProxy } from '../proxy.js';
import { readConfig } from '../config.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

const MAX_BYTES = 1_500_000; // 单页上限：联系方式都在前几百 KB
const TIMEOUT_MS = 20_000;

/**
 * 抓一个页面，返回 {ok, status, html, finalUrl, error}。
 * 永不 throw：单个页面失败只影响该条线索。
 */
export async function fetchPage(url, opts = {}) {
  const config = opts.config ?? readConfig();
  const proxy = resolveProxy(opts.proxy ?? config.serp.proxy);
  const signal = opts.signal ?? AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await httpFetch(
      url,
      {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'en-US,en;q=0.8,es;q=0.7',
        },
        signal,
      },
      proxy,
    );
    const contentType = String(response.headers?.['content-type'] ?? '');
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      return { ok: false, status: response.status, html: '', error: `non-html content-type: ${contentType}` };
    }
    const raw = await response.text();
    const html = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
    return { ok: response.ok, status: response.status, html, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, html: '', error: `${error?.message ?? error}${networkHint(error, proxy)}` };
  }
}

/** 从 HTML 里剥掉 script/style 后的可见文本（供分类与评分用）。 */
export function visibleText(html, cap = 20_000) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}
