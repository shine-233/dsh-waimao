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

// 38 tools + all routes
assert.deepEqual(
  [...tools.keys()].sort(),
  [
    'audit_query', 'cron_status', 'crm_activity', 'crm_export', 'crm_list', 'crm_update',
    'company_dossier',
    'email_compose', 'email_find', 'email_scan_replies', 'email_send', 'email_sequence_start', 'email_sequence_status', 'email_suppress', 'email_verify',
    'kb_list', 'kb_search', 'kb_upsert',
    'lead_enrich', 'lead_export_csv', 'lead_score', 'lead_search',
    'monitor_check', 'monitor_watch',
    'quote_pdf',
    'sop_approve', 'sop_create', 'sop_next', 'sop_review', 'sop_status',
    'stats_report',
    'wa_broadcast', 'wa_reply', 'wa_review_queue', 'wa_send_media', 'wa_send_text', 'wa_sync',
  ].sort(),
);
for (const path of [
  '/waimao',
  '/waimao/leads',
  '/waimao/crm',
  '/waimao/review',
  '/waimao/settings',
  '/waimao/api/status',
  '/waimao/api/markets',
  '/waimao/api/config',
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
  '/waimao/api/review/queue',
  '/waimao/api/review/draft',
  '/waimao/api/review/send',
  '/waimao/api/review/ignore',
  '/waimao/api/cron',
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
for (const page of [routes.get('/waimao/crm'), routes.get('/waimao/settings')]) {
  const res = fakeRes();
  await page.handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
}
assert.ok(String((await new Promise((resolve) => {
  const r = fakeRes();
  routes.get('/waimao/crm').handler(fakeReq('GET'), r);
  resolve(r.body);
}))).includes('CRM'));

// real search: literal first (no network), then ddg (network)
const literal = await lead.execute(
  { product: 'hair dryer', market: '+52', layers: [1], per_layer: 5, engine: 'literal' },
  { signal: undefined },
);
assert.equal(literal.layers[0].found, 0);
assert.ok(literal.layers[0].query.includes('WhatsApp +52'));

console.log('running one real DDG query (network required)...');
try {
  const run = await lead.execute(
    { product: 'hair dryer', market: 'mx', layers: [1, 3], per_layer: 5, engine: 'ddg' },
    { signal: AbortSignal.timeout(60_000) },
  );
  console.log(
    `ddg run: total=${run.total} layers=${run.layers
      .map((l) => `L${l.id}:${l.found}found/${l.added}kept${l.error ? ` err=${l.error}` : ''}`)
      .join(' ')}`,
  );
  for (const item of run.results.slice(0, 3)) {
    console.log(`  [L${item.layer}] ${item.title} -> ${item.url}`);
  }
} catch (error) {
  console.log(`ddg network note (not a code failure): ${error?.message ?? error}`);
}

// review flow through the route handlers (fake req/res)
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

const queueRoute = routes.get('/waimao/api/review/queue');
const res1 = fakeRes();
await queueRoute.handler(fakeReq('GET'), res1);
assert.equal(res1.statusCode, 200);
console.log('review queue route ok');

const webhook = routes.get('/waimao/webhook/evolution');
const res2 = fakeRes();
await webhook.handler(fakeReq('POST', { event: 'messages.upsert', data: {} }), res2);
// token not configured -> 403
assert.equal(res2.statusCode, 403);
console.log('webhook fence ok (403 without token)');

const leadsPageRoute = routes.get('/waimao/leads');
const res3 = fakeRes();
await leadsPageRoute.handler(fakeReq('GET', undefined, { host: 'evil.example', origin: 'https://evil.example' }), res3);
assert.equal(res3.statusCode, 403);
const res4 = fakeRes();
await leadsPageRoute.handler(fakeReq('GET'), res4);
assert.equal(res4.statusCode, 200);
assert.ok(String(res4.body).includes('谷歌获客'));
console.log('page fence + render ok');

console.log('ALL HOST-SIMULATION TESTS PASSED');
