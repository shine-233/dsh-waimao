// 三层搜索公式（与课程公式一致，排除同行：-alibaba -made-in-china
// -globalsources -supplier -manufacturer）。欧美走邮件 + LinkedIn，亚非拉走
// WhatsApp。
const EXCLUDE_COMPETITORS = [
  '-alibaba',
  '-made-in-china',
  '-globalsources',
  '-"wholesale supplier"',
  '-manufacturer',
];

const BUYER_TITLES = [
  '"Purchasing Manager"',
  '"Import Manager"',
  '"Sourcing Manager"',
  '"Procurement Manager"',
  '"Head of Procurement"',
];

const BUY_SIGNALS = [
  '"we buy"',
  '"looking for"',
  '"need supplier"',
  '"seeking supplier"',
  '"distributor wanted"',
  '"importer wanted"',
  '"agent wanted"',
];

/**
 * Build the search layers for one product + market.
 *
 * @param {string} product  English product keyword, e.g. "hair dryer"
 * @param {{label: string, dial: string, style: string, key: string}} market
 * @param {{layers?: number[]}} [opts]  subset of layers to build (default all)
 * @returns {Array<{id: number, name: string, query: string}>}
 */
export function buildLayers(product, market, opts = {}) {
  const wanted = Array.isArray(opts.layers) && opts.layers.length > 0
    ? opts.layers
    : [1, 2, 3];
  const q = `"${product}"`;
  const exclude = EXCLUDE_COMPETITORS.join(' ');
  const all = [];

  // 第 1 层 · 基础搜索：产品词 + WhatsApp/联系方式 + 区号
  if (wanted.includes(1)) {
    all.push({
      id: 1,
      name: '基础搜索',
      query: market.style === 'whatsapp'
        ? `${q} WhatsApp +${market.dial}`
        : `${q} ("contact us" OR email)${market.dial ? ` +${market.dial}` : ''}`,
    });
  }

  // 第 2 层 · LinkedIn 职位定向：找采购决策人
  if (wanted.includes(2)) {
    all.push({
      id: 2,
      name: 'LinkedIn 定位',
      query: `${q} (${BUYER_TITLES.join(' OR ')}) site:linkedin.com ${exclude}`,
    });
  }

  // 第 3 层 · 采购信号：明确想买的人
  if (wanted.includes(3)) {
    all.push({
      id: 3,
      name: '采购信号',
      query: `${q} (${BUY_SIGNALS.join(' OR ')}) ${exclude}`,
    });
  }

  return all;
}
