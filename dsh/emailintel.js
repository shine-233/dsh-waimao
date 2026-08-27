// 邮箱情报：一次性域名识别 / 角色地址识别 / 域名拼写纠错 / 验证结果缓存。
// 参考成熟实现（AfterShip/email-verifier、devmehq/email-validator-js）的通用做法：
// 免费信号先行（域名清单/角色名/编辑距离），昂贵的 SMTP 探测只在必要时做且结果缓存。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';

const CACHE_FILE = join(DATA_DIR, 'verify-cache.json');
export const CACHE_TTL_DAYS = 30;

// 常见一次性/临时邮箱域名（节选自公开 disposable 列表的高频子集）
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', '10minutemail.com', 'guerrillamail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'throwawaymail.com', 'sharklasers.com', 'getnada.com',
  'dispostable.com', 'maildrop.cc', 'mintemail.com', 'tempinbox.com', 'fakeinbox.com',
  'spam4.me', 'grr.la', '1secmail.com', '1secmail.net', 'mohmal.com', 'emailondeck.com',
  'tempr.email', 'discard.email', 'mytemp.email', 'tmpmail.org', 'luxusmail.org',
  'moakt.com', 'tmail.ws', 'disbox.net', 'mail-temp.com', 'nowmymail.com',
]);

/** 一次性邮箱域名（临时邮箱，B2B 场景几乎必然不是真实买家）。 */
export function isDisposableDomain(domainOrEmail) {
  const raw = String(domainOrEmail ?? '').toLowerCase().trim();
  const domain = raw.includes('@') ? raw.split('@')[1] : raw;
  return DISPOSABLE_DOMAINS.has(domain.replace(/^www\./, ''));
}

const ROLE_LOCALS = new Set([
  'info', 'sales', 'contact', 'hello', 'office', 'admin', 'support', 'marketing',
  'webmaster', 'noreply', 'no-reply', 'postmaster', 'abuse', 'help', 'service',
  'purchasing', 'sourcing', 'buy', 'buyer', 'import', 'export', 'trade', 'enquiries', 'inquiry',
]);

/** 角色地址（部门公共邮箱而非个人）：冷回复率显著低于个人邮箱，标记出来让使用者自己权衡。 */
export function isRoleAddress(email) {
  const local = String(email ?? '').toLowerCase().split('@')[0] ?? '';
  return ROLE_LOCALS.has(local) || /^(general|info|sales)\d/.test(local);
}

const POPULAR_PROVIDERS = [
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'aol.com',
  'live.com', 'proton.me', 'protonmail.com', 'qq.com', '163.com', '126.com',
  'sina.com', 'aliyun.com', 'foxmail.com', 'zoho.com', 'gmx.com', 'mail.com',
  'yandex.com', 'hey.com', 'fastmail.com',
];

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 域名拼写纠错：gmial.com → gmail.com（编辑距离 ≤2 的热门服务商）。 */
export function suggestDomainFix(domain) {
  const clean = String(domain ?? '').toLowerCase().trim();
  if (!clean.includes('.') || POPULAR_PROVIDERS.includes(clean)) {
    return null;
  }
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const provider of POPULAR_PROVIDERS) {
    const d = levenshtein(clean, provider);
    if (d > 0 && d <= 2 && d < bestDistance) {
      best = provider;
      bestDistance = d;
    }
  }
  return best;
}

function loadCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    return parsed && typeof parsed.byEmail === 'object' ? parsed : { byEmail: {} };
  } catch {
    return { byEmail: {} };
  }
}

function saveCache(db) {
  mkdirSync(dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  renameSync(tmp, CACHE_FILE);
}

/** 读取缓存的验证结果（TTL 内有效）。unverifiable 不缓存——重试可能有不同结果。 */
export function getCachedVerification(email, { ttlDays = CACHE_TTL_DAYS } = {}) {
  const db = loadCache();
  const entry = db.byEmail[String(email ?? '').toLowerCase()];
  if (!entry) {
    return null;
  }
  const ageDays = (Date.now() - Date.parse(entry.ts)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > ttlDays) {
    delete db.byEmail[String(email ?? '').toLowerCase()];
    saveCache(db);
    return null;
  }
  return { ...entry, cached: true };
}

/** 缓存验证结论。 */
export function rememberVerification(result) {
  const email = String(result?.email ?? '').toLowerCase();
  if (!email.includes('@')) {
    return false;
  }
  const cacheable = ['valid', 'invalid', 'catch-all', 'no-mx', 'no-dns', 'disposable'].includes(result.status);
  if (!cacheable) {
    return false;
  }
  const db = loadCache();
  db.byEmail[email] = {
    status: result.status,
    reason: String(result.reason ?? '').slice(0, 200),
    mx: result.mx ?? null,
    role: Boolean(result.role),
    ts: new Date().toISOString(),
  };
  // 容量裁剪：最多 20_000 条，丢最老的
  const keys = Object.keys(db.byEmail);
  if (keys.length > 20_000) {
    keys.slice(0, keys.length - 20_000).forEach((key) => delete db.byEmail[key]);
  }
  saveCache(db);
  return true;
}

/** 清空缓存（测试用）。 */
export function clearVerificationCache() {
  saveCache({ byEmail: {} });
}
