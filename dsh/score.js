// 客户评分：规则分(0-6)打底，可选 AI 精调(0-6) 合成 0-12 分。
// 分级：🔴极高(10-12) / 🟠高(7-9) / 🟡中(4-6) / 🟢低(1-3)。
// AI 走 DeepSeek 兼容接口，输出严格 JSON；失败时回退纯规则分。
import { readConfig } from './config.js';

const RULE_SIGNALS = [
  { re: /we buy|we purchase|we import|compramos|importamos/, points: 3, why: '明确采购动词' },
  { re: /looking for|seeking|need supplier|buscamos proveedor|distributor wanted/, points: 3, why: '寻找供应商' },
  { re: /wholesale|distribuidor|distributor|importer|mayorista/, points: 2, why: '批发/分销角色' },
  { re: /request a quote|get a quote|rfq|cotizar|cotizacion/, points: 1, why: '有询价入口' },
  { re: /whatsapp|\+\d{1,3}[\s-]?\d{3}/, points: 1, why: '有即时联系方式' },
  { re: /store|shop|retail|tienda|our branches|showroom/, points: 1, why: '零售/门店场景' },
];

const RULE_PENALTIES = [
  { re: /we are manufacturer|our factory|somos fabricantes|leading manufacturer/, points: -3, why: '自称制造商(同行)' },
  { re: /alibaba|made-in-china|globalsources|indiamart/, points: -4, why: 'B2B平台' },
  { re: /job|hiring|career|vacante/, points: -2, why: '招聘内容' },
];

/** 规则分 0-6（截断到区间）。 */
export function ruleScore(item) {
  const text = `${item.title ?? ''} ${item.snippet ?? ''} ${item.signalsText ?? ''}`.toLowerCase();
  let points = 1; // 基础分：出现在搜索结果里
  const reasons = [];
  for (const rule of RULE_SIGNALS) {
    if (rule.re.test(text)) {
      points += rule.points;
      reasons.push(`+${rule.points} ${rule.why}`);
    }
  }
  for (const rule of RULE_PENALTIES) {
    if (rule.re.test(text)) {
      points += rule.points;
      reasons.push(`${rule.points} ${rule.why}`);
    }
  }
  const score = Math.max(0, Math.min(6, points));
  return { ruleScore: score, reasons };
}

export function tierOf(score) {
  if (score >= 10) {
    return { tier: '极高', emoji: '🔴' };
  }
  if (score >= 7) {
    return { tier: '高', emoji: '🟠' };
  }
  if (score >= 4) {
    return { tier: '中', emoji: '🟡' };
  }
  if (score >= 1) {
    return { tier: '低', emoji: '🟢' };
  }
  return { tier: '排除', emoji: '⚪' };
}

async function aiScore({ product, market, text, knowledge, icp }) {
  const config = readConfig();
  if (!config.deepseek.apiKey) {
    return null;
  }
  const system = [
    '你是外贸客户意向评估专家。根据线索文本判断其作为买家（进口商/批发商/经销商/零售商）的采购意向强度。',
    icp ? `我方 ICP：${icp}。判断该线索是否属于这个范围，给出 fit 字段：yes=对口 / partial=沾边 / no=不对口。` : '',
    '只输出 JSON：{"score":0-6的整数,"fit":"yes|partial|no","reasons":["原因"],"advice":"一句开发建议(中文)"}。reasons 里第一条用中文说明为什么合适/不合适我方产品。不要输出其他内容。',
    knowledge ? `企业知识参考：${knowledge}` : '',
  ].filter(Boolean).join('\n');
  const response = await fetch(`${config.deepseek.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.deepseek.apiKey}` },
    body: JSON.stringify({
      model: config.deepseek.model ?? 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `我方产品: ${product ?? ''}\n目标市场: ${market ?? ''}\n线索内容: ${text.slice(0, 3000)}` },
      ],
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  }
  const content = payload?.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content.replace(/^```json\s*|```\s*$/g, ''));
  const score = Math.max(0, Math.min(6, Number(parsed.score) || 0));
  const fit = ['yes', 'partial', 'no'].includes(parsed.fit) ? parsed.fit : null;
  return {
    aiScore: score,
    fit,
    aiReasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5) : [],
    advice: String(parsed.advice ?? '').slice(0, 200),
  };
}

/**
 * 综合评分。opts: {product, market, item:{title,snippet,signalsText,html?}, useAI, knowledge}
 * product/market 缺省时回落到 config.icp。
 * 返回 {score(0-12), tier, emoji, fit?, reasons[], advice}
 */
export async function scoreLead(opts) {
  const config = readConfig();
  const base = ruleScore(opts.item ?? {});
  const product = opts.product || config.icp?.product || '';
  const icpBuyers = config.icp?.buyers || '';
  const icpText = [product, icpBuyers].filter(Boolean).join('；买家类型：');
  let ai = null;
  if (opts.useAI !== false) {
    try {
      ai = await aiScore({
        product,
        market: opts.market,
        text: `${opts.item?.title ?? ''} ${opts.item?.snippet ?? ''} ${opts.item?.signalsText ?? ''}`,
        knowledge: opts.knowledge,
        icp: icpText || null,
      });
    } catch {
      ai = null; // 静默回退规则分
    }
  }
  const score = Math.min(12, base.ruleScore + (ai?.aiScore ?? 0));
  const { tier, emoji } = tierOf(score);
  const advice = ai?.advice ?? (tier === '极高' || tier === '高' ? '建议优先 WhatsApp/邮件触达，附产品图与FOB参考价' : '放入培育列表，定期跟进');
  return {
    score,
    tier,
    emoji,
    fit: ai?.fit ?? null,
    reasons: [...base.reasons, ...(ai?.aiReasons ?? [])],
    advice: ai?.fit === 'no' ? `与我方产品不对口：${advice}` : advice,
    scoredBy: ai ? 'rules+ai' : 'rules',
  };
}
