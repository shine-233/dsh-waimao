// DDG HTML 解析器 fixture 测试（离线，基于 html.duckduckgo.com 的稳定标记）。
import assert from 'node:assert';

// 从 serp.js 内部拿不到私有函数，直接复制其导出面：用一次假 fetch 注入。
// 这里用 module registry 不好 mock，改为直接构造 HTML 并调用 parseDdgHtml 的
// 逻辑副本？不 —— 更可靠的方式：临时替换 globalThis.fetch，让 searchDdg 走
// fixture。serp.js 的 httpFetch 在无代理时调用 global fetch，可被替换。
const FIXTURE = `
<html><body>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example-motor.com%2Fwhatsapp&rut=abc123">
        Buy <b>Hair Dryer</b> in Bulk - Example Motor Co.
      </a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example-motor.com%2Fwhatsapp&rut=abc123">We are <b>looking for</b> hair dryer wholesale partners. WhatsApp +52 155 1234.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://www.direct-link.org/page">Direct Link Title &amp; More</a>
    </h2>
    <a class="result__snippet" href="#">Second snippet with &quot;quoted&quot; text</a>
  </div>
</div>
</body></html>`;

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () => FIXTURE,
});

try {
  const { serpSearch } = await import('../dsh/serp.js');
  const results = await serpSearch('test query', { config: { serp: { engine: 'ddg', serpapiKey: '', perLayer: 10, proxy: '' } }, signal: AbortSignal.timeout(5000) });
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://www.example-motor.com/whatsapp');
  assert.equal(results[0].title, 'Buy Hair Dryer in Bulk - Example Motor Co.');
  assert.ok(results[0].snippet.includes('looking for'));
  assert.equal(results[1].url, 'https://www.direct-link.org/page');
  assert.ok(results[1].title.includes('& More'));
  assert.ok(results[1].snippet.includes('"quoted"'));
  console.log('DDG parser fixture PASSED');
} finally {
  globalThis.fetch = realFetch;
}
