// 邮箱预热（自托管单机版）：
//  - 爬坡计划：新域名/新账号直接群发=进垃圾箱。按启动天数限制"预热情报"每日量，
//    该上限对预热邮件本身强制生效（业务发送由 smtp.dailyCap 保护）。
//  - 互动预热：主账号 ↔ 伙伴账号互发带标签的邮件，cron 自动回复、标星、已读——
//    模拟真实往来，帮邮箱服务商建立"这是正常通信"的印象。
// 限制说明：真正的多域名预热池需要多台收件端配合；单机版做的是"自有账号
// 之间的真实互动 + 预热爬坡限额"，这两件事对送达率贡献最大且完全自托管。
// 不做 IMAP MOVE（挪回收件箱需要服务器支持且误用风险高）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DATA_DIR, readConfig } from './config.js';
import { audit, queryAudit } from './audit.js';
import { sendMail } from './mail/smtp.js';
import { imapLogin, imapSelect, imapSearchFrom, imapFetchMessage, imapLogout } from './mail/imap.js';

const FILE = join(DATA_DIR, 'warmup.json');
export const WARMUP_TAG = '[waimao-warmup]';

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { log: [], startedAt: null };
  } catch {
    return { log: [], startedAt: null };
  }
}

function save(db) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

/** 爬坡：第1周5封/天，每周+5，封顶 maxPerDay。 */
export function rampCap(daysSinceStart, maxPerDay = 30) {
  const week = Math.floor(Math.max(daysSinceStart, 0) / 7);
  return Math.min(5 + week * 5, Math.max(maxPerDay, 5));
}

export function warmupConfigured() {
  const config = readConfig();
  const warmup = config.warmup ?? {};
  return Boolean(
    warmup.enabled &&
      config.smtp?.host &&
      config.smtp?.from &&
      Array.isArray(warmup.partners) &&
      warmup.partners.length > 0 &&
      warmup.partners.every((partner) => partner.host && partner.user && partner.pass && partner.imapHost),
  );
}

/** 今日已发业务邮件数（审计推导），仅供参考展示；预热自身的量由本轮内计数约束。 */
export function todayBudget() {
  const config = readConfig();
  const db = load();
  if (!db.startedAt) {
    return { startedAt: null, cap: null, note: '预热未启动（warmup.enabled=false 或未配置伙伴账号）' };
  }
  const days = Math.floor((Date.now() - Date.parse(db.startedAt)) / 86_400_000);
  const cap = rampCap(days, config.warmup?.maxPerDay ?? 30);
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = querySentToday(today);
  return { startedAt: db.startedAt, days, cap, sentToday, remaining: Math.max(0, cap - sentToday) };
}

function querySentToday(today) {
  try {
    return queryAudit({ action: 'email.send', limit: 1000 }).filter((entry) => entry.ts.startsWith(today)).length;
  } catch {
    return 0;
  }
}

/**
 * 一轮互动预热：主账号 → 每个伙伴账号发一封；再从伙伴账号 IMAP 找到它，
 * 自动回复 + 标星 + （尽力）挪回收件箱。
 */
export async function runWarmupRound({ signal } = {}) {
  const config = readConfig();
  // dry_run 总闸优先：预热也只做真实发送，总闸开着就一封都不发（也不写当日 latch）
  if (config.smtp?.dryRun !== false) {
    return { skipped: 'smtp.dry_run=true：预热不发送真实邮件' };
  }
  if (!warmupConfigured()) {
    throw new Error('预热未配置：config.warmup.enabled=true 且至少一个完整伙伴账号（host/user/pass/imapHost）');
  }
  const db = load();
  if (!db.startedAt) {
    db.startedAt = new Date().toISOString();
    save(db);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (db.log.some((entry) => entry.day === today)) {
    return { skipped: `今天(${today})已跑过一轮`, day: today };
  }
  // 爬坡额度对预热线强制：今日已发达到 rampCap 就停
  const budget = todayBudget();
  if (budget.cap !== null && budget.remaining <= 0) {
    return { skipped: `今日预热额度已用完 (${budget.sentToday}/${budget.cap})`, day: today };
  }
  let sentLegs = 0;
  const withinBudget = () => budget.cap === null || sentLegs < budget.cap;
  const main = config.smtp;
  const results = [];
  for (const partner of config.warmup.partners ?? []) {
    if (signal?.aborted) {
      break;
    }
    if (!withinBudget()) {
      results.push({ leg: 'skipped', partner: partner.user, ok: false, error: '已达今日预热爬坡上限' });
      continue;
    }
    const tag = randomUUID().slice(0, 8);
    // 1) 主 → 伙伴
    try {
      await sendMail(main, {
        from: main.from, fromName: main.fromName,
        to: partner.user, toName: 'Warmup Partner',
        subject: `${WARMUP_TAG} ${tag} Quick hello from our sales inbox`,
        body: `Hi team,\n\nTesting our sending setup — replying to keep the thread alive.\n\nRef: ${tag}\n`,
      });
      sentLegs += 1;
      audit('email.warmup', { leg: 'main->partner', to: partner.user, tag }, 'cron');
      results.push({ leg: 'main->partner', partner: partner.user, ok: true });
    } catch (error) {
      results.push({ leg: 'main->partner', partner: partner.user, ok: false, error: String(error?.message ?? error).slice(0, 120) });
      continue;
    }
    // 2) 伙伴 IMAP：找到 → 回复 + 标星 + 挪回收件箱
    try {
      const partnerImap = { host: partner.imapHost, port: partner.imapPort ?? 993, secure: partner.imapSecure !== false, user: partner.user, pass: partner.pass, mailbox: partner.imapMailbox ?? 'INBOX' };
      const session = await imapLogin(partnerImap);
      try {
        await imapSelect(session, partnerImap.mailbox);
        const seqs = await imapSearchFrom(session, main.from, new Date(Date.now() - 3 * 86_400_000));
        for (const seq of seqs.slice(-3).reverse()) {
          const message = await imapFetchMessage(session, seq, { maxBody: 500 });
          if (!message.subject.includes(WARMUP_TAG)) {
            continue;
          }
          // 自动回复（伙伴 → 主）
          await sendMail(
            { host: partner.smtpHost ?? partner.host, port: partner.smtpPort ?? (partner.smtpSecure === false ? 587 : 465), secure: partner.smtpSecure !== false, user: partner.user, pass: partner.pass, from: partner.user },
            { from: partner.user, to: main.from, subject: `Re: ${message.subject}`, body: `Got it — thanks!\n\nRef: ${tag}`, inReplyTo: message.messageId },
          );
          sentLegs += 1;
          audit('email.warmup', { leg: 'partner-auto-reply', from: partner.user, tag }, 'cron');
          // 标星 + 已读（尽力）
          try {
            session.socket.write(`B1 STORE ${seq} +FLAGS (\\Seen \\Flagged)\r\n`);
            await new Promise((resolve) => setTimeout(resolve, 400));
          } catch {}
          results.push({ leg: 'partner-auto-reply', partner: partner.user, ok: true, subject: message.subject.slice(0, 60) });
          break;
        }
      } finally {
        await imapLogout(session);
      }
    } catch (error) {
      results.push({ leg: 'partner-auto-reply', partner: partner.user, ok: false, error: String(error?.message ?? error).slice(0, 120) });
    }
  }
  const entry = { day: today, at: new Date().toISOString(), results };
  // 全部失败时不写当日 latch，下一轮自动重试（否则预热线当天静默空转）
  const okCount = results.filter((item) => item.ok).length;
  const attempted = results.filter((item) => item.leg !== 'skipped').length;
  if (attempted > 0 && okCount === 0) {
    return { day: today, results, note: '本轮全部失败，未记当日完成，稍后重试' };
  }
  db.log.push(entry);
  if (db.log.length > 365) {
    db.log = db.log.slice(-365);
  }
  save(db);
  audit('warmup.round', { day: today, legs: results.length, ok: results.filter((item) => item.ok).length }, 'cron');
  return { day: today, results };
}

export function warmupStatus() {
  const config = readConfig();
  const db = load();
  return {
    configured: warmupConfigured(),
    startedAt: db.startedAt,
    budget: todayBudget(),
    partners: (config.warmup?.partners ?? []).map((partner) => partner.user),
    recentLog: db.log.slice(-7).reverse(),
  };
}
