// 外贸定价计算器：EXW/FOB/CRF/CIF/DDP 叠加成本 + 利润率报价。
// Incoterms 成本叠加规则（Incoterms 2020）：
//   EXW = 出厂价
//   FOB = EXW + 国内内陆运费 + 港口/报关费
//   CFR = FOB + 海运费
//   CIF = CFR + 保险（保险率 × CFR）
//   DDP = CIF + 目的港清关费 + 目的地内陆运费
// 支持整柜金额或单件成本两种输入；利润率加在最终报价上。

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * @param {object} opts
 *  mode: 'total'(整批金额，默认) | 'unit'(单件成本)
 *  exw: 出厂成本 | inland: 国内运费 | port: 港口/报关费
 *  ocean: 海运费 | insuranceRate: 保险费率(%，基于CFR) | dest: 目的港清关费 | destFreight: 目的地运费
 *  margin: 利润率(%，如 25 表示加 25%) | qty: 数量（mode=unit 时用于算总额）
 */
export function calcPrice(opts = {}) {
  const mode = opts.mode === 'unit' ? 'unit' : 'total';
  const qty = Math.max(1, Number(opts.qty ?? 1));
  const div = mode === 'unit' ? 1 : 1; // 输入即整批口径；unit 模式输入为单件，乘 qty 得整批
  const scale = mode === 'unit' ? qty : 1;

  const exw = Number(opts.exw ?? 0) * scale;
  const inland = Number(opts.inland ?? 0) * (mode === 'unit' ? qty : 1);
  const port = Number(opts.port ?? 0) * (mode === 'unit' ? qty : 1);
  const ocean = Number(opts.ocean ?? 0);
  const insuranceRate = Number(opts.insuranceRate ?? 0) / 100;
  const dest = Number(opts.dest ?? 0);
  const destFreight = Number(opts.destFreight ?? 0);
  const margin = Number(opts.margin ?? 0) / 100;

  const fob = exw + inland + port;
  const cfr = fob + ocean;
  const insurance = cfr * insuranceRate;
  const cif = cfr + insurance;
  const ddp = cif + dest + destFreight;

  const withMargin = (cost) => round2(cost * (1 + margin));

  return {
    mode,
    qty: mode === 'unit' ? qty : (Number(opts.qty ?? 1) || 1),
    cost: {
      EXW: round2(exw),
      FOB: round2(fob),
      CFR: round2(cfr),
      CIF: round2(cif),
      DDP: round2(ddp),
      insurance: round2(insurance),
    },
    quote: {
      EXW: withMargin(exw),
      FOB: withMargin(fob),
      CFR: withMargin(cfr),
      CIF: withMargin(cif),
      DDP: withMargin(ddp),
    },
    // 单件报价（整批口径时除以数量）
    perUnit: (() => {
      const n = mode === 'unit' ? qty : (Number(opts.qty ?? 1) || 1);
      return {
        FOB: n > 0 ? round2(withMargin(fob) / n) : 0,
        CIF: n > 0 ? round2(withMargin(cif) / n) : 0,
      };
    })(),
    margin: `${Math.round(margin * 100)}%`,
    notes: [
      'FOB 适用于海运；空运对应 FCA。',
      'CIF 保险按 CFR × 保险率计（110% 投保惯例可自行上调 insuranceRate）。',
      'DDP 需确认目的国清关与税费，风险最高，慎用。',
    ],
  };
}

/** 生成给客户看的三档报价文本（EXW/FOB/CIF，最常用）。 */
export function quoteLines(calc, { currency = 'USD' } = {}) {
  const q = calc.quote;
  return [
    `EXW: ${currency} ${q.EXW.toLocaleString('en-US')}`,
    `FOB: ${currency} ${q.FOB.toLocaleString('en-US')}  (≈ ${currency} ${calc.perUnit.FOB}/pc @ ${calc.qty}pcs)`,
    `CIF: ${currency} ${q.CIF.toLocaleString('en-US')}  (≈ ${currency} ${calc.perUnit.CIF}/pc @ ${calc.qty}pcs)`,
  ];
}
