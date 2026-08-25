# dsh-waimao 🌐💬

**DeepSeek Harness (dsh) 外贸获客插件**：把「谷歌三层搜索获客」和「WhatsApp 客服审核台」装进你的 dsh，在对话里直接说「帮我搜 hair dryer 墨西哥买家」，或在浏览器里打开自带的双页面操作台。

- 🌐 **谷歌获客**（`/waimao/leads` 页面 + `lead_search` 工具）
  产品词 + 目标市场 → 自动按课程公式三层叠加：
  1. **基础搜索**：`"产品词" WhatsApp +区号`
  2. **LinkedIn 定位**：`"产品词" ("Purchasing Manager" OR ...) site:linkedin.com -alibaba -made-in-china -globalsources ...`（找采购决策人）
  3. **采购信号**：`"产品词" ("we buy" OR "looking for" OR "need supplier" ...)`（明确想买的人）

  逐层执行、逐层去重，亚非拉走 WhatsApp、欧美走邮件+LinkedIn；一键导出 CSV（Excel 不乱码）。
- 💬 **WhatsApp 客服审核台**（`/waimao/review` 页面 + `wa_*` 工具）
  [Evolution API](https://github.com/EvolutionAPI/evolution-api)（自托管 WhatsApp 网关）收到的买家消息进入**待审队列**；AI 生成草稿（DeepSeek 兼容接口，或直接让 dsh 智能体起草）；**人工确认后才真正发出**。群聊拒绝自动发送。
- 🔌 **纯插件**：一切走 `ctx.tools.register` + 回环路由，不改 dsh 内核；零 npm 依赖（Node ≥ 22 内置 fetch）。

## 安装

```sh
# 本地目录开发安装（推荐先用这种）
npx -y @deepseek-ai/dsh plugin --profile web add link:C:\path\to\dsh-waimao

# 或发布后从 git 安装
npx -y @deepseek-ai/dsh plugin --profile web add "github:<your-name>/dsh-waimao"
```

重启 `dsh web`，然后验证：

```sh
npx -y @deepseek-ai/dsh web --dump-config | findstr waimao
```

dump 里应出现插件行 `waimao`。

## 配置

所有配置在 `~/.waimao/config.json`（首次使用自动建目录，缺省即可跑通谷歌获客）：

```jsonc
{
  "serp": {
    "engine": "ddg",            // ddg=免key DuckDuckGo；serpapi=Google（需 key）
    "serpapiKey": "",           // serpapi 引擎时必填
    "perLayer": 10,             // 每层默认收录条数
    "proxy": "http://127.0.0.1:7890" // 大陆网络必填：本地代理(Clash默认7890)；留空则读 HTTPS_PROXY 环境变量
  },
  "evolution": {                // WhatsApp 通道（不用客服功能可不配）
    "baseURL": "http://127.0.0.1:8080",
    "apiKey": "你的 Evolution apikey",
    "instance": "你的实例名"
  },
  "deepseek": {                 // AI 草稿（可选；不配则让 dsh 智能体起草）
    "baseURL": "https://api.deepseek.com",
    "apiKey": "",
    "model": "deepseek-chat"
  },
  "webhookToken": "一串随机字符" // Evolution webhook 的共享密钥，未设置则 webhook 拒收
}
```

### Evolution API webhook（可选，轮询兜底见下）

在 Evolution 里给实例配 webhook：`POST http://127.0.0.1:3080/waimao/webhook/evolution?token=<webhookToken>`，事件选 `MESSAGES_UPSERT`。

> 注意：dsh 只绑 127.0.0.1，Evolution 与 dsh 必须同机（或经 SSH 隧道）。跨机部署时用轮询：在对话里让智能体定期调用 `wa_sync`。

## 使用

### 在对话里（智能体自动调用工具）

```
帮我搜 hair dryer 墨西哥买家，三层全叠加，每层10条，导出CSV
→ lead_search {product:"hair dryer", market:"mx", layers:[1,2,3], per_layer:10}
→ lead_export_csv {}

看看 WhatsApp 有没有新买家消息
→ wa_sync {} → wa_review_queue {}

第2条我回复过报价了，帮他起草一条跟进并审核发送
→ （智能体起草文本）→ wa_reply {id:"...", text:"..."}
```

### 在浏览器里

- `http://127.0.0.1:3080/waimao/leads` —— 谷歌获客页（选市场/层级/条数，结果表 + 导出 CSV + 复制全部链接）
- `http://127.0.0.1:3080/waimao/review` —— 客服审核台（队列 + AI 草稿 + 审核发送）

### SERP 引擎怎么选（重要）

| 引擎 | key | 说明 |
| --- | --- | --- |
| `ddg` | 不需要 | DuckDuckGo HTML。**部分代理节点会 RST 掉 DDG**（表现为 TLS disconnected），换节点即可 |
| `serpapi` | 需要（[免费 100 次/月](https://serpapi.com/)） | 真 Google 结果，最稳。实测经本地代理隧道完全可用，**大陆网络推荐** |
| `literal` | 不需要 | 不联网，只生成三层公式给你手动搜索（兜底） |

自测命令（在本机验证隧道与引擎连通性）：

```sh
node test/ddg-fixture.mjs   # 离线验证 DDG 解析器
```

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `lead_search` | 三层谷歌获客搜索（ddg/serpapi/literal），逐层去重，结果落盘 |
| `lead_export_csv` | 导出某次搜索结果为 CSV |
| `wa_sync` | 从 Evolution API 拉取最近会话，买家消息并入待审队列 |
| `wa_review_queue` | 查看待审/已发/已忽略队列 |
| `wa_reply` | 审核通过并发送回复（或标记忽略）；群聊拒绝 |
| `wa_send_text` | 直接给号码发文本（主动开发，不经审核） |

## 数据与安全

- 数据全部本地：`~/.waimao/`（配置、线索 runs、消息队列、CSV 导出）
- 网页与 API 只接受**回环 + 同源**请求（与 dsh 自身 /api 同款围栏）
- webhook 必须携带 `webhookToken`，未配置 token 时一律 403
- API key 只存本机配置文件，浏览器永远拿不到 key
- **大陆网络**：Node 的 fetch 不读系统代理，插件内置了零依赖的 HTTPS CONNECT 隧道 —— 在 `serp.proxy` 填 `http://127.0.0.1:7890`（Clash 默认端口）即可让 DuckDuckGo/SerpAPI 正常出结果

## 兼容性

基于 `@deepseek-ai/dsh 0.1.0-rc.7` 验证的插件面（`dsh.bundle.patch` 清单、`ctx.tools.register`、`webServer.register`）。dsh 仍是 developer preview，升级后请用 `--dump-config` 复验。

## 免责声明

批量搜索请遵守 Google/搜索引擎条款与目标网站 robots 政策；WhatsApp 自动化请遵守 WhatsApp 服务条款，控制发送频率，避免封号；Evolution API 为第三方开源网关，与其上游条款的合规性由使用者自负。

## License

MIT
