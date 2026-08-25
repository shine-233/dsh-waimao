// 模块级冒烟测试：不起 dsh，直接 import 各模块验证核心逻辑。
import assert from 'node:assert';
import { buildLayers } from '../dsh/dorks.js';
import { resolveMarket, MARKETS } from '../dsh/markets.js';
import { normalizeUrl, toLeadCsv } from '../dsh/leads.js';
import { stripHtml } from '../dsh/serp.js';
import { normalizeWebhook, normalizeHistory, sendText } from '../dsh/evolution.js';
import { leadsPage, reviewPage } from '../dsh/pages.js';
import { DEFAULT_CONFIG, readConfig, configSummary } from '../dsh/config.js';
import * as store from '../dsh/store.js';

// markets
assert.equal(resolveMarket('mx').dial, '52');
assert.equal(resolveMarket('+971').dial, '971');
assert.equal(resolveMarket('墨西哥').key, 'mx');
assert.equal(resolveMarket().key, 'mx');
assert.throws(() => resolveMarket('???'));
assert.ok(Object.keys(MARKETS).length >= 15);

// dorks
const wa = buildLayers('hair dryer', resolveMarket('mx'));
assert.equal(wa.length, 3);
assert.ok(wa[0].query.includes('"hair dryer" WhatsApp +52'));
assert.ok(wa[1].query.includes('site:linkedin.com'));
assert.ok(wa[1].query.includes('-alibaba'));
assert.ok(wa[2].query.includes('"we buy"'));
const eu = buildLayers('hair dryer', resolveMarket('eu'));
assert.ok(eu[0].query.includes('email'));
assert.ok(!eu[0].query.includes('WhatsApp'));
const one = buildLayers('pump', resolveMarket('br'), { layers: [3] });
assert.equal(one.length, 1);

// url dedup
assert.equal(normalizeUrl('https://www.Example.com/a/?utm_source=x&id=1'), 'example.com/a?id=1');
assert.equal(normalizeUrl('http://example.com/a/'), normalizeUrl('https://example.com/a'));
assert.equal(normalizeUrl('https://example.com:443/b'), 'example.com/b');

// csv
const csv = toLeadCsv({ results: [{ layer: 1, layerName: '基础搜索', title: 'a"b', url: 'u', snippet: 'x,y' }] });
assert.ok(csv.startsWith('\uFEFF'));
assert.ok(csv.includes('"a""b"'));
assert.ok(csv.includes('"x,y"'));

// html strip
assert.equal(stripHtml('<b>A</b> &amp; B&#x27;s'), "A & B's");

// webhook normalize (v1.8 object + v2 array shapes)
const v1 = normalizeWebhook({
  event: 'messages.upsert',
  data: { key: { id: 'A1', remoteJid: '52155@s.whatsapp.net', fromMe: false }, pushName: 'Leo', message: { conversation: 'hello, we buy hair dryers' }, messageTimestamp: 1756000000 },
});
assert.equal(v1.length, 1);
assert.equal(v1[0].text, 'hello, we buy hair dryers');
const v2 = normalizeWebhook({
  event: 'messages.upsert',
  data: [{ key: { id: 'A2', remoteJid: 'x@s.whatsapp.net', fromMe: true }, message: { conversation: 'me' }, messageTimestamp: 1756000001 }],
});
assert.equal(v2[0].fromMe, true);
assert.equal(normalizeWebhook({ event: 'connection.update', data: {} }).length, 0);

// history normalize (messages.records shape)
const hist = normalizeHistory({ messages: { records: [{ key: { id: 'H1', remoteJid: 'c', fromMe: false }, message: { extendedTextMessage: { text: 'price pls' } }, messageTimestamp: 1756000002 }] } }, 'c');
assert.equal(hist[0].text, 'price pls');

// store roundtrip (unique id so the test is re-runnable)
const tid = `T-${Date.now().toString(36)}`;
store.upsertIncoming([{ id: tid, chatJid: '52155@s.whatsapp.net', sender: '52155@s.whatsapp.net', name: 'Leo', text: 'hi', ts: new Date().toISOString() }]);
assert.ok(store.pendingQueue({}).some((m) => m.id === tid));
store.updateMessage(tid, { status: 'sent', sentAt: new Date().toISOString() });
assert.ok(!store.pendingQueue({}).some((m) => m.id === tid));

// sendText validation (no network: bad number throws before fetch)
await assert.rejects(() => sendText('123', 'x'), /invalid phone/);
await assert.rejects(() => sendText('5215512345678', ''), /empty/);

// pages render + no stray template artifacts
const lp = leadsPage();
const rp = reviewPage();
for (const page of [lp, rp]) {
  assert.ok(page.includes('<!doctype html>'));
  assert.ok(!page.includes('undefined'));
  assert.ok(!page.includes('[object Object]'));
}
assert.ok(lp.includes('谷歌获客'));
assert.ok(rp.includes('审核台'));

// config
assert.equal(DEFAULT_CONFIG.serp.engine, 'ddg');
assert.ok(configSummary().serp);

console.log('ALL SMOKE TESTS PASSED');
