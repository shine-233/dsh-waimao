// SERP backends. Default is DuckDuckGo's HTML endpoint (keyless, free);
// SerpAPI (Google) is available with a key. Both return the same minimal
// shape: [{title, url, snippet}]. Zero dependencies — requests go through
// httpFetch, which honors serp.proxy / proxy env (CONNECT tunnel) because
// Node's fetch ignores system proxies.
import { readConfig } from './config.js';
import { httpFetch, networkHint, resolveProxy } from './proxy.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
  '&hellip;': '…',
};

export function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (match) => ENTITIES[match.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo wraps results in a redirect link: pull the real url out. */
function decodeDdgHref(href) {
  try {
    if (href.includes('uddg=')) {
      const url = new URL(href.startsWith('//') ? `https:${href}` : href);
      const target = url.searchParams.get('uddg');
      if (target) {
        return target;
      }
    }
    return href.startsWith('//') ? `https:${href}` : href;
  } catch {
    return href;
  }
}

function parseDdgHtml(html) {
  const results = [];
  const anchorRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let snippetMatch;
  while ((snippetMatch = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtml(snippetMatch[1]));
  }
  let index = 0;
  let anchorMatch;
  while ((anchorMatch = anchorRe.exec(html)) !== null) {
    const url = decodeDdgHref(anchorMatch[1]);
    const title = stripHtml(anchorMatch[2]);
    if (!title || !/^https?:\/\//i.test(url)) {
      continue;
    }
    results.push({ title, url, snippet: snippets[index] ?? '' });
    index += 1;
  }
  return results;
}

async function searchDdg(query, { signal, proxy }) {
  let response;
  try {
    response = await httpFetch(
      'https://html.duckduckgo.com/html/',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': UA,
          accept: 'text/html',
        },
        body: new URLSearchParams({ q: query }).toString(),
        signal,
      },
      proxy,
    );
  } catch (error) {
    throw new Error(`duckduckgo unreachable: ${error?.message ?? error}${networkHint(error, proxy)}`);
  }
  if (!response.ok) {
    throw new Error(
      `duckduckgo returned HTTP ${response.status}` +
        (response.status === 403 || response.status === 429
          ? ' (rate limited — wait a moment, switch engine to serpapi, or use engine "literal")'
          : ''),
    );
  }
  const html = await response.text();
  const results = parseDdgHtml(html);
  if (results.length === 0 && /anomaly|blocked|captcha/i.test(html)) {
    throw new Error('duckduckgo served an anti-bot page — wait a moment or switch engine to serpapi');
  }
  return results;
}

async function searchSerpApi(query, { signal, apiKey, maxResults, proxy }) {
  if (!apiKey) {
    throw new Error('engine "serpapi" needs serp.serpapiKey in ~/.waimao/config.json');
  }
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('num', String(Math.min(Math.max(maxResults ?? 10, 1), 20)));
  const response = await httpFetch(
    url,
    { headers: { 'user-agent': UA }, signal },
    proxy,
  );
  if (!response.ok) {
    throw new Error(`serpapi returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`serpapi error: ${payload.error}`);
  }
  return (payload.organic_results ?? []).map((item) => ({
    title: stripHtml(item.title),
    url: item.link ?? '',
    snippet: stripHtml(item.snippet),
  }));
}

/**
 * Run one SERP query on the configured engine.
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function serpSearch(query, opts = {}) {
  const config = opts.config ?? readConfig();
  const engine = opts.engine || config.serp.engine || 'ddg';
  const proxy = resolveProxy(opts.proxy ?? config.serp.proxy);
  const signal = opts.signal ?? AbortSignal.timeout(25_000);
  if (engine === 'serpapi') {
    return searchSerpApi(query, {
      signal,
      proxy,
      apiKey: opts.serpapiKey ?? config.serp.serpapiKey,
      maxResults: opts.maxResults,
    });
  }
  if (engine !== 'ddg') {
    throw new Error(`unknown serp engine: ${engine} (use "ddg" or "serpapi")`);
  }
  return searchDdg(query, { signal, proxy });
}
