// 邮箱预热池（warmbly 式多收件箱，自托管单机版）：
//  - 参与池 = 主账号 + smtp.accounts（可用 warmup:false 退出）+ 传统 partners。
//    池内任意 ≥2 个邮箱即可互为预热伙伴，按天轮换配对方向，模拟真实往来。
//  - 爬坡计划：每个邮箱独立计时（第1周5封/天，每周+5，封顶 maxPerDay），
//    新域名/新账号直接群发=进垃圾箱。该上限对预热邮件本身强制生效；
//    业务发送由 smtp.dailyCap / accounts[].dailyCap 单独保护。
//  - 互动自动化：收到方 IMAP 自动回复、标星、已读；并尽力把误入垃圾箱的
//    预热邮件 MOVE 回 INBOX（服务器不支持则跳过）——这是预热的经典动作。
//  - 内容变化：4 组模板按标签轮换 + 可选 DeepSeek 生成短自然语句，避免
//    每封都长得一样。
// 限制说明：真正的多域名预热池需要多台收件端配合；单机版做的是"自有账号
// 之间的真实互动 + 每邮箱爬坡限额"，这两件事对送达率贡献最大且完全自托管。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DATA_DIR, readConfig } from './config.js';
import { audit, queryAudit } from './audit.js';
import { sendMail } from './mail/smtp.js';
import { imapLogin, imapSelect, imapSearchFrom, imapFetchMessage, imapLogout } from './mail/imap.js';

const FILE = join(DATA_DIR, 'warmup.json');
export const WARMUP_TAG = '[waimao-warmup]';
const SPAM_MAILBOXES = ['[Gmail]/Spam', 'Junk', 'Spam', 'INBOX.Junk'];

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { log: [], startedAt: null, startedBy: {} };
  } catch {
    return { log: [], startedAt: null, startedBy: {} };
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

/**
 * 预热池参与者：主账号 + smtp.accounts(warmup!==false) + partners。
 * 有 imap 配置的参与者承担"收件侧互动"（回复/标星/救垃圾箱）。
 */
export function poolParticipants(config = readConfig()) {
  const out = [];
  const imapOf = (source) => (source?.imapHost ? {
    host: source.imapHost,
    port: source.imapPort ?? 993,
    secure: source.imapSecure !== false,
    user: source.imapUser ?? source.user,
    pass: source.imapPass ?? source.pass,
    mailbox: source.imapMailbox ?? 'INBOX',
  } : null);
  if (config.smtp?.host && config.smtp?.from) {
    out.push({
      email: String(config.smtp.from).toLowerCase(),
      smtp: { ...config.smtp },
      imap: config.warmup?.useMainImap === false ? null : imapOf({
        imapHost: config.imap?.host, imapPort: config.imap?.port, imapSecure: config.imap?.secure !== false,
        imapUser: config.imap?.user || config.smtp.user, imapPass: config.imap?.pass, imapMailbox: config.imap?.mailbox,
      }),
    });
  }
  for (const account of config.smtp?.accounts ?? []) {
    if (!account?.host || !account?.from || account.warmup === false) {
      continue;
    }
    out.push({ email: String(account.from).toLowerCase(), smtp: { ...config.smtp, ...account }, imap: imapOf(account) });
  }
  for (const partner of config.warmup?.partners ?? []) {
    out.push({
      email: String(partner.user ?? '').toLowerCase(),
      smtp: { host: partner.host, port: partner.smtpPort ?? (partner.smtpSecure === false ? 587 : 465), secure: partner.smtpSecure !== false, user: partner.user, pass: partner.pass, from: partner.user },
      imap: imapOf(partner),
    });
  }
  // 按 email 去重（主账号同时出现在 accounts 里时）
  const seen = new Set();
  return out.filter((p) => p.email && p.email.includes('@') && p.smtp?.host && !seen.has(p.email) && seen.add(p.email));
}

/** 按天偏移轮换配对：同一天配对固定，隔天换搭档。返回 [senderIdx, receiverIdx] 数组。 */
export function pairRotation(count, dayOffset) {
  const pairs = [];
  for (let i = 0; i < count; i += 1) {
    pairs.push([(dayOffset + i) % count, (dayOffset + i + 1) % count]);
  }
  return pairs;
}

function warmupConfiguredPool(pool) {
  return pool.length >= 2;
}

export function warmupConfigured() {
  const config = readConfig();
  return Boolean(config.warmup?.enabled && poolParticipants(config).length >= 2);
}

/** 今日已发业务邮件数（审计推导），仅供参考展示；预热自身的量由本轮内计数约束。 */
export function todayBudget() {
  const config = readConfig();
  const db = load();
  if (!db.startedAt) {
    return { startedAt: null, cap: null, note: '预热未启动（warmup.enabled=false 或池内不足 2 个邮箱）' };
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

const CONTENT_VARIANTS = [
  (tag) => ({ subject: `${WARMUP_TAG} ${tag} Quick hello`, body: `Hi team,\n\nTesting our sending setup — replying keeps the thread alive.\n\nRef: ${tag}\n` }),
  (tag) => ({ subject: `${WARMUP_TAG} ${tag} Checking in`, body: `Hey,\n\nJust making sure our mailbox is healthy. A short reply would help.\n\nRef: ${tag}\n` }),
  (tag) => ({ subject: `${WARMUP_TAG} ${tag} Ping`, body: `Hi there,\n\nRoutine deliverability check between our own inboxes.\n\nRef: ${tag}\n` }),
  (tag) => ({ subject: `${WARMUP_TAG} ${tag} Weekly note`, body: `Hello,\n\nAnother note to keep conversations natural. Reply when you get a chance.\n\nRef: ${tag}\n` }),
];

/** 可选 AI 生成一句自然的话（失败回退模板）。 */
async function aiWarmupText(tag) {
  const config = readConfig();
  if (!config.deepseek?.apiKey || config.warmup?.aiTexts === false) {
    return null;
  }
  try {
    const response = await fetch(`${String(config.deepseek.baseURL ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.deepseek.apiKey}` },
      body: JSON.stringify({
        model: config.deepseek.model ?? 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Write a SHORT casual internal email (<=40 words) between colleagues at a trading company. Plain text. Output JSON {"subject":"...","body":"..."}. Do not mention that it is a test.' },
          { role: 'user', content: `ref:${tag}` },
        ],
        temperature: 1,
        max_tokens: 120,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null);
    const parsed = JSON.parse((payload?.choices?.[0]?.message?.content ?? '{}').replace(/^```json\s*|```\s*$/g, ''));
    if (!parsed.subject || !parsed.body) {
      return null;
    }
    return { subject: `${WARMUP_TAG} ${tag} ${String(parsed.subject).slice(0, 60)}`, body: `${String(parsed.body)}\n\nRef: ${tag}\n` };
  } catch {
    return null;
  }
}

/** 收件侧互动：回复 + 标星已读 + 尽力从垃圾箱挪回 INBOX。 */
async function engageReceiver(receiver, participantEmails, tag) {
  if (!receiver.imap) {
    return null;
  }
  let session;
  try {
    session = await imapLogin(receiver.imap);
    await imapSelect(session, receiver.imap.mailbox ?? 'INBOX');
    const others = participantEmails.filter((email) => email !== receiver.email);
    // 1) 找池内其他邮箱发来的预热邮件 → 自动回复 + 标星已读
    let replied = false;
    for (const senderEmail of others) {
      const seqs = await imapSearchFrom(session, senderEmail, new Date(Date.now() - 3 * 86_400_000)).catch(() => []);
      for (const seq of seqs.slice(-3).reverse()) {
        const message = await imapFetchMessage(session, seq, { maxBody: 500 }).catch(() => null);
        if (!message?.subject?.includes(WARMUP_TAG)) {
          continue;
        }
        if (!replied) {
          try {
            await sendMail(
              receiver.smtp,
              { from: receiver.email, to: senderEmail, subject: `Re: ${message.subject}`, body: `Got it — thanks!\n\nRef: ${tag}`, inReplyTo: message.messageId },
            );
            replied = true;
          } catch {}
        }
        try {
          await session.exec(`STORE ${seq} +FLAGS (\\Seen \\Flagged)`);
        } catch {}
        break;
      }
      if (replied) {
        break;
      }
    }
    // 2) 救垃圾箱：预热邮件被判垃圾时挪回 INBOX（服务器不支持 MOVE 则静默跳过）
    let rescued = 0;
    for (const spamBox of SPAM_MAILBOXES) {
      try {
        await imapSelect(session, spamBox);
      } catch {
        continue; // 该服务商没有这个邮箱夹
      }
      for (const senderEmail of others) {
        const seqs = await imapSearchFrom(session, senderEmail, new Date(Date.now() - 7 * 86_400_000)).catch(() => []);
        for (const seq of seqs.slice(-5)) {
          try {
            await session.exec(`UID MOVE ${seq} INBOX`);
            rescued += 1;
          } catch {}
        }
      }
      if (rescued > 0) {
        break;
      }
    }
    return { replied, rescued };
  } catch {
    return null;
  } finally {
    if (session) {
      await imapLogout(session);
    }
  }
}

/**
 * 一轮预热：池内按天轮换配对互发（每发件方 1 封，受其自身爬坡额度约束），
 * 再对有 IMAP 的接收方跑互动自动化。
 */
export async function runWarmupRound({ signal } = {}) {
  const config = readConfig();
  // dry_run 总闸优先：预热也只做真实发送，总闸开着就一封都不发（也不写当日 latch）
  if (config.smtp?.dryRun !== false) {
    return { skipped: 'smtp.dry_run=true：预热不发送真实邮件' };
  }
  const pool = poolParticipants(config);
  if (!warmupConfiguredPool(pool)) {
    throw new Error('预热池不足：需要至少 2 个邮箱（主 smtp.from + smtp.accounts 或 warmup.partners）');
  }
  const db = load();
  db.startedBy = db.startedBy ?? {};
  if (!db.startedAt) {
    db.startedAt = new Date().toISOString();
  }
  const today = new Date().toISOString().slice(0, 10);
  if (db.log.some((entry) => entry.day === today)) {
    return { skipped: `今天(${today})已跑过一轮`, day: today };
  }
  // 每个邮箱独立爬坡计时
  for (const participant of pool) {
    if (!db.startedBy[participant.email]) {
      db.startedBy[participant.email] = new Date().toISOString();
    }
  }
  save(db);

  // 发送侧：按天偏移轮换配对，每发件方受自身 rampCap 约束
  const dayOffset = Math.floor(Date.now() / 86_400_000);
  const results = [];
  const sentByParticipant = new Map();
  const maxPerDay = Number(config.warmup?.maxPerDay ?? 30);
  const budgetOf = (participant) => {
    const days = Math.floor((Date.now() - Date.parse(db.startedBy[participant.email])) / 86_400_000);
    return rampCap(days, maxPerDay);
  };

  for (const [senderIdx, receiverIdx] of pairRotation(pool.length, dayOffset)) {
    if (signal?.aborted) {
      break;
    }
    const sender = pool[senderIdx];
    const receiver = pool[receiverIdx];
    if (sentByParticipant.get(sender.email) >= budgetOf(sender)) {
      results.push({ leg: 'skipped', from: sender.email, ok: false, error: `已达自身爬坡上限 ${budgetOf(sender)}` });
      continue;
    }
    const tag = randomUUID().slice(0, 8);
    const variant = CONTENT_VARIANTS[parseInt(createHash('md5').update(tag).digest('hex').slice(0, 4), 16) % CONTENT_VARIANTS.length];
    const content = (await aiWarmupText(tag)) ?? variant(tag);
    try {
      await sendMail(sender.smtp, {
        from: sender.email, fromName: sender.smtp?.fromName,
        to: receiver.email, toName: 'Warmup Pool',
        subject: content.subject, body: content.body,
      });
      sentByParticipant.set(sender.email, (sentByParticipant.get(sender.email) ?? 0) + 1);
      audit('email.warmup', { leg: 'pool', from: sender.email, to: receiver.email, tag }, 'cron');
      results.push({ leg: 'pool', from: sender.email, to: receiver.email, ok: true });
    } catch (error) {
      results.push({ leg: 'pool', from: sender.email, to: receiver.email, ok: false, error: String(error?.message ?? error).slice(0, 120) });
    }
  }

  // 收件侧互动（并行度 1，避免 IMAP 会话打架）
  for (const receiver of pool) {
    if (!receiver.imap || signal?.aborted) {
      continue;
    }
    const engagement = await engageReceiver(receiver, pool.map((p) => p.email), randomUUID().slice(0, 8));
    if (engagement) {
      results.push({ leg: 'engage', email: receiver.email, ok: true, ...engagement });
      audit('warmup.engage', { email: receiver.email, replied: engagement.replied, rescued: engagement.rescued }, 'cron');
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
  audit('warmup.round', { day: today, legs: results.length, ok: okCount }, 'cron');
  return { day: today, results };
}

export function warmupStatus() {
  const config = readConfig();
  const db = load();
  const pool = poolParticipants(config);
  const maxPerDay = Number(config.warmup?.maxPerDay ?? 30);
  return {
    configured: warmupConfigured(),
    startedAt: db.startedAt,
    budget: todayBudget(),
    pool: pool.map((participant) => {
      const startedAt = db.startedBy?.[participant.email] ?? null;
      const days = startedAt ? Math.floor((Date.now() - Date.parse(startedAt)) / 86_400_000) : null;
      return {
        email: participant.email,
        hasImap: Boolean(participant.imap),
        startedAt,
        cap: startedAt ? rampCap(days, maxPerDay) : null,
      };
    }),
    recentLog: db.log.slice(-7).reverse(),
  };
}
