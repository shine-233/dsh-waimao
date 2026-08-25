// 抑制列表（退订/投诉/退信）：合规刚需。发送前必查，回复分类为退订时自动加入。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'suppress.json');

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
  if (list.length > 10_000) {
    list.splice(0, list.length - 10_000);
  }
  save(list);
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
  return { total: list.length, byReason, recent: list.slice(-10).reverse() };
}
