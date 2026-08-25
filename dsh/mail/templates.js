// 双语开发信模板（EN 默认，拉美市场自动切西语）+ Day 1/3/7/14 跟进序列。
// 模板是兜底：有 DeepSeek key 时 compose.js 会生成个性化版本。

export function isLatam(marketKeyOrDial) {
  return ['mx', 'br' /* br 用葡语但西语可通 */, 'ar', 'cl', 'co', 'pe', '+52', '+55', '+54', '+56', '+57', '+51']
    .includes(String(marketKeyOrDial ?? '').toLowerCase());
}

export function languageFor(market) {
  const key = String(market ?? '').toLowerCase();
  if (key === 'br' || key === '+55') {
    return 'pt';
  }
  if (['mx', 'ar', 'cl', 'co', 'pe', '+52', '+54', '+56', '+57', '+51'].includes(key)) {
    return 'es';
  }
  return 'en';
}

const T = {
  en: {
    subject: (product, company) => `${product} supply for ${company} — factory direct`,
    body: ({ name, company, product, me, features }) =>
      [
        `Hi ${name || 'there'},`,
        '',
        `I'm ${me}. We supply ${product} to importers and wholesalers — ${features}.`,
        '',
        `Noticed ${company || 'your company'} works in this line, so I thought it's worth connecting.`,
        '',
        'Would you like our latest catalog with FOB reference prices?',
        '',
        'Best regards,',
        me,
      ].join('\n'),
  },
  es: {
    subject: (product, company) => `Suministro de ${product} para ${company} — directo de fábrica`,
    body: ({ name, company, product, me, features }) =>
      [
        `Hola ${name || 'que tal'},`,
        '',
        `Soy ${me}. Suministramos ${product} a importadores y mayoristas — ${features}.`,
        '',
        `Vimos que ${company || 'su empresa'} trabaja en este rubro y nos gustaría conectar.`,
        '',
        '¿Le interesa recibir nuestro catálogo con precios FOB de referencia?',
        '',
        'Saludos cordiales,',
        me,
      ].join('\n'),
  },
  pt: {
    subject: (product, company) => `Fornecimento de ${product} para ${company} — direto de fábrica`,
    body: ({ name, company, product, me, features }) =>
      [
        `Olá ${name || 'tudo bem'},`,
        '',
        `Sou ${me}. Fornecemos ${product} para importadores e atacadistas — ${features}.`,
        '',
        `Vimos que a ${company || 'sua empresa'} atua nesse segmento e gostaríamos de nos conectar.`,
        '',
        'Gostaria de receber nosso catálogo com preços FOB de referência?',
        '',
        'Atenciosamente,',
        me,
      ].join('\n'),
  },
};

export const UNSUBSCRIBE_FOOTER = {
  en: 'If you\'d rather not hear from me again, just reply "STOP".',
  es: 'Si no desea recibir más mensajes, responda "ALTO".',
  pt: 'Se não quiser receber mais mensagens, responda "PARAR".',
};

/** 追加退订脚注（合规）。 */
export function withUnsubscribeFooter(draft, language) {
  const footer = UNSUBSCRIBE_FOOTER[language] ?? UNSUBSCRIBE_FOOTER.en;
  if (String(draft.body ?? '').includes(footer)) {
    return draft;
  }
  return { ...draft, body: `${draft.body}\n\n--\n${footer}` };
}

export const FOLLOW_UPS = [
  {
    day: 3,
    subject: (p) => `Re: ${p} supply`,
    body: { en: (c) => `Hi ${c.name || 'there'},\n\nJust floating this up in case it got buried. Catalog and FOB list are ready whenever you are.\n\nBest,\n${c.me}`, es: (c) => `Hola ${c.name || 'que tal'},\n\nRetomo el mensaje por si quedó pendiente. El catálogo y precios FOB están listos cuando guste.\n\nSaludos,\n${c.me}` },
  },
  {
    day: 7,
    subject: (p) => `${p} — catalog + price list attached`,
    body: { en: (c) => `Hi ${c.name || 'there'},\n\nAttaching our catalog. If ${c.product} is not your line, happy to refer you to someone who buys from us regularly.\n\nBest,\n${c.me}`, es: (c) => `Hola ${c.name || 'que tal'},\n\nAdjunto nuestro catálogo. Si ${c.product} no es su rubro, con gusto le referimos a alguien que nos compra habitualmente.\n\nSaludos,\n${c.me}` },
  },
  {
    day: 14,
    subject: (p) => `Last note re: ${p}`,
    body: { en: (c) => `Hi ${c.name || 'there'},\n\nLast note from me — if sourcing ${c.product} is on your roadmap this quarter, reply "catalog" and I'll send it over. Otherwise I won't keep bothering you.\n\nBest,\n${c.me}`, es: (c) => `Hola ${c.name || 'que tal'},\n\nÚltima nota — si comprar ${c.product} está en sus planes este trimestre, responda "catálogo" y se lo envío. Si no, no insisto más.\n\nSaludos,\n${c.me}` },
  },
];

/** 首封开发信模板。ctx: {name, company, product, me, features, market} */
export function firstEmail(ctx) {
  const lang = ctx.language ?? languageFor(ctx.market);
  const pack = T[lang] ?? T.en;
  return {
    language: lang,
    subject: pack.subject(ctx.product ?? 'our products', ctx.company ?? ''),
    body: pack.body(ctx),
  };
}

/** 第 N 封跟进（n=1,2,3 → Day3/7/14）。 */
export function followUp(ctx, n) {
  const lang = ctx.language ?? languageFor(ctx.market);
  const step = FOLLOW_UPS[Math.max(0, Math.min(n - 1, FOLLOW_UPS.length - 1))];
  const vars = { ...ctx, product: ctx.product ?? 'our products' };
  return {
    language: lang,
    day: step.day,
    subject: step.subject(vars.product),
    body: step.body[lang] ? step.body[lang](vars) : step.body.en(vars),
  };
}

export const SEQUENCE_PLAN = [
  { day: 0, label: '首封开发信' },
  { day: 3, label: '轻提醒' },
  { day: 7, label: '附目录+退路话术' },
  { day: 14, label: '最后跟进(可回复即停)' },
];
