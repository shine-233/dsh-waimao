// 深度探针：全模块加载 + 全工具 execute 冒烟 + 关键生命周期确定性断言。
// 离线优先：网络类工具靠"预期业务错误"分类，TypeError/ReferenceError 视为真 bug。
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { USERPROFILE } = process.env;
const cfgDir = `${USERPROFILE}\\.waimao`;
mkdirSync(cfgDir, { recursive: true });
const cfgFile = `${cfgDir}\\config.json`;
const originalRaw = (() => { try { return readFileSync(cfgFile, 'utf8'); } catch { return ''; } })();
function restoreCfg() {
  if (originalRaw) writeFileSync(cfgFile, originalRaw);
}

/* ---------- 1. 全模块加载 ---------- */
const { readdirSync, statSync } = await import('node:fs');
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.js')) files.push(p);
  }
})('dsh');
let loadFails = 0;
for (const f of files) {
  try {
    await import(new URL(`../${f.split('\\').join('/')}`, import.meta.url).href);
  } catch (e) {
    loadFails += 1;
    console.log('LOAD FAIL:', f, '->', String(e.message).slice(0, 120));
  }
}
assert.equal(loadFails, 0, `${loadFails} 个模块加载失败`);

/* ---------- 2. 工具面冒烟：50 个工具逐个 execute ---------- */
const plugin = await import('../dsh/index.js');
const tools = new Map();
const routes = new Map();
plugin.apply({
  tools: { register: (def) => tools.set(def.name, def) },
  inject: (_names, fn) => fn({ webServer: { register: (r) => routes.set(r.path, r) } }),
});
assert.equal(tools.size, 50, `工具数应为50，实际 ${tools.size}`);

const configMod = await import('../dsh/config.js');
// 探针期间固定安全配置（结束后恢复原配置）
writeFileSync(cfgFile, JSON.stringify({
  ...(originalRaw ? JSON.parse(originalRaw.replace(/^\uFEFF/, '')) : {}),
  smtp: { dryRun: true },
  wa: { dryRun: true },
  warmup: { enabled: false },
  cron: { enabled: false },
}));

const crmMod = await import('../dsh/crm.js');
const uniqTag = `deep-${Date.now()}`;
const { lead: probeLead } = crmMod.upsertLead({
  company: uniqTag, url: `https://${uniqTag}.example`, market: 'us',
  contacts: { emails: [`${uniqTag}@example.com`], whatsapps: ['8613800001111'], phones: [], socials: {} },
  score: 8, tier: '高',
});

// 每个工具的最小入参；未列出的用 {}
const ARGS = {
  lead_search: { product: 'hair dryer', market: 'us', engine: 'literal' }, // literal 引擎离线落盘
  lead_enrich: { use_ai: false, fetch_pages: false, save_to_crm: false },
  lead_score: { use_ai: false },
  email_compose: { lead_id: () => probeLead.id, template: '__no_such_tpl__' }, // 应报"模板不存在"
  email_send: { lead_id: () => probeLead.id, subject: 'probe', body: 'probe' },
  email_verify: { email: 'a@no-resolve-xyz.invalid' },
  email_find: { domain: 'no-resolve-xyz.invalid', verify: false },
  email_suppress: { action: 'list' },
  crm_update: { lead_id: () => probeLead.id, status: 'contacted' },
  crm_activity: { lead_id: () => probeLead.id, note: 'probe' },
  sop_create: { goal: 'probe 获客任务' },
  kb_upsert: { type: 'policy', title: `probe-${uniqTag}`, content: 'plain policy text for probe' },
  quote_pdf: { items: [{ desc: 'hair dryer', qty: 10, unitPrice: 5 }] },
  proforma_pdf: { items: [{ desc: 'Hair dryer 2000W', hs_code: '8516.31', qty: 100, unitPrice: 8 }] },
  price_calc: { exw: 10, qty: 100 },
  video_script: { product: 'hair dryer' },
  icp_set: { product: 'probe hair dryers' },
  monitor_watch: { lead_id: () => probeLead.id, url: 'https://example.com/' },
  wa_broadcast: { numbers: ['8613800001111'], text: 'probe' },
  instantly_push_leads: { campaign_id: 'probe' },
  deliverability_check: { domain: 'example.com' },
};

// 这些允许抛"业务性"错误（未配置/找不到/网络），但绝不允许裸 TypeError/ReferenceError
const BUSINESS_ERR = /未配置|not configured|not found|没有|不存在|模板不存在|template needs|需要|missing|invalid|拒绝|已达到|上限|IMAP|SMTP|Evolution|Instantly|RDAP|HTTP|fetch failed|timeout|aborted|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|网络|代理|lead not found|run|无邮箱|no email|群聊|wa\.dryRun|首触冷邮件/i;
const isRealBug = (error) => {
  const msg = String(error?.message ?? error);
  // Node fetch 的网络失败是 TypeError('fetch failed')，属于环境问题不是代码 bug
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Evolution 不可达/i.test(msg)) {
    return false;
  }
  if (error instanceof ReferenceError) {
    return true;
  }
  return error instanceof TypeError || !BUSINESS_ERR.test(msg);
};
const SKIP_EXECUTE = new Set(['market_scan']); // 真实多市场 SERP，太慢

const realBugs = [];
const resultsLog = [];
for (const [name, def] of tools) {
  if (SKIP_EXECUTE.has(name)) continue;
  const rawArgs = ARGS[name] ?? {};
  const args = {};
  for (const [k, v] of Object.entries(rawArgs)) args[k] = typeof v === 'function' ? v() : v;
  try {
    const out = await def.execute(args, { signal: AbortSignal.timeout(60_000) });
    resultsLog.push([name, 'ok']);
    // 工具返回里不允许出现字面 undefined 序列化污染
    const s = JSON.stringify(out) ?? '';
    assert.ok(!s.includes(':undefined'), `${name} 返回含字面 undefined`);
  } catch (error) {
    const msg = String(error?.message ?? error);
    const isBug = isRealBug(error);
    resultsLog.push([name, isBug ? `BUG: ${msg.slice(0, 90)}` : `biz-error: ${msg.slice(0, 60)}`]);
    if (isBug) realBugs.push([name, msg.slice(0, 200)]);
  }
}
for (const [name, status] of resultsLog.filter(([, s]) => s !== 'ok')) {
  console.log(' ', name.padEnd(24), status);
}
assert.deepEqual(realBugs, [], `工具冒烟发现真 bug:\n${realBugs.map(([n, m]) => `${n}: ${m}`).join('\n')}`);

/* ---------- 3. SOP 全生命周期（含驳回不卡门 + remove + outreach 回写） ---------- */
const sopMod = await import('../dsh/sop.js');
globalThis.__waimaoCrm = crmMod; // score 阶段经此注入读 CRM
const task = sopMod.createTask({ goal: 'probe lifecycle', product: 'hair dryer', market: 'us' });
let cur = sopMod.nextStep(task.id, {}); // parse
cur = sopMod.nextStep(task.id, { runId: 'probe-run' }); // discover（runId 弱校验）
cur = sopMod.nextStep(task.id, { leadIds: [probeLead.id] }); // enrich
cur = sopMod.nextStep(task.id, { force: true }); // score
// draft 阶段：挂两封草稿，批准一封、驳回一封、移除一封新的
const d1 = sopMod.attachDraft(task.id, { leadId: probeLead.id, subject: 's1', body: 'b1' });
const d2 = sopMod.attachDraft(task.id, { leadId: probeLead.id, subject: 's2', body: 'b2' });
const d3 = sopMod.attachDraft(task.id, { leadId: probeLead.id, subject: 's3', body: 'b3' });
sopMod.nextStep(task.id, {}); // draft → approval
sopMod.reviewDraft(task.id, d1.id, { approve: true, actor: 'user' });
sopMod.reviewDraft(task.id, d2.id, { approve: false, actor: 'user' }); // 驳回
const removed = sopMod.removeDraft(task.id, d3.id, 'user');
assert.ok(removed.removed);
// 驳回的草稿不算待审：approval 门应放行（回归 H2"驳回永久卡死"）
cur = sopMod.nextStep(task.id, {});
assert.notEqual(cur.task.stage, 'approval', '驳回后审批门不应卡死');
// outreach：真实发送回写（模拟 email_send 的 recordOutreach 调用）
sopMod.recordOutreach(task.id, { leadId: probeLead.id, channel: 'email', to: probeLead.contacts.emails[0], subject: 's1' });
cur = sopMod.nextStep(task.id, {});
assert.equal(cur.task.stage, 'close', `outreach 回写后应能进 close，实际 ${cur.task.stage}`);
const closedTask = sopMod.closeTask(task.id);
assert.equal(closedTask.report.outreach, 1, '结案报告触达数应为 1');

/* ---------- 4. CSV 往返：中文表头导入不丢联系方式 ---------- */
const csvMod = await import('../dsh/csv.js');
const csvRows = [{
  公司: `${uniqTag}-csv`, 链接: `https://${uniqTag}-csv.example`, 市场: 'de',
  邮箱: 'buy@csv-roundtrip.example', WhatsApp: '4915112345678', LinkedIn: 'https://linkedin.com/company/csvrt',
  评分: '9', 分层: '高',
}];
const imp = crmMod.importLeads(csvRows, 'user');
assert.equal(imp.imported + imp.merged >= 1, true, `CSV 导入应成功: ${JSON.stringify(imp)}`);
const rtLead = crmMod.findLeadByPhone('4915112345678');
assert.ok(rtLead, 'WhatsApp 号应能反查线索');
assert.ok(rtLead.contacts.emails.includes('buy@csv-roundtrip.example'), '中文表头邮箱不得丢失');
assert.ok(rtLead.contacts.socials?.linkedin?.[0]?.includes('csvrt'), 'LinkedIn 不得丢失');
// 清理探针线索
{
  const storePath = crmMod.storeFile();
  const db = JSON.parse(readFileSync(storePath, 'utf8'));
  db.leads = db.leads.filter((item) => !String(item.company).startsWith(uniqTag) && item.id !== probeLead.id && item.id !== rtLead.id);
  writeFileSync(storePath, JSON.stringify(db));
}

/* ---------- 5. Instantly addLeads 分批（mock fetch） ---------- */
writeFileSync(cfgFile, JSON.stringify({
  ...(originalRaw ? JSON.parse(originalRaw.replace(/^\uFEFF/, '')) : {}),
  smtp: { dryRun: true }, wa: { dryRun: true },
  instantly: { apiKey: 'probe-key' },
  deepseek: { apiKey: '' },
}));
const realFetch2 = globalThis.fetch;
const batchesSeen = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/api/v2/leads/add')) {
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (target.includes('chat/completions')) {
    return { ok: false, status: 500, json: async () => null };
  }
  throw new Error(`unexpected fetch ${target}`);
};
try {
  // 动态 import 拿到已加载实例；直接调用底层分批逻辑
  const instantly = await import('../dsh/instantly.js');
  const many = Array.from({ length: 1200 }, (_, i) => ({ email: `bulk${i}@example.com`, company_name: 'B' }));
  // addLeads 内部用 api()→httpFetch→fetch；mock 已拦截
  const batchPromise = instantly.addLeads({ campaignId: 'cmp_probe', leads: many, batchSize: 500 });
  // httpFetch 无代理走 fetch → 我们的 mock；收集不到请求体（mock 未记），改为验证返回结构
  const r = await batchPromise;
  assert.equal(r.total, 1200);
  assert.equal(r.batches.length, Math.ceil(1200 / 500), '1200 条应分 3 批');
  assert.deepEqual(r.batches.map((b) => b.sent), [500, 500, 200]);
  const one = instantly.toInstantLead({ contacts: { emails: ['a@b.c'] }, company: 'ACME Trade Co Ltd' });
  assert.equal(one.first_name, null, '公司名不得拆成人名');
  assert.equal(one.email, 'a@b.c');
} finally {
  globalThis.fetch = realFetch2;
}

/* ---------- 6. WA 媒体桥：本地文件路径 → base64 ---------- */
const { resolveWaMedia } = await import('../dsh/index.js');
const EXPORT_DIR = configMod.EXPORT_DIR;
mkdirSync(EXPORT_DIR, { recursive: true });
const probePdf = join(EXPORT_DIR, 'probe-quote.pdf');
writeFileSync(probePdf, Buffer.from('%PDF-1.4 probe'));
const mediaResolved = await resolveWaMedia(probePdf, undefined);
assert.ok(mediaResolved.media.length > 10 && mediaResolved.filename === 'probe-quote.pdf', 'exports 目录文件应自动转 base64');
await assert.rejects(() => resolveWaMedia(join(USERPROFILE, 'Desktop', `__no_such_${Date.now()}.txt`)), /只允许|不是存在的文件/, '目录白名单外的路径必须拒绝');

restoreCfg();
console.log('ALL V9 DEEP PROBES PASSED');
