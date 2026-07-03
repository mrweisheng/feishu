# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

飞书消息归档服务：监听飞书群消息并归档到 SQLite，前后端分离，后台集成 Mastra 智能体。

## 架构

```
飞书 ──长连接──▶ [server/ 单进程] ──写──▶ messages.db
                      │  ├── Hono HTTP API (端口 4111) ◀── /api/messages ◀── [web/ Vue 前端]
                      │  ├── Mastra agent 端点 (/api/agents/...)
                      │  └── worker: 长连接收消息 + 每24h历史补漏
```

**关键约束**：后台进程必须常驻、单实例运行（长连接 + 定时器依赖）。多实例会导致长连接重复收消息。

## 常用命令

```bash
# 后台开发（tsx 热重载）
cd server && npm run dev

# 后台构建/生产启动
cd server && npm run build && npm start

# 前端开发（Vite，端口 5173，/api 代理到 4111）
cd web && npm run dev

# 前端构建
cd web && npm run build
```

首次运行需要 `cp server/.env.example server/.env` 并填入飞书应用凭证。

## 技术栈

| 层 | 技术 |
|---|---|
| 后台运行时 | Node.js + TypeScript + ESM + Hono |
| 飞书 SDK | `@larksuiteoapi/node-sdk`（API 客户端 + 长连接 WS 客户端） |
| 数据库 | `better-sqlite3`（WAL 模式），文件路径由 `DB_PATH` 环境变量控制 |
| AI Agent | Mastra (`@mastra/core` + `@mastra/hono`)，模型 MiniMax-M3（走 Anthropic SDK 兼容端点，由 `ANTHROPIC_*` 环境变量驱动） |
| 前端 | Vue 3 + Vite + TypeScript |
| 构建工具 | tsup（后台）、Vite（前端） |

## 后台单进程三合一

`server/src/index.ts` 在一个 Node 进程中同时启动：

1. **飞书 Worker** (`feishu/handler.ts`)：注册 `im.message.receive_v1` 事件，通过长连接接收实时消息，入库 `source=realtime`；启动 5 秒后执行一次历史补漏，之后每 24 小时一次
2. **业务 HTTP API** (`routes/`)：路由在 `routes/index.ts` 聚合后挂到 `/api`，`GET /api/messages` 分页读 SQLite，支持 `chat_id` 过滤
3. **Mastra Agent** (`mastra/`)：Hono 自动暴露 `/api/agents/summary-agent` 等端点

## 代码组织

- `db/`：持久化层。`db/index.ts` 负责连接与建表 schema（messages / mentions / reminders 三张表），`db/messages.ts` 和 `db/reminders.ts` 各自封装领域仓储（预编译语句 + CRUD）。
- `ai/model.ts`：统一 LLM 配置，同时给 `llm.ts`（@问答的 Anthropic SDK tool-use loop）和 Mastra agent（AI SDK 模型）复用，指向同一个 MiniMax 兼容端点。
- `feishu/`：飞书 SDK 封装（client / handler / history / messages / reminders）。
- `routes/`：HTTP 路由，`index.ts` 聚合。
- `mastra/`：Mastra 智能体定义。

## 数据库设计

`server/src/db/` 使用预编译语句，三张表：

- **messages**：主表，`message_id` 为主键（`INSERT OR IGNORE` 去重），`source` 区分 `realtime`/`history`，`sender_name` 异步回填
- **mentions**：@提及表，外键关联 `messages.message_id`
- **reminders**：定时提醒表，调度器每 60 秒轮询 `remind_at` 到点的 `pending` 记录

历史补漏逻辑（`feishu/history.ts`）：以机器人所在群为目标，从每个群最后一条消息时间往前回退 5 分钟重叠窗口增量拉取，靠 `message_id` 去重避免重复入库。

## 环境变量

`server/.env`（参考 `.env.example`）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `PORT` | 否 | HTTP 端口，默认 4111 |
| `DB_PATH` | 否 | SQLite 路径（相对 server/），默认 `./data/messages.db` |
| `ANTHROPIC_BASE_URL` | 是 | LLM 端点，指向 MiniMax 的 Anthropic 兼容端点 |
| `ANTHROPIC_API_KEY` | 是 | MiniMax API Key |
| `LLM_MODEL` | 否 | 模型名，默认 `MiniMax-M3` |
