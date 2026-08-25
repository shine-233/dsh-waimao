// 通用 CSV（UTF-8 BOM，Excel 友好）。
export function csvEscape(value) {
  const text = String(value ?? '');
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
