// 端到端本地仿真：不依赖任何真实外部服务。
// 起四个本地假服务器（SMTP / IMAP / DeepSeek兼容 / Evolution兼容），
// 把插件配置指向它们，然后走真实代码路径验证：
//   1. SMTP：sendMail 真实握手（EHLO/AUTH PLAIN/DATA/dot-stuffing/RFC2047中文主题）
//   2. 邮件发送闭环：email_send 工具 → SMTP 收到 → CRM 变 contacted → 审计落盘
//      + 抑制列表拦截 + 域名黑名单拦截 + dailyCap 闸门
//   3. IMAP：scanReplies 真实会话（SEARCH/FETCH 字面量/QP中文解码）→ AI 分类 → CRM replied
//      + STOP 退订 → 抑制列表
//   4. 跟进序列：sequence_start → cron 到期 → 三步全部真实发出（Re: 线程头）
//   5. WhatsApp 审核闭环：webhook → 队列 → AI 草稿 → 发送（Evolution 假服务器收到）
//   6. Evolution 扫码/状态路由
//   7. PDF：中文内容 + xref 偏移逐字节验证
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
// CI 健壮性：断言失败 / 未捕获拒绝时立即退出，避免 server 句柄让进程挂起白跑 6 小时
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); process.exit(1); });

const CFG = `${process.env.USERPROFILE}\\.waimao\\config.json`;
const originalRaw = (() => { try { return readFileSync(CFG, 'utf8'); } catch { return ''; } })();
function writeCfg(cfg) { writeFileSync(CFG, JSON.stringify(cfg)); }

/* ================= 假 SMTP 服务器 ================= */
function startSmtp() {
  const state = { messages: [], authFailures: 0 };
  const server = net.createServer((socket) => {
    socket.on('error', () => {}); // 客户端提前断开（如 AUTH 失败后 destroy）不崩进程
    let buffer = '';
    let inData = false;
    let dataBuffer = '';
    const write = (line) => socket.write(`${line}\r\n`);
    write('220 test.local ESMTP waimao-e2e');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          // un-dot-stuffing：行首 .. 还原为 .
          const mime = raw.replace(/(^|\r\n)\.\./g, '$1.');
          state.messages.push(mime);
          write('250 OK queued as E2E001');
          continue;
        }
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) {
          write('250-test.local');
          write('250 AUTH PLAIN LOGIN');
        } else if (cmd.startsWith('AUTH PLAIN')) {
          const b64 = line.slice('AUTH PLAIN '.length).trim();
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          const parts = decoded.split('\u0000');
          if (parts[1] === 'user@a.com' && parts[2] === 'secret') {
            write('235 ok');
          } else {
            state.authFailures += 1;
            write('535 bad credentials');
          }
        } else if (cmd.startsWith('MAIL FROM:')) {
          state.mailFrom = line.slice(10).trim();
          write('250 ok');
        } else if (cmd.startsWith('RCPT TO:')) {
          state.rcptTo = line.slice(8).trim();
          write('250 ok');
        } else if (cmd === 'DATA') {
          inData = true;
          write('354 go ahead');
        } else if (cmd === 'QUIT') {
          write('221 bye');
          socket.end();
        } else {
          write('250 ok');
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

/* ================= 假 IMAP 服务器 ================= */
function startImap({ searchSeqs, fetchPayload }) {
  const state = { commands: [] };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let buffer = '';
    socket.write('* OK IMAP4rev1 ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const tag = line.slice(0, line.indexOf(' '));
        const rest = line.slice(tag.length + 1);
        state.commands.push(rest);
        const upper = rest.toUpperCase();
        if (upper.startsWith('LOGIN')) {
          // 凭据校验（带引号）
          const m = rest.match(/LOGIN "(.+)" "(.+)"/);
          socket.write(`${tag} ${m && m[1] === 'imap@a.com' && m[2] === 'imapsecret' ? 'OK logged in' : 'NO bad credentials'}\r\n`);
        } else if (upper.startsWith('SELECT')) {
          socket.write(`* ${searchSeqs.length + 2} EXISTS\r\n${tag} OK [READ-WRITE] done\r\n`);
        } else if (upper.startsWith('SEARCH')) {
          socket.write(`* SEARCH ${searchSeqs.join(' ')}\r\n${tag} OK done\r\n`);
        } else if (upper.startsWith('FETCH')) {
          socket.write(`* ${fetchPayload}\r\n${tag} OK done\r\n`);
        } else if (upper.startsWith('STORE') || upper.startsWith('MOVE')) {
          socket.write(`${tag} OK done\r\n`);
        } else if (upper.startsWith('LOGOUT')) {
          socket.write(`* BYE\r\n${tag} OK bye\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK\r\n`);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

/* ================= 假 DeepSeek（OpenAI 兼容）服务器 ================= */
function startDeepseek() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let content = '{}';
      try {
        const parsed = JSON.parse(body);
        state.requests.push(parsed);
        const system = parsed.messages?.[0]?.content ?? '';
        if (system.includes('意向评估')) {
          content = JSON.stringify({ score: 5, fit: 'yes', reasons: ['批发商，产品对口'], advice: '直接发目录和FOB' });
        } else if (system.includes('分类买家回复')) {
          content = JSON.stringify({ category: 'interested', summary: '买家想买', suggested_action: '马上发目录' });
        } else if (system.includes('sales rep') || system.includes('vendedor')) {
          content = JSON.stringify({ subject: 'Hair dryers — factory direct', body: 'Hi John,\n\nSaw your work in wholesale distribution. We supply professional hair dryers at factory prices. Want our FOB list?\n\nBest,\nSales' });
        } else if (system.includes('外贸业务员助理')) {
          // WhatsApp 客服草稿：draft.js 期望纯文本正文（非 JSON）
          content = 'Yes, we have professional hair dryers — may I ask your target quantity per order?';
        }
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

/* ================= 假 Evolution API 服务器 ================= */
function startEvolution() {
  const state = { sent: [], media: [], connectHits: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url.includes('/message/sendText/')) {
        const parsed = JSON.parse(body);
        state.sent.push(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: { id: 'EVO1' } }));
      } else if (req.method === 'POST' && url.includes('/message/sendMedia/')) {
        state.media.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: { id: 'EVO2' } }));
      } else if (req.method === 'GET' && url.includes('/instance/connect/')) {
        state.connectHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ qrcode: { base64: 'QkFTRTY0', pairingCode: 'ABCD-EFGH' }, instance: { state: 'connecting' } }));
      } else if (req.method === 'GET' && url.includes('/instance/connectionState/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ instance: { state: 'open' } }));
      } else if (req.method === 'POST' && url.includes('/chat/findChats/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: '551155512345@s.whatsapp.net', name: 'Buyer' }]));
      } else if (req.method === 'POST' && url.includes('/chat/findMessagesByChat/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: { records: [{ key: { id: 'MSG1', remoteJid: '551155512345@s.whatsapp.net', fromMe: false }, pushName: 'Buyer', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'preciso de secador de cabelo' } }] } }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

/* ================= 启动全部假服务器 ================= */
const smtp = await startSmtp();
const deepseek = await startDeepseek();
const evolution = await startEvolution();

// IMAP：两轮不同剧本（先回复，后退订），用可重配的容器
const imapState = { searchSeqs: [1], fetchPayload: '' };
let imapHandle = await startImap(imapState);

/* ================= 配置指向本地服务 ================= */
writeCfg({
  serp: { engine: 'ddg' },
  deepseek: { baseURL: `http://127.0.0.1:${deepseek.port}`, apiKey: 'test-key', model: 'test' },
  smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'user@a.com', pass: 'secret', from: 'sales@mycompany.test', fromName: 'Sales', dryRun: false, dailyCap: 0, sendWindow: false },
  imap: { host: '127.0.0.1', port: imapHandle.port, secure: false, user: 'imap@a.com', pass: 'imapsecret', mailbox: 'INBOX' },
  evolution: { baseURL: `http://127.0.0.1:${evolution.port}`, apiKey: 'evo-key', instance: 'e2e' },
  webhookToken: 'e2e-token',
  cron: { enabled: true, sequenceCheckEveryMin: 60 },
  wa: { dryRun: false, dailyBroadcastCap: 200, minDelaySec: 0, maxDelaySec: 0 },
});

const crmMod = (await import('../dsh/crm.js'));
const suppressMod = (await import('../dsh/suppress.js'));
const auditMod = (await import('../dsh/audit.js'));

// 清理旧 e2e 数据 + 注册测试线索
function cleanupE2e() {
  const storePath = crmMod.storeFile();
  const db = JSON.parse(readFileSync(storePath, 'utf8'));
  db.leads = db.leads.filter((l) => !String(l.domain ?? '').endsWith('e2e.test'));
  writeFileSync(storePath, JSON.stringify(db));
  for (const file of ['suppress.json', 'domain-blacklist.json']) {
    try {
      const p = `${process.env.USERPROFILE}\\.waimao\\data\\${file}`;
      const list = JSON.parse(readFileSync(p, 'utf8'));
      const filtered = Array.isArray(list) ? list.filter((item) => !(item.email ?? item.domain ?? '').includes('e2e.test')) : list;
      writeFileSync(p, JSON.stringify(filtered));
    } catch {}
  }
}
cleanupE2e();

function e2eLead(name, email) {
  const { lead } = crmMod.upsertLead({
    company: name, url: `https://${name.toLowerCase().replace(/\W/g, '')}.e2e.test`, market: 'us',
    source: `https://${name.toLowerCase().replace(/\W/g, '')}.e2e.test`,
    contacts: { emails: [email], whatsapps: [], phones: [], socials: {} },
    score: 9, tier: '高', fit: 'yes', advice: '测试线索',
  });
  return lead;
}

/* ================= 加载插件（注册工具+路由） ================= */
const plugin = await import('../dsh/index.js');
const tools = new Map();
const routes = new Map();
plugin.apply({
  tools: { register: (d) => tools.set(d.name, d) },
  inject: (names, fn) => fn({ webServer: { register: (r) => routes.set(r.path, r) } }),
});

function fakeReq(method, body, headers = { host: '127.0.0.1:3080' }) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  let i = 0;
  return {
    method, headers, url: '/x',
    headersSent: false,
    on(event, cb) {
      if (event === 'data' && i < chunks.length) cb(chunks[i++]);
      if (event === 'end') cb();
    },
  };
}
function fakeRes() {
  return {
    statusCode: 0, headers: null, body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; return this; },
    end(payload) { this.body = payload ?? ''; return this; },
    writeHeadJson: null,
    destroy() {},
  };
}

/* ================= 1. SMTP 原始客户端 ================= */
const { sendMail } = await import('../dsh/mail/smtp.js');
await sendMail({ host: '127.0.0.1', port: smtp.port, secure: false, user: 'user@a.com', pass: 'secret', from: 'sales@mycompany.test' }, {
  from: 'sales@mycompany.test', to: 'raw@test.example', subject: '中文主题测试',
  body: 'line one\n..starts with dot\nline three',
});
assert.equal(smtp.state.messages.length, 1);
const rawMime = smtp.state.messages[0];
assert.ok(rawMime.includes('To: raw@test.example'));
assert.ok(rawMime.includes('=?UTF-8?B?'), '中文主题应 RFC2047 编码');
// 正文是 base64：解码后应还原原文（含行首点行）；base64 字符集不含 '.'，
// dot-stuffing 对 base64 流是恒等操作，但传输层仍必须正确处理行首点
const bodyB64 = rawMime.split(/Content-Transfer-Encoding: base64\r\n\r\n/)[1]?.split(/\r\n--/)[0]?.replace(/\r\n/g, '') ?? '';
assert.ok(bodyB64.length > 0, '应能提取 base64 正文');
assert.ok(Buffer.from(bodyB64, 'base64').toString('utf8').includes('..starts with dot'), 'base64 正文解码还原原文');
const subjectB64 = rawMime.match(/Subject: =\?UTF-8\?B\?(.+)\?=/)[1];
assert.equal(Buffer.from(subjectB64, 'base64').toString('utf8'), '中文主题测试');
// AUTH 失败路径
await assert.rejects(() => sendMail({ host: '127.0.0.1', port: smtp.port, secure: false, user: 'user@a.com', pass: 'WRONG', from: 'sales@mycompany.test' }, { from: 'sales@mycompany.test', to: 'x@y.z', subject: 'a', body: 'b' }), /535/);
console.log('1. SMTP 原始客户端（握手/AUTH/DATA/中文/dot-stuffing）OK');

/* ================= 2. 冷邮件审批门 + 网页发送 + SOP 全流程闭环 ================= */
const lead1 = e2eLead('E2E Buyer One', 'buyer1@e2e.test');
// 2a) 智能体直发首触冷邮件 → 默认拒绝
await assert.rejects(
  () => tools.get('email_send').execute({ lead_id: lead1.id, subject: 'Hello {A|B} buyer', body: 'Cold pitch. Reply STOP to opt out.' }),
  /首触冷邮件/,
);
// 2b) 网页人工发送（actor=user）放行，spintax 生效，CRM 变 contacted
const webSendRes = fakeRes();
await routes.get('/waimao/api/crm/send-email').handler(
  fakeReq('POST', { id: lead1.id, subject: 'Hello {A|B} buyer', body: 'We supply hair dryers.\nReply STOP to opt out.' }),
  webSendRes,
);
const webSent = JSON.parse(webSendRes.body);
assert.equal(webSent.dryRun, false, `网页发送应真实发出: ${webSendRes.body}`);
const webMime = smtp.state.messages.at(-1);
assert.ok(webMime.includes('<buyer1@e2e.test>'), `收件人应在 To 头: ${webMime.slice(0, 200)}`);
const webMimeSubject = webMime.match(/Subject: (.*)\r\n/)?.[1] ?? '';
assert.ok(
  ['Hello A buyer', 'Hello B buyer'].some((s) => webMimeSubject === s || webMimeSubject === `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`),
  `spintax 应生效，实际 Subject: ${webMimeSubject}`,
);
assert.equal(crmMod.getLead(lead1.id).status, 'contacted', '发送后 CRM 变 contacted');
assert.ok(auditMod.queryAudit({ action: 'email.send', limit: 10 }).some((e) => e.detail?.to === 'buyer1@e2e.test'), '审计落盘');
// 抑制列表拦截
suppressMod.suppress('buyer1@e2e.test', 'manual', 'e2e');
await assert.rejects(() => tools.get('email_send').execute({ lead_id: lead1.id, subject: 'x', body: 'y' }), /抑制列表/);
suppressMod.unsuppress('buyer1@e2e.test', 'e2e');
// 域名黑名单拦截
suppressMod.blacklistDomain('e2e.test', 'hard-bounce', 'e2e');
await assert.rejects(() => tools.get('email_send').execute({ lead_id: lead1.id, subject: 'x', body: 'y' }), /黑名单/);
const blPath = `${process.env.USERPROFILE}\\.waimao\\data\\domain-blacklist.json`;
const blList = JSON.parse(readFileSync(blPath, 'utf8'));
writeFileSync(blPath, JSON.stringify(blList.filter((d) => d.domain !== 'e2e.test')));
// 空邮件拒绝
await assert.rejects(() => tools.get('email_send').execute({ lead_id: lead1.id, subject: '', body: '' }), /空邮件/);

// 2c) SOP 八阶段全流程（审批后的冷邮件放行，且以批准稿内容为准）
await tools.get('template_save').execute({ name: 'e2e-tpl', language: 'en', subject: 'SOP offer {A|B} for you', body: 'Approved draft body. Reply STOP to opt out.' });
const taskCreated = await tools.get('sop_create').execute({ goal: 'e2e sop goal' });
const taskId = taskCreated.id;
await tools.get('sop_next').execute({ task_id: taskId, product: 'hair dryers', market: 'us' });
await tools.get('sop_next').execute({ task_id: taskId, run_id: 'fake-run' });
await tools.get('sop_next').execute({ task_id: taskId, lead_ids: [lead1.id] });
await tools.get('sop_next').execute({ task_id: taskId });
const composed = await tools.get('email_compose').execute({ lead_id: lead1.id, task_id: taskId, template: 'e2e-tpl' });
assert.ok(composed.draftId, '草稿应挂到 SOP 任务');
await tools.get('sop_next').execute({ task_id: taskId }); // draft → approval
// 未批准就发 → 拒绝
const review = await tools.get('sop_review').execute({ task_id: taskId });
assert.equal(review.stage, 'approval');
assert.ok(review.drafts.length >= 1);
const draftId = review.drafts[0].id;
await assert.rejects(
  () => tools.get('email_send').execute({ lead_id: lead1.id, subject: 'x', body: 'y', task_id: taskId, draft_id: draftId }),
  /未批准|哈希/,
);
// 逐封批准
for (const d of review.drafts) {
  await tools.get('sop_approve').execute({ task_id: taskId, draft_id: d.id, approve: true });
}
await tools.get('sop_next').execute({ task_id: taskId }); // approval → outreach
// 批准后发送：内容以批准稿为准（参数里的 subject/body 被忽略）
const mimeBody = (mime) => {
  const b64 = mime.split(/Content-Transfer-Encoding: base64\r\n\r\n/)[1]?.split(/\r\n--/)[0]?.replace(/\r\n/g, '') ?? '';
  return Buffer.from(b64, 'base64').toString('utf8');
};
const mimeSubject = (mime) => mime.match(/Subject: (?:=\?UTF-8\?B\?(.+?)\?=|(.*))\r\n/)?.[2] ?? Buffer.from(mime.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/)?.[1] ?? '', 'base64').toString('utf8');
const beforeSopSend = smtp.state.messages.length;
const sopSent = await tools.get('email_send').execute({ lead_id: lead1.id, subject: 'IGNORED', body: 'IGNORED', task_id: taskId, draft_id: draftId });
assert.equal(sopSent.dryRun, false);
const sopMime = smtp.state.messages.at(-1);
assert.ok(mimeBody(sopMime).includes('Approved draft body'), '应发送批准稿正文而非参数内容');
assert.ok(!mimeBody(sopMime).includes('IGNORED') && !sopMime.includes('IGNORED'), '参数内容应被忽略');
assert.ok(['SOP offer A for you', 'SOP offer B for you'].includes(mimeSubject(sopMime)), `批准稿主题+spintax，实际: ${mimeSubject(sopMime)}`);
// SOP 触达记录回写
const taskStatus = await tools.get('sop_status').execute({ task_id: taskId });
assert.equal(taskStatus.outreach.length, 1, 'recordOutreach 应回写触达记录');
await tools.get('sop_next').execute({ task_id: taskId }); // outreach → close
await tools.get('sop_next').execute({ task_id: taskId }); // close → 生成结案报告
const closed = await tools.get('sop_status').execute({ task_id: taskId });
assert.equal(closed.report.outreach, 1, '结案报告触达数');
assert.equal(closed.report.approved, closed.report.drafts, '结案报告批准数');
console.log('2. 冷邮件审批门 + 网页发送 + SOP 八阶段闭环 OK');

/* ================= 3. IMAP 回复扫描闭环 ================= */
const lead2 = e2eLead('E2E Buyer Two', 'buyer2@e2e.test');
crmMod.updateLead(lead2.id, { status: 'contacted' });
const leadStop = e2eLead('E2E Buyer Stop', 'stopper@e2e.test');
crmMod.updateLead(leadStop.id, { status: 'contacted' });
// 序列挂上（验证回复自动停序列）
const { newSequence } = await import('../dsh/mail/sequence.js');
const seqForReply = newSequence({ language: 'en' });
seqForReply.steps[0].status = 'sent';
crmMod.updateLead(lead2.id, { sequence: seqForReply });

// QP 编码的中文正文 + 带括号 From
// QP 编码中文正文（按 UTF-8 字节逐个转 =XX）
function qpEncode(text) {
  return [...Buffer.from(text, 'utf8')].map((byte) => {
    const ch = String.fromCharCode(byte);
    return (byte > 126 || byte < 32 || ch === '=') ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : ch;
  }).join('');
}
function buildFetchPayload(from, messageId, subject, qpText) {
  const headers = `Message-ID: ${messageId}\r\nFrom: ${from}\r\nSubject: ${subject}\r\nDate: Wed, 26 Aug 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n`;
  const text = qpText;
  return `* 1 FETCH (BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES SUBJECT FROM DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] {${Buffer.byteLength(headers)}}\r\n${headers}\r\n BODY[TEXT]<0> {${Buffer.byteLength(text)}}\r\n${text})`;
}
imapState.fetchPayload = buildFetchPayload('"Buyer Two (Trading Co.)" <buyer2@e2e.test>', '<reply-1@e2e.test>', 'Re: offer', qpEncode('We reviewed your proposal and have a question about the material grade.'));
imapHandle.server.close();
imapHandle = await startImap(imapState);
writeCfg(JSON.parse(readFileSync(CFG, 'utf8'))); // 刷新（imap 端口变了）
const cfgNow = JSON.parse(readFileSync(CFG, 'utf8'));
cfgNow.imap.port = imapHandle.port;
writeCfg(cfgNow);

const scan1 = await tools.get('email_scan_replies').execute({ use_ai: true });
const reply2 = scan1.replies.find((r) => r.from === 'buyer2@e2e.test');
assert.ok(reply2, '应扫到 buyer2 的回复');
assert.equal(reply2.category, 'interested', `AI 分类应 interested，实际 ${reply2.category}`);
assert.equal(reply2.summary, '买家想买', 'AI 摘要落库（模糊正文走 AI 路径）');
assert.equal(crmMod.getLead(lead2.id).status, 'replied', '回复后 CRM 变 replied');
assert.equal(crmMod.getLead(lead2.id).sequence.steps.filter((s) => s.status === 'pending').length, 0, '回复后序列全停');
assert.equal(crmMod.getLead(lead2.id).lastReply.summary, '买家想买', 'AI 摘要落库');
const fetched = imapHandle.state.commands.find((c) => c.toUpperCase().startsWith('FETCH'));
assert.ok(fetched, '应发起 FETCH');
assert.ok(imapHandle.state.commands.some((c) => /SINCE \d{2}-[A-Z][a-z]{2}-\d{4}/.test(c)), 'SINCE 应为 DD-Mon-YYYY 格式');

// STOP 退订（规则层，不调 AI）
imapState.fetchPayload = buildFetchPayload('stopper@e2e.test', '<reply-2@e2e.test>', 'Re: offer', 'STOP');
imapHandle.server.close();
imapHandle = await startImap(imapState);
const cfgNow2 = JSON.parse(readFileSync(CFG, 'utf8'));
cfgNow2.imap.port = imapHandle.port;
writeCfg(cfgNow2);
const scan2 = await tools.get('email_scan_replies').execute({ use_ai: false });
const replyStop = scan2.replies.find((r) => r.from === 'stopper@e2e.test');
assert.ok(replyStop && replyStop.category === 'unsubscribe', 'STOP 应判退订');
assert.ok(suppressMod.isSuppressed('stopper@e2e.test'), '退订自动进抑制列表');
console.log('3. IMAP 回复扫描闭环（字面量/QP中文/AI分类/停序列/STOP退订抑制）OK');

/* ================= 4. 跟进序列到期真实发送 ================= */
const lead3 = e2eLead('E2E Buyer Three', 'buyer3@e2e.test');
const started = await tools.get('email_sequence_start').execute({ lead_id: lead3.id });
assert.equal(started.started, 1);
const lead3b = crmMod.getLead(lead3.id);
assert.ok(lead3b.sequence.steps.every((s) => s.subject && s.body), '启动时四步内容全非空');
// 时间回拨 8 天 → Day0/3/7 三步到期
const db = JSON.parse(readFileSync(crmMod.storeFile(), 'utf8'));
const seqLead = db.leads.find((l) => l.id === lead3.id);
seqLead.sequence.startedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
writeFileSync(crmMod.storeFile(), JSON.stringify(db));
const beforeCount = smtp.state.messages.length;
const cronMod = (await import('../dsh/cron.js'));
const seqResult = await cronMod.runOnce('sequence');
const followUps = smtp.state.messages.slice(beforeCount);
assert.equal(followUps.length, 3, `Day0/3/7 应各发一封，实际 ${followUps.length}`);
assert.ok(followUps.every((m) => m.includes('<buyer3@e2e.test>')));
// 跟进挂原线程（Re: subject0）
// 跟进挂原线程（Re: subject0；主题含非 ASCII 时是 RFC2047 编码，解码后断言）
assert.ok(followUps.slice(1).every((m) => mimeSubject(m).startsWith('Re: ')), `Day3/7 主题应带 Re:，实际: ${followUps.slice(1).map(mimeSubject).join(' | ')}`);
const lead3c = crmMod.getLead(lead3.id);
assert.equal(lead3c.status, 'contacted');
assert.equal(lead3c.sequence.steps.filter((s) => s.status === 'sent').length, 3, '三步标记 sent');
assert.equal(lead3c.sequence.steps[3].status, 'pending', 'Day14 未到期保持 pending');
console.log('4. 跟进序列到期真实发送（三步/Re:线程/状态标记）OK');

/* ================= 5. WhatsApp 审核闭环（webhook→队列→AI草稿→发送） ================= */
const waJid = `5511${String(Date.now()).slice(-8)}@s.whatsapp.net`;
const waMsgId = `WA1-${Date.now().toString(36)}`;
const webhook = routes.get('/waimao/webhook/evolution');
const hookBody = {
  event: 'messages.upsert',
  data: { key: { id: waMsgId, remoteJid: waJid, fromMe: false }, pushName: 'Buyer BR', messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'Do you have professional hair dryers?' } },
};
const hookReq = fakeReq('POST', hookBody, { host: '127.0.0.1:3080', 'x-webhook-token': 'e2e-token' });
const hookRes = fakeRes();
await webhook.handler(hookReq, hookRes);
assert.equal(hookRes.statusCode, 200);
// 队列应包含我们的消息（注意：该路由返回裸数组）
const queueRes = fakeRes();
await routes.get('/waimao/api/review/queue').handler(fakeReq('GET'), queueRes);
const queueRaw = JSON.parse(queueRes.body);
const queue = Array.isArray(queueRaw) ? queueRaw : queueRaw.items;
const waMsg = queue.find((m) => m.id === waMsgId);
assert.ok(waMsg, 'webhook 消息进队列');
assert.equal(waMsg.text, 'Do you have professional hair dryers?');
// AI 草稿（走本地 DeepSeek）
const draftRes = fakeRes();
await routes.get('/waimao/api/review/draft').handler(fakeReq('POST', { id: waMsg.id }), draftRes);
const draft = JSON.parse(draftRes.body);
assert.ok(draft.draft && draft.draft.length > 10, `AI 草稿应生成: ${draft.draft}`);
// 审核发送（走本地 Evolution）
const sendRes = fakeRes();
await routes.get('/waimao/api/review/send').handler(fakeReq('POST', { id: waMsg.id, text: 'Yes! We have the full range.' }), sendRes);
const sendParsed = JSON.parse(sendRes.body);
assert.equal(sendParsed.status, 'sent', `发送路由返回: ${sendRes.body}`);
assert.equal(evolution.state.sent.length, 1);
assert.equal(evolution.state.sent[0].number, waJid.split('@')[0]);
assert.equal(evolution.state.sent[0].text, 'Yes! We have the full range.');
// webhook 无 token 拒绝
const badHook = fakeRes();
await webhook.handler(fakeReq('POST', hookBody, { host: '127.0.0.1:3080' }), badHook);
assert.equal(badHook.statusCode, 403);
console.log('5. WhatsApp 审核闭环（webhook围栏/队列/AI草稿/真实发送）OK');

/* ================= 6. Evolution 扫码/状态/发媒体 ================= */
const connectRes = fakeRes();
await routes.get('/waimao/api/evolution/connect').handler(fakeReq('POST'), connectRes);
const connect = JSON.parse(connectRes.body);
assert.equal(connect.connected, false);
assert.equal(connect.qrcodeBase64, 'QkFTRTY0');
assert.equal(connect.pairingCode, 'ABCD-EFGH');
const stateRes = fakeRes();
await routes.get('/waimao/api/evolution/state').handler(fakeReq('GET'), stateRes);
assert.equal(JSON.parse(stateRes.body).connected, true);
await tools.get('wa_send_media').execute({ number: waJid, media: 'JVBERi0=', mediatype: 'document', filename: 'quote.pdf' });
assert.equal(evolution.state.media.length, 1);
assert.equal(evolution.state.media[0].media, 'JVBERi0=', 'v2 扁平格式 media 字段');
assert.equal(evolution.state.media[0].fileName, 'quote.pdf');
assert.equal(evolution.state.media[0].number, waJid.split('@')[0]);
console.log('6. Evolution 扫码/状态/发媒体（v2格式）OK');

/* ================= 7. PDF 结构逐字节验证（含中文→?替换） ================= */
const pdfMod = await import('../dsh/pdf.js');
const pdfBuf = pdfMod.quotePdf({
  quoteNo: 'QE2E', from: { company: '我的公司 My Co', email: 's@x.y' }, to: { company: 'Buyer', country: 'US' },
  items: [{ desc: 'Hair dryer 2000W', qty: 1000, unitPrice: 8.5 }], payment: 'T/T 30%', notes: '备注测试',
});
const latin = pdfBuf.toString('latin1');
assert.ok(latin.startsWith('%PDF-1.4'));
assert.ok(latin.endsWith('%%EOF'));
const startxref = Number(latin.match(/startxref\n(\d+)\n%%EOF$/)[1]);
assert.ok(latin.slice(startxref).startsWith('xref'), 'startxref 应指向 xref 表');
// 每个 xref 条目偏移都要指向对应的 "N 0 obj"
const xrefBlock = latin.slice(startxref, latin.indexOf('trailer'));
const entries = [...xrefBlock.matchAll(/^(\d{10}) 00000 n $/gm)];
assert.ok(entries.length >= 5, `xref 应有对象条目，实际 ${entries.length}`);
entries.forEach((m, i) => {
  const offset = Number(m[1]);
  assert.ok(latin.slice(offset).startsWith(`${i + 1} 0 obj`), `对象 ${i + 1} 的 xref 偏移正确`);
});
assert.ok(!/[\u0080-\uFFFF]/.test(latin), 'PDF 内容流不应含非 ASCII（中文已替换）');
const piBuf = pdfMod.proformaPdf({ piNo: 'PIE2E', items: [{ desc: 'x', hsCode: '8516', qty: 1, unitPrice: 2 }], bank: { name: 'Bank of Test', account: '123' } });
assert.ok(piBuf.toString('latin1').includes('PROFORMA INVOICE'));
console.log('7. PDF 结构（xref逐字节/中文替换/PI）OK');

/* ================= 8. dailyCap 闸门（动态额度，放最后） ================= */
const lead4 = e2eLead('E2E Buyer Four', 'buyer4@e2e.test');
const sentToday = auditMod.countRealSends(auditMod.queryAudit({ action: 'email.send', since: auditMod.startOfLocalDay(), limit: 5000 }));
const cfgCap = JSON.parse(readFileSync(CFG, 'utf8'));
cfgCap.smtp.dailyCap = sentToday + 1;
cfgCap.smtp.allowColdSendWithoutApproval = true; // 本段只测容量闸门，冷邮件门先豁免
writeCfg(cfgCap);
await tools.get('email_send').execute({ lead_id: lead4.id, subject: 'within cap', body: 'ok' });
await assert.rejects(() => tools.get('email_send').execute({ lead_id: lead4.id, subject: 'over cap', body: 'no' }), /全局上限/);
console.log('8. dailyCap 全局闸门 OK');

/* ================= 9. 邮箱预热池全流程（互发+自动回复+标星+救垃圾箱） ================= */
{
  // 假 IMAP 的 FETCH 剧本换成预热主题（engage 靠 WARMUP_TAG 识别预热邮件）
  imapState.fetchPayload = buildFetchPayload('sales@mycompany.test', '<warmup-1@mycompany.test>', '[waimao-warmup] e2e Quick hello', qpEncode('Quick hello between our inboxes.'));
  imapHandle.server.close();
  imapHandle = await startImap(imapState);
  const cfgWarm = JSON.parse(readFileSync(CFG, 'utf8'));
  cfgWarm.warmup = { enabled: true, maxPerDay: 30 };
  cfgWarm.imap.port = imapHandle.port;
  // 池 = 主账号 + 一个伙伴账号（SMTP/IMAP 都指向本地假服务器）
  cfgWarm.smtp.accounts = [{
    host: '127.0.0.1', port: smtp.port, secure: false, user: 'user@a.com', pass: 'secret',
    from: 'partner@mycompany.test', fromName: 'Partner',
    imapHost: '127.0.0.1', imapPort: imapHandle.port, imapSecure: false, imapUser: 'imap@a.com', imapPass: 'imapsecret',
  }];
  writeCfg(cfgWarm);

  const beforeWarm = smtp.state.messages.length;
  const warmResult = await tools.get('warmup_status').execute({ action: 'run' });
  assert.ok(!warmResult.skipped, `预热应执行: ${JSON.stringify(warmResult).slice(0, 200)}`);
  const poolLegs = warmResult.results.filter((r) => r.leg === 'pool' && r.ok);
  assert.equal(poolLegs.length, 2, `两个邮箱应互发（2 条腿），实际 ${poolLegs.length}`);
  const warmMimes = smtp.state.messages.slice(beforeWarm);
  assert.ok(warmMimes.every((m) => m.includes('[waimao-warmup]')), '预热邮件应带标签');
  // 收件侧互动：自动回复 + 救垃圾箱
  const engage = warmResult.results.filter((r) => r.leg === 'engage');
  assert.ok(engage.length >= 1, '至少一个收件方执行了互动');
  assert.ok(engage.every((e) => e.replied === true), `应自动回复: ${JSON.stringify(engage)}`);
  assert.ok(engage.every((e) => e.rescued >= 1), `应从垃圾箱挪回: ${JSON.stringify(engage)}`);
  // 自动回复是真实 SMTP 发送（互动腿）
  assert.ok(smtp.state.messages.slice(beforeWarm).some((m) => m.includes('Got it')), '自动回复应真实发出');
  const warmAudits = auditMod.queryAudit({ action: 'email.warmup', limit: 10 });
  assert.ok(warmAudits.length >= 2, '预热发送应进审计');
  // 当日 latch：同天再跑应跳过
  const second = await tools.get('warmup_status').execute({ action: 'run' });
  assert.ok(second.skipped, '同一天重复跑应跳过');
  console.log('9. 邮箱预热池全流程（配对互发/自动回复/标星/救垃圾箱/当日latch）OK');
}

/* ================= 清理 ================= */
imapHandle.server.close();
smtp.server.close();
deepseek.server.close();
evolution.server.close();
cleanupE2e();
if (originalRaw) {
  writeCfg(JSON.parse(originalRaw.replace(/^\uFEFF/, '')));
} else {
  try { require('node:fs').unlinkSync(CFG); } catch {}
}
console.log('ALL E2E LOCAL-SIMULATION TESTS PASSED');
// 强制退出：仿真 server 已 .close()，但 keep-alive 连接会维持事件循环，导致 node 进程不退出
process.exit(0);
