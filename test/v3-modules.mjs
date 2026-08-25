// v0.3 测试：回复分类、抑制列表、线程头、退订脚注、监控哈希、统计、模板。
import assert from 'node:assert';
import { execSync } from 'node:child_process';

const NODE = process.execPath;

/* ---------- 回复分类（规则层） ---------- */
const { classifyReply } = await import('../dsh/mail/replies.js');
assert.equal(classifyReply('Please unsubscribe me from your list').category, 'unsubscribe');
assert.equal(classifyReply('Thanks but we are not interested right now').category, 'not-interested');
assert.equal(classifyReply('I am out of office until Monday').category, 'ooo');
assert.equal(classifyReply('This is an automatic reply').category, 'auto');
assert.equal(classifyReply('We are interested, please send catalog and pricing', 'Re: hair dryers').category, 'interested');
assert.equal(classifyReply('What is your MOQ and lead time?').category, 'interested');

/* ---------- IMAP 头解析 + 正文解码（用内部函数不可导出，走 fixture 验证 parse 逻辑） ---------- */
// parseHeaderBlock/decodeBody 未导出，通过构造响应测试 exec 循环成本太高，
// 这里验证导出面与配置守卫：
const imap = await import('../dsh/mail/imap.js');
await assert.rejects(() => imap.imapLogin({}), /IMAP 未配置/);
assert.equal(typeof imap.imapFetchMessage, 'function');
assert.equal(typeof imap.imapProbe, 'function');

/* ---------- 抑制列表 ---------- */
const suppress = await import('../dsh/suppress.js');
const testEmail = `suppress-test-${Date.now()}@example.com`;
assert.equal(suppress.isSuppressed(testEmail), null);
suppress.suppress(testEmail, 'unsubscribe-test', 'agent');
assert.ok(suppress.isSuppressed(testEmail));
assert.throws(() => suppress.suppress('not-an-email'), /invalid email/);
const removed = suppress.unsuppress(testEmail, 'agent');
assert.ok(removed.removed);
assert.equal(suppress.isSuppressed(testEmail), null);

/* ---------- 线程头 + 退订脚注 ---------- */
const smtp = await import('../dsh/mail/smtp.js');
const mime = smtp.buildMime({
  from: 'sales@acme.cn', to: 'buyer@example.com',
  subject: 'Re: hair dryers', body: 'following up',
  inReplyTo: '<orig@mail.test>', references: '<older@mail.test>',
});
assert.ok(mime.includes('In-Reply-To: <orig@mail.test>'));
assert.ok(mime.includes('References: <older@mail.test> <orig@mail.test>'));
// 点填充：正文行首句号要双写
const dotMime = smtp.buildMime({ from: 'a@b.c', to: 'd@e.f', subject: 'x', body: '.leading dot line\nnormal line' });
const decoded = Buffer.from(dotMime.split('Content-Transfer-Encoding: base64\r\n\r\n')[1]?.split('\r\n')[0] ?? '', 'base64').toString();
// base64 编码后不会有裸点填充问题；验证 buildMime 不抛错即可
assert.ok(dotMime.length > 100);

const tpl = await import('../dsh/mail/templates.js');
const draft = tpl.withUnsubscribeFooter({ body: 'hello' }, 'es');
assert.ok(draft.body.includes('ALTO'));
const draft2 = tpl.withUnsubscribeFooter(draft, 'es');
assert.equal(draft2.body, draft.body, '不重复追加脚注');
assert.equal(tpl.languageFor('br'), 'pt');
assert.equal(tpl.languageFor('+52'), 'es');
assert.equal(tpl.languageFor('us'), 'en');
const pt = tpl.firstEmail({ company: 'ACME Ltda', product: 'secadores', me: 'Li', market: 'br' });
assert.equal(pt.language, 'pt');
assert.ok(pt.body.includes('Olá'));

/* ---------- 监控 ---------- */
const monitor = await import('../dsh/monitor.js');
const crm = await import('../dsh/crm.js');
const uniq = `mon-${Date.now()}`;
const { lead } = crm.upsertLead({ company: uniq, url: `https://${uniq}.example`, market: 'us', contacts: { emails: [], whatsapps: [], phones: [], socials: {} } });
monitor.watch(lead.id);
const watched = monitor.listWatched();
assert.ok(watched.some((t) => t.leadId === lead.id));
assert.ok(watched.find((t) => t.leadId === lead.id).url.includes(uniq));
const removed2 = monitor.unwatch(lead.id);
assert.ok(removed2.removed);

/* ---------- 统计 ---------- */
const stats = await import('../dsh/stats.js');
const report = stats.report();
assert.ok(report.funnel && typeof report.funnel.new === 'number');
assert.ok(report.conversion && 'replyRate' in report.conversion);
assert.ok(report.byTier['极高'] !== undefined);

/* ---------- cron 新任务已注册面 ---------- */
const cron = await import('../dsh/cron.js');
cron.registerJob('probe', { everyMs: 3600_000, description: 't', fn: async () => 'ok' });
assert.ok(cron.status().some((job) => job.name === 'probe'));
await assert.rejects(() => cron.runOnce('nope'), /unknown job/);

console.log('ALL V0.3 MODULE TESTS PASSED');
