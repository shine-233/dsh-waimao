// WhatsApp 消息存储 + 审核队列。~/.waimao/data/messages.json 单文件存储，
// 按 Evolution 的 message id 去重；容量上限 + 旧已发送记录裁剪。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = join(DATA_DIR, 'messages.json');
const MAX_MESSAGES = 2000;

export function loadMessages() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMessages(list) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(list, null, 1)}`, { mode: 0o600 });
  renameSync(tmp, FILE);
}

export function upsertIncoming(entries) {
  const list = loadMessages();
  const byId = new Map(list.map((item) => [item.id, item]));
  let added = 0;
  for (const entry of entries) {
    if (!entry?.id || byId.has(entry.id)) {
      continue;
    }
    byId.set(entry.id, { status: 'pending', draft: '', ...entry });
    added += 1;
  }
  const merged = [...byId.values()];
  prune(merged);
  saveMessages(merged);
  return { added, total: merged.length };
}

function prune(list) {
  const sentCutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const kept = list.filter(
    (item) => item.status !== 'sent' || Date.parse(item.sentAt ?? item.ts ?? 0) > sentCutoff,
  );
  if (kept.length > MAX_MESSAGES) {
    kept.sort((a, b) => Date.parse(b.ts ?? 0) - Date.parse(a.ts ?? 0));
    kept.length = MAX_MESSAGES;
  }
  list.length = 0;
  list.push(...kept);
}

export function pendingQueue({ status = 'pending', limit = 50 } = {}) {
  const list = loadMessages()
    .filter((item) => (status === 'all' ? true : item.status === status))
    .sort((a, b) => Date.parse(b.ts ?? 0) - Date.parse(a.ts ?? 0));
  return list.slice(0, limit);
}

export function getMessage(id) {
  return loadMessages().find((item) => item.id === id) ?? null;
}

export function updateMessage(id, patch) {
  const list = loadMessages();
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`message not found: ${id}`);
  }
  list[index] = { ...list[index], ...patch };
  prune(list);
  saveMessages(list);
  return list[index];
}

export function stats() {
  const list = loadMessages();
  return {
    total: list.length,
    pending: list.filter((item) => item.status === 'pending').length,
    drafted: list.filter((item) => item.status === 'drafted').length,
    sent: list.filter((item) => item.status === 'sent').length,
    ignored: list.filter((item) => item.status === 'ignored').length,
  };
}

export function storeFileExists() {
  return existsSync(FILE);
}
