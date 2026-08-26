// v0.6 测试：定价计算、PI发票、蓝海选国(结构)、口播脚本(模板兜底)、退信分类、爬坡、A/B统计。
import assert from 'node:assert';

/* ---------- 定价计算器 ---------- */
const { calcPrice, quoteLines } = await import('../dsh/pricing.js');
const calc = calcPrice({ mode: 'total', exw: 10000, inland: 500, port: 300, ocean: 2000, insuranceRate: 1, dest: 800, destFreight: 400, margin: 20, qty: 1000 });
assert.equal(calc.cost.EXW, 10000);
assert.equal(calc.cost.FOB, 10800);
assert.equal(calc.cost.CFR, 12800);
assert.equal(calc.cost.insurance, 128);
assert.equal(calc.cost.CIF, 12928);
assert.equal(calc.cost.DDP, 14128); // 不传 dutyRate 时 DDP 不含关税（保持兼容）
assert.equal(calc.quote.FOB, 12960); // 10800 * 1.2
assert.equal(calc.quote.CIF, 15513.6);
assert.equal(calc.perUnit.FOB, 12.96);
const unitCalc = calcPrice({ mode: 'unit', exw: 5, inland: 0.2, port: 0.1, ocean: 1, qty: 1000, margin: 10 });
assert.equal(unitCalc.cost.FOB, 5300); // 5.3 * 1000（ocean 按整批不乘 qty）
assert.equal(unitCalc.perUnit.FOB, 5.83); // 5.3*1.1
// DDP 关税：duty 按 CIF 计入
const ddpCalc = calcPrice({ mode: 'total', exw: 10000, ocean: 2000, dutyRate: 30 });
assert.equal(ddpCalc.cost.duty, Math.round(12000 * 0.3 * 100) / 100);
assert.ok(ddpCalc.cost.DDP > ddpCalc.cost.CIF + ddpCalc.cost.duty - 0.01, 'DDP 应含关税+清关费');
const text = quoteLines(calc);
assert.ok(text[1].includes('FOB') && text[1].includes('12.96'));

/* ---------- PI 发票 ---------- */
const { proformaPdf, quotePdf } = await import('../dsh/pdf.js');
const pi = proformaPdf({
  piNo: 'PI-TEST', items: [{ desc: 'Hair dryer 2000W', hsCode: '8516.31', qty: 1000, unitPrice: 8.5 }],
  incoterm: 'CIF Shanghai', bank: { name: 'Bank of China', account: '888', swift: 'BKCHCNBJ' },
  from: { company: 'ACME' }, to: { company: 'Buyer SA' },
});
const s = pi.toString('latin1');
assert.ok(s.startsWith('%PDF-') && s.trimEnd().endsWith('%%EOF'));
assert.ok(s.includes('PROFORMA INVOICE') && s.includes('8516.31') && s.includes('CIF Shanghai') && s.includes('Bank of China'));

/* ---------- 蓝海选国（mock 引擎） ---------- */
const realFetch = globalThis.fetch;
const { writeFileSync, mkdirSync } = await import('node:fs');
const cfgDir = `${process.env.USERPROFILE}\\.waimao`;
mkdirSync(cfgDir, { recursive: true });
const cfgFile = `${cfgDir}\\config.json`;
let cfg = {};
try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
const { readFileSync } = await import('node:fs');
// 清掉本地代理配置，让 mock fetch 生效
cfg.serp = Object.assign({}, cfg.serp, { proxy: '', engine: 'ddg', chain: ['ddg'] });
writeFileSync(cfgFile, JSON.stringify(cfg));
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('duckduckgo')) {
    const q = decodeURIComponent(String(init?.body ?? ''));
    const market = q.includes('+52') ? 'mx' : q.includes('+49') ? 'de' : 'other';
    const html = market === 'mx'
      ? `<a class="result__a" href="https://buyers-mx.com/a">We buy hair dryers WhatsApp</a><a class="result__snippet" href="#">looking for supplier</a><a class="result__a" href="https://www.alibaba.com/x">Alibaba</a>`
      : `<a class="result__a" href="https://www.made-in-china.com/y">supplier</a>`;
    return { ok: true, status: 200, headers: {}, text: async () => html };
  }
  throw new Error('unexpected fetch ' + target);
};
try {
  const { scanMarkets } = await import('../dsh/market.js');
  const scan = await scanMarkets({ product: 'hair dryer', markets: ['mx', 'de'], perMarket: 8 });
  assert.equal(scan.ranking.length, 2);
  assert.ok(scan.ranking[0].opportunity >= scan.ranking[1].opportunity, '按机会分排序');
  const mx = scan.ranking.find((r) => r.market === 'mx');
  assert.ok(mx.buyerSignals >= 1, '墨西哥应有买家信号');
  assert.ok(mx.verdict.includes('蓝海') || mx.verdict.includes('可试'));
} finally {
  globalThis.fetch = realFetch;
  delete cfg.serp.proxy;
  writeFileSync(cfgFile, JSON.stringify(cfg));
}

/* ---------- 口播脚本（模板兜底，无 key） ---------- */
const { videoScript, renderScript } = await import('../dsh/content.js');
const script = await videoScript({ product: 'hair dryer', seconds: 30 });
assert.equal(script.generatedBy, 'template');
assert.ok(script.hook.text.includes('hair dryer'));
assert.ok(script.scenes.length >= 3);
const rendered = renderScript(script);
assert.ok(rendered.includes('HOOK') && rendered.includes('CTA'));

/* ---------- 退信分类 + 抑制 ---------- */
const { classifyReply } = await import('../dsh/mail/replies.js');
assert.equal(classifyReply('Mail Delivery System: This message was undeliverable').category, 'bounce');
assert.equal(classifyReply('User unknown in virtual mailbox table').category, 'bounce');

/* ---------- 爬坡 + A/B 统计结构 ---------- */
const warmup = await import('../dsh/warmup.js');
assert.equal(warmup.rampCap(20, 30), 15, '第20天=第3周=5+2*5');
assert.equal(warmup.rampCap(21, 30), 20, '第21天=第4周=5+3*5');
// dry_run 总闸对预热强制：强制总闸开启，一封不发、不抛错（防真实配置误发）
const origV6 = (() => { try { return readFileSync(cfgFile, 'utf8'); } catch { return ''; } })();
cfg = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
cfg.smtp = Object.assign({}, cfg.smtp, { dryRun: true });
writeFileSync(cfgFile, JSON.stringify(cfg));
let warmupRound;
try {
  warmupRound = await warmup.runWarmupRound({});
} finally {
  if (origV6) {
    writeFileSync(cfgFile, origV6);
  }
}
assert.ok(warmupRound.skipped && warmupRound.skipped.includes('dry_run'), `预热应被总闸拦下: ${JSON.stringify(warmupRound)}`);
const stats = await import('../dsh/stats.js');
const report = stats.report();
assert.ok('abTest' in report);
assert.ok(report.tracking !== undefined);

/* ---------- 发送时间窗（sendWindow 真实现） ---------- */
const cron = await import('../dsh/cron.js');
assert.equal(cron.recipientLocalHour('de', new Date('2026-01-01T12:00:00Z')), 13, 'UTC+1 市场按粗时区换算');
assert.equal(cron.recipientLocalHour('+999', new Date()), null, '未知市场不检查窗口');
assert.equal(cron.outsideSendWindow(null), false);
assert.equal(cron.outsideSendWindow(8), true, '9点前不顺延发送');
assert.equal(cron.outsideSendWindow(12), false);
assert.equal(cron.outsideSendWindow(12, 0), true, '周日不顺延发送');
assert.equal(cron.outsideSendWindow(12, 3), false, '工作日窗口内正常发');
assert.equal(cron.outsideSendWindow(19), true, '19点后不顺延发送');
// 收件人当地时间换算（含星期）
const localParts = cron.recipientLocalTime('br', new Date('2026-08-26T12:00:00Z'));
assert.equal(localParts.hour, 9);
assert.ok(localParts.dow >= 0 && localParts.dow <= 6);

/* ---------- 预热池配对轮换 ---------- */
const warmupMod = await import('../dsh/warmup.js');
const pairsA = warmupMod.pairRotation(4, 0);
const pairsB = warmupMod.pairRotation(4, 1);
assert.equal(pairsA.length, 4);
assert.ok(pairsA.every(([s, r]) => s !== r && s >= 0 && r < 4), '不能自己给自己发');
assert.ok(JSON.stringify(pairsA) !== JSON.stringify(pairsB), '隔天必须换配对');
// 池参与者构建（纯函数，喂假配置）
const fakePoolCfg = {
  smtp: { host: 'smtp.main.com', from: 'main@main.com', accounts: [
    { host: 'smtp.b.com', from: 'b@b.com' },
    { host: 'smtp.c.com', from: 'c@c.com', warmup: false },
    { host: 'smtp.main.com', from: 'main@main.com' }, // 与主账号重复，应被去重
  ] },
  imap: { host: 'imap.main.com', user: 'main@main.com', pass: 'x' },
  warmup: { partners: [{ host: 'smtp.d.com', user: 'd@d.com', pass: 'x', imapHost: 'imap.d.com' }] },
};
const pool = warmupMod.poolParticipants(fakePoolCfg);
assert.deepEqual(pool.map((p) => p.email).sort(), ['b@b.com', 'd@d.com', 'main@main.com'], 'warmup:false 退出、重复邮箱去重');
assert.equal(pool.find((p) => p.email === 'd@d.com').imap.host, 'imap.d.com');

/* ---------- 时区窗 ---------- */
const { MARKETS } = await import('../dsh/markets.js');
assert.equal(typeof MARKETS.mx.utc, 'number');
assert.equal(MARKETS.de.utc, 1);

console.log('ALL V0.6 MODULE TESTS PASSED');
