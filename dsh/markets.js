// 目标市场预设。亚非拉买家习惯 WhatsApp，欧美习惯邮件 + LinkedIn —— 搜索
// 公式随 style 切换（与课程公式一致）。dial 是国际区号（不带 +）。
// utc 是大致时区偏移（小时，用于发送时间窗判断，夏令时不做精调）。
export const MARKETS = {
  mx: { label: '墨西哥', dial: '52', style: 'whatsapp', utc: -6 },
  ae: { label: '迪拜/阿联酋', dial: '971', style: 'whatsapp', utc: 4 },
  sa: { label: '沙特', dial: '966', style: 'whatsapp', utc: 3 },
  br: { label: '巴西', dial: '55', style: 'whatsapp', utc: -3 },
  id: { label: '印尼', dial: '62', style: 'whatsapp', utc: 7 },
  in: { label: '印度', dial: '91', style: 'whatsapp', utc: 5.5 },
  ng: { label: '尼日利亚', dial: '234', style: 'whatsapp', utc: 1 },
  tr: { label: '土耳其', dial: '90', style: 'whatsapp', utc: 3 },
  th: { label: '泰国', dial: '66', style: 'whatsapp', utc: 7 },
  vn: { label: '越南', dial: '84', style: 'whatsapp', utc: 7 },
  ph: { label: '菲律宾', dial: '63', style: 'whatsapp', utc: 8 },
  pk: { label: '巴基斯坦', dial: '92', style: 'whatsapp', utc: 5 },
  us: { label: '美国', dial: '1', style: 'email', utc: -5 },
  ca: { label: '加拿大', dial: '1', style: 'email', utc: -5 },
  uk: { label: '英国', dial: '44', style: 'email', utc: 0 },
  de: { label: '德国', dial: '49', style: 'email', utc: 1 },
  eu: { label: '欧洲(通用)', dial: '', style: 'email', utc: 1 },
  global: { label: '全球(不限)', dial: '', style: 'email', utc: 0 },
};

/**
 * Accepts a preset key ('mx'), a Chinese label ('墨西哥'), or a raw dial code
 * ('+52' / '52'). Raw codes default to the WhatsApp style, which is what the
 * dial-code formula exists for.
 */
export function resolveMarket(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') {
    return { ...MARKETS.mx, key: 'mx' };
  }
  const key = raw.toLowerCase();
  if (Object.hasOwn(MARKETS, key)) {
    return { ...MARKETS[key], key };
  }
  for (const [presetKey, market] of Object.entries(MARKETS)) {
    if (market.label === raw) {
      return { ...market, key: presetKey };
    }
  }
  const dial = raw.replace(/^\+/, '').replace(/\D/g, '');
  if (dial !== '') {
    return { label: `+${dial}`, dial, style: 'whatsapp', key: `+${dial}` };
  }
  throw new Error(
    `unknown market: ${input}. Use a preset key (${Object.keys(MARKETS).join('/')}) or a dial code like +52`,
  );
}

export function marketOptions() {
  return Object.entries(MARKETS).map(([key, market]) => ({
    key,
    label: market.label,
    dial: market.dial,
    style: market.style,
  }));
}
