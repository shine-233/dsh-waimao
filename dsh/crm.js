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
  for (const key of ['status', 'tags', 'ownerNote', 'company', 'market', 'emailStatus', 'score', 'tier', 'fit', 'advice', 'sequence', 'lastMessageId', 'lastReply', 'pendingEmail', 'dossier', 'contacts']) {
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

/** 手机号尾号匹配线索：WhatsApp 收发自动关联 CRM 时间线用。 */
export function findLeadByPhone(number) {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (digits.length < 8) {
    return null;
  }
  const tail = digits.slice(-8);
  return listLeads({ limit: 500 }).find((lead) =>
    [...(lead.contacts?.whatsapps ?? []), ...(lead.contacts?.phones ?? [])]
      .some((value) => String(value).replace(/\D/g, '').endsWith(tail)),
  ) ?? null;
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
      // 别名要覆盖自家导出的中文表头（邮箱/WhatsApp/电话/LinkedIn），
      // 否则导出的 CSV 改完再导回来，联系方式全部静默丢失
      const emails = String(row.email ?? row.emails ?? row['邮箱'] ?? '').split(/[\s;,]+/).filter((item) => item.includes('@'));
      const whatsapps = String(row.whatsapp ?? row.whatsapps ?? row['WhatsApp'] ?? row.phone ?? row['电话'] ?? '').split(/[\s;,]+/).map((item) => item.replace(/\D/g, '')).filter((item) => item.length >= 8);
      // Apollo/Hunter 导出风格表头（company_name / website / linkedin_url）
      const company = String(row.company ?? row.company_name ?? row['公司'] ?? '').trim();
      const url = String(row.url ?? row.domain ?? row.website ?? row['链接'] ?? '').trim();
      const title = String(row.title ?? row.job_title ?? '').trim();
      if (!company && !url && emails.length === 0 && whatsapps.length === 0) {
        results.skipped += 1;
        continue;
      }
      const linkedin = String(row.linkedin ?? row['LinkedIn'] ?? '').trim();
      const { lead, merged } = upsertLead({
        company,
        url,
        market: String(row.market ?? row['市场'] ?? '').trim(),
        source: `import:${String(row.source ?? 'csv').slice(0, 40)}`,
        contacts: { emails, whatsapps, phones: [], socials: linkedin ? { linkedin: [linkedin] } : {} },
        score: Number(row.score ?? row['评分'] ?? 0) || 0,
        tier: String(row.tier ?? row['分层'] ?? '').trim() || undefined,
        title: (title || String(row.title ?? '')).slice(0, 120),
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

const normCompanyKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');

function pushToMap(map, key, value) {
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** 疑似重复线索分组：同公司名（归一化）/共享邮箱/共享手机尾号。 */
export function findDuplicateGroups({ limit = 300 } = {}) {
  const leads = listLeads({ limit });
  const byCompany = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  for (const lead of leads) {
    pushToMap(byCompany, normCompanyKey(lead.company).slice(0, 40), lead);
    for (const email of lead.contacts?.emails ?? []) {
      pushToMap(byEmail, String(email).toLowerCase(), lead);
    }
    for (const phone of [...(lead.contacts?.whatsapps ?? []), ...(lead.contacts?.phones ?? [])]) {
      pushToMap(byPhone, String(phone).replace(/\D/g, '').slice(-8), lead);
    }
  }
  const groups = [];
  const seen = new Set();
  const addGroup = (reason, key, members) => {
    if (members.length < 2) return;
    const sig = `${reason}:${members.map((m) => m.id).sort().join('|')}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    groups.push({
      reason,
      key: String(key).slice(0, 60),
      leads: members
        .map((m) => ({ id: m.id, company: m.company || m.domain, score: m.score ?? 0, status: m.status, emails: (m.contacts?.emails ?? []).length }))
        .sort((a, b) => b.score - a.score),
    });
  };
  byCompany.forEach((ms, k) => addGroup('same-company', k, ms));
  byEmail.forEach((ms, k) => addGroup('shared-email', k, ms));
  byPhone.forEach((ms, k) => addGroup('shared-phone', k, ms));
  return groups.sort((a, b) => b.leads.length - a.leads.length);
}

/**
 * 合并线索：联系方式/来源/标签/社媒取并集，分数分层取高，活动并入 keeper。
 * keepId 缺省时自动选分最高的。被合并的线索删除。
 */
export function mergeLeads(keepId, removeIds, actor = 'user') {
  const db = load();
  const ids = [...new Set(removeIds.filter((id) => id && id !== keepId))];
  const keep = db.leads.find((lead) => lead.id === keepId);
  if (!keep) {
    throw new Error(`lead not found: ${keepId}`);
  }
  if (ids.length === 0) {
    throw new Error('没有要合并的线索');
  }
  const others = [];
  for (const id of ids) {
    const other = db.leads.find((lead) => lead.id === id);
    if (!other) {
      throw new Error(`lead not found: ${id}`);
    }
    others.push(other);
  }
  // keeper 缺省规则：显式指定优先；否则分数最高者
  const all = [keep, ...others];
  const best = all.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
  const keeper = keep.score >= (best.score ?? 0) || keepId === keep.id ? keep : best;

  const uniq = (list) => [...new Set(list)];
  keeper.contacts.emails = uniq([
    ...(keeper.contacts?.emails ?? []),
    ...others.flatMap((o) => o.contacts?.emails ?? []),
  ]);
  keeper.contacts.whatsapps = uniq([
    ...(keeper.contacts?.whatsapps ?? []),
    ...others.flatMap((o) => o.contacts?.whatsapps ?? []),
  ]).map((v) => String(v).replace(/\D/g, ''));
  keeper.contacts.phones = uniq([
    ...(keeper.contacts?.phones ?? []),
    ...others.flatMap((o) => o.contacts?.phones ?? []),
  ]);
  for (const other of others) {
    for (const [key, list] of Object.entries(other.contacts?.socials ?? {})) {
      keeper.contacts.socials[key] = uniq([...(keeper.contacts.socials?.[key] ?? []), ...list]).slice(0, 3);
    }
  }
  keeper.sources = uniq([...(keeper.sources ?? []), ...others.flatMap((o) => o.sources ?? [])]);
  keeper.tags = uniq([...(keeper.tags ?? []), ...others.flatMap((o) => o.tags ?? [])]);
  for (const other of others) {
    if ((other.score ?? 0) > (keeper.score ?? 0)) {
      keeper.score = other.score;
      keeper.tier = other.tier ?? keeper.tier;
    }
    if (!keeper.advice && other.advice) keeper.advice = other.advice;
    if (!keeper.fit && other.fit) keeper.fit = other.fit;
    if (!keeper.sequence && other.sequence) keeper.sequence = other.sequence;
    if (!keeper.lastMessageId && other.lastMessageId) keeper.lastMessageId = other.lastMessageId;
    if (!keeper.lastReply && other.lastReply) keeper.lastReply = other.lastReply;
    keeper.activities.push(...(other.activities ?? []));
  }
  keeper.activities.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  keeper.activities = keeper.activities.slice(-200);
  keeper.updatedAt = new Date().toISOString();
  keeper.activities.push({
    ts: keeper.updatedAt, type: 'merge', actor,
    note: `合并自: ${others.map((o) => o.company || o.domain).join(', ')}`,
  });
  db.leads = db.leads.filter((lead) => !ids.includes(lead.id));
  save(db);
  audit('crm.merge', { keepId: keeper.id, removed: ids }, actor);
  return { merged: true, keeper, removedCount: ids.length };
}

export function storeFile() {
  return FILE;
}

export function exists() {
  return existsSync(FILE);
}
