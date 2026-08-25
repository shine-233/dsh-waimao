// 口播脚本生成器（TikTok/Reels/Shorts）：AI 生成 hook→痛点→产品→CTA 结构的
// 短视频脚本，带分镜时间轴。无 key 时回退到固定结构模板。
import { readConfig } from './config.js';

const FALLBACK = ({ product, audience, seconds }) => ({
  duration: `${seconds}s`,
  hook: { t: '0-3s', text: `Stop scrolling if you need ${product}!` },
  scenes: [
    { t: '3-10s', text: `Problem: most ${audience} waste time and money on the wrong ${product}.` },
    { t: '10-20s', text: `Product: this is our ${product} — factory direct, tested quality, fast shipping. Show close-ups.` },
    { t: '20-28s', text: `Proof: show certifications, warehouse, packing line. Text overlay: "MOQ friendly".` },
  ],
  cta: { t: '28-30s', text: 'WhatsApp us for the catalog — link in bio.' },
  hashtags: [`#${product.replace(/\s+/g, '')}`, '#wholesale', '#factorydirect', '#b2b'],
  generatedBy: 'template',
});

export async function videoScript({ product, audience = 'importers & wholesalers', platform = 'tiktok', seconds = 30, language = 'en', tone = 'energetic' } = {}) {
  if (!product || !String(product).trim()) {
    throw new Error('video_script needs a product');
  }
  const config = readConfig();
  if (!config.deepseek.apiKey) {
    return FALLBACK({ product, audience, seconds });
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
            `You are a short-video scriptwriter for B2B export marketing on ${platform}.`,
            `Write a ${seconds}-second script in ${language}, ${tone} tone.`,
            'Output JSON only: {"hook":{"t":"0-3s","text":"..."},"scenes":[{"t":"...","text":"..."}],"cta":{"t":"...","text":"..."},"hashtags":["..."]}',
            'Hook must stop the scroll in 3 seconds. Scenes include visual directions in brackets. 3-4 scenes max.',
          ].join('\n'),
        },
        { role: 'user', content: `Product: ${product}\nAudience: ${audience}` },
      ],
      temperature: 0.8,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return FALLBACK({ product, audience, seconds });
  }
  try {
    const parsed = JSON.parse((payload?.choices?.[0]?.message?.content ?? '{}').replace(/^```json\s*|```\s*$/g, ''));
    if (!parsed.hook || !Array.isArray(parsed.scenes)) {
      return FALLBACK({ product, audience, seconds });
    }
    return { duration: `${seconds}s`, ...parsed, generatedBy: 'ai' };
  } catch {
    return FALLBACK({ product, audience, seconds });
  }
}

/** 渲染成可直接照念的分镜表文本。 */
export function renderScript(script) {
  const lines = [`⏱ ${script.duration ?? '30s'}`, '', `🎬 HOOK [${script.hook?.t ?? '0-3s'}]`, script.hook?.text ?? '', ''];
  for (const scene of script.scenes ?? []) {
    lines.push(`🎬 [${scene.t ?? ''}]`, scene.text ?? '', '');
  }
  lines.push(`🎬 CTA [${script.cta?.t ?? ''}]`, script.cta?.text ?? '', '');
  if (Array.isArray(script.hashtags) && script.hashtags.length > 0) {
    lines.push(script.hashtags.join(' '));
  }
  lines.push('', `— generatedBy: ${script.generatedBy ?? 'template'}`);
  return lines.join('\n');
}
