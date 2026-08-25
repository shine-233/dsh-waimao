// 两个回环页面：谷歌获客（/waimao/leads）与客服审核台（/waimao/review）。
// 单文件 HTML + 原生 JS，深色主题，直接调用同源 /waimao/api/* 路由。
// 注意：页面内脚本刻意不用模板字符串，避免与宿主模板字面量冲突。

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; }
h1 { font-size: 20px; margin: 0 0 4px; color: #58a6ff; }
.sub { color: #8b949e; margin-bottom: 20px; }
.panel { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 18px; margin-bottom: 18px; }
.panel h2 { font-size: 15px; margin: 0 0 14px; padding-left: 8px; border-left: 3px solid #58a6ff; }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 12px; color: #8b949e; }
input, select, textarea { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; padding: 8px 10px; font: inherit; }
input:focus, select:focus, textarea:focus { outline: 1px solid #58a6ff; }
button { background: #1f6feb; border: none; color: #fff; border-radius: 6px; padding: 9px 16px; font: inherit; cursor: pointer; }
button:hover { background: #388bfd; }
button.ghost { background: #21262d; border: 1px solid #30363d; }
button.ghost:hover { background: #30363d; }
button:disabled { opacity: .5; cursor: wait; }
.formula { background: #161b22; border: 1px dashed #30363d; border-radius: 8px; padding: 10px 14px; color: #d29922; font-size: 13px; margin-bottom: 18px; }
.badge { display: inline-block; background: #1f6feb; color: #fff; border-radius: 999px; font-size: 12px; padding: 2px 10px; margin: 14px 0 8px; }
.badge.gray { background: #30363d; color: #8b949e; }
table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
th { color: #58a6ff; font-weight: 600; background: #161b22; }
tr:last-child td { border-bottom: none; }
td.num { color: #8b949e; width: 34px; }
td.t { width: 34%; word-break: break-all; }
td.s { color: #8b949e; }
.err { color: #f85149; }
.ok { color: #3fb950; }
.msg { margin: 10px 0; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.card .meta { color: #8b949e; font-size: 12px; margin-bottom: 6px; }
.card .text { white-space: pre-wrap; margin-bottom: 10px; }
.card textarea { width: 100%; min-height: 64px; margin-bottom: 8px; }
.actions { display: flex; gap: 8px; }
.status { font-size: 13px; color: #8b949e; }
.pill { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; border: 1px solid #30363d; margin-right: 6px; }
.pill.on { color: #3fb950; border-color: #238636; }
.pill.off { color: #f85149; border-color: #b62324; }
`;

const COMMON_HEAD = (title) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${title}</title><style>${STYLE}</style></head><body><div class="wrap">`;

const FOOTER = `</div></body></html>`;

function leadsPage() {
  return (
    COMMON_HEAD('谷歌获客 · 三层搜索') +
    `<h1>🌐 谷歌获客 <span class="status">dsh-waimao · Google SERP 三层搜索</span></h1>` +
    `<div class="sub">输入产品英文词 + 目标市场 → 自动按「基础搜索 → LinkedIn 定位 → 采购信号」三层叠加，逐层去重，带公司、带职位、排除同行的 WhatsApp/LinkedIn 联系人候选。</div>` +
    `<div class="formula">💡 课程公式："产品词" WhatsApp [+区号] site:linkedin.com -alibaba -made-in-china -globalsources -supplier -manufacturer。欧美走邮件+LinkedIn，亚非拉走 WhatsApp。</div>` +
    `<div class="panel"><h2>搜索</h2>` +
    `<div class="row">` +
    `<div class="field" style="flex:2 1 260px"><label>产品关键词（英文）</label><input id="product" placeholder="hair dryer"></div>` +
    `<div class="field"><label>目标市场</label><select id="market"></select></div>` +
    `<div class="field"><label>搜索层级</label><select id="layers">` +
    `<option value="1,2,3">三层全叠加（最精）</option><option value="1,3">基础+采购信号</option>` +
    `<option value="1">第1层·基础搜索</option><option value="2">第2层·LinkedIn 定位</option>` +
    `<option value="3">第3层·采购信号</option></select></div>` +
    `<div class="field"><label>每层条数</label><select id="perLayer">` +
    `<option>5</option><option selected>10</option><option>20</option><option>30</option></select></div>` +
    `<div class="field"><label>引擎</label><select id="engine">` +
    `<option value="ddg">DuckDuckGo（免key）</option><option value="serpapi">SerpAPI(Google)</option>` +
    `<option value="literal">仅生成公式（不搜索）</option></select></div>` +
    `<button id="go">🔍 开始搜索</button>` +
    `</div><div class="msg status" id="status"></div></div>` +
    `<div id="result"></div>` +
    `<script>` +
    `var sel = document.getElementById('market');` +
    `fetch('api/markets').then(function(r){return r.json()}).then(function(list){` +
    `list.forEach(function(m){var o=document.createElement('option');o.value=m.key;o.textContent=m.label+(m.dial?' +'+m.dial:'');sel.appendChild(o)})` +
    `});` +
    `document.getElementById('go').onclick = function(){` +
    `var product = document.getElementById('product').value.trim();` +
    `if(!product){document.getElementById('status').textContent='请输入产品关键词';return;}` +
    `var btn=this; btn.disabled=true;` +
    `document.getElementById('status').textContent='搜索中…（三层逐层进行，每层之间稍作停顿）';` +
    `document.getElementById('result').innerHTML='';` +
    `fetch('api/leads/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({` +
    `product:product, market:sel.value, layers:document.getElementById('layers').value.split(',').map(Number),` +
    `perLayer:Number(document.getElementById('perLayer').value), engine:document.getElementById('engine').value})})` +
    `.then(function(r){return r.json().then(function(j){return {ok:r.ok, j:j}})})` +
    `.then(function(res){` +
    `btn.disabled=false;` +
    `if(!res.ok){document.getElementById('status').innerHTML='<span class="err">'+esc(res.j.error||'搜索失败')+'</span>';return;}` +
    `render(res.j);` +
    `}).catch(function(e){btn.disabled=false;document.getElementById('status').innerHTML='<span class="err">'+esc(String(e))+'</span>'});` +
    `};` +
    `function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}` +
    `function render(run){` +
    `var box=document.getElementById('result');` +
    `document.getElementById('status').innerHTML='<span class="ok">完成：'+run.total+' 条结果（已逐层去重）。run: '+run.id+'</span>';` +
    `var head='<div class="row" style="margin-bottom:10px"><button class="ghost" onclick="exportCsv(\\''+run.id+'\\')">⬇ 导出 CSV</button>' +` +
    `'<button class="ghost" onclick="copyLinks()">📋 复制全部链接</button>' +` +
    `'<span class="status" id="copyTip"></span></div>';` +
    `var html=head; var byLayer={};` +
    `run.results.forEach(function(it){(byLayer[it.layer]=byLayer[it.layer]||[]).push(it)});` +
    `run.layers.forEach(function(layer){` +
    `html+='<div class="badge">第'+layer.id+'层 · '+esc(layer.name)+'</div>';` +
    `html+='<div class="status" style="margin-bottom:8px">公式：<code>'+esc(layer.query)+'</code>'+(layer.error?' <span class=\"err\">[错误: '+esc(layer.error)+']</span>':'')+'</div>';` +
    `var rows=byLayer[layer.id]||[];` +
    `if(rows.length===0){html+='<table><tr><td class="s">（本层无结果）</td></tr></table>';return;}` +
    `html+='<table><tr><th>#</th><th>标题 / 链接</th><th>摘要</th></tr>';` +
    `rows.forEach(function(it,i){` +
    `html+='<tr><td class="num">'+(i+1)+'</td><td class="t"><a href="'+esc(it.url)+'" target="_blank" rel="noopener">'+esc(it.title)+'</a><br><span class="status">'+esc(it.url)+'</span></td><td class="s">'+esc(it.snippet)+'</td></tr>';` +
    `});` +
    `html+='</table>';` +
    `});` +
    `window.__lastRun=run; box.innerHTML=html;` +
    `}` +
    `function exportCsv(runId){window.open('api/leads/export.csv?run='+encodeURIComponent(runId),'_blank');}` +
    `function copyLinks(){` +
    `var run=window.__lastRun||{}; var urls=(run.results||[]).map(function(it){return it.url});` +
    `navigator.clipboard.writeText(urls.join('\\n')).then(function(){document.getElementById('copyTip').textContent='已复制 '+urls.length+' 条链接';});` +
    `}` +
    `</script>` +
    FOOTER
  );
}

function reviewPage() {
  return (
    COMMON_HEAD('XMT 客服审核台') +
    `<h1>💬 WhatsApp 客服审核台 <span class="status">dsh-waimao · AI 起草 · 人工审核</span></h1>` +
    `<div class="sub">Evolution API 收到的买家消息先进待审队列；AI 生成草稿，人工确认后才真正发出。</div>` +
    `<div class="panel"><div class="row" style="align-items:center">` +
    `<span id="pills" class="status">加载中…</span>` +
    `<span style="flex:1"></span>` +
    `<button class="ghost" id="refresh">↻ 刷新队列</button>` +
    `</div></div>` +
    `<div id="queue"></div>` +
    `<script>` +
    `function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}` +
    `function fmtTs(t){try{return new Date(t).toLocaleString('zh-CN')}catch(e){return t}}` +
    `function loadStatus(){fetch('api/status').then(function(r){return r.json()}).then(function(s){` +
    `var pills='';` +
    `pills+='<span class="pill '+(s.evolution.ready?'on':'off')+'">Evolution API '+(s.evolution.ready?'已连接':'未配置')+'</span>';` +
    `pills+='<span class="pill '+(s.webhookTokenSet?'on':'off')+'">Webhook token '+(s.webhookTokenSet?'已设置':'未设置')+'</span>';` +
    `pills+='<span class="pill '+(s.deepseek.ready?'on':'off')+'">AI 草稿 '+(s.deepseek.ready?'可用':'未配key(可让智能体起草)')+'</span>';` +
    `pills+='<span class="pill '+(s.serp.engine==='serpapi'||true?'':'')+'">SERP: '+esc(s.serp.engine)+'</span>';` +
    `document.getElementById('pills').innerHTML=pills;` +
    `});}` +
    `function loadQueue(){fetch('api/review/queue?limit=50').then(function(r){return r.json()}).then(function(list){` +
    `var box=document.getElementById('queue');` +
    `if(!list.length){box.innerHTML='<div class="panel"><h2>待审消息</h2><span class="status">队列为空。确认 Evolution webhook 已指向 /waimao/webhook/evolution?token=...，或让智能体调用 wa_sync 拉取。</span></div>';return;}` +
    `var html='<div class="panel"><h2>待审消息（'+list.length+'）</h2>';` +
    `list.forEach(function(m){` +
    `html+='<div class="card" id="m-'+esc(m.id)+'">' +` +
    `'<div class="meta">'+esc(m.name||m.sender)+' · '+esc(m.chatJid)+' · '+fmtTs(m.ts)+' · 状态: '+esc(m.status)+'</div>' +` +
    `'<div class="text">'+esc(m.text)+'</div>' +` +
    `'<textarea placeholder="回复内容（可先用 AI 草稿）">'+esc(m.draft||'')+'</textarea>' +` +
    `'<div class="actions">' +` +
    `'<button onclick="draft(\\''+esc(m.id)+'\\',this)">✨ AI 草稿</button>' +` +
    `'<button onclick="send(\\''+esc(m.id)+'\\',this)">✅ 审核通过并发送</button>' +` +
    `'<button class="ghost" onclick="ignore(\\''+esc(m.id)+'\\',this)">忽略</button>' +` +
    `'</div><div class="msg status"></div></div>';` +
    `});` +
    `html+='</div>'; box.innerHTML=html;` +
    `});}` +
    `document.getElementById('refresh').onclick=function(){loadQueue()};` +
    `function cardOf(id){return document.getElementById('m-'+CSS.escape(id));}` +
    `function tipOf(card){return card.querySelector('.msg');}` +
    `function draft(id,btn){var card=cardOf(id);var ta=card.querySelector('textarea');btn.disabled=true;` +
    `fetch('api/review/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})` +
    `.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})` +
    `.then(function(res){btn.disabled=false;` +
    `if(!res.ok){tipOf(card).innerHTML='<span class="err">'+esc(res.j.error)+'</span>';return;}` +
    `ta.value=res.j.draft; tipOf(card).innerHTML='<span class="ok">草稿已生成，请人工修改后发送</span>';` +
    `}).catch(function(e){btn.disabled=false;tipOf(card).innerHTML='<span class="err">'+esc(String(e))+'</span>'});}` +
    `function send(id,btn){var card=cardOf(id);var ta=card.querySelector('textarea');var text=ta.value.trim();` +
    `if(!text){tipOf(card).innerHTML='<span class="err">回复为空</span>';return;}` +
    `btn.disabled=true;` +
    `fetch('api/review/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,text:text})})` +
    `.then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})` +
    `.then(function(res){btn.disabled=false;` +
    `if(!res.ok){tipOf(card).innerHTML='<span class="err">'+esc(res.j.error)+'</span>';return;}` +
    `card.style.opacity=.45; tipOf(card).innerHTML='<span class="ok">已发送 ✓</span>';` +
    `}).catch(function(e){btn.disabled=false;tipOf(card).innerHTML='<span class="err">'+esc(String(e))+'</span>'});}` +
    `function ignore(id,btn){fetch('api/review/ignore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})` +
    `.then(function(){var card=cardOf(id);card.style.opacity=.35;card.querySelector('.actions').style.display='none';});}` +
    `loadStatus(); loadQueue();` +
    `</script>` +
    FOOTER
  );
}

export { leadsPage, reviewPage };
