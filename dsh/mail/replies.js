// 回复扫描闭环：IMAP 拉买家回复 → AI 分类（感兴趣/询价/不感兴趣/自动回复/
// 退订）→ 自动改 CRM 状态 replied → 停邮件序列 → 退订自动进抑制列表。
// 这是 v0.2 断掉的"发出去之后的回路"。
import { readConfig } from '../config.js';
import * as crm from '../crm.js';
import * as suppress from '../suppress.js';
import { stopSequence } from './sequence.js';
import { imapLogin, imapSelect, imapSearchFrom, imapFetchMessage, imapLogout } from './imap.js';
import { audit } from '../audit.js';

const RULES = [
  { category: 'unsubscribe', re: /\bunsubscribe\b|\bopt[- ]?out\b|don'?t (want|contact)|remove me|退订|不要再联系/i },
  { category: 'not-interested', re: /not interested|no thanks|we (are )?covered|don'?t need|no need|不感兴趣|暂无需求/i },
  { category: 'ooo', re: /out of (the )?office|annual leave|vacation until|back (on|in) (monday|the office)|自动回复/i },
  { category: 'auto', re: /\bauto(matic)?[- ]?reply\b|delivery status|undeliverable|mailer-daemon|postmaster@|no-?reply@/i },
  { category: 'interested', re: /interested|send (me |us )?(the )?(catalog|price|quotation|quote|sample)|more (info|details)|pricing|moq|lead time|报价|目录|感兴趣/i },
];

export function classifyReply(text, subject = '') {
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
            '{"category":"interested|pricing|not-interested|ooo|auto|unsubscribe|other","summary":"一句话中文摘要","suggested_action":"一句中文建议"}',
            'interested=表达兴趣/要看样品/约会议；pricing=询价要目录；not-interested=明确拒绝；ooo=休假自动回复；auto=系统自动邮件；unsubscribe=要求退订。',
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
          // 已处理过这封（按 messageId 去重）
          const seen = (lead.activities ?? []).some((activity) => activity.type === 'reply' && (activity.note ?? '').includes(message.messageId));
          if (seen) {
            continue;
          }
          const classification = opts.useAI === false
            ? classifyReply(message.body, message.subject)
            : (await aiClassify(message.body, message.subject).catch(() => null)) ?? classifyReply(message.body, message.subject);

          // 退订 → 抑制列表
          if (classification.category === 'unsubscribe') {
            suppress.suppress(leadEmail, 'unsubscribe-reply', 'cron');
          }

          // 更新 CRM：状态 replied + 停序列 + 记活动
          const lead2 = crm.getLead(lead.id);
          const sequence = lead2?.sequence ? stopSequence(lead2.sequence, `buyer replied: ${classification.category}`) : undefined;
          crm.updateLead(lead.id, {
            status: lead.status === 'quoted' ? 'replied' : 'replied',
            ...(sequence ? { sequence } : {}),
            lastReply: {
              messageId: message.messageId,
              category: classification.category,
              summary: classification.summary ?? message.subject,
              ts: message.date || new Date().toISOString(),
            },
          }, {
            activityNote: `📩 回复[${classification.category}] ${message.messageId} ${(classification.summary ?? message.subject).slice(0, 120)}${classification.suggestedAction ? ` | 建议: ${classification.suggestedAction}` : ''}`,
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
  } finally {
    await imapLogout(session);
  }
  return { scanned, replies, errors, checked: candidates.length };
}
