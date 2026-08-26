// 规则引擎分类：一眼排除同行/黄页/B2B平台/招聘/社媒/新闻，识别买家信号。
// 参考 b2b-buyer-discovery 的 skipPatterns 思路，输出 {kind, keep, reason}。
import { visibleText } from './fetchPage.js';

// 域名级硬排除：B2B 平台 / 招聘 / 黄页目录 / 社媒 / 新闻 / 学术
// （job 在 directory 之前：linkedin.com/jobs 是招聘页，不该被黄页规则先截住）
const DOMAIN_RULES = [
  { kind: 'b2b-platform', keep: false, reason: 'B2B平台(同行卖家聚集)', patterns: ['alibaba.', 'made-in-china.', 'globalsources.', 'dhgate.', '1688.', 'aliexpress.', 'tradekey.', 'ec21.', 'exportersindia', 'indiamart.', 'made-in-china'] },
  { kind: 'job', keep: false, reason: '招聘/求职页', patterns: ['indeed.', 'glassdoor.', 'ziprecruiter.', 'linkedin.com/jobs', 'monster.com', 'seek.com.au', 'careerjet.', 'upwork.', 'freelancer.com'] },
  { kind: 'directory', keep: false, reason: '黄页/目录站', patterns: ['yelp.', 'yellowpages.', 'europages.', 'thomasnet.', 'kompass.', 'hipages', 'dnb.com', 'bbb.org', 'trustpilot.', 'importyeti.', 'panjiva.', 'zoominfo.', 'linkedin.com', 'crunchbase.', 'bloomberg.com', 'yellow.place', 'hub.biz'] },
  { kind: 'social', keep: false, reason: '社媒页', patterns: ['facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'twitter.com', 'x.com', 'pinterest.', 'reddit.com'] },
  { kind: 'marketplace', keep: false, reason: '电商/零售平台(非买家公司官网)', patterns: ['amazon.', 'ebay.', 'walmart.', 'etsy.', 'shopee.', 'lazada.', 'mercadolibre.'] },
  { kind: 'news', keep: false, reason: '新闻/资讯', patterns: ['news.', '.news', 'reuters.', 'prnewswire.', 'globenewswire.', 'businesswire.', 'forbes.com', 'wikipedia.', 'quora.', 'medium.com'] },
];

// 页面内容级排除：供应商自称（同行）
const SUPPLIER_PATTERNS = [
  'we are manufacturer', 'we are a manufacturer', 'our factory', 'our products include',
  'we produce', 'we supply', 'leading manufacturer', 'professional manufacturer',
  'somos fabricantes', 'fabrica de', 'somos proveedores', 'fabricantes de',
  'welcome to our company', 'our company was founded in', 'oem/odm welcome',
  'exporting to over', 'certified factory',
];

// 页面内容级买家信号（加分）
const BUYER_PATTERNS = [
  'we buy', 'we are looking for', 'looking for supplier', 'seeking supplier',
  'we import', 'importer of', 'we purchase', 'need supplier', 'sourcing',
  'our stores', 'our branches', 'distributor wanted', 'become our supplier',
  'compramos', 'buscamos proveedor', 'importamos', 'distribuidor de',
  'wholesale supply to', 'request a quote', 'get a quote', 'rfq',
  'buy in bulk', 'bulk orders', 'wholesale inquiry',
];

// 中性但有效的商业信号（有采购场景的机构）
const BUSINESS_PATTERNS = [
  'contact us', 'about us', 'our team', 'sales@', 'info@', 'purchasing@', 'sourcing@',
  'get in touch', 'our showroom', 'our warehouse', 'customer service',
];

/**
 * 域名规则命中判断。'x.com' 这类双标签 pattern 必须按域后缀对齐——
 * 用 url.includes 会把 wix.com / netflix.com / flex.com 全部误判成 x.com 社媒页。
 * 含路径的 pattern（如 linkedin.com/jobs）仍按 URL 子串匹配；
 * 单标签前缀（如 alibaba）匹配 host 开头（alibaba.com / alibabagroup.com）。
 */
function ruleHit(host, url, pattern) {
  const p = `${String(pattern ?? '').toLowerCase()}`.replace(/^\.+|\.+$/g, '');
  if (p === '') {
    return false;
  }
  if (p.includes('/')) {
    return url.includes(p);
  }
  if (p.includes('.')) {
    // 双标签及以上（如 x.com）：按域后缀对齐，wix.com/netflix.com 不再误判成 x.com
    const labels = p.split('.').filter(Boolean);
    const tail = host.split('.').slice(-labels.length).join('.');
    return tail === labels.join('.');
  }
  // 单标签前缀（如 alibaba / made-in-china）：任一域名标签以它开头即命中
  return host.split('.').some((label) => label.startsWith(p));
}

/**
 * @param {{url: string, title?: string, snippet?: string, html?: string}} item
 * @returns {{kind: string, keep: boolean, reason: string, signals: string[]}}
 */
export function classify(item) {
  const url = String(item.url ?? '').toLowerCase();
  const host = url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  const text = item.html ? visibleText(item.html, 30_000).toLowerCase() : `${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();

  for (const rule of DOMAIN_RULES) {
    if (rule.patterns.some((pattern) => ruleHit(host, url, pattern))) {
      return { kind: rule.kind, keep: false, reason: rule.reason, signals: [] };
    }
  }
  if (/\.(gov|edu)(\.[a-z]{2})?$/.test(host)) {
    return { kind: 'gov-edu', keep: false, reason: '政府/学校域名', signals: [] };
  }

  const signals = [];
  const supplierHits = SUPPLIER_PATTERNS.filter((pattern) => text.includes(pattern));
  const buyerHits = BUYER_PATTERNS.filter((pattern) => text.includes(pattern));
  const businessHits = BUSINESS_PATTERNS.filter((pattern) => text.includes(pattern));

  // 供应商信号强于买家信号时排除（同行）；两者都强时保留但标注
  if (supplierHits.length >= 2 && supplierHits.length > buyerHits.length) {
    return { kind: 'supplier', keep: false, reason: '疑似同行(供应商自称)', signals: supplierHits.slice(0, 4) };
  }

  if (buyerHits.length > 0) {
    signals.push(...buyerHits.slice(0, 4));
    return { kind: 'buyer', keep: true, reason: `明确买家信号(${buyerHits.length}处)`, signals };
  }
  if (businessHits.length >= 2) {
    signals.push(...businessHits.slice(0, 4));
    return { kind: 'business', keep: true, reason: '正常商业站点', signals };
  }
  return { kind: 'unknown', keep: true, reason: '信号不足，待人工判断', signals: [] };
}
