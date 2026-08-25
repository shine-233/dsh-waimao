// 零依赖 IMAP 客户端（够用版）：TLS 连接、LOGIN、SELECT、SEARCH、FETCH。
// 支持 IMAP 字面量 {N} 分块读取。只做回复检测需要的部分，不做完整解析。
import tls from 'node:tls';
import net from 'node:net';

function connect(host, port, secure, timeout = 25_000) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IMAP connect timeout ${host}:${port}`));
    }, timeout);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 带字面量感知的 IMAP 会话。 */
class ImapSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.tagCounter = 0;
    this.pending = null; // {resolve, reject}
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      if (this.pending) {
        const { reject } = this.pending;
        this.pending = null;
        reject(error);
      }
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    if (!this.pending) {
      return;
    }
    this.#tryResolve();
  }

  /**
   * 尝试从 buffer 里解析完整响应（含字面量）。
   * 命令完成标志：出现以当前 tag 开头的行。
   */
  #tryResolve() {
    const { tag, resolve, reject } = this.pending;
    let searchFrom = 0;
    for (;;) {
      const literalMatch = this.buffer.slice(searchFrom).match(/\{(\d+)\}\r\n/);
      const tagIndex = this.buffer.indexOf(`\r\n${tag} `, searchFrom);
      if (literalMatch) {
        const literalStart = searchFrom + literalMatch.index;
        const literalEnd = literalStart + literalMatch[0].length + Number(literalMatch[1]);
        if (this.buffer.length < literalEnd) {
          return; // 字面量未收完
        }
        searchFrom = literalEnd; // 跳过字面量继续找 tag 行
        continue;
      }
      if (tagIndex === -1) {
        return; // tag 行还没到
      }
      // 完整响应 = buffer 里 tag 行（含）之前的内容
      const end = this.buffer.indexOf('\r\n', tagIndex + 2);
      const full = this.buffer.slice(0, end + 2);
      const statusLine = this.buffer.slice(tagIndex + 2, end);
      this.buffer = this.buffer.slice(end + 2);
      this.pending = null;
      const status = statusLine.split(' ')[1];
      if (status === 'OK') {
        resolve(full);
      } else {
        reject(new Error(`IMAP ${statusLine.slice(0, 200)}`));
      }
      return;
    }
  }

  /** 发送一条命令并等 tag 行。返回完整响应文本（含 * 行与 tag 行）。 */
  exec(command) {
    this.tagCounter += 1;
    const tag = `A${String(this.tagCounter).padStart(3, '0')}`;
    return new Promise((resolve, reject) => {
      this.pending = { tag, resolve, reject };
      this.socket.write(`${tag} ${command}\r\n`);
      this.#tryResolve();
    });
  }
}

function quote(value) {
  return `"${String(value ?? '').replace(/(["\\])/g, '\\$1')}"`;
}

/** 连接并登录。返回 session。 */
export async function imapLogin({ host, port = 993, secure = true, user, pass }, timeout = 25_000) {
  if (!host || !user || !pass) {
    throw new Error('IMAP 未配置（config.json 的 imap.host/user/pass）');
  }
  const socket = await connect(host, Number(port), Boolean(secure), timeout);
  const session = new ImapSession(socket);
  // 服务器问候语（* OK ...）——等它出现再 LOGIN
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('IMAP greeting timeout')), timeout);
    const wait = () => {
      if (session.buffer.startsWith('* ')) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(wait, 50);
      }
    };
    wait();
  });
  await session.exec(`LOGIN ${quote(user)} ${quote(pass)}`);
  return session;
}

export async function imapLogout(session) {
  try {
    await session.exec('LOGOUT');
  } catch {}
  session.socket.destroy();
}

/** 打开邮箱，返回 {exists}。 */
export async function imapSelect(session, mailbox = 'INBOX') {
  const response = await session.exec(`SELECT ${quote(mailbox)}`);
  const exists = response.match(/\* (\d+) EXISTS/);
  return { exists: exists ? Number(exists[1]) : 0 };
}

/**
 * 搜索某发件人自某日期以来的邮件。
 * @returns {Promise<number[]>} 序列号列表（新→旧不保证，按 IMAP 返回）
 */
export async function imapSearchFrom(session, fromEmail, sinceDate) {
  const since = sinceDate.toISOString().slice(0, 10).split('-').reverse().join('-'); // DD-MM-YYYY
  const response = await session.exec(`SEARCH FROM ${quote(fromEmail)} SINCE ${since} ALL`);
  const line = response.split('\r\n').find((item) => item.startsWith('* SEARCH'));
  if (!line) {
    return [];
  }
  return line.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean).map(Number);
}

function parseHeaderBlock(block) {
  const headers = {};
  let currentKey = null;
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith(' ') || rawLine.startsWith('\t')) {
      if (currentKey) {
        headers[currentKey] += ` ${rawLine.trim()}`;
      }
      continue;
    }
    const colon = rawLine.indexOf(':');
    if (colon > 0) {
      currentKey = rawLine.slice(0, colon).trim().toLowerCase();
      headers[currentKey] = rawLine.slice(colon + 1).trim();
    }
  }
  return headers;
}

function decodeBody(text, encoding) {
  const enc = String(encoding ?? '').toLowerCase();
  try {
    if (enc.includes('base64')) {
      const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, '');
      return Buffer.from(cleaned, 'base64').toString('utf8');
    }
    if (enc.includes('quoted-printable')) {
      return text
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => Buffer.from(hex, 'hex').toString('latin1'));
    }
    return text;
  } catch {
    return text;
  }
}

/**
 * 抓一封信的头部+正文（正文截断 maxBody 字节）。
 * @returns {{messageId, inReplyTo, references, subject, from, date, body}}
 */
export async function imapFetchMessage(session, sequence, { maxBody = 8000 } = {}) {
  const command =
    `FETCH ${sequence} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES SUBJECT FROM DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.${maxBody}>)`;
  const response = await session.exec(command);
  // 拆 HEADER / TEXT 两段
  const headerMatch = response.match(/HEADER\.FIELDS \([^)]*\)\] ?\r?\n?([\s\S]*?)\r?\n?\)/i);
  const textMatch = response.match(/BODY\[TEXT\]<0>\] ?\r?\n?([\s\S]*?)(?:\r?\nA\d{3} |$)/i);
  const headers = parseHeaderBlock(headerMatch?.[1] ?? '');
  const rawBody = (textMatch?.[1] ?? '').trim();
  const body = decodeBody(rawBody, headers['content-transfer-encoding']);
  const plainFromHtml = body
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    sequence,
    messageId: (headers['message-id'] ?? '').trim(),
    inReplyTo: (headers['in-reply-to'] ?? '').trim(),
    references: (headers.references ?? '').trim(),
    subject: headers.subject ?? '',
    from: (headers.from ?? '').trim(),
    date: headers.date ?? '',
    body: plainFromHtml.slice(0, 4000),
  };
}

/** 一次性探测：登录+选箱，设置页测试用。 */
export async function imapProbe(config) {
  const session = await imapLogin(config);
  try {
    const { exists } = await imapSelect(session, config.mailbox ?? 'INBOX');
    return `${config.host} 登录成功，${config.mailbox ?? 'INBOX'} 共 ${exists} 封`;
  } finally {
    await imapLogout(session);
  }
}
