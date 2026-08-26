// 外贸定价计算器：EXW/FOB/CFR/CIF/DDP 叠加成本 + 利润率报价。
// Incoterms 成本叠加规则（Incoterms 2020）：
//   EXW = 出厂价
//   FOB = EXW + 国内内陆运费 + 港口/报关费
//   CFR = FOB + 海运费
//   CIF = CFR + 保险（保险率 × CFR；教科书为 CIF×110%×r，此处按 CFR×r 近似）
//   DDP = CIF + 关税(dutyRate% × CIF) + 目的港清关费 + 目的地内陆运费
// 口径约定：
//   mode='total' —— 所有输入都是整批金额；
//   mode='unit'  —— exw/inland/port 为"单件"成本，
//                   ocean/dest/destFreight（海运/清关/目的地运费）按整批金额不乘 qty。
// 利润率加在最终报价上。

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * @param {object} opts
 *  mode: 'total'(整批金额，默认) | 'unit'(单件成本，运费除外)
 *  exw: 出厂成本 | inland: 国内运费 | port: 港口/报关费
 *  ocean: 海运费 | insuranceRate: 保险费率(%，基于CFR)
 *  dutyRate: 目的国关税+增值税综合税率(%，基于CIF，DDP 必填否则严重低估)
 *  dest: 目的港清关费 | destFreight: 目的地运费
 *  margin: 利润率(%，如 25 表示加 25%) | qty: 数量
 */
export function calcPrice(opts = {}) {
  const mode = opts.mode === 'unit' ? 'unit' : 'total';
  const qty = Math.max(1, Number(opts.qty ?? 1));
  const scale = mode === 'unit' ? qty : 1;

  const exw = Number(opts.exw ?? 0) * scale;
  const inland = Number(opts.inland ?? 0) * scale;
  const port = Number(opts.port ?? 0) * scale;
  const ocean = Number(opts.ocean ?? 0);
  const insuranceRate = Number(opts.insuranceRate ?? 0) / 100;
  const dutyRate = Number(opts.dutyRate ?? 0) / 100;
  const dest = Number(opts.dest ?? 0);
  const destFreight = Number(opts.destFreight ?? 0);
  const margin = Number(opts.margin ?? 0) / 100;

  const fob = exw + inland + port;
  const cfr = fob + ocean;
  const insurance = cfr * insuranceRate;
  const cif = cfr + insurance;
  const duty = cif * dutyRate;
  const ddp = cif + duty + dest + destFreight;

  const withMargin = (cost) => round2(cost * (1 + margin));

  return {
    mode,
    qty,
    cost: {
      EXW: round2(exw),
      FOB: round2(fob),
      CFR: round2(cfr),
      CIF: round2(cif),
      duty: round2(duty),
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
    // 单件报价
    perUnit: {
      FOB: round2(withMargin(fob) / qty),
      CIF: round2(withMargin(cif) / qty),
      DDP: round2(withMargin(ddp) / qty),
    },
    margin: `${Math.round(margin * 100)}%`,
    notes: [
      'FOB 适用于海运；空运对应 FCA。',
      'CIF 保险按 CFR × 保险率计（110% 投保惯例可自行上调 insuranceRate）。',
      'DDP 的关税按 CIF × dutyRate 计——巴西约60%、欧盟约20%+VAT，漏报会直接亏本；不确定就先报 CIF/DDU。',
      mode === 'unit'
        ? 'unit 口径：exw/inland/port 为单件成本；ocean/dest/destFreight（海运费/清关费/目的地运费）按整批金额，不乘数量。'
        : 'total 口径：所有输入均为整批金额。',
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
