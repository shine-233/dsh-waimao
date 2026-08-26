// 通用 CSV（UTF-8 BOM，Excel 友好）。
export function csvEscape(value) {
  let text = String(value ?? '');
  // Excel 公式注入防护：网页抓来的公司名/标题以 =+-@ 开头时会被当公式执行
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
  const head = headers.map(csvEscape).join(',');
  const body = rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','));
  return `\uFEFF${[head, ...body].join('\r\n')}\r\n`;
}

/** CRM 导出用的列。 */
export const CRM_CSV_HEADERS = [
  'ID', '公司', '域名', '市场', '状态', '评分', '分层', '邮箱', 'WhatsApp',
  '电话', 'LinkedIn', '开发建议', '最近动作', '标签', '来源', '创建时间',
];

export function crmRow(lead) {
  const last = lead.activities?.at(-1);
  return {
    ID: lead.id,
    公司: lead.company || lead.domain,
    域名: lead.domain,
    市场: lead.market,
    状态: lead.status,
    评分: lead.score ?? 0,
    分层: lead.tier,
    邮箱: (lead.contacts?.emails ?? []).join(' '),
    WhatsApp: (lead.contacts?.whatsapps ?? []).join(' '),
    电话: (lead.contacts?.phones ?? []).join(' '),
    LinkedIn: (lead.contacts?.socials?.linkedin ?? []).join(' '),
    开发建议: lead.advice ?? '',
    最近动作: last ? `${last.ts.slice(0, 16)} ${last.note}` : '',
    标签: (lead.tags ?? []).join(' '),
    来源: (lead.sources ?? []).join(' '),
    创建时间: lead.createdAt,
  };
}

/** RFC6350 vCard（手机通讯录可直接导入，WhatsApp 加联系人神器）。 */
export function toVCard(lead) {
  // vCard 值转义：\ , ; 和换行都是结构字符
  const esc = (value) =>
    String(value ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const name = (lead.company || lead.domain || 'Unknown').replace(/[;,\\]/g, ' ');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(name)};;;;`, `FN:${esc(name)}`, `ORG:${esc(name)}`];
  if (lead.market) {
    lines.push(`NOTE:${esc(`[waimao] ${lead.market} ${lead.tier ?? ''} ${lead.score ?? ''}分`)}`);
  }
  for (const email of (lead.contacts?.emails ?? []).slice(0, 3)) {
    lines.push(`EMAIL;TYPE=WORK:${email}`);
  }
  for (const wa of (lead.contacts?.whatsapps ?? []).slice(0, 2)) {
    lines.push(`TEL;TYPE=CELL:+${wa.replace(/\D/g, '')}`);
  }
  for (const phone of (lead.contacts?.phones ?? []).slice(0, 2)) {
    lines.push(`TEL;TYPE=WORK:+${phone.replace(/\D/g, '')}`);
  }
  const linkedin = lead.contacts?.socials?.linkedin?.[0];
  if (linkedin) {
    lines.push(`URL:${linkedin}`);
  }
  if (lead.url) {
    lines.push(`URL:${lead.url}`);
  }
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

export function toVcf(leads) {
  return `${leads.map(toVCard).join('\r\n')}\r\n`;
}
