// 邮件模板库：保存/复用开发信模板。data/templates.json。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'templates.json');

function load() {
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

export function saveTemplate({ name, language = 'en', subject, body, tags = [] }, actor = 'agent') {
  if (!String(name ?? '').trim() || !String(subject ?? '').trim() || !String(body ?? '').trim()) {
    throw new Error('template needs name/subject/body');
  }
  const list = load();
  const existing = list.find((item) => item.name.toLowerCase() === String(name).toLowerCase());
  const now = new Date().toISOString();
  if (existing) {
    existing.subject = String(subject);
    existing.body = String(body);
    existing.language = language;
    existing.tags = tags;
    existing.updatedAt = now;
    save(list);
    audit('template.update', { name: existing.name }, actor);
    return existing;
  }
  const template = {
    id: `TPL${randomUUID().slice(0, 6)}`,
    name: String(name).slice(0, 60),
    language,
    subject: String(subject),
    body: String(body),
    tags,
    used: 0,
    createdAt: now,
    updatedAt: now,
  };
  list.push(template);
  if (list.length > 200) {
    list.splice(0, list.length - 200);
  }
  save(list);
  audit('template.create', { name: template.name }, actor);
  return template;
}

export function listTemplates({ language } = {}) {
  let list = load();
  if (language) {
    list = list.filter((item) => item.language === language);
  }
  return list.map((item) => ({ ...item, body: undefined, bodyPreview: item.body.slice(0, 120) }));
}

export function getTemplate(idOrName) {
  const needle = String(idOrName ?? '').toLowerCase();
  const found = load().find(
    (item) => item.id.toLowerCase() === needle || item.name.toLowerCase() === needle,
  );
  return found ?? null;
}

export function markUsed(id) {
  const list = load();
  const found = list.find((item) => item.id === id);
  if (found) {
    found.used += 1;
    save(list);
  }
}

export function removeTemplate(id, actor = 'agent') {
  const list = load();
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(`template not found: ${id}`);
  }
  const [removed] = list.splice(index, 1);
  save(list);
  audit('template.delete', { name: removed.name }, actor);
  return removed;
}
