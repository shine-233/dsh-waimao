// 站点联系人抓取（hunter.io 的 Domain Search 平替思路）：
// 抓首页 + 常见联系页路径（/contact /about /team /impressum ...），从页面提取
// 邮箱/WhatsApp/电话/社媒。只用已有积木（fetchPage + extractContacts），零依赖。
import { fetchPage } from './enrich/fetchPage.js';
import { extractContacts } from './enrich/contacts.js';

const COMMON_PATHS = [
  '/contact', '/contact-us', '/contacts', '/about', '/about-us', '/company',
  '/team', '/impressum', '/en/contact', '/sales', '/get-a-quote',
];

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** 从 HTML 里收集同源链接的 path 列表。 */
function sameOriginPaths(html, origin) {
  const paths = [];
  for (const match of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    const href = match[1];
    let resolved;
    try {
      resolved = new URL(href, origin);
    } catch {
      continue;
    }
    if (resolved.origin !== origin || resolved.pathname === '/') {
      continue;
    }
    paths.push(resolved.pathname);
  }
  return [...new Set(paths)];
}

/**
 * 抓取一个站点并汇总联系方式。
 * @returns {{pages: Array<{url, ok}>, emails: string[], whatsapps: string[], phones: string[], socials: object, company: string}}
 */
export async function harvestSiteContacts(targetUrl, { maxPages = 5, signal } = {}) {
  const origin = originOf(targetUrl);
  if (!origin) {
    throw new Error(`invalid url: ${targetUrl}`);
  }
  const queue = ['/'];
  const seen = new Set();
  const pages = [];
  const agg = { emails: [], whatsapps: [], phones: [], socials: {}, company: '' };

  const absorb = (html) => {
    const found = extractContacts(html, { knownCompany: agg.company || undefined });
    for (const key of ['emails', 'whatsapps', 'phones']) {
      for (const value of found[key] ?? []) {
        if (!agg[key].includes(value)) {
          agg[key].push(value);
        }
      }
    }
    for (const [key, list] of Object.entries(found.socials ?? {})) {
      agg.socials[key] = [...new Set([...(agg.socials[key] ?? []), ...list])].slice(0, 3);
    }
    if (!agg.company && found.company) {
      agg.company = found.company;
    }
  };

  // 首页先抓：既取联系方式，也发现站内真实存在的联系页
  let homepageLinks = [];
  while (queue.length > 0 && pages.length < Math.max(1, maxPages)) {
    const path = queue.shift();
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const page = await fetchPage(`${origin}${path}`, { signal });
    pages.push({ url: `${origin}${path}`, ok: Boolean(page.ok) });
    if (!page.ok || !page.html) {
      continue;
    }
    absorb(page.html);
    if (pages.length === 1) {
      homepageLinks = sameOriginPaths(page.html, origin);
      // 站内真实链接优先，其次常见猜测路径；联系类关键词加权排前
      const scored = [...new Set([...homepageLinks, ...COMMON_PATHS])]
        .map((p) => ({ p, score: /contact|about|team|impressum|sales|quote/i.test(p) ? 0 : 1 }))
        .sort((a, b) => a.score - b.score)
        .map((x) => x.p);
      queue.push(...scored.slice(0, maxPages - 1));
    }
  }

  return {
    pages,
    emails: agg.emails,
    whatsapps: agg.whatsapps,
    phones: agg.phones,
    socials: agg.socials,
    company: agg.company,
  };
}
