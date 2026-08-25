// AI 草稿：直接调 DeepSeek 兼容接口给一条待审消息生成客服回复草稿。
// 没配 key 时报错并提示走 dsh 智能体起草（智能体本来就会写）。
import { readConfig } from './config.js';

const SYSTEM_PROMPT = [
  '你是一名专业的外贸业务员助理，用 WhatsApp 跟进海外买家。',
  '根据聊天历史生成一条简短、礼貌、推动成交的英文回复（可附一句西语/阿语问候视对方语言而定）。',
  '不要编造价格和货期；涉及报价时引导客户提供数量与规格。',
  '只输出回复正文本身，不要任何解释、引号或前缀。',
].join('\n');

export async function draftReply({ history, buyerName, product }) {
  const config = readConfig();
  if (!config.deepseek.apiKey) {
    throw new Error(
      '未配置 deepseek.apiKey：可在 ~/.waimao/config.json 配置，或直接让 dsh 智能体起草后调用 wa_reply 发送',
    );
  }
  const context = [
    buyerName ? `买家称呼: ${buyerName}` : '',
    product ? `我方产品: ${product}` : '',
    '最近聊天记录(按时间):',
    ...(history ?? []).map((item) => `${item.fromMe ? '我方' : '买家'}: ${item.text}`),
  ]
    .filter(Boolean)
    .join('\n');
  const response = await fetch(`${config.deepseek.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.deepseek.apiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseek.model ?? 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: context },
      ],
      temperature: 0.6,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.message ?? response.status;
    throw new Error(`DeepSeek API ${detail}`);
  }
  const text = payload?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('DeepSeek returned an empty draft');
  }
  return text;
}
