// 线索加工管线：搜索结果 → 抓页 → 提取联系方式 → 规则分类 → 评分 → 入 CRM。
// 每条线索独立容错：单页失败不影响整批。产出汇总给工具层/网页。
import { fetchPage, visibleText } from './enrich/fetchPage.js';
import { extractContacts } from './enrich/contacts.js';
import { classify } from './enrich/classify.js';
import { scoreLead } from './score.js';
import { upsertLead } from './crm.js';
import { contextFor } from './kb.js';
import { audit } from './audit.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 加工一批搜索结果。
 * @param {Array<{title, url, snippet, layer, layerName}>} results
 * @param {{product, market, useAI?, fetchPages?, saveToCrm?, limit?, signal?, onProgress?}} opts
 * @returns {Array<{url, title, kind, keep, reason, contacts, score, tier, advice, leadId?, error?}>}
 */
export async function enrichResults(results, opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const out = [];
  const batch = results.slice(0, limit);
  for (let index = 0; index < batch.length; index += 1) {
    const item = batch[index];
    if (opts.signal?.aborted) {
      break;
    }
    const record = {
      url: item.url,
      title: item.title,
      layer: item.layer,
      kind: 'unknown',
      keep: true,
      reason: '',
      contacts: { emails: [], whatsapps: [], phones: [], socials: {} },
      company: '',
      score: 0,
      tier: '低',
      advice: '',
      leadId: null,
    };
    try {
      // 1) 抓页（可选关闭：只用 title/snippet 分类评分）
      if (opts.fetchPages !== false) {
        const page = await fetchPage(item.url, { signal: opts.signal });
        if (page.ok) {
          record.html = page.html;
        } else {
          record.error = page.error;
        }
        // 礼貌间隔，避免打爆目标站
        await sleep(400 + Math.floor(Math.random() * 500));
      }

      // 2) 提取联系方式
      if (record.html) {
        const contacts = extractContacts(record.html);
        record.contacts = {
          emails: contacts.emails.slice(0, 5),
          whatsapps: contacts.whatsapps.slice(0, 3),
          phones: contacts.phones.slice(0, 3),
          socials: contacts.socials,
        };
        record.company = contacts.company;
      }

      // 3) 规则分类
      const cls = classify({ url: item.url, title: item.title, snippet: item.snippet, html: record.html });
      record.kind = cls.kind;
      record.keep = cls.keep;
      record.reason = cls.reason;
      record.signals = cls.signals;

      // 4) 评分（被排除的同行/平台不打分，直接 0）
      if (cls.keep) {
        const scored = await scoreLead({
          product: opts.product,
          market: opts.market,
          useAI: opts.useAI,
          knowledge: contextFor(`${opts.product ?? ''} ${opts.market ?? ''} 报价 政策`),
          item: {
            title: item.title,
            snippet: item.snippet,
            signalsText: `${cls.signals.join(' ')} ${(record.contacts.emails ?? []).join(' ')} ${record.company}`,
          },
        });
        record.score = scored.score;
        record.tier = scored.tier;
        record.fit = scored.fit;
        record.advice = scored.advice;
        record.reasons = scored.reasons;
        record.scoredBy = scored.scoredBy;
      } else {
        record.score = 0;
        record.tier = '排除';
      }

      // 5) 入 CRM（keep 且有基本信息的才入库）
      if (opts.saveToCrm !== false && cls.keep && (record.contacts.emails.length > 0 || record.contacts.whatsapps.length > 0 || record.company || record.html)) {
        const { lead, merged } = upsertLead({
          company: record.company || item.title.slice(0, 80),
          url: item.url,
          market: opts.market,
          source: item.url,
          contacts: record.contacts,
          score: record.score,
          tier: record.tier,
          fit: record.fit,
          reasons: record.reasons,
          advice: record.advice,
          title: item.title,
          snippet: item.snippet,
          runId: opts.runId,
        }, { actor: opts.actor ?? 'agent' });
        record.leadId = lead.id;
        record.merged = merged;
      }
    } catch (error) {
      record.error = String(error?.message ?? error).slice(0, 200);
    }
    out.push(record);
    opts.onProgress?.(index + 1, batch.length, record);
  }
  audit('leads.enrich', { total: out.length, kept: out.filter((item) => item.keep).length, saved: out.filter((item) => item.leadId).length }, opts.actor ?? 'agent');
  return out;
}

export { visibleText };
