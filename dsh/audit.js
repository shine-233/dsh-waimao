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

/** 本地时区某一天的 00:00 的 ISO 时间戳。 */
export function startOfLocalDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * 统计今天真实发送的邮件数（不含 dry-run）。纯函数，供日发送上限判断。
 * entries 传 queryAudit({action:'email.send', since: startOfLocalDay()})；
 * 传混合列表也安全：只认 action=email.send 且 detail.dryRun!==true。
 */
export function countRealSends(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.action === 'email.send' && entry?.detail?.dryRun !== true).length;
}
