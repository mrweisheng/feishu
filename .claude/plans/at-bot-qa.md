# @机器人 一问一答 接入方案

## 目标
群里 @机器人 → 提取问题 → 调 MiniMax（走 Anthropic SDK 兼容端点）→ 回复到飞书：@提问者 + 引用回复挂在原消息下。一问一答，无上下文。

## 架构决策：直接调 LLM，不走 Mastra

封装一个独立的 `src/llm.ts`，在飞书事件处理里直接调用。

理由：
- 这是**事件驱动**场景（收到 @消息 → 调 LLM → 回复），不是 agent 主动决策调工具的对话循环，走 Mastra agent 反而绕路。
- 用户要求"后续所有用到的 LLM 都用这个"，需要一个**统一、独立**的 LLM 入口，而不是绑死在某个 agent 上。
- 符合 Simplicity First。

现有 Mastra `summary-agent`（zhipu/glm-4.5）**不动**，避免范围蔓延；如需统一可后续切换。

## 改动清单

### 1. 装依赖
```bash
cd server && npm install @anthropic-ai/sdk
```

### 2. 配置 `server/.env` + `.env.example`
追加三行（key 写入 .env，.env.example 只留占位）：
```
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
ANTHROPIC_API_KEY=<用户提供的 key>
LLM_MODEL=MiniMax-M3
```

### 3. 新建 `server/src/llm.ts`（统一 LLM 入口）
- `new Anthropic()`：Node SDK 自动读 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` 环境变量，无需手动传
- 导出 `askLLM(question: string): Promise<string>`：
  - `system: "你是一个有用的助手。"`
  - `model: config.LLM_MODEL`
  - `max_tokens: 1000`
  - `messages: [{ role: 'user', content: question }]`
  - 解析返回的 `content` blocks，只取 `type === 'text'` 拼接（过滤 MiniMax-M3 可能返回的 `thinking` blocks）

### 4. `config.ts` 增加 LLM 配置
- `LLM_MODEL: process.env.LLM_MODEL || 'MiniMax-M3'`
- 用 `required()` 校验 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 存在

### 5. `feishu/handler.ts` 改造
- **启动时**获取机器人自身 open_id：调 `GET /open-apis/bot/v3/info/`，缓存到模块变量。失败则日志告警、@问答功能不可用（不影响归档主流程）。
- **事件处理** `im.message.receive_v1` 里，在现有落库逻辑之后追加：
  1. 判断是否 @机器人：`chat_type === 'group'` 且 `message.mentions` 里有 `mention.id.open_id === botOpenId`
  2. 只处理 `message_type === 'text'`；非文本不回复（避免打扰）
  3. 提取问题文本：`JSON.parse(content).text`，正则去掉 `@_user_\d+` 占位符并 `trim()`
  4. 调 `askLLM(question)`
  5. 回复：`POST /open-apis/im/v1/messages/{message_id}/reply`，`msg_type=text`，`content={"text":"<at user_id=\"提问者open_id\"></at> {回答}"}`
  6. LLM 失败时回复兜底文案（如"开小差了，稍后再试"），避免用户以为没反应

### 6. 飞书应用权限 + README
- 补权限 `im:message:send_as_bot`（以应用身份发消息/reply）
- README 权限清单更新

## 明确不做（避免范围蔓延）
- 不做多轮上下文（用户明确一问一答）
- 不处理 p2p 单聊（用户只说群里）
- 不动 Mastra summary-agent
- 不做流式输出（飞书 reply 不支持流式）

## 验证
1. `npm run dev` 启动，确认日志输出"机器人 open_id 已获取"
2. 群里 @机器人 发"讲个笑话" → 确认：机器人回复挂在原消息下（引用）、回复内容 @ 了提问者
3. 不 @机器人的普通消息 → 不触发回复，但仍正常归档
4. 模拟 LLM 报错 → 回复兜底文案

## 实施时需现场确认的细节
- "获取机器人信息"API 路径 `GET /open-apis/bot/v3/info/`（调研确认有此接口返回 bot open_id，路径实施时验证）
- MiniMax Anthropic 兼容端点返回的 thinking block 字段名，看实际响应再定过滤逻辑
