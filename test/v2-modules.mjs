// v0.2 新模块测试：加工管线各环节 + CRM + SOP + 序列 + PDF + 模板。
// 全部离线（网络类模块用 fixture/mock）。
import assert from 'node:assert';

/* ---------- classify 规则引擎 ---------- */
const { classify } = await import('../dsh/enrich/classify.js');
assert.equal(classify({ url: 'https://www.alibaba.com/supplier/abc' }).keep, false);
assert.equal(classify({ url: 'https://www.yelp.com/biz/x' }).kind, 'directory');
assert.equal(classify({ url: 'https://www.indeed.com/jobs?q=x' }).kind, 'job');
assert.equal(classify({ url: 'https://facebook.com/somepage' }).kind, 'social');
assert.equal(classify({ url: 'https://www.gov.uk/thing' }).kind, 'gov-edu');
const supplier = classify({ url: 'https://factory-example.com', title: 'Leading manufacturer of hair dryers', snippet: 'We are manufacturer, our factory was founded in 1998, OEM/ODM welcome. Our products include...' });
assert.equal(supplier.keep, false);
assert.equal(supplier.kind, 'supplier');
const buyer = classify({ url: 'https://beauty-imports.mx/about', title: 'Beauty Imports SA de CV', snippet: 'We are looking for suppliers of hair dryers. We buy in bulk for our stores. Request a quote.' });
assert.equal(buyer.keep, true);
assert.equal(buyer.kind, 'buyer');

/* ---------- contacts 提取 ---------- */
const { extractContacts } = await import('../dsh/enrich/contacts.js');
const html = `
<html><head><title>Beauty Imports | Wholesale Distributor</title>
<meta property="og:site_name" content="Beauty Imports MX"></head><body>
<a href="mailto:info@beautyimports.mx">mail</a>
<a href="mailto:noreply@beautyimports.mx">bad</a>
<a href="https://wa.me/5215512345678">chat</a>
<a href="tel:+52 55 1234 5678">call</a>
Contact: sales@beautyimports.mx, call +52-55-8765-4321
<a href="https://www.linkedin.com/company/beauty-imports">LI</a>
<script>var email="trap@script.io";</script>
</body></html>`;
const contacts = extractContacts(html);
assert.ok(contacts.emails.includes('info@beautyimports.mx'));
assert.ok(contacts.emails.includes('sales@beautyimports.mx'));
assert.ok(!contacts.emails.includes('trap@script.io'), 'script 内邮箱不应提取');
assert.ok(!contacts.emails.some((e) => e.startsWith('noreply@')), 'noreply 应过滤');
assert.ok(contacts.whatsapps.includes('5215512345678'));
assert.ok(contacts.company === 'Beauty Imports MX');
assert.ok(contacts.socials.linkedin?.[0].includes('linkedin.com/company/beauty-imports'));

/* ---------- email 猜测 ---------- */
const { guessEmails } = await import('../dsh/enrich/emailfind.js');
const guesses = guessEmails({ name: 'John Garcia', domain: 'https://www.beautyimports.mx/contact' });
assert.ok(guesses.includes('john@beautyimports.mx'));
assert.ok(guesses.includes('john.garcia@beautyimports.mx'));
assert.ok(guesses.includes('jgarcia@beautyimports.mx'));
assert.ok(guesses.includes('info@beautyimports.mx'));
assert.equal(guessEmails({ name: '', domain: 'x' }).length, 0);

/* ---------- score 规则分 ---------- */
const { ruleScore, tierOf } = await import('../dsh/score.js');
const high = ruleScore({ title: 'Importer of hair dryers', snippet: 'We buy wholesale, looking for supplier. Request a quote. WhatsApp +52 155' });
assert.ok(high.ruleScore >= 5, `高意向分应>=5, got ${high.ruleScore}`);
const low = ruleScore({ title: 'Leading manufacturer', snippet: 'We are manufacturer of hair dryers, our factory...' });
assert.ok(low.ruleScore <= 3, `同行分应<=3, got ${low.ruleScore}`);
assert.equal(tierOf(11).emoji, '🔴');
assert.equal(tierOf(8).emoji, '🟠');
assert.equal(tierOf(5).emoji, '🟡');
assert.equal(tierOf(2).emoji, '🟢');
assert.equal(tierOf(0).tier, '排除');

/* ---------- CRM ---------- */
const crm = await import('../dsh/crm.js');
const unique = `test-${Date.now()}`;
const { lead, merged } = crm.upsertLead({
  company: `Beauty Imports ${unique}`, url: `https://beauty-${unique}.mx`, market: 'mx',
  source: 'https://beauty-' + unique + '.mx',
  contacts: { emails: ['info@x.mx'], whatsapps: ['5215511111111'], phones: [], socials: {} },
  score: 9, tier: '高', reasons: ['test'], advice: 'test advice',
});
assert.equal(merged, false);
assert.equal(lead.status, 'new');
// 同域名再次入库 → 合并
const again = crm.upsertLead({ company: 'dup', url: `https://www.beauty-${unique}.mx/other-page`, market: 'mx', contacts: { emails: ['sales@x.mx'], whatsapps: [], phones: [], socials: {} }, score: 11, tier: '极高' });
assert.equal(again.merged, true);
assert.ok(again.lead.contacts.emails.includes('sales@x.mx'), '合并后应包含新邮箱');
assert.equal(again.lead.score, 11, '分数应取高');
// 状态机
const updated = crm.updateLead(lead.id, { status: 'contacted' }, { activityNote: '发信' });
assert.equal(updated.status, 'contacted');
assert.throws(() => crm.updateLead(lead.id, { status: 'bogus' }), /invalid status/);
crm.addActivity(lead.id, { type: 'call', note: 'called, asked for FOB' });
const listed = crm.listLeads({ q: unique });
assert.ok(listed.length >= 1);
assert.ok(crm.listLeads({ status: 'contacted' }).some((l) => l.id === lead.id));

/* ---------- SOP 阶段机 + 审批门 ---------- */
const sop = await import('../dsh/sop.js');
globalThis.__waimaoCrm = crm; // index.js 运行时注入，测试里手动等价注入
const task = sop.createTask({ goal: `开发测试客户 ${unique}`, product: 'hair dryer', market: 'mx' });
assert.equal(task.stage, 'parse');
// 建任务时已带 product/market → parse 直接放行到 discover
let step = sop.nextStep(task.id, {});
assert.equal(step.task.stage, 'discover');
assert.throws(() => sop.nextStep(task.id, {}), /discover 未完成/);
step = sop.nextStep(task.id, { runId: 'run-test' });
assert.equal(step.task.stage, 'enrich');
assert.throws(() => sop.nextStep(task.id, {}), /enrich 未完成/);
step = sop.nextStep(task.id, { leadIds: [lead.id] });
assert.equal(step.task.stage, 'score');
// score 需要 CRM 有分（upsertLead 时给了 11 分，但那是合并后的 again.lead；原 lead 是 9）
step = sop.nextStep(task.id, {});
assert.equal(step.task.stage, 'draft');
assert.throws(() => sop.nextStep(task.id, {}), /draft 未完成/);
const draft = sop.attachDraft(task.id, { leadId: lead.id, channel: 'email', to: 'info@x.mx', subject: 'Hello', body: 'We supply hair dryers' });
step = sop.nextStep(task.id, {});
assert.equal(step.task.stage, 'approval');
// 审批门：未批准时 outreach 前的 approval 校验必须失败（fail-closed）
assert.throws(() => sop.nextStep(task.id, {}), /approval 未完成/);
assert.throws(() => sop.assertApproved(task.id, draft.id), /未批准/);
const review = sop.reviewDraft(task.id, draft.id, { approve: true, actor: 'user' });
assert.equal(review.pending, 0);
sop.assertApproved(task.id, draft.id); // 不抛即通过
// 草稿被改动 → 哈希失配 → 批准失效
const taskFull = sop.getTaskFull(task.id);
taskFull.drafts[0].body = 'CHANGED CONTENT';
// 直接改存储里的内容模拟改动
{
  const fs = await import('node:fs');
  const file = `${process.env.USERPROFILE}\\.waimao\\data\\sop.json`;
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stored = db.tasks.find((t) => t.id === task.id);
  stored.drafts[0].body = 'CHANGED CONTENT';
  fs.writeFileSync(file, JSON.stringify(db));
}
assert.throws(() => sop.assertApproved(task.id, draft.id), /哈希失配|未批准/);
// 重新批准后放行
sop.reviewDraft(task.id, draft.id, { approve: true, actor: 'user' });
sop.assertApproved(task.id, draft.id);
step = sop.nextStep(task.id, {});
assert.equal(step.task.stage, 'outreach');
assert.throws(() => sop.nextStep(task.id, {}), /outreach 未完成/);
step = sop.nextStep(task.id, { sent: [{ draftId: draft.id, to: 'info@x.mx', dryRun: true }], });
assert.equal(step.task.stage, 'close');
const closed = sop.nextStep(task.id, {});
assert.ok(closed.report);
assert.equal(closed.report.dryRunOnly, true);

/* ---------- 序列 ---------- */
const seq = await import('../dsh/mail/sequence.js');
const s = seq.newSequence({ language: 'es' });
assert.equal(s.steps.length, 4);
assert.equal(seq.dueSteps(s).length, 1, 'Day0 立即到期');
// 模拟 8 天前启动
s.startedAt = new Date(Date.now() - 8 * 86400000).toISOString();
assert.equal(seq.dueSteps(s).length, 3, 'Day0/3/7 到期');
seq.stopSequence(s);
assert.equal(seq.dueSteps(s).length, 0);

/* ---------- 模板 ---------- */
const tpl = await import('../dsh/mail/templates.js');
const en = tpl.firstEmail({ name: 'John', company: 'ACME', product: 'hair dryers', me: 'Li Lei', market: 'us' });
assert.equal(en.language, 'en');
assert.ok(en.subject.includes('hair dryers'));
const es = tpl.firstEmail({ name: 'Juan', company: 'ACME MX', product: 'secadores', me: 'Li Lei', market: 'mx' });
assert.equal(es.language, 'es');
assert.ok(es.body.includes('Hola'));
const fu = tpl.followUp({ name: 'J', company: 'C', product: 'p', me: 'M', market: 'us' }, 2);
assert.equal(fu.day, 7);

/* ---------- PDF ---------- */
const { quotePdf } = await import('../dsh/pdf.js');
const pdf = quotePdf({
  quoteNo: 'QTEST1',
  from: { company: 'ACME Export', email: 'sales@acme.cn' },
  to: { company: 'Beauty Imports', contact: 'John', country: 'MX' },
  items: [
    { desc: 'Hair dryer 2000W professional', qty: 1000, unitPrice: 8.5 },
    { desc: 'Hair dryer travel folding', qty: 500, unitPrice: 4.2 },
  ],
  currency: 'USD',
});
assert.ok(pdf.slice(0, 5).toString() === '%PDF-');
assert.ok(pdf.includes('/Type /Catalog'));
assert.ok(pdf.includes('QUOTATION'));
assert.ok(pdf.includes('8.50'));
assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'));

/* ---------- CSV ---------- */
const { toCsv, crmRow, CRM_CSV_HEADERS } = await import('../dsh/csv.js');
const csv = toCsv(CRM_CSV_HEADERS, [crmRow(crm.getLead(lead.id))]);
assert.ok(csv.startsWith('\uFEFF'));
assert.ok(csv.includes('Beauty Imports'));

/* ---------- 审计 ---------- */
const { queryAudit } = await import('../dsh/audit.js');
const entries = queryAudit({ limit: 10 });
assert.ok(entries.length >= 1);
assert.ok(entries[0].ts && entries[0].action);

/* ---------- cron 注册/状态/手动触发（不启动定时器） ---------- */
const cron = await import('../dsh/cron.js');
cron.registerJob('testJob', { everyMs: 3_600_000, description: 'test', fn: async () => 'ran!' });
assert.ok(cron.status().some((job) => job.name === 'testJob'));
const triggered = await cron.runOnce('testJob');
assert.equal(triggered.result, 'ran!');
await assert.rejects(() => cron.runOnce('nope'), /unknown job/);

console.log('ALL V0.2 MODULE TESTS PASSED');
