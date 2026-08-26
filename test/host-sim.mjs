// 宿主模拟：像 dsh 一样加载插件入口，收集工具与路由注册，再走一遍
// lead_search（真实 DDG 请求）与审核 API 流程。
import assert from 'node:assert';

const plugin = await import('../dsh/index.js');
assert.equal(plugin.name, 'waimao');
assert.deepEqual(plugin.inject, ['tools']);
assert.equal(typeof plugin.apply, 'function');

const tools = new Map();
const routes = new Map();
const ctx = {
  tools: { register: (def) => tools.set(def.name, def) },
  inject: (names, fn) => {
    assert.deepEqual(names, ['webServer']);
    fn({
      webServer: {
        register: (route) => routes.set(route.path, route),
      },
    });
  },
};
plugin.apply(ctx);

// 50 tools + all routes
assert.deepEqual(
  [...tools.keys()].sort(),
  [
    'audit_query', 'company_dossier', 'cron_status', 'crm_activity', 'crm_export', 'crm_list', 'crm_update',
    'data_backup',
    'deliverability_check',
    'email_compose', 'email_find', 'email_scan_replies', 'email_send', 'email_sequence_start', 'email_sequence_status', 'email_suppress', 'email_verify',
    'icp_set',
    'instantly_campaign_list', 'instantly_push_leads',
    'kb_list', 'kb_search', 'kb_upsert',
    'lead_enrich', 'lead_export_csv', 'lead_score', 'lead_search',
    'market_scan',
    'monitor_check', 'monitor_watch',
    'price_calc',
    'proforma_pdf',
    'quote_pdf',
    'sop_approve', 'sop_create', 'sop_next', 'sop_review', 'sop_status',
    'stats_report',
    'template_delete', 'template_list', 'template_save',
    'video_script',
    'wa_broadcast', 'wa_reply', 'wa_review_queue', 'wa_send_media', 'wa_send_text', 'wa_sync',
    'warmup_status',
  ].sort(),
);
// icp_set 落库
const icpSet = tools.get('icp_set');
assert.ok(icpSet.parameters.required.includes('product'));
for (const path of [
  '/waimao',
  '/waimao/leads',
  '/waimao/crm',
  '/waimao/review',
  '/waimao/templates',
  '/waimao/settings',
  '/waimao/api/status',
  '/waimao/api/markets',
  '/waimao/api/config',
  '/waimao/api/templates',
  '/waimao/api/templates/delete',
  '/waimao/api/quote-defaults',
  '/waimao/api/test/serp',
  '/waimao/api/test/imap',
  '/waimao/api/leads/search',
  '/waimao/api/leads/enrich',
  '/waimao/api/leads/export.csv',
  '/waimao/api/crm/list',
  '/waimao/api/crm/update',
  '/waimao/api/crm/activity',
  '/waimao/api/crm/compose',
  '/waimao/api/crm/send-email',
  '/waimao/api/crm/sequence-start',
  '/waimao/api/crm/export.csv',
  '/waimao/api/crm/vcard',
  '/waimao/api/crm/bulk',
  '/waimao/api/crm/import',
  '/waimao/api/stats',
  '/waimao/api/calc/price',
  '/waimao/api/review/queue',
  '/waimao/api/review/draft',
  '/waimao/api/review/send',
  '/waimao/api/review/ignore',
  '/waimao/api/cron',
  '/waimao/px',
  '/waimao/click',
  '/waimao/webhook/evolution',
]) {
  assert.ok(routes.has(path), `missing route ${path}`);
}

// lead_search tool schema sanity
const lead = tools.get('lead_search');
assert.equal(lead.parameters.required[0], 'product');
// v0.2: new pages render + SOP tools present
const sopNext = tools.get('sop_next');
assert.ok(sopNext.description.includes('fail-closed'));
const broadcast = tools.get('wa_broadcast');
assert.ok(broadcast.description.includes('熔断'));

// page render + fence
function fakeReq(method, body, headers = { host: '127.0.0.1:3080' }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  let i = 0;
  return {
    method,
    headers,
    url: '/x',
    on(event, cb) {
      if (event === 'data' && i < chunks.length) {
        cb(chunks[i++]);
      }
      if (event === 'end') {
        cb();
      }
    },
  };
}
function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      return this;
    },
    end(payload) {
      this.body = payload ?? '';
    },
    destroy() {},
  };
}

for (const path of ['/waimao/crm', '/waimao/settings']) {
  const res = fakeRes();
  await routes.get(path).handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
}
const crmRes = fakeRes();
await routes.get('/waimao/crm').handler(fakeReq('GET'), crmRes);
assert.ok(String(crmRes.body).includes('CRM'));

// v0.4 追踪端点：公开（不要求回环围栏），但严格校验 ID
const pxRoute = routes.get('/waimao/px');
const pxRes = fakeRes();
await pxRoute.handler(fakeReq('GET', undefined, { host: 'track.example.com' }), pxRes);
assert.equal(pxRes.statusCode, 200); // 无效 id 也不报错，只是不记录，返回像素
assert.ok(pxRes.body.length > 10);

const clickRoute = routes.get('/waimao/click');
const badClick = fakeRes();
await clickRoute.handler(fakeReq('GET', undefined, { host: 'track.example.com' }), badClick);
// 未知 clickId → 404（不重定向）
assert.equal(badClick.statusCode, 404);

// crm/list 必须返回 fit / lastReply 字段（详情抽屉的对口徽章和最近回复靠它们渲染）
const crmMod = await import('../dsh/crm.js');
const { writeFileSync, readFileSync } = await import('node:fs');
const uniqCompany = `hostsim-${Date.now()}`;
const { lead: simLead } = crmMod.upsertLead({
  company: uniqCompany, url: `https://${uniqCompany}.example`, market: 'us',
  contacts: { emails: [], whatsapps: [], phones: [], socials: {} },
  score: 9, tier: '高', fit: 'partial',
});
crmMod.updateLead(simLead.id, { lastReply: { messageId: '<x@y>', category: 'interested', summary: '要看目录', ts: new Date().toISOString() } });
try {
  const listRoute = routes.get('/waimao/api/crm/list');
  const listRes = fakeRes();
  await listRoute.handler(fakeReq('GET', undefined, { host: '127.0.0.1:3080' }), listRes);
  const rows = JSON.parse(listRes.body);
  const row = rows.find((item) => item.id === simLead.id);
  assert.ok(row, '列表应包含测试线索');
  assert.equal(row.fit, 'partial', 'crm/list 必须返回 fit');
  assert.equal(row.lastReply.category, 'interested', 'crm/list 必须返回 lastReply');
} finally {
  // 清理测试线索
  const storePath = crmMod.storeFile();
  const db = JSON.parse(readFileSync(storePath, 'utf8'));
  db.leads = db.leads.filter((item) => item.id !== simLead.id);
  writeFileSync(storePath, JSON.stringify(db));
}

// review queue route
const queueRoute = routes.get('/waimao/api/review/queue');
const res1 = fakeRes();
await queueRoute.handler(fakeReq('GET'), res1);
assert.equal(res1.statusCode, 200);

// webhook fence
const webhook = routes.get('/waimao/webhook/evolution');
const res2 = fakeRes();
await webhook.handler(fakeReq('POST', { event: 'messages.upsert', data: {} }), res2);
assert.equal(res2.statusCode, 403);

// leads page fence
const leadsPageRoute = routes.get('/waimao/leads');
const res3 = fakeRes();
await leadsPageRoute.handler(fakeReq('GET', undefined, { host: 'evil.example', origin: 'https://evil.example' }), res3);
assert.equal(res3.statusCode, 403);
const res4 = fakeRes();
await leadsPageRoute.handler(fakeReq('GET'), res4);
assert.equal(res4.statusCode, 200);
assert.ok(String(res4.body).includes('谷歌获客'));

console.log('ALL HOST-SIMULATION TESTS PASSED');
