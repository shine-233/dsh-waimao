// 五个回环页面：仪表盘CRM、谷歌获客、客服审核台、设置。
// v0.5 前端全面重做：玻璃拟态 + 渐变 + 入场动画 + 骨架屏 + Toast/Modal +
// Ctrl+K 命令面板 + Canvas 图表（零依赖） + 看板拖拽 + WhatsApp 气泡。
// 页面内脚本刻意不用模板字符串。

const STYLE = `
:root{
  color-scheme:dark;
  --bg:#09090b;--bg2:#0f0f12;--card:rgba(24,24,27,.66);--card2:rgba(39,39,42,.6);
  --border:rgba(63,63,70,.45);--border2:rgba(82,82,91,.5);
  --text:#fafafa;--muted:#a1a1aa;--dim:#71717a;
  --accent:#6366f1;--accent2:#8b5cf6;--ok:#34d399;--warn:#fbbf24;--err:#f87171;--pink:#f472b6;--cyan:#22d3ee;
  --grad:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#d946ef 100%);
  --shadow:0 8px 32px rgba(0,0,0,.45);--r:14px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:-1;background:
  radial-gradient(600px 300px at 15% -5%,rgba(99,102,241,.14),transparent 60%),
  radial-gradient(700px 350px at 90% 0%,rgba(139,92,246,.10),transparent 60%),
  radial-gradient(500px 300px at 50% 110%,rgba(217,70,239,.06),transparent 60%)}
a{color:#a5b4fc;text-decoration:none;transition:color .2s}
a:hover{color:#c7d2fe}
::selection{background:rgba(99,102,241,.4)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#27272a;border-radius:8px;border:2px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}
.wrap{max-width:1240px;margin:0 auto;padding:22px 22px 80px}

/* ---------- 顶部 ---------- */
.hero{margin-bottom:20px}
.hero h1{font-size:26px;margin:0 0 2px;letter-spacing:-.02em;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block;background-size:200% auto;animation:gradX 6s ease infinite}
@keyframes gradX{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.hero .sub{color:var(--muted);font-size:13.5px}
nav.tabs{display:flex;gap:4px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:4px;width:fit-content;margin-bottom:22px;backdrop-filter:blur(12px);position:sticky;top:10px;z-index:50;box-shadow:var(--shadow)}
nav.tabs a{padding:7px 18px;border-radius:9px;color:var(--muted);font-weight:500;font-size:13.5px;transition:all .25s cubic-bezier(.4,0,.2,1);position:relative}
nav.tabs a:hover{color:var(--text);background:rgba(255,255,255,.05)}
nav.tabs a.on{color:#fff;background:var(--grad);box-shadow:0 4px 16px rgba(99,102,241,.35)}
nav.tabs .kbd-hint{margin-left:auto;align-self:center;padding-right:10px;color:var(--dim);font-size:11px}
kbd{background:#27272a;border:1px solid #3f3f46;border-bottom-width:2px;border-radius:5px;padding:1px 6px;font-size:11px;font-family:inherit}

/* ---------- 卡片/面板 ---------- */
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:20px;margin-bottom:18px;backdrop-filter:blur(14px);box-shadow:var(--shadow);transition:border-color .3s}
.panel:hover{border-color:var(--border2)}
.panel h2{font-size:14.5px;margin:0 0 14px;padding-left:10px;border-left:3px solid var(--accent);letter-spacing:.01em}
.panel h2 .hint{color:var(--dim);font-weight:400;font-size:12px;margin-left:8px}
.grid{display:grid;gap:14px}
.g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.g5{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}

/* ---------- 统计卡 ---------- */
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px;position:relative;overflow:hidden;transition:transform .3s cubic-bezier(.34,1.56,.64,1),border-color .3s;animation:fadeUp .5s cubic-bezier(.22,1,.36,1) backwards}
.stat:hover{transform:translateY(-3px);border-color:rgba(99,102,241,.5)}
.stat::after{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:var(--grad);opacity:0;transition:opacity .3s}
.stat:hover::after{opacity:1}
.stat .num{font-size:28px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat .lbl{color:var(--muted);font-size:12px;margin-top:2px}
.stat .trend{position:absolute;top:14px;right:14px;font-size:11px;color:var(--dim)}
.stat.accent .num{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}

/* ---------- 表单 ---------- */
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:end}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:12px;color:var(--muted)}
input,select,textarea{background:rgba(9,9,11,.7);border:1px solid var(--border);border-radius:9px;color:var(--text);padding:9px 12px;font:inherit;transition:border-color .2s,box-shadow .2s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.18)}
input::placeholder,textarea::placeholder{color:var(--dim)}

/* ---------- 按钮 ---------- */
button{background:var(--grad);border:none;color:#fff;border-radius:9px;padding:9px 18px;font:inherit;font-weight:500;cursor:pointer;transition:all .25s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden}
button:hover{box-shadow:0 4px 20px rgba(99,102,241,.45);transform:translateY(-1px)}
button:active{transform:translateY(0) scale(.98)}
button.ghost{background:rgba(255,255,255,.04);border:1px solid var(--border)}
button.ghost:hover{background:rgba(255,255,255,.08);box-shadow:none}
button.danger{background:linear-gradient(135deg,#ef4444,#dc2626)}
button.mini{padding:4px 11px;font-size:12px;border-radius:7px}
button:disabled{opacity:.45;cursor:wait;transform:none!important;box-shadow:none!important}
button .spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:5px}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---------- 表格 ---------- */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;padding:9px 12px;color:var(--muted);font-weight:600;font-size:12px;border-bottom:1px solid var(--border)}
td{padding:9px 12px;border-bottom:1px solid rgba(39,39,42,.6);vertical-align:top}
tr:last-child td{border-bottom:none}
tbody tr{transition:background .2s}
tbody tr:hover{background:rgba(99,102,241,.05)}

/* ---------- 徽章/标签 ---------- */
.badge{display:inline-flex;align-items:center;gap:5px;background:rgba(99,102,241,.15);color:#a5b4fc;border:1px solid rgba(99,102,241,.3);border-radius:999px;font-size:12px;padding:2px 11px;font-weight:500}
.badge.gray{background:rgba(82,82,91,.2);color:var(--muted);border-color:var(--border)}
.badge.ok{background:rgba(52,211,153,.12);color:var(--ok);border-color:rgba(52,211,153,.3)}
.badge.warn{background:rgba(251,191,36,.12);color:var(--warn);border-color:rgba(251,191,36,.3)}
.badge.err{background:rgba(248,113,113,.12);color:var(--err);border-color:rgba(248,113,113,.3)}
.pill{display:inline-block;padding:1px 10px;border-radius:999px;font-size:11.5px;border:1px solid var(--border);margin-right:5px;color:var(--muted)}
.pill.on{color:var(--ok);border-color:rgba(52,211,153,.4)}
.pill.off{color:var(--err);border-color:rgba(248,113,113,.4)}
.tag{display:inline-block;background:rgba(99,102,241,.12);color:#a5b4fc;border-radius:5px;padding:0 7px;font-size:11.5px;margin-right:4px}

/* ---------- 动画 ---------- */
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes scaleIn{from{opacity:0;transform:scale(.94) translateY(8px)}to{opacity:1;transform:none}}
@keyframes slideRight{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
@keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
@keyframes pulseGlow{0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.5)}50%{box-shadow:0 0 0 7px rgba(99,102,241,0)}}
@keyframes bounceDot{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-5px);opacity:1}}
@keyframes stripes{to{background-position:28px 0}}
@keyframes popIn{0%{transform:scale(0)}70%{transform:scale(1.15)}100%{transform:scale(1)}}
.stagger>*{animation:fadeUp .5s cubic-bezier(.22,1,.36,1) backwards}
.skeleton{background:linear-gradient(90deg,#18181b 25%,#27272a 50%,#18181b 75%);background-size:400px 100%;animation:shimmer 1.4s infinite linear;border-radius:8px;color:transparent!important;user-select:none}
.progress{height:8px;background:#18181b;border-radius:99px;overflow:hidden}
.progress .bar{height:100%;background:var(--grad);border-radius:99px;transition:width .5s cubic-bezier(.22,1,.36,1);position:relative}
.progress .bar.striped{background-image:linear-gradient(45deg,rgba(255,255,255,.18) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.18) 50%,rgba(255,255,255,.18) 75%,transparent 75%);background-size:28px 28px;animation:stripes .8s linear infinite}
.typing{display:inline-flex;gap:4px;padding:8px 12px}
.typing i{width:7px;height:7px;background:var(--muted);border-radius:50%;animation:bounceDot 1.2s infinite}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}

/* ---------- Toast ---------- */
#toasts{position:fixed;top:16px;right:16px;z-index:1000;display:flex;flex-direction:column;gap:10px;max-width:380px}
.toast{background:rgba(24,24,27,.92);backdrop-filter:blur(14px);border:1px solid var(--border2);border-radius:12px;padding:12px 16px;box-shadow:var(--shadow);animation:slideRight .35s cubic-bezier(.22,1,.36,1);font-size:13.5px;position:relative;overflow:hidden}
.toast.ok{border-left:3px solid var(--ok)}.toast.err{border-left:3px solid var(--err)}.toast.warn{border-left:3px solid var(--warn)}
.toast .tbar{position:absolute;bottom:0;left:0;height:2px;background:var(--grad);animation:tbar 4s linear forwards}
@keyframes tbar{from{width:100%}to{width:0}}

/* ---------- Modal ---------- */
#modalBack{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);z-index:900;display:none;align-items:center;justify-content:center;animation:fadeIn .2s}
#modalBack.show{display:flex}
#modalBack .box{background:#141417;border:1px solid var(--border2);border-radius:16px;padding:24px;max-width:640px;width:92%;max-height:84vh;overflow:auto;animation:scaleIn .3s cubic-bezier(.22,1,.36,1);box-shadow:var(--shadow)}

/* ---------- 命令面板 ---------- */
#cmdk{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);z-index:950;display:none;align-items:flex-start;justify-content:center;padding-top:14vh}
#cmdk.show{display:flex;animation:fadeIn .15s}
#cmdk .box{background:#141417;border:1px solid var(--border2);border-radius:14px;width:560px;max-width:92%;box-shadow:var(--shadow);overflow:hidden;animation:scaleIn .25s cubic-bezier(.22,1,.36,1)}
#cmdk input{width:100%;border:none;background:transparent;padding:16px 18px;font-size:15px;border-bottom:1px solid var(--border);border-radius:0}
#cmdk input:focus{box-shadow:none}
#cmdk .items{max-height:320px;overflow:auto;padding:6px}
#cmdk .item{padding:10px 14px;border-radius:8px;cursor:pointer;display:flex;gap:10px;align-items:center;color:var(--muted);transition:background .15s}
#cmdk .item:hover,#cmdk .item.sel{background:rgba(99,102,241,.15);color:var(--text)}
#cmdk .item .ic{width:20px;text-align:center}

/* ---------- 看板 ---------- */
.kanban{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(215px,1fr);gap:12px;overflow-x:auto;padding-bottom:8px}
.kcol{background:rgba(24,24,27,.5);border:1px solid var(--border);border-radius:12px;padding:10px;min-height:220px;transition:border-color .25s,background .25s}
.kcol.dragover{border-color:var(--accent);background:rgba(99,102,241,.08)}
.kcol h3{font-size:12.5px;margin:0 0 10px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;padding:0 4px}
.kcol h3 .cnt{background:#27272a;border-radius:99px;padding:0 8px;font-size:11px}
.kcard{background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:grab;transition:all .2s;animation:popIn .3s cubic-bezier(.34,1.56,.64,1)}
.kcard:hover{border-color:rgba(99,102,241,.5);transform:translateY(-2px);box-shadow:0 6px 18px rgba(0,0,0,.35)}
.kcard:active{cursor:grabbing}
.kcard.dragging{opacity:.4;transform:rotate(2deg) scale(.98)}
.kcard .t{font-weight:600;font-size:13px;margin-bottom:3px}
.kcard .m{color:var(--dim);font-size:11.5px;display:flex;gap:8px;flex-wrap:wrap}

/* ---------- 抽屉 ---------- */
#drawer{position:fixed;top:0;right:-460px;width:440px;max-width:94vw;height:100vh;background:#101013;border-left:1px solid var(--border2);z-index:800;transition:right .35s cubic-bezier(.22,1,.36,1);box-shadow:-16px 0 48px rgba(0,0,0,.5);display:flex;flex-direction:column}
#drawer.show{right:0}
#drawer .dhead{padding:18px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
#drawer .dbody{flex:1;overflow:auto;padding:18px 20px}
#drawer .x{background:none;border:none;color:var(--muted);font-size:20px;padding:2px 8px;cursor:pointer}
#drawer .x:hover{color:var(--text)}

/* ---------- 气泡（审核台） ---------- */
.chat{display:flex;flex-direction:column;gap:2px;margin:14px 0}
.bubble{max-width:78%;padding:9px 14px;border-radius:16px;font-size:13.5px;position:relative;animation:fadeUp .35s cubic-bezier(.22,1,.36,1);white-space:pre-wrap;word-break:break-word}
.bubble.them{align-self:flex-start;background:#1c1c21;border:1px solid var(--border);border-bottom-left-radius:5px}
.bubble.me{align-self:flex-end;background:linear-gradient(135deg,#365314,#1a2e05);border:1px solid rgba(52,211,153,.25);border-bottom-right-radius:5px}
.bubble .bmeta{font-size:10.5px;color:var(--dim);margin-top:4px}

/* ---------- 图表 ---------- */
.chart-wrap{position:relative}
.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;font-size:12px;color:var(--muted)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px}
.hbar{margin-bottom:9px}
.hbar .hl{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px}
.hbar .track{height:9px;background:#18181b;border-radius:99px;overflow:hidden}
.hbar .fill{height:100%;border-radius:99px;width:0;transition:width 1s cubic-bezier(.22,1,.36,1)}
.funnel{display:flex;flex-direction:column;gap:6px}
.fstep{position:relative;height:40px;border-radius:8px;display:flex;align-items:center;padding:0 16px;color:#fff;font-size:13px;font-weight:600;overflow:hidden;transition:transform .25s,filter .25s;cursor:default}
.fstep:hover{transform:scale(1.015);filter:brightness(1.15)}
.fstep .fv{margin-left:auto;font-variant-numeric:tabular-nums}
.funnel .fbar{height:100%;position:absolute;inset:0;background:var(--grad);opacity:.85;transition:width 1s cubic-bezier(.22,1,.36,1)}

/* ---------- 杂项 ---------- */
.muted{color:var(--muted)}.dim{color:var(--dim)}.err{color:var(--err)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.mt{margin-top:14px}.mb{margin-bottom:14px}
.right{margin-left:auto}
.flex{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1}
.clickable{cursor:pointer;user-select:none}
.empty{padding:34px;text-align:center;color:var(--dim)}
.empty .big{font-size:38px;margin-bottom:8px;opacity:.6}
.score-hi{color:#f87171;font-weight:700}.score-mid{color:#fbbf24;font-weight:700}.score-lo{color:#34d399;font-weight:700}.score-no{color:#52525b}
`;

const COMMON_HEAD = (title, active) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${title}</title><style>${STYLE}</style></head><body><div class="wrap">` +
  `<div id="toasts"></div><div id="modalBack"></div><div id="cmdk"></div>` +
  `<nav class="tabs">` +
  `<a href="leads" class="${active === 'leads' ? 'on' : ''}">获客</a>` +
  `<a href="crm" class="${active === 'crm' ? 'on' : ''}">管线</a>` +
  `<a href="review" class="${active === 'review' ? 'on' : ''}">审核台</a>` +
  `<a href="templates" class="${active === 'templates' ? 'on' : ''}">模板</a>` +
  `<a href="settings" class="${active === 'settings' ? 'on' : ''}">设置</a>` +
  `<span class="kbd-hint"><kbd>Ctrl</kbd>+<kbd>K</kbd></span>` +
  `</nav>` +
  SHARED_JS;

const FOOTER = `</div></body></html>`;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 所有页面共享的 JS：toast/modal/命令面板/计数动画/Canvas 图表。 */
const SHARED_JS = `<script>
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function $(sel,root){return (root||document).querySelector(sel);}
function $$(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel));}

/* ---- Toast ---- */
function toast(msg,type,ms){type=type||'ok';ms=ms||4000;
  var box=document.getElementById('toasts');
  var t=document.createElement('div');t.className='toast '+type;
  t.innerHTML=esc(msg)+'<i class="tbar" style="animation-duration:'+(ms/1000)+'s"></i>';
  box.appendChild(t);
  setTimeout(function(){t.style.transition='all .3s';t.style.opacity='0';t.style.transform='translateX(30px)';setTimeout(function(){t.remove()},320)},ms);
}
function toastErr(e){toast(String(e&&e.message||e),'err',6000);}

/* ---- fetch JSON helper ---- */
function api(url,opt){opt=opt||{};opt.headers=Object.assign({'content-type':'application/json'},opt.headers||{});
  return fetch(url,opt).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})});}

/* ---- Modal ---- */
function modal(html,onOpen){var back=document.getElementById('modalBack');
  back.innerHTML='<div class="box">'+html+'</div>';back.classList.add('show');
  back.onclick=function(e){if(e.target===back)closeModal()};
  if(onOpen)onOpen(back.querySelector('.box'));return back.querySelector('.box');}
function closeModal(){var back=document.getElementById('modalBack');back.classList.remove('show');back.innerHTML='';}
function confirmBox(text,onYes){modal('<h3 style="margin:0 0 12px">确认</h3><p style="color:var(--muted)">'+esc(text)+'</p>'+
  '<div class="flex" style="justify-content:flex-end"><button class="ghost" onclick="closeModal()">取消</button>'+
  '<button id="cfYes">确认</button></div>',function(box){box.querySelector('#cfYes').onclick=function(){closeModal();onYes();}});}

/* ---- 数字滚动 ---- */
function countUp(el,to,dur){dur=dur||900;var from=0;var t0=null;
  function frame(t){if(!t0)t0=t;var p=Math.min((t-t0)/dur,1);p=1-Math.pow(1-p,3);
    el.textContent=Math.round(from+(to-from)*p);if(p<1)requestAnimationFrame(frame);}
  requestAnimationFrame(frame);}

/* ---- Canvas 环形图 ---- */
function donut(canvas,segments,centerLabel){var ctx=canvas.getContext('2d');
  var w=canvas.width,h=canvas.height,cx=w/2,cy=h/2,r=Math.min(w,h)/2-8,lw=22;
  var total=segments.reduce(function(s,x){return s+x.value},0);
  if(total===0){ctx.strokeStyle='#27272a';ctx.lineWidth=lw;ctx.beginPath();ctx.arc(cx,cy,r-lw/2,0,Math.PI*2);ctx.stroke();
    if(centerLabel)drawCenter(centerLabel);return;}
  var progress=0;var t0=null;
  function ease(t){return 1-Math.pow(1-t,3)}
  function frame(ts){if(!t0)t0=ts;var p=Math.min((ts-t0)/900,1);var e=ease(p);
    ctx.clearRect(0,0,w,h);var start=-Math.PI/2;
    for(var i=0;i<segments.length;i++){var seg=segments[i];var sweep=(seg.value/total)*Math.PI*2*e;
      ctx.beginPath();ctx.strokeStyle=seg.color;ctx.lineWidth=lw;ctx.lineCap='butt';
      ctx.arc(cx,cy,r-lw/2,start,start+sweep);ctx.stroke();start+=sweep;}
    if(centerLabel)drawCenter(centerLabel);
    if(p<1)requestAnimationFrame(frame);}
  function drawCenter(label){ctx.fillStyle='#fafafa';ctx.font='700 '+(h*0.16)+'px Segoe UI';ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(String(label.value),cx,cy-h*0.04);ctx.fillStyle='#71717a';ctx.font=(h*0.075)+'px Segoe UI';ctx.fillText(label.text,cx,cy+h*0.09);}
  requestAnimationFrame(frame);}

/* ---- 横向条形（CSS 驱动） ---- */
function hbar(container,items){container.innerHTML='';
  items.forEach(function(item,i){
    var wrap=document.createElement('div');wrap.className='hbar';wrap.style.animation='fadeUp .4s '+ (i*0.06)+'s cubic-bezier(.22,1,.36,1) backwards';
    var max=item.max||Math.max.apply(null,items.map(function(x){return x.value}).concat([1]));
    wrap.innerHTML='<div class="hl"><span>'+esc(item.label)+'</span><span>'+item.text+'</span></div>'+
      '<div class="track"><div class="fill" style="background:'+(item.color||'var(--grad)')+'"></div></div>';
    container.appendChild(wrap);
    requestAnimationFrame(function(){requestAnimationFrame(function(){wrap.querySelector('.fill').style.width=Math.max(2,(item.value/max)*100)+'%'})});
  });}

/* ---- 漏斗 ---- */
function funnel(container,steps){container.innerHTML='';
  var max=steps[0]?steps[0].value:1;
  steps.forEach(function(step,i){
    var row=document.createElement('div');row.className='fstep';row.title=step.label+': '+step.value;
    row.style.animation='fadeUp .45s '+(i*0.08)+'s cubic-bezier(.22,1,.36,1) backwards';
    var pct=max>0?Math.max(3,(step.value/max)*100):3;
    row.innerHTML='<div class="fbar" style="width:'+pct+'%;background:'+(step.color||'linear-gradient(90deg,#6366f1,#8b5cf6)')+'"></div>'+
      '<span style="position:relative">'+esc(step.label)+'</span><span class="fv" style="position:relative">'+step.value+'</span>';
    container.appendChild(row);
  });}

/* ---- 迷你趋势线 ---- */
function sparkline(canvas,values,color){var ctx=canvas.getContext('2d');var w=canvas.width,h=canvas.height;
  if(values.length<2)return;var max=Math.max.apply(null,values);var min=Math.min.apply(null,values);
  if(max===min)max=min+1;var t0=null;
  function frame(ts){if(!t0)t0=ts;var p=Math.min((ts-t0)/700,1);var e=1-Math.pow(1-p,3);
    ctx.clearRect(0,0,w,h);ctx.beginPath();
    var n=values.length;
    for(var i=0;i<n;i++){var x=(i/(n-1))*w;var y=h-4-((values[i]-min)/(max-min))*(h-10)*e;
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
    ctx.strokeStyle=color||'#818cf8';ctx.lineWidth=2;ctx.lineJoin='round';ctx.stroke();
    if(p<1)requestAnimationFrame(frame);}
  requestAnimationFrame(frame);}

/* ---- 简易彩带（成交时刻） ---- */
function confetti(){var c=document.createElement('canvas');c.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:1200';
  c.width=innerWidth;c.height=innerHeight;document.body.appendChild(c);var ctx=c.getContext('2d');
  var colors=['#6366f1','#8b5cf6','#d946ef','#34d399','#fbbf24'];
  var parts=[];for(var i=0;i<90;i++){parts.push({x:innerWidth/2,y:innerHeight*0.4,vx:(Math.random()-0.5)*14,vy:Math.random()*-11-3,g:0.32,s:4+Math.random()*5,c:colors[i%5],r:Math.random()*6,vr:(Math.random()-0.5)*0.4,life:90+Math.random()*40});}
  var frames=0;function tick(){ctx.clearRect(0,0,c.width,c.height);var alive=false;
    parts.forEach(function(p){if(p.life<=0)return;alive=true;p.life--;p.x+=p.vx;p.y+=p.vy;p.vy+=p.g;p.r+=p.vr;
      ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.r);ctx.fillStyle=p.c;ctx.globalAlpha=Math.min(1,p.life/30);ctx.fillRect(-p.s/2,-p.s/2,p.s,p.s*0.6);ctx.restore();});
    if(alive)requestAnimationFrame(tick);else c.remove();}
  requestAnimationFrame(tick);}

/* ---- Ctrl+K 命令面板 ---- */
var CMDK_ITEMS=[
  {ic:'1',label:'获客 · 搜索',kw:'search lead 获客 搜索',href:'leads'},
  {ic:'2',label:'管线 · 看板/列表',kw:'crm pipeline 管线 看板',href:'crm'},
  {ic:'3',label:'审核台 · WhatsApp',kw:'review whatsapp 审核 客服',href:'review'},
  {ic:'4',label:'模板 · 邮件/报价',kw:'template quote 邮件 报价 模板',href:'templates'},
  {ic:'5',label:'设置 · 配置',kw:'settings config 设置 配置',href:'settings'},
  {ic:'6',label:'线索加工',kw:'enrich 提取 评分 加工',href:'leads'},
  {ic:'7',label:'效果统计',kw:'stats 统计 回复率',href:'crm'}
];
function initCmdk(){var box=document.getElementById('cmdk');var sel=0;
  function render(q){q=(q||'').toLowerCase();
    var items=CMDK_ITEMS.filter(function(it){return !q||(it.label+' '+it.kw).toLowerCase().includes(q)});
    box.querySelector('.items').innerHTML=items.map(function(it,i){return '<div class="item'+(i===sel?' sel':'')+'" data-href="'+it.href+'"><span class="ic">'+it.ic+'</span>'+esc(it.label)+'</div>'}).join('')||'<div class="item">没有匹配</div>';
    $$('#cmdk .item').forEach(function(el){el.onclick=function(){location.href=el.getAttribute('data-href')}});}
  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();box.classList.add('show');var inp=box.querySelector('input');inp.value='';sel=0;render('');setTimeout(function(){inp.focus()},30);}
    if(e.key==='Escape'){box.classList.remove('show');}
    if(box.classList.contains('show')){
      var items=$$('#cmdk .item[data-href]');
      if(e.key==='ArrowDown'){sel=Math.min(sel+1,items.length-1);render(box.querySelector('input').value);}
      if(e.key==='ArrowUp'){sel=Math.max(sel-1,0);render(box.querySelector('input').value);}
      if(e.key==='Enter'&&items[sel]){location.href=items[sel].getAttribute('data-href');}
    }});
  box.addEventListener('click',function(e){if(e.target===box)box.classList.remove('show')});
  box.innerHTML='<div class="box"><input placeholder="跳转到… (获客/管线/审核/设置)"><div class="items"></div></div>';
  box.querySelector('input').oninput=function(){sel=0;render(this.value)};}
document.addEventListener('DOMContentLoaded',initCmdk);
</script>`;
/* ------------------------------------------------------------------ */
/* 页面 1：谷歌获客（搜索 → 加工 → 入库）                                */
/* ------------------------------------------------------------------ */

function leadsPage() {
  return (
    COMMON_HEAD('谷歌获客 · 三层搜索 + 线索加工', 'leads') +
    `<div class="hero"><h1>谷歌获客</h1><div class="sub">按产品词和市场搜买家 → 提取联系方式 → 滤掉同行平台 → 存入 CRM。</div></div>` +
    `<div class="formula" style="background:var(--card);border:1px dashed var(--border2);border-radius:12px;padding:11px 16px;color:var(--warn);font-size:13px;margin-bottom:18px">搜索公式：<span class="mono">"产品词" WhatsApp [+区号] site:linkedin.com -alibaba -made-in-china -globalsources -supplier -manufacturer</span> · 欧美市场加 LinkedIn 层走邮件，亚非拉市场走 WhatsApp</div>` +
    `<div class="panel"><h2>搜索 <span class="hint">引擎失败自动切换（failover 链）</span></h2>` +
    `<div class="row">` +
    `<div class="field" style="flex:2 1 260px"><label>产品关键词（英文）</label><input id="product" placeholder="hair dryer" onkeydown="if(event.key==='Enter')document.getElementById('go').click()"></div>` +
    `<div class="field"><label>目标市场</label><select id="market"></select></div>` +
    `<div class="field"><label>搜索层级</label><select id="layers"><option value="1,2,3">三层全叠加（最精）</option><option value="1,3">基础+采购信号</option><option value="1">第1层·基础搜索</option><option value="2">第2层·LinkedIn 定位</option><option value="3">第3层·采购信号</option></select></div>` +
    `<div class="field"><label>每层条数</label><select id="perLayer"><option>5</option><option selected>10</option><option>20</option><option>30</option></select></div>` +
    `<div class="field"><label>引擎</label><select id="engine"><option value="">自动(failover)</option><option value="ddg">DuckDuckGo</option><option value="serpapi">SerpAPI(Google)</option><option value="literal">仅生成公式</option></select></div>` +
    `<button id="go">开始搜索</button>` +
    `</div>` +
    `<div id="searchProg" style="display:none;margin-top:14px"><div class="progress"><div class="bar striped" id="progBar" style="width:8%"></div></div><div class="status muted" style="margin-top:6px" id="searchStatus"></div></div>` +
    `</div>` +
    `<div class="panel" id="enrichPanel" style="display:none"><h2>线索加工 <span class="hint">提取联系方式，滤掉同行，评分后入库</span></h2>` +
    `<div class="row">` +
    `<label class="muted" style="align-self:center;cursor:pointer"><input type="checkbox" id="useAI" checked> AI 评分</label>` +
    `<label class="muted" style="align-self:center;cursor:pointer"><input type="checkbox" id="fetchPages" checked> 抓取网页提取联系方式</label>` +
    `<button id="enrich">提取 + 过滤 + 评分 + 入库</button>` +
    `<span class="muted" style="align-self:center;font-size:12.5px">排除项（同行/平台）不会入库</span>` +
    `</div><div id="enrichProg" style="display:none;margin-top:14px"><div class="progress"><div class="bar" id="enrichBar" style="width:0%"></div></div><div class="status muted" style="margin-top:6px" id="enrichStatus"></div></div></div>` +
    `<div id="result"></div>` +
    `<script>` +
    `var sel=document.getElementById('market');` +
    `api('api/markets').then(function(r){if(r.ok)r.j.forEach(function(m){var o=document.createElement('option');o.value=m.key;o.textContent=m.label+(m.dial?' +'+m.dial:'');sel.appendChild(o)})});` +
    `var lastRun=null;` +
    `document.getElementById('go').onclick=function(){` +
    `var product=document.getElementById('product').value.trim();` +
    `if(!product){toast('请输入产品关键词','warn');return;}` +
    `var btn=this;btn.disabled=true;btn.innerHTML='<span class="spinner"></span>搜索中';` +
    `document.getElementById('searchProg').style.display='block';` +
    `document.getElementById('result').innerHTML='';document.getElementById('enrichPanel').style.display='none';` +
    `var pct=8;var timer=setInterval(function(){pct=Math.min(pct+Math.random()*7,88);document.getElementById('progBar').style.width=pct+'%';},700);` +
    `document.getElementById('searchStatus').textContent='逐层搜索中…';` +
    `api('api/leads/search',{method:'POST',body:JSON.stringify({product:product,market:sel.value,layers:document.getElementById('layers').value.split(',').map(Number),perLayer:Number(document.getElementById('perLayer').value),engine:document.getElementById('engine').value})})` +
    `.then(function(res){clearInterval(timer);btn.disabled=false;btn.innerHTML='开始搜索';` +
    `if(!res.ok){document.getElementById('progBar').style.width='100%';document.getElementById('progBar').style.background='linear-gradient(90deg,#ef4444,#dc2626)';document.getElementById('searchStatus').innerHTML='<span class="err">'+esc(res.j.error)+'</span>';toast(res.j.error||'搜索失败','err');return;}` +
    `document.getElementById('progBar').style.width='100%';setTimeout(function(){document.getElementById('searchProg').style.display='none';document.getElementById('progBar').style.width='8%';document.getElementById('progBar').style.background=''},600);` +
    `render(res.j);toast('搜索完成：'+res.j.total+' 条结果');})` +
    `.catch(function(e){clearInterval(timer);btn.disabled=false;btn.innerHTML='开始搜索';toastErr(e);});};` +
    `function render(run){lastRun=run;` +
    `document.getElementById('enrichPanel').style.display='block';` +
    `var chips='<div class="grid g5 stagger" style="margin-bottom:16px">' +` +
    `'<div class="stat accent"><div class="num">'+run.total+'</div><div class="lbl">去重后结果</div></div>' +` +
    `'<div class="stat"><div class="num">'+run.layers.length+'</div><div class="lbl">执行层数</div></div>' +` +
    `'<div class="stat"><div class="num">'+esc(run.engine)+'</div><div class="lbl">引擎</div></div>' +` +
    `'<div class="stat"><div class="num">'+esc(run.marketLabel||run.market)+'</div><div class="lbl">市场</div></div></div>';` +
    `var html=chips+'<div class="row mb"><button class="ghost" onclick="exportCsv(\\''+run.id+'\\')">导出 CSV</button><button class="ghost" onclick="copyLinks()">复制全部链接</button><span class="muted status" id="copyTip"></span>'+(run.engineFallbacks?'<span class="badge warn">引擎切换: '+esc(run.engineFallbacks.join(', '))+'</span>':'')+'</div>';` +
    `var byLayer={};run.results.forEach(function(it){(byLayer[it.layer]=byLayer[it.layer]||[]).push(it)});` +
    `run.layers.forEach(function(layer,li){` +
    `html+='<div class="badge" style="animation:fadeUp .4s '+(li*0.1)+'s backwards">第'+layer.id+'层 · '+esc(layer.name)+'</div>';` +
    `html+='<div class="muted status mb" style="font-size:12px"><span class="mono">'+esc(layer.query)+'</span>'+(layer.error?' <span class="err">[错误: '+esc(layer.error)+']</span>':'')+'</div>';` +
    `var rows=byLayer[layer.id]||[];` +
    `if(rows.length===0){html+='<div class="empty">本层无结果</div>';return;}` +
    `html+='<div class="stagger">';` +
    `rows.forEach(function(it,i){` +
    `html+='<div class="card panel" style="margin-bottom:10px;padding:13px 16px;animation-delay:'+(i*0.05)+'s;display:flex;gap:14px;align-items:flex-start">' +` +
    `'<div class="num" style="color:var(--dim);font-size:15px;min-width:24px">'+(i+1)+'</div>' +` +
    `'<div class="grow"><a href="'+esc(it.url)+'" target="_blank" rel="noopener" style="font-weight:600">'+esc(it.title)+'</a>' +` +
    `'<div class="muted mono" style="font-size:11.5px;margin-top:2px">'+esc(it.url)+'</div>' +` +
    `'<div class="muted" style="font-size:12.5px;margin-top:5px">'+esc(it.snippet)+'</div></div></div>';});` +
    `html+='</div>';});` +
    `window.__lastRun=run;document.getElementById('result').innerHTML=html;}` +
    `document.getElementById('enrich').onclick=function(){` +
    `if(!lastRun){toast('先跑一次搜索','warn');return;}var btn=this;btn.disabled=true;btn.innerHTML='<span class="spinner"></span>加工中';` +
    `document.getElementById('enrichProg').style.display='block';` +
    `var fake=setInterval(function(){var b=document.getElementById('enrichBar');var w=parseFloat(b.style.width)||0;if(w<85)b.style.width=(w+Math.random()*6)+'%';},900);` +
    `document.getElementById('enrichStatus').textContent='抓页 → 提取 → 分类 → 评分 → 入库…';` +
    `api('api/leads/enrich',{method:'POST',body:JSON.stringify({run_id:lastRun.id,useAI:document.getElementById('useAI').checked,fetchPages:document.getElementById('fetchPages').checked,limit:30})})` +
    `.then(function(res){clearInterval(fake);btn.disabled=false;btn.innerHTML='提取 + 过滤 + 评分 + 入库';` +
    `if(!res.ok){document.getElementById('enrichStatus').innerHTML='<span class="err">'+esc(res.j.error)+'</span>';toast(res.j.error,'err');return;}` +
    `document.getElementById('enrichBar').style.width='100%';` +
    `renderEnrich(res.j);toast('加工完成，'+res.j.filter(function(r){return r.leadId}).length+' 条入库','ok');})` +
    `.catch(function(e){clearInterval(fake);btn.disabled=false;btn.innerHTML='提取 + 过滤 + 评分 + 入库';toastErr(e);});};` +
    `function scoreCls(s){return s>=7?'score-hi':(s>=4?'score-mid':(s>=1?'score-lo':'score-no'));}` +
    `function renderEnrich(list){` +
    `var kept=list.filter(function(r){return r.keep});` +
    `document.getElementById('enrichStatus').innerHTML='<span class="ok">完成：'+kept.length+'/'+list.length+' 保留 · '+list.filter(function(r){return r.leadId&&!r.merged}).length+' 新入库 · '+list.filter(function(r){return r.merged}).length+' 合并</span>';` +
    `var html='<div class="stagger">';` +
    `var FITLABEL={yes:'对口',partial:'沾边',no:'不对口'};` +
    `var FITCLS={yes:'ok',partial:'warn',no:'err'};` +
    `list.forEach(function(r,i){` +
    `var ct=[].concat(r.contacts.emails||[]).concat((r.contacts.whatsapps||[]).map(function(w){return 'WA:'+w})).concat(r.contacts.phones||[]).slice(0,4);` +
    `var badge=r.keep?'<span class="badge ok">'+esc(r.kind)+'</span>':'<span class="badge gray">'+esc(r.kind)+'</span>';` +
    `html+='<div class="panel" style="margin-bottom:10px;padding:13px 16px;animation-delay:'+(i*0.04)+'s">' +` +
    `'<div class="flex">'+badge+` +
    `'<span class="'+scoreCls(r.score)+'" style="font-size:16px">'+r.score+' <span style="font-size:12px">'+esc(r.tier)+'</span></span>' +` +
    `(r.fit?'<span class="badge '+FITCLS[r.fit]+'">'+FITLABEL[r.fit]+'</span>':'') +` +
    `(r.leadId?'<span class="badge '+(r.merged?'warn':'ok')+'">'+(r.merged?'CRM合并':'已入库')+'</span>':'')+(r.error?'<span class="badge err">错误</span>':'')+'</div>' +` +
    `'<div style="margin-top:7px"><a href="'+esc(r.url)+'" target="_blank" rel="noopener" style="font-weight:600">'+esc(r.company||r.title)+'</a>' +` +
    `'<span class="muted" style="font-size:12px;margin-left:8px">'+esc(r.reason)+'</span></div>' +` +
    `'<div class="flex mt" style="font-size:12.5px">'+(ct.length?ct.map(function(c){return '<span class="tag mono">'+esc(c)+'</span>'}).join(''):'<span class="score-no">未提取到联系方式</span>')+'</div>' +` +
    `(r.advice?'<div class="muted" style="font-size:12.5px;margin-top:6px">'+esc(r.advice)+'</div>':'') +` +
    `'</div>';});` +
    `html+='</div>';` +
    `var box=document.createElement('div');box.innerHTML=html;document.getElementById('result').appendChild(box);}` +
    `function exportCsv(runId){window.open('api/leads/export.csv?run='+encodeURIComponent(runId),'_blank');}` +
    `function copyLinks(){var run=window.__lastRun||{};var urls=(run.results||[]).map(function(it){return it.url});` +
    `navigator.clipboard.writeText(urls.join('\\n')).then(function(){toast('已复制 '+urls.length+' 条链接')});}` +
    `</script>` +
    FOOTER
  );
}

/* ------------------------------------------------------------------ */
/* 页面 2：CRM（仪表盘 + 看板拖拽 + 列表 + 批量 + 抽屉）                  */
/* ------------------------------------------------------------------ */

function crmPage() {
  return (
    COMMON_HEAD('CRM 管线', 'crm') +
    `<div class="hero"><h1>管线</h1><div class="sub">新线索 → 已评估 → 已触达 → 已回复 → 已报价 → 成交/流失</div></div>` +
    `<div id="dash" class="grid g4 mb"></div>` +
    `<div class="grid g2 mb">` +
    `<div class="panel"><h2>管线分布</h2><div class="chart-wrap" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"><canvas id="donut" width="170" height="170"></canvas><div class="legend grow" id="donutLegend"></div></div></div>` +
    `<div class="panel"><h2>转化漏斗</h2><div class="funnel" id="funnel"></div></div>` +
    `</div>` +
    `<div class="grid g2 mb">` +
    `<div class="panel"><h2>分层 × 回复率</h2><div id="tierBars"></div></div>` +
    `<div class="panel"><h2>触达量 <span class="hint">审计日志推导</span></h2><div id="outreachBars"></div></div>` +
    `</div>` +
    `<div class="panel"><h2>线索库 <span class="hint">看板卡片可拖拽换阶段 · 勾选可批量操作</span></h2>` +
    `<div class="row mb">` +
    `<input id="fQ" placeholder="搜索 公司/域名/邮箱/WA…" style="flex:1 1 220px" oninput="loadDebounced()">` +
    `<select id="fTier" onchange="load()"><option value="">全部分层</option><option>极高</option><option>高</option><option>中</option><option>低</option></select>` +
    `<div class="flex" style="gap:0;background:var(--bg2);border:1px solid var(--border);border-radius:9px;padding:3px">` +
    `<button class="mini" id="vKanban" style="background:var(--grad)">看板</button>` +
    `<button class="mini ghost" id="vList" style="border:none;background:transparent">列表</button></div>` +
    `<button class="ghost mini" onclick="window.open('api/crm/export.csv','_blank')">导出 CSV</button>` +
    `<button class="ghost mini" onclick="window.open('api/crm/vcard','_blank')">导出 vCard</button>` +
    `<button class="ghost mini" onclick="openCalc()">定价计算器</button>` +
    `<label class="ghost mini clickable" style="padding:4px 11px;font-size:12px;border-radius:7px;border:1px solid var(--border);display:inline-block">导入 <input type="file" accept=".csv,.json" id="importFile" style="display:none" onchange="importFile(this)"></label>` +
    `</div>` +
    `<div id="bulkBar" class="flex mb" style="display:none;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.35);border-radius:10px;padding:9px 14px">` +
    `<span>已选 <b id="selCnt">0</b> 条</span>` +
    `<select id="bulkStatus" class="mini"><option value="">改状态为…</option><option value="new">新线索</option><option value="qualified">已评估</option><option value="contacted">已触达</option><option value="replied">已回复</option><option value="quoted">已报价</option><option value="won">已成交</option><option value="lost">已流失</option></select>` +
    `<button class="mini ghost" onclick="bulkApply('status')">应用</button>` +
    `<button class="mini ghost" onclick="bulkApply('sequence-stop')">停止序列</button>` +
    `<span class="right"></span><button class="mini ghost" onclick="clearSel()">取消选择</button></div>` +
    `<div id="kanban" class="kanban"></div>` +
    `<div id="listView" style="display:none"></div>` +
    `</div>` +
    `<div id="drawer"><div class="dhead"><b id="dTitle">详情</b><button class="x" onclick="closeDrawer()">✕</button></div><div class="dbody" id="dBody"></div></div>` +
    `<script>` +
    `var STATUS=['new','qualified','contacted','replied','quoted','won','lost'];` +
    `var SLABEL={new:'新线索',qualified:'已评估',contacted:'已触达',replied:'已回复',quoted:'已报价',won:'已成交',lost:'已流失'};` +
    `var SCOLOR={new:'#6366f1',qualified:'#8b5cf6',contacted:'#22d3ee',replied:'#34d399',quoted:'#fbbf24',won:'#34d399',lost:'#71717a'};` +
    `var allLeads=[];var selected={};var view='kanban';var debounceT=null;` +
    `function scoreCls(s){return s>=7?'score-hi':(s>=4?'score-mid':(s>=1?'score-lo':'score-no'));}` +
    `function loadDebounced(){clearTimeout(debounceT);debounceT=setTimeout(load,350);}` +
    `function load(){` +
    `var qs='?limit=500';if(document.getElementById('fTier').value)qs+='&tier='+encodeURIComponent(document.getElementById('fTier').value);` +
    `if(document.getElementById('fQ').value)qs+='&q='+encodeURIComponent(document.getElementById('fQ').value);` +
    `api('api/crm/list'+qs).then(function(r){if(!r.ok){toast(r.j.error,'err');return;}allLeads=r.j;renderDash();renderBoard();renderList();});}` +
    `function renderDash(){` +
    `api('api/stats').then(function(r){if(!r.ok)return;var s=r.j;var d=document.getElementById('dash');d.innerHTML='';` +
    `var cards=[` +
    `{n:s.funnel.new||0,l:'新线索',c:'accent'},` +
    `{n:s.conversion.contactedTotal,l:'已触达'},` +
    `{n:s.conversion.repliedTotal,l:'已回复'},` +
    `{n:s.conversion.replyRate,l:'回复率',raw:true,accent:true},` +
    `{n:s.conversion.won,l:'成交'}];` +
    `cards.forEach(function(cd,i){var el=document.createElement('div');el.className='stat'+(cd.accent?' accent':'');el.style.animationDelay=(i*0.07)+'s';` +
    `el.innerHTML='<div class="num">0</div><div class="lbl">'+esc(cd.l)+'</div>';d.appendChild(el);` +
    `if(cd.raw){el.querySelector('.num').textContent=cd.n;}else{countUp(el.querySelector('.num'),cd.n);}});` +
    `var segs=STATUS.filter(function(st){return s.funnel[st]>0}).map(function(st){return{label:SLABEL[st],value:s.funnel[st],color:SCOLOR[st]}});` +
    `donut(document.getElementById('donut'),segs.length?segs:[{label:'空',value:1,color:'#27272a'}],{value:s.total||0,text:'线索'});` +
    `document.getElementById('donutLegend').innerHTML=segs.map(function(seg){return '<span><i style="background:'+seg.color+'"></i>'+esc(seg.label)+' '+seg.value+'</span>'}).join('')||'<span class="dim">暂无线索</span>';` +
    `funnel(document.getElementById('funnel'),[` +
    `{label:'触达',value:s.conversion.contactedTotal,color:'linear-gradient(90deg,#6366f1,#818cf8)'},` +
    `{label:'回复',value:s.conversion.repliedTotal,color:'linear-gradient(90deg,#8b5cf6,#a78bfa)'},` +
    `{label:'报价',value:s.funnel.quoted||0,color:'linear-gradient(90deg,#d946ef,#e879f9)'},` +
    `{label:'成交',value:s.conversion.won,color:'linear-gradient(90deg,#10b981,#34d399)'}]);` +
    `var tierItems=Object.entries(s.byTier).filter(function(e){return e[1].contacted>0}).map(function(e){` +
    `return{label:e[0],value:parseInt(e[1].replyRate)||0,text:e[1].replied+'/'+e[1].contacted+' ('+e[1].replyRate+')',color:'linear-gradient(90deg,#6366f1,#8b5cf6)'};});` +
    `hbar(document.getElementById('tierBars'),tierItems.length?tierItems:[{label:'暂无触达数据',value:0,text:''}]);` +
    `hbar(document.getElementById('outreachBars'),[` +
    `{label:'邮件真实发送',value:s.outreach.emailSent,text:String(s.outreach.emailSent)},` +
    `{label:'打开(去重/天)',value:s.tracking?parseInt(s.tracking.openRate)||0:0,text:s.tracking?s.tracking.opened+'/'+s.tracking.trackedEmails+' ('+s.tracking.openRate+')':'-'},` +
    `{label:'WhatsApp 发送',value:s.outreach.waSent,text:String(s.outreach.waSent)},` +
    `{label:'抑制列表',value:s.suppressed,text:String(s.suppressed)}]);` +
    `});}` +
    `function renderBoard(){var kb=document.getElementById('kanban');kb.style.display=view==='kanban'?'grid':'none';` +
    `document.getElementById('listView').style.display=view==='kanban'?'none':'block';` +
    `document.getElementById('vKanban').style.background=view==='kanban'?'var(--grad)':'transparent';` +
    `document.getElementById('vKanban').style.color=view==='kanban'?'#fff':'var(--muted)';` +
    `document.getElementById('vList').style.background=view==='list'?'var(--grad)':'transparent';` +
    `document.getElementById('vList').style.color=view==='list'?'#fff':'var(--muted)';` +
    `if(view!=='kanban')return;kb.innerHTML='';` +
    `STATUS.forEach(function(st,si){` +
    `var leads=allLeads.filter(function(l){return l.status===st});` +
    `var col=document.createElement('div');col.className='kcol';col.style.animation='fadeUp .4s '+(si*0.05)+'s backwards';` +
    `col.innerHTML='<h3><span>'+SLABEL[st]+'</span><span class="cnt">'+leads.length+'</span></h3>';` +
    `col.ondragover=function(e){e.preventDefault();col.classList.add('dragover')};` +
    `col.ondragleave=function(){col.classList.remove('dragover')};` +
    `col.ondrop=function(e){e.preventDefault();col.classList.remove('dragover');` +
    `var id=e.dataTransfer.getData('text/plain');if(!id)return;var card=allLeads.find(function(l){return l.id===id});` +
    `if(card&&card.status!==st){changeStatus(id,st);}};` +
    `leads.forEach(function(l,li){var card=document.createElement('div');card.className='kcard';card.draggable=true;card.style.animationDelay=(li*0.04)+'s';` +
    `card.innerHTML='<div class="t">'+esc(l.company||l.domain)+'</div>' +` +
    `'<div class="m"><span class="'+scoreCls(l.score)+'">'+l.score+'分 '+esc(l.tier)+'</span>' +` +
    `(l.contacts.emails&&l.contacts.emails.length?'<span title="有邮箱">邮</span>':'') +` +
    `(l.contacts.whatsapps&&l.contacts.whatsapps.length?'<span title="有WhatsApp">WA</span>':'') +` +
    `(l.sequence?'<span title="序列中">序</span>':'')+(l.lastReply?'<span title="已回复">复</span>':'')+'</div>';` +
    `card.onclick=function(){openDrawer(l.id)};` +
    `card.ondragstart=function(e){e.dataTransfer.setData('text/plain',l.id);card.classList.add('dragging')};` +
    `card.ondragend=function(){card.classList.remove('dragging')};` +
    `col.appendChild(card);});` +
    `kb.appendChild(col);});}` +
    `function renderList(){var box=document.getElementById('listView');` +
    `if(allLeads.length===0){box.innerHTML='<div class="empty">暂无线索。去「获客」页跑一轮搜索并加工入库。</div>';return;}` +
    `var html='<table><thead><tr><th style="width:30px"><input type="checkbox" onchange="toggleAll(this)"></th><th>公司</th><th>评分</th><th>状态</th><th>联系方式</th><th>最近动作</th><th></th></tr></thead><tbody class="stagger">';` +
    `allLeads.forEach(function(l,i){` +
    `var ct=[].concat(l.contacts.emails||[]).concat((l.contacts.whatsapps||[]).map(function(w){return 'WA:'+w})).slice(0,3);` +
    `var last=l.activities&&l.activities.length?l.activities[l.activities.length-1]:null;` +
    `html+='<tr style="animation-delay:'+(i*0.03)+'s">' +` +
    `'<td><input type="checkbox" onchange="selRow(\\''+l.id+'\\',this.checked)" '+(selected[l.id]?'checked':'')+'></td>' +` +
    `'<td><a href="#" onclick="openDrawer(\\''+l.id+'\\');return false" style="font-weight:600">'+esc(l.company||l.domain)+'</a><br><span class="dim" style="font-size:11.5px">'+esc(l.market||'')+'</span></td>' +` +
    `'<td class="'+scoreCls(l.score)+'">'+l.score+' '+esc(l.tier)+'</td>' +` +
    `'<td><span class="badge" style="border-color:'+SCOLOR[l.status]+'55;color:'+SCOLOR[l.status]+'">'+SLABEL[l.status]+'</span></td>' +` +
    `'<td class="muted" style="font-size:12px">'+(ct.length?ct.map(esc).join('<br>'):'—')+'</td>' +` +
    `'<td class="muted" style="font-size:12px;max-width:220px">'+(last?esc(last.note.slice(0,60)):'—')+'</td>' +` +
    `'<td><button class="mini ghost" onclick="openDrawer(\\''+l.id+'\\')">详情</button></td></tr>';});` +
    `html+='</tbody></table>';box.innerHTML=html;}` +
    `document.getElementById('vKanban').onclick=function(){view='kanban';renderBoard();};` +
    `document.getElementById('vList').onclick=function(){view='list';renderBoard();renderList();};` +
    `function changeStatus(id,status){api('api/crm/update',{method:'POST',body:JSON.stringify({id:id,status:status})})` +
    `.then(function(r){if(!r.ok){toast(r.j.error,'err');load();return;}` +
    `if(status==='won'){confetti();toast('成交，恭喜','ok');}else{toast('已移至 '+SLABEL[status]);}load();});}` +
    `function selRow(id,checked){if(checked)selected[id]=true;else delete selected[id];updateBulkBar();}` +
    `function toggleAll(cb){allLeads.forEach(function(l){if(cb.checked)selected[l.id]=true;else delete selected[l.id]});renderList();updateBulkBar();}` +
    `function updateBulkBar(){var n=Object.keys(selected).length;document.getElementById('bulkBar').style.display=n?'flex':'none';document.getElementById('selCnt').textContent=n;}` +
    `function clearSel(){selected={};updateBulkBar();renderList();}` +
    `function bulkApply(action){var ids=Object.keys(selected);if(!ids.length)return;` +
    `var value=action==='status'?document.getElementById('bulkStatus').value:undefined;` +
    `if(action==='status'&&!value){toast('先选状态','warn');return;}` +
    `confirmBox('对 '+ids.length+' 条线索执行批量操作？',function(){` +
    `api('api/crm/bulk',{method:'POST',body:JSON.stringify({ids:ids,action:action,value:value})})` +
    `.then(function(r){if(!r.ok){toast(r.j.error,'err');return;}toast('批量完成 '+r.j.results.filter(function(x){return x.ok}).length+'/'+ids.length);clearSel();load();});});}` +
    `function importFile(input){var file=input.files[0];if(!file)return;var reader=new FileReader();` +
    `reader.onload=function(){try{var rows=[];` +
    `if(file.name.endsWith('.json')){rows=JSON.parse(reader.result);}else{` +
    `var lines=reader.result.replace(/^\\uFEFF/,'').split(/\\r?\\n/).filter(Boolean);` +
    `var head=lines[0].split(',').map(function(h){return h.trim().replace(/^"|"$/g,'')});` +
    `rows=lines.slice(1).map(function(line){var cells=line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)||[];` +
    `var obj={};head.forEach(function(h,i){obj[h]=(cells[i]||'').replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"')});return obj;});}` +
    `api('api/crm/import',{method:'POST',body:JSON.stringify({rows:rows})})` +
    `.then(function(r){if(!r.ok){toast(r.j.error,'err');return;}toast('导入完成：新增 '+r.j.imported+'，合并 '+r.j.merged);load();});` +
    `}catch(e){toast('解析失败：'+e.message,'err');}};reader.readAsText(file,'utf-8');input.value='';}` +
    `function openDrawer(id){var l=allLeads.find(function(x){return x.id===id});if(!l)return;` +    `document.getElementById('dTitle').textContent=l.company||l.domain;` +
    `var ct=[].concat(l.contacts.emails||[]).concat((l.contacts.whatsapps||[]).map(function(w){return 'WA: +'+w})).concat(l.contacts.phones||[]);` +
    `var acts=(l.activities||[]).slice(-8).reverse();` +
    `document.getElementById('dBody').innerHTML=` +
    `'<div class="flex mb"><span class="badge" style="border-color:'+SCOLOR[l.status]+'55;color:'+SCOLOR[l.status]+'">'+SLABEL[l.status]+'</span>' +` +
    `'<span class="'+scoreCls(l.score)+'" style="font-size:18px">'+l.score+'分</span><span class="badge gray">'+esc(l.tier)+'</span>' +` +
    `(l.fit?'<span class="badge '+(l.fit==='yes'?'ok':(l.fit==='no'?'err':'warn'))+'">'+(l.fit==='yes'?'对口':(l.fit==='no'?'不对口':'沾边'))+'</span>':'') +` +
    `(l.sequence?'<span class="badge">序列中</span>':'')+'</div>' +` +
    `(l.advice?'<div class="panel" style="padding:12px 14px;margin-bottom:12px">'+esc(l.advice)+'</div>':'') +` +
    `'<div class="mb"><div class="muted" style="font-size:12px;margin-bottom:5px">联系方式</div>' +` +
    `(ct.length?ct.map(function(c){return '<div class="mono" style="padding:3px 0">'+esc(c)+'</div>'}).join(''):'<span class="dim">无</span>')+'</div>' +` +
    `(l.lastReply?'<div class="panel" style="padding:12px 14px;margin-bottom:12px"><b class="ok">最近回复 ['+esc(l.lastReply.category)+']</b><div class="muted" style="font-size:12.5px;margin-top:4px">'+esc(l.lastReply.summary)+'</div></div>':'') +` +
    `'<div class="muted" style="font-size:12px;margin-bottom:5px">动作时间线</div>' +` +
    `acts.map(function(a){return '<div style="padding:7px 0;border-bottom:1px solid rgba(39,39,42,.6);font-size:12.5px"><span class="dim mono">'+a.ts.slice(5,16)+'</span> '+esc(a.note)+'</div>'}).join('') || '<span class="dim">无</span>';` +
    `document.getElementById('drawer').classList.add('show');}` +
    `function closeDrawer(){document.getElementById('drawer').classList.remove('show');}` +
    `/* ---- 定价计算器（实时联动） ---- */` +
    `function openCalc(){` +
    `modal('<h3 style="margin:0 0 14px">定价计算器 <span class="dim" style="font-size:12px;font-weight:400">Incoterms 2020 叠加</span></h3>' +` +
    `'<div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">' +` +
    `['exw|出厂成本','inland|国内运费','port|港口/报关费','ocean|海运费','insurance_rate|保险率%','dest|目的港清关费','dest_freight|目的地运费','margin|利润率%'].map(function(f){` +
    `var p=f.split('|');return '<div class="field"><label>'+p[1]+'</label><input type="number" id="pc-'+p[0]+'" value="0" oninput="calcLive()"></div>'}).join('') +` +
    `'<div class="field"><label>口径</label><select id="pc-mode" onchange="calcLive()"><option value="total">整批金额</option><option value="unit">单件成本</option></select></div>' +` +
    `'<div class="field"><label>数量</label><input type="number" id="pc-qty" value="1000" oninput="calcLive()"></div></div>' +` +
    `'<div id="pcOut" class="mt"></div>',` +
    `function(box){calcLive();});}` +
    `function calcLive(){var g=function(k){return Number((document.getElementById('pc-'+k)||{}).value)||0};` +
    `var body={mode:document.getElementById('pc-mode').value,qty:g('qty'),exw:g('exw'),inland:g('inland'),port:g('port'),ocean:g('ocean'),insurance_rate:g('insurance_rate'),dest:g('dest'),dest_freight:g('dest_freight'),margin:g('margin')};` +
    `api('api/calc/price',{method:'POST',body:JSON.stringify(body)})` +
    `.then(function(r){if(!r.ok)return;var c=r.j;` +
    `document.getElementById('pcOut').innerHTML=` +
    `'<table><tr><th></th><th>成本</th><th>报价(+'+esc(c.margin)+')</th></tr>' +` +
    `['EXW','FOB','CFR','CIF','DDP'].map(function(k){return '<tr><td><b>'+k+'</b></td><td class="mono">'+c.cost[k].toLocaleString()+'</td><td class="mono" style="color:#a5b4fc;font-weight:700">'+c.quote[k].toLocaleString()+'</td></tr>'}).join('')+'</table>' +` +
    `'<div class="muted mt" style="font-size:12px">单件：FOB ≈ '+c.perUnit.FOB+' · CIF ≈ '+c.perUnit.CIF+'</div>';` +
    `});}` +
    `load();` +
    `</script>` +
    FOOTER
  );
}

/* ------------------------------------------------------------------ */
/* 页面 3：客服审核台（WhatsApp 气泡风）                                 */
/* ------------------------------------------------------------------ */

function reviewPage() {
  return (
    COMMON_HEAD('客服审核台', 'review') +
    `<div class="hero"><h1>审核台</h1><div class="sub">买家消息先进队列 · AI 起草 · 人工确认才发送</div></div>` +
    `<div class="panel"><div class="row" style="align-items:center">` +
    `<span id="pills" class="muted">加载中…</span><span class="grow"></span>` +
    `<button class="ghost" id="refresh">↻ 刷新</button></div></div>` +
    `<div id="queue"></div>` +
    `<script>` +
    `function fmtTs(t){try{return new Date(t).toLocaleString('zh-CN')}catch(e){return t}}` +
    `function loadStatus(){api('api/status').then(function(r){if(!r.ok)return;var s=r.j;` +
    `document.getElementById('pills').innerHTML=` +
    `'<span class="pill '+(s.evolution.ready?'on':'off')+'">Evolution '+(s.evolution.ready?'✓':'未配置')+'</span>' +` +
    `'<span class="pill '+(s.webhookTokenSet?'on':'off')+'">Webhook '+(s.webhookTokenSet?'✓':'未设token')+'</span>' +` +
    `'<span class="pill '+(s.deepseek.ready?'on':'off')+'">AI草稿 '+(s.deepseek.ready?'✓':'无key')+'</span>' +` +
    `'<span class="pill '+(s.smtp.ready?(s.smtp.dryRun?'off':'on'):'off')+'">SMTP '+(s.smtp.ready?(s.smtp.dryRun?'dry-run':'可发送'):'未配置')+'</span>';});}` +
    `function loadQueue(){api('api/review/queue?limit=50').then(function(r){if(!r.ok)return;var list=r.j;` +
    `var box=document.getElementById('queue');` +
    `if(!list.length){box.innerHTML='<div class="panel"><div class="empty">队列为空。<br><span style="font-size:12.5px">Evolution webhook → /waimao/webhook/evolution?token=…，或让智能体调用 wa_sync 拉取。</span></div></div>';return;}` +
    `var html='';` +
    `list.forEach(function(m,i){` +
    `html+='<div class="panel" style="animation:fadeUp .4s '+(i*0.06)+'s backwards" id="m-'+esc(m.id)+'">' +` +
    `'<div class="flex mb"><b>'+esc(m.name||m.sender)+'</b><span class="dim mono" style="font-size:11.5px">'+esc(m.chatJid)+'</span><span class="dim" style="font-size:11.5px">'+fmtTs(m.ts)+'</span>' +` +
    `'<span class="badge gray right">'+esc(m.status)+'</span></div>' +` +
    `'<div class="chat"><div class="bubble them">'+esc(m.text)+'<div class="bmeta">'+fmtTs(m.ts)+'</div></div>' +` +
    `'<div id="draftWrap-'+esc(m.id)+'"></div></div>' +` +
    `'<div class="actions">' +` +
    `'<button class="mini" onclick="draft(\\''+esc(m.id)+'\\',this)">AI 草稿</button>' +` +
    `'<button class="mini" onclick="send(\\''+esc(m.id)+'\\',this)">审核并发送</button>' +` +
    `'<button class="mini ghost" onclick="ignore(\\''+esc(m.id)+'\\',this)">忽略</button></div>' +` +
    `'<div class="msg status mt" id="tip-'+esc(m.id)+'"></div></div>';});` +
    `box.innerHTML=html;});}` +
    `document.getElementById('refresh').onclick=loadQueue;` +
    `function tipOf(id){return document.getElementById('tip-'+CSS.escape(id));}` +
    `function draft(id,btn){btn.disabled=true;` +
    `document.getElementById('draftWrap-'+CSS.escape(id)).innerHTML='<div class="bubble me typing"><i></i><i></i><i></i></div>';` +
    `api('api/review/draft',{method:'POST',body:JSON.stringify({id:id})})` +
    `.then(function(r){btn.disabled=false;var wrap=document.getElementById('draftWrap-'+CSS.escape(id));` +
    `if(!r.ok){wrap.innerHTML='';tipOf(id).innerHTML='<span class="err">'+esc(r.j.error)+'</span>';return;}` +
    `wrap.innerHTML='<div class="bubble me">'+esc(r.j.draft)+'<div class="bmeta">AI 草稿 · 可编辑</div></div>' +` +
    `'<textarea class="mt" style="width:100%;min-height:70px" id="ta-'+esc(id)+'">'+esc(r.j.draft)+'</textarea>';` +
    `toast('草稿已生成');});}` +
    `function send(id,btn){var ta=document.getElementById('ta-'+CSS.escape(id));var text=ta?ta.value.trim():'';` +
    `if(!text){toast('先写回复（可先 AI 草稿）','warn');return;}btn.disabled=true;` +
    `api('api/review/send',{method:'POST',body:JSON.stringify({id:id,text:text})})` +
    `.then(function(r){btn.disabled=false;` +
    `if(!r.ok){tipOf(id).innerHTML='<span class="err">'+esc(r.j.error)+'</span>';return;}` +
    `var wrap=document.getElementById('draftWrap-'+CSS.escape(id));` +
    `wrap.innerHTML='<div class="bubble me">'+esc(text)+'<div class="bmeta">已发送 ✓</div></div>';` +
    `tipOf(id).innerHTML='<span class="ok">发送成功</span>';toast('已发送');}).catch(function(e){btn.disabled=false;toastErr(e);});}` +
    `function ignore(id,btn){api('api/review/ignore',{method:'POST',body:JSON.stringify({id:id})})` +
    `.then(function(){var card=document.getElementById('m-'+CSS.escape(id));if(card){card.style.opacity=.35;}});}` +
    `loadStatus();loadQueue();` +
    `</script>` +
    FOOTER
  );
}

/* ------------------------------------------------------------------ */
/* 页面 4：设置（分页签 + 动效）                                        */
/* ------------------------------------------------------------------ */

const SETTINGS_SECTIONS = [
  { key: 'icp', title: 'ICP 画像', fields: [
    ['product', '我方产品（一句英文，如 professional hair dryers 1800-2400W）', 'text'],
    ['buyers', '对口买家类型（英文，如 wholesalers, beauty supply distributors）', 'text'],
  ] },
  { key: 'serp', title: 'SERP 搜索', test: 'serp', fields: [
    ['engine', '首选引擎', 'select', [['ddg', 'DuckDuckGo(免key)'], ['serpapi', 'SerpAPI(Google)']]],
    ['serpapiKey', 'SerpAPI Key', 'password'],
    ['perLayer', '每层条数', 'number'],
    ['proxy', '代理 (http://127.0.0.1:7890)', 'text'],
  ] },
  { key: 'smtp', title: 'SMTP 发信', test: 'smtp', fields: [
    ['host', '服务器', 'text'],
    ['port', '端口', 'number'],
    ['user', '账号', 'text'],
    ['pass', '密码/授权码', 'password'],
    ['from', '发件人', 'text'],
    ['fromName', '发件人名', 'text'],
    ['dryRun', 'dry-run 总闸', 'select', [['true', 'true（安全，只预览）'], ['false', 'false（真实发送）']]],
    ['dailyCap', '每日真实发送上限（新域名建议 20-30，0=不限制）', 'number'],
    ['plainText', '纯文本模式（不注入追踪，投递率更好）', 'select', [['false', '关'], ['true', '开']]],
  ] },
  { key: 'imap', title: 'IMAP 回复检测', test: 'imap', fields: [
    ['host', '服务器', 'text'],
    ['port', '端口', 'number'],
    ['user', '账号', 'text'],
    ['pass', '密码/授权码', 'password'],
    ['mailbox', '邮箱夹', 'text'],
  ] },
  { key: 'evolution', title: 'Evolution API (WhatsApp)', test: 'evolution', fields: [
    ['baseURL', 'Base URL', 'text'],
    ['apiKey', 'API Key', 'password'],
    ['instance', '实例名', 'text'],
  ], extra: 'waConnect' },
  { key: 'deepseek', title: 'DeepSeek', test: 'deepseek', fields: [
    ['baseURL', 'Base URL', 'text'],
    ['apiKey', 'API Key', 'password'],
    ['model', '模型', 'text'],
  ] },
  { key: 'instantly', title: 'Instantly', test: 'instantly', fields: [
    ['apiKey', 'API Key（推线索进 Instantly 活动用）', 'password'],
  ] },
  { key: 'track', title: '打开/点击追踪', fields: [
    ['publicBaseUrl', '公网入口 (反代到 127.0.0.1:3080)', 'text'],
    ['secret', '点击签名密钥', 'password'],
  ] },
  { key: 'warmup', title: '邮箱预热', fields: [
    ['enabled', '启用', 'select', [['false', '关'], ['true', '开']]],
    ['maxPerDay', '爬坡封顶(封/天)', 'number'],
  ] },
  { key: 'cron', title: '定时任务', fields: [
    ['enabled', '总开关', 'select', [['true', '开'], ['false', '关']]],
    ['waSyncEveryMin', 'WA轮询(分钟)', 'number'],
    ['sequenceCheckEveryMin', '序列检查(分钟)', 'number'],
    ['replyScanEveryMin', '回复扫描(分钟)', 'number'],
    ['monitorEveryHour', '官网监控(小时)', 'number'],
    ['dailyReportAt', '日报时间(HH:mm)', 'text'],
    ['staleDays', '停跟进天数', 'number'],
  ] },
  { key: 'wa', title: '群发频控', fields: [
    ['dailyBroadcastCap', '每日上限', 'number'],
    ['minDelaySec', '最小间隔(秒)', 'number'],
    ['maxDelaySec', '最大间隔(秒)', 'number'],
  ] },
];

function settingsPage() {
  const tabs = SETTINGS_SECTIONS.map((section, index) =>
    `<button class="mini ghost setTab" data-tab="${section.key}" style="border:none;background:transparent" onclick="showTab('${section.key}',this)">${esc(section.title)}</button>`,
  ).join('');
  const panels = SETTINGS_SECTIONS.map((section, index) => {
    const fields = section.fields
      .map(([key, label, kind, options]) => {
        if (kind === 'select') {
          const opts = options.map(([value, text]) => `<option value="${value}">${esc(text)}</option>`).join('');
          return `<label>${esc(label)}</label><select data-section="${section.key}" data-key="${key}">${opts}</select>`;
        }
        const type = kind === 'password' ? 'password' : kind === 'number' ? 'number' : 'text';
        return `<label>${esc(label)}</label><input type="${type}" data-section="${section.key}" data-key="${key}" autocomplete="off">`;
      })
      .join('');
    const testButton = section.test ? `<button class="mini ghost" onclick="testConn('${section.test}',this)">测试连通</button>` : '';
    const waConnect = section.extra === 'waConnect'
      ? `<button class="mini" onclick="waConnect(this)">扫码接入 WhatsApp</button>` +
        `<span class="mini ghost" id="waState" style="border:none;background:transparent;cursor:default"></span>` +
        `<div id="waQr" class="mt"></div>`
      : '';
    return `<div class="panel setPanel" id="tab-${section.key}" style="display:${index === 0 ? 'block' : 'none'};animation:fadeUp .35s backwards"><h2>${esc(section.title)}</h2><div class="kv">${fields}</div><div class="msg status" id="t-${section.key}"></div><div class="flex">${testButton}${waConnect}</div></div>`;
  }).join('');
  return (
    COMMON_HEAD('设置', 'settings') +
    `<div class="hero"><h1>设置</h1><div class="sub">配置写入 ~/.waimao/config.json · 密钥只写不读 · 每个区块可单独测试连通</div></div>` +
    `<div class="flex mb">${tabs}<span class="grow"></span><button id="save">保存全部</button></div>` +
    panels +
    `<script>` +
    `var SECRET_KEYS=['serpapiKey','apiKey','pass','secret'];` +
    `function showTab(key,btn){$$('.setPanel').forEach(function(p){p.style.display=p.id==='tab-'+key?'block':'none'});` +
    `$$('.setTab').forEach(function(b){b.style.background='transparent';b.style.color='var(--muted)'});` +
    `btn.style.background='var(--grad)';btn.style.color='#fff';` +
    `var panel=document.getElementById('tab-'+key);panel.style.animation='none';void panel.offsetHeight;panel.style.animation='fadeUp .35s';}` +
    `api('api/config').then(function(r){if(!r.ok)return;var s=r.j;` +
    `$$('[data-section]').forEach(function(el){` +
    `var sec=el.getAttribute('data-section'),key=el.getAttribute('data-key');` +
    `var v=(s[sec]||{})[key];` +
    `if(v===undefined||v===null){` +
    `var flag='has'+key.charAt(0).toUpperCase()+key.slice(1);` +
    `if(SECRET_KEYS.indexOf(key)>=0&&s[sec]&&s[sec][flag]){el.placeholder='已设置，留空保持不变';}` +
    `return;}` +
    `el.value=String(v);});});` +
    `document.getElementById('save').onclick=function(){var btn=this;btn.disabled=true;btn.innerHTML='保存中…';` +
    `var patch={};` +
    `$$('[data-section]').forEach(function(el){` +
    `var sec=el.getAttribute('data-section'),key=el.getAttribute('data-key');` +
    `patch[sec]=patch[sec]||{};var v=el.value;` +
    `if(el.type==='number'||['perLayer','port','staleDays','dailyBroadcastCap','minDelaySec','maxDelaySec','waSyncEveryMin','sequenceCheckEveryMin','replyScanEveryMin','monitorEveryHour','maxPerDay','dailyCap'].indexOf(key)>=0){v=Number(v);}` +
    `if(['dryRun','enabled','plainText'].indexOf(key)>=0){v=v==='true';}` +
    `if(SECRET_KEYS.indexOf(key)>=0&&!v){return;}` +
    `patch[sec][key]=v;});` +
    `api('api/config',{method:'POST',body:JSON.stringify(patch)})` +
    `.then(function(r){btn.disabled=false;btn.innerHTML='保存全部';` +
    `if(r.j.error){toast(r.j.error,'err');}else{toast('已保存 ✓');}});};` +
    `function testConn(name,btn){btn.disabled=true;btn.innerHTML='<span class="spinner"></span>测试中';` +
    `var tip=document.getElementById('t-'+name);tip.textContent='';` +
    `api('api/test/'+name,{method:'POST'})` +
    `.then(function(r){btn.disabled=false;btn.innerHTML='测试连通';` +
    `tip.innerHTML=r.j.ok?'<span class="ok">'+esc(r.j.message)+'</span>':'<span class="err">'+esc(r.j.error||'失败')+'</span>';` +
    `if(r.j.ok)toast(name+' 连通 ✓');else toast(name+' 连接失败','err');});}` +
    `function waConnect(btn){btn.disabled=true;btn.innerHTML='<span class="spinner"></span>请求中';` +
    `var box=document.getElementById('waQr');var st=document.getElementById('waState');` +
    `api('api/evolution/connect',{method:'POST'})` +
    `.then(function(r){btn.disabled=false;btn.innerHTML='扫码接入 WhatsApp';` +
    `if(r.j.error){st.innerHTML='<span class="err">'+esc(r.j.error)+'</span>';return;}` +
    `if(r.j.connected){st.innerHTML='<span class="ok">已连接</span>';box.innerHTML='';toast('WhatsApp 已连接');return;}` +
    `st.innerHTML='<span class="warn">等待扫码</span>';` +
    `var html='';` +
    `if(r.j.qrcodeBase64){var src=r.j.qrcodeBase64.startsWith('data:')?r.j.qrcodeBase64:'data:image/png;base64,'+r.j.qrcodeBase64;` +
    `html+='<img src="'+src+'" alt="QR" style="width:220px;height:220px;background:#fff;padding:8px;border-radius:8px">';}` +
    `if(r.j.pairingCode){html+='<div class="mt mono" style="font-size:18px">配对码: <b>'+esc(r.j.pairingCode)+'</b></div>';}` +
    `html+='<div class="muted" style="font-size:12px">WhatsApp → 设置 → 已关联的设备 → 关联设备</div>';` +
    `box.innerHTML=html;` +
    `}).catch(function(e){btn.disabled=false;btn.innerHTML='扫码接入 WhatsApp';toastErr(e);});}` +
    `</script>` +
    FOOTER
  );
}

/* ------------------------------------------------------------------ */
/* 页面 5：模板（邮件模板库 + 报价默认条款）                             */
/* ------------------------------------------------------------------ */

function templatesPage() {
  return (
    COMMON_HEAD('邮件与报价模板', 'templates') +
    `<div class="hero"><h1>模板</h1><div class="sub">邮件模板供 email_compose 直接复用 · 报价条款是 quote_pdf / proforma_pdf 的缺省值</div></div>` +
    `<div class="panel"><div class="row" style="align-items:center">` +
    `<h2 style="margin:0">邮件模板</h2><span class="grow"></span>` +
    `<button id="newTpl">新建模板</button></div>` +
    `<div id="tplList" class="mt">加载中…</div></div>` +
    `<div class="panel"><h2>报价默认条款 <span class="hint">quote_pdf / proforma_pdf 参数没传时用这里的价值</span></h2>` +
    `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">` +
    `<div class="field"><label>币种</label><input id="q-currency" placeholder="USD"></div>` +
    `<div class="field"><label>付款方式</label><input id="q-payment" placeholder="T/T 30% deposit..."></div>` +
    `<div class="field"><label>交期</label><input id="q-leadTime" placeholder="25-35 days after deposit"></div>` +
    `<div class="field"><label>报价有效期</label><input id="q-validity" placeholder="15 days"></div>` +
    `<div class="field"><label>收款银行</label><input id="q-bankName"></div>` +
    `<div class="field"><label>银行账号</label><input id="q-bankAccount"></div>` +
    `<div class="field"><label>SWIFT</label><input id="q-bankSwift"></div>` +
    `<div class="field"><label>收款人（Beneficiary）</label><input id="q-bankBeneficiary"></div>` +
    `</div>` +
    `<div class="field mt"><label>报价单备注（每份 PDF 末尾都会带）</label><textarea id="q-notes" style="min-height:60px"></textarea></div>` +
    `<div class="flex mt"><button id="saveQuote">保存报价条款</button><span class="msg status" id="qTip"></span></div>` +
    `</div>` +
    `<script>` +
    `function loadTpls(){api('api/templates').then(function(r){if(!r.ok)return;var list=r.j;` +
    `var box=document.getElementById('tplList');` +
    `if(!list.length){box.innerHTML='<div class="empty">还没有模板。对话里让智能体调 template_save，或点「新建模板」。</div>';return;}` +
    `var html='';list.forEach(function(t,i){` +
    `html+='<div class="panel" style="margin-bottom:10px;padding:12px 16px;animation:fadeUp .35s '+(i*0.05)+'s backwards">' +` +
    `'<div class="flex"><b>'+esc(t.name)+'</b><span class="badge gray">'+esc(t.language)+'</span>' +` +
    `(t.tags&&t.tags.length?t.tags.map(function(x){return '<span class="tag">'+esc(x)+'</span>'}).join(''):'') +` +
    `'<span class="right"></span><button class="mini ghost" onclick="delTpl(\\''+t.id+'\\',this)">删除</button></div>' +` +
    `'<div class="mt" style="font-weight:600;font-size:13px">'+esc(t.subject)+'</div>' +` +
    `'<div class="muted" style="font-size:12.5px;white-space:pre-wrap;margin-top:4px">'+esc(t.bodyPreview||'')+'</div>' +` +
    `'<div class="dim" style="font-size:11.5px;margin-top:6px">用于 '+t.used+' 次 · 更新 '+String(t.updatedAt||'').slice(0,10)+'</div></div>';});` +
    `box.innerHTML=html;});}` +
    `function delTpl(id,btn){confirmBox('删除这个模板？',function(){api('api/templates/delete',{method:'POST',body:JSON.stringify({id:id})})` +
    `.then(function(r){if(!r.ok){toast(r.j.error,'err');return;}toast('已删除');loadTpls();});});}` +
    `document.getElementById('newTpl').onclick=function(){` +
    `modal('<h3 style="margin:0 0 14px">新建邮件模板</h3>' +` +
    `'<div class="grid" style="grid-template-columns:2fr 1fr;gap:10px">' +` +
    `'<div class="field"><label>模板名（唯一）</label><input id="nt-name" placeholder="hair-dryer-first-en"></div>' +` +
    `'<div class="field"><label>语言</label><select id="nt-lang"><option value="en">en</option><option value="es">es</option><option value="pt">pt</option></select></div></div>' +` +
    `'<div class="field mt"><label>主题</label><input id="nt-subject" placeholder="Hair dryers supply for {company}"></div>' +` +
    `'<div class="field mt"><label>正文</label><textarea id="nt-body" style="min-height:160px"></textarea></div>',` +
    `function(box){box.querySelector('#nt-name').focus();});` +
    `var back=document.getElementById('modalBack');` +
    `var footer=document.createElement('div');footer.className='flex';footer.style.cssText='justify-content:flex-end;margin-top:14px';` +
    `footer.innerHTML='<button class="ghost" onclick="closeModal()">取消</button><button id="ntSave">保存</button>';` +
    `back.querySelector('.box').appendChild(footer);` +
    `footer.querySelector('#ntSave').onclick=function(){` +
    `var name=back.querySelector('#nt-name').value.trim();var subject=back.querySelector('#nt-subject').value.trim();var body=back.querySelector('#nt-body').value.trim();` +
    `if(!name||!subject||!body){toast('名字、主题、正文都要填','warn');return;}` +
    `api('api/templates',{method:'POST',body:JSON.stringify({name:name,language:back.querySelector('#nt-lang').value,subject:subject,body:body})})` +
    `.then(function(r){if(!r.ok){toast(r.j.error,'err');return;}closeModal();toast('模板已保存');loadTpls();});};};` +
    `api('api/quote-defaults').then(function(r){if(!r.ok)return;var q=r.j;` +
    `var map={currency:'#q-currency',payment:'#q-payment',leadTime:'#q-leadTime',validity:'#q-validity',notes:'#q-notes'};` +
    `Object.keys(map).forEach(function(k){var el=document.querySelector(map[k]);if(el&&q[k]!==undefined&&q[k]!==null)el.value=String(q[k]);});` +
    `var bank=q.bank||{};` +
    `[['bankName','#q-bankName'],['bankAccount','#q-bankAccount'],['bankSwift','#q-bankSwift'],['bankBeneficiary','#q-bankBeneficiary']].forEach(function(p){var el=document.querySelector(p[1]);if(el&&bank[p[0]])el.value=bank[p[0]];});` +
    `});` +
    `document.getElementById('saveQuote').onclick=function(){var btn=this;btn.disabled=true;` +
    `var g=function(id){return document.getElementById(id).value.trim();};` +
    `api('api/config',{method:'POST',body:JSON.stringify({quote:{currency:g('q-currency'),payment:g('q-payment'),leadTime:g('q-leadTime'),validity:g('q-validity'),notes:g('q-notes'),bank:{name:g('q-bankName'),account:g('q-bankAccount'),swift:g('q-bankSwift'),beneficiary:g('q-bankBeneficiary')}}})})` +
    `.then(function(r){btn.disabled=false;if(r.j.error){toast(r.j.error,'err');return;}toast('报价条款已保存');});};` +
    `loadTpls();` +
    `</script>` +
    FOOTER
  );
}

export { leadsPage, crmPage, reviewPage, settingsPage, templatesPage };
