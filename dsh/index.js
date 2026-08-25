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
import { toCsv, crmRow, CRM_CSV_HEADERS } from './csv.js';
import * as cronMod from './cron.js';
import * as draftMod from './draft.js';
import * as enrichMod from './enrich.js';
import { findEmail, verifyEmail, guessEmails } from './enrich/emailfind.js';
import * as evolutionMod from './evolution.js';
import * as httpMod from './http.js';
import * as kbMod from './kb.js';
import * as leadsMod from './leads.js';
import * as composeMod from './mail/compose.js';
import { newSequence, dueSteps, sequenceSummary, stopSequence } from './mail/sequence.js';
import { sendMail } from './mail/smtp.js';
import { marketOptions } from './markets.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as pagesMod from './pages.js';
import { quotePdf, quoteFileName } from './pdf.js';
import { readConfig, EXPORT_DIR } from './config.js';
import { scoreLead } from './score.js';
import * as sopMod from './sop.js';
import * as storeMod from './store.js';

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
  registerSequenceStartTool(ctx);
  registerSequenceStatusTool(ctx);
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

/** 发送邮件的唯一入口：尊重 smtp.dry_run 总闸 + 审计。 */
async function sendEmailGuarded({ to, toName, subject, body, attachments, leadId, actor = 'agent' }) {
  const smtp = smtpOf();
  if (!smtp.host || !smtp.from) {
    throw new Error('SMTP 未配置（settings 页或 ~/.waimao/config.json 的 smtp 段）');
  }
  if (smtp.dryRun !== false) {
    const previewFile = join(EXPORT_DIR, `draft-${Date.now().toString(36)}.txt`);
    mkdirSync(EXPORT_DIR, { recursive: true });
    writeFileSync(previewFile, `To: ${to}\nSubject: ${subject}\n\n${body}`, { mode: 0o600 });
    auditMod.audit('email.dry_run', { to, subject, leadId, preview: previewFile }, actor);
    return { dryRun: true, previewFile, message: 'smtp.dry_run=true：未真实发送，草稿已存盘' };
  }
  const result = await sendMail(smtp, { from: smtp.from, fromName: smtp.fromName, to, toName, subject, body, replyTo: smtp.replyTo, attachments });
  auditMod.audit('email.send', { to, subject, leadId, messageId: result.messageId }, actor);
  return { dryRun: false, ...result };
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
    description: '导出一次 lead_search 结果为 CSV（UTF-8 BOM）。不传 run_id 导出最近一次。CRM 导出请用 crm_export。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
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
      writeFileSync(file, leadsMod.toLeadCsv(run), { mode: 0o600 });
      return { file, total: run.total, product: run.product };
    },
  });
}

function registerLeadEnrichTool(ctx) {
  ctx.tools.register({
    name: 'lead_enrich',
    description:
      '线索加工管线：对 lead_search 的结果抓取网页 → 提取联系方式(邮箱/WhatsApp/电话/社媒) → 规则引擎过滤(排除同行/B2B平台/黄页/招聘) → AI评分分级(0-12分,🔴🟠🟡🟢) → 自动存入CRM(去重合并)。这是把"链接"变成"客户"的核心工具。',
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
        lead_ids: { type: 'array', items: { type: 'string' }, description: '线索ID列表，缺省=全部 new/qualified 状态' },
        use_ai: { type: 'boolean', description: '默认true' },
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: 'lead_score', kind: 'score', rawInput: args }),
    async execute(args) {
      const ids = Array.isArray(args?.lead_ids) && args.lead_ids.length > 0
        ? args.lead_ids
        : crmMod.listLeads({ status: 'new', limit: 50 }).map((lead) => lead.id);
      const results = [];
      for (const id of ids) {
        const lead = crmMod.getLead(id);
        if (!lead) {
          results.push({ id, error: 'not found' });
          continue;
        }
        const scored = await scoreLead({
          product: '',
          market: lead.market,
          item: {
            title: lead.title,
            snippet: lead.snippet,
            signalsText: `${lead.advice} ${(lead.contacts.emails ?? []).join(' ')} ${lead.company}`,
          },
          useAI: args?.use_ai,
        });
        crmMod.updateLead(id, { score: scored.score, tier: scored.tier, advice: scored.advice }, { activityNote: `重评分: ${scored.score}(${scored.tier})` });
        results.push({ id, score: scored.score, tier: scored.tier, advice: scored.advice });
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
      '撰写开发信草稿（不发送）：优先 DeepSeek 个性化生成（带知识库上下文），回退双语模板。拉美市场自动西语。SOP 任务进行中时传 task_id 会把草稿挂到任务上等待审批。',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'CRM 线索ID' },
        language: { type: 'string', enum: ['en', 'es'], description: '缺省按市场自动选' },
        use_ai: { type: 'boolean', description: '默认true' },
        kind: { type: 'string', enum: ['first', 'followup'], description: '首封/跟进，默认first' },
        step: { type: 'number', description: '跟进序号1-3（kind=followup时）' },
        task_id: { type: 'string', description: 'SOP任务ID（可选，挂草稿到任务）' },
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
      const draft = await composeMod.composeEmail({
        kind: args?.kind ?? 'first',
        step: args?.step,
        name: lead.contacts?.contactName ?? '',
        company: lead.company || lead.domain,
        product: '',
        market: lead.market,
        language: args?.language,
        useAI: args?.use_ai,
        me: readConfig().smtp?.fromName ?? 'Sales',
        features: 'factory direct, stable quality, fast lead time',
        knowledge: kbContext || undefined,
      });
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
      '发送开发信。受 smtp.dry_run 总闸约束（默认 true 只存预览不发送）。SOP 任务中发送需草稿已批准（哈希校验）。发送后自动记 CRM 活动，replied 前状态改为 contacted。',
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
      if (args?.task_id && args?.draft_id) {
        sopMod.assertApproved(args.task_id, args.draft_id);
      }
      const to = lead.contacts.emails?.[0];
      if (!to) {
        throw new Error(`线索 ${lead.id} 没有邮箱（先 email_find 或 lead_enrich）`);
      }
      const result = await sendEmailGuarded({
        to,
        toName: lead.company,
        subject: String(args?.subject ?? ''),
        body: String(args?.body ?? ''),
        leadId: lead.id,
      });
      if (!result.dryRun) {
        crmMod.updateLead(lead.id, {
          status: ['new', 'qualified'].includes(lead.status) ? 'contacted' : lead.status,
        }, { activityNote: `开发信已发送: ${args?.subject}` });
      } else {
        crmMod.addActivity(lead.id, { type: 'email-draft', note: `[dry-run] 预览: ${args?.subject}` });
      }
      return { ...result, to };
    },
  });
}

function registerSequenceStartTool(ctx) {
  ctx.tools.register({
    name: 'email_sequence_start',
    description:
      '给线索启动 Day 0/3/7/14 四步跟进序列（首封+轻提醒+附目录+最后跟进）。回复即停（状态改 replied 时自动停）。由 cron 定时执行，受 smtp.dry_run 约束。',
    parameters: {
      type: 'object',
      properties: { lead_id: { type: 'string' }, language: { type: 'string', enum: ['en', 'es'] } },
      required: ['lead_id'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `email_sequence_start: ${args?.lead_id ?? ''}`, kind: 'schedule', rawInput: args }),
    async execute(args) {
      const lead = crmMod.getLead(String(args?.lead_id ?? ''));
      if (!lead) {
        throw new Error(`lead not found: ${args?.lead_id}`);
      }
      if (!lead.contacts.emails?.length) {
        throw new Error('该线索没有邮箱，无法启动邮件序列');
      }
      const language = args?.language ?? (String(lead.market).match(/^(mx|br|ar|cl|co|pe)$/) ? 'es' : 'en');
      const sequence = newSequence({ language });
      // 预生成首封
      const first = await composeMod.composeEmail({ kind: 'first', company: lead.company || lead.domain, market: lead.market, language, useAI: true, me: readConfig().smtp?.fromName ?? 'Sales' });
      sequence.steps[0].subject = first.subject;
      sequence.steps[0].body = first.body;
      crmMod.updateLead(lead.id, { sequence }, { activityNote: '启动4步跟进序列(Day0/3/7/14)' });
      return { leadId: lead.id, language, plan: sequence.steps.map((step) => ({ day: step.day, label: step.label })), firstSubject: first.subject };
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
    description: '导出 CRM 线索为 CSV（可按状态过滤），返回文件路径。',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string' }, file: { type: 'string' } },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'crm_export', kind: 'export', rawInput: args }),
    async execute(args) {
      const leads = crmMod.listLeads({ status: args?.status, limit: 2000 });
      const file = args?.file || join(EXPORT_DIR, `crm-${new Date().toISOString().slice(0, 10)}.csv`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, toCsv(CRM_CSV_HEADERS, leads.map(crmRow)), { mode: 0o600 });
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
      const buffer = quotePdf({
        quoteNo,
        from: { company: readConfig().smtp?.fromName ?? 'Our Company', email: readConfig().smtp?.from ?? '' },
        to: { company: lead?.company ?? args?.to_company ?? 'Valued Customer', contact: '', country: lead?.market ?? '' },
        items: args?.items ?? [],
        currency: args?.currency ?? 'USD',
        leadTime: args?.lead_time,
        payment: args?.payment ?? (kbPolicy ? undefined : 'T/T 30% deposit'),
        validity: args?.validity,
        notes: args?.notes,
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
        action: { type: 'string', description: '如 email.send / wa.send / crm.status / sop.stage' },
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
      } else {
        httpMod.sendJson(res, 404, { error: `unknown test: ${name}` });
      }
    } catch (error) {
      httpMod.sendJson(res, 200, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  };
  for (const engine of ['serp', 'smtp', 'evolution', 'deepseek']) {
    route(`waimao-test-${engine}`, 'exact', `/waimao/api/test/${engine}`, testHandler);
  }

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
        reason: item.reason, score: item.score, tier: item.tier, advice: item.advice,
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
      const language = String(lead.market).match(/^(mx|br|ar|cl|co|pe)$/) ? 'es' : 'en';
      const sequence = newSequence({ language });
      const first = await composeMod.composeEmail({ kind: 'first', company: lead.company || lead.domain, market: lead.market, language, me: readConfig().smtp?.fromName ?? 'Sales' });
      sequence.steps[0].subject = first.subject;
      sequence.steps[0].body = first.body;
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
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="crm-export.csv"` });
    res.end(toCsv(CRM_CSV_HEADERS, leads.map(crmRow)));
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
      sendEmail: async ({ lead, to, subject, body }) => sendEmailGuarded({ to, toName: lead.company, subject, body, leadId: lead.id, actor: 'cron' }),
    }),
  });
  const waMin = config.cron?.waSyncEveryMin ?? 30;
  if (waMin > 0) {
    cronMod.registerJob('waInbox', { everyMs: waMin * 60_000, description: 'WhatsApp 收件箱轮询', fn: cronMod.waInboxJob });
  }
  // 每日日报：按 HH:mm 触发（每 30 分钟检查一次时间）
  cronMod.registerJob('dailyReport', {
    everyMs: 30 * 60_000,
    description: '每日管线日报',
    fn: async () => {
      const target = String(config.cron?.dailyReportAt ?? '09:00');
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (hhmm < target || hhmm >= `${target.slice(0, 3)}30`) {
        return `not due (${hhmm} vs ${target})`;
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
