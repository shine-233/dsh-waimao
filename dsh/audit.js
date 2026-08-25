// 审计日志：只增 JSONL。所有对外动作（发邮件/发WhatsApp/状态变更/SOP推进/
// cron 任务）都落一条，可回放、可追责。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = join(DATA_DIR, 'audit.jsonl');

export function audit(action, detail = {}, actor = 'agent') {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const entry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    actor,
    action,
    detail,
  };
  try {
    appendFileSync(FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // 审计失败不阻断业务，但尽量留痕在 stderr
    console.error('[waimao][audit] write failed:', action);
  }
  return entry;
}

export function queryAudit({ limit = 100, action, actor, since } = {}) {
  let raw = '';
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (action && entry.action !== action) {
        continue;
      }
      if (actor && entry.actor !== actor) {
        continue;
      }
      if (since && entry.ts < since) {
        continue;
      }
      out.push(entry);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
