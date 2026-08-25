// 知识库（RAG-lite）：产品目录 / 报价政策 / 案例 / 市场规则 / 品牌信息。
// 存储 ~/.waimao/data/kb.json。检索 = 分词命中打分（标题3x/标签2x/内容1x），
// 返回带 citation 的片段。够 agent 回复客户时"有据可依"。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'kb.json');
export const TYPES = ['product', 'policy', 'case', 'market', 'brand'];
const TYPE_LABELS = { product: '产品', policy: '政策', case: '案例', market: '市场', brand: '品牌' };

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function save(db) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

export function upsert({ type, title, content, tags = [], source = 'user' }) {
  if (!TYPES.includes(type)) {
    throw new Error(`invalid type: ${type} (use ${TYPES.join('/')})`);
  }
  if (!String(title ?? '').trim() || !String(content ?? '').trim()) {
    throw new Error('kb entry needs title and content');
  }
  const db = load();
  const existing = db.entries.find(
    (entry) => entry.type === type && entry.title.toLowerCase() === String(title).toLowerCase(),
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.content = String(content).slice(0, 20_000);
    existing.tags = tags;
    existing.source = source;
    existing.version += 1;
    existing.updatedAt = now;
    save(db);
    audit('kb.update', { id: existing.id, type, version: existing.version });
    return existing;
  }
  const entry = {
    id: `K${randomUUID().slice(0, 8)}`,
    type,
    typeLabel: TYPE_LABELS[type],
    title: String(title).slice(0, 120),
    content: String(content).slice(0, 20_000),
    tags,
    source,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.entries.unshift(entry);
  if (db.entries.length > 1000) {
    db.entries.length = 1000;
  }
  save(db);
  audit('kb.create', { id: entry.id, type, title: entry.title });
  return entry;
}

function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[\s,;，；、]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function scoreEntry(entry, tokens) {
  let score = 0;
  const title = entry.title.toLowerCase();
  const content = entry.content.toLowerCase();
  const tags = (entry.tags ?? []).join(' ').toLowerCase();
  for (const token of tokens) {
    if (title.includes(token)) {
      score += 3;
    }
    if (tags.includes(token)) {
      score += 2;
    }
    if (content.includes(token)) {
      score += 1;
    }
  }
  return score;
}

/** 检索：返回 [{entry 摘要 + snippet + citation}]。 */
export function search({ query, type, limit = 5 }) {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }
  let entries = load().entries;
  if (type) {
    entries = entries.filter((entry) => entry.type === type);
  }
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
  return scored.map(({ entry, score }) => {
    const lower = entry.content.toLowerCase();
    const first = tokens.find((token) => lower.includes(token));
    const at = first ? Math.max(0, lower.indexOf(first) - 40) : 0;
    return {
      id: entry.id,
      type: entry.type,
      typeLabel: entry.typeLabel,
      title: entry.title,
      snippet: `${at > 0 ? '…' : ''}${entry.content.slice(at, at + 200)}…`,
      tags: entry.tags,
      version: entry.version,
      updatedAt: entry.updatedAt,
      score,
      citation: `[${entry.typeLabel}:${entry.title} v${entry.version}]`,
    };
  });
}

export function list({ type, limit = 50 } = {}) {
  let entries = load().entries;
  if (type) {
    entries = entries.filter((entry) => entry.type === type);
  }
  return entries.slice(0, limit).map((entry) => ({
    id: entry.id, type: entry.type, typeLabel: entry.typeLabel, title: entry.title,
    tags: entry.tags, version: entry.version, updatedAt: entry.updatedAt,
    contentPreview: entry.content.slice(0, 120),
  }));
}

export function remove(id) {
  const db = load();
  const index = db.entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    throw new Error(`kb entry not found: ${id}`);
  }
  const [removed] = db.entries.splice(index, 1);
  save(db);
  audit('kb.delete', { id, title: removed.title });
  return removed;
}

/** 把命中的知识拼成给 LLM 的上下文串。 */
export function contextFor(query, limit = 3) {
  const hits = search({ query, limit });
  return hits.map((hit) => `${hit.citation} ${hit.snippet}`).join('\n');
}
