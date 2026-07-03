# 工具接入:时间观念 + 定时提醒

## 目标
1. **时间观念**:机器人能答"今天几号/几点"。
2. **定时提醒**:@机器人 "5分钟后提醒我喝水" / "下午1点提醒我拿快递",到点在群里回复原消息并 @提问者。

## 技术结论(已调研)
- MiniMax-M3 的 Anthropic 兼容端点**官方支持 tool calling**(标准 Anthropic `tools` API:`tools` 参数 + `tool_use` block + `tool_result` 回灌)。文档原文:"MiniMax-M3 支持...工具调用、工具结果...内容块"。
- 飞书回复消息 API 已有(`replyMessage`),提醒到点复用它即可。

## 方案概览
- **时间**:不做成工具,直接把当前时间注入 `system` prompt(更简单可靠,LLM 直接就知道现在几点,答"今天几号"无需额外调用)。
- **提醒**:做成 `set_reminder` 工具,走标准 tool-use loop。LLM 读 system prompt 里的当前时间 → 算出绝对触发时间 `remind_at`(ISO 8601) → 调工具 → 后端存 SQLite + 调度 → 到点 `reply` 原消息 @用户。

## 关键决策(用户已定)
- 提醒形式:**回复**设提醒的那条原消息(引用回复,挂原消息下)→ 需存 `original_message_id`。
- 过期提醒:**直接丢弃** → 启动时把 `pending` 且 `remind_at < now` 的标记 `expired`,不发送。
- 调度精度:60 秒轮询(提醒场景足够,最多 1 分钟误差)。

## 文件改动

### 1. `db.ts` — 新增 reminders 表 + CRUD
```sql
CREATE TABLE IF NOT EXISTS reminders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             TEXT NOT NULL,
  user_open_id        TEXT NOT NULL,         -- @谁
  content             TEXT NOT NULL,         -- 提醒内容
  remind_at           INTEGER NOT NULL,      -- 触发时间(毫秒)
  original_message_id TEXT NOT NULL,         -- 设提醒的原消息ID,到点reply它
  created_at          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'  -- pending | sent | expired
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at, status);
```
新增并 export:`addReminder(...)`、`getDueReminders(now)`、`markReminderSent(id)`、`expireOverdueReminders(now)`。

### 2. `llm.ts` — 重写为 tool-use loop
- 新签名:`askLLM(question, ctx: { originalMessageId, userOpenId, chatId })`
- `system` prompt 动态注入当前时间:`你是一个有用的助手。当前时间:2026-07-03 周五 11:30 (UTC+8, Asia/Shanghai)。需要时调用 set_reminder 工具帮用户设置定时提醒。`(用 `Asia/Shanghai` 时区格式化,不依赖服务器本地时区)
- `tools = [SET_REMINDER_TOOL]`
- 循环(最多 3 轮防卡死):
  1. `client.messages.create({ model, system, tools, messages })`
  2. 若 `stop_reason === 'tool_use'`:把 `res.content` 入历史 → 逐个执行工具 → 回灌 `tool_result` → 继续循环
  3. 否则:返回拼接的 text
- `set_reminder` 工具执行:校验 `Date.parse(remind_at)` 合法且 > now → `addReminder(...)` → 返回 `{ok:true}` / `{ok:false,error}`(过去时间返回 error,LLM 会重试或提示用户)

`SET_REMINDER_TOOL` 定义(Anthropic 格式):
```ts
{
  name: 'set_reminder',
  description: '为用户设置定时提醒。到点会在群里@用户并回复原消息。用户说"X分钟后提醒我...""下午X点提醒我..."时调用。',
  input_schema: {
    type: 'object',
    properties: {
      remind_at: { type: 'string', description: '提醒触发绝对时间,ISO 8601,如 "2026-07-03T13:05:00+08:00",根据当前时间推算' },
      content:   { type: 'string', description: '提醒内容,简短,如"喝水"' },
    },
    required: ['remind_at', 'content'],
  },
}
```

### 3. `feishu/messages.ts` — 新文件,提取 replyMessage
把 `handler.ts` 里现有的 `replyMessage(messageId, text)` 搬到此文件并 export,handler 和 scheduler 共用(为本次新功能产生的合理复用,非顺手重构)。

### 4. `feishu/reminders.ts` — 新文件,调度器
```ts
export function startReminderScheduler() {
  // 启动时丢弃过期(用户选:直接丢弃)
  expireOverdueReminders(Date.now())
  // 启动立刻跑一次 + 每60秒轮询到点的
  const tick = () => {
    for (const r of getDueReminders(Date.now())) {
      replyMessage(r.original_message_id, `<at user_id="${r.user_open_id}"></at> ⏰ 提醒:${r.content}`)
        .then(() => markReminderSent(r.id))
        .catch((e) => console.error('【提醒发送失败】id=', r.id, e.response?.data?.msg || e.message))
      // 失败也标记 sent,避免反复重试打扰(原消息被撤回等情况)
      markReminderSent(r.id)
    }
  }
  tick()
  setInterval(tick, 60_000)
}
```
注:`markReminderSent` 无论发送成败都标记(避免撤回的原消息导致无限重试),失败靠日志定位。

### 5. `handler.ts`
- 删除本地 `replyMessage` 定义,改 `import { replyMessage } from './messages.js'`
- 问答块 `askLLM(question)` 改为 `askLLM(question, { originalMessageId: message.message_id, userOpenId: openId, chatId: message.chat_id })`
- `startFeishuWorker()` 末尾加 `startReminderScheduler()`

## 验证(由用户启动,不自动跑)
1. `npx tsc --noEmit` 通过
2. `cd server && npm run dev` 启动
3. 测试用例:
   - @机器人 "今天几号" → 直接答(走 system prompt 注入,不调工具)
   - @机器人 "1分钟后提醒我喝水" → 日志见 `set_reminder` 工具调用 + DB 写入;约 1 分钟后群里回复原消息 "@你 ⏰ 提醒:喝水"
   - @机器人 "下午1点提醒我拿快递" → 验证 LLM 算出正确绝对时间
   - 重启丢弃:设 2 分钟提醒,1 分钟时重启 → 过期那条不再发送,日志见 `expireOverdueReminders` 清理

## 风险
- LLM 算错时间/时区:system prompt 明确当前时间+时区;后端校验 `remind_at > now`,过去则返回 error 让 LLM 重试。
- 轮询 60 秒精度:"30秒后提醒"可能延迟到下一轮询。可接受;若需更精确改 30 秒间隔。
- 原消息被撤回:reply 失败,日志记录,标记 sent 跳过,不重试。
- tool-use loop 最多 3 轮,防 LLM 卡在工具调用循环。
