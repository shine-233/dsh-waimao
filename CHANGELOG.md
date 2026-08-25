# Changelog

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
