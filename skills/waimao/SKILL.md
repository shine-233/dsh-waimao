---
name: waimao
description: 外贸获客全家桶方法论：三层搜索→线索加工(提取/过滤/评分)→邮箱验证→开发信→跟进序列→CRM→SOP阶段机(人工审批)→知识库→定时任务→WhatsApp。何时用哪个工具、标准作业流程。
---

# 外贸获客（waimao v0.2）

## 标准获客流程（SOP）

用户说"帮我找 XX 产品 + 某市场买家"时，推荐走完整 SOP（sop_create 创建任务，sop_next 逐步推进，服务端强制顺序）：

1. **discover**：`lead_search`（英文产品词；亚非拉走 WhatsApp 公式，欧美加 LinkedIn 层；`source:maps` 可搜地图商家，需 serpapi key）
2. **enrich**：`lead_enrich`（抓页提取邮箱/WA/电话 + 规则过滤同行/B2B平台/黄页 + 自动入 CRM）
3. **score**：`lead_score`（规则+AI 0-12 分：🔴极高10-12 / 🟠高7-9 / 🟡中4-6 / 🟢低1-3）
4. **draft**：对 🔴🟠 线索 `email_compose(task_id=...)` 生成开发信草稿（拉美自动西语；引用 kb_search 的 citation）
5. **approval**：`sop_review` 列草稿 → **必须人工 sop_approve**（哈希绑定，草稿改动需重批，fail-closed）
6. **outreach**：`email_send`（受 smtp.dry_run 总闸）或 `wa_send_text`；可 `email_sequence_start` 启动 Day0/3/7/14 序列
7. **close**：`sop_next` 自动出结案报告

## 关键规则

- **回复有据**：报价/产品/政策问题先 `kb_search`，引用 citation；没命中明说资料不足，请用户 `kb_upsert` 录入
- **邮箱**：没有邮箱的线索用 `email_find`（模式猜测+MX+SMTP验证）；unverifiable 是 25 端口被封，正常现象，标注即可
- **dry_run**：smtp.dry_run 默认 true，发送只存预览。帮用户首次真实发送前要确认用户已在设置页关闸
- **群发**：`wa_broadcast` 默认 dry_run；真实发送有每日上限+随机间隔+3连败熔断，提醒用户封号风险
- **报价**：`quote_pdf` 生成英文 PDF（先 kb_search 查报价政策），可 `wa_send_media` 发送，自动记 CRM 活动、状态改 quoted
- **客户回复**：`crm_update` 状态改 replied（自动停邮件序列）；WhatsApp 消息走审核台 `wa_review_queue` → `wa_reply`
- **定时任务**：`cron_status` 查看序列/收件箱轮询/日报；`cron_status {run:"sequence"}` 手动触发

## 工具速查

| 阶段 | 工具 |
|---|---|
| 搜索 | lead_search / lead_export_csv |
| 加工 | lead_enrich / lead_score / email_find / email_verify |
| 邮件 | email_compose / email_send / email_sequence_start / email_sequence_status |
| CRM | crm_list / crm_update / crm_activity / crm_export |
| SOP | sop_create / sop_next / sop_review / sop_approve / sop_status |
| 知识 | kb_search / kb_upsert / kb_list |
| WhatsApp | wa_sync / wa_review_queue / wa_reply / wa_send_text / wa_send_media / wa_broadcast |
| 报价 | quote_pdf |
| 运维 | cron_status / audit_query |
