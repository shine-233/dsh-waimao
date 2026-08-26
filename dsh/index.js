// dsh-waimao v0.2 — DeepSeek Harness 外贸获客插件。
//
// v0.2 全家桶：三层搜索 → 线索加工(提取/过滤/评分) → 邮箱验证 → 开发信
// (SMTP+dry_run) → 跟进序列 → CRM 管线 → SOP 阶段机(审批门) → 知识库 →
// 定时任务 → WhatsApp 群发频控/媒体 → 报价PDF → 审计日志。
//
// 零 npm 依赖：node 内置模块 + global fetch（Node >= 22.13）。
// 兼容基线：@deepseek-ai/dsh 0.1.0-rc.7。
import * as auditMod from './audit.js';
import * as configMod from './config.js';
import * as crmMod from './crm.js';
import { toCsv, crmRow, CRM_CSV_HEADERS, importerRowFromLead, importerRowFromResult, IMPORTER_CSV_HEADERS } from './csv.js';
import * as cronMod from './cron.js';
import * as draftMod from './draft.js';
import { companyDossier } from './enrich/dossier.js';
import * as enrichMod from './enrich.js';
import { findEmail, verifyEmail } from './enrich/emailfind.js';
import * as evolutionMod from './evolution.js';
import * as httpMod from './http.js';
import * as kbMod from './kb.js';
import * as leadsMod from './leads.js';
import { imapProbe } from './mail/imap.js';
import * as composeMod from './mail/compose.js';
import { followUp, languageFor } from './mail/templates.js';
import { newSequence, dueSteps, sequenceSummary, stopSequence } from './mail/sequence.js';
import { scanReplies } from './mail/replies.js';
import { sendMail } from './mail/smtp.js';
import * as monitorMod from './monitor.js';
import { marketOptions } from './markets.js';import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as pagesMod from './pages.js';
import { quotePdf, quoteFileName } from './pdf.js';
import { readConfig, EXPORT_DIR } from './config.js';
import { scoreLead } from './score.js';
import * as sopMod from './sop.js';
import * as statsMod from './stats.js';
import * as storeMod from './store.js';
import * as suppressMod from './suppress.js';
import * as trackMod from './track.js';
import * as warmupMod from './warmup.js';
import { deliverabilityCheck } from './deliverability.js';
import * as instantlyMod from './instantly.js';
import * as templatesMod from './templates.js';
import { toVcf } from './csv.js';
import { calcPrice, quoteLines } from './pricing.js';
import { proformaPdf } from './pdf.js';
import { scanMarkets } from './market.js';
import { videoScript, renderScript, spinText } from './content.js';

export const name = 'waimao';

export const inject = ['tools'];

export function apply(ctx) {
  // SOP 阶段机需要读 CRM（避免 ESM 循环依赖，走注入）
  globalThis.__waimaoCrm = crmMod;

  registerLeadSearchTool(ctx);
  registerLeadExportTool(ctx);
  registerLeadEnrichTool(ctx);
  registerLeadScoreTool(ctx);
  registerEmailFindTool(ctx);
  registerEmailVerifyTool(ctx);
  registerEmailComposeTool(ctx);
  registerEmailSendTool(ctx);
  registerEmailScanRepliesTool(ctx);
  registerEmailSuppressTool(ctx);
  registerEmailStatsTool(ctx);
  registerSequenceStartTool(ctx);
  registerSequenceStatusTool(ctx);
  registerCompanyDossierTool(ctx);
  registerMonitorWatchTool(ctx);
  registerMonitorCheckTool(ctx);
  registerCrmListTool(ctx);
  registerCrmUpdateTool(ctx);
  registerCrmActivityTool(ctx);
  registerCrmExportTool(ctx);
  registerSopCreateTool(ctx);
  registerSopNextTool(ctx);
  registerSopReviewTool(ctx);
  registerSopApproveTool(ctx);
  registerSopStatusTool(ctx);
  registerKbSearchTool(ctx);
  registerKbUpsertTool(ctx);
  registerKbListTool(ctx);
  registerWaSyncTool(ctx);
  registerWaQueueTool(ctx);
  registerWaReplyTool(ctx);
  registerWaSendTextTool(ctx);
  registerWaSendMediaTool(ctx);
  registerWaBroadcastTool(ctx);
  registerQuotePdfTool(ctx);
  registerCronStatusTool(ctx);
  registerAuditQueryTool(ctx);
  registerWarmupStatusTool(ctx);
  registerDeliverabilityCheckTool(ctx);
  registerTemplateTools(ctx);
  registerPriceCalcTool(ctx);
  registerProformaPdfTool(ctx);
  registerMarketScanTool(ctx);
  registerVideoScriptTool(ctx);
  registerIcpSetTool(ctx);
  registerDataBackupTool(ctx);
  registerInstantlyTools(ctx);

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerRoutes(scope);
        startCron();
      } catch (error) {
        console.error(`[waimao] web routes skipped: ${error}`);
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

function smtpOf() {
  const config = readConfig();
  return config.smtp ?? {};
}

/**
 * 多收件账号轮换：配了 smtp.accounts 就轮询选号，否则用主账号。
 * 支持账号级 dailyCap（per-mailbox cap，实战惯例 30-40/邮箱/天）：
 * 已达自身上限的账号本轮跳过，全打满则回落主账号由上层闸门拦截。
 */
function pickSmtpAccount(sentByAccount = new Map()) {
  const smtp = readConfig().smtp ?? {};
  const accounts = Array.isArray(smtp.accounts) ? smtp.accounts.filter((a) => a?.host && a?.from) : [];
  if (accounts.length === 0) {
    return { ...smtp, accountIndex: 0 };
  }
  const stateFile = join(EXPORT_DIR, '.rotate');
  let index = 0;
  try {
    index = Number(readFileSync(stateFile, 'utf8').trim()) || 0;
  } catch {}
  let chosen = null;
  for (let i = 0; i < accounts.length; i += 1) {
    const candidate = accounts[(index + i) % accounts.length];
    const cap = Number(candidate.dailyCap ?? 0) || 0;
    if (cap > 0 && (sentByAccount.get(candidate.from) ?? 0) >= cap) {
      continue;
    }
    chosen = candidate;
    try {
      mkdirSync(EXPORT_DIR, { recursive: true });
      writeFileSync(stateFile, String((index + i + 1) % accounts.length), { mode: 0o600 });
    } catch {}
    return { ...smtp, ...chosen, accountIndex: (index + i) % accounts.length };
  }
  // 所有账号都打满：返回轮换起点，交给上层账号闸门报错
  return { ...smtp, ...accounts[index % accounts.length], accountIndex: index % accounts.length };
}

/**
 * 首触冷邮件审批闸（对齐 gtm-mcp/Instantly 的"激活"模式）：
 * 智能体自主发起的首触（无线程、无审批凭证）默认拒绝；网页人工发送、
 * 回复/线程跟进、SOP 已批准草稿、cron 序列（启动序列本身是用户显式操作）放行。
 */
export function coldSendNeedsApproval({ approvedVia, actor, inReplyTo }, allowWithoutApproval = false) {
  if (allowWithoutApproval || approvedVia) {
    return false;
  }
  if (inReplyTo) {
    return false; // 买家已回复的会话跟进不算冷触达
  }
  return actor !== 'user'; // 网页按钮=人点的，天然是审批
}

/** 发送邮件的唯一入口：日发送上限 + 抑制列表拦截 + spintax + dry_run 总闸 + 退订脚注 + 线程头 + 审计。 */
async function sendEmailGuarded({ to, toName, subject, body, attachments, leadId, actor = 'agent', inReplyTo, references, isFirstEmail, approvedVia }) {
  const config = readConfig();
  // 域名黑名单：退信/投诉过的公司域名整体拒发（同公司其他联系人大概率也是坏地址）
  const blacklisted = suppressMod.isDomainBlacklisted(suppressMod.domainOf(to));
  if (blacklisted) {
    throw new Error(`收件人域名 ${blacklisted.domain} 在黑名单中（${blacklisted.reason}，${blacklisted.ts.slice(0, 10)}），拒绝发送`);
  }
  const suppressed = suppressMod.isSuppressed(to);
  if (suppressed) {
    throw new Error(`收件人 ${to} 在抑制列表中（${suppressed.reason}，${suppressed.ts.slice(0, 10)}），拒绝发送`);
  }
  // 今日已发审计一次取回，供全局上限与每邮箱上限共用（业务 email.send + 预热 email.warmup）
  let todaysSends = [];
  let todaysWarmup = [];
  try {
    todaysSends = auditMod.queryAudit({ action: 'email.send', since: auditMod.startOfLocalDay(), limit: 5000 });
  } catch {}
  try {
    todaysWarmup = auditMod.queryAudit({ action: 'email.warmup', since: auditMod.startOfLocalDay(), limit: 5000 });
  } catch {}
  const sentByAccount = new Map();
  for (const entry of todaysSends) {
    const account = entry.detail?.account;
    if (account) {
      sentByAccount.set(account, (sentByAccount.get(account) ?? 0) + 1);
    }
  }
  const smtp = pickSmtpAccount(sentByAccount);
  if (!smtp.host || !smtp.from) {
    throw new Error('SMTP 未配置（settings 页或 ~/.waimao/config.json 的 smtp 段）');
  }
  if (smtp.dryRun === false) {
    // 首触审批闸
    if (coldSendNeedsApproval({ approvedVia, actor, inReplyTo }, config.smtp?.allowColdSendWithoutApproval === true)) {
      throw new Error('首触冷邮件需人工审批：走 email_compose(task_id=…) → sop_review → sop_approve 后再发；或设置页开启 smtp.allowColdSendWithoutApproval 自行担责');
    }
    // 每邮箱总上限（业务+预热合计；服务商只看邮箱当天总量）
    const totalCap = Number(config.smtp?.mailboxTotalCap ?? 0) || 0;
    if (totalCap > 0) {
      const warmupFrom = todaysWarmup.filter((entry) => entry.detail?.account === smtp.from).length;
      if ((sentByAccount.get(smtp.from) ?? 0) + warmupFrom >= totalCap) {
        throw new Error(`账号 ${smtp.from} 今日总发信量（业务+预热）已达 mailboxTotalCap=${totalCap}。保护邮箱信誉，明天再发或调整上限`);
      }
    }
    // 每邮箱独立上限（per-mailbox cap，仅统计业务发送）
    const mailboxCap = Number(smtp.dailyCap ?? 0) || 0;
    if (mailboxCap > 0 && (sentByAccount.get(smtp.from) ?? 0) >= mailboxCap && config.smtp?.accounts?.length) {
      throw new Error(`账号 ${smtp.from} 今日已达自身上限 ${mailboxCap} 封。可在 smtp.accounts 里加更多收件箱或调高该账号 dailyCap`);
    }
    // 容量闸门：今天真实发送已达全局上限就停（保护域名信誉，防进垃圾箱）
    const dailyCap = Number(config.smtp?.dailyCap ?? 0) || 0;
    if (dailyCap > 0) {
      const sentToday = auditMod.countRealSends(todaysSends);
      if (sentToday >= dailyCap) {
        throw new Error(`今日已真实发送 ${sentToday} 封，达到 smtp.dailyCap=${dailyCap} 全局上限。为保护域名信誉，明天再发或调高上限（新域名建议 ≤30/天）`);
      }
    }
  }
  // Spintax：{a|b|c} 随机选一项，让每封信略有差异
  let finalSubject = spinText(subject);
  // 合规：首封开发信追加退订提示
  let finalBody = spinText(String(body ?? ''));
  if (isFirstEmail && smtp.unsubscribeFooter !== false) {
    const { withUnsubscribeFooter } = await import('./mail/templates.js');
    finalBody = withUnsubscribeFooter({ body: finalBody }, 'en').body;
  }
  if (smtp.dryRun !== false) {
    const previewFile = join(EXPORT_DIR, `draft-${Date.now().toString(36)}.txt`);
    mkdirSync(EXPORT_DIR, { recursive: true });
    writeFileSync(previewFile, `To: ${to}\nSubject: ${finalSubject}\n${inReplyTo ? `In-Reply-To: ${inReplyTo}` : ''}\n\n${finalBody}`, { mode: 0o600 });
    auditMod.audit('email.dry_run', { to, subject: finalSubject, leadId, preview: previewFile }, actor);
    return { dryRun: true, previewFile, message: 'smtp.dry_run=true：未真实发送，草稿已存盘' };
  }
  // 打开/点击追踪：配置了公网入口且未开纯文本模式时，生成 HTML 替身（像素+链接包裹）
  let html;
  let tracking = null;
  const trackBase = smtp.plainText === true ? null : trackMod.trackingEnabled();
  if (trackBase) {
    tracking = trackMod.createTracking({ leadId, to, subject: finalSubject });
    const built = trackMod.buildTrackedHtml({ text: finalBody, trackId: tracking.id, base: trackBase });
    html = built.html;
  }
  const result = await sendMail(smtp, { from: smtp.from, fromName: smtp.fromName, to, toName, subject: finalSubject, body: finalBody, html, replyTo: smtp.replyTo, inReplyTo, references, attachments });
  auditMod.audit('email.send', { to, subject: finalSubject, leadId, account: smtp.from ?? '', messageId: result.messageId, threaded: Boolean(inReplyTo), tracked: Boolean(tracking) }, actor);
  return { dryRun: false, trackId: tracking?.id ?? null, ...result };
}

/** A/B 分组：按线索 ID 稳定哈希，逐条/批量调用分组一致且大致对半。 */
export function abVariant(id) {
  const s = String(id ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 2 === 0 ? 'A' : 'B';
}

/** 填充序列 Day3/7/14 跟进内容（模板兜底）：cron 到期直接发步骤里存的内容，绝不允许空邮件。 */
export function fillFollowUpSteps(sequence, { market, language }) {
  const config = readConfig();
  for (let n = 1; n <= Math.min(3, sequence.steps.length - 1); n += 1) {
    if (sequence.steps[n].subject && sequence.steps[n].body) {
      continue;
    }
    const fu = followUp(
      { market, language, product: config.icp?.product || undefined, me: config.smtp?.fromName ?? 'Sales' },
      n,
    );
    sequence.steps[n].subject = fu.subject;
    sequence.steps[n].body = fu.body;
  }
  return sequence;
}

/* ------------------------------------------------------------------ */
/* 工具：搜索 + 线索加工                                                */
/* ------------------------------------------------------------------ */

function registerLeadSearchTool(ctx) {
  ctx.tools.register({
    name: 'lead_search',
    description:
      '谷歌三层获客搜索：按「基础搜索(产品词+WhatsApp/区号) → LinkedIn职位定向 → 采购信号」逐层执行并去重。引擎自动 failover（ddg失败切serpapi）。source=maps 时改用 Google Maps 商家数据(需serpapi key)。结果落盘，可接 lead_enrich 做联系方式提取+过滤+评分。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: '产品关键词（英文）' },
        market: { type: 'string', description: '市场：预设key(mx/ae/sa/br/us/eu...)或区号(+52)' },
        layers: { type: 'array', items: { type: 'number', enum: [1, 2, 3] }, description: '执行哪些层，默认[1,2,3]' },
        per_layer: { type: 'number', description: '每层条数，默认10' },
        engine: { type: 'string', enum: ['ddg', 'serpapi', 'literal'], description: '留空=自动failover' },
        source: { type: 'string', enum: ['web', 'maps'], description: 'web=谷歌网页(默认)，maps=谷歌地图商家(需serpapi)' },
      },
      required: ['product'],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `lead_search: ${args?.product ?? ''}`, kind: 'search', rawInput: args }),
    async execute(args, exec) {
      return leadsMod.runLeadSearch({
        product: args?.product,
        market: args?.market,
        layers: Array.isArray(args?.layers) ? args.layers : undefined,
        perLayer: args?.per_layer,
        engine: args?.engine,
        source: args?.source,
        signal: exec?.signal,
      });
    },
  });
}

function registerLeadExportTool(ctx) {
  ctx.tools.register({
    name: 'lead_export_csv',
    description: '导出一次 lead_search 结果为 CSV（UTF-8 BOM）。format=importer 输出发信工具标准列。不传 run_id 导出最近一次。CRM 导出请用 crm_export。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        format: { type: 'string', enum: ['full', 'importer'], description: 'importer=Instantly/Smartlead 标准列' },
        file: { type: 'string', description: '可选输出路径' },
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'lead_export_csv', kind: 'export', rawInput: args }),
    async execute(args) {
      const run = args?.run_id ? leadsMod.findRun(args.run_id) : leadsMod.loadRuns(1)[0];
      if (!run) {
        throw new Error('没有可导出的搜索记录，先运行 lead_search');
      }
      const { writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const file = args?.file || leadsMod.exportPath(run.id);
      mkdirSync(dirname(file), { recursive: true });
      const content = args?.format === 'importer'
        ? toCsv(IMPORTER_CSV_HEADERS, (run.results ?? []).map(importerRowFromResult))
        : leadsMod.toLeadCsv(run);
      writeFileSync(file, content, { mode: 0o600 });
      return { file, total: run.total, product: run.product };
    },
  });
}

function registerLeadEnrichTool(ctx) {
  ctx.tools.register({
    name: 'lead_enrich',
    description:
      '线索加工管线：对 lead_search 的结果抓取网页 → 提取联系方式(邮箱/WhatsApp/电话/社媒) → 规则引擎过滤(排除同行/B2B平台/黄页/招聘) → AI评分分级(0-12分,🔴🟠🟡🟢,按 icp_set 的画像判断是否对口) → 自动存入CRM(去重合并)。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'lead_search 的 run id，缺省=最近一次' },
        limit: { type: 'number', description: '最多加工条数，默认20，上限100' },
        use_ai: { type: 'boolean', description: 'AI评分，默认true(无key自动回退规则分)' },
        fetch_pages: { type: 'boolean', description: '抓取网页，默认true' },
        save_to_crm: { type: 'boolean', description: '存入CRM，默认true' },
      },
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'lead_enrich', kind: 'fetch', rawInput: args }),
    async execute(args, exec) {
      const run = args?.run_id ? leadsMod.findRun(args.run_id) : leadsMod.loadRuns(1)[0];
      if (!run) {
        throw new Error('没有可加工的搜索记录，先运行 lead_search');
      }
      const records = await enrichMod.enrichResults(run.results, {
        product: run.product,
        market: run.market,
        runId: run.id,
        limit: args?.limit,
        useAI: args?.use_ai,
        fetchPages: args?.fetch_pages,
        saveToCrm: args?.save_to_crm,
        signal: exec?.signal,
      });
      const kept = records.filter((item) => item.keep);
      return {
        run: run.id,
        processed: records.length,
        kept: kept.length,
        savedToCrm: records.filter((item) => item.leadId).length,
        excluded: records.filter((item) => !item.keep).map((item) => ({ url: item.url, kind: item.kind, reason: item.reason })),
        leads: kept.map((item) => ({
          leadId: item.leadId, company: item.company || item.title, url: item.url, kind: item.kind,
          score: item.score, tier: item.tier, advice: item.advice,
          emails: item.contacts.emails, whatsapps: item.contacts.whatsapps, phones: item.contacts.phones,
          error: item.error,
        })),
      };
    },
  });
}

function registerLeadScoreTool(ctx) {
  ctx.tools.register({
    name: 'lead_score',
    description: '对 CRM 里的线索重新评分（规则+AI，0-12分，🔴极高/🟠高/🟡中/🟢低，附开发建议）。',
    parameters: {
      type: 'object',
      properties: {
        lead_ids: { type: 'array', items: { type: 'string' }, description: '线索ID列表，缺省=new/qualified 各最多50条' },
        use_ai: { type: 'boolean', description: '默认true' },
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'lead_score', kind: 'score', rawInput: args }),
    async execute(args) {
      const ids = Array.isArray(args?.lead_ids) && args.lead_ids.length > 0
        ? args.lead_ids
        : [
            ...crmMod.listLeads({ status: 'new', limit: 50 }).map((lead) => lead.id),
            ...crmMod.listLeads({ status: 'qualified', limit: 50 }).map((lead) => lead.id),
          ];
      const results = [];
      for (const id of ids) {
        const lead = crmMod.getLead(id);
        if (!lead) {
          results.push({ id, error: 'not found' });
          continue;
        }
        const scored = await scoreLead({
          market: lead.market,
          item: {
            title: lead.title,
            snippet: lead.snippet,
            signalsText: `${lead.advice} ${(lead.contacts.emails ?? []).join(' ')} ${lead.company}`,
          },
          useAI: args?.use_ai,
        });
        crmMod.updateLead(id, { score: scored.score, tier: scored.tier, fit: scored.fit, advice: scored.advice }, { activityNote: `重评分: ${scored.score}(${scored.tier})` });
        results.push({ id, score: scored.score, tier: scored.tier, fit: scored.fit, advice: scored.advice });
      }
      return { scored: results.length, results };
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：邮箱发现验证 + 邮件触达 + 序列                                 */
/* ------------------------------------------------------------------ */

function registerEmailFindTool(ctx) {
  ctx.tools.register({
    name: 'email_find',
    description:
      '邮箱发现+验证（hunter.io 开源平替）：按 姓名+域名 猜测常见邮箱模式（info@/first.last@/flast@...），逐个 MX+SMTP RCPT 探测，返回 valid/catch-all/invalid 等状态。25端口被封锁时返回 unverifiable（正常现象）。',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '公司域名，如 example.com' },
        name: { type: 'string', description: '联系人姓名（可选，提高猜测准确度）' },
        verify: { type: 'boolean', description: '是否SMTP验证，默认true' },
        limit: { type: 'number', description: '最多尝试几个候选，默认6' },
      },
      required: ['domain'],
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `email_find: ${args?.domain ?? ''}`, kind: 'search', rawInput: args }),
    async execute(args, exec) {
      const result = await findEmail({ domain: args?.domain, name: args?.name, verify: args?.verify !== false, limit: args?.limit, signal: exec?.signal });
      if (result.best) {
        const lead = crmMod.listLeads({ q: args?.domain, limit: 1 })[0];
        if (lead) {
          crmMod.updateLead(lead.id, {
            contacts: { ...lead.contacts, emails: [...new Set([result.best, ...(lead.contacts.emails ?? [])])] },
            emailStatus: 'valid',
          }, { activityNote: `邮箱验证通过: ${result.best}` });
        }
      }
      return result;
    },
  });
}

function registerEmailVerifyTool(ctx) {
  ctx.tools.register({
    name: 'email_verify',
    description: '验证单个邮箱是否真实可收信（MX + SMTP RCPT TO 探测 + catch-all 检测）。',
    parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `email_verify: ${args?.email ?? ''}`, kind: 'fetch', rawInput: args }),
    async execute(args) {
      return verifyEmail(String(args?.email ?? '').trim().toLowerCase());
    },
  });
}

function registerEmailComposeTool(ctx) {
  ctx.tools.register({
    name: 'email_compose',
    description:
      '撰写开发信草稿（不发送）：优先 DeepSeek 个性化生成（带知识库上下文），回退双语模板。拉美市场自动西语。产品与买家画像取自 icp_set 设置的 ICP，没设置过就先问用户或调 icp_set。SOP 任务进行中时传 task_id 会把草稿挂到任务上等待审批。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'CRM 线索ID' },
        contact_name: { type: 'string', description: '联系人姓名（从搜索结果/LinkedIn 拿到时传入，信里会称呼名字）' },
        language: { type: 'string', enum: ['en', 'es', 'pt'], description: '缺省按市场自动选' },
        use_ai: { type: 'boolean', description: '默认true' },
        kind: { type: 'string', enum: ['first', 'followup'], description: '首封/跟进，默认first' },
        step: { type: 'number', description: '跟进序号1-3（kind=followup时）' },
        task_id: { type: 'string', description: 'SOP任务ID（可选，挂草稿到任务）' },
        template: { type: 'string', description: '模板库 id 或 name（提供则跳过AI直接用模板）' },
      },
      required: ['lead_id'],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `email_compose: ${args?.lead_id ?? ''}`, kind: 'compose', rawInput: args }),
    async execute(args) {
      const lead = crmMod.getLead(String(args?.lead_id ?? ''));
      if (!lead) {
        throw new Error(`lead not found: ${args?.lead_id}`);
      }
      const kbContext = kbMod.contextFor(`${lead.market} ${lead.company} ${lead.domain} 报价 政策 产品`);
      let draft;
      const template = args?.template ? templatesMod.getTemplate(String(args.template)) : null;
      if (args?.template && !template) {
        throw new Error(`模板不存在: ${args.template}（template_list 可查）`);
      }
      if (template) {
        templatesMod.markUsed(template.id);
        draft = { language: template.language, subject: template.subject, body: template.body, generatedBy: `template:${template.name}` };
      } else {
        const icp = readConfig().icp ?? {};
        draft = await composeMod.composeEmail({
          kind: args?.kind ?? 'first',
          step: args?.step,
          // 联系人名：优先用参数（智能体从搜索结果/LinkedIn 层拿到时传入），
          // 其次用 CRM 里存的名字；都没有模板兜底 "Hi there"
          name: String(args?.contact_name ?? lead.contacts?.contactName ?? '').trim(),
          company: lead.company || lead.domain,
          product: icp.product || 'our products',
          buyers: icp.buyers || undefined,
          market: lead.market,
          language: args?.language,
          useAI: args?.use_ai,
          me: readConfig().smtp?.fromName ?? 'Sales',
          features: 'factory direct, stable quality, fast lead time',
          knowledge: kbContext || undefined,
        });
      }
      const result = { leadId: lead.id, ...draft, knowledgeCited: kbContext ? kbContext.split('\n').length : 0 };
      if (args?.task_id) {
        const attached = sopMod.attachDraft(args.task_id, {
          leadId: lead.id, channel: 'email', to: lead.contacts.emails?.[0] ?? '', subject: draft.subject, body: draft.body,
        });
        result.draftId = attached.id;
        result.note = '草稿已挂到SOP任务，需人工审批后才能发送';
      } else {
        crmMod.updateLead(lead.id, { pendingEmail: { subject: draft.subject, body: draft.body, generatedBy: draft.generatedBy } }, { activityNote: `开发信草稿(${draft.generatedBy}/${draft.language})` });
      }
      return result;
    },
  });
}

function registerEmailSendTool(ctx) {
  ctx.tools.register({
    name: 'email_send',
    description:
      '发送开发信。受 smtp.dry_run 总闸（默认 true 只存预览）与日上限约束。SOP 任务中发送需草稿已批准且以批准稿为准。首触冷邮件默认还需审批：不带 task_id/draft_id 直接发会被拒绝——走 email_compose(task_id)→sop_review→sop_approve，或让用户在设置页开 smtp.allowColdSendWithoutApproval；回复/线程跟进与网页手动发送不受此限。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        task_id: { type: 'string', description: 'SOP模式：校验该草稿已批准' },
        draft_id: { type: 'string', description: 'SOP模式：草稿ID' },
      },
      required: ['lead_id', 'subject', 'body'],
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `email_send: ${args?.lead_id ?? ''}`, kind: 'send', rawInput: { lead_id: args?.lead_id, subject: args?.subject } }),
    async execute(args) {
      const lead = crmMod.getLead(String(args?.lead_id ?? ''));
      if (!lead) {
        throw new Error(`lead not found: ${args?.lead_id}`);
      }
      // SOP 模式：发送内容以"已批准草稿"为准（哈希校验），参数里的 subject/body
      // 只在无 SOP 时生效——防止审批后被偷换内容。
      let finalSubject = String(args?.subject ?? '');
      let finalBody = String(args?.body ?? '');
      let approvedVia;
      if (args?.task_id && args?.draft_id) {
        const sopDraft = sopMod.assertApproved(args.task_id, args.draft_id);
        if (sopDraft.leadId && sopDraft.leadId !== lead.id) {
          throw new Error(`草稿 ${args.draft_id} 属于线索 ${sopDraft.leadId}，与 lead_id ${lead.id} 不匹配`);
        }
        finalSubject = sopDraft.subject;
        finalBody = sopDraft.body;
        approvedVia = 'sop';
      }
      const to = lead.contacts.emails?.[0];
      if (!to) {
        throw new Error(`线索 ${lead.id} 没有邮箱（先 email_find 或 lead_enrich）`);
      }
      const isFirstEmail = !lead.lastMessageId && ['new', 'qualified'].includes(lead.status);
      const result = await sendEmailGuarded({
        to,
        toName: lead.company,
        subject: finalSubject,
        body: finalBody,
        leadId: lead.id,
        // 跟进邮件挂原线程（回复检测依赖 In-Reply-To）
        inReplyTo: lead.lastMessageId,
        isFirstEmail,
        approvedVia,
      });
      if (!result.dryRun) {
        crmMod.updateLead(lead.id, {
          status: ['new', 'qualified'].includes(lead.status) ? 'contacted' : lead.status,
          ...(result.messageId ? { lastMessageId: result.messageId } : {}),
        }, { activityNote: `开发信已发送${isFirstEmail ? '(首封)' : '(跟进)'}: ${finalSubject}` });
      } else {
        crmMod.addActivity(lead.id, { type: 'email-draft', note: `[dry-run] 预览: ${finalSubject}` });
      }
      return { ...result, to };
    },
  });
}

function registerSequenceStartTool(ctx) {
  ctx.tools.register({
    name: 'email_sequence_start',
    description:
      '给线索启动 Day 0/3/7/14 四步跟进序列（首封+轻提醒+附目录+最后跟进）。回复即停（状态改 replied 时自动停）。由 cron 定时执行，受 smtp.dry_run 约束。传 template_a/template_b 可做 A/B 测试（按线索 ID 稳定分组，逐条/批量结果一致，stats_report 按变体统计回复率）。',
    parameters: {
      type: 'object',
      properties: {
        lead_ids: { type: 'array', items: { type: 'string' }, description: '线索ID列表（批量启动用）' },
        lead_id: { type: 'string', description: '单线索ID（与 lead_ids 二选一）' },
        language: { type: 'string', enum: ['en', 'es', 'pt'] },
        template_a: { type: 'string', description: 'A变体模板（id/name，可选）' },
        template_b: { type: 'string', description: 'B变体模板（可选，与A成对）' },
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'email_sequence_start', kind: 'schedule', rawInput: args }),
    async execute(args) {
      const ids = Array.isArray(args?.lead_ids) && args.lead_ids.length > 0 ? args.lead_ids : [args?.lead_id];
      const abMode = Boolean(args?.template_a && args?.template_b);
      const results = [];
      for (const id of ids.filter(Boolean)) {
        try {
          const lead = crmMod.getLead(String(id));
          if (!lead) {
            results.push({ id, error: 'not found' });
            continue;
          }
          if (!lead.contacts.emails?.length) {
            results.push({ id, error: 'no email' });
            continue;
          }
          const language = args?.language ?? languageFor(lead.market);
          const variant = abMode ? abVariant(lead.id) : null;
          const templateId = variant === 'A' ? args.template_a : variant === 'B' ? args.template_b : null;
          const template = templateId ? templatesMod.getTemplate(String(templateId)) : null;
          if (templateId && !template) {
            results.push({ id, error: `模板不存在: ${templateId}（A/B 对比会失真，template_list 可查）` });
            continue;
          }
          const icp = readConfig().icp ?? {};
          const sequence = newSequence({ language });
          let first;
          if (template) {
            templatesMod.markUsed(template.id);
            first = { subject: template.subject, body: template.body, generatedBy: `template:${template.name}` };
          } else {
            first = await composeMod.composeEmail({ kind: 'first', company: lead.company || lead.domain, market: lead.market, language, useAI: args?.use_ai, me: readConfig().smtp?.fromName ?? 'Sales', product: icp.product || undefined, buyers: icp.buyers || undefined });
          }
          sequence.steps[0].subject = first.subject;
          sequence.steps[0].body = first.body;
          sequence.subject0 = first.subject;
          fillFollowUpSteps(sequence, { market: lead.market, language });
          sequence.variant = variant;
          crmMod.updateLead(lead.id, { sequence }, { activityNote: `启动4步跟进序列${variant ? ` [变体${variant}]` : ''}` });
          results.push({ id, variant, firstSubject: first.subject });
        } catch (error) {
          results.push({ id, error: String(error?.message ?? error).slice(0, 120) });
        }
      }
      return {
        started: results.filter((item) => !item.error).length,
        abTest: abMode ? { a: args.template_a, b: args.template_b, note: 'stats_report 按变体统计回复率' } : null,
        results,
      };
    },
  });
}

function registerSequenceStatusTool(ctx) {
  ctx.tools.register({
    name: 'email_sequence_status',
    description: '查看所有进行中的邮件跟进序列及到期情况。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'email_sequence_status', kind: 'list', rawInput: args }),
    async execute() {
      const leads = crmMod.listLeads({ limit: 500 }).filter((lead) => lead.sequence);
      return {
        running: leads.length,
        dueNow: leads.filter((lead) => dueSteps(lead.sequence).length > 0).map((lead) => ({ id: lead.id, company: lead.company, due: dueSteps(lead.sequence).map((step) => `Day${step.day}`) })),
        sequences: leads.slice(0, 30).map((lead) => ({ id: lead.id, company: lead.company, ...sequenceSummary(lead.sequence) })),
      };
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：CRM                                                           */
/* ------------------------------------------------------------------ */

function registerCrmListTool(ctx) {
  ctx.tools.register({
    name: 'crm_list',
    description: '查询 CRM 线索：按状态/分层/关键词过滤，带联系方式、评分、最近动作。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new', 'qualified', 'contacted', 'replied', 'quoted', 'won', 'lost'] },
        tier: { type: 'string', enum: ['极高', '高', '中', '低', '排除'] },
        q: { type: 'string', description: '关键词（公司/域名/邮箱）' },
        min_score: { type: 'number' },
        limit: { type: 'number', description: '默认50' },
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'crm_list', kind: 'list', rawInput: args }),
    async execute(args) {
      const leads = crmMod.listLeads({
        status: args?.status,
        tier: args?.tier,
        q: args?.q,
        minScore: args?.min_score,
        limit: Math.min(Math.max(args?.limit ?? 50, 1), 200),
      });
      return { stats: crmMod.crmStats(), leads: leads.map((lead) => ({
        id: lead.id, company: lead.company || lead.domain, domain: lead.domain, market: lead.market,
        status: lead.status, score: lead.score, tier: lead.tier,
        emails: lead.contacts.emails, whatsapps: lead.contacts.whatsapps, phones: lead.contacts.phones,
        advice: lead.advice, lastActivity: lead.activities.at(-1)?.note ?? '',
      })) };
    },
  });
}

function registerCrmUpdateTool(ctx) {
  ctx.tools.register({
    name: 'crm_update',
    description: '更新线索：状态流转(new→qualified→contacted→replied→quoted→won/lost)、标签、备注。状态改 replied 时自动停掉邮件跟进序列。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        status: { type: 'string', enum: ['new', 'qualified', 'contacted', 'replied', 'quoted', 'won', 'lost'] },
        tags: { type: 'array', items: { type: 'string' } },
        note: { type: 'string', description: '备注（追加到档案）' },
      },
      required: ['lead_id'],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `crm_update: ${args?.lead_id ?? ''}`, kind: 'update', rawInput: args }),
    async execute(args) {
      const lead = crmMod.getLead(String(args?.lead_id ?? ''));
      if (!lead) {
        throw new Error(`lead not found: ${args?.lead_id}`);
      }
      let sequence = lead.sequence;
      if (args?.status === 'replied' && sequence) {
        sequence = stopSequence(sequence, 'buyer replied');
      }
      const updated = crmMod.updateLead(lead.id, {
        status: args?.status,
        tags: Array.isArray(args?.tags) ? args.tags : undefined,
        ownerNote: args?.note ?? undefined,
        sequence,
      }, { activityNote: args?.note ? `备注: ${args.note}` : undefined });
      return { id: updated.id, status: updated.status, tags: updated.tags };
    },
  });
}

function registerCrmActivityTool(ctx) {
  ctx.tools.register({
    name: 'crm_activity',
    description: '给线索记一条跟进活动（电话/会议/WhatsApp/备注等）。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        type: { type: 'string', enum: ['note', 'call', 'meeting', 'whatsapp', 'email', 'quote'], description: '默认note' },
        note: { type: 'string' },
      },
      required: ['lead_id', 'note'],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'crm_activity', kind: 'note', rawInput: args }),
    async execute(args) {
      const activity = crmMod.addActivity(String(args?.lead_id ?? ''), { type: args?.type ?? 'note', note: args?.note });
      return activity;
    },
  });
}

function registerCrmExportTool(ctx) {
  ctx.tools.register({
    name: 'crm_export',
    description:
      '导出 CRM 线索为 CSV（可按状态过滤）。format=importer 输出 Instantly/Smartlead 标准列（email/first_name/company/reason...），可直接导入发信工具；默认中文全字段表。',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string' }, format: { type: 'string', enum: ['full', 'importer'] }, file: { type: 'string' } },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'crm_export', kind: 'export', rawInput: args }),
    async execute(args) {
      const leads = crmMod.listLeads({ status: args?.status, limit: 2000 });
      const file = args?.file || join(EXPORT_DIR, `crm-${new Date().toISOString().slice(0, 10)}.csv`);
      mkdirSync(dirname(file), { recursive: true });
      const content = args?.format === 'importer'
        ? toCsv(IMPORTER_CSV_HEADERS, leads.map(importerRowFromLead))
        : toCsv(CRM_CSV_HEADERS, leads.map(crmRow));
      writeFileSync(file, content, { mode: 0o600 });
      return { file, count: leads.length };
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：SOP 阶段机（服务端强制顺序 + 审批门）                          */
/* ------------------------------------------------------------------ */

function registerSopCreateTool(ctx) {
  ctx.tools.register({
    name: 'sop_create',
    description: '创建 SOP 获客任务，进入八阶段流程：解析→发现→加工→评分→草稿→审批→触达→结案。阶段由服务端强制顺序推进（不可跳步），开发信发送前必须人工审批。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '如：开发3个墨西哥电吹风买家' },
        product: { type: 'string' },
        market: { type: 'string' },
      },
      required: ['goal'],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `sop_create: ${args?.goal ?? ''}`, kind: 'create', rawInput: args }),
    async execute(args) {
      const task = sopMod.createTask({ goal: args?.goal, product: args?.product, market: args?.market });
      return { ...sopMod.summary(task), hint: '调用 sop_next 推进（parse 阶段需传 product/market）' };
    },
  });
}

function registerSopNextTool(ctx) {
  ctx.tools.register({
    name: 'sop_next',
    description:
      '推进 SOP 任务一个阶段。前置条件由服务端校验：discover 需 run_id（lead_search 结果）；enrich 需 lead_ids；draft 需先用 email_compose(task_id) 挂草稿；approval 需全部草稿已批准（fail-closed）；outreach 需发送记录或 force=true。返回下一阶段操作提示。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        product: { type: 'string' },
        market: { type: 'string' },
        run_id: { type: 'string' },
        lead_ids: { type: 'array', items: { type: 'string' } },
        force: { type: 'boolean', description: 'outreach 阶段本轮不发送也放行' },
      },
      required: ['task_id'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `sop_next: ${args?.task_id ?? ''}`, kind: 'step', rawInput: args }),
    async execute(args) {
      const { task, hint, report } = sopMod.nextStep(String(args?.task_id ?? ''), {
        product: args?.product,
        market: args?.market,
        runId: args?.run_id,
        leadIds: args?.lead_ids,
        force: args?.force,
      });
      return { task: sopMod.summary(task), hint, ...(report ? { report } : {}) };
    },
  });
}

function registerSopReviewTool(ctx) {
  ctx.tools.register({
    name: 'sop_review',
    description: '列出 SOP 任务中待人工审批的开发信草稿（含哈希与批准状态）。',
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'sop_review', kind: 'list', rawInput: args }),
    async execute(args) {
      const task = sopMod.getTaskFull(String(args?.task_id ?? ''));
      return {
        stage: task.stage,
        drafts: task.drafts.map((draft) => ({
          id: draft.id, leadId: draft.leadId, to: draft.to, subject: draft.subject,
          body: draft.body, hash: draft.hash,
          approved: draft.approved ? `${draft.approved.ts} by ${draft.approved.actor}` : null,
          needsApproval: draft.approved?.hash !== draft.hash,
        })),
      };
    },
  });
}

function registerSopApproveTool(ctx) {
  ctx.tools.register({
    name: 'sop_approve',
    description: '人工审批/驳回 SOP 草稿。批准凭证绑定当前内容哈希；草稿被改动后需重新审批。全部批准后 approval 阶段才放行。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        draft_id: { type: 'string' },
        approve: { type: 'boolean', description: 'true=批准 false=驳回' },
      },
      required: ['task_id', 'draft_id', 'approve'],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `sop_approve: ${args?.draft_id ?? ''}`, kind: 'approve', rawInput: args }),
    async execute(args) {
      const { task, pending } = sopMod.reviewDraft(String(args?.task_id ?? ''), String(args?.draft_id ?? ''), { approve: args?.approve === true, actor: 'user' });
      return { draftId: args?.draft_id, approved: args?.approve === true, pendingApprovals: pending, stage: task.stage };
    },
  });
}

function registerSopStatusTool(ctx) {
  ctx.tools.register({
    name: 'sop_status',
    description: '查看 SOP 任务列表或单个任务详情（阶段轨迹、草稿、触达记录、结案报告）。',
    parameters: { type: 'object', properties: { task_id: { type: 'string' } } },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'sop_status', kind: 'status', rawInput: args }),
    async execute(args) {
      if (args?.task_id) {
        return sopMod.getTaskFull(String(args.task_id));
      }
      return sopMod.listTasks({});
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：知识库                                                         */
/* ------------------------------------------------------------------ */

function registerKbSearchTool(ctx) {
  ctx.tools.register({
    name: 'kb_search',
    description: '检索企业知识库（产品/报价政策/案例/市场规则/品牌）。回复客户、写开发信、报价前先查这里，引用 citation 作依据；没命中就明说资料不足，不要编造。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['product', 'policy', 'case', 'market', 'brand'] },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `kb_search: ${args?.query ?? ''}`, kind: 'search', rawInput: args }),
    async execute(args) {
      const hits = kbMod.search({ query: args?.query, type: args?.type, limit: args?.limit });
      return { hits, hint: hits.length === 0 ? '没有命中。请告知用户资料不足，或请用户用 kb_upsert 录入。' : '回复时引用 citation 字段' };
    },
  });
}

function registerKbUpsertTool(ctx) {
  ctx.tools.register({
    name: 'kb_upsert',
    description: '录入/更新企业知识（用户确认过的事实才允许写入；禁止写入密码/token）。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['product', 'policy', 'case', 'market', 'brand'] },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['type', 'title', 'content'],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `kb_upsert: ${args?.title ?? ''}`, kind: 'update', rawInput: args }),
    async execute(args) {
      if (/passw|token|secret|api[_-]?key/i.test(String(args?.content ?? ''))) {
        throw new Error('知识库禁止写入密码/token/密钥类内容');
      }
      const entry = kbMod.upsert({ type: args?.type, title: args?.title, content: args?.content, tags: args?.tags });
      return { id: entry.id, title: entry.title, version: entry.version };
    },
  });
}

function registerKbListTool(ctx) {
  ctx.tools.register({
    name: 'kb_list',
    description: '列出知识库条目。',
    parameters: { type: 'object', properties: { type: { type: 'string' } } },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'kb_list', kind: 'list', rawInput: args }),
    async execute(args) {
      return kbMod.list({ type: args?.type });
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：WhatsApp（同步/审核/发送/媒体/群发）                            */
/* ------------------------------------------------------------------ */

function registerWaSyncTool(ctx) {
  ctx.tools.register({
    name: 'wa_sync',
    description: '从 Evolution API 拉取 WhatsApp 最近会话，买家消息并入待审队列（webhook 不可达时的轮询兜底）。',
    parameters: {
      type: 'object',
      properties: {
        chats: { type: 'number', description: '拉取最近几个会话，默认10' },
        per_chat: { type: 'number', description: '每会话拉取条数，默认20' },
      },
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'wa_sync', kind: 'fetch', rawInput: args }),
    async execute(args, exec) {
      const payload = await evolutionMod.findChats(exec?.signal);
      const rawChats = Array.isArray(payload) ? payload : (payload?.chats ?? []);
      const wanted = rawChats.slice(0, Math.min(Math.max(args?.chats ?? 10, 1), 30));
      let added = 0;
      let scanned = 0;
      for (const chat of wanted) {
        const jid = chat?.id ?? chat?.remoteJid ?? chat?.chatId;
        if (typeof jid !== 'string' || jid === '') {
          continue;
        }
        const history = await evolutionMod.findMessages(jid, args?.per_chat ?? 20, exec?.signal).catch(() => null);
        if (!history) {
          continue;
        }
        const entries = evolutionMod.normalizeHistory(history, jid).filter((item) => !item.fromMe && item.chatJid && !item.chatJid.endsWith('@g.us'));
        scanned += entries.length;
        added += storeMod.upsertIncoming(entries).added;
      }
      return { chatsScanned: wanted.length, messagesScanned: scanned, added, queue: storeMod.stats() };
    },
  });
}

function registerWaQueueTool(ctx) {
  ctx.tools.register({
    name: 'wa_review_queue',
    description: '列出 WhatsApp 客服审核队列（pending/drafted/sent/ignored/all）。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'drafted', 'sent', 'ignored', 'all'] },
        limit: { type: 'number' },
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'wa_review_queue', kind: 'list', rawInput: args }),
    async execute(args) {
      const items = storeMod.pendingQueue({ status: args?.status ?? 'pending', limit: Math.min(Math.max(args?.limit ?? 50, 1), 200) });
      return { stats: storeMod.stats(), items };
    },
  });
}

function registerWaReplyTool(ctx) {
  ctx.tools.register({
    name: 'wa_reply',
    description: '审核并发送 WhatsApp 回复（人工审核后的动作）。群聊(@g.us)拒绝自动发送。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '消息ID' },
        text: { type: 'string' },
        action: { type: 'string', enum: ['send', 'ignore'], description: '默认send' },
      },
      required: ['id'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `wa_reply: ${args?.id ?? ''}`, kind: 'send', rawInput: args }),
    async execute(args) {
      const message = storeMod.getMessage(String(args?.id ?? ''));
      if (!message) {
        throw new Error(`message not found: ${args?.id}`);
      }
      if (args?.action === 'ignore') {
        storeMod.updateMessage(args.id, { status: 'ignored' });
        auditMod.audit('wa.ignore', { id: args.id });
        return { id: args.id, status: 'ignored' };
      }
      const text = String(args?.text ?? '').trim();
      if (text === '') {
        throw new Error('wa_reply 需要非空 text');
      }
      if (message.chatJid.endsWith('@g.us')) {
        throw new Error('群聊(@g.us)拒绝自动发送');
      }
      await evolutionMod.sendText(message.chatJid, text);
      storeMod.updateMessage(args.id, { status: 'sent', draft: text, sentAt: new Date().toISOString() });
      auditMod.audit('wa.send', { to: message.chatJid, id: args.id });
      return { id: args.id, status: 'sent', to: message.chatJid };
    },
  });
}

function registerWaSendTextTool(ctx) {
  ctx.tools.register({
    name: 'wa_send_text',
    description: '直接给 WhatsApp 号码发文本（主动开发，不经审核队列）。',
    parameters: {
      type: 'object',
      properties: { number: { type: 'string' }, text: { type: 'string' } },
      required: ['number', 'text'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `wa_send_text: ${args?.number ?? ''}`, kind: 'send', rawInput: args }),
    async execute(args) {
      const result = await evolutionMod.sendText(args?.number, args?.text);
      auditMod.audit('wa.send', { to: args?.number });
      return { sent: true, to: String(args?.number) };
    },
  });
}

function registerWaSendMediaTool(ctx) {
  ctx.tools.register({
    name: 'wa_send_media',
    description: '发 WhatsApp 媒体消息（图片/PDF/文档）。media 传 URL 或 base64。常配合 quote_pdf 发报价单。',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'string' },
        media: { type: 'string', description: 'http(s) URL 或 base64' },
        mediatype: { type: 'string', enum: ['image', 'document', 'video', 'audio'] },
        filename: { type: 'string' },
        caption: { type: 'string' },
      },
      required: ['number', 'media'],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `wa_send_media: ${args?.number ?? ''}`, kind: 'send', rawInput: { number: args?.number, mediatype: args?.mediatype } }),
    async execute(args) {
      const result = await evolutionMod.sendMedia(args?.number, { media: args?.media, mediatype: args?.mediatype ?? 'document', filename: args?.filename, caption: args?.caption });
      auditMod.audit('wa.sendMedia', { to: args?.number, mediatype: args?.mediatype ?? 'document' });
      return { sent: true, to: String(args?.number) };
    },
  });
}

function registerWaBroadcastTool(ctx) {
  ctx.tools.register({
    name: 'wa_broadcast',
    description:
      '受控 WhatsApp 群发：随机间隔(默认20-90秒)+每日上限(默认200)+连续3次失败熔断。可从 CRM 按分层/状态取收件人。⚠ 高频群发有封号风险，请控制节奏。',
    parameters: {
      type: 'object',
      properties: {
        numbers: { type: 'array', items: { type: 'string' }, description: '号码列表（与 crm_filter 二选一）' },
        crm_filter: { type: 'object', description: '{tier?, status?, limit?} 从CRM取WhatsApp号' },
        text: { type: 'string' },
        dry_run: { type: 'boolean', description: '默认true：只列出将发送的目标不发送' },
      },
      required: ['text'],
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'wa_broadcast', kind: 'broadcast', rawInput: { count: args?.numbers?.length ?? args?.crm_filter?.limit ?? '?', dry_run: args?.dry_run } }),
    async execute(args, exec) {
      let targets = (Array.isArray(args?.numbers) ? args.numbers : []).map((number) => ({ number: String(number).replace(/\D/g, ''), text: args?.text }));
      if (args?.crm_filter && typeof args.crm_filter === 'object') {
        const leads = crmMod.listLeads({ tier: args.crm_filter.tier, status: args.crm_filter.status, limit: Math.min(args.crm_filter.limit ?? 50, 200) });
        targets = targets.concat(leads.filter((lead) => lead.contacts.whatsapps?.length).map((lead) => ({ number: lead.contacts.whatsapps[0], text: args?.text, leadId: lead.id })));
      }
      targets = targets.filter((target) => target.number.length >= 8);
      const uniqueTargets = [...new Map(targets.map((target) => [target.number, target])).values()];
      const budget = evolutionMod.broadcastBudget();
      if (args?.dry_run !== false) {
        return { dryRun: true, wouldSend: uniqueTargets.length, budget, targets: uniqueTargets.slice(0, 20), hint: '确认无误后传 dry_run=false 真正发送' };
      }
      const result = await evolutionMod.broadcast(uniqueTargets, { signal: exec?.signal, onProgress: (sent, total) => { if (sent % 10 === 0) { console.error(`[waimao] broadcast ${sent}/${total}`); } } });
      auditMod.audit('wa.broadcast', { total: uniqueTargets.length, ...result });
      return result;
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：报价PDF / 定时任务 / 审计                                      */
/* ------------------------------------------------------------------ */

function registerQuotePdfTool(ctx) {
  ctx.tools.register({
    name: 'quote_pdf',
    description: '生成英文报价单 PDF（可配报价政策知识库）。返回文件路径，可配 wa_send_media 发给客户。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: '关联CRM线索（可选）' },
        items: { type: 'array', items: { type: 'object', properties: { desc: { type: 'string' }, qty: { type: 'number' }, unitPrice: { type: 'number' } }, required: ['desc', 'qty', 'unitPrice'] } },
        currency: { type: 'string', description: '默认USD' },
        lead_time: { type: 'string' },
        payment: { type: 'string' },
        validity: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['items'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `quote_pdf: ${args?.items?.length ?? 0} items`, kind: 'export', rawInput: { lead_id: args?.lead_id } }),
    async execute(args) {
      const kbPolicy = kbMod.contextFor('报价 政策 payment lead time', 2);
      const lead = args?.lead_id ? crmMod.getLead(String(args.lead_id)) : null;
      const quoteNo = `Q${Date.now().toString(36).toUpperCase()}`;
      const defaults = readConfig().quote ?? {};
      const buffer = quotePdf({
        quoteNo,
        from: { company: readConfig().smtp?.fromName ?? 'Our Company', email: readConfig().smtp?.from ?? '' },
        to: { company: lead?.company ?? args?.to_company ?? 'Valued Customer', contact: '', country: lead?.market ?? '' },
        items: args?.items ?? [],
        currency: args?.currency ?? defaults.currency ?? 'USD',
        leadTime: args?.lead_time ?? defaults.leadTime,
        payment: args?.payment ?? defaults.payment,
        validity: args?.validity ?? defaults.validity,
        notes: args?.notes ?? defaults.notes,
      });
      const file = join(EXPORT_DIR, quoteFileName(quoteNo));
      mkdirSync(EXPORT_DIR, { recursive: true });
      writeFileSync(file, buffer);
      if (lead) {
        crmMod.addActivity(lead.id, { type: 'quote', note: `报价单 ${quoteNo}: ${args?.items?.length ?? 0} 项` });
        crmMod.updateLead(lead.id, { status: lead.status === 'replied' ? 'quoted' : lead.status });
      }
      auditMod.audit('quote.pdf', { quoteNo, file, leadId: args?.lead_id ?? null });
      return { file, quoteNo, total: (args?.items ?? []).reduce((sum, item) => sum + Number(item.qty ?? 0) * Number(item.unitPrice ?? 0), 0), currency: args?.currency ?? 'USD', policyCited: kbPolicy || null };
    },
  });
}

function registerCronStatusTool(ctx) {
  ctx.tools.register({
    name: 'cron_status',
    description: '查看/手动触发定时任务（WA收件箱轮询、邮件序列、每日日报、停跟进提醒）。',
    parameters: {
      type: 'object',
      properties: { run: { type: 'string', description: '手动触发指定任务名' } },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'cron_status', kind: 'status', rawInput: args }),
    async execute(args) {
      if (args?.run) {
        return { triggered: await cronMod.runOnce(String(args.run)) };
      }
      return cronMod.status();
    },
  });
}

function registerAuditQueryTool(ctx) {
  ctx.tools.register({
    name: 'audit_query',
    description: '查询审计日志（谁在什么时候发了什么/改了什么），可按动作/角色过滤。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '如 email.send / wa.send / crm.status / sop.stage / track.open' },
        actor: { type: 'string', enum: ['agent', 'user', 'cron'] },
        limit: { type: 'number' },
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'audit_query', kind: 'list', rawInput: args }),
    async execute(args) {
      return { entries: auditMod.queryAudit({ action: args?.action, actor: args?.actor, limit: Math.min(Math.max(args?.limit ?? 50, 1), 300) }) };
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：定价计算 / PI发票 / 蓝海选国 / 口播脚本 / 备份（v0.6）          */
/* ------------------------------------------------------------------ */

function registerPriceCalcTool(ctx) {
  ctx.tools.register({
    name: 'price_calc',
    description:
      '外贸定价计算器：按 Incoterms 2020 叠加成本算 EXW/FOB/CFR/CIF/DDP，可加利润率出报价，附单件价。mode=total 输入整批费用；mode=unit 输入单件成本（自动乘数量）。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['total', 'unit'], description: '默认total' },
        exw: { type: 'number', description: '出厂成本' },
        inland: { type: 'number', description: '国内内陆运费' },
        port: { type: 'number', description: '港口/报关费' },
        ocean: { type: 'number', description: '海运费' },
        insurance_rate: { type: 'number', description: '保险费率%（基于CFR），默认0' },
        duty_rate: { type: 'number', description: '目的国关税+增值税综合税率%（基于CIF，DDP 报价必填，漏报会严重低估）' },
        dest: { type: 'number', description: '目的港清关费(DDP用)' },
        dest_freight: { type: 'number', description: '目的地运费(DDP用)' },
        margin: { type: 'number', description: '利润率%（如25）' },
        qty: { type: 'number', description: '数量（unit模式必填）' },
      },
      required: ['exw'],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `price_calc: EXW=${args?.exw} +${args?.margin ?? 0}%`, kind: 'calc', rawInput: args }),
    async execute(args) {
      const calc = calcPrice({
        mode: args?.mode, exw: args?.exw, inland: args?.inland, port: args?.port,
        ocean: args?.ocean, insuranceRate: args?.insurance_rate, dutyRate: args?.duty_rate, dest: args?.dest,
        destFreight: args?.dest_freight, margin: args?.margin, qty: args?.qty,
      });
      return { ...calc, quoteText: quoteLines(calc).join('\n') };
    },
  });
}

function registerProformaPdfTool(ctx) {
  ctx.tools.register({
    name: 'proforma_pdf',
    description:
      'PI 形式发票 PDF：比报价单正式——Incoterms 2020、HS 编码、原产国/目的国、银行收款信息、双方签章栏。客户开信用证/预付款/清关估价用。可配 wa_send_media 发送。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { desc: { type: 'string' }, hs_code: { type: 'string' }, qty: { type: 'number' }, unitPrice: { type: 'number' } }, required: ['desc', 'qty', 'unitPrice'] } },
        currency: { type: 'string' },
        incoterm: { type: 'string', description: 'FOB/CIF/EXW/DDP…默认FOB' },
        payment: { type: 'string' },
        lead_time: { type: 'string' },
        origin: { type: 'string', description: '原产国，默认China' },
        destination: { type: 'string' },
        bank_name: { type: 'string' },
        bank_account: { type: 'string' },
        bank_swift: { type: 'string' },
        bank_beneficiary: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['items'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `proforma_pdf: ${args?.items?.length ?? 0} items`, kind: 'export', rawInput: { lead_id: args?.lead_id, incoterm: args?.incoterm } }),
    async execute(args) {
      const lead = args?.lead_id ? crmMod.getLead(String(args.lead_id)) : null;
      const piNo = `PI-${Date.now().toString(36).toUpperCase()}`;
      const defaults = readConfig().quote ?? {};
      const buffer = proformaPdf({
        piNo,
        from: { company: readConfig().smtp?.fromName ?? 'Our Company', email: readConfig().smtp?.from ?? '' },
        to: { company: lead?.company ?? 'Valued Customer', country: lead?.market ?? '' },
        items: (args?.items ?? []).map((item) => ({ ...item, hsCode: item.hs_code ?? item.hsCode })),
        currency: args?.currency ?? defaults.currency ?? 'USD',
        incoterm: args?.incoterm,
        payment: args?.payment ?? defaults.payment,
        leadTime: args?.lead_time ?? defaults.leadTime,
        origin: args?.origin,
        destination: args?.destination,
        bank: {
          name: args?.bank_name ?? defaults.bank?.name,
          account: args?.bank_account ?? defaults.bank?.account,
          swift: args?.bank_swift ?? defaults.bank?.swift,
          beneficiary: args?.bank_beneficiary ?? defaults.bank?.beneficiary,
        },
        notes: args?.notes ?? defaults.notes,
      });
      const file = join(EXPORT_DIR, `${piNo}.pdf`);
      mkdirSync(EXPORT_DIR, { recursive: true });
      writeFileSync(file, buffer);
      if (lead) {
        crmMod.addActivity(lead.id, { type: 'quote', note: `PI ${piNo} (${args?.incoterm ?? 'FOB'})` });
        crmMod.updateLead(lead.id, { status: lead.status === 'replied' ? 'quoted' : lead.status });
      }
      auditMod.audit('quote.proforma', { piNo, file, leadId: args?.lead_id ?? null });
      return { file, piNo, incoterm: args?.incoterm ?? 'FOB', total: (args?.items ?? []).reduce((sum, item) => sum + Number(item.qty ?? 0) * Number(item.unitPrice ?? 0), 0), currency: args?.currency ?? 'USD' };
    },
  });
}

function registerMarketScanTool(ctx) {
  ctx.tools.register({
    name: 'market_scan',
    description:
      '蓝海选国：同一产品在多个市场跑基础搜索，对比「结果量(竞争噪声) × 买家信号密度(需求)」→ 机会评分排名（🔵蓝海/🟡可试/🔴红海）。搜索侧启发，建议结合海关数据复核。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: '英文产品词' },
        markets: { type: 'array', items: { type: 'string' }, description: '市场key列表，默认 mx,us,br,de,ae,id' },
        per_market: { type: 'number', description: '每市场搜索条数，默认8' },
      },
      required: ['product'],
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `market_scan: ${args?.product ?? ''}`, kind: 'search', rawInput: args }),
    async execute(args, exec) {
      return scanMarkets({ product: args?.product, markets: args?.markets, perMarket: args?.per_market, signal: exec?.signal });
    },
  });
}

function registerVideoScriptTool(ctx) {
  ctx.tools.register({
    name: 'video_script',
    description: '口播脚本生成器：TikTok/Reels/Shorts 短视频脚本（hook→痛点→产品→CTA，带分镜时间轴和标签），AI 生成、模板兜底。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string' },
        audience: { type: 'string', description: '默认 importers & wholesalers' },
        platform: { type: 'string', enum: ['tiktok', 'reels', 'shorts'] },
        seconds: { type: 'number', description: '默认30' },
        language: { type: 'string' },
      },
      required: ['product'],
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `video_script: ${args?.product ?? ''}`, kind: 'create', rawInput: args }),
    async execute(args) {
      const script = await videoScript({
        product: args?.product, audience: args?.audience, platform: args?.platform,
        seconds: args?.seconds, language: args?.language,
      });
      return { ...script, rendered: renderScript(script) };
    },
  });
}

function registerIcpSetTool(ctx) {
  ctx.tools.register({
    name: 'icp_set',
    description:
      '设置 ICP 画像：我方产品（一句英文，如 professional hair dryers 1800-2400W）和对口买家类型（如 wholesalers, beauty supply distributors, salon equipment dealers）。设置后 lead_enrich/lead_score 评分会判断线索是否对口并给出理由，email_compose 写信也知道你卖什么。用户在对话里描述完产品后主动调用。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: '产品一句话（英文）' },
        buyers: { type: 'string', description: '对口买家类型（英文，逗号分隔）' },
      },
      required: ['product'],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `icp_set: ${args?.product ?? ''}`, kind: 'config', rawInput: args }),
    async execute(args) {
      const product = String(args?.product ?? '').trim().slice(0, 300);
      const buyers = String(args?.buyers ?? '').trim().slice(0, 300);
      if (!product) {
        throw new Error('product 不能为空');
      }
      configMod.writeConfig({ icp: { product, buyers } });
      return { saved: true, icp: { product, buyers }, note: '已生效：之后的评分和开发信都会带上这个画像' };
    },
  });
}

function registerDataBackupTool(ctx) {
  ctx.tools.register({
    name: 'data_backup',
    description: '导出全部业务数据为单个 JSON 备份（CRM/线索runs/知识库/模板/审核消息/审计尾部），返回文件路径。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'data_backup', kind: 'export', rawInput: args }),
    async execute() {
      const read = (file) => {
        try {
          return JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          return null;
        }
      };
      const { homedir } = await import('node:os');
      const home = homedir();
      const data = (name) => read(join(home, '.waimao', 'data', name));
      // 审计日志尾部（JSONL 只取最后 200 行，避免备份无限膨胀）
      let auditTail = null;
      try {
        auditTail = data('audit.jsonl')?.split?.('\n').filter(Boolean).slice(-200) ?? null;
      } catch {}
      const bundle = {
        exportedAt: new Date().toISOString(),
        version: '0.7.2',
        crm: data('crm.json'),
        leads: data('leads.jsonl')?.split?.('\n').filter(Boolean) ?? null,
        kb: data('kb.json'),
        templates: data('templates.json'),
        messages: data('messages.json'),
        suppress: data('suppress.json'),
        domainBlacklist: data('domain-blacklist.json'),
        sop: data('sop.json'),
        monitor: data('monitor.json'),
        tracking: data('tracking.json'),
        warmup: data('warmup.json'),
        broadcast: data('broadcast.json'),
        cronState: data('cron.json'),
        auditTail,
      };
      const file = join(EXPORT_DIR, `backup-${new Date().toISOString().slice(0, 10)}.json`);
      mkdirSync(EXPORT_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(bundle, null, 1), { mode: 0o600 });
      auditMod.audit('data.backup', { file });
      let bytes = -1;
      try {
        bytes = statSync(file).size;
      } catch {}
      return { file, bytes };
    },
  });
}

function registerInstantlyTools(ctx) {
  ctx.tools.register({
    name: 'instantly_campaign_list',
    description: '列出 Instantly.ai 的发信活动和账号（需 instantly.apiKey）。推送线索前先查 campaign_id。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'instantly_campaign_list', kind: 'list', rawInput: args }),
    async execute() {
      const [campaigns, accounts] = await Promise.all([
        instantlyMod.listCampaigns({ limit: 50 }),
        instantlyMod.listAccounts({ limit: 50 }).catch(() => null),
      ]);
      return {
        campaigns: (Array.isArray(campaigns) ? campaigns : campaigns?.campaigns ?? []).map((c) => ({ id: c.id ?? c.campaign_id, name: c.name ?? c.title, status: c.status })),
        accounts: accounts ? (Array.isArray(accounts) ? accounts : accounts?.accounts ?? []).map((a) => ({ email: a.email, status: a.status })) : null,
      };
    },
  });
  ctx.tools.register({
    name: 'instantly_push_leads',
    description:
      '把 CRM 线索批量推送到 Instantly 活动开跑：默认排除 replied/won/lost（在谈客户不能进冷邮序列），按评分/对口过滤，reason 进 personalization 变量，≤500/批。dry_run 默认 true 先看会推多少。',
    parameters: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Instantly 活动 ID' },
        status: { type: 'string', description: '显式指定则只推该状态；缺省=排除 replied/won/lost 的其余线索' },
        min_score: { type: 'number', description: '最低评分，默认 7' },
        fit: { type: 'string', enum: ['yes', 'partial'], description: '只推对口的，默认 yes' },
        limit: { type: 'number', description: '最多推多少条，默认 100' },
        dry_run: { type: 'boolean', description: '默认 true；确认列表后传 false 真实推送' },
      },
      required: ['campaign_id'],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `instantly_push_leads → ${args?.campaign_id ?? ''}`, kind: 'update', rawInput: args }),
    async execute(args) {
      const minScore = Number(args?.min_score ?? 7);
      const fit = args?.fit ?? 'yes';
      const limit = Math.min(Number(args?.limit ?? 100), 1000);
      const base = args?.status
        ? crmMod.listLeads({ status: args.status, limit: 500 })
        : crmMod.listLeads({ limit: 500 }).filter((lead) => !['replied', 'won', 'lost'].includes(lead.status));
      const candidates = base
        .filter((lead) => lead.contacts.emails?.length)
        .filter((lead) => (Number(lead.score ?? 0) >= minScore))
        .filter((lead) => (fit === 'any' ? true : lead.fit === fit))
        .slice(0, limit);
      // 同邮箱去重（跨公司重复抓取时常见）
      const seenEmails = new Set();
      const unique = candidates.filter((lead) => {
        const email = String(lead.contacts.emails[0]).toLowerCase();
        if (seenEmails.has(email)) return false;
        seenEmails.add(email);
        return true;
      });
      const payload = unique.map(instantlyMod.toInstantLead).filter((l) => l.email);
      if (args?.dry_run !== false) {
        auditMod.audit('instantly.push.dry_run', { campaignId: args?.campaign_id, count: payload.length }, 'agent');
        return { dryRun: true, wouldPush: payload.length, sample: payload.slice(0, 5), note: '确认无误后带 dry_run:false 真实推送' };
      }
      const result = await instantlyMod.addLeads({ campaignId: args?.campaign_id, leads: payload });
      auditMod.audit('instantly.push', { campaignId: args?.campaign_id, count: result.total }, 'agent');
      return { ...result, pushed: result.total };
    },
  });
}

function registerDeliverabilityCheckTool(ctx) {
  ctx.tools.register({
    name: 'deliverability_check',
    description:
      '发信域名送达率体检：SPF/DKIM/DMARC/MX 的 DNS 检查 + 可执行修复建议。第一次真实发开发信之前必跑。',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: '发信域名（smtp.from 的 @ 后部分），缺省自动取 smtp.from' },
        dkim_selector: { type: 'string', description: '自定义 DKIM selector（可选）' },
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'deliverability_check', kind: 'check', rawInput: args }),
    async execute(args) {
      const domain = String(args?.domain ?? '').trim() || String(smtpOf().from ?? '').split('@')[1] || '';
      if (!domain) {
        throw new Error('没有 domain：传 domain 参数或先配置 smtp.from');
      }
      return deliverabilityCheck(domain, { dkimSelector: args?.dkim_selector });
    },
  });
}

function registerTemplateTools(ctx) {
  ctx.tools.register({
    name: 'template_save',
    description: '保存/更新邮件模板到模板库（name 唯一，同名覆盖）。之后 email_compose 可配 template_id/name 复用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        language: { type: 'string', enum: ['en', 'es', 'pt'] },
        subject: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'subject', 'body'],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `template_save: ${args?.name ?? ''}`, kind: 'update', rawInput: args }),
    async execute(args) {
      const template = templatesMod.saveTemplate(args);
      return { id: template.id, name: template.name, language: template.language };
    },
  });
  ctx.tools.register({
    name: 'template_list',
    description: '列出模板库（可按语言过滤）。',
    parameters: { type: 'object', properties: { language: { type: 'string' } } },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'template_list', kind: 'list', rawInput: args }),
    async execute(args) {
      return templatesMod.listTemplates({ language: args?.language });
    },
  });
  ctx.tools.register({
    name: 'template_delete',
    description: '删除模板。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `template_delete: ${args?.id ?? ''}`, kind: 'delete', rawInput: args }),
    async execute(args) {
      const removed = templatesMod.removeTemplate(String(args?.id ?? ''), 'user');
      return { deleted: removed.name };
    },
  });
}

function registerWarmupStatusTool(ctx) {
  ctx.tools.register({
    name: 'warmup_status',
    description:
      '邮箱预热：status=查看爬坡进度与今日额度；run=手动跑一轮互动预热（主账号↔伙伴账号互发+自动回复+标星，cron 每天也会跑）。新域名/新账号先预热再发开发信，否则必进垃圾箱。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'run'], description: '默认status' },
      },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `warmup_status: ${args?.action ?? 'status'}`, kind: 'status', rawInput: args }),
    async execute(args) {
      if (args?.action === 'run') {
        const result = await warmupMod.runWarmupRound({});
        return { ...result, budget: warmupMod.todayBudget() };
      }
      return warmupMod.warmupStatus();
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：回复扫描 / 抑制列表 / 背调 / 监控 / 统计（v0.3）                */
/* ------------------------------------------------------------------ */

function registerEmailScanRepliesTool(ctx) {
  ctx.tools.register({
    name: 'email_scan_replies',
    description:
      '扫描收件箱找买家回复（IMAP）：按 CRM 线索邮箱搜索最近 N 天来信，AI 分类（interested/pricing/not-interested/ooo/auto/unsubscribe），自动改状态 replied、停跟进序列、退订自动进抑制列表。cron 也会定期跑，这个工具用于手动触发/补扫。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回溯天数，默认14' },
        limit: { type: 'number', description: '最多检查线索数，默认30' },
        use_ai: { type: 'boolean', description: 'AI分类，默认true（无key回退规则）' },
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'email_scan_replies', kind: 'fetch', rawInput: args }),
    async execute(args, exec) {
      const result = await scanReplies({ days: args?.days, limit: args?.limit, useAI: args?.use_ai, signal: exec?.signal });
      return {
        ...result,
        hint: result.replies.length > 0
          ? '回复已自动落库。interested/pricing 的线索建议立即跟进：看 lastReply.summary 与 suggestedAction。'
          : '本轮没有新回复。',
      };
    },
  });
}

function registerEmailSuppressTool(ctx) {
  ctx.tools.register({
    name: 'email_suppress',
    description: '管理邮件抑制列表（合规）：add=加入地址 / remove=移除 / domain_add=整个域名拉黑(退信/投诉后同公司其他联系人也是坏地址) / list=查看。发送前强制拦截。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'domain_add', 'list'], description: '默认list' },
        email: { type: 'string' },
        domain: { type: 'string', description: 'action=domain_add 时必填，如 buyer.example.com' },
        reason: { type: 'string', description: 'unsubscribe/bounce/complaint/manual' },
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `email_suppress: ${args?.action ?? 'list'}`, kind: 'update', rawInput: args }),
    async execute(args) {
      if (args?.action === 'add') {
        return suppressMod.suppress(args?.email, args?.reason ?? 'manual', 'user');
      }
      if (args?.action === 'remove') {
        return suppressMod.unsuppress(args?.email, 'user');
      }
      if (args?.action === 'domain_add') {
        const domain = args?.domain ?? suppressMod.domainOf(args?.email);
        return suppressMod.blacklistDomain(domain, args?.reason ?? 'manual', 'user');
      }
      return suppressMod.suppressStats();
    },
  });
}

function registerEmailStatsTool(ctx) {
  ctx.tools.register({
    name: 'stats_report',
    description: '效果统计：漏斗转化、分层回复率、市场分布、回复分类、触达量。回复数据来自 email_scan_replies 自动检测。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'stats_report', kind: 'report', rawInput: args }),
    async execute() {
      return statsMod.report();
    },
  });
}

function registerCompanyDossierTool(ctx) {
  ctx.tools.register({
    name: 'company_dossier',
    description:
      '公司背调：RDAP 查 WHOIS（域名年龄/注册商/到期，新域名<6个月标警）+ 首页技术栈指纹（Shopify/WooCommerce/WordPress/像素等）+ 业务信号（招聘=扩张、进口职能等）。可落库到 CRM 线索。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'CRM线索ID（可选，结果落库）' },
        domain: { type: 'string', description: '域名（无 lead_id 时必填）' },
      },
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `company_dossier: ${args?.domain ?? args?.lead_id ?? ''}`, kind: 'research', rawInput: args }),
    async execute(args, exec) {
      if (!args?.lead_id && !args?.domain) {
        throw new Error('需要 lead_id 或 domain');
      }
      return companyDossier({ lead_id: args?.lead_id, domain: args?.domain, signal: exec?.signal });
    },
  });
}

function registerMonitorWatchTool(ctx) {
  ctx.tools.register({
    name: 'monitor_watch',
    description:
      '监控客户官网变化（意图信号）：add/remove/list。cron 定期检查页面哈希，变化时记 CRM 活动（命中 new product/hiring/expansion 等信号词会特别标注）——客户扩张/换供应商时是最佳触达时机。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list'], description: '默认list' },
        lead_id: { type: 'string' },
        url: { type: 'string', description: '默认监控线索官网首页' },
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `monitor_watch: ${args?.action ?? 'list'}`, kind: 'update', rawInput: args }),
    async execute(args) {
      if (args?.action === 'add') {
        return monitorMod.watch(String(args?.lead_id ?? ''), { url: args?.url });
      }
      if (args?.action === 'remove') {
        return monitorMod.unwatch(String(args?.lead_id ?? ''));
      }
      return { ...monitorMod.stats(), targets: monitorMod.listWatched() };
    },
  });
}

function registerMonitorCheckTool(ctx) {
  ctx.tools.register({
    name: 'monitor_check',
    description: '手动检查一轮全部被监控的客户官网（cron 也会自动跑）。',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'monitor_check', kind: 'fetch', rawInput: args }),
    async execute(args, exec) {
      return monitorMod.checkAll({ limit: args?.limit, signal: exec?.signal });
    },
  });
}

/* ------------------------------------------------------------------ */
/* 回环路由（5 页面 + JSON API + webhook）                              */
/* ------------------------------------------------------------------ */

function registerRoutes(scope) {
  const route = (name, kind, path, handler) =>
    scope.webServer.register({ name, kind, path, handler });

  route('waimao-root', 'exact', '/waimao', (req, res) => {
    res.writeHead(302, { location: '/waimao/leads' });
    res.end();
  });
  route('waimao-leads-page', 'exact', '/waimao/leads', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendHtml(res, 200, pagesMod.leadsPage());
  });
  route('waimao-crm-page', 'exact', '/waimao/crm', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendHtml(res, 200, pagesMod.crmPage());
  });
  route('waimao-review-page', 'exact', '/waimao/review', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendHtml(res, 200, pagesMod.reviewPage());
  });
  route('waimao-settings-page', 'exact', '/waimao/settings', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendHtml(res, 200, pagesMod.settingsPage());
  });
  route('waimao-templates-page', 'exact', '/waimao/templates', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendHtml(res, 200, pagesMod.templatesPage());
  });

  // 模板库 API（邮件模板 + 报价默认条款）
  route('waimao-templates-api', 'exact', '/waimao/api/templates', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      if (req.method === 'POST') {
        const body = await httpMod.readBody(req);
        const saved = templatesMod.saveTemplate({
          name: body.name, language: body.language, subject: body.subject, body: body.body, tags: Array.isArray(body.tags) ? body.tags : [],
        }, 'user');
        auditMod.audit('template.save', { id: saved.id, name: saved.name }, 'user');
        httpMod.sendJson(res, 200, { saved: true, template: saved });
        return;
      }
      httpMod.sendJson(res, 200, templatesMod.listTemplates());
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });
  route('waimao-templates-delete', 'exact', '/waimao/api/templates/delete', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const removed = templatesMod.removeTemplate(String(body.id ?? ''), 'user');
      auditMod.audit('template.delete', { id: body.id }, 'user');
      httpMod.sendJson(res, 200, { removed: true, id: removed.id });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });
  route('waimao-quote-defaults', 'exact', '/waimao/api/quote-defaults', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendJson(res, 200, (configMod.configSummary().quote) ?? {});
  });

  route('waimao-status', 'exact', '/waimao/api/status', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendJson(res, 200, configMod.configSummary());
  });

  route('waimao-markets', 'exact', '/waimao/api/markets', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendJson(res, 200, marketOptions());
  });

  // 配置读写（密钥只写不读：configSummary 不含密钥原文）
  route('waimao-config', 'exact', '/waimao/api/config', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    if (req.method === 'GET') {
      httpMod.sendJson(res, 200, configMod.configSummary());
      return;
    }
    try {
      const patch = await httpMod.readBody(req);
      // 密钥空串不覆盖
      for (const section of Object.keys(patch)) {
        if (typeof patch[section] !== 'object' || patch[section] === null) {
          delete patch[section];
        }
      }
      configMod.writeConfig(patch);
      auditMod.audit('config.update', { sections: Object.keys(patch) }, 'user');
      httpMod.sendJson(res, 200, configMod.configSummary());
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  // 连通性测试（exact 路由 × 4，共用 handler）
  const testHandler = async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    const name = String(req.url ?? '').split('/').pop().split('?')[0];
    const send = (ok, message) => httpMod.sendJson(res, 200, { ok, message });
    try {
      if (name === 'serp') {
        const { serpSearchChained } = await import('./serp.js');
        const { results, engine, attempts } = await serpSearchChained('test', { maxResults: 3, signal: AbortSignal.timeout(25_000) });
        send(true, `引擎 ${engine} 正常，返回 ${results.length} 条${attempts.length > 1 ? `（failover: ${attempts.map((a) => a.engine ?? a.skipped).join(' -> ')}）` : ''}`);
      } else if (name === 'smtp') {
        const { probeSmtp } = await import('./mail/smtp.js');
        const message = await probeSmtp(smtpOf());
        send(true, message);
      } else if (name === 'evolution') {
        const chats = await evolutionMod.findChats(AbortSignal.timeout(15_000));
        const count = Array.isArray(chats) ? chats.length : (chats?.chats?.length ?? 0);
        send(true, `Evolution 正常，${count} 个会话`);
      } else if (name === 'deepseek') {
        const config = readConfig();
        if (!config.deepseek.apiKey) {
          send(false, '未配置 deepseek.apiKey');
          return;
        }
        const response = await fetch(`${config.deepseek.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.deepseek.apiKey}` },
          body: JSON.stringify({ model: config.deepseek.model ?? 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
          signal: AbortSignal.timeout(30_000),
        });
        send(response.ok, response.ok ? 'DeepSeek 正常' : `HTTP ${response.status}`);
      } else if (name === 'imap') {
        const config = readConfig();
        const message = await imapProbe(config.imap ?? {});
        send(true, message);
      } else if (name === 'instantly') {
        if (!instantlyMod.instantlyConfigured()) {
          send(false, '未配置 instantly.apiKey');
          return;
        }
        const accounts = await instantlyMod.listAccounts({ limit: 5 });
        const list = Array.isArray(accounts) ? accounts : accounts?.accounts ?? [];
        send(true, `Instantly 正常，工作区 ${list.length}+ 个发信账号`);
      } else {
        httpMod.sendJson(res, 404, { error: `unknown test: ${name}` });
      }
    } catch (error) {
      httpMod.sendJson(res, 200, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  };
  for (const engine of ['serp', 'smtp', 'evolution', 'deepseek', 'imap', 'instantly']) {
    route(`waimao-test-${engine}`, 'exact', `/waimao/api/test/${engine}`, testHandler);
  }

  // WhatsApp 扫码接入（Evolution 实例配对）
  route('waimao-evolution-connect', 'exact', '/waimao/api/evolution/connect', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const result = await evolutionMod.connectInstance();
      auditMod.audit('wa.connect', { connected: result.connected }, 'user');
      httpMod.sendJson(res, 200, result);
    } catch (error) {
      httpMod.sendJson(res, 200, { connected: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });
  route('waimao-evolution-state', 'exact', '/waimao/api/evolution/state', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      httpMod.sendJson(res, 200, await evolutionMod.connectionState());
    } catch (error) {
      httpMod.sendJson(res, 200, { connected: false, state: 'unknown', error: String(error?.message ?? error).slice(0, 200) });
    }
  });

  // 线索加工
  route('waimao-leads-search', 'exact', '/waimao/api/leads/search', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const run = await leadsMod.runLeadSearch({ product: body.product, market: body.market, layers: body.layers, perLayer: body.perLayer, engine: body.engine || undefined, source: body.source });
      httpMod.sendJson(res, 200, run);
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-leads-enrich', 'exact', '/waimao/api/leads/enrich', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const run = body.run_id ? leadsMod.findRun(String(body.run_id)) : leadsMod.loadRuns(1)[0];
      if (!run) {
        httpMod.sendJson(res, 404, { error: 'run not found' });
        return;
      }
      const records = await enrichMod.enrichResults(run.results, {
        product: run.product, market: run.market, runId: run.id,
        limit: body.limit, useAI: body.useAI, fetchPages: body.fetchPages, saveToCrm: true, actor: 'user',
      });
      httpMod.sendJson(res, 200, records.map((item) => ({
        url: item.url, title: item.title, company: item.company, kind: item.kind, keep: item.keep,
        reason: item.reason, score: item.score, tier: item.tier, fit: item.fit, advice: item.advice,
        contacts: item.contacts, leadId: item.leadId, merged: item.merged, error: item.error,
      })));
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-leads-export', 'exact', '/waimao/api/leads/export.csv', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const run = url.searchParams.has('run') ? leadsMod.findRun(String(url.searchParams.get('run'))) : leadsMod.loadRuns(1)[0];
    if (!run) { httpMod.sendJson(res, 404, { error: 'run not found' }); return; }
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="leads-${run.id}.csv"` });
    res.end(leadsMod.toLeadCsv(run));
  });

  // CRM
  route('waimao-crm-list', 'exact', '/waimao/api/crm/list', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const leads = crmMod.listLeads({
      status: url.searchParams.get('status') ?? undefined,
      tier: url.searchParams.get('tier') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    });
    httpMod.sendJson(res, 200, leads.map((lead) => ({
      id: lead.id, company: lead.company || lead.domain, domain: lead.domain, market: lead.market,
      status: lead.status, score: lead.score, tier: lead.tier, advice: lead.advice,
      fit: lead.fit ?? null,
      lastReply: lead.lastReply ?? null,
      contacts: lead.contacts, sequence: lead.sequence ? sequenceSummary(lead.sequence) : null,
      activities: (lead.activities ?? []).slice(-3),
    })));
  });

  route('waimao-crm-update', 'exact', '/waimao/api/crm/update', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      let sequence;
      if (body.status === 'replied') {
        const lead = crmMod.getLead(String(body.id ?? ''));
        if (lead?.sequence) {
          sequence = stopSequence(lead.sequence, 'buyer replied');
        }
      }
      const lead = crmMod.updateLead(String(body.id ?? ''), { status: body.status, tags: body.tags, ownerNote: body.note, sequence }, { actor: 'user' });
      httpMod.sendJson(res, 200, { id: lead.id, status: lead.status });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-crm-activity', 'exact', '/waimao/api/crm/activity', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const activity = crmMod.addActivity(String(body.id ?? ''), { type: body.type ?? 'note', note: body.note, actor: 'user' });
      httpMod.sendJson(res, 200, activity);
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-crm-compose', 'exact', '/waimao/api/crm/compose', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const lead = crmMod.getLead(String(body.id ?? ''));
      if (!lead) { httpMod.sendJson(res, 404, { error: 'lead not found' }); return; }
      const draft = await composeMod.composeEmail({
        kind: 'first', company: lead.company || lead.domain, market: lead.market,
        me: readConfig().smtp?.fromName ?? 'Sales',
        product: readConfig().icp?.product || undefined,
        buyers: readConfig().icp?.buyers || undefined,
        knowledge: kbMod.contextFor(`${lead.market} 报价 产品`) || undefined,
      });
      crmMod.updateLead(lead.id, { pendingEmail: draft }, { activityNote: `网页生成开发信草稿(${draft.generatedBy})`, actor: 'user' });
      httpMod.sendJson(res, 200, draft);
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-crm-send-email', 'exact', '/waimao/api/crm/send-email', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const lead = crmMod.getLead(String(body.id ?? ''));
      if (!lead) { httpMod.sendJson(res, 404, { error: 'lead not found' }); return; }
      const to = lead.contacts.emails?.[0];
      if (!to) { httpMod.sendJson(res, 400, { error: '该线索没有邮箱' }); return; }
      const result = await sendEmailGuarded({ to, toName: lead.company, subject: String(body.subject ?? ''), body: String(body.body ?? ''), leadId: lead.id, actor: 'user' });
      if (result.dryRun) {
        crmMod.addActivity(lead.id, { type: 'email-draft', note: `[dry-run] ${body.subject}`, actor: 'user' });
      } else {
        crmMod.updateLead(lead.id, { status: ['new', 'qualified'].includes(lead.status) ? 'contacted' : lead.status }, { activityNote: `开发信已发送: ${body.subject}`, actor: 'user' });
      }
      httpMod.sendJson(res, 200, result);
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-crm-sequence-start', 'exact', '/waimao/api/crm/sequence-start', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const lead = crmMod.getLead(String(body.id ?? ''));
      if (!lead) { httpMod.sendJson(res, 404, { error: 'lead not found' }); return; }
      if (!lead.contacts.emails?.length) { httpMod.sendJson(res, 400, { error: '该线索没有邮箱' }); return; }
      const language = languageFor(lead.market);
      const sequence = newSequence({ language });
      const first = await composeMod.composeEmail({ kind: 'first', company: lead.company || lead.domain, market: lead.market, language, me: readConfig().smtp?.fromName ?? 'Sales', product: readConfig().icp?.product || undefined, buyers: readConfig().icp?.buyers || undefined });
      sequence.steps[0].subject = first.subject;
      sequence.steps[0].body = first.body;
      sequence.subject0 = first.subject;
      fillFollowUpSteps(sequence, { market: lead.market, language });
      crmMod.updateLead(lead.id, { sequence }, { activityNote: '网页启动4步跟进序列', actor: 'user' });
      httpMod.sendJson(res, 200, { ok: true, language, firstSubject: first.subject });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-crm-export', 'exact', '/waimao/api/crm/export.csv', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const leads = crmMod.listLeads({ status: url.searchParams.get('status') ?? undefined, limit: 2000 });
    const importer = url.searchParams.get('format') === 'importer';
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="crm-export.csv"` });
    res.end(importer
      ? toCsv(IMPORTER_CSV_HEADERS, leads.map(importerRowFromLead))
      : toCsv(CRM_CSV_HEADERS, leads.map(crmRow)));
  });

  // vCard 导出（单条 ?id= 或全部）
  route('waimao-crm-vcard', 'exact', '/waimao/api/crm/vcard', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const leads = id ? [crmMod.getLead(String(id))].filter(Boolean) : crmMod.listLeads({ limit: 2000 });
    if (leads.length === 0) { httpMod.sendJson(res, 404, { error: 'no leads' }); return; }
    res.writeHead(200, { 'content-type': 'text/vcard; charset=utf-8', 'content-disposition': `attachment; filename="waimao-leads.vcf"` });
    res.end(toVcf(leads));
  });

  // 批量操作
  route('waimao-crm-bulk', 'exact', '/waimao/api/crm/bulk', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const results = crmMod.bulkUpdate({ ids: body.ids, action: body.action, value: body.value }, { actor: 'user' });
      httpMod.sendJson(res, 200, { results });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  // 线索导入（JSON 行数组，自动去重合并）
  route('waimao-crm-import', 'exact', '/waimao/api/crm/import', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const result = crmMod.importLeads(body.rows ?? []);
      httpMod.sendJson(res, 200, result);
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  // 统计（仪表盘图表用）
  route('waimao-api-stats', 'exact', '/waimao/api/stats', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    httpMod.sendJson(res, 200, statsMod.report());
  });

  // 定价计算（网页计算器实时调用）
  route('waimao-calc-price', 'exact', '/waimao/api/calc/price', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      httpMod.sendJson(res, 200, calcPrice({
        mode: body.mode, exw: body.exw, inland: body.inland, port: body.port,
        ocean: body.ocean, insuranceRate: body.insurance_rate, dutyRate: body.duty_rate, dest: body.dest,
        destFreight: body.dest_freight, margin: body.margin, qty: body.qty,
      }));
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  // 审核台
  route('waimao-review-queue', 'exact', '/waimao/api/review/queue', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    httpMod.sendJson(res, 200, storeMod.pendingQueue({ status: url.searchParams.get('status') ?? 'pending', limit: Number(url.searchParams.get('limit') ?? 50) }));
  });

  route('waimao-review-draft', 'exact', '/waimao/api/review/draft', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const message = storeMod.getMessage(String(body.id ?? ''));
      if (!message) { httpMod.sendJson(res, 404, { error: `message not found: ${body.id}` }); return; }
      const history = storeMod.loadMessages().filter((item) => item.chatJid === message.chatJid).sort((a, b) => Date.parse(a.ts ?? 0) - Date.parse(b.ts ?? 0)).slice(-12);
      const text = await draftMod.draftReply({ history, buyerName: message.name || message.sender });
      storeMod.updateMessage(message.id, { draft: text, status: 'drafted' });
      httpMod.sendJson(res, 200, { id: message.id, draft: text });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-review-send', 'exact', '/waimao/api/review/send', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      const message = storeMod.getMessage(String(body.id ?? ''));
      if (!message) { httpMod.sendJson(res, 404, { error: `message not found: ${body.id}` }); return; }
      const text = String(body.text ?? '').trim();
      if (text === '') { httpMod.sendJson(res, 400, { error: 'text is empty' }); return; }
      if (message.chatJid.endsWith('@g.us')) { httpMod.sendJson(res, 400, { error: '群聊不支持自动发送' }); return; }
      await evolutionMod.sendText(message.chatJid, text);
      storeMod.updateMessage(message.id, { status: 'sent', draft: text, sentAt: new Date().toISOString() });
      auditMod.audit('wa.send', { to: message.chatJid, via: 'review-page' }, 'user');
      httpMod.sendJson(res, 200, { id: message.id, status: 'sent' });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-review-ignore', 'exact', '/waimao/api/review/ignore', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    try {
      const body = await httpMod.readBody(req);
      storeMod.updateMessage(String(body.id ?? ''), { status: 'ignored' });
      httpMod.sendJson(res, 200, { id: body.id, status: 'ignored' });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  // cron 状态/手动触发
  route('waimao-cron', 'exact', '/waimao/api/cron', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) { res.writeHead(403).end(); return; }
    if (req.method === 'POST') {
      try {
        const body = await httpMod.readBody(req);
        httpMod.sendJson(res, 200, await cronMod.runOnce(String(body.name ?? '')));
      } catch (error) {
        httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    httpMod.sendJson(res, 200, cronMod.status());
  });

  // 追踪端点（公开可达：经用户反代进来的邮件客户端请求）。
  // 不走回环围栏，但 ID 不可枚举 + 只重定向到发送时登记的 URL + 零数据响应。
  route('waimao-px', 'exact', '/waimao/px', (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id') ?? '';
    if (trackMod.isValidTrackId(id)) {
      trackMod.recordOpen(id, req.headers?.['user-agent']);
    }
    res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store', pragma: 'no-cache' });
    res.end(trackMod.PIXEL);
  });

  route('waimao-click', 'exact', '/waimao/click', (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cid = url.searchParams.get('c') ?? '';
    const target = trackMod.isValidClickId(cid) ? trackMod.recordClick(cid) : null;
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(302, { location: target });
    res.end();
  });

  // Evolution webhook（token 校验）
  route('waimao-webhook', 'exact', '/waimao/webhook/evolution', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!httpMod.isTrustedWebhook(req, url)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await httpMod.readBody(req);
      const entries = evolutionMod.normalizeWebhook(body).filter((item) => !item.fromMe);
      const { added } = storeMod.upsertIncoming(entries);
      httpMod.sendJson(res, 200, { received: entries.length, added });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* 定时任务接线                                                         */
/* ------------------------------------------------------------------ */

function startCron() {
  const config = readConfig();
  if (config.cron?.enabled === false) {
    return;
  }
  // 邮件序列到期执行（注入发送函数，尊重 dry_run）
  cronMod.registerJob('sequence', {
    everyMs: Math.max(5, config.cron?.sequenceCheckEveryMin ?? 60) * 60_000,
    description: '邮件跟进序列到期执行(Day0/3/7/14)',
    fn: cronMod.createSequenceJob({
      // 启动序列本身是用户的显式操作（等同 Instantly 的"激活"），标记为已批准
      sendEmail: async ({ lead, to, subject, body, inReplyTo, isFirstEmail }) => sendEmailGuarded({ to, toName: lead.company, subject, body, leadId: lead.id, actor: 'cron', inReplyTo, isFirstEmail, approvedVia: 'sequence-start' }),
    }),
  });
  const waMin = config.cron?.waSyncEveryMin ?? 30;
  if (waMin > 0) {
    cronMod.registerJob('waInbox', { everyMs: waMin * 60_000, description: 'WhatsApp 收件箱轮询', fn: cronMod.waInboxJob });
  }
  const replyMin = config.cron?.replyScanEveryMin ?? 30;
  if (replyMin > 0) {
    cronMod.registerJob('replyScan', { everyMs: replyMin * 60_000, description: 'IMAP 回复扫描+AI分类', fn: cronMod.replyScanJob });
  }
  const monitorH = config.cron?.monitorEveryHour ?? 6;
  if (monitorH > 0) {
    cronMod.registerJob('monitor', { everyMs: monitorH * 3_600_000, description: '客户官网变化监控(意图信号)', fn: cronMod.monitorJob });
  }
  if (config.warmup?.enabled === true) {
    cronMod.registerJob('warmup', { everyMs: 24 * 3_600_000, description: '邮箱预热(互动轮)', fn: cronMod.warmupJob });
  }
  // 每日日报：按 HH:mm 触发（每 30 分钟检查一次时间）
  cronMod.registerJob('dailyReport', {
    everyMs: 30 * 60_000,
    description: '每日管线日报',
    fn: async () => {
      // 每次运行时读配置（改时间不用重启）；解析失败/越界回退 09:00
      const raw = String(readConfig().cron?.dailyReportAt ?? '09:00').split(':');
      let hh = Number.parseInt(raw[0], 10);
      let mm = Number.parseInt(raw[1] ?? '0', 10);
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
        hh = 9;
        mm = 0;
      }
      hh = Math.min(23, Math.max(0, hh));
      mm = Math.min(59, Math.max(0, mm));
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const targetMin = hh * 60 + mm;
      if (nowMin < targetMin || nowMin >= targetMin + 30) {
        return `not due (${nowMin} min vs ${targetMin})`;
      }
      return cronMod.dailyReportJob();
    },
  });
  cronMod.registerJob('staleAlert', {
    everyMs: 6 * 3600_000,
    description: '停跟进提醒',
    fn: cronMod.createStaleJob({ staleDays: config.cron?.staleDays ?? 7 }),
  });
  cronMod.start({ intervalMs: 60_000 });
}
