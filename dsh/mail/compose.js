// 开发信撰写：优先 DeepSeek 生成个性化版本（带知识库上下文），失败回退模板。
// 只生成草稿，不发送 —— 发送永远在 mail/sequence.js 或 email_send 工具里，
// 且受 smtp.dry_run 总闸约束。
import { readConfig } from '../config.js';
import { firstEmail, followUp, languageFor } from './templates.js';

const SYSTEM = {
  en: 'You are a top-performing foreign-trade sales rep. Write a SHORT cold email (<=120 words), plain text, no HTML, no placeholders left unfilled. End with one clear question CTA. Output JSON: {"subject":"...","body":"..."}',
  es: 'Eres un vendedor internacional de élite. Escribe un email corto (<=120 palabras), texto plano, sin HTML, sin marcadores sin rellenar. Cierra con una pregunta clara. Output JSON: {"subject":"...","body":"..."}',
};

async function aiWrite({ language, product, market, company, name, knowledge, me, features, buyers, kind, step }) {
  const config = readConfig();
  if (!config.deepseek.apiKey) {
    return null;
  }
  const task = kind === 'followup'
    ? `Write follow-up email #${step} (day ${step === 1 ? 3 : step === 2 ? 7 : 14}). Polite, short, give an easy out.`
    : 'Write the FIRST cold email.';
  const response = await fetch(`${config.deepseek.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.deepseek.apiKey}` },
    body: JSON.stringify({
      model: config.deepseek.model ?? 'deepseek-chat',
      messages: [
        { role: 'system', content: `${SYSTEM[language] ?? SYSTEM.en}\n${task}\nOutput JSON only.` },
        {
          role: 'user',
          content: [
            `From rep: ${me}`,
            `Our product: ${product}`,
            buyers ? `Who we are looking for: ${buyers}` : '',
            `Our strengths: ${features ?? 'factory direct, stable quality, fast lead time'}`,
            `Target company: ${company ?? ''} contact: ${name ?? 'unknown'}`,
            `Target market: ${market ?? ''}`,
            knowledge ? `Verified facts you may cite: ${knowledge}` : '',
          ].filter(Boolean).join('\n'),
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  }
  const parsed = JSON.parse((payload?.choices?.[0]?.message?.content ?? '{}').replace(/^```json\s*|```\s*$/g, ''));
  if (!parsed.subject || !parsed.body) {
    throw new Error('AI draft missing subject/body');
  }
  return { subject: String(parsed.subject).slice(0, 200), body: String(parsed.body) };
}

/**
 * 撰写开发信/跟进。
 * opts: {kind:'first'|'followup', step?, name, company, product, buyers?, market, me, features, language?, knowledge?, useAI?}
 */
export async function composeEmail(opts) {
  const language = opts.language ?? languageFor(opts.market);
  const fallback = opts.kind === 'followup'
    ? followUp({ ...opts, language }, opts.step ?? 1)
    : firstEmail({ ...opts, language });
  if (opts.useAI === false) {
    return { ...fallback, generatedBy: 'template' };
  }
  try {
    const ai = await aiWrite({ ...opts, language });
    if (ai) {
      return { language, subject: ai.subject, body: ai.body, generatedBy: 'ai' };
    }
  } catch {
    // 回退模板
  }
  return { ...fallback, generatedBy: 'template' };
}
