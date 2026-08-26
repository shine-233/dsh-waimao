// 回复扫描闭环：IMAP 拉买家回复 → AI 分类（感兴趣/询价/不感兴趣/自动回复/
// 退订）→ 自动改 CRM 状态 replied → 停邮件序列 → 退订自动进抑制列表。
// 这是 v0.2 断掉的"发出去之后的回路"。
import { readConfig } from '../config.js';
import * as crm from '../crm.js';
import * as suppress from '../suppress.js';
import { stopSequence } from './sequence.js';
import { imapLogin, imapSelect, imapSearch, imapSearchFrom, imapFetchMessage, imapLogout, imapDate } from './imap.js';
import { audit } from '../audit.js';

const RULES = [
  { category: 'bounce', re: /undeliverable|delivery (status|failure) notification|returned mail|mailbox (not found|unavailable|full)|address does not exist|user unknown|recipient rejected|no such user|退信/i },
  { category: 'unsubscribe', re: /\bunsubscribe\b|\bopt[- ]?out\b|don'?t (want|email|contact|message)|remove me|take me off|no longer wish|stop emailing|退订|不要再联系/i },
  { category: 'not-interested', re: /not interested|no thanks|we (are )?covered|don'?t need|no need|not looking|不感兴趣|暂无需求/i },
  { category: 'wrong-person', re: /\bwrong person\b|i (have )?(left|quit) (the )?company|no longer with (the )?company|try reaching|i'?m not the right|已离职|不是我负责/i },
  { category: 'referral', re: /cc'?ing|forward(ed|ing)? (this|to)|colleague who handles|let me (connect|introduce) you to|推荐联系/i },
  { category: 'ooo', re: /out of (the )?office|annual leave|vacation until|back (on|in) (monday|the office)|自动回复/i },
  { category: 'auto', re: /\bauto(matic)?[- ]?reply\b|mailer-daemon|postmaster@|no-?reply@/i },
  { category: 'meeting', re: /\b(call|meeting|demo|zoom|teams|google meet)\b|\bschedule[d]?\b|calendar|available|slot|约个?(电话|会议|时间)/i },
  { category: 'interested', re: /interested|send (me |us )?(the )?(catalog|price|quotation|quote|sample)|more (info|details)|pricing|moq|lead time|报价|目录|感兴趣/i },
];

// 页脚承诺的 "reply STOP/ALTO/PARAR" 退订：正文以关键词开头且极短才算，
// 避免把 "we will stop ordering" 这类正常商务句子误判成退订
const SHORT_STOP_RE = /^\s*(?:re\s*:\s*)?(stop|alto|parar)\b[\s!.]{0,10}$/i;

export function classifyReply(text, subject = '') {
  if (SHORT_STOP_RE.test(String(text ?? '').trim())) {
    return { category: 'unsubscribe', by: 'rules' };
  }
  const haystack = `${subject} ${text}`.slice(0, 3000);
  for (const rule of RULES) {
    if (rule.re.test(haystack)) {
      return { category: rule.category, by: 'rules' };
    }
  }
  return { category: 'other', by: 'rules' };
}

async function aiClassify(text, subject) {
  const config = readConfig();
  if (!config.deepseek.apiKey) {
    return null;
  }
  const response = await fetch(`${config.deepseek.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.deepseek.apiKey}` },
    body: JSON.stringify({
      model: config.deepseek.model ?? 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: [
            '你是外贸销售助理，分类买家回复。只输出 JSON：',
            '{"category":"interested|meeting|pricing|question|not-interested|wrong-person|referral|ooo|auto|unsubscribe|bounce|other","summary":"一句话中文摘要","suggested_action":"一句中文建议"}',
            'interested=表达兴趣/要看样品；meeting=明确约电话/会议/demo；pricing=询价要目录；question=决策前提问(倾向按 interested 处理)；not-interested=明确拒绝；wrong-person=已离职/不负责，建议找对的人；referral=转给同事处理；ooo=休假自动回复；auto=系统自动邮件；unsubscribe=要求退订；bounce=退信/投递失败通知(地址已失效)。短肯定回复(sure/sounds good)归 interested。',
          ].join('\n'),
        },
        { role: 'user', content: `Subject: ${subject}\n\n${String(text).slice(0, 2500)}` },
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  }
  const parsed = JSON.parse((payload?.choices?.[0]?.message?.content ?? '{}').replace(/^```json\s*|```\s*$/g, ''));
  if (!parsed.category) {
    return null;
  }
  return {
    category: String(parsed.category),
    summary: String(parsed.summary ?? '').slice(0, 200),
    suggestedAction: String(parsed.suggested_action ?? '').slice(0, 200),
    by: 'ai',
  };
}

function extractEmail(fromHeader) {
  const match = String(fromHeader ?? '').match(/[\w.+-]+@[\w.-]+/);
  return match ? match[0].toLowerCase() : '';
}

/**
 * 扫描一轮回复。opts: {days(回溯天数,默认14), limit(最多检查线索数,默认30),
 * useAI(默认true), signal}
 * @returns {{scanned, replies: Array, errors: Array}}
 */
export async function scanReplies(opts = {}) {
  const config = readConfig();
  if (!config.imap?.host || !config.imap?.user) {
    throw new Error('IMAP 未配置：请在 ~/.waimao/config.json 填 imap.host/user/pass');
  }
  const days = Math.min(Math.max(opts.days ?? 14, 1), 90);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const since = new Date(Date.now() - days * 86_400_000);

  // 有外发记录的线索（contacted/replied/quoted 状态）
  const candidates = crm
    .listLeads({ limit: 500 })
    .filter((lead) => lead.contacts.emails?.length && ['contacted', 'replied', 'quoted'].includes(lead.status))
    .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))
    .slice(0, limit);

  const session = await imapLogin(config.imap);
  const replies = [];
  const errors = [];
  let scanned = 0;
  try {
    await imapSelect(session, config.imap.mailbox ?? 'INBOX');
    for (const lead of candidates) {
      if (opts.signal?.aborted) {
        break;
      }
      const leadEmail = lead.contacts.emails[0];
      if (suppress.isSuppressed(leadEmail)) {
        continue;
      }
      try {
        const seqs = await imapSearchFrom(session, leadEmail, since);
        if (seqs.length === 0) {
          continue;
        }
        scanned += 1;
        // 只看最新的 2 封（旧的可能已经处理过）
        for (const seq of seqs.slice(-2).reverse()) {
          const message = await imapFetchMessage(session, seq);
          const fromAddr = extractEmail(message.from);
          if (fromAddr !== leadEmail) {
            continue; // 安全：只认发件人精确匹配
          }
          // 已处理过这封（按 messageId 去重；messageId 为空时绝不能当成"已处理"，
          // 否则该线索的所有回复会被永久跳过）
          const messageId = String(message.messageId ?? '').trim();
          const seen = Boolean(messageId) && (lead.activities ?? []).some((activity) => activity.type === 'reply' && (activity.note ?? '').includes(messageId));
          if (seen) {
            continue;
          }
          // 分类走成本漏斗：规则层（免费、确定性：退订/退信/OOO 等）先过滤，
          // 只有规则判为 other 的模糊回复才调 AI（学 gtm-mcp 的 3-tier funnel）
          const ruleResult = classifyReply(message.body, message.subject);
          const classification = ruleResult.category !== 'other' || opts.useAI === false
            ? ruleResult
            : (await aiClassify(message.body, message.subject).catch(() => null)) ?? ruleResult;

          // 退订 → 抑制列表；退信 → 抑制 + 整个域名拉黑
          if (classification.category === 'unsubscribe' || classification.category === 'bounce') {
            suppress.suppress(leadEmail, classification.category === 'bounce' ? 'hard-bounce' : 'unsubscribe-reply', 'cron');
            if (classification.category === 'bounce') {
              try {
                suppress.blacklistDomain(suppress.domainOf(leadEmail), 'hard-bounce', 'cron');
              } catch {}
            }
          }

          // 更新 CRM：状态 replied + 停序列 + 记活动
          const lead2 = crm.getLead(lead.id);
          const sequence = lead2?.sequence ? stopSequence(lead2.sequence, `buyer replied: ${classification.category}`) : undefined;
          crm.updateLead(lead.id, {
            status: 'replied',
            ...(sequence ? { sequence } : {}),
            lastReply: {
              messageId,
              category: classification.category,
              summary: classification.summary ?? message.subject,
              ts: message.date || new Date().toISOString(),
            },
          }, {
            activityNote: `📩 回复[${classification.category}] ${messageId} ${(classification.summary ?? message.subject).slice(0, 120)}${classification.suggestedAction ? ` | 建议: ${classification.suggestedAction}` : ''}`,
          });
          audit('email.reply', { leadId: lead.id, category: classification.category, messageId: message.messageId }, 'cron');
          replies.push({
            leadId: lead.id, company: lead.company || lead.domain, from: leadEmail,
            subject: message.subject, category: classification.category,
            summary: classification.summary, suggestedAction: classification.suggestedAction,
            bodyPreview: message.body.slice(0, 300),
          });
          break; // 每个线索处理最新一封即可
        }
      } catch (error) {
        errors.push({ leadId: lead.id, error: String(error?.message ?? error).slice(0, 150) });
      }
    }

    // —— 退信(DSN)扫描：投递失败通知的 From 是 mailer-daemon/postmaster，
    // 上面的按发件人搜索够不到。单独搜一轮，从正文提取失败地址，
    // 命中候选线索即进抑制列表（继续发伤域名信誉）。
    try {
      const dsnSeqs = await imapSearch(session, `OR FROM "mailer-daemon" FROM "postmaster" SINCE ${imapDate(since)}`);
      const knownEmails = new Map();
      for (const lead of candidates) {
        for (const email of lead.contacts.emails) {
          knownEmails.set(String(email).toLowerCase(), lead);
        }
      }
      let bounced = 0;
      for (const seq of dsnSeqs.slice(-10).reverse()) {
        const message = await imapFetchMessage(session, seq, { maxBody: 4000 });
        const haystack = `${message.subject} ${message.body}`;
        if (!/\b(undeliver|delivery status|returned mail|failure|user unknown|address (not found|does not exist)|no longer on server)\b/i.test(haystack)) {
          continue;
        }
        const mentioned = new Set([...haystack.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map((m) => m[0].toLowerCase()));
        for (const addr of mentioned) {
          const hit = knownEmails.get(addr);
          if (!hit || suppress.isSuppressed(addr)) {
            continue;
          }
          suppress.suppress(addr, 'hard-bounce', 'cron');
          try {
            suppress.blacklistDomain(suppress.domainOf(addr), 'hard-bounce', 'cron');
          } catch {}
          crm.addActivity(hit.id, { type: 'bounce', note: `退信(${String(message.subject).slice(0, 80)})，地址已进抑制列表`, actor: 'cron' });
          const fresh = crm.getLead(hit.id);
          if (fresh?.sequence && fresh.status !== 'replied') {
            crm.updateLead(hit.id, { sequence: stopSequence(fresh.sequence, 'hard bounce') });
          }
          bounced += 1;
          replies.push({
            leadId: hit.id, company: hit.company || hit.domain, from: addr,
            subject: message.subject, category: 'bounce',
            summary: '投递失败通知，地址已抑制', bodyPreview: message.body.slice(0, 300),
          });
        }
      }
      if (bounced > 0) {
        audit('email.bounce.suppressed', { count: bounced }, 'cron');
      }
    } catch (error) {
      errors.push({ dsnScan: String(error?.message ?? error).slice(0, 150) });
    }
  } finally {
    await imapLogout(session);
  }
  return { scanned, replies, errors, checked: candidates.length };
}
