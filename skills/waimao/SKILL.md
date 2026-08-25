---
name: waimao
description: 外贸获客与 WhatsApp 客服方法论：何时用 lead_search 三层搜索、如何选市场与层级、如何用 wa_* 工具做"AI起草+人工审核"的客服流程。
---

# 外贸获客（waimao）

## 谷歌三层获客公式

用户说"帮我找 XX 产品 + 某市场的买家"时，调用 `lead_search`：

- product 必须是**英文**产品词（中文先翻译）。
- 市场：亚非拉（墨西哥+52、迪拜+971、沙特+966、巴西+55、印尼+62…）走 WhatsApp 公式；欧美走邮件+LinkedIn。
- 默认三层全跑 `[1,2,3]`；用户要"快"就 `[1,3]`；要"找对人"就加第 2 层（LinkedIn 职位：Purchasing/Import/Sourcing Manager）。
- 结果已逐层去重；汇报时按层分组，并提醒：第 2 层是"拿到公司再定位到人"，第 3 层是"明确想买的人"，比 wholesale 词精准得多。
- 需要表格交付时调用 `lead_export_csv`，把返回的文件路径给用户。

## WhatsApp 客服流程（AI 起草 + 人工审核）

1. `wa_sync`：拉取最近会话，买家消息进入待审队列（webhook 不可达时的兜底）。
2. `wa_review_queue`：看待审消息。
3. **草稿**：由你（智能体）根据聊天上下文直接起草英文回复——简短、礼貌、推动成交；不编造价格货期，报价先问数量规格。
4. `wa_reply {id, text}`：用户确认后才调用；这是"人工审核后发送"。群聊(@g.us)会拒绝，提示用户手机手动回复。
5. `wa_send_text` 只用于用户明确要求的主动开发信，不经过审核队列。

## 配置提示

- SERP 默认 DuckDuckGo 免 key；被限流时换 `engine:"serpapi"`（需 `~/.waimao/config.json` 配 key）或 `engine:"literal"` 只出公式让用户手动搜。
- Evolution API 未配置时，客服工具会报错并提示配置 `~/.waimao/config.json` 的 evolution 段。
