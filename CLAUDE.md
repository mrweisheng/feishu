# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

飞书消息归档 + 群机器人助手服务:监听飞书群消息并归档到 SQLite,集成 @机器人问答(基于 LLM)、定时提醒、天气查询,后台同时暴露 Mastra 智能体端点。 前后端分离。

## 架构

```
飞书 ──长连接──▶ [server/ 单进程] ──写──▶ messages.db
                      │  ├── Hono HTTP API (端口 4111) ◀── /api/messages ◀── [web/ Vue 前端]
                      │  ├── Mastra agent 端点 (/api/agents/summary-agent)
                      │  ├── @机器人问答 (llm.ts tool-use loop → set_reminder / get_weather)
                      │  ├── 提醒调度器 (动态 setTimeout + 10min 兜底轮询)
                      │  └── worker: 长连接收消息 + 每24h历史补漏
```

**关键约束**:后台进程必须常驻、单实例运行(长连接 + 定时器 + 提醒调度器依赖)。多实例会导致长连接重复收消息、提醒重复触发。

## 常用命令

```bash
# 后台开发(tsx 热重载)
cd server && npm run dev

# 后台构建/生产启动
cd server && npm run build && npm start

# 前端开发(Vite,端口 5173,/api 代理到 4111)
cd web && npm run dev

# 前端构建
cd web && npm run build
```

首次运行需要 `cp server/.env.example server/.env` 并填入飞书应用凭证 + LLM 凭证。

## 技术栈

| 层 | 技术 |
|---|---|
| 后台运行时 | Node.js + TypeScript + ESM + Hono |
| 飞书 SDK | `@larksuiteoapi/node-sdk`(API 客户端 + 长连接 WS 客户端) |
| 数据库 | `better-sqlite3`(WAL 模式),文件路径由 `DB_PATH` 环境变量控制 |
| LLM | Anthropic SDK 兼容端点(`@anthropic-ai/sdk`),指向 MiniMax(`ANTHROPIC_*` 变量驱动) |
| AI Agent | Mastra(`@mastra/core` + `@mastra/hono`),通过 AI SDK(`@ai-sdk/anthropic`)复用同一 LLM |
| 前端 | Vue 3 + Vite + TypeScript |
| 构建工具 | tsup(后台,ESM/es2023)、Vite(前端) |

## 后台单进程三合一(+ 定时任务)

`server/src/index.ts` 在一个 Node 进程中并行启动:

1. **飞书 Worker**(`feishu/handler.ts`)
   - 注册 `im.message.receive_v1` 事件,长连接接收实时消息 → 入库 `source=realtime`
   - 启动 5 秒后执行一次历史补漏,之后每 24 小时一次(`source=history`,靠 `message_id` 去重)
   - 启动时异步拉取机器人自身 `open_id`(走 `/open-apis/bot/v3/info/`),用于判断"@机器人"
   - @机器人的群消息(text 类型)→ 提取问题 → 调 `askLLM` → 引用回复原消息
   - 启动提醒调度器(`feishu/reminders.ts`)

2. **业务 HTTP API**(`routes/`)
   - `routes/index.ts` 聚合后挂到 `/api`
   - 当前: `GET /api/messages?limit&offset&chat_id` 分页读 SQLite
   - 新模块在此注册,`index.ts` 只需引入一次

3. **Mastra Agent**(`mastra/`)
   - `mastra/index.ts` 注册 `summaryAgent`,经 `@mastra/hono` 的 `MastraServer` 暴露 `/api/agents/summary-agent`

## 代码组织

- `db/`:持久化层。`db/index.ts` 单例连接 + 建表 schema,`db/messages.ts` / `db/reminders.ts` 各封装领域仓储(全部预编译语句,业务层零 SQL)。
- `ai/model.ts`:统一 LLM 配置,导出 `anthropic`(Anthropic SDK 客户端)、`model`(AI SDK LanguageModel)、`modelName`。`llm.ts`(问答 tool-use loop)和 Mastra agent 都从此取,共享同一 MiniMax 兼容端点。
- `llm.ts`:@机器人问答入口。导出 `askLLM(question, ctx)`(最多 3 轮 tool-use loop,带 `set_reminder` + `get_weather` 工具)、`generateReminderText(content, userName)`(到点提醒的活泼文案)、`setOnReminderAdded(fn)`(新增提醒后通知调度器重排定时器,避免循环依赖)。
- `services/`:外部 API 封装。当前只有 `weather.ts`(`wttr.in` 免费、无 key、中文友好,`format=j1` 返回结构化 JSON,weatherCode 映射中文描述,`date` 不传=实时,传=预报)。
- `feishu/`:飞书 SDK 封装
  - `client.ts` — `apiClient`(主动调飞书接口) + `wsClient`(长连接收事件)
  - `handler.ts` — 消息事件入口、机器人 open_id、@问答路由、worker 启动
  - `history.ts` — 历史补漏,以机器人所在群为目标,5 分钟重叠窗口增量拉取
  - `messages.ts` — `replyMessage`(引用回复原消息)
  - `reminders.ts` — 提醒调度器
- `routes/`:HTTP 路由,`index.ts` 聚合
- `mastra/`:Mastra 智能体定义,`agents/summary-agent.ts` 是示例 agent(后续在此扩展)

## LLM 工具系统(`llm.ts`)

`askLLM` 走标准 Anthropic tool-use loop,最多 3 轮:

- **系统 prompt 注入当前时间**:`Asia/Shanghai` 时区格式化,LLM 直接知道"今天几号/几点"无需额外调用
- **工具列表**:
  - `set_reminder(remind_at: ISO8601, content: string)`:后端校验时间合法性 + 未来 → 入 `reminders` 表 → 调度器到点 reply 原消息
  - `get_weather(city, date?: YYYY-MM-DD)`:查 `wttr.in`,`date` 不传=实时,传=查该日预报(约 3 天范围)
- **失败兜底**:LLM 报错时回复"开小差了,稍后再试",避免用户以为没反应
- **上下文**:`LlmContext = { originalMessageId, userOpenId, chatId }`,工具执行时用(知道回复到哪条消息、@谁)

到点提醒的文案(`generateReminderText`)走 LLM 生成,失败时回退到 6 条本地多样化模板(随机挑),避免重复死板。

## 提醒调度器(`feishu/reminders.ts`)

混合调度模式,平衡精度与可靠性:

- **动态 setTimeout**:为"最近一条 pending"设精确触发定时器,到点 `flushDue`,处理完再 `scheduleNext` 重排下一条;无 pending 时零空转
- **10 分钟兜底轮询**:补动态定时器可能漏的情况(时钟漂移 / 新增提醒 / 进程恢复)
- **新增提醒钩子**:`llm.ts` 调用 `setOnReminderAdded(scheduleNext)`,若新增的提醒比当前定时器更早,立刻重排
- **启动时清理**:`expireOverdueReminders(now)` 把"过期的 pending"标记 `expired`,**直接丢弃不补发**(用户决策)
- **发送策略**:无论 reply 成败都标记 `sent`,避免原消息被撤回等导致无限重试

## 数据库设计

`server/src/db/index.ts` 单例连接(WAL 模式),三张表(全部预编译语句):

### messages

主表,`message_id` 为主键(`INSERT OR IGNORE` 去重)。

| 字段 | 说明 |
|---|---|
| `message_id` | 飞书消息 ID,主键 |
| `chat_id` / `chat_type` | 会话 / 群 ID 与类型(p2p \| group) |
| `message_type` | text \| post \| image \| ... |
| `sender_open_id` / `sender_user_id` / `sender_union_id` / `sender_type` | 发送人 ID 三件套 + 类型 |
| `sender_name` | 冗余存姓名,异步回填 |
| `root_id` / `parent_id` | 话题根 / 被回复消息 ID |
| `content` | 原始 content JSON 字符串 |
| `raw_data` | 完整事件 JSON 兜底 |
| `create_time` / `received_at` | 发送时间 / 入库时间(毫秒) |
| `source` | `realtime` \| `history` |
| `is_recalled` / `updated_at` | 撤回标记 / 更新时间 |

索引:`idx_chat_time(chat_id, create_time)` / `idx_sender` / `idx_create_time` / `idx_source`

### mentions

@提及表,外键 `message_id → messages.message_id`。

| 字段 | 说明 |
|---|---|
| `mention_key` | content 里的占位符 `@_user_1` |
| `open_id` / `user_id` / `union_id` / `name` | 被 @ 用户 ID 三件套 + 名字 |

索引:`idx_mentions_msg` / `idx_mentions_openid`

### reminders

定时提醒表,调度器读取 `status='pending' AND remind_at <= now` 的记录。

| 字段 | 说明 |
|---|---|
| `chat_id` | 群 ID(便于排查) |
| `user_open_id` | @谁 |
| `content` | 提醒内容 |
| `remind_at` | 触发时间(毫秒) |
| `original_message_id` | 设提醒的原消息 ID,到点 reply 它 |
| `created_at` | 创建时间 |
| `status` | `pending` \| `sent` \| `expired` |

索引:`idx_reminders_due(remind_at, status)`

**入库去重**:历史补漏与实时收消息共用 `saveMessage`,靠 `message_id` 主键 `INSERT OR IGNORE` 吸收。**mentions 仅在 messages 真新增时插入**,避免重投递时重复落库。

## 飞书历史补漏(`feishu/history.ts`)

- **目标群**:启动时实时拉机器人所在群(`/open-apis/im/v1/chats`),自动覆盖新加入的群,解决冷启动无种子问题;API 失败时回退到库中已知 `chat_id`
- **增量起点**:从该群最后一条 `create_time` 往前回退 5 分钟重叠窗口(`OVERLAP_MS`),无记录则拉最近 7 天
- **入库**:复用实时事件 `saveMessage` 路径,标记 `source=history`,靠主键去重
- **分页**:50 条/页,最多 500 页防死循环,按 `ByCreateTimeAsc` 升序

## 前端结构(`web/`)

```
web/src/
├── App.vue                  # 入口:头部 + 加载按钮 + MessageList
├── api.ts                   # fetchMessages({limit, offset, chat_id}),走 vite proxy
├── components/
│   └── MessageList.vue      # 消息卡片列表(姓名/时间/source 标签/content)
├── main.ts
└── env.d.ts
```

Vite 开发期 `proxy: '/api' → http://localhost:4111`,免跨域。前端只读消息列表,不直接调 Mastra 端点。

## 环境变量

`server/.env`(参考 `.env.example`):

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `PORT` | 否 | HTTP 端口,默认 `4111` |
| `DB_PATH` | 否 | SQLite 路径(相对 server/),默认 `./data/messages.db` |
| `ANTHROPIC_BASE_URL` | 是 | LLM 端点,指向 MiniMax 的 Anthropic 兼容端点(`.env.example` 默认 `https://api.minimaxi.com/anthropic`) |
| `ANTHROPIC_API_KEY` | 是 | MiniMax API Key |
| `LLM_MODEL` | 否 | 模型名,默认 `MiniMax-M3` |

## 飞书应用权限(后台归档 + @问答 + 提醒所需)

- `im:message` — 接收消息事件
- `im:message.group_at_msg:readonly` / `im:message:readonly` — 读群消息
- `im:chat:readonly` — 拉机器人所在群(历史补漏用)
- `contact:user.base:readonly` — 查用户姓名(发件人缓存)
- `im:message:send_as_bot` — 以应用身份 reply 消息(@问答、提醒回复用)

「事件订阅」开长连接模式,订阅 `im.message.receive_v1`,把机器人加入要监听的群。