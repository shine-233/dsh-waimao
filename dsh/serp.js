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

async function searchSerpApi(query, { signal, apiKey, maxResults, proxy, maps = false }) {
  if (!apiKey) {
    throw new Error('engine "serpapi" needs serp.serpapiKey in ~/.waimao/config.json');
  }
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('num', String(Math.min(Math.max(maxResults ?? 10, 1), 20)));
  if (maps) {
    // Google Maps 数据源：type=search 找商家，返回 title/address/phone/website
    url.searchParams.set('engine', 'google_maps');
    url.searchParams.set('type', 'search');
    url.searchParams.delete('num');
  }
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
  if (maps) {
    return (payload.local_results ?? []).map((item) => ({
      title: stripHtml(item.title),
      url: item.website ?? `https://www.google.com/maps/place/${encodeURIComponent(item.title)}`,
      snippet: [item.address, item.phone, (item.extensions ?? []).join(', ')].filter(Boolean).join(' | '),
      phone: item.phone ?? '',
      address: item.address ?? '',
    }));
  }
  return (payload.organic_results ?? []).map((item) => ({
    title: stripHtml(item.title),
    url: item.link ?? '',
    snippet: stripHtml(item.snippet),
  }));
}

/**
 * Run one SERP query on the configured engine (single engine, no failover).
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
      maps: opts.maps === true,
      apiKey: opts.serpapiKey ?? config.serp.serpapiKey,
      maxResults: opts.maxResults,
    });
  }
  if (engine !== 'ddg') {
    throw new Error(`unknown serp engine: ${engine} (use "ddg" or "serpapi")`);
  }
  return searchDdg(query, { signal, proxy });
}

const cooldownUntil = new Map(); // engine -> ts

export function engineCooldowns() {
  return Object.fromEntries(
    [...cooldownUntil.entries()]
      .filter(([, until]) => until > Date.now())
      .map(([engine, until]) => [engine, new Date(until).toISOString()]),
  );
}

function markCooldown(engine, minutes) {
  cooldownUntil.set(engine, Date.now() + minutes * 60_000);
}

/**
 * Run one SERP query with the configured failover chain.
 * opts: {engine?, maps?, config?, signal, maxResults}
 * @returns {Promise<{results: Array, engine: string, attempts: Array}>}
 */
export async function serpSearchChained(query, opts = {}) {
  const config = opts.config ?? readConfig();
  const chain = [];
  const preferred = opts.engine || config.serp.engine || 'ddg';
  chain.push(preferred);
  for (const engine of config.serp.chain ?? []) {
    if (!chain.includes(engine)) {
      chain.push(engine);
    }
  }
  const cooldownMin = config.serp.cooldownMin ?? 10;
  const attempts = [];
  let lastError = null;
  for (const engine of chain) {
    if (engine === 'literal') {
      continue;
    }
    const until = cooldownUntil.get(engine) ?? 0;
    if (until > Date.now()) {
      attempts.push({ engine, skipped: `cooldown until ${new Date(until).toISOString()}` });
      continue;
    }
    try {
      const results = await serpSearch(query, { ...opts, engine, config });
      return { results, engine, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({ engine, error: String(error?.message ?? error).slice(0, 150) });
      markCooldown(engine, cooldownMin);
    }
  }
  throw new Error(
    `all serp engines failed (${chain.join(' -> ')}): ${String(lastError?.message ?? lastError).slice(0, 200)}`,
  );
}
