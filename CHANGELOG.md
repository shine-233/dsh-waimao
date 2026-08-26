# Changelog

## 0.7.1 (2026-08-26)

全库审查后的两批修复：先修会伤客户/丢数据的严重 bug 与 IMAP 链路硬伤，再把"假功能"全部做成真的或改成诚实描述。

### 严重修复
- **跟进序列 Day3/7/14 发空邮件**：`email_sequence_start`（工具+网页两处）此前只填 Day0 内容，Day3/7/14 存的是空串，cron 到期原样发出。现在启动时即用三语模板填充全部跟进步骤（`fillFollowUpSteps`），巴西走新增的葡语跟进文案
- **设置页「保存全部」清空配置**：`configSummary()` 此前不返回 imap 区块、smtp.user/fromName、warmup.maxPerDay，页面回填为空后点保存会把真实配置覆盖成空值。已补齐非密钥字段；密钥占位提示改按 hasXxx 标志显示（原来永远不出现）
- **IMAP 回复扫描拿不到正文**：TEXT 段提取正则把 `<0>]` 括号顺序写反，真实服务器响应 `BODY[TEXT]<0> {N}` 从未匹配成功——回复分类一直在跑空字符串。改为按字面量 {N} 字节长度定位（头块同理，不再被含括号的 From/Subject 截断 Message-ID）

### 假功能落地 / 名实相符
- **smtp.sendWindow 发送时间窗（此前纯摆设，零消费代码）**：现在 cron 序列执行真检查收件人当地时间（按市场预设粗时区），9-19 点之外顺延到下一轮
- **预热爬坡闸门强制生效**：预热线此前绕过 dry_run 总闸、不审计、爬坡额度只展示不拦截。现在 dry_run=true 时预热一封不发；每条腿计入审计 `email.warmup` 并受 rampCap 硬约束；全失败的轮次不再写当日 latch（会自动重试）；文档改为诚实表述——爬坡只约束预热邮件本身，业务发送由 dailyCap 保护；删掉虚假的"IMAP MOVE 挪回收件箱"宣传
- **STOP/ALTO/PARAR 退订识别**：正文以 STOP/ALTO/PARAR 开头且极短即判退订进抑制列表（页脚承诺的闭环补上；正常商务句里的 stop 不误伤）
- **退信→抑制闭环打通**：DSN 的 From 是 mailer-daemon/postmaster，按发件人搜索永远够不到。新增独立 DSN 扫描轮（OR FROM mailer-daemon/postmaster），从通知正文提取失败地址命中线索即抑制+停序列；AI 分类枚举补 bounce
- **IMAP SINCE 日期格式**：原来发 `26-08-2026`（数字月），RFC 要求 `26-Aug-2026`——严格服务器上搜索静默空结果
- **A/B 测试分组稳定**：原来计数器每次调用重置，逐条启动全分到 A 组；改为按线索 ID 哈希，逐条/批量分组一致且大致对半
- **详情抽屉对口徽章生效**：`/api/crm/list` 此前漏返 fit/lastReply 字段，前端渲染永不出现
- **data_backup 名副其实**：补齐 sop/monitor/tracking/warmup/broadcast/cron 六个数据文件 + 审计日志尾部 200 行（此前号称全量实际漏一半）
- **price_calc DDP 补关税**：新增 duty_rate 参数（按 CIF 计）；DDP 不带关税报价就是亏钱，提示文案写明巴西~60%/欧盟~20%+VAT；unit 口径文档化（运费清关按整批，不乘数量）
- 文档修正：工具数 47→48（README/CHANGELOG 原来都写成 49）；SKILL 补上 price_calc/proforma_pdf/market_scan/video_script/data_backup/template_* 等 8 个从未提及的工具

### 其他修复
- **代理路径 SerpAPI/RDAP 必崩**：proxy.js 最小响应对象没有 json() 方法；RDAP 的 rdap.org 重定向也不跟随。两处都已修复
- **域名分类子串误杀**：规则用 url.includes('x.com') 会把 wix.com/netflix.com/flex.com 全判成社媒丢线索；改按域后缀对齐匹配
- **邮箱验证协议缺陷**：SMTP 多行回复在续行就提前返回导致回包错位；4xx 临时失败（灰名单/限流）被误判成 invalid 误导弃单。现只在终止行结算，4xx 归 unverifiable；默认改用空发件人 <> 与地址字面量 EHLO（.local 假域常被直接拒）
- **追踪链接对带 & 的 URL 全坏**：先 HTML 转义再提取 URL，查询参数变成 &amp; 存进链接表，点击 302 到坏地址；改为原文提取、展示层转义
- **PDF 含非 ASCII 打不开**：偏移量按 UTF-8 字节算、输出却按 latin1 编码，xref 整体漂移；统一按字符数计算，中文等无字形字符替换为 ?
- **cron 任务重叠执行**：replyScan 一轮可能超过 everyMs，上一轮没完下一轮已启动（重复扫描/双写）。加重入保护；runOnce 手动触发也落盘并写审计
- **dailyReportAt 容错**："9:00" 这类不补零写法此前永不触发；日报窗口改分钟数比较
- **email_find 结果写不进 CRM**：updateLead 白名单缺 contacts 键，找到的验证邮箱被静默丢弃
- **抑制列表裁剪合规**：容量裁剪优先删最老记录=最先删掉退订者；现在 hard-bounce/unsubscribe/complaint 永久保留
- **DKIM 吊销密钥假阳性**：v=DKIM1; p=（空公钥）此前也算通过；要求 p= 有实际公钥
- **WhatsApp sendMedia base64 负载形状**：mediaMessage:{base64} 是 webhook 接收载荷的形状，不是发送请求；改为 v2 扁平结构 {number, mediatype, media, fileName, caption}
- **CSV 公式注入防护**：以 =+-@ 开头的字段加 ' 前缀；vCard NOTE/OR G 值转义 , ; \\ 换行，补 RFC 必需的 N: 字段
- **SMTP/IMAP 空闲超时**：DATA 后等回复对半开连接无限等待拖死 cron；空闲 120s 断开报错
- **SOP 幽灵提示**：outreach 阶段 hint 指向不存在的 sop_close 工具，改为如实说明再调一次 sop_next 即结案
- 死代码清理：pricing.js 恒为 1 的除数、replies.js 两分支相同的三元表达式

### 测试
- v3：IMAP 头块括号截断 fixture、QP 中文重组、TEXT 字面量提取
- v6：定价断言保持兼容（total 口径不变）
- v7：configSummary 必含字段、三语序列步骤全非空、PDF Payment 默认值/自定义值、A/B 分组稳定性

## 0.7.0 (2026-08-26)

对照 GitHub 上跑通同类项目的经验（OpenOutreach / gtm-mcp / warmbly / seqd），补上四个真正影响回复率的功能；界面文案整体去掉 AI 腔。

### 新功能
- `icp_set` **ICP 画像**：一句话设置"我卖什么 + 找什么买家"。`lead_enrich`/`lead_score` 评分时判断线索是否对口（fit: 对口/沾边/不对口，附理由，学 OpenOutreach 的 reason-per-lead），`email_compose` 写信也知道卖什么——修复了之前产品词传空、模板兜底会写出 "We supply to importers..." 残句的问题
- **Spintax**：邮件主题/正文支持 `{a|b|c}` 随机变体，发送时选一项，群发时每封略有差异（学 seqd/warmbly）；不含 `|` 的花括号不受影响
- **smtp.dailyCap 日发送上限**：按审计日志统计当日真实发送量，达到上限拒绝发送并提示（学 gtm-mcp 的容量闸门）。新域名建议 20-30/天，保护域名信誉
- **smtp.plainText 纯文本模式**：开了就不注入 HTML 替身和打开/点击追踪（学 gtm-mcp 的实践：纯文本投递率更好）

### 界面文案
- 去掉满屏 emoji（导航/按钮/标题只留必要符号），"一条龙""课程公式""把链接变成客户"这类话全部改成平实说法
- 获客页加工结果显示"对口/沾边/不对口"徽章；线索详情抽屉同步显示

### 其他
- 设置页新增 ICP 画像区块 + 日上限 + 纯文本开关；`package.json` 修复重复的 description 键；v6 测试补进 npm test
- 工具数 47 → **48**（+icp_set）；新增 `test/v7-modules.mjs`

## 0.6.0 (2026-08-25)

对照 XMT 截图导航栏补齐最后一批外贸特化工具 + 发信基建增强。

### 外贸特化工具（截图导航栏全齐）
- `price_calc` **定价计算器**：Incoterms 2020 成本叠加（EXW→FOB→CFR→CIF→DDP），整批/单件双口径，利润率一键报价，附单件价；CRM 页内置实时联动弹窗
- `proforma_pdf` **PI 形式发票**：Incoterms、HS 编码列、原产国/目的国、银行收款信息、双方签章栏（开信用证/预付/清关估价）
- `market_scan` **蓝海选国**：多市场搜索对比，机会评分 = 买家信号密度 vs 平台噪声 → 🔵蓝海/🟡可试/🔴红海排名
- `video_script` **口播脚本**：TikTok/Reels/Shorts 短视频脚本（hook→痛点→产品→CTA 分镜时间轴+标签），AI 生成模板兜底

### 发信基建增强
- **多收件账号轮换**：`smtp.accounts[]` 轮询发信，分散单账号压力
- **A/B 测试**：序列启动传 template_a/b 交替分配变体，`stats_report` 按变体统计回复率
- **退信自动抑制**：hard-bounce 自动进抑制列表（保护域名信誉）
- **发送时间窗**：市场预设带时区，序列发送避开收件人深夜（9-19 当地时间）
- `data_backup`：全量业务数据 JSON 备份

### 工具数
43 → **48**；路由 35 → **36**

## 0.5.0 (2026-08-25)

前端全面重做（对标 GitHub 最佳仪表盘设计）+ 补齐批量/导入/vCard/模板库。

### 前端（4 页全部重写）
- **设计系统**：zinc 暗色 + indigo→violet 渐变、玻璃拟态卡片（backdrop-blur）、渐变流光标题、入场交错动画、骨架屏、悬停微交互、渐变滚动条
- **仪表盘**（管线页）：数字滚动统计卡、Canvas 环形图（管线分布，动画绘制）、转化漏斗、分层回复率条图、触达量条图
- **看板**：7 阶段拖拽换状态（HTML5 DnD + 拖拽倾斜反馈 + 落列高亮），改「已成交」触发**全屏彩带**🎉；看板/列表双视图
- **批量操作**：勾选多线索 → 批量改状态/停序列；CSV 导入（自动去重合并）；vCard 导出（手机通讯录直导，加 WhatsApp 联系人神器）
- **详情抽屉**：滑入面板，含时间线、回复摘要、开发建议
- **Toast 通知**（进度条自动消失）、**Modal 确认**、**Ctrl+K 命令面板**（方向键导航）
- 获客页：搜索/加工双进度条（条纹动画）、结果卡片交错入场、实时统计芯片
- 审核台：WhatsApp 风格气泡 + AI 打字指示动画（三点弹跳）
- 设置页：分页签切换（渐变高亮 + 重放入场动画）、每区块独立连通测试

### 后端新增
- `POST /waimao/api/crm/bulk` 批量操作（状态/标签/停序列）
- `POST /waimao/api/crm/import` 线索导入（CSV/JSON，去重合并）
- `GET /waimao/api/crm/vcard` vCard 导出（单条/全部）
- `GET /waimao/api/stats` 仪表盘统计
- 模板库：`template_save` / `template_list` / `template_delete`，`email_compose` 支持 `template` 参数直接复用

### 工具数
40 → **43**（+模板库 3 个）；路由 31 → **35**

## 0.4.0 (2026-08-25)

补齐「常驻服务器基建」最后两块：打开/点击追踪 + 邮箱预热 + 送达率体检。

### 追踪（打开/点击）
- `track.publicBaseUrl` 配置公网入口（caddy/nginx/cloudflared 反代到本机 3080），未配置则静默关闭
- 发信自动生成 HTML 替身（multipart/alternative）：1x1 像素 + 链接包裹
- `/waimao/px` + `/waimao/click` 公开端点：24位随机ID不可枚举、点击只 302 到发送时登记的 URL（防开放重定向）、同一天重复打开去重、零数据响应
- `stats_report` 新增打开率/点击率

### 邮箱预热（单机自托管版）
- 爬坡闸门：第1周5封/天，每周+5，封顶可配——防止新域名直接群发进垃圾箱
- 互动预热：主账号↔伙伴账号互发带标签邮件，cron 自动回复+标星，模拟真实往来
- `warmup_status`（status/run）

### 送达率体检
- `deliverability_check`：SPF/DKIM/DMARC/MX 的 DNS 检查（DKIM 探测常见 selector）+ 可执行修复建议 + rDNS 人工指引

## 0.3.0 (2026-08-25)

补上「发出去之后」的回路：回复检测闭环 + 合规 + 背调 + 意图信号 + 度量。

### 回复检测闭环（最大断点补齐）
- 零依赖 IMAP 客户端（TLS/LOGIN/SELECT/SEARCH/FETCH，字面量分块解析）
- `email_scan_replies`：按 CRM 线索邮箱扫描来信 → AI 分类（interested/pricing/not-interested/ooo/auto/unsubscribe）→ 自动改 replied + 停序列 + 记活动
- 退订回复自动进抑制列表；cron 定期扫描（`replyScanEveryMin`）

### 合规
- 抑制列表：发送前强制拦截，`email_suppress` 管理，退订自动加入
- 开发信自动追加退订提示行（可关）；回复线程头（In-Reply-To/References）让跟进挂原线程

### 背调与信号
- `company_dossier`：RDAP 查 WHOIS（域名年龄，<6个月标警）+ 首页技术栈指纹（Shopify/Woo/WordPress/像素等）+ 业务信号（招聘=扩张）
- `monitor_watch`/`monitor_check`：客户官网变化监控（changedetection 思路），命中 new product/hiring 等信号词特别标注，cron 自动跑

### 度量
- `stats_report`：漏斗转化、分层回复率、市场分布、回复分类分布、触达量

### 其他
- 葡语模板（巴西自动切 pt）；IMAP 设置区块+测试按钮；npm 发布工作流（trusted publishing）；英文 README

## 0.2.0 (2026-08-25)

从「骨架」到「全家桶」：补齐线索质量加工、邮件触达、流程管理、自动化四大块。

### A. 线索质量加工
- `lead_enrich`：抓页 → 提取联系方式（邮箱/WhatsApp/电话/LinkedIn/IG/FB）→ 规则引擎分类（排除同行/B2B平台/黄页/招聘/社媒/政府）→ AI评分 → 自动入CRM（去重合并）
- `lead_score`：规则+AI 双层评分 0-12 分（🔴极高/🟠高/🟡中/🟢低），附开发建议
- `email_find` / `email_verify`：邮箱模式猜测（35+模式）+ MX + SMTP RCPT 探测 + catch-all 检测

### B. 邮件触达
- 零依赖 SMTP 客户端（隐式TLS/STARTTLS、AUTH PLAIN/LOGIN、MIME+附件）
- `email_compose`：DeepSeek 个性化生成（带知识库引用）+ 双语模板兜底（拉美自动西语）
- `email_send`：dry-run 总闸默认开，预览落盘
- `email_sequence_start`：Day 0/3/7/14 四步跟进序列，回复即停

### C. 流程管理
- CRM 管线：七态状态机、客户档案、跟进活动、跨搜索去重合并、CSV导出
- SOP 阶段机：八阶段服务端强制顺序（不可跳步）、人工审批门（sha256 哈希绑定、改动失效、fail-closed）
- 知识库：产品/政策/案例/市场/品牌，检索带 citation
- 审计日志：全动作 JSONL 留痕，`audit_query` 可查

### D. 自动化与深度
- 定时任务：WA收件箱轮询 / 序列到期执行 / 每日管线日报 / 停跟进提醒（unref 定时器）
- `wa_send_media`（图片/PDF）+ `wa_broadcast` 受控群发（随机间隔+每日上限+3连败熔断）
- `quote_pdf`：零依赖手写英文报价单 PDF
- SERP 引擎 failover 链（10分钟冷却）+ Google Maps 数据源（serpapi）
- 设置页（全部配置+4个连通性测试按钮）、CRM 管线网页

## 0.1.0 (2026-08-25)

首个骨架版本。

- 谷歌获客：`lead_search`（三层公式：基础搜索 / LinkedIn 职位定向 / 采购信号，逐层去重）、`lead_export_csv`，`/waimao/leads` 网页操作台
- SERP 引擎：DuckDuckGo HTML（免 key）、SerpAPI（Google，免费 100 次/月）、literal（仅生成公式）
- **零依赖代理支持**：手写 HTTPS over CONNECT 隧道（`serp.proxy` 或 HTTPS_PROXY 环境变量），大陆网络下 Node fetch 不读系统代理的问题就此解决
- WhatsApp 客服审核台：`wa_sync` / `wa_review_queue` / `wa_reply` / `wa_send_text`，`/waimao/review` 网页审核台，Evolution API webhook 接收器（token 校验）
- AI 草稿：DeepSeek 兼容 `/chat/completions`（可选，未配 key 时由 dsh 智能体起草）
- 配置文件 BOM 容错（Windows 记事本/PowerShell 友好）
- 兼容 `@deepseek-ai/dsh 0.1.0-rc.7` 插件面（bundle patch 清单 / tools.register / webServer.register）
- 测试：模块冒烟 + DDG 解析器 fixture + 宿主模拟（工具/路由注册、围栏、webhook 403）
