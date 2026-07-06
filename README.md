# 飞书群机器人助手服务

基于飞书长连接的群机器人后台,围绕单进程构建:

- **消息归档**:实时接收 + 每 24h 历史补漏,落 SQLite
- **@机器人问答(LLM)**:基于 MiniMax 的 tool-use loop,支持定时提醒、天气查询、**业务收支记账**
- **多维表格双向同步**:记账数据双写到飞书多维表格作为审计/可视化副本,表格改动反向回写 SQLite
- **前端**:消息列表 + 收支统计仪表盘

## 架构

```
飞书 ──长连接──▶ [server/ 后台进程] ──写──▶ messages.db
                      │  │
                      │  ├── Hono HTTP API ◀── /api/messages ◀── [web/ Vue 前端]
                      │  └── Mastra agent 端点(/api/agents/...)
                      └── worker:长连接收消息 + 每24h历史补漏
```

- **server/**:Node + TypeScript + ESM + Hono。一个进程同时跑 ① 飞书 worker(长连接+补漏)② 业务 HTTP API(读 SQLite)③ Mastra agent 端点。必须常驻、单实例运行。
- **web/**:Vue 3 + Vite + TypeScript。前端页面,经后台 API 读数据。

## 目录结构

```
feishu/
├── server/
│   ├── src/
│   │   ├── index.ts                 # 入口:Hono app + MastraServer + 启动 worker
│   │   ├── config.ts                # 读 .env
│   │   ├── llm.ts                   # @问答 LLM 入口(tool-use loop,9 个工具)
│   │   ├── ai/
│   │   │   └── model.ts             # 统一 LLM 配置(Anthropic SDK + AI SDK → MiniMax)
│   │   ├── db/
│   │   │   ├── index.ts             # better-sqlite3 连接 + 建表 schema + 幂等迁移
│   │   │   ├── messages.ts          # 消息/提及入库/查询
│   │   │   ├── reminders.ts         # 提醒 CRUD
│   │   │   ├── paymentMethods.ts    # 我方收款方式(启动 seed)
│   │   │   ├── projects.ts          # 业务名册
│   │   │   └── transactions.ts      # 收支流水 + 聚合 + 反向同步
│   │   ├── feishu/
│   │   │   ├── client.ts            # apiClient + wsClient
│   │   │   ├── handler.ts           # 消息事件处理 + @机器人问答 + worker 启动
│   │   │   ├── history.ts           # 历史补漏
│   │   │   ├── messages.ts          # replyMessage
│   │   │   ├── reminders.ts         # 提醒调度器
│   │   │   ├── bitable.ts           # 多维表格双向同步(正向 + 反向)
│   │   │   └── bitable-todo.ts      # 待办事项写多维表格(create_todo;未配则纯提醒)
│   │   ├── routes/
│   │   │   ├── index.ts             # 业务 API 路由聚合
│   │   │   ├── messages.ts          # GET /api/messages
│   │   │   └── stats.ts             # GET /api/stats/*(业务/月份/待结清/流水/项目/收款方式)
│   │   ├── services/
│   │   │   └── weather.ts           # wttr.in 封装
│   │   └── mastra/
│   │       ├── index.ts             # Mastra 实例
│   │       └── agents/summary-agent.ts
│   ├── data/messages.db             # SQLite(运行时生成)
│   ├── .env                         # 凭证(自行填写,参考 .env.example)
│   └── .env.example
└── web/
    ├── vite.config.ts               # proxy /api -> localhost:4111
    └── src/                         # Vue 页面(双 tab:消息 / 收支统计)
```

## 快速开始

### 1. 后台

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

### 2. 前端

```bash
cd web
npm install
npm run dev
```

打开 http://localhost:5173 ,页面展示归档消息列表(`/api` 经 vite proxy 转发到 4111)。

## 飞书应用配置

在飞书开放平台为应用开启权限:

**基础**(消息归档 + @问答 + 提醒):
- `im:message`(接收消息事件)
- `im:message.group_at_msg:readonly` / `im:message:readonly`(读群消息)
- `im:chat:readonly`(拉机器人所在群,历史补漏用)
- `contact:user.base:readonly`(查用户姓名)
- `im:message:send_as_bot`(以应用身份发消息,@机器人回复用)

**多维表格双向同步**(启用双写时需要):
- `bitable:app:readonly` / `bitable:app`(读写多维表格)
- `drive:drive`(订阅云文档事件)

「事件订阅」开长连接模式,订阅:
- `im.message.receive_v1`
- `drive.file.bitable_record_changed_v1`(启用双写时)

把机器人加入要监听的群。多维表格的字段名/单选选项需要与 `server/src/feishu/bitable.ts` 里的字段映射保持一致(详见 CLAUDE.md)。

## 部署注意

后台进程必须**常驻、单实例**(长连接 + 定时器依赖)。不要部署到会冻结/回收实例的环境(如 Vercel serverless)。单台常驻服务器或容器即可。多实例会导致长连接重复收消息。

## NPM Scripts

| 目录 | 命令 | 说明 |
|---|---|---|
| server | `npm run dev` | tsx 热重载 |
| server | `npm run build` / `npm start` | tsup 编译 / 生产启动 |
| web | `npm run dev` | Vite 开发 |
| web | `npm run build` | 生产构建 |
