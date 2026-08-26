// 邮箱发现 + 验证（hunter.io 开源平替思路）：
//  1) 模式猜测：name + domain → first@ / first.last@ / flast@ ... 35+ 模式里的常用子集
//  2) DNS：A/MX 记录检查
//  3) SMTP RCPT TO 探测：MAIL FROM 本机身份 → RCPT TO 目标，250=存在，
//     550/551/553=不存在；任何域名都 250 → catch-all（结果不可信，标注）
//  4) 全流程超时保护；25 端口常见被封（云主机/家宽），失败标注 skipped
import net from 'node:net';
import tls from 'node:tls';
import { promises as dns } from 'node:dns';

// 姓名模式 20 个 + 角色地址 15 个 = 35+ 候选（hunter.io 常用模式子集）
const PATTERNS = [
  (f, l) => `${f}`,              // john
  (f, l) => `${f}.${l}`,         // john.smith
  (f, l) => `${f}${l}`,          // johnsmith
  (f, l) => `${f[0]}${l}`,       // jsmith
  (f, l) => `${f[0]}.${l}`,      // j.smith
  (f, l) => `${f}_${l}`,         // john_smith
  (f, l) => `${f}-${l}`,         // john-smith
  (f, l) => `${f}${l[0] ?? ''}`, // johns
  (f, l) => `${f}.${l[0] ?? ''}`,// john.s
  (f, l) => `${l}`,              // smith
  (f, l) => `${l}.${f}`,         // smith.john
  (f, l) => `${l}${f}`,          // smithjohn
  (f, l) => `${l[0]}${f}`,       // sjohn
  (f, l) => `${l}.${f[0] ?? ''}`,// smith.j
  (f, l) => `${l}_${f}`,         // smith_john
  (f, l) => `${l}-${f}`,         // smith-john
  (f, l) => `${f[0]}${l[0] ?? ''}`,   // js
  (f, l) => `${f[0]}.${l[0] ?? ''}`,  // j.s
  (f, l) => `${f}${l[0] ?? ''}${f[0]}`, // johnsj (少见但存在)
  (f, l) => `${l}${f[0] ?? ''}.${f}`,   // sj.john
];

export function guessEmails({ name, domain }) {
  const cleanDomain = String(domain ?? '').toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '');
  if (!cleanDomain || !cleanDomain.includes('.')) {
    return [];
  }
  const role = ['info', 'sales', 'contact', 'purchasing', 'sourcing', 'import', 'export', 'buy', 'buyer', 'hello', 'office', 'trade', 'admin', 'support', 'marketing'];
  if (!name || !String(name).trim()) {
    return [...role.map((r) => `${r}@${cleanDomain}`)];
  }
  const parts = String(name).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const first = (parts[0] ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const last = (parts[parts.length - 1] ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const guessed = first ? PATTERNS.map((fn) => fn(first, last || first[0])) : [];
  // 姓名模式与 role 账号穿插（2:1）：默认 limit=6 截断时 purchasing@ 这类
  // 外贸关键角色地址也能轮到，不会被 20 个姓名模式挤到永远探不到
  const merged = [];
  let gi = 0;
  let ri = 0;
  while (gi < guessed.length || ri < role.length) {
    for (let k = 0; k < 2 && gi < guessed.length; k += 1) {
      merged.push(guessed[gi]);
      gi += 1;
    }
    if (ri < role.length) {
      merged.push(role[ri]);
      ri += 1;
    }
  }
  return [...new Set(merged)].map((local) => `${local}@${cleanDomain}`);
}

async function dnsCheck(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    return { hasMx: mx.length > 0, mx: mx.sort((a, b) => a.priority - b.priority) };
  } catch {
    try {
      await dns.resolve(domain);
      return { hasMx: false, mx: [] };
    } catch {
      return { hasMx: false, mx: [], noDns: true };
    }
  }
}

/** 极简 SMTP 会话：返回 {code, message}。stepTimeout 毫秒/步。 */
function smtpCommand(socket, expected, command, stepTimeout = 15_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP timeout'));
    }, stepTimeout);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      // 多行回复以 "250-" 续行；只有 "250 "（空格）才是终止行。
      // 在续行就提前返回会与服务器剩余输出交错，后续回包全部错位。
      // 取最后一个终止行（缓冲里可能已有整条回复）
      const completeLines = lines.slice(0, -1);
      const finalLine = [...completeLines].reverse().find((line) => /^\d{3} /.test(line));
      if (finalLine) {
        cleanup();
        resolve({ code: Number(finalLine.slice(0, 3)), message: buffer.trim() });
      }
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
    }
    socket.on('data', onData);
    socket.once('error', (error) => {
      cleanup();
      reject(error);
    });
    if (command !== undefined) {
      socket.write(`${command}\r\n`);
    }
  });
}

function connect(host, port, secure, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error(`connect timeout ${host}:${port}`));
    });
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => resolve(tlsSocket));
    tlsSocket.once('error', reject);
  });
}

async function withSmtp(mxHost, fromEmail, handler, { securePort, starttls }) {
  let socket = await connect(mxHost, securePort ?? 25, securePort === 465);
  try {
    // 地址字面量作 HELO 名，所有服务器都接受；裸域名 waimao.local 反而可疑
    const ehlo = async (name = '[127.0.0.1]') => {
      const res = await smtpCommand(socket, [250], `EHLO ${name}`);
      return res.message;
    };
    if (starttls) {
      await smtpCommand(socket, [220], 'STARTTLS');
      socket = await upgradeTls(socket, mxHost);
      await ehlo();
    } else {
      await ehlo();
    }
    return await handler(socket, ehlo);
  } finally {
    try {
      socket.write('QUIT\r\n');
    } catch {}
    socket.destroy();
  }
}

/** RCPT 结果分类：accepted=存在 / rejected=确定不存在 / temporary=灰名单限流，不可下结论。 */
export function classifyRcpt(code) {
  if (code === 250 || code === 251) {
    return 'accepted';
  }
  if (code >= 500) {
    return 'rejected';
  }
  if (code >= 400) {
    return 'temporary';
  }
  return 'unexpected';
}

/**
 * 验证单个邮箱。结果：
 *  valid / invalid / catch-all / unverifiable(25端口不可达、4xx临时失败等) / no-mx / no-dns
 */
export async function verifyEmail(email, opts = {}) {
  const domain = email.split('@')[1];
  if (!domain) {
    return { email, status: 'invalid', reason: 'no domain' };
  }
  const dnsResult = await dnsCheck(domain);
  if (dnsResult.noDns) {
    return { email, status: 'no-dns', reason: 'domain does not resolve' };
  }
  if (!dnsResult.hasMx) {
    return { email, status: 'no-mx', reason: 'no MX record (cannot receive mail)' };
  }
  const mxHost = dnsResult.mx[0]?.exchange;
  if (!mxHost) {
    return { email, status: 'no-mx', reason: 'empty MX' };
  }
  // 默认用空发件人 <>：探测用途下被普遍接受；.local 假域常被直接拒
  const fromEmail = opts.fromEmail ?? '';
  const mailFrom = fromEmail ? `<${fromEmail}>` : '<>';
  const ports = opts.port ? [opts.port] : [25, 587];
  let lastError = null;
  for (const port of ports) {
    try {
      return await withSmtp(
        mxHost,
        fromEmail,
        async (socket) => {
          const mail = await smtpCommand(socket, [250], `MAIL FROM:${mailFrom}`);
          if (Math.floor(mail.code / 100) !== 2) {
            return { email, status: 'unverifiable', reason: `MAIL FROM rejected (${mail.code}) — 无法探测`, mx: mxHost };
          }
          const rcpt = await smtpCommand(socket, [250, 251, 550, 551, 553, 554], `RCPT TO:<${email}>`);
          const verdict = classifyRcpt(rcpt.code);
          if (verdict === 'accepted') {
            // 再探一个几乎必然不存在的地址判断 catch-all
            const probe = await smtpCommand(socket, [250, 251, 550, 551, 553, 554], `RCPT TO:<no-such-user-${Date.now()}@${domain}>`);
            if (classifyRcpt(probe.code) === 'accepted') {
              return { email, status: 'catch-all', reason: 'server accepts any address (result unreliable)', mx: mxHost };
            }
            return { email, status: 'valid', reason: rcpt.message.split('\n').pop(), mx: mxHost };
          }
          if (verdict === 'temporary') {
            // 灰名单/限流：4xx 说明服务器暂时不表态，判成 invalid 会误杀真实线索
            return { email, status: 'unverifiable', reason: `temporary failure (${rcpt.code})，稍后可重试`, mx: mxHost };
          }
          return { email, status: 'invalid', reason: (rcpt.message.split('\n').pop() ?? '').slice(0, 120), mx: mxHost };
        },
        { securePort: port === 465 ? 465 : undefined, starttls: port === 587 },
      );
    } catch (error) {
      lastError = error;
    }
  }
  return {
    email,
    status: 'unverifiable',
    reason: `SMTP probe failed (${String(lastError?.message ?? lastError).slice(0, 100)}) — 25端口常被封，属正常情况`,
    mx: mxHost,
  };
}

const STATUS_RANK = { valid: 0, 'catch-all': 1, unverifiable: 2, 'no-mx': 3, 'no-dns': 4, invalid: 5 };

/** 猜测并验证：返回按优先级排序的候选列表（valid 最前）。 */
export async function findEmail({ name, domain, verify = true, fromEmail, limit = 6, signal } = {}) {
  const candidates = guessEmails({ name, domain }).slice(0, Math.max(limit, 1));
  if (!verify || candidates.length === 0) {
    return { domain, candidates: candidates.map((email) => ({ email, status: 'guessed' })), best: candidates[0] ?? null };
  }
  const results = [];
  for (const email of candidates) {
    if (signal?.aborted) {
      break;
    }
    const result = await verifyEmail(email, { fromEmail });
    results.push(result);
    if (result.status === 'valid') {
      break; // 找到有效即停，省时省额度
    }
  }
  results.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  return { domain, candidates: results, best: results[0]?.status === 'valid' ? results[0].email : null };
}

export const __internals = { smtpCommand, PATTERNS };
