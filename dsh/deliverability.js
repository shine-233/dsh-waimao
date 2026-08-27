// 送达率体检：SPF / DKIM / DMARC / MX 的 DNS 检查 + 可执行建议。
// 全部走 node:dns，零依赖。DKIM 按常见 selector 探测（用户可指定）。
import { promises as dns } from 'node:dns';

const COMMON_DKIM_SELECTORS = ['google', 'default', 'selector1', 'selector2', 's1', 'm1', 'k1', 'dkim', 'mail'];

// 收件方邮箱服务商识别（MX 主机 → 服务商）：影响发信策略建议
const MX_PROVIDERS = [
  ['Google Workspace', /google|googlemail/i],
  ['Microsoft 365', /(outlook|hotmail|protection\.outlook|microsoft)\./i],
  ['Zoho Mail', /zoho/i],
  ['Yandex', /yandex/i],
  ['QQ 企业邮箱', /(qq\.com|tencent)/i],
  ['网易企业邮箱', /(163|126|netease)\.com/i],
  ['阿里企业邮箱', /aliyun/i],
  ['腾讯企业邮', /exmail/i],
];

export function providerFromMxHost(host) {
  const clean = String(host ?? '').toLowerCase();
  for (const [name, re] of MX_PROVIDERS) {
    if (re.test(clean)) {
      return name;
    }
  }
  return null;
}

async function txtRecords(name) {
  try {
    return (await dns.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

export async function deliverabilityCheck(domain, { dkimSelector } = {}) {
  const clean = String(domain ?? '').toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  if (!clean.includes('.')) {
    throw new Error(`invalid domain: ${domain}`);
  }
  const checks = [];
  const advice = [];

  // MX
  let mx = [];
  try {
    mx = await dns.resolveMx(clean);
  } catch {}
  checks.push({ item: 'MX', ok: mx.length > 0, detail: mx.length > 0 ? `${mx.length} 条记录 (${mx.slice(0, 2).map((item) => item.exchange).join(', ')})` : '无 MX 记录——收不了信' });
  if (mx.length === 0) {
    advice.push('没有 MX 记录：这个域名收不了回复，检查邮箱服务 DNS 配置');
  }
  const provider = mx.length > 0 ? providerFromMxHost(mx[0].exchange) : null;
  if (provider) {
    checks[checks.length - 1].detail += ` — ${provider}`;
    if (provider === 'Google Workspace') {
      advice.push('收件方在 Google：DKIM selector 多为 google，发信节奏稳定更容易进收件箱');
    } else if (provider === 'Microsoft 365') {
      advice.push('收件方在 Microsoft：对垃圾链接敏感，首封避免短链接和附件');
    }
  }

  // SPF
  const txt = await txtRecords(clean);
  const spf = txt.find((record) => record.toLowerCase().startsWith('v=spf1'));
  checks.push({ item: 'SPF', ok: Boolean(spf), detail: spf ? spf.slice(0, 120) : '未找到 v=spf1 记录' });
  if (!spf) {
    advice.push('添加 SPF 记录，例如: v=spf1 include:_spf.google.com ~all（按你的邮箱服务商调整）');
  } else if (spf.includes('+all') || spf.includes('* all')) {
    checks[checks.length - 1].ok = false;
    checks[checks.length - 1].detail += ' ⚠️ +all 等于不设防，会被拒收';
    advice.push('SPF 里不要用 +all，改成 ~all');
  }

  // DMARC
  const dmarc = await txtRecords(`_dmarc.${clean}`);
  const dmarcRecord = dmarc.find((record) => record.toLowerCase().startsWith('v=dmarc1'));
  checks.push({ item: 'DMARC', ok: Boolean(dmarcRecord), detail: dmarcRecord ? dmarcRecord.slice(0, 120) : '未找到（_dmarc.' + clean + '）' });
  if (!dmarcRecord) {
    advice.push('添加 DMARC 记录，例如: v=DMARC1; p=none; rua=mailto:dmarc@' + clean + '（先观察再收紧到 quarantine）');
  }

  // DKIM：常见 selector 探测。p= 后面必须有实际公钥（吊销密钥 p= 为空，不算通过）
  const selectors = [dkimSelector, ...COMMON_DKIM_SELECTORS].filter(Boolean);
  let dkimFound = null;
  for (const selector of [...new Set(selectors)]) {
    const records = await txtRecords(`${selector}._domainkey.${clean}`);
    const hit = records.find((record) => (record.toLowerCase().includes('v=dkim1') || record.includes('p=')) && /p=[A-Za-z0-9+/]{8}/.test(record));
    if (hit) {
      dkimFound = { selector, record: hit.slice(0, 100) };
      break;
    }
  }
  checks.push({ item: 'DKIM', ok: Boolean(dkimFound), detail: dkimFound ? `selector=${dkimFound.selector}` : `常见 selector 未命中（${selectors.slice(0, 4).join('/')}...）——有自定义 selector 请在参数里指定` });
  if (!dkimFound) {
    advice.push('DKIM 未检测到：在邮箱服务商后台确认已启用签名，并用其提供的 selector 重试（dkimSelector 参数）');
  }

  // rDNS 无法从外侧查发信 IP，跳过；给出人工检查指引
  advice.push('反向 DNS (rDNS/PTR)：在 VPS/邮箱服务商控制台确认发信 IP 的 PTR 记录指向你的邮件主机名');

  const passed = checks.filter((check) => check.ok).length;
  return {
    domain: clean,
    passed,
    total: checks.length,
    score: `${passed}/${checks.length}`,
    checks,
    advice,
    verdict: passed === checks.length ? '✅ 基础配置齐全' : passed >= 2 ? '⚠️ 有缺口，先修再发' : '❌ 配置严重不足，直接发必进垃圾箱',
  };
}
