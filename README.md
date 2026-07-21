# 飞书群机器人助手服务

基于飞书长连接的群机器人后台,围绕单进程构建:

- **消息归档**:实时接收 + 每 24h 历史补漏,落 SQLite
- **@机器人问答(LLM)**:基于 MiniMax 的 tool-use loop,支持定时提醒、天气查询(实时/多日预报)
- **客资登记**:发微信联系人截图 @机器人,自动逐条识别录入客资,同步到飞书多维表格(当前最重的能力)
- **定时提醒**:@机器人「X 点提醒我 XX」,到点 @用户(动态定时器精确触发 + 兜底轮询 + 重启补偿)

## 架构

```
飞书 ──长连接──▶ [server/ 后台进程] ──写──▶ messages.db
                      │  │
                      │  ├── Hono HTTP API (/api/messages, /api/customer-leads)
                      │  ├── Mastra agent 端点(/api/agents/...)
                      │  └── record_customer_info ──best-effort──▶ 飞书「客资信息登记表」
                      └── worker:长连接收消息 + 每24h历史补漏 + 提醒调度
```

- **server/**:Node + TypeScript + ESM + Hono。一个进程同时跑 ① 飞书 worker(长连接+补漏+提醒调度)② 业务 HTTP API(读 SQLite)③ Mastra agent 端点。必须常驻、单实例运行。**纯后台,无前端。**

## 目录结构

```
feishu/
└── server/
    ├── src/
    │   ├── index.ts                 # 入口:Hono app + MastraServer + 启动 worker
    │   ├── config.ts                # 读 .env
    │   ├── llm.ts                   # @问答 LLM 入口(tool-use loop,4 个工具)
    │   ├── llm/toolRegistry.ts      # 事实接管:写工具登记表 + 系统核对段 + URL 清洗 + 去重归一化
    │   ├── ai/
    │   │   └── model.ts             # 统一 LLM 配置(Anthropic SDK + AI SDK -> MiniMax)
    │   ├── db/
    │   │   ├── index.ts             # better-sqlite3 连接 + 建表 schema(messages / mentions / reminders / customer_leads)
    │   │   ├── messages.ts          # 消息/提及入库/查询
    │   │   ├── reminders.ts         # 提醒 CRUD
    │   │   └── customerLeads.ts     # 客资 CRUD + 软删 + 分页查询
    │   ├── feishu/
    │   │   ├── client.ts            # apiClient + wsClient
    │   │   ├── handler.ts           # 消息事件处理 + @机器人问答 + 补录模式 + worker 启动
    │   │   ├── history.ts           # 历史补漏
    │   │   ├── messages.ts          # replyMessage
    │   │   ├── media.ts             # 下载消息图片 + sharp 压缩(喂 LLM 视觉)
    │   │   ├── reminders.ts         # 提醒调度器(动态定时器 + 兜底轮询 + 重启补偿)
    │   │   └── bitable-customer.ts  # 客资单向同步到飞书表格
    │   ├── routes/
    │   │   ├── index.ts             # 业务 API 路由聚合
    │   │   ├── messages.ts          # GET /api/messages
    │   │   └── customerLeads.ts     # GET /api/customer-leads
    │   ├── services/
    │   │   └── weather.ts           # open-meteo 封装(实时 + 多日预报)
    │   └── mastra/
    │       ├── index.ts             # Mastra 实例
    │       └── agents/summary-agent.ts
    ├── tests/
    │   └── toolRegistry.test.ts     # 事实接管 + 去重归一化单测(node:test)
    ├── data/messages.db             # SQLite(运行时生成)
    ├── .env                         # 凭证(自行填写,参考 .env.example)
    └── .env.example
```

## 快速开始

```bash
cd server
npm install
cp .env.example .env   # 填入飞书凭证与 ANTHROPIC_API_KEY(MiniMax)
npm run dev
```

启动后控制台应同时出现:
- `✅ 飞书长连接已启动,正在监听群消息...`
- `⏰ 历史补漏已调度:启动5秒后执行一次,之后每24小时一次`
- `✅ HTTP 服务监听 http://localhost:4111`
- `⏰ 提醒调度器已启动(动态定时器 + 10分钟兜底轮询,重启补偿窗口 30min)`

## 飞书应用配置

在飞书开放平台为应用开启权限:

**基础**(消息归档 + @问答 + 提醒):
- `im:message`(接收消息事件)
- `im:message.group_at_msg:readonly` / `im:message:readonly`(读群消息)
- `im:chat:readonly`(拉机器人所在群,历史补漏用)
- `contact:user.base:readonly`(查用户姓名)
- `im:message:send_as_bot`(以应用身份发消息,@机器人回复用)

**客资同步**(可选,启用飞书表格同步时需要):
- `bitable:app:readonly` / `bitable:app`(读写客资多维表格)

> 客资是单向同步,不订阅云文档变更事件,无需 `drive:drive` 权限。

「事件订阅」开**长连接模式**(不要选「将事件发送至开发者服务器」),订阅:
- `im.message.receive_v1`

> 长连接模式下不需要配置回调地址、Encrypt Key、Verification Token。

把机器人加入要监听的群。

## 部署注意

后台进程必须**常驻、单实例**(长连接 + 定时器依赖)。不要部署到会冻结/回收实例的环境(如 Vercel serverless)。单台常驻服务器或容器即可。多实例会导致长连接重复收消息。

## NPM Scripts

| 命令 | 说明 |
|---|---|
| `npm run dev` | tsx 热重载 |
| `npm run build` / `npm start` | tsup 编译 / 生产启动 |
| `npm test` | 单测(node:test + tsx,覆盖事实接管与去重归一化) |
