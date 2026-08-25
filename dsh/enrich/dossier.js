// 公司背调：RDAP 协议查 WHOIS（域名年龄/注册商/到期）+ 首页技术栈指纹。
// RDAP 是 WHOIS 的现代替代，纯 HTTPS 零依赖。走 serp.proxy 代理。
import { httpFetch, resolveProxy } from '../proxy.js';
import { fetchPage, visibleText } from './fetchPage.js';
import { readConfig } from '../config.js';

const TECH_SIGNATURES = [
  { name: 'WordPress', re: /wp-content|wp-includes/i },
  { name: 'Shopify', re: /cdn\.shopify\.com|shopify\.theme/i },
  { name: 'WooCommerce', re: /woocommerce/i },
  { name: 'Magento', re: /magento|Mage\./i },
  { name: 'PrestaShop', re: /prestashop/i },
  { name: 'Wix', re: /wixstatic|_wixCssModules/i },
  { name: 'Squarespace', re: /squarespace/i },
  { name: 'BigCommerce', re: /bigcommerce/i },
  { name: 'React', re: /__NEXT_DATA__|react(-dom)?(\.production)?\.min\.js|data-reactroot/i },
  { name: 'Vue', re: /vue(\.runtime)?(\.min)?\.js|data-v-app/i },
  { name: 'Google Analytics', re: /googletagmanager\.com|google-analytics\.com/i },
  { name: 'Meta Pixel', re: /connect\.facebook\.net.*fbevents|fbq\(/i },
  { name: 'Cloudflare', re: /cdn-cgi\/|cloudflare/i },
  { name: 'Alibaba.com Store', re: /alibaba\.com|1688/i },
  { name: 'WhatsApp Chat Widget', re: /wa\.me|whatsapp.*widget|api\.whatsapp/i },
  { name: 'Intercom', re: /intercom/i },
  { name: 'HubSpot', re: /hs-scripts\.com|hubspot/i },
];

function normalizeDomain(urlOrDomain) {
  return String(urlOrDomain ?? '').toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '');
}

/** RDAP 查询域名注册信息。 */
async function rdapDomain(domain, proxy, signal) {
  const response = await httpFetch(
    `https://rdap.org/domain/${encodeURIComponent(domain)}`,
    { headers: { accept: 'application/rdap+json' }, signal },
    proxy,
  );
  if (!response.ok) {
    throw new Error(`RDAP HTTP ${response.status}`);
  }
  const payload = await response.json();
  const events = {};
  for (const event of payload.events ?? []) {
    events[event.eventAction] = event.eventDate;
  }
  const registrar = (payload.entities ?? [])
    .find((entity) => (entity.roles ?? []).includes('registrar'));
  const registrarName = registrar?.vcardArray?.[1]?.find((item) => item[0] === 'fn')?.[3] ?? '';
  const ageDays = events.registration ? Math.floor((Date.now() - Date.parse(events.registration)) / 86_400_000) : null;
  return {
    registered: events.registration ?? null,
    ageDays,
    ageText: ageDays !== null ? `${Math.floor(ageDays / 365)}年${Math.floor((ageDays % 365) / 30)}个月` : '',
    expires: events.expiration ?? null,
    registrar: String(registrarName).slice(0, 60),
    ageFlag: ageDays !== null && ageDays < 180 ? '⚠️ 新注册域名(<6个月)，谨慎' : ageDays !== null && ageDays > 1825 ? '✅ 老域名(>5年)，较可信' : '',
  };
}

/** 首页技术栈指纹 + 联系方式复检。 */
async function homepageProfile(url, signal) {
  const page = await fetchPage(url, { signal });
  if (!page.ok) {
    return { error: page.error };
  }
  const techStack = TECH_SIGNATURES.filter((sig) => sig.re.test(page.html)).map((sig) => sig.name);
  const text = visibleText(page.html, 8000).toLowerCase();
  const signals = [];
  if (/distributor|wholesal|reseller|dealer/.test(text)) {
    signals.push('自称分销/批发商');
  }
  if (/import|sourcing|procurement/.test(text)) {
    signals.push('有进口/采购职能');
  }
  if (/since \d{4}|founded in \d{4}|est\.? \d{4}/.test(text)) {
    signals.push('标注成立年份(老公司)');
  }
  if (/career|job|hiring|vacanc/.test(text)) {
    signals.push('在招聘(业务扩张信号)');
  }
  return { techStack, signals };
}

/**
 * 生成公司档案。opts: {lead_id?, url/domain, signal}
 */
export async function companyDossier(opts = {}) {
  const config = readConfig();
  const proxy = resolveProxy(config.serp.proxy);
  let domain = normalizeDomain(opts.domain ?? opts.url);
  if (!domain || !domain.includes('.')) {
    throw new Error('company_dossier 需要有效 domain 或 url');
  }
  const signal = opts.signal ?? AbortSignal.timeout(45_000);
  const [rdap, homepage] = await Promise.allSettled([
    rdapDomain(domain, proxy, signal),
    homepageProfile(`https://${domain}/`, signal),
  ]);
  const dossier = {
    domain,
    whois: rdap.status === 'fulfilled' ? rdap.value : { error: String(rdap.reason?.message ?? rdap.reason).slice(0, 120) },
    homepage: homepage.status === 'fulfilled' ? homepage.value : { error: String(homepage.reason?.message ?? homepage.reason).slice(0, 120) },
    generatedAt: new Date().toISOString(),
  };
  // 落库到 CRM
  if (opts.lead_id) {
    const { getLead, updateLead } = await import('../crm.js');
    const lead = getLead(String(opts.lead_id));
    if (lead) {
      updateLead(lead.id, { dossier }, { activityNote: `背调完成: ${dossier.whois.ageText || 'WHOIS未知'} ${dossier.homepage.techStack?.length ? `| 技术栈: ${dossier.homepage.techStack.join(',')}` : ''}` });
    }
  }
  return dossier;
}
