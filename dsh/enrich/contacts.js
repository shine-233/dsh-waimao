// 从 HTML 提取联系方式：邮箱（mailto + 正文）、WhatsApp（wa.me / api.whatsapp
// / 点击聊天链接）、电话（tel: + 国际格式）、社媒（LinkedIn/IG/FB）、公司名。
// 全部去重、归一化。零依赖。
import { visibleText } from './fetchPage.js';
import { stripHtml } from '../serp.js';

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const WA_LINK_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|whatsapp:\/\/send\?phone=)(\+?\d[\d\s-]{6,20})/gi;
const TEL_LINK_RE = /href=["']tel:([^"']+)["']/gi;
const INTL_PHONE_RE = /(?<![\d-])(\+\d{1,3}[\s-]?)((?:\d[\s-]?){7,14}\d)(?![\d])/g;
const SOCIAL_RES = {
  linkedin: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/[a-z0-9%-]+/gi,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[a-z0-9_.]+/gi,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/[a-z0-9_.-]+/gi,
};

const EMAIL_BAD_DOMAINS = /^(example|test|domain|your|email|sender|company)\./i;
const EMAIL_BAD_EXT = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i;

function uniq(list) {
  return [...new Set(list)];
}

function cleanPhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    return '';
  }
  if (/^(\d)\1+$/.test(digits)) {
    return ''; // 全同数字
  }
  return digits;
}

export function extractContacts(html, { knownCompany } = {}) {
  const text = visibleText(html, 60_000);
  const textOnly = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const mailtos = [...textOnly.matchAll(/href=["']mailto:([^"'?]+)/gi)].map((match) => match[1].toLowerCase());
  const emails = uniq(
    mailtos
      .concat(textOnly.match(EMAIL_RE) ?? [])
      .map((value) => value.toLowerCase().trim())
      .filter((value) => !EMAIL_BAD_DOMAINS.test(value) && !EMAIL_BAD_EXT.test(value))
      .filter((value) => !/^(noreply|no-reply|postmaster|abuse|webmaster)@/.test(value)),
  );

  const whatsapps = uniq(
    [...html.matchAll(WA_LINK_RE)]
      .map((match) => cleanPhone(match[1]))
      .filter(Boolean),
  );

  const telLinks = uniq([...html.matchAll(TEL_LINK_RE)].map((match) => cleanPhone(match[0])).filter(Boolean));
  const inlinePhones = uniq(
    [...text.matchAll(INTL_PHONE_RE)].map((match) => cleanPhone(`${match[1]}${match[2]}`)).filter(Boolean),
  );
  const phones = uniq([...whatsapps, ...telLinks, ...inlinePhones]);

  const socials = {};
  for (const [key, re] of Object.entries(SOCIAL_RES)) {
    const found = uniq((html.match(re) ?? []).map((value) => value.replace(/[)"'>].*$/, '')));
    if (found.length > 0) {
      socials[key] = found.slice(0, 3);
    }
  }

  let company = knownCompany ?? '';
  if (!company) {
    const ogSite = html.match(/property=["']og:site_name["']\s+content=["']([^"']{2,80})["']/i);
    const title = html.match(/<title[^>]*>([\s\S]{2,120}?)<\/title>/i);
    company = stripHtml(ogSite?.[1] ?? title?.[1] ?? '').replace(/[|–—-].*$/, '').trim();
  }

  return {
    company,
    emails,
    whatsapps,
    phones: phones.filter((value) => !whatsapps.includes(value)),
    socials,
    hasWhatsAppLink: /whatsapp|wa\.me/i.test(html),
  };
}

/** 从一段纯文本（如搜索摘要）里快速提取，用于不抓网页时的兜底。 */
export function extractFromText(text) {
  return {
    emails: uniq((text.match(EMAIL_RE) ?? []).map((value) => value.toLowerCase())),
    whatsapps: [],
    phones: uniq([...String(text ?? '').matchAll(INTL_PHONE_RE)].map((m) => cleanPhone(m[0])).filter(Boolean)),
  };
}
