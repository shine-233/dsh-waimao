// 页面静态一致性检查：
//  1) 内联 JS 里 getElementById('x') 的每个 id 必须出现在页面 HTML 里
//  2) 内联 HTML 属性处理器（onclick/onchange/oninput/onkeydown/onsubmit）引用的函数必须在脚本里定义
//  3) api('api/...') 调用的端点必须在插件路由里注册
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const pagesMod = await import('../dsh/pages.js');
const plugin = await import('../dsh/index.js');

// 收集路由
const routes = new Map();
plugin.apply({
  tools: { register: () => {} },
  inject: (names, fn) => fn({ webServer: { register: (r) => routes.set(r.path, r) } }),
});
const routePaths = [...routes.keys()];

const pageFns = [
  ['leads', pagesMod.leadsPage],
  ['crm', pagesMod.crmPage],
  ['review', pagesMod.reviewPage],
  ['settings', pagesMod.settingsPage],
  ['templates', pagesMod.templatesPage],
];

let issues = 0;
for (const [name, fn] of pageFns) {
  const html = fn();

  // ---- 提取 <script> 内容（页面主脚本；SHARED_JS 已包含在内）----
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const js = scripts.join('\n');

  // ---- 1) getElementById 的 id 必须存在 ----
  // 动态创建的 id（出现在 JS 字符串拼接里的 id="..."）也算存在
  const htmlAndJs = html; // id="xxx" 可能出现在模板字符串里，全文搜索
  const definedIds = new Set([...htmlAndJs.matchAll(/id=["']([\w-]+)["']/g)].map((m) => m[1]));
  // JS 里动态 id- 前缀拼接：'id-'+xxx / #tab-'+key 等，提取前缀
  const dynamicPrefixes = [...js.matchAll(/['"`]id-['"`]\s*\+/g)].map(() => 'id-');
  const requested = [...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  // 拼接型调用 getElementById('pc-'+k) → 前缀 pc-
  const concatCalls = [...js.matchAll(/getElementById\(\s*['"]([\w-]+)-['"]\s*\+/g)].map((m) => m[1]);
  for (const id of requested) {
    if (!definedIds.has(id)) {
      console.log(`[${name}] getElementById('${id}') 在 HTML 中不存在`);
      issues += 1;
    }
  }
  for (const prefix of concatCalls) {
    const hasAny = [...definedIds].some((id) => id.startsWith(`${prefix}-`));
    if (!hasAny) {
      console.log(`[${name}] getElementById('${prefix}-'+…) 没有任何匹配的动态 id`);
      issues += 1;
    }
  }

  // ---- 2) 内联事件处理器引用的函数必须已定义 ----
  const handlerBodies = [...html.matchAll(/\son(?:click|change|input|keydown|submit|load)=["']([^"']+)["']/g)].map((m) => m[1]);
  const calledFns = new Set();
  for (const body of handlerBodies) {
    for (const m of body.matchAll(/(?<![\w.$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const fnName = m[1];
      if (['if', 'for', 'while', 'return', 'event', 'window', 'document'].includes(fnName)) continue;
      calledFns.add(fnName);
    }
  }
  const definedFns = new Set([
    ...[...js.matchAll(/function\s+([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...js.matchAll(/(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:function|\()/g)].map((m) => m[1]),
    'esc', '$', '$$', 'toast', 'toastErr', 'api', 'modal', 'closeModal', 'confirmBox', 'countUp',
    'donut', 'hbar', 'funnel', 'sparkline', 'confetti', 'initCmdk',
  ]);
  for (const fnName of calledFns) {
    if (!definedFns.has(fnName)) {
      console.log(`[${name}] 内联处理器调用 ${fnName}() 但脚本里没有定义`);
      issues += 1;
    }
  }

  // ---- 3) api() 调用的端点必须有对应路由 ----
  const apiCalls = [...js.matchAll(/api\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const endpoint of apiCalls) {
    const full = `/waimao/${endpoint.replace(/^\//, '')}`;
    const hit = routePaths.some((p) => p === full || full.startsWith(p));
    if (!hit) {
      console.log(`[${name}] api('${endpoint}') 没有对应路由（找 ${full}）`);
      issues += 1;
    }
  }

  // ---- 4) window.open 的相对端点也要存在 ----
  for (const m of js.matchAll(/window\.open\(\s*['"]([^'"]+)['"]/g)) {
    const ep = m[1].split('?')[0];
    const full = `/waimao/${ep.replace(/^\//, '')}`;
    if (!ep.startsWith('http') && !routePaths.some((p) => p === full)) {
      console.log(`[${name}] window.open('${m[1]}') 没有对应路由`);
      issues += 1;
    }
  }
}

assert.equal(issues, 0, `${issues} 个页面一致性问题`);
console.log('PAGE CONSISTENCY CHECKS PASSED');
