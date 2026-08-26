# Changelog

## 0.7.2 (2026-08-26)

补齐 XMT 导航栏最后一块 + GitHub 仓库治理 + 第二轮逐字审计修复 + 第三轮功能测试。

### 第三轮：新增 10 套测试中的两套，抓出并修复
- **新增 `test/v8-functional.mjs`**（新代码纯函数逐一验证）+ **`test/page-consistency.mjs`**（页面内联 JS 的元素 ID / 事件处理函数 / API 端点与实际存在交叉验证——这类错只有真开浏览器才会暴露）
- **回复分类规则三处缺口**：①"John has left the company"（第三方离职）匹配不到 wrong-person；②Gmail 标准退信措辞 "address not found" 不在 bounce 规则里；③既说找错人又抄送同事的回复应优先归 referral（有新联系人可跟进），调整规则顺序
- **WhatsApp 群发支持 Spintax**：正文 `{a|b|c}` 每条随机选一项（与邮件侧对齐，降低重复内容判定）
- `email_send` 拒绝 subject/body 同时为空（防发空邮件）

### 第二轮审计修复
- **网页定价计算器漏关税**：pricing.js 已支持 duty_rate（DDP 必填），但计算器弹窗没有这个输入框，网页算出的 DDP 报价永远漏掉关税——正是工具描述里警告的坑。已补输入框
- **管线页环形图中心恒为 0**：引用了 stats 接口不存在的 `s.total` 字段 → 改为 funnel 求和
- **Day7 跟进邮件虚假声称附件**：主题写 "catalog attached"、正文写 "Attaching our catalog"，但序列发送从不带附件——买家会找一封不存在的附件。改为"目录已备好，回复即发"
- **Instantly/CSV 导出拿公司名拆词冒充人名**：`contacts.person` 字段在 CRM schema 里不存在，first_name 会变成公司名第一个词（垃圾数据）。改为留空，模板用 {{company_name}} 称呼
- `email_sequence_start` 描述同步实际实现（A/B 分组是按线索 ID 哈希，不是交替分配）

### 新增
- **模板页**（第 5 个网页 `/waimao/templates`，对照 XMT 导航的「报价模板」）：
  - 邮件模板库管理：新建/删除/查看，`email_compose` 传 `template` 参数直接复用
  - 报价默认条款：币种/付款方式/交期/有效期/收款银行（户名·账号·SWIFT）/备注，存 `config.quote`
  - `quote_pdf` / `proforma_pdf` 参数缺省时自动用这些条款兜底（此前每次都要重复口述付款方式）
- **WhatsApp 扫码接入**：设置页 Evolution 区块新增「扫码接入」按钮（对接 `/instance/connect`，二维码+配对码，已连接自动识别）
- `email_send` SOP 模式强制以已批准草稿内容发送（修复审批后可被偷换内容的漏洞），并校验草稿归属线索

### 修复
- `lead_score` 缺省只扫 new 状态，与描述"new/qualified"不符 → 补齐
- `stats_report`：A/B 变体统计漏掉 won（回复率可能算出 >100%）；WhatsApp 触达量不计群发
- AI 回复分类枚举补 `bounce`（配了 AI key 时退信也能自动进抑制列表）
- 邮箱猜测模式从 11+9=20 补到 20+15=35+（兑现"35+候选"）
- 分类规则 `'x.com'` 子串误杀 wix.com/xbox.com → 改为域边界匹配
- Evolution `sendMedia` base64 分支改 v2 扁平格式（`mediaMessage` 是 webhook 接收载荷的形状，发信会失败）
- GitHub 仓库描述乱码已修复（`gh repo edit`）

### 设计决策对齐成熟项目（Instantly OpenAPI / gtm-mcp 实战）
- **首触冷邮件审批闸**（学 Instantly 的"活动激活"+gtm-mcp 双人工门）：智能体直接调 email_send 发首触默认拒绝，必须走 SOP 已批准草稿；网页手动发送、回复/线程跟进、cron 序列（启动即用户激活）不受限；`smtp.allowColdSendWithoutApproval=true` 显式解除。此前"不传 task_id 可绕过审批"的口子已堵上
- **每邮箱总上限 `smtp.mailboxTotalCap`**（学 Instantly 的 daily_limit_max）：业务+预热合计封顶——服务商只看邮箱当天总量，业务发得多时预热自动让路（预热预算 = min(爬坡上限, 总上限余量)）。此前预热完全不吃任何与业务相关的上限
- 设置页同步两个新开关；email_send 工具描述如实说明闸门行为

### 第三轮全量复审修复（WhatsApp 链路 / SOP / 前端 / 支持模块）
- **WhatsApp 补上三大断裂**：① `wa.dryRun` 总闸（此前配好即真实外发，零闸门，与 cron 注释矛盾）；② wa_send_media 支持本地文件路径（限 exports/data 目录，quote_pdf 产物直接传——此前"配合报价单发送"根本接不通）；③ WA 收发自动按手机号尾号匹配 CRM 线索并记活动时间线（此前完全没有 CRM 回写）
- **SOP 两处断线**：email_send 成功后回写 task.outreach（此前结案报告触达统计恒为 0/dryRunOnly）；驳回的草稿改为"已决策"不再永久卡死审批门，sop_approve 支持 remove 直接移除
- **CSV 往返丢联系方式**：导入别名补齐自家中文表头（邮箱/WhatsApp/电话/LinkedIn）——此前导出的备份改完导回，联系方式全部静默丢失
- **CRM 抽屉补操作按钮**：生成开发信→可编辑→发送、启动序列（三条后端路由此前是无人调用的悬空 API）
- **market_scan 机会分钳制 0-100 + 小样本标注**（1 条结果 1 个命中=300 分"必蓝海"的统计爆炸）；monitor 拒绝空 domain 目标、checkAll 逐目标持久化（不再用陈旧 db 整体覆盖）；kb 密钥守卫下沉存储层覆盖 title/tags；templates 名字先截断再查重；群发熔断状态持久化+本地日界；审核台草稿带产品上下文；quote_pdf 的 KB 报价政策真写进 PDF 备注（此前只是查了没用于渲染）
- **前端**：api() 全局 catch（403 空 body 不再白屏）、忽略按钮检查返回码、加工结果不再堆叠、QR 扫码后自动轮询连接状态、CSS.escape 误用 getElementById 修正

### 工具数
48 → **50**（并行线加了 instantly_campaign_list / instantly_push_leads）；网页 4 → **5**

### 三路复审修复（合并后全量再审）
- **预热池救垃圾箱用错编号**：`UID MOVE` 配的是 SEARCH 序列号——轻则静默失效，重则把垃圾箱里无关邮件挪进收件箱；改用序列号版 MOVE 并倒序处理（MOVE 后序列号会前移，正序迭代拿旧号错位）
- **预热 latch 被互动腿虚增**：发送腿全失败但 IMAP 互动"成功"也会写当日完成标记，当天不再重试；改为只统计发送腿
- **instantly_push_leads 缺省会推已回复/已成交客户**（投诉风险）：默认排除 replied/won/lost；fit 过滤改严格（未评分线索不再放行）
- **toInstantLead 不再拿公司名拆人名**（"Acme Trading Co Ltd"→first:"Acme"/last:"Ltd" 的垃圾个性化），无真实联系人名就置空
- **报价条款表单静默清空备注**：notes 此前不回填但保存无条件上送，改任何字段点保存就把已配置的备注清成空串；现在回填+保存闭环
- **quote_pdf 的 KB 命中反而丢配置**：KB 命中时 payment 兜底被跳过退化成硬编码 'T/T'，去掉这个特殊门控
- **dailyReportAt 非法输入导致日报轰炸**：负数小时使窗口恒真，每 30 分钟发一次日报；加钳制与 NaN 回退，且改为运行时读配置（改时间不用重启）
- 预热互动失败留审计痕（此前 IMAP 凭据缺失时静默失败，无从排查）
- emailfind 候选穿插：role 地址（purchasing@ 等外贸关键角色）按 2:1 插入姓名模式，默认 limit=6 截断时也能探到
- A/B 模板名写错从静默变 AI 改为显式报错（对比失真无告警）；data_backup 补 domain-blacklist.json；README 网页数/SOP 表述修正；清死导入

### 预热池 + Instantly 实现（并行线）
- **多收件箱预热池**：参与池 = 主账号 + `smtp.accounts`（`warmup:false` 退出）+ 传统 partners，≥2 个邮箱按天轮换配对互发；每邮箱独立爬坡计时（各自从首次参与起算）；收件侧自动回复/标星已读 + **误入垃圾箱 UID MOVE 回 INBOX**（[Gmail]/Spam、Junk 等逐一探测，服务器不支持则跳过）；4 组内容模板按标签哈希轮换，配 DeepSeek key 时可生成自然语句（失败回退模板）；互动自动化改走 ImapSession.exec 规范标签机
- **Instantly 客户端**（`dsh/instantly.js`）：严格对齐官方 OpenAPI v2——Bearer 鉴权、`POST /api/v2/leads/add`（campaign_id/list_id 二选一、≤1000/批、company_name/job_title/personalization 字段）、`GET campaigns/accounts`；`instantly_push_leads` 按状态/最低评分/fit 过滤 + 同邮箱去重 + ≤500/批推送，reason 进 personalization 变量，dry_run 默认 true；走 serp.proxy 可用
- 测试补齐：pairRotation 轮换断言、池参与者构建（去重/warmup:false 退出）、host-sim 工具清单

## 0.7.1 (2026-08-26)

全库审查后的两批修复：先修会伤客户/丢数据的严重 bug 与 IMAP 链路硬伤，再对照 GitHub 同类实战项目（OpenOutreach / gtm-mcp / warmbly）把"假功能"落地、补齐实战差距。

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

### 对标实战项目补齐（OpenOutreach 2.8k★ / gtm-mcp / warmbly）
- **分类成本漏斗**：正则层（免费、确定性）先过滤退订/退信/休假等，只有模糊回复才调 AI——学 gtm-mcp 的 3-tier funnel，省 token 且结果稳定
- **12 类回复细分**：新增 meeting(约会议)/question(提问)/wrong-person(已离职)/referral(转介同事)，AI 提示词带消歧规则（短肯定回复归 interested 等）
- **域名级黑名单**：退信后整个公司域名拉黑（同公司其他联系人大概率也是坏地址），发送前强制拦截；`email_suppress` 新增 domain_add
- **每邮箱独立上限（per-mailbox cap）**：smtp.accounts 每个账号可设 dailyCap，打满自动轮换到下一个（warmbly/gtm-mcp 惯例 30-40/邮箱/天）；全局 dailyCap 继续生效
- **发送窗加工作日**：收件人当地时间 Mon-Fri 9-19 之外顺延（实战惯例），周末不发
- **跟进邮件保持同线程**：Day3/7/14 主题改为 `Re: 首封主题`（配合已有的 In-Reply-To 头，收件箱归为同一会话）
- **Instantly/Smartlead 标准导出**：`crm_export`/`lead_export_csv`/网页端新增 `format=importer`，输出 email/first_name/last_name/company/title/website/linkedin_url/reason 标准列免映射导入；reason 带"为什么选这条线索"（学 OpenOutreach：reason 才是差异点）
- **DDG 标题/摘要配对修复**：中间有被过滤结果时摘要整体错位、张冠李戴并喂给下游评分；改为按文档区间配对
- 模板文案去掉 "Just..." 家族开头（gtm-mcp 禁语清单）

### 测试
- v3：IMAP 头块括号截断 fixture、QP 中文重组、TEXT 字面量提取、新分类类别、域名黑名单、importer 导出行
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
