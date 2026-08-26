// CRM 管线：线索档案 + 状态机 + 跟进活动 + 跨搜索去重。
// 存储 ~/.waimao/data/crm.json。状态流转：new → qualified → contacted →
// replied → quoted → won/lost（允许任意合法跳转，但每次都记活动+审计）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'crm.json');
export const STATUSES = ['new', 'qualified', 'contacted', 'replied', 'quoted', 'won', 'lost'];
export const STATUS_LABELS = {
  new: '新线索', qualified: '已评估', contacted: '已触达',
  replied: '已回复', quoted: '已报价', won: '已成交', lost: '已流失',
};

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.leads) ? parsed : { leads: [] };
  } catch {
    return { leads: [] };
  }
}

function save(db) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

export function normalizeDomain(urlOrDomain) {
  return String(urlOrDomain ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/^www\./, '');
}

/** 跨搜索去重键：域名优先，其次 WhatsApp/电话数字。 */
export function dedupKeyOf({ url, domain, phones, whatsapps } = {}) {
  const d = normalizeDomain(domain ?? url);
  if (d && d.includes('.')) {
    return `d:${d}`;
  }
  const wa = whatsapps?.[0] ?? phones?.[0];
  if (wa) {
    return `p:${String(wa).replace(/\D/g, '')}`;
  }
  return null;
}

export function findDuplicate(candidate) {
  const key = dedupKeyOf(candidate);
  if (!key) {
    return null;
  }
  const db = load();
  return db.leads.find((lead) => lead.dedupKey === key) ?? null;
}

/**
 * 新建（或合并）线索。candidate:
 * {company, url, domain, market, source, contacts:{emails,whatsapps,phones,socials},
 *  score, tier, reasons, advice, title, snippet, runId}
 */
export function upsertLead(candidate, { actor = 'agent', merge = true } = {}) {
  const db = load();
  const dedupKey = dedupKeyOf(candidate);
  const now = new Date().toISOString();
  const existing = dedupKey ? db.leads.find((lead) => lead.dedupKey === dedupKey) : null;

  if (existing && merge) {
    // 合并：联系方式并入、分数取高、活动记一条
    const before = existing.score ?? 0;
    const incoming = candidate.score ?? 0;
    const contacts = { ...candidate.contacts };
    existing.contacts.emails = [...new Set([...(existing.contacts.emails ?? []), ...(contacts.emails ?? [])])];
    existing.contacts.whatsapps = [...new Set([...(existing.contacts.whatsapps ?? []), ...(contacts.whatsapps ?? [])])];
    existing.contacts.phones = [...new Set([...(existing.contacts.phones ?? []), ...(contacts.phones ?? [])])];
    for (const [key, list] of Object.entries(contacts.socials ?? {})) {
      existing.contacts.socials[key] = [...new Set([...(existing.contacts.socials[key] ?? []), ...list])];
    }
    if (incoming > before) {
      existing.score = candidate.score;
      existing.tier = candidate.tier ?? existing.tier;
      existing.fit = candidate.fit ?? existing.fit;
      existing.reasons = candidate.reasons ?? existing.reasons;
      existing.advice = candidate.advice ?? existing.advice;
    }
    existing.sources = [...new Set([...(existing.sources ?? []), candidate.source ?? candidate.url].filter(Boolean))];
    existing.activities.push({ ts: now, type: 'merge', note: `再次搜到(${candidate.source ?? 'search'})，分数${incoming}>${before ? '+' : '='}${before}`, actor });
    existing.updatedAt = now;
    save(db);
    audit('crm.merge', { lead_id: existing.id, dedup_key: dedupKey }, actor);
    return { lead: existing, merged: true };
  }

  const lead = {
    id: `L${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
    company: candidate.company ?? '',
    domain: normalizeDomain(candidate.domain ?? candidate.url),
    url: candidate.url ?? '',
    market: candidate.market ?? '',
    country: candidate.country ?? '',
    dedupKey,
    contacts: {
      emails: candidate.contacts?.emails ?? [],
      whatsapps: candidate.contacts?.whatsapps ?? [],
      phones: candidate.contacts?.phones ?? [],
      socials: candidate.contacts?.socials ?? {},
    },
    emailStatus: 'unknown', // unknown | guessed | valid | catch-all | invalid | no-mx | unverifiable
    score: candidate.score ?? 0,
    tier: candidate.tier ?? '低',
    fit: candidate.fit ?? null,
    reasons: candidate.reasons ?? [],
    advice: candidate.advice ?? '',
    title: candidate.title ?? '',
    snippet: (candidate.snippet ?? '').slice(0, 300),
    status: 'new',
    tags: [],
    ownerNote: '',
    sources: [candidate.source ?? candidate.url].filter(Boolean),
    runId: candidate.runId ?? null,
    sequence: null,
    activities: [{ ts: now, type: 'create', note: `线索入库(${candidate.source ?? 'search'})`, actor }],
    createdAt: now,
    updatedAt: now,
  };
  db.leads.unshift(lead);
  if (db.leads.length > 5000) {
    db.leads.length = 5000;
  }
  save(db);
  audit('crm.create', { lead_id: lead.id, company: lead.company, score: lead.score }, actor);
  return { lead, merged: false };
}

export function getLead(id) {
  return load().leads.find((lead) => lead.id === id) ?? null;
}

export function updateLead(id, patch, { actor = 'agent', activityNote } = {}) {
  const db = load();
  const lead = db.leads.find((item) => item.id === id);
  if (!lead) {
    throw new Error(`lead not found: ${id}`);
  }
  if (patch.status && !STATUSES.includes(patch.status)) {
    throw new Error(`invalid status: ${patch.status} (use ${STATUSES.join('/')})`);
  }
  const changed = {};
  for (const key of ['status', 'tags', 'ownerNote', 'company', 'market', 'emailStatus', 'score', 'tier', 'fit', 'advice', 'sequence', 'lastMessageId', 'lastReply', 'pendingEmail', 'dossier']) {
    if (patch[key] !== undefined) {
      if (lead[key] !== patch[key]) {
        changed[key] = [lead[key], patch[key]];
      }
      lead[key] = patch[key];
    }
  }
  lead.updatedAt = new Date().toISOString();
  if (Object.keys(changed).length > 0 || activityNote) {
    lead.activities.push({
      ts: lead.updatedAt,
      type: patch.status ? 'status' : 'update',
      note: activityNote
        ?? (patch.status ? `状态: ${STATUS_LABELS[changed.status?.[0]] ?? ''} → ${STATUS_LABELS[patch.status]}` : JSON.stringify(Object.keys(changed))),
      actor,
    });
  }
  if (changed.status) {
    audit('crm.status', { lead_id: id, from: changed.status[0], to: patch.status }, actor);
  }
  save(db);
  return lead;
}

export function addActivity(id, { type = 'note', note, actor = 'agent' }) {
  const db = load();
  const lead = db.leads.find((item) => item.id === id);
  if (!lead) {
    throw new Error(`lead not found: ${id}`);
  }
  const activity = { ts: new Date().toISOString(), type, note: String(note ?? '').slice(0, 1000), actor };
  lead.activities.push(activity);
  lead.updatedAt = activity.ts;
  save(db);
  audit('crm.activity', { lead_id: id, type }, actor);
  return activity;
}

export function listLeads({ status, tier, q, minScore, limit = 50 } = {}) {
  let leads = load().leads;
  if (status) {
    leads = leads.filter((lead) => lead.status === status);
  }
  if (tier) {
    leads = leads.filter((lead) => lead.tier === tier);
  }
  if (minScore !== undefined) {
    leads = leads.filter((lead) => (lead.score ?? 0) >= minScore);
  }
  if (q) {
    const needle = q.toLowerCase();
    leads = leads.filter((lead) =>
      [lead.company, lead.domain, lead.url, ...(lead.contacts.emails ?? []), ...(lead.contacts.whatsapps ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }
  return leads.slice(0, limit);
}

export function crmStats() {
  const leads = load().leads;
  const byStatus = {};
  const byTier = {};
  for (const lead of leads) {
    byStatus[lead.status] = (byStatus[lead.status] ?? 0) + 1;
    byTier[lead.tier] = (byTier[lead.tier] ?? 0) + 1;
  }
  return { total: leads.length, byStatus, byTier };
}

/** 批量操作：状态/标签/删除。返回逐条结果。 */
export function bulkUpdate({ ids, action, value }, { actor = 'user' } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('bulk needs ids');
  }
  if (ids.length > 500) {
    throw new Error('bulk limited to 500 per call');
  }
  const results = [];
  for (const id of ids) {
    try {
      if (action === 'status') {
        const lead = updateLead(id, { status: value }, { actor, activityNote: `批量改状态 → ${STATUS_LABELS[value] ?? value}` });
        results.push({ id, ok: true, status: lead.status });
      } else if (action === 'tag') {
        const lead = getLead(id);
        if (!lead) {
          throw new Error('not found');
        }
        const tags = [...new Set([...(lead.tags ?? []), String(value ?? '')].filter(Boolean))];
        updateLead(id, { tags }, { actor, activityNote: `批量加标签: ${value}` });
        results.push({ id, ok: true, tags });
      } else if (action === 'sequence-stop') {
        const lead = getLead(id);
        if (lead?.sequence) {
          updateLead(id, { sequence: stopSequenceLocal(lead.sequence, 'bulk stop') }, { actor, activityNote: '批量停止序列' });
        }
        results.push({ id, ok: true });
      } else if (action === 'watch') {
        results.push({ id, ok: true, delegated: 'monitor' }); // 由 index.js 转给 monitor.watch
      } else {
        throw new Error(`unknown bulk action: ${action}`);
      }
    } catch (error) {
      results.push({ id, ok: false, error: String(error?.message ?? error).slice(0, 120) });
    }
  }
  audit('crm.bulk', { action, count: ids.length, ok: results.filter((item) => item.ok).length }, actor);
  return results;
}

function stopSequenceLocal(sequence, reason) {
  for (const step of sequence?.steps ?? []) {
    if (step.status === 'pending') {
      step.status = 'skipped';
      step.error = reason;
    }
  }
  return sequence;
}

/** 导入线索（CSV 解析后的行或 JSON），自动去重合并。 */
export function importLeads(rows, { actor = 'user' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('import needs rows');
  }
  if (rows.length > 2000) {
    throw new Error('import limited to 2000 rows per call');
  }
  const results = { imported: 0, merged: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    try {
      const emails = String(row.email ?? row.emails ?? '').split(/[\s;,]+/).filter((item) => item.includes('@'));
      const whatsapps = String(row.whatsapp ?? row.whatsapps ?? row.phone ?? '').split(/[\s;,]+/).map((item) => item.replace(/\D/g, '')).filter((item) => item.length >= 8);
      const company = String(row.company ?? row['公司'] ?? '').trim();
      const url = String(row.url ?? row.domain ?? row['链接'] ?? '').trim();
      if (!company && !url && emails.length === 0 && whatsapps.length === 0) {
        results.skipped += 1;
        continue;
      }
      const { lead, merged } = upsertLead({
        company,
        url,
        market: String(row.market ?? row['市场'] ?? '').trim(),
        source: `import:${String(row.source ?? 'csv').slice(0, 40)}`,
        contacts: { emails, whatsapps, phones: [], socials: {} },
        score: Number(row.score ?? row['评分'] ?? 0) || 0,
        tier: String(row.tier ?? row['分层'] ?? '').trim() || undefined,
        title: String(row.title ?? '').slice(0, 120),
        snippet: String(row.snippet ?? row['摘要'] ?? '').slice(0, 300),
      }, { actor, merge: true });
      if (merged) {
        results.merged += 1;
      } else {
        results.imported += 1;
      }
    } catch (error) {
      results.errors.push(String(error?.message ?? error).slice(0, 100));
    }
  }
  return results;
}

export function storeFile() {
  return FILE;
}

export function exists() {
  return existsSync(FILE);
}
