# 飞书群机器人助手服务

基于飞书长连接的群机器人后台,围绕单进程构建:

- **消息归档**:实时接收 + 每 24h 历史补漏,落 SQLite
- **@机器人问答(LLM)**:基于 MiniMax 的 tool-use loop,支持定时提醒、天气查询
- **定时提醒**:@机器人「X 点提醒我 XX」,到点 @用户(动态定时器精确触发 + 兜底轮询防漏)

## 架构

```
飞书 ──长连接──▶ [server/ 后台进程] ──写──▶ messages.db
                      │  │
                      │  ├── Hono HTTP API (/api/messages)
                      │  └── Mastra agent 端点(/api/agents/...)
                      └── worker:长连接收消息 + 每24h历史补漏 + 提醒调度
```

- **server/**:Node + TypeScript + ESM + Hono。一个进程同时跑 ① 飞书 worker(长连接+补漏+提醒调度)② 业务 HTTP API(读 SQLite)③ Mastra agent 端点。必须常驻、单实例运行。

## 目录结构

```
feishu/
└── server/
    ├── src/
    │   ├── index.ts                 # 入口:Hono app + MastraServer + 启动 worker
    │   ├── config.ts                # 读 .env
    │   ├── llm.ts                   # @问答 LLM 入口(tool-use loop,3 个工具:set_reminder / get_weather / get_weather_forecast)
    │   ├── ai/
    │   │   └── model.ts             # 统一 LLM 配置(Anthropic SDK + AI SDK → MiniMax)
    │   ├── db/
    │   │   ├── index.ts             # better-sqlite3 连接 + 建表 schema(messages / mentions / reminders)
    │   │   ├── messages.ts          # 消息/提及入库/查询
    │   │   └── reminders.ts         # 提醒 CRUD
    │   ├── feishu/
    │   │   ├── client.ts            # apiClient + wsClient
    │   │   ├── handler.ts           # 消息事件处理 + @机器人问答 + worker 启动
    │   │   ├── history.ts           # 历史补漏
    │   │   ├── messages.ts          # replyMessage
    │   │   └── reminders.ts         # 提醒调度器(动态定时器 + 兜底轮询)
    │   ├── routes/
    │   │   ├── index.ts             # 业务 API 路由聚合
    │   │   └── messages.ts          # GET /api/messages
    │   ├── services/
    │   │   └── weather.ts           # wttr.in 封装
    │   └── mastra/
    │       ├── index.ts             # Mastra 实例
    │       └── agents/summary-agent.ts
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
- `⏰ 提醒调度器已启动(动态定时器 + 10分钟兜底轮询)`

## 飞书应用配置

在飞书开放平台为应用开启权限:

**基础**(消息归档 + @问答 + 提醒):
- `im:message`(接收消息事件)
- `im:message.group_at_msg:readonly` / `im:message:readonly`(读群消息)
- `im:chat:readonly`(拉机器人所在群,历史补漏用)
- `contact:user.base:readonly`(查用户姓名)
- `im:message:send_as_bot`(以应用身份发消息,@机器人回复用)

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
