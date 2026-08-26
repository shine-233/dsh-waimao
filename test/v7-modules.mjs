// v0.7 测试：ICP 画像（评分回落/compose 模板带产品）、Spintax、日发送上限计数、
// 纯文本配置、CRM fit 字段存取。
import assert from 'node:assert';

const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
const cfgDir = `${process.env.USERPROFILE}\\.waimao`;
mkdirSync(cfgDir, { recursive: true });
const cfgFile = `${cfgDir}\\config.json`;
let originalRaw = '';
try { originalRaw = readFileSync(cfgFile, 'utf8'); } catch {}
function writeCfg(patch) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  writeFileSync(cfgFile, JSON.stringify({ ...cfg, ...patch }));
}

/* ---------- Spintax ---------- */
const { spinText } = await import('../dsh/content.js');
// 确定性：给定 rand 永远选第 0 项 / 第 1 项
assert.equal(spinText('Hi {A|B} friend', () => 0), 'Hi A friend');
assert.equal(spinText('Hi {A|B} friend', () => 0.99), 'Hi B friend');
// 随机 200 次输出都在选项集合内，且不再含花括号
const seen = new Set();
for (let i = 0; i < 200; i += 1) {
  const out = spinText('ok {yes|no|maybe} end');
  seen.add(out);
  assert.ok(/^ok (yes|no|maybe) end$/.test(out), `unexpected: ${out}`);
}
assert.ok(seen.size === 3, '三个选项都应出现过');
// 不含 | 的花括号原样保留（不误伤占位符/JSON）
assert.equal(spinText('keep {first_name} and {"a":1}', () => 0), 'keep {first_name} and {"a":1}');
// 无花括号原样返回
assert.equal(spinText('plain subject'), 'plain subject');
// 空值
assert.equal(spinText(''), '');
// 多段各自独立替换
assert.equal(spinText('{A|B}-{C|D}', () => 0.25), 'A-C');

/* ---------- 日发送上限计数 ---------- */
const audit = await import('../dsh/audit.js');
const today = audit.startOfLocalDay();
assert.ok(!Number.isNaN(Date.parse(today)));
const start = new Date(today);
assert.equal(start.getHours(), 0, '本地时区应为 0 点');
assert.equal(start.getMinutes(), 0);
assert.equal(start.getSeconds(), 0);
assert.ok(Date.now() - start.getTime() < 86_400_000, '零点应在过去 24 小时内');
const sends = [
  { action: 'email.send', ts: today, detail: { to: 'a@b.c' } },
  { action: 'email.send', ts: new Date().toISOString(), detail: { to: 'd@e.f' } },
  { action: 'email.send', ts: new Date().toISOString(), detail: { to: 'x@y.z', dryRun: true } },
  { action: 'email.dry_run', ts: new Date().toISOString(), detail: {} },
  { action: 'wa.send', ts: new Date().toISOString(), detail: {} },
];
assert.equal(audit.countRealSends(sends), 2, '只计真实发送，dry-run 不计');
assert.equal(audit.countRealSends([]), 0);
assert.equal(audit.countRealSends(null), 0);

/* ---------- 配置：icp / dailyCap / plainText ---------- */
writeCfg({ icp: { product: 'professional hair dryers 1800-2400W', buyers: 'wholesalers, beauty supply distributors' } });
const config = await import('../dsh/config.js');
const summary = config.configSummary();
assert.equal(summary.icp.product, 'professional hair dryers 1800-2400W');
assert.equal(summary.icp.ready, true);
assert.equal(typeof summary.smtp.dailyCap, 'number');
assert.equal(typeof summary.smtp.plainText, 'boolean');

/* ---------- 评分：ICP 回落 + fit 字段（离线，规则分路径） ---------- */
const { scoreLead, ruleScore, tierOf } = await import('../dsh/score.js');
const scored = await scoreLead({
  market: 'mx',
  useAI: false, // 离线：强制走规则分
  item: { title: 'Beauty importer', snippet: 'we buy hair dryers wholesale', signalsText: '' },
});
assert.equal(typeof scored.score, 'number');
assert.ok(scored.score >= 1);
assert.equal(scored.fit, null, '无 AI 时 fit 为 null');
assert.equal(scored.scoredBy, 'rules');
// ICP 缺省回落：不传 product 不抛错（内部读 config.icp）
const scored2 = await scoreLead({ useAI: false, item: { title: 'x', snippet: '', signalsText: '' } });
assert.equal(typeof scored2.score, 'number');
assert.deepEqual(tierOf(12), { tier: '极高', emoji: '🔴' });
assert.deepEqual(tierOf(0), { tier: '排除', emoji: '⚪' });
const rs = ruleScore({ title: 'we are manufacturer', snippet: 'alibaba store', signalsText: '' });
assert.ok(rs.ruleScore <= 2, '同行/平台词应被扣分');

/* ---------- compose：模板兜底必须带上产品词 ---------- */
const { composeEmail } = await import('../dsh/mail/compose.js');
const draft = await composeEmail({
  kind: 'first', product: 'hair dryers', buyers: 'wholesalers', market: 'us', useAI: false, company: 'ACME', name: 'John',
});
assert.ok(draft.subject.includes('hair dryers'), `subject 应含产品词: ${draft.subject}`);
assert.ok(draft.body.includes('hair dryers'));
assert.equal(draft.generatedBy, 'template');

/* ---------- CRM：fit 存取 ---------- */
writeCfg({ track: { publicBaseUrl: '', secret: '' } }); // 关闭追踪，避免测试残留
const crm = await import('../dsh/crm.js');
const { lead } = crm.upsertLead({
  company: 'V7 Test Buyer', url: 'https://v7-test-buyer.example', market: 'us',
  source: 'https://v7-test-buyer.example', contacts: { emails: ['buy@v7-test-buyer.example'], whatsapps: [], phones: [], socials: {} },
  score: 9, tier: '高', fit: 'yes', reasons: ['+3 明确采购动词'], advice: '优先触达',
});
assert.equal(lead.fit, 'yes');
crm.updateLead(lead.id, { fit: 'partial' });
assert.equal(crm.getLead(lead.id).fit, 'partial');
// 合并时 fit 随高分更新
const { merged } = crm.upsertLead({
  company: 'V7 Test Buyer', url: 'https://v7-test-buyer.example', market: 'us',
  source: 'https://v7-test-buyer.example/again', contacts: { emails: [], whatsapps: [], phones: [], socials: {} },
  score: 11, tier: '极高', fit: 'yes', reasons: [], advice: '',
});
assert.equal(merged, true);
assert.equal(crm.getLead(lead.id).fit, 'yes');
// 清理测试线索（直接改存储文件）
const storePath = crm.storeFile();
const db = JSON.parse(readFileSync(storePath, 'utf8'));
db.leads = db.leads.filter((item) => item.id !== lead.id);
writeFileSync(storePath, JSON.stringify(db));

/* ---------- 恢复原配置 ---------- */
if (originalRaw) {
  writeFileSync(cfgFile, originalRaw);
}

console.log('ALL V0.7 MODULE TESTS PASSED');
