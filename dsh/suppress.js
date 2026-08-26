// 抑制列表（退订/投诉/退信）：合规刚需。发送前必查，回复分类为退订时自动加入。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'suppress.json');
const DOMAIN_FILE = join(DATA_DIR, 'domain-blacklist.json');

function loadDomains() {
  try {
    const parsed = JSON.parse(readFileSync(DOMAIN_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDomains(list) {
  mkdirSync(dirname(DOMAIN_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${DOMAIN_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  renameSync(tmp, DOMAIN_FILE);
}

export function domainOf(email) {
  const raw = String(email ?? '').toLowerCase().trim().split('@')[1] ?? '';
  return raw.replace(/^www\./, '');
}

/** 域名级黑名单：退信/投诉后整个域名拉黑（同公司其他联系人大概率也是坏地址）。 */
export function blacklistDomain(domain, reason = 'hard-bounce', actor = 'agent') {
  const clean = String(domain ?? '').toLowerCase().trim();
  if (!clean.includes('.')) {
    throw new Error(`invalid domain: ${domain}`);
  }
  const list = loadDomains();
  if (list.some((item) => item.domain === clean)) {
    return { domain: clean, already: true };
  }
  const entry = { domain: clean, reason, ts: new Date().toISOString() };
  list.push(entry);
  if (list.length > 5000) {
    saveDomains(list.slice(-5000));
  } else {
    saveDomains(list);
  }
  audit('suppress.domain', { domain: clean, reason }, actor);
  return entry;
}

export function isDomainBlacklisted(domain) {
  const clean = String(domain ?? '').toLowerCase().trim();
  if (!clean) {
    return null;
  }
  return loadDomains().find((item) => item.domain === clean) ?? null;
}

export function loadSuppress() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(list) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

export function isSuppressed(email) {
  const needle = String(email ?? '').toLowerCase().trim();
  if (!needle) {
    return null;
  }
  const found = loadSuppress().find((item) => item.email === needle);
  return found ?? null;
}

export function suppress(email, reason = 'manual', actor = 'agent') {
  const clean = String(email ?? '').toLowerCase().trim();
  if (!clean.includes('@')) {
    throw new Error(`invalid email: ${email}`);
  }
  const list = loadSuppress();
  if (list.some((item) => item.email === clean)) {
    return { email: clean, already: true };
  }
  const entry = { email: clean, reason, ts: new Date().toISOString() };
  list.push(entry);
  // 容量裁剪：优先丢弃最老的"非永久"记录；退订/退信/投诉是合规红线，
  // 裁掉它们会导致给已退订的人重新发信
  if (list.length > 10_000) {
    const PERMANENT = /^(hard-bounce|unsubscribe|unsubscribe-reply|complaint)/;
    const removableIndexes = [];
    list.forEach((item, index) => {
      if (!PERMANENT.test(String(item.reason ?? ''))) {
        removableIndexes.push(index);
      }
    });
    let excess = list.length - 10_000;
    const drop = new Set();
    for (const index of removableIndexes) {
      if (excess <= 0) break;
      drop.add(index);
      excess -= 1;
    }
    save(drop.size > 0 ? list.filter((_, index) => !drop.has(index)) : list);
  } else {
    save(list);
  }
  audit('suppress.add', { email: clean, reason }, actor);
  return entry;
}

export function unsuppress(email, actor = 'agent') {
  const clean = String(email ?? '').toLowerCase().trim();
  const list = loadSuppress();
  const index = list.findIndex((item) => item.email === clean);
  if (index === -1) {
    return { email: clean, removed: false };
  }
  list.splice(index, 1);
  save(list);
  audit('suppress.remove', { email: clean }, actor);
  return { email: clean, removed: true };
}

export function suppressStats() {
  const list = loadSuppress();
  const byReason = {};
  for (const item of list) {
    byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  }
  const domains = loadDomains();
  return { total: list.length, byReason, recent: list.slice(-10).reverse(), domains: domains.length, domainRecent: domains.slice(-5).reverse() };
}
