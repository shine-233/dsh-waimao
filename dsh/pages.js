// 四个回环页面：谷歌获客（含线索加工）、客服审核台、CRM 管线、设置。
// 单文件 HTML + 原生 JS，深色主题，调用同源 /waimao/api/* 路由。
// 页面内脚本刻意不用模板字符串，避免与宿主字符串拼接冲突。

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 60px; }
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
button.mini { padding: 4px 10px; font-size: 12px; }
button:disabled { opacity: .5; cursor: wait; }
.formula { background: #161b22; border: 1px dashed #30363d; border-radius: 8px; padding: 10px 14px; color: #d29922; font-size: 13px; margin-bottom: 18px; }
.badge { display: inline-block; background: #1f6feb; color: #fff; border-radius: 999px; font-size: 12px; padding: 2px 10px; margin: 14px 0 8px; }
.badge.gray { background: #30363d; color: #8b949e; }
table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
th { color: #58a6ff; font-weight: 600; }
tr:last-child td { border-bottom: none; }
td.num { color: #8b949e; width: 34px; }
td.t { width: 30%; word-break: break-all; }
td.s { color: #8b949e; font-size: 13px; }
.err { color: #f85149; }
.ok { color: #3fb950; }
.warn { color: #d29922; }
.msg { margin: 10px 0; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.card .meta { color: #8b949e; font-size: 12px; margin-bottom: 6px; }
.card .text { white-space: pre-wrap; margin-bottom: 10px; }
.card textarea { width: 100%; min-height: 64px; margin-bottom: 8px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.status { font-size: 13px; color: #8b949e; }
.pill { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; border: 1px solid #30363d; margin-right: 6px; }
.pill.on { color: #3fb950; border-color: #238636; }
.pill.off { color: #f85149; border-color: #b62324; }
.tag { display: inline-block; background: #21262d; border-radius: 4px; padding: 0 8px; font-size: 12px; margin-right: 4px; }
.score-hi { color: #f85149; font-weight: 700; }
.score-mid { color: #d29922; font-weight: 700; }
.score-lo { color: #3fb950; }
.score-no { color: #484f58; }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 8px 12px; margin-bottom: 14px; }
.kv label { color: #8b949e; font-size: 13px; padding-top: 8px; }
.kv input, .kv select { width: 100%; }
nav.tabs { margin-bottom: 18px; }
nav.tabs a { display: inline-block; padding: 6px 16px; border-radius: 6px; margin-right: 6px; background: #21262d; }
nav.tabs a.on { background: #1f6feb; color: #fff; }
`;

const COMMON_HEAD = (title, active) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${title}</title><style>${STYLE}</style></head><body><div class="wrap">` +
  `<nav class="tabs">` +
  `<a href="leads" class="${active === 'leads' ? 'on' : ''}">🌐 谷歌获客</a>` +
  `<a href="crm" class="${active === 'crm' ? 'on' : ''}">📊 CRM 管线</a>` +
  `<a href="review" class="${active === 'review' ? 'on' : ''}">💬 客服审核台</a>` +
  `<a href="settings" class="${active === 'settings' ? 'on' : ''}">⚙ 设置</a>` +
  `</nav>`;

const FOOTER = `</div></body></html>`;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* 页面 1：谷歌获客（搜索 + 线索加工）                                  */
/* ------------------------------------------------------------------ */

function leadsPage() {
  return (
    COMMON_HEAD('谷歌获客 · 三层搜索 + 线索加工', 'leads') +
    `<h1>🌐 谷歌获客 <span class="status">dsh-waimao · 三层搜索 → 提取 → 过滤 → 评分 → 入CRM</span></h1>` +
    `<div class="formula">💡 课程公式："产品词" WhatsApp [+区号] site:linkedin.com -alibaba -made-in-china -globalsources -supplier -manufacturer。欧美走邮件+LinkedIn，亚非拉走 WhatsApp。</div>` +
    `<div class="panel"><h2>搜索</h2>` +
    `<div class="row">` +
    `<div class="field" style="flex:2 1 260px"><label>产品关键词（英文）</label><input id="product" placeholder="hair dryer"></div>` +
    `<div class="field"><label>目标市场</label><select id="market"></select></div>` +
    `<div class="field"><label>搜索层级</label><select id="layers">` +
    `<option value="1,2,3">三层全叠加（最精）</option><option value="1,3">基础+采购信号</option>` +
    `<option value="1">第1层·基础搜索</option><option value="2">第2层·LinkedIn 定位</option>` +
    `<option value="3">第3层·采购信号</option></select></div>` +
    `<div class="field"><label>每层条数</label><select id="perLayer"><option>5</option><option selected>10</option><option>20</option><option>30</option></select></div>` +
    `<div class="field"><label>引擎</label><select id="engine">` +
    `<option value="">自动(failover链)</option><option value="ddg">DuckDuckGo</option>` +
    `<option value="serpapi">SerpAPI(Google)</option><option value="literal">仅生成公式</option></select></div>` +
    `<button id="go">🔍 开始搜索</button>` +
    `</div><div class="msg status" id="status"></div></div>` +
    `<div class="panel" id="enrichPanel" style="display:none"><h2>线索加工</h2>` +
    `<div class="row">` +
    `<label class="status" style="align-self:center"><input type="checkbox" id="useAI" checked> AI评分(需DeepSeek key)</label>` +
    `<label class="status" style="align-self:center"><input type="checkbox" id="fetchPages" checked> 抓取网页提取联系方式</label>` +
    `<button id="enrich">🧪 提取+过滤+评分+入CRM</button>` +
    `<span class="status" style="align-self:center">被排除的同行/平台会标 ⚪排除，不入库</span>` +
    `</div><div class="msg status" id="enrichStatus"></div></div>` +
    `<div id="result"></div>` +
    `<script>` +
    `function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}` +
    `var sel=document.getElementById('market');` +
    `fetch('api/markets').then(function(r){return r.json()}).then(function(list){` +
    `list.forEach(function(m){var o=document.createElement('option');o.value=m.key;o.textContent=m.label+(m.dial?' +'+m.dial:'');sel.appendChild(o)})});` +
    `var lastRun=null, lastEnrich=null;` +
    `document.getElementById('go').onclick=function(){` +
    `var product=document.getElementById('product').value.trim();` +
    `if(!product){document.getElementById('status').textContent='请输入产品关键词';return;}` +
    `var btn=this;btn.disabled=true;` +
    `document.getElementById('status').textContent='搜索中…（三层逐层进行）';` +
    `document.getElementById('result').innerHTML='';document.getElementById('enrichPanel').style.display='none';` +
    `fetch('api/leads/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({` +
    `product:product,market:sel.value,layers:document.getElementById('layers').value.split(',').map(Number),` +
    `perLayer:Number(document.getElementById('perLayer').value),engine:document.getElementById('engine').value})})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})` +
    `.then(function(res){btn.disabled=false;` +
    `if(!res.ok){document.getElementById('status').innerHTML='<span class="err">'+esc(res.j.error||'搜索失败')+'</span>';return;}` +
    `render(res.j);}).catch(function(e){btn.disabled=false;document.getElementById('status').innerHTML='<span class="err">'+esc(String(e))+'</span>'});};` +
    `function render(run){lastRun=run;` +
    `document.getElementById('status').innerHTML='<span class="ok">完成：'+run.total+' 条（已逐层去重）</span> <span class="status">run: '+run.id+(run.engineFallbacks?' · 引擎切换: '+run.engineFallbacks.join(', '):'')+'</span>';` +
    `document.getElementById('enrichPanel').style.display='block';` +
    `var html='<div class="row" style="margin-bottom:10px"><button class="ghost" onclick="exportCsv(\\''+run.id+'\\')">⬇ 导出 CSV</button><button class="ghost" onclick="copyLinks()">📋 复制全部链接</button><span class="status" id="copyTip"></span></div>';` +
    `var byLayer={};run.results.forEach(function(it){(byLayer[it.layer]=byLayer[it.layer]||[]).push(it)});` +
    `run.layers.forEach(function(layer){` +
    `html+='<div class="badge">第'+layer.id+'层 · '+esc(layer.name)+'</div>';` +
    `html+='<div class="status" style="margin-bottom:8px">公式：<code>'+esc(layer.query)+'</code>'+(layer.error?' <span class="err">[错误: '+esc(layer.error)+']</span>':'')+'</div>';` +
    `var rows=byLayer[layer.id]||[];` +
    `if(rows.length===0){html+='<table><tr><td class="s">（本层无结果）</td></tr></table>';return;}` +
    `html+='<table><tr><th>#</th><th>标题 / 链接</th><th>摘要</th></tr>';` +
    `rows.forEach(function(it,i){` +
    `html+='<tr><td class="num">'+(i+1)+'</td><td class="t"><a href="'+esc(it.url)+'" target="_blank" rel="noopener">'+esc(it.title)+'</a><br><span class="status">'+esc(it.url)+'</span></td><td class="s">'+esc(it.snippet)+'</td></tr>';});` +
    `html+='</table>';});` +
    `window.__lastRun=run;document.getElementById('result').innerHTML=html;}` +
    `document.getElementById('enrich').onclick=function(){` +
    `if(!lastRun){return;}var btn=this;btn.disabled=true;` +
    `document.getElementById('enrichStatus').textContent='加工中…（抓页+提取+分类+评分，每页有礼貌间隔，请耐心）';` +
    `fetch('api/leads/enrich',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({` +
    `run_id:lastRun.id,useAI:document.getElementById('useAI').checked,fetchPages:document.getElementById('fetchPages').checked,limit:30})})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})` +
    `.then(function(res){btn.disabled=false;` +
    `if(!res.ok){document.getElementById('enrichStatus').innerHTML='<span class="err">'+esc(res.j.error)+'</span>';return;}` +
    `lastEnrich=res.j;renderEnrich(res.j);})` +
    `.catch(function(e){btn.disabled=false;document.getElementById('enrichStatus').innerHTML='<span class="err">'+esc(String(e))+'</span>'});};` +
    `function scoreCls(s){return s>=10?'score-hi':(s>=7?'score-hi':(s>=4?'score-mid':(s>=1?'score-lo':'score-no')));}` +
    `function renderEnrich(list){` +
    `var kept=list.filter(function(r){return r.keep});` +
    `document.getElementById('enrichStatus').innerHTML='<span class="ok">完成：'+kept.length+'/'+list.length+' 条保留，'+list.filter(function(r){return r.leadId}).length+' 条已入CRM</span>';` +
    `var html='<table><tr><th>#</th><th>分类</th><th>评分</th><th>公司/标题</th><th>联系方式</th><th>建议</th></tr>';` +
    `list.forEach(function(r,i){` +
    `var ct=[].concat(r.contacts.emails||[]).concat((r.contacts.whatsapps||[]).map(function(w){return 'WA:'+w})).concat(r.contacts.phones||[]).slice(0,4);` +
    `html+='<tr><td class="num">'+(i+1)+'</td>' +` +
    `'<td class="s">'+(r.keep?'<span class="ok">'+esc(r.kind)+'</span>':'<span class="score-no">⚪'+esc(r.kind)+'</span>')+'<br><span class="status">'+esc(r.reason)+'</span></td>' +` +
    `'<td class="'+scoreCls(r.score)+'">'+r.score+' '+esc(r.tier)+'</td>' +` +
    `'<td class="t"><a href="'+esc(r.url)+'" target="_blank" rel="noopener">'+esc(r.company||r.title)+'</a>'+(r.merged?' <span class="warn">[CRM合并]</span>':(r.leadId?' <span class="ok">[已入CRM]</span>':''))+'</td>' +` +
    `'<td class="s">'+(ct.length?ct.map(esc).join('<br>'):'<span class="score-no">未提取到</span>')+'</td>' +` +
    `'<td class="s">'+esc(r.advice||r.error||'')+'</td></tr>';});` +
    `html+='</table>';` +
    `var box=document.createElement('div');box.innerHTML=html;` +
    `document.getElementById('result').appendChild(box);}` +
    `function exportCsv(runId){window.open('api/leads/export.csv?run='+encodeURIComponent(runId),'_blank');}` +
    `function copyLinks(){var run=window.__lastRun||{};var urls=(run.results||[]).map(function(it){return it.url});` +
    `navigator.clipboard.writeText(urls.join('\\n')).then(function(){document.getElementById('copyTip').textContent='已复制 '+urls.length+' 条';});}` +
    `</script>` +
    FOOTER
  );
}

/* ------------------------------------------------------------------ */
/* 页面 2：CRM 管线                                                    */
/* ------------------------------------------------------------------ */

function crmPage() {
  return (
    COMMON_HEAD('CRM 管线', 'crm') +
    `<h1>📊 CRM 管线 <span class="status">新线索 → 已评估 → 已触达 → 已回复 → 已报价 → 成交/流失</span></h1>` +
    `<div class="panel"><div class="row">` +
    `<div class="field"><label>状态</label><select id="fStatus"><option value="">全部</option>` +
    `<option value="new">新线索</option><option value="qualified">已评估</option><option value="contacted">已触达</option>` +
    `<option value="replied">已回复</option><option value="quoted">已报价</option><option value="won">已成交</option><option value="lost">已流失</option></select></div>` +
    `<div class="field"><label>分层</label><select id="fTier"><option value="">全部</option>` +
    `<option>极高</option><option>高</option><option>中</option><option>低</option></select></div>` +
    `<div class="field" style="flex:1 1 200px"><label>搜索</label><input id="fQ" placeholder="公司/域名/邮箱/WA"></div>` +
    `<button id="fGo">查询</button>` +
    `<span style="flex:1"></span>` +
    `<button class="ghost" id="fExport">⬇ 导出 CSV</button>` +
    `</div><div class="msg status" id="status"></div></div>` +
    `<div id="list"></div>` +
    `<script>` +
    `function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}` +
    `function scoreCls(s){return s>=7?'score-hi':(s>=4?'score-mid':(s>=1?'score-lo':'score-no'));}` +
    `var STATUS={new:'新线索',qualified:'已评估',contacted:'已触达',replied:'已回复',quoted:'已报价',won:'已成交',lost:'已流失'};` +
    `function load(){` +
    `var qs='?limit=100';` +
    `if(document.getElementById('fStatus').value)qs+='&status='+document.getElementById('fStatus').value;` +
    `if(document.getElementById('fTier').value)qs+='&tier='+encodeURIComponent(document.getElementById('fTier').value);` +
    `if(document.getElementById('fQ').value)qs+='&q='+encodeURIComponent(document.getElementById('fQ').value);` +
    `fetch('api/crm/list'+qs).then(function(r){return r.json()}).then(function(list){` +
    `document.getElementById('status').textContent=list.length+' 条线索';` +
    `var html='';` +
    `list.forEach(function(l){` +
    `var ct=[].concat(l.contacts.emails||[]).concat((l.contacts.whatsapps||[]).map(function(w){return 'WA:'+w})).concat(l.contacts.phones||[]);` +
    `var last=l.activities&&l.activities.length?l.activities[l.activities.length-1]:null;` +
    `html+='<div class="card"><div class="meta">' +` +
    `'<strong>'+esc(l.company||l.domain)+'</strong> · '+esc(l.market)+' · ' +` +
    `'<span class="'+scoreCls(l.score)+'">'+l.score+'分 '+esc(l.tier)+'</span> · ' +` +
    `'状态: <select onchange="setStatus(\\''+l.id+'\\',this.value)">' +` +
    `Object.keys(STATUS).map(function(k){return '<option '+(l.status===k?'selected':'')+' value="'+k+'">'+STATUS[k]+'</option>'}).join('') +` +
    `'</select>' +` +
    `(l.sequence?' · 📧序列中('+l.sequence.steps.filter(function(s){return s.status==='sent'}).length+'/'+l.sequence.steps.length+')':'') +` +
    `'</div>' +` +
    `'<div class="text">'+(ct.length?ct.map(esc).join(' · '):'<span class="score-no">无联系方式(可点"提取")</span>')+` +
    `(l.advice?'<br><span class="status">💡 '+esc(l.advice)+'</span>':'')+` +
    `(last?'<br><span class="status">'+esc(last.ts.slice(0,16))+' '+esc(last.note)+'</span>':'')+'</div>' +` +
    `'<div class="actions">' +` +
    `'<button class="mini" onclick="compose(\\''+l.id+'\\',this)">✉ AI开发信</button>' +` +
    `'<button class="mini ghost" onclick="seqStart(\\''+l.id+'\\',this)">📅 启动跟进序列</button>' +` +
    `(l.contacts.whatsapps&&l.contacts.whatsapps.length?'<a class="mini ghost button" style="padding:4px 10px;font-size:12px;background:#21262d;border:1px solid #30363d;border-radius:6px" target="_blank" href="https://wa.me/'+l.contacts.whatsapps[0]+'">💬 WhatsApp</a>':'') +` +
    `'<button class="mini ghost" onclick="note(\\''+l.id+'\\',this)">📝 记跟进</button>' +` +
    `'</div>' +` +
    `'<div class="msg status" id="m-'+l.id+'"></div>' +` +
    `'<div id="d-'+l.id+'"></div></div>';` +
    `});` +
    `document.getElementById('list').innerHTML=html||'<div class="panel"><span class="status">空。先去「谷歌获客」跑一轮并点「提取+过滤+评分+入CRM」。</span></div>';` +
    `});}` +
    `document.getElementById('fGo').onclick=load;` +
    `document.getElementById('fExport').onclick=function(){window.open('api/crm/export.csv','_blank');};` +
    `function setStatus(id,status){fetch('api/crm/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,status:status})}).then(function(){load()});}` +
    `function compose(id,btn){btn.disabled=true;var tip=document.getElementById('m-'+id);tip.textContent='AI 撰写中…';` +
    `fetch('api/crm/compose',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})` +
    `.then(function(res){btn.disabled=false;` +
    `if(!res.ok){tip.innerHTML='<span class="err">'+esc(res.j.error)+'</span>';return;}` +
    `var d=document.getElementById('d-'+id);` +
    `d.innerHTML='<textarea style="width:100%;min-height:120px" id="s-'+id+'">'+esc(res.j.subject)+'</textarea><textarea style="width:100%;min-height:160px" id="b-'+id+'">'+esc(res.j.body)+'</textarea>' +` +
    `'<div class="actions"><button class="mini" onclick="sendMail(\\''+id+'\\')">发送(受dry_run闸门)</button><span class="status">'+esc(res.j.generatedBy)+' · '+esc(res.j.language)+'</span></div>';` +
    `tip.innerHTML='<span class="ok">草稿已生成，可编辑后发送</span>';` +
    `}).catch(function(e){btn.disabled=false;tip.innerHTML='<span class="err">'+esc(String(e))+'</span>'});}` +
    `function sendMail(id){var subject=document.getElementById('s-'+id).value;var body=document.getElementById('b-'+id).value;` +
    `var tip=document.getElementById('m-'+id);tip.textContent='发送中…';` +
    `fetch('api/crm/send-email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,subject:subject,body:body})})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})` +
    `.then(function(res){tip.innerHTML=res.ok?'<span class="ok">'+esc(res.j.dryRun?'[dry-run] 未真实发送：'+esc(res.j.previewFile||'预览已生成'):'已发送 ✓')+'</span>':'<span class="err">'+esc(res.j.error)+'</span>';});}` +
    `function seqStart(id,btn){btn.disabled=true;` +
    `fetch('api/crm/sequence-start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})` +
    `.then(function(res){if(!res.ok){document.getElementById('m-'+id).innerHTML='<span class="err">'+esc(res.j.error)+'</span>';return;}load();});}` +
    `function note(id,btn){var text=prompt('跟进记录：');if(!text)return;` +
    `fetch('api/crm/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,type:'note',note:text})}).then(load);}` +
    `load();` +
    `</script>` +
    FOOTER
  );
}

/* ------------------------------------------------------------------ */
/* 页面 3：客服审核台（沿用 v0.1，微调导航）                            */
/* ------------------------------------------------------------------ */

function reviewPage() {
  return (
    COMMON_HEAD('XMT 客服审核台', 'review') +
    `<h1>💬 WhatsApp 客服审核台 <span class="status">AI 起草 · 人工审核 · 群聊拒发</span></h1>` +
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
    `pills+='<span class="pill '+(s.evolution.ready?'on':'off')+'">Evolution '+(s.evolution.ready?'已连接':'未配置')+'</span>';` +
    `pills+='<span class="pill '+(s.webhookTokenSet?'on':'off')+'">Webhook token '+(s.webhookTokenSet?'已设置':'未设置')+'</span>';` +
    `pills+='<span class="pill '+(s.deepseek.ready?'on':'off')+'">AI草稿 '+(s.deepseek.ready?'可用':'未配key')+'</span>';` +
    `pills+='<span class="pill '+(s.smtp.ready?(s.smtp.dryRun?'off':'on'):'off')+'">SMTP '+(s.smtp.ready?(s.smtp.dryRun?'dry-run':'可发送'):'未配置')+'</span>';` +
    `document.getElementById('pills').innerHTML=pills;});}` +
    `function loadQueue(){fetch('api/review/queue?limit=50').then(function(r){return r.json()}).then(function(list){` +
    `var box=document.getElementById('queue');` +
    `if(!list.length){box.innerHTML='<div class="panel"><h2>待审消息</h2><span class="status">队列为空。确认 Evolution webhook 指向 /waimao/webhook/evolution?token=...，或让智能体调用 wa_sync。</span></div>';return;}` +
    `var html='<div class="panel"><h2>待审消息（'+list.length+'）</h2>';` +
    `list.forEach(function(m){` +
    `html+='<div class="card" id="m-'+esc(m.id)+'">' +` +
    `'<div class="meta">'+esc(m.name||m.sender)+' · '+esc(m.chatJid)+' · '+fmtTs(m.ts)+' · '+esc(m.status)+'</div>' +` +
    `'<div class="text">'+esc(m.text)+'</div>' +` +
    `'<textarea placeholder="回复内容（可先 AI 草稿）">'+esc(m.draft||'')+'</textarea>' +` +
    `'<div class="actions">' +` +
    `'<button onclick="draft(\\''+esc(m.id)+'\\',this)">✨ AI 草稿</button>' +` +
    `'<button onclick="send(\\''+esc(m.id)+'\\',this)">✅ 审核并发送</button>' +` +
    `'<button class="ghost" onclick="ignore(\\''+esc(m.id)+'\\')">忽略</button>' +` +
    `'</div><div class="msg status"></div></div>';});` +
    `html+='</div>';box.innerHTML=html;});}` +
    `document.getElementById('refresh').onclick=loadQueue;` +
    `function cardOf(id){return document.getElementById('m-'+CSS.escape(id));}` +
    `function tipOf(card){return card.querySelector('.msg');}` +
    `function draft(id,btn){var card=cardOf(id);var ta=card.querySelector('textarea');btn.disabled=true;` +
    `fetch('api/review/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})` +
    `.then(function(res){btn.disabled=false;` +
    `if(!res.ok){tipOf(card).innerHTML='<span class="err">'+esc(res.j.error)+'</span>';return;}` +
    `ta.value=res.j.draft;tipOf(card).innerHTML='<span class="ok">草稿已生成</span>';});}` +
    `function send(id,btn){var card=cardOf(id);var ta=card.querySelector('textarea');var text=ta.value.trim();` +
    `if(!text){tipOf(card).innerHTML='<span class="err">回复为空</span>';return;}` +
    `btn.disabled=true;` +
    `fetch('api/review/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,text:text})})` +
    `.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})` +
    `.then(function(res){btn.disabled=false;` +
    `if(!res.ok){tipOf(card).innerHTML='<span class="err">'+esc(res.j.error)+'</span>';return;}` +
    `card.style.opacity=.45;tipOf(card).innerHTML='<span class="ok">已发送 ✓</span>';});}` +
    `function ignore(id){fetch('api/review/ignore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})` +
    `.then(function(){var card=cardOf(id);card.style.opacity=.35;card.querySelector('.actions').style.display='none';});}` +
    `loadStatus();loadQueue();` +
    `</script>` +
    FOOTER
  );
}

/* ------------------------------------------------------------------ */
/* 页面 4：设置（配置读写 + 连通性测试）                                */
/* ------------------------------------------------------------------ */

const SETTINGS_SECTIONS = [
  {
    key: 'serp', title: 'SERP 搜索',
    fields: [
      ['engine', '首选引擎', 'select', [['ddg', 'DuckDuckGo(免key)'], ['serpapi', 'SerpAPI(Google)']]],
      ['serpapiKey', 'SerpAPI Key', 'password'],
      ['perLayer', '每层条数', 'number'],
      ['proxy', '代理(如 http://127.0.0.1:7890)', 'text'],
    ],
  },
  {
    key: 'evolution', title: 'Evolution API (WhatsApp)',
    fields: [
      ['baseURL', 'Base URL', 'text'],
      ['apiKey', 'API Key', 'password'],
      ['instance', '实例名', 'text'],
    ],
  },
  {
    key: 'deepseek', title: 'DeepSeek (AI评分/草稿)',
    fields: [
      ['baseURL', 'Base URL', 'text'],
      ['apiKey', 'API Key', 'password'],
      ['model', '模型', 'text'],
    ],
  },
  {
    key: 'smtp', title: 'SMTP (开发信)',
    fields: [
      ['host', '服务器', 'text'],
      ['port', '端口', 'number'],
      ['user', '账号', 'text'],
      ['pass', '密码/授权码', 'password'],
      ['from', '发件人', 'text'],
      ['fromName', '发件人名', 'text'],
      ['dryRun', 'dry-run 总闸', 'select', [['true', 'true(安全,只预览)'], ['false', 'false(真实发送)']]],
    ],
  },
  {
    key: 'cron', title: '定时任务',
    fields: [
      ['enabled', '启用', 'select', [['true', '开'], ['false', '关']]],
      ['waSyncEveryMin', 'WA收件箱轮询(分钟,0关)', 'number'],
      ['sequenceCheckEveryMin', '序列检查(分钟)', 'number'],
      ['dailyReportAt', '日报时间(HH:mm)', 'text'],
      ['staleDays', '停跟进天数', 'number'],
    ],
  },
  {
    key: 'wa', title: 'WhatsApp 群发频控',
    fields: [
      ['dailyBroadcastCap', '每日上限', 'number'],
      ['minDelaySec', '最小间隔(秒)', 'number'],
      ['maxDelaySec', '最大间隔(秒)', 'number'],
    ],
  },
];

function settingsPage() {
  const sectionsHtml = SETTINGS_SECTIONS.map((section) => {
    const fields = section.fields
      .map(([key, label, kind, options]) => {
        if (kind === 'select') {
          const opts = options.map(([value, text]) => `<option value="${value}">${esc(text)}</option>`).join('');
          return `<label>${esc(label)}</label><select data-section="${section.key}" data-key="${key}">${opts}</select>`;
        }
        const type = kind === 'password' ? 'password' : kind === 'number' ? 'number' : 'text';
        return `<label>${esc(label)}</label><input type="${type}" data-section="${section.key}" data-key="${key}">`;
      })
      .join('');
    const testButton = ['serp', 'smtp', 'evolution', 'deepseek'].includes(section.key)
      ? `<button class="mini ghost" onclick="testConn('${section.key}',this)">测试连通</button>`
      : '';
    return `<div class="panel"><h2>${esc(section.title)}</h2><div class="kv">${fields}</div><div class="msg status" id="t-${section.key}"></div>${testButton}</div>`;
  }).join('');
  return (
    COMMON_HEAD('设置', 'settings') +
    `<h1>⚙ 设置 <span class="status">~/.waimao/config.json · 密钥只写不读</span></h1>` +
    `<div class="panel"><div class="row"><button id="save">💾 保存全部</button><span class="msg status" id="status"></span></div></div>` +
    sectionsHtml +
    `<script>` +
    `function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}` +
    `var SECRET_KEYS=['serpapiKey','apiKey','pass'];` +
    `fetch('api/config').then(function(r){return r.json()}).then(function(s){` +
    `document.querySelectorAll('[data-section]').forEach(function(el){` +
    `var sec=el.getAttribute('data-section'),key=el.getAttribute('data-key');` +
    `var v=(s[sec]||{})[key];if(v===undefined||v===null)return;` +
    `if(SECRET_KEYS.indexOf(key)>=0&&typeof v==='string'&&v){el.placeholder='已设置，留空保持不变';return;}` +
    `el.value=String(v);});});` +
    `document.getElementById('save').onclick=function(){` +
    `var patch={};` +
    `document.querySelectorAll('[data-section]').forEach(function(el){` +
    `var sec=el.getAttribute('data-section'),key=el.getAttribute('data-key');` +
    `patch[sec]=patch[sec]||{};` +
    `var v=el.value;` +
    `if(el.type==='number'||key==='perLayer'||key==='port'||key==='staleDays'||key==='dailyBroadcastCap'||key==='minDelaySec'||key==='maxDelaySec'||key==='waSyncEveryMin'||key==='sequenceCheckEveryMin'){v=Number(v);}` +
    `if(key==='dryRun'||key==='enabled'){v=v==='true';}` +
    `if(SECRET_KEYS.indexOf(key)>=0&&!v){return;}` +
    `patch[sec][key]=v;});` +
    `fetch('api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)})` +
    `.then(function(r){return r.json()}).then(function(j){` +
    `document.getElementById('status').innerHTML=j.error?'<span class="err">'+esc(j.error)+'</span>':'<span class="ok">已保存</span>';});};` +
    `function testConn(name,btn){btn.disabled=true;var tip=document.getElementById('t-'+name);tip.textContent='测试中…';` +
    `fetch('api/test/'+name,{method:'POST'}).then(function(r){return r.json()}).then(function(j){btn.disabled=false;` +
    `tip.innerHTML=j.ok?'<span class="ok">'+esc(j.message)+'</span>':'<span class="err">'+esc(j.error||'失败')+'</span>';});}` +
    `</script>` +
    FOOTER
  );
}

export { leadsPage, crmPage, reviewPage, settingsPage };
