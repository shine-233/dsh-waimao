// v0.4 测试：追踪（像素/链接包裹/事件）、MIME alternative、预热爬坡、送达率。
import assert from 'node:assert';

/* ---------- MIME alternative ---------- */
const smtp = await import('../dsh/mail/smtp.js');
const altMime = smtp.buildMime({ from: 'a@b.c', to: 'd@e.f', subject: 'x', body: 'plain text', html: '<b>html</b>' });
assert.ok(altMime.includes('multipart/alternative'));
assert.ok(altMime.includes('text/plain'));
assert.ok(altMime.includes('text/html'));
// 附件 + html → mixed 包 alternative
const mixedMime = smtp.buildMime({ from: 'a@b.c', to: 'd@e.f', subject: 'x', body: 'p', html: '<i>h</i>', attachments: [{ filename: 'q.pdf', base64: 'JVBERi0=' }] });
assert.ok(mixedMime.includes('multipart/mixed'));
assert.ok(mixedMime.includes('multipart/alternative'));
assert.ok(mixedMime.includes('q.pdf'));
// 纯文本无 html → 无 alternative
const plainMime = smtp.buildMime({ from: 'a@b.c', to: 'd@e.f', subject: 'x', body: 'p' });
assert.ok(!plainMime.includes('multipart'));
assert.ok(plainMime.includes('text/plain'));

/* ---------- 追踪 ---------- */
// 配置公网入口
const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
const cfgDir = `${process.env.USERPROFILE}\\.waimao`;
mkdirSync(cfgDir, { recursive: true });
const cfgFile = `${cfgDir}\\config.json`;
let cfg = {};
try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
cfg.track = { publicBaseUrl: 'https://track.test.example', secret: 'test-secret-v4' };
writeFileSync(cfgFile, JSON.stringify(cfg));

const track = await import('../dsh/track.js');
assert.equal(track.trackingEnabled(), 'https://track.test.example');

const { id, record } = track.createTracking({ leadId: 'L-test', to: 'buyer@example.com', subject: 'Hello' });
assert.ok(track.isValidTrackId(id));
assert.ok(!track.isValidTrackId('short'));
assert.ok(!track.isValidTrackId(`${id}x`));

const built = track.buildTrackedHtml({
  text: 'Visit https://acme.cn/catalog for info. Thanks!',
  trackId: id,
  base: 'https://track.test.example',
});
assert.ok(built.html.includes(`https://track.test.example/waimao/px?id=${id}`));
assert.ok(built.html.includes('/waimao/click?c='));
assert.ok(Object.keys(built.clickMap).length >= 1);
// 链接映射：clickId → 原始 URL
const [firstCid, firstUrl] = Object.entries(built.clickMap)[0];
assert.ok(firstUrl.includes('acme.cn'));

// 点击：合法 id → 返回登记的 URL；未知 id → null（防开放重定向）
assert.equal(track.recordClick(firstCid), firstUrl);
assert.equal(track.recordClick('0123456789abcdef'), null);
// 打开：合法记录一次/天
assert.equal(track.recordOpen(id, 'test-agent'), true);
assert.equal(track.recordOpen(id, 'test-agent'), false, '同一天重复打开不重复计');

const tstats = track.trackStats();
assert.ok(tstats.trackedEmails >= 1);
assert.ok(tstats.opened >= 1);
assert.ok(tstats.clicked >= 1);

// 未配置公网入口 → 关闭
cfg.track.publicBaseUrl = '';
writeFileSync(cfgFile, JSON.stringify(cfg));
// 重新加载模块的 readConfig 是动态读取，trackingEnabled 应实时反映
assert.equal(track.trackingEnabled(), '');

/* ---------- 预热爬坡 ---------- */
const warmup = await import('../dsh/warmup.js');
assert.equal(warmup.rampCap(0, 30), 5);
assert.equal(warmup.rampCap(3, 30), 5);
assert.equal(warmup.rampCap(7, 30), 10);
assert.equal(warmup.rampCap(14, 30), 15);
assert.equal(warmup.rampCap(60, 30), 30, '封顶');
assert.equal(warmup.rampCap(400, 10), 10, '自定义封顶');
assert.ok(warmup.WARMUP_TAG.includes('waimao-warmup'));
await assert.rejects(() => warmup.runWarmupRound({}), /预热未配置/);

/* ---------- 送达率（真实 DNS，google.com 基本必过） ---------- */
const { deliverabilityCheck } = await import('../dsh/deliverability.js');
const report = await deliverabilityCheck('gmail.com');
assert.ok(report.checks.some((check) => check.item === 'SPF' && check.ok), 'gmail.com 应有 SPF');
assert.ok(report.checks.some((check) => check.item === 'MX' && check.ok), 'gmail.com 应有 MX');
assert.ok(report.advice.length >= 1);
const bad = await deliverabilityCheck('this-domain-definitely-does-not-exist-xyz123.com');
assert.ok(bad.advice.length >= 2);

console.log('ALL V0.4 MODULE TESTS PASSED');
