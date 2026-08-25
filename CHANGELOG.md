# Changelog

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
