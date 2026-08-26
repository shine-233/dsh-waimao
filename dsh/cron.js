// 定时任务调度器：unref 定时器，不阻塞 dsh 退出。
// 任务：wa 收件箱轮询 / 邮件序列到期执行 / 每日管线日报 / 停跟进提醒。
// 全部动作走 audit；发送类动作尊重 smtp.dry_run 与 evolution 配置。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readConfig } from './config.js';
import { audit, queryAudit } from './audit.js';

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

const jobs = new Map();
let timer = null;

/** 注册任务：fn 必须自带幂等与错误处理（这里 catch 全部）。 */
export function registerJob(name, { everyMs, fn, description }) {
  jobs.set(name, { everyMs, fn, description, lastRun: null, lastResult: null, lastError: null, running: false });
}

function persist(name, patch) {
  const state = loadState();
  state[name] = { ...(state[name] ?? {}), ...patch };
  saveState(state);
}

function tick() {
  const now = Date.now();
  const state = loadState();
  for (const [name, job] of jobs) {
    // 重叠保护：上一轮还没跑完（AI 分类/IMAP 扫描可能超过 everyMs），本轮跳过
    if (job.running) {
      continue;
    }
    const last = state[name]?.lastRun ? Date.parse(state[name].lastRun) : 0;
    if (now - last < job.everyMs) {
      continue;
    }
    job.running = true;
    Promise.resolve()
      .then(() => job.fn())
      .then((result) => {
        job.lastRun = new Date().toISOString();
        job.lastResult = result ?? 'ok';
        job.lastError = null;
        persist(name, { lastRun: job.lastRun, lastResult: job.lastResult });
        audit('cron.run', { job: name, result: typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) }, 'cron');
      })
      .catch((error) => {
        job.lastRun = new Date().toISOString();
        job.lastError = String(error?.message ?? error).slice(0, 300);
        persist(name, { lastRun: job.lastRun, lastError: job.lastError });
        audit('cron.error', { job: name, error: job.lastError }, 'cron');
      })
      .finally(() => {
        job.running = false;
      });
  }
}

/** 启动调度（web/headless 均可；定时器 unref 不阻塞退出）。 */
export function start({ intervalMs = 60_000 } = {}) {
  if (timer) {
    return;
  }
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 手动触发一次（cron_status / 网页按钮用）。结果落盘，避免自动调度立刻重跑。 */
export async function runOnce(name) {
  const job = jobs.get(name);
  if (!job) {
    throw new Error(`unknown job: ${name} (have: ${[...jobs.keys()].join(',')})`);
  }
  if (job.running) {
    throw new Error(`job ${name} is already running`);
  }
  job.running = true;
  try {
    const result = await job.fn();
    job.lastRun = new Date().toISOString();
    job.lastResult = result ?? 'ok';
    persist(name, { lastRun: job.lastRun, lastResult: job.lastResult });
    audit('cron.run', { job: name, manual: true, result: typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) }, 'cron');
    return { job: name, result };
  } finally {
    job.running = false;
  }
}

export function status() {
  const state = loadState();
  return [...jobs.entries()].map(([name, job]) => ({
    name,
    description: job.description,
    everyMs: job.everyMs,
    lastRun: state[name]?.lastRun ?? null,
    lastResult: state[name]?.lastResult ?? null,
    lastError: state[name]?.lastError ?? null,
  }));
}

/* ------------------------------------------------------------------ */
/* 内置任务工厂（index.js 注入发送函数，避免循环依赖）                   */
/* ------------------------------------------------------------------ */

import * as crm from './crm.js';
import * as waStore from './store.js';
import * as evolution from './evolution.js';
import { dueSteps, stopSequence } from './mail/sequence.js';
import { scanReplies } from './mail/replies.js';
import * as monitorMod from './monitor.js';
import { MARKETS } from './markets.js';

const STATE_FILE = join(DATA_DIR, 'cron.json');

/** 收件人当地时间的小时数（按市场预设的粗时区；未知市场返回 null）。 */
export function recipientLocalHour(market, now = new Date()) {
  const m = MARKETS[String(market ?? '').toLowerCase()];
  if (!m || typeof m.utc !== 'number') {
    return null;
  }
  return (((now.getUTCHours() + m.utc) % 24) + 24) % 24;
}

/** 发送时间窗判断：收件人当地时间 9-19 点之外不顺延发送。 */
export function outsideSendWindow(localHour) {
  return localHour !== null && (localHour < 9 || localHour >= 19);
}

/**
 * 邮件序列到期执行：sendEmail({lead, subject, body, ...}) 由 index.js 提供。
 * smtp.sendWindow=true（默认）时，收件人当地时间 9-19 点之外的顺延到下一轮。
 */
export function createSequenceJob({ sendEmail }) {
  return async () => {
    const config = readConfig();
    if (config.smtp?.dryRun !== false) {
      return 'smtp.dry_run=true，序列仅标记不发送';
    }
    const windowOn = config.smtp?.sendWindow !== false;
    const leads = crm.listLeads({ limit: 500 });
    let sent = 0;
    let deferred = 0;
    for (const lead of leads) {
      if (!lead.sequence || lead.status === 'replied' || lead.status === 'won' || lead.status === 'lost') {
        continue;
      }
      if (windowOn && outsideSendWindow(recipientLocalHour(lead.market))) {
        deferred += 1;
        continue; // 步骤保持 pending，下一轮窗口内再发
      }
      const due = dueSteps(lead.sequence);
      for (const step of due) {
        const email = lead.contacts.emails?.[0];
        if (!email) {
          crm.updateLead(lead.id, { sequence: stopSequence(lead.sequence, 'no email address') }, { activityNote: '序列跳过：无邮箱' });
          break;
        }
        try {
          const result = await sendEmail({ lead, to: email, subject: step.subject, body: step.body, inReplyTo: lead.lastMessageId, isFirstEmail: step.day === 0 && !lead.lastMessageId });
          step.status = 'sent';
          step.sentAt = new Date().toISOString();
          crm.updateLead(lead.id, {
            sequence: lead.sequence,
            status: lead.status === 'new' || lead.status === 'qualified' ? 'contacted' : lead.status,
            ...(result?.messageId ? { lastMessageId: result.messageId } : {}),
          }, { activityNote: `跟进序列 Day${step.day} 已发送: ${step.subject}` });
          sent += 1;
        } catch (error) {
          step.status = 'failed';
          step.error = String(error?.message ?? error).slice(0, 200);
          crm.updateLead(lead.id, { sequence: lead.sequence }, { activityNote: `Day${step.day} 发送失败: ${step.error}` });
          break; // 单封失败停止该线索本轮，下轮重试
        }
      }
    }
    return sent > 0 ? `sent ${sent} follow-ups` : deferred > 0 ? `no due steps, ${deferred} deferred (outside send window)` : 'no due steps';
  };
}

/** WhatsApp 收件箱轮询（webhook 不可达时的兜底）。 */
export async function waInboxJob() {
  const config = readConfig();
  if (!config.evolution.apiKey || !config.evolution.instance) {
    return 'evolution not configured';
  }
  const payload = await evolution.findChats();
  const chats = Array.isArray(payload) ? payload : (payload?.chats ?? []);
  let added = 0;
  for (const chat of chats.slice(0, 10)) {
    const jid = chat?.id ?? chat?.remoteJid ?? chat?.chatId;
    if (typeof jid !== 'string' || jid === '' || jid.endsWith('@g.us')) {
      continue;
    }
    const history = await evolution.findMessages(jid, 20).catch(() => null);
    if (!history) {
      continue;
    }
    const entries = evolution.normalizeHistory(history, jid).filter((item) => !item.fromMe);
    added += waStore.upsertIncoming(entries).added;
  }
  return added > 0 ? `+${added} new buyer messages` : 'inbox clean';
}

function writeReport(name, content) {
  const dir = join(DATA_DIR, 'reports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}.md`);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

/** IMAP 回复扫描（回复检测闭环的 cron 半边）。 */
export async function replyScanJob() {
  const config = readConfig();
  if (!config.imap?.host || !config.imap?.user) {
    return 'imap not configured';
  }
  const result = await scanReplies({ days: 14, limit: 30 });
  return result.replies.length > 0
    ? `${result.replies.length} replies (${result.replies.map((item) => item.category).join(',')})`
    : 'no replies';
}

/** 客户官网变化监控（意图信号）。 */
export async function monitorJob() {
  const stats = monitorMod.stats();
  if (stats.targets === 0) {
    return 'no watched sites';
  }
  const result = await monitorMod.checkAll({ limit: 30 });
  return result.changed.length > 0
    ? `${result.changed.length}/${result.checked} sites changed`
    : `${result.checked} checked, no changes`;
}

/** 邮箱预热（每天一轮互动）。 */
export async function warmupJob() {
  const warmup = await import('./warmup.js');
  if (!warmup.warmupConfigured()) {
    return 'warmup not configured';
  }
  const result = await warmup.runWarmupRound({});
  return result.skipped ?? `${result.results?.filter((r) => r.ok).length ?? 0} warmup legs ok`;
}

/** 每日管线日报。 */
export async function dailyReportJob() {
  const stats = crm.crmStats();
  const recent = queryAudit({ limit: 30 });
  const lines = [
    `# 外贸管线日报 ${new Date().toISOString().slice(0, 10)}`,
    '',
    `## 管线概况`,
    `总计 ${stats.total} 条线索`,
    ...Object.entries(stats.byStatus).map(([status, count]) => `- ${crm.STATUS_LABELS[status]}: ${count}`),
    '',
    `## 分层分布`,
    ...Object.entries(stats.byTier).map(([tier, count]) => `- ${tier}: ${count}`),
    '',
    `## 最近动作`,
    ...recent.slice(0, 15).map((entry) => `- ${entry.ts.slice(5, 16)} [${entry.actor}] ${entry.action} ${JSON.stringify(entry.detail).slice(0, 80)}`),
  ];
  const file = writeReport(`daily-${new Date().toISOString().slice(0, 10)}`, lines.join('\n'));
  return `report: ${file}`;
}

/** 停跟进提醒：contacted/replied 超过 N 天没动作的线索。 */
export function createStaleJob({ staleDays = 7 } = {}) {
  return async () => {
    const cutoff = Date.now() - staleDays * 86_400_000;
    const stale = crm
      .listLeads({ limit: 500 })
      .filter((lead) => ['contacted', 'replied', 'quoted'].includes(lead.status))
      .filter((lead) => Date.parse(lead.updatedAt ?? 0) < cutoff);
    if (stale.length === 0) {
      return 'no stale leads';
    }
    const lines = [
      `# 停跟进提醒 ${new Date().toISOString().slice(0, 10)}`,
      `以下 ${stale.length} 条线索超过 ${staleDays} 天没有动作：`,
      ...stale.map((lead) => `- [${lead.id}] ${lead.company || lead.domain} (${crm.STATUS_LABELS[lead.status]}, ${lead.tier}) 最近动作: ${lead.activities.at(-1)?.note ?? ''}`),
    ];
    const file = writeReport(`stale-${new Date().toISOString().slice(0, 10)}`, lines.join('\n'));
    return `${stale.length} stale leads -> ${file}`;
  };
}
