// 零依赖 SMTP 客户端：隐式 TLS(465) / 明文+STARTTLS(587/25)，AUTH PLAIN/LOGIN，
// MIME multipart（text/plain UTF-8 + base64 附件）。够发开发信和报价单。
import net from 'node:net';
import tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';

const CRLF = '\r\n';
// 会话级空闲超时：连接阶段有 timeout，但 DATA 后 await readReply 对半开
// 连接会无限等待，拖住整个 cron。空闲 120s 无数据即销毁并报错。
// （Node 的 socket.setTimeout 只在持续空闲时触发，收发数据自动重置）
const IDLE_TIMEOUT = 120_000;

function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(CRLF);
      if (lines.length >= 2 && /^\d{3} /.test(lines[lines.length - 2] ?? '')) {
        socket.setTimeout(0);
        socket.removeListener('data', onData);
        resolve({ code: Number(buffer.slice(0, 3)), text: buffer });
      }
    };
    socket.setTimeout(IDLE_TIMEOUT, () => {
      socket.destroy();
      reject(new Error(`SMTP idle timeout (${IDLE_TIMEOUT / 1000}s no data)`));
    });
    socket.on('data', onData);
    socket.once('error', (error) => {
      socket.removeListener('data', onData);
      reject(error);
    });
  });
}

async function cmd(socket, command, expect) {
  if (command !== undefined) {
    socket.write(`${command}${CRLF}`);
  }
  const reply = await readReply(socket);
  if (!expect.includes(reply.code)) {
    const line = reply.text.split(CRLF).find((item) => /^\d{3} /.test(item)) ?? reply.text;
    throw new Error(`SMTP ${reply.code}: ${line}`.slice(0, 220));
  }
  return reply;
}

function connectSocket(host, port, secure, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timeout ${host}:${port}`));
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

/** RFC2047 编码 UTF-8 头。 */
export function encodeHeader(text) {
  if (!/[\u0080-\uffff]/.test(String(text))) {
    return String(text);
  }
  return `=?UTF-8?B?${Buffer.from(String(text), 'utf8').toString('base64')}?=`;
}

function b64Lines(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
}

function dotStuff(mime) {
  return mime
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

/**
 * 组装 MIME 邮件。支持 html（multipart/alternative）、附件（multipart/mixed）、
 * 两者叠加（mixed > alternative > plain+html+attachments）。
 * @param {{from, fromName?, to, toName?, subject, body, html?, replyTo?, inReplyTo?, references?, attachments?: [{filename, contentType?, base64}]}} message
 * @returns {string} 完整 MIME 文本
 */
export function buildMime(message) {
  const boundary = `=_waimao_${createHash('md5').update(`${message.to}${randomUUID()}`).digest('hex').slice(0, 16)}`;
  const altBoundary = `${boundary}alt`;
  const fromName = message.fromName ? `${encodeHeader(message.fromName)} ` : '';
  const headers = [
    `From: ${fromName}<${message.from}>`,
    `To: ${message.toName ? `${encodeHeader(message.toName)} <${message.to}>` : message.to}`,
    `Subject: ${encodeHeader(message.subject ?? '')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${createHash('md5').update(randomUUID()).digest('hex').slice(0, 20)}@waimao.local>`,
    'MIME-Version: 1.0',
  ];
  if (message.replyTo) {
    headers.push(`Reply-To: ${message.replyTo}`);
  }
  // 回复线程：跟进邮件挂到原邮件线程下（In-Reply-To + References）
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${message.inReplyTo}`);
    const refs = String(message.references ?? '').split(/\s+/).filter(Boolean);
    headers.push(`References: ${[...refs, message.inReplyTo].join(' ')}`);
  }
  const files = Array.isArray(message.attachments) ? message.attachments.filter((f) => f?.base64) : [];
  const hasHtml = typeof message.html === 'string' && message.html.trim() !== '';

  const plainPart =
    `--${hasHtml ? altBoundary : boundary}${CRLF}Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    b64Lines(message.body ?? '') + CRLF;
  const htmlPart = hasHtml
    ? `--${altBoundary}${CRLF}Content-Type: text/html; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
      b64Lines(message.html) + CRLF
    : '';
  const alternativeBlock = hasHtml
    ? `--${boundary}${CRLF}Content-Type: multipart/alternative; boundary="${altBoundary}"${CRLF}${CRLF}` +
      plainPart + htmlPart + `--${altBoundary}--${CRLF}`
    : plainPart;

  const attachmentParts = files
    .map(
      (file) =>
        `--${boundary}${CRLF}` +
        `Content-Type: ${file.contentType ?? 'application/octet-stream'}; name="${encodeHeader(file.filename)}"${CRLF}` +
        `Content-Disposition: attachment; filename="${encodeHeader(file.filename)}"${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
        String(file.base64).replace(/(.{76})/g, `$1${CRLF}`) + CRLF,
    )
    .join('');

  let mime;
  if (files.length > 0 || hasHtml) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    mime = headers.join(CRLF) + CRLF + CRLF + alternativeBlock + attachmentParts + `--${boundary}--${CRLF}`;
    // 无附件只有 alternative 时，mixed 里只有一个 alternative 子块——合法但多余，
    // 直接用 alternative 作为顶层更干净：
    if (files.length === 0) {
      headers[headers.length - 1] = `Content-Type: multipart/alternative; boundary="${altBoundary}"`;
      mime = headers.join(CRLF) + CRLF + CRLF + plainPart + htmlPart + `--${altBoundary}--${CRLF}`;
    }
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    mime = headers.join(CRLF) + CRLF + CRLF + b64Lines(message.body ?? '') + CRLF;
  }
  return mime;
}

/** 连通性探测：连接 + EHLO +（配置了账号时）AUTH，不发信。返回描述文本。 */
export async function probeSmtp(smtp) {
  if (!smtp?.host) {
    throw new Error('SMTP 未配置 host');
  }
  const port = Number(smtp.port ?? (smtp.secure ? 465 : 587));
  const socket = await connectSocket(smtp.host, port, Boolean(smtp.secure));
  try {
    await cmd(socket, undefined, [220]);
    const ehlo = await cmd(socket, 'EHLO probe.waimao.local', [250]);
    const caps = ehlo.text.toLowerCase();
    let auth = caps.includes('auth') ? 'auth可用' : '无需auth';
    if (smtp.user && smtp.pass) {
      if (caps.includes('auth=plain') || caps.includes('auth plain')) {
        const plain = Buffer.from(`\u0000${smtp.user}\u0000${smtp.pass}`, 'utf8').toString('base64');
        await cmd(socket, `AUTH PLAIN ${plain}`, [235]);
        auth = 'AUTH PLAIN 验证通过';
      } else if (caps.includes('auth=login') || caps.includes('auth login')) {
        await cmd(socket, 'AUTH LOGIN', [334]);
        await cmd(socket, Buffer.from(smtp.user).toString('base64'), [334]);
        await cmd(socket, Buffer.from(smtp.pass).toString('base64'), [235]);
        auth = 'AUTH LOGIN 验证通过';
      } else {
        auth = '服务器不支持AUTH，无法用账号密码发信';
      }
    }
    try {
      socket.write(`QUIT${CRLF}`);
    } catch {}
    return `${smtp.host}:${port} 连通，${auth}${caps.includes('starttls') ? '，支持STARTTLS' : ''}`;
  } finally {
    socket.destroy();
  }
}

/**
 * 发送一封邮件。
 * @param {object} smtp {host, port, secure, user, pass, from, fromName}
 * @param {object} message 同 buildMime
 * @returns {{messageId: string, accepted: string[]}}
 */
export async function sendMail(smtp, message) {
  if (!smtp?.host || !smtp?.from) {
    throw new Error('SMTP 未配置：请在 ~/.waimao/config.json 填写 smtp.host / smtp.from');
  }
  const port = Number(smtp.port ?? (smtp.secure ? 465 : 587));
  let socket = await connectSocket(smtp.host, port, Boolean(smtp.secure));
  const fromDomain = String(smtp.from).split('@')[1] ?? 'waimao.local';
  try {
    await cmd(socket, undefined, [220]);
    const ehlo = await cmd(socket, `EHLO ${fromDomain}`, [250]);
    const caps = ehlo.text.toLowerCase();
    if (!smtp.secure && caps.includes('starttls') && port !== 25) {
      await cmd(socket, 'STARTTLS', [220]);
      socket = await new Promise((resolve, reject) => {
        const tlsSocket = tls.connect({ socket, servername: smtp.host, rejectUnauthorized: false });
        tlsSocket.once('error', reject);
        tlsSocket.once('secureConnect', () => resolve(tlsSocket));
      });
      await cmd(socket, `EHLO ${fromDomain}`, [250]);
    }
    if (smtp.user && smtp.pass) {
      if (caps.includes('auth=plain') || caps.includes('auth plain') || caps.includes('auth login')) {
        if (caps.includes('auth login') && !caps.includes('auth=plain')) {
          await cmd(socket, 'AUTH LOGIN', [334]);
          await cmd(socket, Buffer.from(smtp.user).toString('base64'), [334]);
          await cmd(socket, Buffer.from(smtp.pass).toString('base64'), [235]);
        } else {
          const plain = Buffer.from(`\u0000${smtp.user}\u0000${smtp.pass}`, "utf8").toString('base64');
          await cmd(socket, `AUTH PLAIN ${plain}`, [235]);
        }
      }
    }
    await cmd(socket, `MAIL FROM:<${smtp.from}>`, [250]);
    const recipients = Array.isArray(message.to) ? message.to : [message.to];
    for (const to of recipients) {
      await cmd(socket, `RCPT TO:<${to}>`, [250, 251]);
    }
    await cmd(socket, 'DATA', [354]);
    const mime = buildMime({ ...message, to: Array.isArray(message.to) ? message.to.join(', ') : message.to });
    socket.write(dotStuff(mime) + CRLF + '.' + CRLF);
    const sent = await readReply(socket);
    if (sent.code !== 250) {
      throw new Error(`SMTP DATA rejected ${sent.code}: ${sent.text.split(CRLF).pop()}`.slice(0, 220));
    }
    try {
      socket.write(`QUIT${CRLF}`);
    } catch {}
    socket.destroy();
    return { messageId: (mime.match(/Message-ID: (.+)/) ?? [])[1] ?? '', accepted: recipients };
  } catch (error) {
    try {
      socket.destroy();
    } catch {}
    throw error;
  }
}
