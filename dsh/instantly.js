// Instantly.ai 直连（零依赖）：把 CRM 线索推进 Instantly 活动、查活动/账号列表。
// API 形状按官方 OpenAPI v2（https://api.instantly.ai/openapi/api_v2.json）：
//   - 鉴权：Authorization: Bearer <apiKey>
//   - POST /api/v2/leads/add  { campaign_id|list_id, leads[] ≤1000 }
//     lead 字段：email/first_name/last_name/company_name/job_title/website/personalization/phone
//   - GET  /api/v2/campaigns / /api/v2/accounts
import { readConfig } from './config.js';
import { httpFetch, resolveProxy, networkHint } from './proxy.js';

const BASE = 'https://api.instantly.ai';

export function instantlyConfigured() {
  return Boolean(readConfig().instantly?.apiKey);
}

async function api(path, { method = 'GET', body, query, timeoutMs = 30_000 } = {}) {
  const apiKey = readConfig().instantly?.apiKey;
  if (!apiKey) {
    throw new Error('Instantly 未配置：settings 页或 ~/.waimao/config.json 填 instantly.apiKey');
  }
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const proxy = resolveProxy(readConfig().serp?.proxy ?? '');
  let response;
  try {
    response = await httpFetch(url.href, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, proxy);
  } catch (error) {
    throw new Error(`Instantly 请求失败: ${String(error?.message ?? error)}${networkHint(error, proxy)}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Instantly HTTP ${response.status}: ${JSON.stringify(payload)?.slice(0, 200)}`);
  }
  return payload;
}

/** 活动列表。status: active/paused/draft 等（按 Instantly 文档）。 */
export async function listCampaigns({ limit = 20, search, status } = {}) {
  return api('/api/v2/campaigns', { query: { limit, search, status } });
}

export async function listAccounts({ limit = 50 } = {}) {
  return api('/api/v2/accounts', { query: { limit } });
}

/**
 * 批量加线索到活动。leads 元素须符合官方 schema：
 * {email?, first_name?, last_name?, company_name?, job_title?, website?, personalization?, phone?}
 * 自动按 ≤500/批切分；返回每批结果。
 */
export async function addLeads({ campaignId, leads, batchSize = 500 }) {
  if (!campaignId) {
    throw new Error('campaign_id 必填（instantly_campaign_list 可查）');
  }
  const clean = (Array.isArray(leads) ? leads : []).filter((lead) => lead && typeof lead.email === 'string' && lead.email.includes('@'));
  if (clean.length === 0) {
    throw new Error('没有带邮箱的线索可推送');
  }
  const results = [];
  for (let i = 0; i < clean.length; i += batchSize) {
    const batch = clean.slice(i, i + batchSize).map((lead) => ({
      email: lead.email,
      first_name: lead.first_name || null,
      last_name: lead.last_name || null,
      company_name: lead.company_name || null,
      job_title: lead.job_title || null,
      website: lead.website || null,
      personalization: lead.personalization || null,
    }));
    const payload = await api('/api/v2/leads/add', { method: 'POST', body: { campaign_id: campaignId, leads: batch } });
    results.push({ batch: results.length + 1, sent: batch.length, ok: payload?.ok !== false });
  }
  return { total: clean.length, batches: results };
}

/** CRM 线索 → Instantly lead schema。没有真实联系人名就不填（公司名拆词当人名是垃圾数据），reason 进 personalization 变量。 */
export function toInstantLead(lead) {
  const parts = String(lead.contacts?.person ?? '').trim().split(/\s+/).filter(Boolean);
  return {
    email: lead.contacts?.emails?.[0] ?? '',
    first_name: parts[0] ?? null,
    last_name: parts.length > 1 ? parts[parts.length - 1] : null,
    company_name: lead.company || lead.domain || null,
    website: lead.domain ? `https://${lead.domain}` : null,
    personalization: [lead.fit ? `fit:${lead.fit}` : '', lead.advice || ''].filter(Boolean).join(' | ') || null,
  };
}
