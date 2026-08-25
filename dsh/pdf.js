// 极简 PDF 生成器（PDF 1.4，Helvetica，英文报价单）。
// 中文不进 PDF（Helvetica 无 CJK 字形），报价单面向海外客户用英文正合适。
// 只用 PDF 基本对象：catalog/pages/page/font/content stream，xref 手工计算。
import { createHash } from 'node:crypto';

function esc(text) {
  return String(text ?? '').replace(/[\\()]/g, (match) => `\\${match}`);
}

function wrap(text, width) {
  const words = String(text ?? '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      if (line) {
        lines.push(line.trim());
      }
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line.trim()) {
    lines.push(line.trim());
  }
  return lines;
}

/**
 * 生成报价单 PDF Buffer。
 * opts: {quoteNo, date, from:{company,email,phone}, to:{company,contact,country},
 *        items:[{desc, qty, unit, unitPrice}], currency, leadTime, payment, validity, notes}
 */
export function quotePdf(opts) {
  const currency = opts.currency ?? 'USD';
  const items = Array.isArray(opts.items) ? opts.items : [];
  const subtotal = items.reduce((sum, item) => sum + Number(item.qty ?? 0) * Number(item.unitPrice ?? 0), 0);

  const lines = []; // {text, size, bold, gap}
  const add = (text, { size = 10, bold = false, gap = 6 } = {}) => lines.push({ text, size, bold, gap });

  add(opts.from?.company ?? 'OUR COMPANY', { size: 16, bold: true, gap: 4 });
  add([opts.from?.email, opts.from?.phone].filter(Boolean).join('  |  '), { size: 9, gap: 14 });

  add(`QUOTATION  ${opts.quoteNo ?? ''}`, { size: 14, bold: true, gap: 4 });
  add(`Date: ${opts.date ?? new Date().toISOString().slice(0, 10)}`, { size: 9, gap: 12 });

  add('TO:', { size: 9, bold: true, gap: 2 });
  add(opts.to?.company ?? '-', { size: 10, gap: 2 });
  add([opts.to?.contact, opts.to?.country].filter(Boolean).join(', '), { size: 9, gap: 14 });

  add('ITEMS', { size: 10, bold: true, gap: 4 });
  add('No.  Description                              Qty      Unit      Amount', { size: 9, gap: 2 });
  add('-'.repeat(78), { size: 9, gap: 4 });
  items.forEach((item, index) => {
    const qty = Number(item.qty ?? 0);
    const price = Number(item.unitPrice ?? 0);
    add(
      `${String(index + 1).padEnd(5)}${String(item.desc ?? '').slice(0, 40).padEnd(43)}${String(qty).padEnd(9)}${price.toFixed(2).padStart(9)}  ${(qty * price).toFixed(2).padStart(10)}`,
      { size: 9, gap: 3 },
    );
  });
  add('-'.repeat(78), { size: 9, gap: 4 });
  add(`TOTAL: ${currency} ${subtotal.toFixed(2)}`, { size: 12, bold: true, gap: 14 });

  add(`Lead time: ${opts.leadTime ?? 'to be confirmed'}`, { size: 9, gap: 2 });
  add(`Payment: ${opts.payment ?? 'T/T', ''}`, { size: 9, gap: 2 });
  add(`Quote validity: ${opts.validity ?? '15 days'}`, { size: 9, gap: 10 });
  for (const note of wrap(opts.notes ?? '', 95)) {
    add(`Note: ${note}`, { size: 8, gap: 2 });
  }

  return renderPdf(lines);
}

/**
 * PI 形式发票（Proforma Invoice）：比报价单更正式——Incoterms、HS 编码、
 * 原产国、银行信息、双方签章栏。用于客户开信用证/预付/清关预估。
 * opts: {piNo, date, validUntil, from:{company,email,phone,address}, to:{company,contact,address,country},
 *        items:[{desc, hsCode, qty, unitPrice}], currency, incoterm, payment, leadTime,
 *        origin, destination, bank:{name, account, swift, beneficiary}, notes}
 */
export function proformaPdf(opts) {
  const currency = opts.currency ?? 'USD';
  const items = Array.isArray(opts.items) ? opts.items : [];
  const subtotal = items.reduce((sum, item) => sum + Number(item.qty ?? 0) * Number(item.unitPrice ?? 0), 0);
  const incoterm = opts.incoterm ?? 'FOB';

  const lines = [];
  const add = (text, { size = 10, bold = false, gap = 6 } = {}) => lines.push({ text, size, bold, gap });

  add('PROFORMA INVOICE', { size: 17, bold: true, gap: 4 });
  add(`No.: ${opts.piNo ?? 'PI-' + Date.now().toString(36).toUpperCase()}    Date: ${opts.date ?? new Date().toISOString().slice(0, 10)}    Valid Until: ${opts.validUntil ?? '15 days'}`, { size: 9, gap: 14 });

  add('SELLER / EXPORTER', { size: 9, bold: true, gap: 2 });
  add(opts.from?.company ?? '-', { size: 10, gap: 1 });
  add([opts.from?.address, opts.from?.email, opts.from?.phone].filter(Boolean).join(', ').slice(0, 100), { size: 8.5, gap: 10 });

  add('BUYER / IMPORTER', { size: 9, bold: true, gap: 2 });
  add(opts.to?.company ?? '-', { size: 10, gap: 1 });
  add([opts.to?.contact, opts.to?.address, opts.to?.country].filter(Boolean).join(', ').slice(0, 100), { size: 8.5, gap: 12 });

  add('GOODS', { size: 10, bold: true, gap: 4 });
  add('No.  Description                        HS Code       Qty      Unit Price    Amount', { size: 9, gap: 2 });
  add('-'.repeat(88), { size: 9, gap: 4 });
  items.forEach((item, index) => {
    const qty = Number(item.qty ?? 0);
    const price = Number(item.unitPrice ?? 0);
    add(
      `${String(index + 1).padEnd(5)}${String(item.desc ?? '').slice(0, 32).padEnd(34)}${String(item.hsCode ?? '').padEnd(14)}${String(qty).padEnd(9)}${price.toFixed(2).padStart(12)}  ${(qty * price).toFixed(2).padStart(11)}`,
      { size: 8.5, gap: 3 },
    );
  });
  add('-'.repeat(88), { size: 9, gap: 4 });
  add(`TOTAL AMOUNT: ${currency} ${subtotal.toFixed(2)}  (${incoterm})`, { size: 12, bold: true, gap: 14 });

  add(`Country of Origin: ${opts.origin ?? 'China'}        Destination: ${opts.destination ?? opts.to?.country ?? '-'}`, { size: 9, gap: 2 });
  add(`Incoterms 2020: ${incoterm}`, { size: 9, gap: 2 });
  add(`Payment Terms: ${opts.payment ?? 'T/T 30% deposit, 70% against copy of B/L'}`, { size: 9, gap: 2 });
  add(`Lead Time: ${opts.leadTime ?? '25-35 days after deposit'}`, { size: 9, gap: 12 });

  if (opts.bank?.name || opts.bank?.account) {
    add('BANK DETAILS', { size: 9, bold: true, gap: 2 });
    add(`Beneficiary: ${opts.bank.beneficiary ?? opts.from?.company ?? '-'}`, { size: 8.5, gap: 1 });
    add(`Bank: ${opts.bank.name ?? '-'}`, { size: 8.5, gap: 1 });
    add(`Account: ${opts.bank.account ?? '-'}    SWIFT: ${opts.bank.swift ?? '-'}`, { size: 8.5, gap: 12 });
  }

  for (const note of wrap(opts.notes ?? '', 95)) {
    add(`Note: ${note}`, { size: 8, gap: 2 });
  }
  add('This proforma invoice is for quotation/customs estimation and is not a final commercial invoice.', { size: 8, gap: 16 });

  add('SELLER SIGNATURE', { size: 9, bold: true, gap: 2 });
  add('_______________________', { size: 9, gap: 2 });
  add(opts.from?.company ?? '', { size: 9, gap: 2 });
  add('BUYER ACCEPTANCE (optional)', { size: 9, bold: true, gap: 2 });
  add('_______________________', { size: 9, gap: 2 });
  add(opts.to?.company ?? '', { size: 9 });

  return renderPdf(lines);
}

/** 共用渲染：lines → 分页 → PDF 对象组装。 */
function renderPdf(lines) {
  const pagesContent = [];
  let current = [];
  let y = 800;
  for (const line of lines) {
    if (y < 50) {
      pagesContent.push(current);
      current = [];
      y = 800;
    }
    current.push({ ...line, y });
    y -= line.size + line.gap;
  }
  if (current.length > 0) {
    pagesContent.push(current);
  }

  const objects = []; // {id, body}
  const push = (body) => {
    objects.push(body);
    return objects.length; // 1-based id
  };

  const fontId = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBoldId = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds = [];
  const contentIds = [];

  for (const page of pagesContent) {
    const parts = [];
    for (const line of page) {
      parts.push(`BT /${line.bold ? 'F2' : 'F1'} ${line.size} Tf 50 ${line.y} Td (${esc(line.text)}) Tj ET`);
    }
    const stream = parts.join('\n');
    const contentId = push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    contentIds.push(contentId);
  }
  const pagesId = objects.length + pagesContent.length + 1; // 预留
  for (const contentId of contentIds) {
    const pageId = push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  const realPagesId = push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  // pagesId 占位与 realPagesId 相等时无需修正（我们预留的数量恰好一致）
  const catalogId = push(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

export function quoteFileName(quoteNo) {
  return `quote-${quoteNo || createHash('md5').update(String(Date.now())).digest('hex').slice(0, 8)}.pdf`;
}
