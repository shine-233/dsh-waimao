// 意图监控（changedetection.io 思路的轻量版）：盯客户官网变化 → 采购信号。
// 可见文本哈希对比；变化时记 CRM 活动 + 保存差异摘要。
// cron 定期跑，也可 monitor_check 手动触发。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
import { fetchPage, visibleText } from './enrich/fetchPage.js';
import * as crm from './crm.js';
import { audit } from './audit.js';

const FILE = join(DATA_DIR, 'monitor.json');

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.targets) ? parsed : { targets: [] };
  } catch {
    return { targets: [] };
  }
}

function save(db) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

/** 监控某线索的官网（默认其 domain）。 */
export function watch(leadId, { url, note } = {}) {
  const lead = crm.getLead(leadId);
  if (!lead) {
    throw new Error(`lead not found: ${leadId}`);
  }
  const target = url || (lead.domain ? `https://${lead.domain}/` : '');
  if (!/^https?:\/\/.+/.test(target)) {
    throw new Error(`no valid url to watch（线索没有 domain，请传 url 参数）`);
  }
  const db = load();
  let entry = db.targets.find((item) => item.leadId === leadId);
  if (!entry) {
    entry = { leadId, url: target, addedAt: new Date().toISOString(), hash: null, lastChecked: null, changes: 0 };
    db.targets.push(entry);
  }
  entry.url = target;
  entry.note = note ?? entry.note;
  entry.paused = false;
  save(db);
  crm.addActivity(leadId, { type: 'note', note: `开始监控官网变化: ${target}` });
  return entry;
}

export function unwatch(leadId) {
  const db = load();
  const index = db.targets.findIndex((item) => item.leadId === leadId);
  if (index === -1) {
    return { removed: false };
  }
  const [removed] = db.targets.splice(index, 1);
  save(db);
  return { removed: true, url: removed.url };
}

export function listWatched() {
  return load().targets;
}

/** 检查一个目标。内部用。 */
async function checkTarget(entry, signal) {
  const page = await fetchPage(entry.url, { signal });
  if (!page.ok) {
    return { leadId: entry.leadId, url: entry.url, ok: false, error: page.error };
  }
  const text = visibleText(page.html, 20_000);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const changed = entry.hash !== null && entry.hash !== hash;
  const result = { leadId: entry.leadId, url: entry.url, ok: true, changed, firstSnapshot: entry.hash === null };
  // 提取变化线索：新旧文本都拿不到旧文（只存哈希），所以变化时抓关键词差异
  if (changed) {
    const interesting = ['new product', 'new factory', 'expansion', 'now hiring', 'we are looking', 'new warehouse', 'grand opening', 'now importing', 'new line'];
    const found = interesting.filter((keyword) => text.toLowerCase().includes(keyword));
    entry.changes += 1;
    result.keywords = found;
    crm.addActivity(entry.leadId, {
      type: 'signal',
      note: `🔔 官网有更新(${entry.url})${found.length ? `，命中信号词: ${found.join(', ')}` : ''} —— 可能是采购/扩张时机`,
    });
    audit('monitor.change', { leadId: entry.leadId, url: entry.url, keywords: found }, 'cron');
  }
  entry.hash = hash;
  entry.lastChecked = new Date().toISOString();
  return result;
}

/** 检查全部监控目标（cron 用）。哈希更新合并回"重新加载"的最新状态，
 *  避免长时间 await 期间用陈旧 db 覆盖掉期间新增/删除的监控目标。 */
export async function checkAll({ limit = 50, signal } = {}) {
  const due = load().targets.filter((entry) => !entry.paused).slice(0, limit);
  const results = [];
  for (const entry of due) {
    if (signal?.aborted) {
      break;
    }
    try {
      const result = await checkTarget(entry, signal);
      // 每次检查后立即持久化该目标的哈希（读-改-写窗口最小化）
      const fresh = load();
      const live = fresh.targets.find((item) => item.leadId === entry.leadId && item.url === entry.url);
      if (live) {
        live.hash = entry.hash;
        live.lastChecked = entry.lastChecked;
        live.changes = entry.changes;
        save(fresh);
      }
      results.push(result);
    } catch (error) {
      results.push({ leadId: entry.leadId, ok: false, error: String(error?.message ?? error).slice(0, 120) });
    }
  }
  return {
    checked: results.length,
    changed: results.filter((item) => item.changed),
    errors: results.filter((item) => !item.ok),
  };
}

export function stats() {
  const db = load();
  return { targets: db.targets.length, totalChanges: db.targets.reduce((sum, entry) => sum + (entry.changes ?? 0), 0) };
}
