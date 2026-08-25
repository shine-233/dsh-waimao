// 三层获客编排：逐层搜索 → 逐层去重（URL 归一化，先到先得并保留层级标记）
// → 落盘 JSONL（~/.waimao/data/leads.jsonl）→ 可导出 CSV。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, EXPORT_DIR, readConfig } from './config.js';
import { buildLayers } from './dorks.js';
import { resolveMarket } from './markets.js';
import { serpSearchChained } from './serp.js';

const LEADS_FILE = join(DATA_DIR, 'leads.jsonl');

/** URL 归一化：去协议/www/尾斜杠/utm/锚点，host 小写。 */
export function normalizeUrl(input) {
  try {
    const url = new URL(input);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const drop = [...url.searchParams.keys()].filter((key) =>
      /^(utm_|fbclid|gclid|ref|spm)/i.test(key),
    );
    for (const key of drop) {
      url.searchParams.delete(key);
    }
    const query = url.searchParams.toString();
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.hostname}${path}${query ? `?${query}` : ''}`;
  } catch {
    return String(input ?? '').trim();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function loadRuns(limit = 20) {
  let raw = '';
  try {
    raw = readFileSync(LEADS_FILE, 'utf8');
  } catch {
    return [];
  }
  const runs = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    try {
      runs.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt line
    }
  }
  return runs.slice(-limit).reverse();
}

export function findRun(id) {
  return loadRuns(500).find((run) => run.id === id) ?? null;
}

function appendRun(run) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  appendFileSync(LEADS_FILE, `${JSON.stringify(run)}\n`, { mode: 0o600 });
}

/**
 * Run the layered search. `opts`: product (required), market, layers,
 * perLayer, engine, signal. Returns the run record (also persisted).
 */
export async function runLeadSearch(opts) {
  const product = String(opts.product ?? '').trim();
  if (product === '') {
    throw new Error('lead_search needs a non-empty English product keyword');
  }
  const config = readConfig();
  const market = resolveMarket(opts.market);
  const engine = opts.engine || config.serp.engine || 'ddg';
  const perLayer = Math.min(Math.max(Number(opts.perLayer ?? config.serp.perLayer ?? 10), 1), 50);
  const layers = buildLayers(product, market, { layers: opts.layers });
  if (layers.length === 0) {
    throw new Error('no layer selected (use 1/2/3, e.g. layers [1,3])');
  }

  const seen = new Set();
  const results = [];
  const layerSummaries = [];
  let layerFallbacks = null;

  for (const layer of layers) {
    let items = [];
    let error = null;
    if (engine !== 'literal') {
      try {
        const chained = await serpSearchChained(layer.query, {
          config,
          engine,
          maxResults: perLayer * 2,
          signal: opts.signal,
        });
        items = chained.results;
        if (chained.engine !== engine) {
          layerFallbacks = layerFallbacks ?? [];
          layerFallbacks.push(`${layer.id}:${engine}->${chained.engine}`);
        }
      } catch (cause) {
        error = String(cause?.message ?? cause);
      }
    }
    let added = 0;
    for (const item of items) {
      if (added >= perLayer) {
        break;
      }
      const key = normalizeUrl(item.url);
      if (key === '' || seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({ ...item, layer: layer.id, layerName: layer.name });
      added += 1;
    }
    layerSummaries.push({
      id: layer.id,
      name: layer.name,
      query: layer.query,
      found: items.length,
      added,
      ...(error ? { error } : {}),
    });
    // Politeness between layers so the engine does not rate-limit the next one.
    if (engine !== 'literal' && layer !== layers[layers.length - 1]) {
      await sleep(900 + Math.floor(Math.random() * 600));
    }
  }

  const run = {
    id: `run-${Date.now().toString(36)}`,
    ts: new Date().toISOString(),
    product,
    market: market.key,
    marketLabel: market.label,
    style: market.style,
    engine,
    ...(layerFallbacks ? { engineFallbacks: layerFallbacks } : {}),
    layers: layerSummaries,
    results,
    total: results.length,
  };
  appendRun(run);
  return run;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 BOM first so Excel opens Chinese/emoji correctly. */
export function toLeadCsv(run) {
  const header = ['层', '层名', '标题', '链接', '摘要'].map(csvEscape).join(',');
  const lines = (run?.results ?? []).map((item) =>
    [item.layer, item.layerName, item.title, item.url, item.snippet]
      .map(csvEscape)
      .join(','),
  );
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}

export function exportPath(runId) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = runId ? `leads-${runId}.csv` : `leads-${stamp}-${Date.now().toString(36)}.csv`;
  return join(EXPORT_DIR, name);
}
