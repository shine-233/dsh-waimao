// v0.7 功能测试：并行会话新增/重写的纯函数逐一验证。
// 覆盖：A/B 稳定分组、序列填充、发送时间窗、回复分类新类别、IMAP 日期、
// 域名规则边界、导入行映射、配对轮换、爬坡、预热池、CSV 防注入、定价 unit+duty。
import assert from 'node:assert';

/* ---------- A/B 稳定分组 ---------- */
const { abVariant, fillFollowUpSteps } = await import('../dsh/index.js');
const counts = { A: 0, B: 0 };
for (let i = 0; i < 200; i += 1) {
  counts[abVariant(`L${i}abc`)] += 1;
}
assert.ok(counts.A > 60 && counts.B > 60, `分组应大致对半: ${JSON.stringify(counts)}`);
assert.equal(abVariant('L-test-1'), abVariant('L-test-1'), '同 ID 分组稳定');
assert.ok(['A', 'B'].includes(abVariant('anything')));

/* ---------- 序列填充：三步全部非空，且不覆盖已有内容 ---------- */
const { newSequence } = await import('../dsh/mail/sequence.js');
const seq = newSequence({ language: 'en' });
seq.steps[0].subject = 'First';
seq.steps[0].body = 'First body';
fillFollowUpSteps(seq, { market: 'us', language: 'en' });
for (const step of seq.steps) {
  assert.ok(step.subject && step.subject.length > 0, `Day${step.day} subject 不应为空`);
  assert.ok(step.body && step.body.length > 0, `Day${step.day} body 不应为空`);
  assert.ok(!step.body.includes('undefined'), '模板不应渲染出 undefined');
}
// 已填内容的步骤不被覆盖
const seq2 = newSequence({ language: 'en' });
seq2.steps[0].subject = 'F';
seq2.steps[0].body = 'FB';
seq2.steps[1].subject = '自定义 Day3';
seq2.steps[1].body = '自定义内容';
fillFollowUpSteps(seq2, { market: 'us', language: 'en' });
assert.equal(seq2.steps[1].subject, '自定义 Day3', '已有步骤不应被覆盖');
assert.ok(seq2.steps[2].body, '空步骤仍应被填充');

/* ---------- 发送时间窗 ---------- */
const { recipientLocalTime, outsideSendWindow } = await import('../dsh/cron.js');
// UTC 12:00 → 墨西哥(utc-6) 06:00 → 窗外
const utcNoon = new Date('2026-08-26T12:00:00Z');
const mx = recipientLocalTime('mx', utcNoon);
assert.equal(mx.hour, 6);
assert.equal(outsideSendWindow(mx.hour, mx.dow), true, '墨西哥凌晨 6 点应顺延');
// UTC 18:00 → 迪拜(utc+4) 22:00 → 窗外
assert.equal(outsideSendWindow(recipientLocalTime('ae', new Date('2026-08-26T18:00:00Z')).hour), true);
// UTC 14:00 → 德国(utc+1... 8月夏令时实际+2，这里按预设+1) 15:00 周三 → 窗内
const de = recipientLocalTime('de', new Date('2026-08-26T14:00:00Z')); // 周三
assert.equal(outsideSendWindow(de.hour, de.dow), false, '德国周三 15 点应在窗口内');
// 周末顺延
assert.equal(outsideSendWindow(15, 0), true, '周日应顺延');
assert.equal(outsideSendWindow(15, 6), true, '周六应顺延');
assert.equal(outsideSendWindow(null, null), false, '未知市场不拦');

/* ---------- 回复分类（规则层新类别 + STOP 退订） ---------- */
const { classifyReply } = await import('../dsh/mail/replies.js');
assert.equal(classifyReply('stop').category, 'unsubscribe', '短 STOP 判退订');
assert.equal(classifyReply('ALTO').category, 'unsubscribe', '短 ALTO 判退订');
assert.equal(classifyReply('PARAR').category, 'unsubscribe', '短 PARAR 判退订');
assert.notEqual(classifyReply('we will stop ordering next month').category, 'unsubscribe', '正常商务句不误判退订');
assert.equal(classifyReply('can we schedule a call tomorrow?').category, 'meeting');
assert.equal(classifyReply('John has left the company, please contact our purchasing dept').category, 'wrong-person');
assert.equal(classifyReply("I'm not the right person, cc'ing my colleague who handles this").category, 'referral');
assert.equal(classifyReply('Mail Delivery Subsystem: address not found').category, 'bounce');
assert.ok(classifyReply('sure, sounds good').category in { interested: 1, meeting: 1, other: 1 });

/* ---------- IMAP 日期格式（RFC 3501） ---------- */
const { imapDate } = await import('../dsh/mail/imap.js');
assert.equal(imapDate(new Date('2026-08-26T00:00:00Z')), '26-Aug-2026');
assert.equal(imapDate(new Date('2026-01-05T00:00:00Z')), '05-Jan-2026');

/* ---------- 域名规则边界（子串不再误杀） ---------- */
const { classify } = await import('../dsh/enrich/classify.js');
assert.equal(classify({ url: 'https://acme-beauty-wix.com/about' }).keep, true, '含 wix/x.com 字样的独立域名不再被误杀');
assert.equal(classify({ url: 'https://netflix.com' }).kind === 'social', false, 'netflix 不因含 x.com 子串误判为社媒');
const social = classify({ url: 'https://x.com/somebuyer', title: 'we buy hair dryers' });
assert.equal(social.keep, false, 'x.com 本身仍判社媒');
// netflix 检查已并入上一行
assert.equal(classify({ url: 'https://alibabagroup.com' }).kind, 'b2b-platform', 'alibaba 前缀命中');
assert.equal(classify({ url: 'https://company.com/linkedin.com/jobs' }).kind === 'job', true, '路径 pattern 仍按 URL 子串');

/* ---------- 导入行：不再拿公司名冒充人名 ---------- */
const { importerRowFromLead, importerRowFromResult, csvEscape } = await import('../dsh/csv.js');
const leadRow = importerRowFromLead({
  company: 'AGARO Beauty', domain: 'agaro.example', url: 'https://agaro.example',
  contacts: { emails: ['buy@agaro.example'], whatsapps: [], phones: [], socials: {} },
  fit: 'yes', advice: '优先触达', reasons: ['+3 明确采购动词'],
});
assert.equal(leadRow.email, 'buy@agaro.example');
assert.equal(leadRow.first_name, '', '没有真实人名时 first_name 留空');
assert.equal(leadRow.company, 'AGARO Beauty');
assert.ok(leadRow.reason.includes('fit:yes'));
const resultRow = importerRowFromResult({ title: 'Best Buy Import SA', url: 'https://bestbuy-import.example', snippet: 'wholesale buyer', email: 'x@y.z' });
assert.equal(resultRow.email, 'x@y.z');
// 公式注入防护
assert.ok(csvEscape('=cmd|calc').startsWith("'"), '= 开头要加前缀');
assert.ok(csvEscape('+3').startsWith("'"));
assert.equal(csvEscape('normal'), 'normal');

/* ---------- Instantly 映射 ---------- */
const { toInstantLead } = await import('../dsh/instantly.js');
const instant = toInstantLead({ company: 'ACME', domain: 'acme.example', contacts: { emails: ['a@acme.example'] }, fit: 'partial', advice: 'x' });
assert.equal(instant.first_name, null, '无人名时不冒充');
assert.equal(instant.company_name, 'ACME');
assert.equal(instant.email, 'a@acme.example');

/* ---------- 配对轮换：无自配、全覆盖 ---------- */
const { pairRotation, rampCap, poolParticipants } = await import('../dsh/warmup.js');
for (const count of [2, 3, 5]) {
  for (const day of [0, 1, 7, 30]) {
    const pairs = pairRotation(count, day);
    assert.equal(pairs.length, count);
    for (const [a, b] of pairs) {
      assert.notEqual(a, b, '不允许自己发自己');
      assert.ok(a >= 0 && a < count && b >= 0 && b < count);
    }
  }
}
assert.equal(rampCap(0, 30), 5);
assert.equal(rampCap(20, 30), 15);
assert.equal(rampCap(90, 30), 30);
// 预热池：主账号 + accounts 去重
const pool = poolParticipants({
  smtp: { host: 'smtp.a.com', from: 'main@a.com', accounts: [{ host: 'smtp.b.com', from: 'main@a.com' }, { host: 'smtp.c.com', from: 'c@c.com' }] },
  warmup: { partners: [] },
});
assert.equal(pool.length, 2, '同邮箱去重（主账号与 accounts 重复）');
assert.ok(pool.some((p) => p.email === 'c@c.com'));

/* ---------- 定价：unit 口径 + 关税 ---------- */
const { calcPrice } = await import('../dsh/pricing.js');
const unit = calcPrice({ mode: 'unit', qty: 1000, exw: 10, inland: 1, port: 0.5, ocean: 3000, dutyRate: 20, margin: 20 });
assert.equal(unit.cost.FOB, 11500, 'unit 模式 (10+1+0.5)*1000');
assert.equal(unit.cost.CFR, 14500, '海运费按整批不乘数量');
// CIF = CFR*1.0（无保险）→ duty = CIF*20% = 2900 → DDP = 17400
assert.equal(unit.cost.DDP, 17400, 'DDP 必须含关税');
assert.ok(unit.cost.duty > 0);
const total = calcPrice({ exw: 10000, inland: 1000, port: 500, ocean: 3000, dutyRate: 20 });
assert.equal(total.cost.FOB, 11500);
assert.equal(total.cost.DDP, 17400);

/* ---------- spinText 不破坏模板占位符 ---------- */
const { spinText } = await import('../dsh/content.js');
assert.equal(spinText('Hair dryers supply for {company}'), 'Hair dryers supply for {company}', '无 | 的占位符保留');
assert.ok(['Hi A', 'Hi B'].includes(spinText('Hi {A|B}')));

console.log('ALL V0.7.2 FUNCTIONAL TESTS PASSED');
