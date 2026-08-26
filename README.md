# dsh-waimao 🌐💬

**DeepSeek Harness (dsh) 外贸获客插件**：从「搜到链接」到「成交回款」的完整流程，全部装进你的 dsh。

```
设置ICP画像 → 三层搜索 → 提取联系方式 → 规则过滤 → AI评分(判断是否对口)
   → 邮箱验证 → 开发信(dry-run,线程头,spintax,日上限)
   → 人工审批 → 触达(邮件/WhatsApp) → IMAP回复扫描+AI分类 → 跟进序列
   → CRM管线 → 官网监控(意图信号) → 报价PDF → 结案复盘 → 效果统计
```

## 功能总览（49 个对话工具 + 4 个网页）

| 模块 | 能力 |
|---|---|
| 🎯 **ICP 画像** | `icp_set` 一句话设置"卖什么+找什么买家"；评分判断线索是否对口（对口/沾边/不对口+理由），写开发信自动带上产品 |
| 🌐 **谷歌获客** | 三层公式（基础搜索/LinkedIn职位定向/采购信号）、18个市场预设、逐层去重、引擎自动 failover、Google Maps 商家数据源(serpapi)、CSV导出 |
| 🧪 **线索加工** | 抓页提取邮箱/WhatsApp/电话/社媒、**规则引擎过滤**（同行/B2B平台/黄页/招聘/社媒一眼排除）、**AI评分0-12分**（🔴极高/🟠高/🟡中/🟢低+开发建议）、自动入CRM去重合并 |
| 📧 **邮箱发现验证** | 35+模式猜测 + MX记录 + SMTP RCPT探测 + catch-all检测（hunter.io 开源平替） |
| ✉️ **开发信** | DeepSeek 个性化生成（带知识库引用）/ 三语模板兜底（英/西/**葡**，拉美自动切西语、巴西切葡语）、零依赖SMTP客户端、**dry-run 总闸默认开**、**回复线程头**、**退订脚注**、**Spintax 变体**（{a\|b\|c} 群发每封略有差异）、**每日发送上限**（保护新域名） |
| 📬 **回复检测闭环** | **IMAP 扫描买家回复 → AI 分类（感兴趣/询价/拒绝/休假/退订）→ 自动改 replied + 停序列**，退订自动进抑制列表 |
| 🛡️ **合规** | 抑制列表（发送强制拦截）、退订提示行、全量审计日志 |
| 📅 **跟进序列** | Day 0/3/7/14 四步自动跟进（挂原邮件线程）、回复即停、cron 定时执行 |
| 📊 **CRM 管线** | 状态机（新→评估→触达→回复→报价→成交/流失）、客户档案、跟进活动、跨搜索去重合并、CSV导出 |
| 🔐 **SOP 阶段机** | 八阶段服务端强制顺序（agent 不可跳步）、**人工审批门（哈希绑定，改动即失效）** |
| 📚 **知识库** | 产品/报价政策/案例/市场规则，检索带 citation，AI 回复客户有据可依 |
| 🕵️ **公司背调** | RDAP WHOIS（域名年龄，新站标警）+ 技术栈指纹（Shopify/Woo等）+ 业务信号（招聘=扩张） |
| 👀 **意图监控** | cron 盯客户官网变化，命中 new product/hiring 等信号词=触达时机 |
| ⏰ **定时任务** | WA收件箱轮询、序列执行、回复扫描、官网监控、每日管线日报、停跟进提醒 |
| 💬 **WhatsApp** | 客服审核台（AI草稿+人工审核）、媒体消息（发报价PDF）、受控群发（随机间隔+每日上限+3连败熔断） |
| 📄 **报价** | 英文报价单 PDF（零依赖手写生成）、自动关联CRM |
| 📈 **效果统计** | 漏斗转化、分层回复率、市场分布、回复分类、触达量、**打开率/点击率** |
| 📬 **打开/点击追踪** | 发信自动注入像素+链接包裹（HTML替身），公网反代模式，防开放重定向 |
| 🔥 **邮箱预热** | 爬坡闸门（第1周5封/天，每周+5）+ 主账号↔伙伴账号自动互动（互发/回复/标星） |
| 🩺 **送达率体检** | SPF/DKIM/DMARC/MX DNS检查 + 修复建议，首封开发信前必跑 |

## 安装

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:shine-233/dsh-waimao
# 本地开发：add link:C:\path\to\dsh-waimao
```

重启 `dsh web`，浏览器打开：

- `http://127.0.0.1:3080/waimao/leads` —— 谷歌获客（搜索→提取→评分→入CRM 一条龙）
- `http://127.0.0.1:3080/waimao/crm` —— CRM 管线（AI开发信/序列/状态流转）
- `http://127.0.0.1:3080/waimao/review` —— WhatsApp 客服审核台
- `http://127.0.0.1:3080/waimao/settings` —— 设置（全部配置+连通性测试按钮）

## 快速上手（对话里说人话即可）

```
我卖电吹风，找欧美批发商          → icp_set 存好画像（第一次用先做这个）

帮我开发墨西哥电吹风买家
→ sop_create → lead_search → lead_enrich → lead_score → email_compose
→ [人工审批] → email_send → 结案报告

看看这些线索质量怎么样
→ lead_enrich → 按 🔴🟠🟡🟢 分层汇报，附对口判断、联系方式和开发建议

给这个客户报1000台FOB价
→ kb_search(报价政策) → quote_pdf → wa_send_media / email_send
```

## 配置

`~/.waimao/config.json`（推荐直接用设置页，带测试按钮）：

```jsonc
{
  "icp": { "product": "professional hair dryers 1800-2400W", "buyers": "wholesalers, beauty supply distributors" },
  "serp": {
    "engine": "ddg", "serpapiKey": "", "perLayer": 10,
    "proxy": "http://127.0.0.1:7890",   // 大陆网络必填
    "chain": ["ddg", "serpapi"]          // failover 链
  },
  "evolution": { "baseURL": "http://127.0.0.1:8080", "apiKey": "", "instance": "" },
  "deepseek": { "baseURL": "https://api.deepseek.com", "apiKey": "", "model": "deepseek-chat" },
  "smtp": {
    "host": "smtp.gmail.com", "port": 465, "secure": true,
    "user": "", "pass": "", "from": "", "fromName": "Sales",
    "dryRun": true,         // ⚠️ 总闸：确认能跑通后再改 false
    "dailyCap": 300,        // 每日真实发送上限，新域名建议 20-30
    "plainText": false      // 纯文本模式：不注入追踪，投递率更好
  },
  "cron": { "enabled": true, "waSyncEveryMin": 30, "sequenceCheckEveryMin": 60, "dailyReportAt": "09:00", "staleDays": 7 },
  "wa": { "dailyBroadcastCap": 200, "minDelaySec": 20, "maxDelaySec": 90 },
  "webhookToken": "随机字符串"
}
```

## 追踪与预热（需要公网入口）

dsh 只绑 127.0.0.1，收件人的邮件客户端打不到本机。要启用打开/点击追踪，给插件一个公网入口：

```bash
# 方式一：cloudflared 隧道（无需公网IP）
cloudflared tunnel --url http://127.0.0.1:3080
# 方式二：同机 caddy/nginx 反代
# track.example.com → 127.0.0.1:3080
```

然后 `config.track.publicBaseUrl` 填该域名。未配置时追踪静默关闭。安全设计：像素/点击端点用 24 位随机 ID（不可枚举），点击只 302 到发送时登记过的 URL（防开放重定向），响应零数据。

邮箱预热（新域名/新账号必做，否则必进垃圾箱）：

```jsonc
"warmup": {
  "enabled": true,
  "maxPerDay": 30,
  "partners": [{ "host": "smtp.partner.com", "user": "b@partner.com", "pass": "***", "imapHost": "imap.partner.com" }]
}
```

cron 每天自动跑一轮互动（主账号↔伙伴账号互发+自动回复+标星），爬坡第1周限5封/天、每周+5。发信前先 `deliverability_check` 体检 SPF/DKIM/DMARC。

## 安全设计

- 所有网页/API 只接受回环+同源请求；webhook 必须带 token
- API key/邮箱密码只存本机，浏览器永远拿不到
- 邮件 dry-run 总闸默认开；SOP 发送必须过人工审批门（哈希绑定）
- 群发默认 dry_run，真实发送有频控+熔断；全部动作进审计日志（`audit_query` 可查）

## 兼容性

基于 `@deepseek-ai/dsh 0.1.0-rc.7` 插件面（bundle patch / tools.register / webServer.register）。零 npm 依赖，Node ≥ 22.13。

## 免责声明

搜索请遵守引擎条款；邮件营销请遵守 CAN-SPAM/GDPR，提供退订方式；WhatsApp 自动化遵守其服务条款，控制频率防封号。Evolution API 为第三方开源网关。

## License

MIT
