// dsh-waimao — DeepSeek Harness 外贸获客插件。
//
// 一切走注册，不改内核：
//  - 6 个工具（ctx.tools.register）：lead_search / lead_export_csv /
//    wa_sync / wa_review_queue / wa_reply / wa_send_text
//  - 回环路由（ctx.inject(['webServer'])）：谷歌获客页、客服审核台页、
//    同源 JSON API、Evolution API webhook 接收器
//
// 零依赖：只用 node 内置模块 + global fetch（Node >= 22.13）。
// 兼容性基线：@deepseek-ai/dsh 0.1.0-rc.7（工具注册与 webServer 注册两个
// 面与 modsearch 0.1.x 同款用法）。
import * as configMod from './config.js';
import * as draftMod from './draft.js';
import * as evolutionMod from './evolution.js';
import * as httpMod from './http.js';
import * as leadsMod from './leads.js';
import { marketOptions } from './markets.js';
import * as pagesMod from './pages.js';
import * as storeMod from './store.js';

export const name = 'waimao';

export const inject = ['tools'];

export function apply(ctx) {
  registerLeadSearchTool(ctx);
  registerLeadExportTool(ctx);
  registerWaSyncTool(ctx);
  registerWaQueueTool(ctx);
  registerWaReplyTool(ctx);
  registerWaSendTextTool(ctx);

  // webServer 只在 web profile 存在；cordis 无可选注入，就用 scoped inject：
  // 服务存在处闭包执行，服务不存在处永不执行（headless 不受影响）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerRoutes(scope);
      } catch (error) {
        console.error(`[waimao] web routes skipped: ${error}`);
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function registerLeadSearchTool(ctx) {
  ctx.tools.register({
    name: 'lead_search',
    description:
      '谷歌三层获客搜索：按「第1层·基础搜索(产品词+WhatsApp/区号) → 第2层·LinkedIn职位定向(采购经理等) → 第3层·采购信号(we buy/looking for/need supplier)」逐层生成谷歌搜索公式并执行，逐层去重后返回带标题/链接/摘要/层级的买家线索。亚非拉市场走 WhatsApp 公式，欧美走邮件+LinkedIn。engine=ddg 免key可用；serpapi 需在 ~/.waimao/config.json 配 key；literal 只返回公式不联网。结果同时落盘，可用 lead_export_csv 导出。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: '产品关键词（英文，如 hair dryer）' },
        market: {
          type: 'string',
          description:
            '目标市场：预设 key（mx/ae/sa/br/id/in/us/uk/de/eu/global 等）或区号（+52）。默认 mx',
        },
        layers: {
          type: 'array',
          items: { type: 'number', enum: [1, 2, 3] },
          description: '执行哪些层，默认 [1,2,3]',
        },
        per_layer: { type: 'number', description: '每层最多收录条数，默认 10' },
        engine: {
          type: 'string',
          enum: ['ddg', 'serpapi', 'literal'],
          description: 'SERP 引擎，默认取配置（ddg）',
        },
      },
      required: ['product'],
    },
    timeoutMs: 150_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `lead_search: ${args?.product ?? ''}`,
      kind: 'search',
      rawInput: args,
    }),
    async execute(args, exec) {
      return leadsMod.runLeadSearch({
        product: args?.product,
        market: args?.market,
        layers: Array.isArray(args?.layers) ? args.layers : undefined,
        perLayer: args?.per_layer,
        engine: args?.engine,
        signal: exec?.signal,
      });
    },
  });
}

function registerLeadExportTool(ctx) {
  ctx.tools.register({
    name: 'lead_export_csv',
    description:
      '把一次 lead_search 的结果导出为 CSV（UTF-8 BOM，Excel 直接打开不乱码）。不传 run_id 导出最近一次。返回文件绝对路径。',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'lead_search 返回的 run id，缺省=最近一次' },
        file: { type: 'string', description: '可选：输出文件绝对路径' },
      },
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: 'lead_export_csv',
      kind: 'export',
      rawInput: args,
    }),
    async execute(args) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const run = args?.run_id
        ? leadsMod.findRun(args.run_id)
        : leadsMod.loadRuns(1)[0];
      if (!run) {
        throw new Error('没有可导出的搜索记录，先运行 lead_search');
      }
      const file = args?.file || leadsMod.exportPath(run.id);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, leadsMod.toLeadCsv(run), { mode: 0o600 });
      return { file, total: run.total, product: run.product, market: run.marketLabel };
    },
  });
}

function registerWaSyncTool(ctx) {
  ctx.tools.register({
    name: 'wa_sync',
    description:
      '从 Evolution API 拉取 WhatsApp 最近会话与消息，把买家（非自己发送）的文本消息并入本地待审队列。适合 webhook 不可达（dsh 只绑 127.0.0.1）时用轮询兜底。返回新增条数与队列概况。',
    parameters: {
      type: 'object',
      properties: {
        chats: { type: 'number', description: '拉取最近几个会话，默认 10' },
        per_chat: { type: 'number', description: '每个会话拉取多少条历史，默认 20' },
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
        const history = await evolutionMod
          .findMessages(jid, args?.per_chat ?? 20, exec?.signal)
          .catch(() => null);
        if (!history) {
          continue;
        }
        const entries = evolutionMod
          .normalizeHistory(history, jid)
          .filter((item) => !item.fromMe && item.chatJid && !item.chatJid.endsWith('@g.us'));
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
    description:
      '列出 WhatsApp 客服审核队列：status=pending 待审 / drafted 已有草稿 / sent 已发送 / ignored 已忽略 / all。默认 pending，最新在前。',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'drafted', 'sent', 'ignored', 'all'],
          description: '默认 pending',
        },
        limit: { type: 'number', description: '最多返回条数，默认 50' },
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'wa_review_queue', kind: 'list', rawInput: args }),
    async execute(args) {
      const items = storeMod.pendingQueue({
        status: args?.status ?? 'pending',
        limit: Math.min(Math.max(args?.limit ?? 50, 1), 200),
      });
      return { stats: storeMod.stats(), items };
    },
  });
}

function registerWaReplyTool(ctx) {
  ctx.tools.register({
    name: 'wa_reply',
    description:
      '审核并发送一条 WhatsApp 回复：按消息 id 发送 text 给该买家（经 Evolution API），并把该消息标记为 sent。这是人工审核后的发送动作；群聊(@g.us)拒绝自动发送。action=ignore 只标记忽略不发送。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'wa_review_queue 返回的消息 id' },
        text: { type: 'string', description: '要发送的回复正文' },
        action: { type: 'string', enum: ['send', 'ignore'], description: '默认 send' },
      },
      required: ['id'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `wa_reply: ${args?.id ?? ''}`, kind: 'send', rawInput: args }),
    async execute(args) {
      const message = storeMod.getMessage(args.id);
      if (!message) {
        throw new Error(`message not found: ${args.id}`);
      }
      if (args.action === 'ignore') {
        storeMod.updateMessage(args.id, { status: 'ignored' });
        return { id: args.id, status: 'ignored' };
      }
      const text = String(args?.text ?? '').trim();
      if (text === '') {
        throw new Error('wa_reply 需要非空 text');
      }
      if (message.chatJid.endsWith('@g.us')) {
        throw new Error('该会话是群聊(@g.us)，拒绝自动发送，请在手机上手动回复');
      }
      await evolutionMod.sendText(message.chatJid, text);
      storeMod.updateMessage(args.id, {
        status: 'sent',
        draft: text,
        sentAt: new Date().toISOString(),
      });
      return { id: args.id, status: 'sent', to: message.chatJid, text };
    },
  });
}

function registerWaSendTextTool(ctx) {
  ctx.tools.register({
    name: 'wa_send_text',
    description:
      '直接通过 Evolution API 给一个 WhatsApp 号码发文本（主动开发信/跟进，不经过审核队列）。number 用国际格式数字（可带+，如 5215512345678）。',
    parameters: {
      type: 'object',
      properties: {
        number: { type: 'string', description: '国际格式号码，如 5215512345678' },
        text: { type: 'string', description: '消息正文' },
      },
      required: ['number', 'text'],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `wa_send_text: ${args?.number ?? ''}`, kind: 'send', rawInput: args }),
    async execute(args) {
      const result = await evolutionMod.sendText(args?.number, args?.text);
      return { sent: true, to: String(args?.number), result };
    },
  });
}

/* ------------------------------------------------------------------ */
/* 回环路由（谷歌获客页 / 审核台页 / JSON API / webhook）                */
/* ------------------------------------------------------------------ */

function registerRoutes(scope) {
  const route = (name, kind, path, handler) =>
    scope.webServer.register({ name, kind, path, handler });

  route('waimao-root', 'exact', '/waimao', (req, res) => {
    res.writeHead(302, { location: '/waimao/leads' });
    res.end();
  });

  route('waimao-leads-page', 'exact', '/waimao/leads', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    httpMod.sendHtml(res, 200, pagesMod.leadsPage());
  });

  route('waimao-review-page', 'exact', '/waimao/review', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    httpMod.sendHtml(res, 200, pagesMod.reviewPage());
  });

  route('waimao-status', 'exact', '/waimao/api/status', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    httpMod.sendJson(res, 200, configMod.configSummary());
  });

  route('waimao-markets', 'exact', '/waimao/api/markets', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    httpMod.sendJson(res, 200, marketOptions());
  });

  route('waimao-leads-search', 'exact', '/waimao/api/leads/search', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await httpMod.readBody(req);
      const run = await leadsMod.runLeadSearch({
        product: body.product,
        market: body.market,
        layers: Array.isArray(body.layers) ? body.layers : undefined,
        perLayer: body.perLayer,
        engine: body.engine,
        signal: req.signal ?? undefined,
      });
      httpMod.sendJson(res, 200, run);
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-leads-export', 'exact', '/waimao/api/leads/export.csv', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const run = url.searchParams.has('run')
      ? leadsMod.findRun(String(url.searchParams.get('run')))
      : leadsMod.loadRuns(1)[0];
    if (!run) {
      httpMod.sendJson(res, 404, { error: 'run not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="leads-${run.id}.csv"`,
    });
    res.end(leadsMod.toLeadCsv(run));
  });

  route('waimao-review-queue', 'exact', '/waimao/api/review/queue', (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    httpMod.sendJson(
      res,
      200,
      storeMod.pendingQueue({
        status: url.searchParams.get('status') ?? 'pending',
        limit: Number(url.searchParams.get('limit') ?? 50),
      }),
    );
  });

  route('waimao-review-draft', 'exact', '/waimao/api/review/draft', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await httpMod.readBody(req);
      const message = storeMod.getMessage(String(body.id ?? ''));
      if (!message) {
        httpMod.sendJson(res, 404, { error: `message not found: ${body.id}` });
        return;
      }
      const history = storeMod
        .loadMessages()
        .filter((item) => item.chatJid === message.chatJid)
        .sort((a, b) => Date.parse(a.ts ?? 0) - Date.parse(b.ts ?? 0))
        .slice(-12);
      const text = await draftMod.draftReply({
        history,
        buyerName: message.name || message.sender,
      });
      storeMod.updateMessage(message.id, { draft: text, status: 'drafted' });
      httpMod.sendJson(res, 200, { id: message.id, draft: text });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-review-send', 'exact', '/waimao/api/review/send', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await httpMod.readBody(req);
      const message = storeMod.getMessage(String(body.id ?? ''));
      if (!message) {
        httpMod.sendJson(res, 404, { error: `message not found: ${body.id}` });
        return;
      }
      const text = String(body.text ?? '').trim();
      if (text === '') {
        httpMod.sendJson(res, 400, { error: 'text is empty' });
        return;
      }
      if (message.chatJid.endsWith('@g.us')) {
        httpMod.sendJson(res, 400, { error: '群聊不支持自动发送' });
        return;
      }
      await evolutionMod.sendText(message.chatJid, text);
      storeMod.updateMessage(message.id, {
        status: 'sent',
        draft: text,
        sentAt: new Date().toISOString(),
      });
      httpMod.sendJson(res, 200, { id: message.id, status: 'sent' });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-review-ignore', 'exact', '/waimao/api/review/ignore', async (req, res) => {
    if (!httpMod.isTrustedRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await httpMod.readBody(req);
      storeMod.updateMessage(String(body.id ?? ''), { status: 'ignored' });
      httpMod.sendJson(res, 200, { id: body.id, status: 'ignored' });
    } catch (error) {
      httpMod.sendJson(res, 400, { error: String(error?.message ?? error) });
    }
  });

  route('waimao-webhook', 'exact', '/waimao/webhook/evolution', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!httpMod.isTrustedWebhook(req, url)) {
      // 不回显细节，避免给探测者任何提示。
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
