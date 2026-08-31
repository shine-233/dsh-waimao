// 零依赖 IMAP 客户端（够用版）：TLS 连接、LOGIN、SELECT、SEARCH、FETCH。
// 支持 IMAP 字面量 {N} 分块读取。只做回复检测需要的部分，不做完整解析。
import tls from 'node:tls';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

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

const IDLE_TIMEOUT = 120_000; // 空闲 2 分钟无数据即断开（防止等一个永远不来的字面量）

/** 带字面量感知的 IMAP 会话。 */
class ImapSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8'); // 跨 TCP 分块安全解码，避免多字节字符被切开变乱码
    this.tagCounter = 0;
    this.pending = null; // {resolve, reject}
    socket.setTimeout(IDLE_TIMEOUT, () => {
      const error = new Error(`IMAP idle timeout (${IDLE_TIMEOUT / 1000}s no data)`);
      socket.destroy();
      if (this.pending) {
        const { reject } = this.pending;
        this.pending = null;
        reject(error);
      }
    });
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
    this.buffer += this.decoder.write(chunk);
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
      const tagMarker = this.buffer.startsWith(`${tag} `)
        ? 0
        : this.buffer.indexOf(`\r\n${tag} `, searchFrom);
      if (literalMatch) {
        const literalStart = searchFrom + literalMatch.index;
        const literalEnd = literalStart + literalMatch[0].length + Number(literalMatch[1]);
        if (this.buffer.length < literalEnd) {
          return; // 字面量未收完
        }
        searchFrom = literalEnd; // 跳过字面量继续找 tag 行
        continue;
      }
      if (tagMarker === -1) {
        return; // tag 行还没到
      }
      // 完整响应 = buffer 里 tag 行（含）之前的内容
      const statusStart = tagMarker === 0 ? 0 : tagMarker + 2;
      const end = this.buffer.indexOf('\r\n', statusStart);
      const full = this.buffer.slice(0, end + 2);
      const statusLine = this.buffer.slice(statusStart, end);
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

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP SINCE 日期：RFC 3501 要求 DD-Mon-YYYY（如 01-Aug-2026）。 */
export function imapDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${IMAP_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** 通用 SEARCH：criteria 为 IMAP 搜索语法。返回序列号列表。 */
export async function imapSearch(session, criteria) {
  const response = await session.exec(`SEARCH ${criteria}`);
  const line = response.split('\r\n').find((item) => item.startsWith('* SEARCH'));
  if (!line) {
    return [];
  }
  return line.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean).map(Number);
}

/**
 * 搜索某发件人自某日期以来的邮件。
 * @returns {Promise<number[]>} 序列号列表（新→旧不保证，按 IMAP 返回）
 */
export async function imapSearchFrom(session, fromEmail, sinceDate) {
  return imapSearch(session, `FROM ${quote(fromEmail)} SINCE ${imapDate(sinceDate)}`);
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
      // 按字节解码再重组 UTF-8：=XX 是字节级转义，逐字节 toString('latin1') 会把
      // 多字节序列拆散成乱码（中文回复必中）
      const clean = text.replace(/=\r?\n/g, '');
      const bytes = [];
      for (let i = 0; i < clean.length; i += 1) {
        if (clean[i] === '=' && /^[0-9A-F]{2}$/i.test(clean.slice(i + 1, i + 3))) {
          bytes.push(parseInt(clean.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(clean.charCodeAt(i) & 0xff);
        }
      }
      return Buffer.from(bytes).toString('utf8');
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
/**
 * 按 UTF-8 字节长度截断字符串。IMAP 字面量 {N} 的 N 是字节数，而响应已被
 * StringDecoder 解码成 JS 字符串（UTF-16 码元）——多字节字符会让"取 N 个字符"
 * 多拿或少拿。这里逐字符累计字节数，精确切到第 N 字节。
 */
function sliceByBytes(str, maxBytes) {
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : 3;
    if (bytes + size > maxBytes) {
      return str.slice(0, i);
    }
    bytes += size;
  }
  return str;
}

/**
 * 从 FETCH 响应里提取头块。优先按 IMAP 字面量 {N} 的字节长度截取——
 * 旧的正则懒惰匹配会在头值含括号时提前截断（如 From: "Foo (Trading Co.)" <a@b.com>），
 * 导致 Message-ID 丢失、回复被去重逻辑静默吞掉。
 */
export function extractHeaderBlock(response) {
  const literal = response.match(/HEADER\.FIELDS \([^)]*\)\] ?\{(\d+)\}\r\n/i);
  if (literal) {
    const start = literal.index + literal[0].length;
    const block = sliceByBytes(response.slice(start), Number(literal[1]));
    const cut = block.indexOf('\r\n\r\n');
    return cut >= 0 ? block.slice(0, cut) : block;
  }
  // 兜底：不带字面量标记的响应
  return response.match(/HEADER\.FIELDS \([^)]*\)\] ?\r?\n?([\s\S]*?)\r?\n?\)/i)?.[1] ?? '';
}

/**
 * 从 FETCH 响应里提取 TEXT 段。旧正则写成 BODY\[TEXT\]<0>\]（括号顺序反了），
 * 真实服务器响应是 `BODY[TEXT]<0> {N}`，导致正文永远提取不到、回复分类拿到空字符串。
 * 按字面量 {N} 字节长度精确截断：字面量内容后紧跟 `)`（无 CRLF），启发式截断
 * 会把右括号带进正文——"STOP)" 因此不匹配退订规则，真实场景已复现。
 */
function extractTextBlock(response) {
  const literal = response.match(/BODY\[TEXT\](?:<0[^>]*>)? ?\{(\d+)\}\r\n/i);
  if (!literal) {
    // 兜底：不带字面量标记的响应
    return response.match(/BODY\[TEXT\][^\r\n]*?\r?\n?([\s\S]*?)(?:\r\n\)|\r?\nA\d{3} |$)/i)?.[1] ?? '';
  }
  const start = literal.index + literal[0].length;
  return sliceByBytes(response.slice(start), Number(literal[1]));
}

export async function imapFetchMessage(session, sequence, { maxBody = 8000 } = {}) {
  const command =
    `FETCH ${sequence} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES SUBJECT FROM DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.${maxBody}>)`;
  const response = await session.exec(command);
  // 拆 HEADER / TEXT 两段
  const headerBlock = extractHeaderBlock(response);
  const headers = parseHeaderBlock(headerBlock);
  const rawBody = extractTextBlock(response).trim();
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
