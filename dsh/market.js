// 蓝海选国：同一产品在多个市场跑一次基础搜索，对比
//  「结果量(供给/竞争噪声) × 买家信号密度(需求)」→ 机会评分排名。
// 启发式说明：结果少但买家信号多 = 蓝海（需求在、同行没铺开）；
// 结果巨多且全是平台站 = 红海。评分只是搜索侧启发，结合海关数据更准。
import { readConfig } from './config.js';
import { resolveMarket, MARKETS } from './markets.js';
import { serpSearchChained } from './serp.js';

const BUYER_SIGNAL_RE = /whatsapp|\bwe buy\b|looking for|need supplier|importer|distribuidor|compramos|buscamos|wholesal/i;
const PLATFORM_RE = /alibaba|made-in-china|globalsources|amazon|indiamart/i;

export async function scanMarkets({ product, markets, perMarket = 8, signal } = {}) {
  if (!product || !String(product).trim()) {
    throw new Error('market_scan needs an English product keyword');
  }
  const config = readConfig();
  const keys = (Array.isArray(markets) && markets.length > 0 ? markets : ['mx', 'us', 'br', 'de', 'ae', 'id'])
    .map((key) => resolveMarket(key).key);
  const unique = [...new Set(keys)].slice(0, 10);

  const results = [];
  for (const key of unique) {
    if (signal?.aborted) {
      break;
    }
    const market = resolveMarket(key);
    const query = `"${product}" WhatsApp +${market.dial}`.trim();
    try {
      const { results: items, engine } = await serpSearchChained(query, {
        config,
        maxResults: perMarket,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      const buyerSignals = items.filter((item) => BUYER_SIGNAL_RE.test(`${item.title} ${item.snippet}`)).length;
      const platformNoise = items.filter((item) => PLATFORM_RE.test(item.url)).length;
      results.push({
        market: key,
        label: market.label,
        dial: market.dial,
        style: market.style,
        engine,
        query,
        results: items.length,
        buyerSignals,
        platformNoise,
      });
    } catch (error) {
      results.push({ market: key, label: market.label, error: String(error?.message ?? error).slice(0, 120) });
    }
    // 礼貌间隔
    await new Promise((resolve) => setTimeout(resolve, 900 + Math.floor(Math.random() * 500)));
  }

  const scored = results
    .filter((item) => !item.error)
    .map((item) => {
      // 机会分：买家信号为主，供给噪声为负；结果量适中加分（说明有市场活动）。
      // 钳制到 0-100：小样本(1条结果1命中=300分"必蓝海")的统计爆炸要压掉
      const demand = item.buyerSignals * 3;
      const noise = item.platformNoise * 2 + Math.max(0, item.results - 6);
      const opportunity = Math.min(100, Math.max(0, Math.round(((demand - noise) / Math.max(item.results, 1)) * 100)));
      return { ...item, opportunity, lowSample: item.results < 3 };
    })
    .sort((a, b) => b.opportunity - a.opportunity);

  const ranked = scored.map((item, index) => ({
    rank: index + 1,
    market: item.market,
    label: item.label,
    opportunity: item.opportunity,
    verdict: (item.lowSample ? '⚪ 样本太少，' : '') + (item.opportunity >= 60 ? '🔵 蓝海' : item.opportunity >= 30 ? '🟡 可试' : '🔴 红海/信号弱'),
    results: item.results,
    buyerSignals: item.buyerSignals,
    platformNoise: item.platformNoise,
    query: item.query,
  }));

  return {
    product,
    scanned: scored.length,
    failed: results.filter((item) => item.error),
    ranking: ranked,
    hint: '蓝海=买家信号密度高而平台噪声低。搜索侧启发仅供参考：结合海关数据、本地零售平台（MercadoLibre/Jumia等）人工复核再压货。',
  };
}
