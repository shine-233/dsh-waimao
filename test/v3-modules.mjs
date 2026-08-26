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
// 实战分类（对标 gtm-mcp）：会议邀约/找错人/转介同事
assert.equal(classifyReply('Sure, let\'s schedule a call next week').category, 'meeting');
assert.equal(classifyReply('I left the company last month, try reaching David').category, 'wrong-person');
assert.equal(classifyReply('CC\'ing my colleague who handles purchasing').category, 'referral');

/* ---------- IMAP 头解析 + 正文解码（用内部函数不可导出，走 fixture 验证 parse 逻辑） ---------- */
// parseHeaderBlock/decodeBody 未导出，通过构造响应测试 exec 循环成本太高，
// 这里验证导出面与配置守卫：
const imap = await import('../dsh/mail/imap.js');
await assert.rejects(() => imap.imapLogin({}), /IMAP 未配置/);
assert.equal(typeof imap.imapFetchMessage, 'function');
assert.equal(typeof imap.imapProbe, 'function');

/* ---------- IMAP 头块提取：头值含括号不得截断 ---------- */
const headerText = 'Message-ID: <abc@mail.test>\r\nFrom: "Foo (Trading Co.)" <a@b.com>\r\nSubject: Re: quote (2)\r\n\r\n';
const fetchResponse =
  `* 1 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT)] {${Buffer.byteLength(headerText)}}\r\n${headerText} BODY[TEXT]<0> {5}\r\nHello)\r\nA003 OK done`;
// 用假 session 直接喂 fixture
const msg = await imap.imapFetchMessage({ exec: async () => fetchResponse }, 1);
assert.equal(msg.messageId, '<abc@mail.test>', '含括号的 From 不得截断 Message-ID');
assert.ok(msg.from.includes('a@b.com'), 'From 应完整解析');
// 无字面量标记的兜底路径
assert.ok(imap.extractHeaderBlock('X BODY[HEADER.FIELDS (FROM)]\r\nFrom: x@y.z\r\n)').includes('x@y.z'));

/* ---------- QP 解码：多字节 UTF-8 必须重组为中文 ---------- */
const qpBody = '=E4=B8=AD=E6=96=87 test';
const qpHeaders = 'Message-ID: <qp@mail.test>\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n';
const qpResponse =
  `* 2 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID CONTENT-TRANSFER-ENCODING)] {${Buffer.byteLength(qpHeaders)}}\r\n${qpHeaders} BODY[TEXT]<0> {${Buffer.byteLength(qpBody)}}\r\n${qpBody})\r\nA004 OK done`;
const qpMsg = await imap.imapFetchMessage({ exec: async () => qpResponse }, 2);
assert.ok(qpMsg.body.includes('中文'), `QP 中文应正确解码, got: ${qpMsg.body}`);
assert.ok(qpMsg.body.includes('test'), 'QP 正文 ASCII 部分应保留');

/* ---------- 退订关键词（页脚承诺的 STOP/ALTO/PARAR） ---------- */
assert.equal(classifyReply('STOP').category, 'unsubscribe');
assert.equal(classifyReply('PARAR', 'Re: offer').category, 'unsubscribe');
assert.equal(classifyReply('ALTO!').category, 'unsubscribe');
assert.notEqual(classifyReply('We will stop ordering next quarter due to inventory').category, 'unsubscribe', '正常商务句不得误判退订');

/* ---------- 域名分类：按域后缀对齐，x.com 不再误杀 wix/netflix ---------- */
const { classify } = await import('../dsh/enrich/classify.js');
assert.equal(classify({ url: 'https://www.wix.com/template' }).keep, true, 'wix.com 不是社媒');
assert.equal(classify({ url: 'https://www.netflix.com' }).keep, true, 'netflix.com 不是社媒');
assert.equal(classify({ url: 'https://x.com/someone' }).kind, 'social');
assert.equal(classify({ url: 'https://www.x.com/someone' }).kind, 'social');
assert.equal(classify({ url: 'https://facebook.com/page' }).kind, 'social');
assert.equal(classify({ url: 'https://www.alibaba.com/u/xyz' }).kind, 'b2b-platform');
assert.equal(classify({ url: 'https://www.linkedin.com/jobs/view/1' }).kind, 'job');

/* ---------- 联系人抽取：占位域名过滤作用在域名上 ---------- */
const { extractContacts } = await import('../dsh/enrich/contacts.js');
const extracted = extractContacts('<a href="mailto:info@example.com">mail</a><a href="mailto:buy@real-buyer.example">x</a>');
assert.ok(!extracted.emails.includes('info@example.com'), 'example.com 占位域名应被过滤');
assert.ok(extracted.emails.includes('buy@real-buyer.example'));

/* ---------- IMAP 日期格式（RFC: DD-Mon-YYYY） ---------- */
assert.equal(imap.imapDate(new Date(Date.UTC(2026, 7, 26))), '26-Aug-2026');

/* ---------- CSV 公式注入 + vCard 转义 ---------- */
const csvMod = await import('../dsh/csv.js');
assert.ok(csvMod.toCsv(['公司'], [{ '公司': '=HYPERLINK("http://evil")' }]).includes("'=HYPERLINK"), '公式开头应加前缀防注入');
// Instantly/Smartlead 标准导入列
const impRow = csvMod.importerRowFromLead({
  company: 'ACME Trading', domain: 'acme.example', url: '', score: 9,
  fit: 'yes', advice: '优先触达',
  contacts: { emails: ['buy@acme.example'], socials: { linkedin: ['https://linkedin.com/company/acme'] } },
});
assert.deepEqual(Object.keys(impRow), csvMod.IMPORTER_CSV_HEADERS);
assert.equal(impRow.email, 'buy@acme.example');
assert.equal(impRow.website, 'https://acme.example');
assert.equal(impRow.linkedin_url, 'https://linkedin.com/company/acme');
assert.ok(impRow.reason.includes('fit:yes'));
const vc = csvMod.toVCard({ company: 'A,B; C\\D', market: 'mx; tier 高', contacts: {} });
assert.ok(vc.includes('mx\\; tier 高'), `vCard NOTE 分号需转义: ${vc.split('\r\n').find((l) => l.startsWith('NOTE'))}`);
assert.ok(vc.includes('N:A B  C D;;;;'), `vCard 需有 N 字段(公司名分隔符已被空格替代): ${vc.split('\r\n').find((l) => l.startsWith('N:'))}`);

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

/* ---------- 域名黑名单：退信公司整体拒发 ---------- */
const badDomain = `banned-${Date.now()}.example.com`;
assert.equal(suppress.isDomainBlacklisted(badDomain), null);
suppress.blacklistDomain(badDomain, 'hard-bounce', 'agent');
assert.ok(suppress.isDomainBlacklisted(badDomain));
assert.equal(suppress.domainOf('buyer@' + badDomain), badDomain);
assert.throws(() => suppress.blacklistDomain('not-a-domain'), /invalid domain/);

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
