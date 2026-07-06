# 待办事项:渐进式提醒改造(v1 → v2)

## 目标
把已实现的 `create_todo`(单次写表格 + 可选单次提醒)改造成**渐进式提醒**:
- 所有待办都走 3 轮渐进式(第1次=起点,第2次=+2h,第3次=+3h,最多3次)
- 起点:用户给的具体时间;没给 = 次日 9:30
- 每轮到点读飞书表格「处理状态」,仍是「待处理」的列出来,发**一条**消息 @用户(列清单);全完成→该轮不发、后续取消
- 截止:下一轮超过起点当天 20:00 就不排
- 多对象("回访客户A、B、C"):表格建多条,但提醒时**合并成一条消息**列出(不 @十几次)

## 关键决策(用户已定)
1. 有具体时间也走渐进式(起点=用户时间);无具体时间起点=次日9:30。**统一渐进式,没有"只提醒一次"模式了。**
2. 参数:第1次=起点,第2次=+2h,第3次=+3h,最多3次;每次提醒前读表格状态,仍「待处理」才提醒,已「已完成/已取消」则该条不列、该批全完成则停止。
3. 截止晚上8点:下一轮 remind_at > 起点当天 20:00 则不排。
4. 多对象:拆多条待办记录,但提醒合并成一条消息列清单。
5. 聚合提醒消息走**模板**(不走 LLM),保证清单格式清晰;set_reminder 仍走 LLM 文案不变。

## 文件改动

### 1. `db/index.ts` — reminders 表加 3 字段
CREATE TABLE 加 + 用现有 `addColumnIfMissing` 迁移:
```sql
batch_id        TEXT NOT NULL DEFAULT '',   -- 渐进式批次ID(set_reminder 单次提醒留空)
round           INTEGER NOT NULL DEFAULT 0, -- 第几轮 1/2/3(单次=0)
todo_record_ids TEXT NOT NULL DEFAULT ''    -- JSON 数组:该批次待办的飞书 record_id
```
另加索引:`CREATE INDEX IF NOT EXISTS idx_reminders_batch ON reminders(batch_id, round);`
迁移:
```typescript
addColumnIfMissing('reminders', 'batch_id', "batch_id TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('reminders', 'round', 'round INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('reminders', 'todo_record_ids', "todo_record_ids TEXT NOT NULL DEFAULT ''")
```

### 2. `db/reminders.ts` — 新增批次插入 + 取消后续轮
- `DueReminder` 接口加 `batch_id / round / todo_record_ids` 字段
- 新增 `addBatchReminders(input: { batchId, chatId, userOpenId, originalMessageId, rounds: { round, remindAt, todoRecordIds }[] })`:批量插入一个批次的多轮提醒(事务)
- 新增 `cancelLaterRounds(batchId, afterRound)`:把同批次 `round > afterRound` 且 `status='pending'` 的标 `expired`(全完成时调用,避免后续空跑到点还要查表格)
- `addReminder`(单次,set_reminder 用)不动;新字段的单次行 batch_id='' / round=0 / todo_record_ids=''

### 3. `feishu/bitable-todo.ts` — 新增批量读状态
```typescript
export async function getTodoRecords(
  recordIds: string[]
): Promise<{ record_id: string; status: string; content: string }[]>
```
逐条 `GET /bitable/v1/apps/{APP}/tables/{TABLE}/records/{rid}`,读 `fields.事件内容`(content)和 `fields.处理状态`(status)。失败的条目跳过。返回的 `status` 是表格单选文案("待处理"/"已完成"/"已取消")。
> 性能:十几条 = 十几次 API,每天提醒次数有限,可接受。后续若要优化再改 `POST /records/search` 带 filter。

### 4. `feishu/reminders.ts` — flushDue 加聚合分支
`sendReminder` 不动(单次用)。`flushDue` 改造:对每条 due reminder 分支:
- `batch_id == ''`(单次)→ 原 `sendReminder` 逻辑
- `batch_id != ''`(渐进式批次):
  1. `JSON.parse(todo_record_ids)` → recordIds
  2. `getTodoRecords(recordIds)` → 筛 `status === '待处理'` 的(取 content)
  3. 若筛空(全完成/取消)→ **不发消息**,`cancelLaterRounds(batch_id, round)`,markSent,结束
  4. 否则生成聚合消息(模板):
     - 非最后轮:`📋 {userName},你还有 {N} 件待办:\n1. xxx\n2. xxx\n...`
     - 最后轮(round=3 或该批次最大轮):`⏰ {userName},最后提醒!你还有 {N} 件待办:\n1. xxx\n...`
  5. `replyMessage(original_message_id, '<at user_id="${userOpenId}"></at> ' + 聚合消息)`
  6. markSent(无论成败,避免重试)
- "最后轮"判定:round 字段 == 该批次插入时的最大轮次(可在 reminder 行存 `round`,到点时若 `round` 已是该批次最大则加"最后提醒")。简化:round=3 一定是最后;若因截止只排了1或2轮,则 round=最大那轮也是最后——需在插入时知道最大轮。方案:`addBatchReminders` 时把 `total_rounds` 也存(或到点查同批次最大 round)。**简化:rounds 数组里最后一个就是最后轮,插入时给该行 round 标记 `is_last=1`?** 避免加字段,改为:到点时 `cancelLaterRounds` 不影响,直接用 `round === 该批次 max round`——加一个查询 `getBatchMaxRound(batchId)`。或最简:插入时若该轮是最后一轮,在 `content` 字段存 `__LAST__` 标记?不优雅。
  > **决定**:reminders 表再加一列不必要。用 `getBatchMaxRound(batchId)` 查同批次 pending+sent 里最大 round。到点那轮 round==max → 加"最后提醒"。简单查询,无新字段。

### 5. `llm.ts` — CREATE_TODO_TOOL 改造
工具参数:`content`(单字符串)→ **`contents`(字符串数组)**;`remind_at` 仍可选。
```typescript
const CREATE_TODO_TOOL = {
  name: 'create_todo',
  description: '在飞书待办事项表创建待办,并自动排渐进式提醒(3轮:+2h、+3h,晚8点截止,每轮检查表格状态,未完成才提醒)。用户 @你 + 待办内容 + wiki 链接时调用。多对象(如"回访客户A、B、C")拆成 contents 数组一次调用。',
  input_schema: {
    type: 'object',
    properties: {
      contents: { type: 'array', items: { type: 'string' }, description: '待办内容数组。单条也用数组包;多对象每项一条,去掉链接和时间词。如["回访客户A","回访客户B"]' },
      remind_at: { type: 'string', description: '可选。起点时间 ISO 8601,如 "2026-07-07T09:30:00+08:00"。有具体时间传它;没具体时间不传(默认次日9:30)。' },
    },
    required: ['contents'],
  },
}
```
`executeTool` 的 `create_todo` 分支重写:
1. 校验 `contents` 非空数组,每条 trim 非空,去重
2. 逐条 `createTodoInBitable({content, userOpenId, chatId})`,收集成功的 `record_ids`(失败的跳过并 log)
3. 若 record_ids 全空 → 返回 `{ok:false, error:'待办表格写入全部失败'}`
4. 算 startTs:`remind_at` 解析(校验未来);不传 → 次日 09:30 Asia/Shanghai
5. 算 3 轮 + 截止(起点当天 20:00):
   - round1 = startTs(必排)
   - round2 = startTs + 2h;`> day20` 则不排 round2/3
   - round3 = startTs + 3h;`> day20` 则不排 round3
6. `batchId = ctx.originalMessageId + '-' + Date.now()`
7. `addBatchReminders({ batchId, chatId, userOpenId, originalMessageId, rounds: [{round, remindAt, todoRecordIds: record_ids}] })`
8. `onReminderAdded?.()`(重排定时器)
9. 返回 `{ ok:true, todo_count: record_ids.length, record_ids, start_at, rounds: [各轮时间ISO], bitable_link: config.BITABLE_TODO_LINK }`

### 6. `llm.ts` — system prompt 更新待办段
- 多对象:用户一次提多个待办(如"回访客户A、B、C")→ `contents` 数组,**一次调用**(别调多次)
- 时间:有具体时间传 `remind_at`(起点);无具体时间不传(默认次日9:30)
- 渐进式:后端自动排3轮(+2h/+3h,晚8点截止,每轮检查表格状态未完成才提醒),LLM 不用管轮次
- 回复格式:确认创建了几条 + 列出内容 + 第一次提醒时间 +(若有)截止说明 + 表格链接
  - 例:`✅ 已创建3条待办:回访客户A、回访客户B、回访客户C\n⏰ 第一次提醒:明天9:30,之后11:30、14:30 各查一次(没完成才提醒)\n🔗 查看待办:<link>`

## 不改的
- `set_reminder`(单次定时提醒)及其工具、调度、LLM 文案 —— 完全不动,与 create_todo 并存
- `feishu/bitable-todo.ts` 的 `createTodoInBitable`(写表格)—— 复用,只加 `getTodoRecords`
- `config.ts` —— 已有 `BITABLE_TODO_*`,无需改

## 边界
- 第1轮到点前用户在表格把全部待办标完成 → 第1轮不发,`cancelLaterRounds` 取消后续
- 截止20:00:如 18:00 起 → round2=20:00(>20:00 当天,不排)→ 只提醒1次
- 聚合消息:只列仍「待处理」的;已完成/已取消的不列
- 读表格失败(网络/权限):该轮跳过不发(避免发错),markSent,等下一轮重试。或保守起见不发 + 不 markSent 让重试?**决定**:读失败则该轮跳过、**不 markSent**(下次兜底轮询重试),避免误标完成。但可能重复发——边界,先不 markSent 重试。

## 验证(你启动服务后测)
1. `明天9:30提醒我回访客户A、B、C` → 表格3条;9:30 一条消息列3条;11:30 查状态列剩余;14:30 最后一次列剩余
2. `明天提醒我完成报销` → 表格1条;次日9:30/11:30/14:30 三次(无具体时间起点=9:30)
3. 中途表格把某条改「已完成」→ 下次提醒不列它;全完成 → 后续不再提醒
4. `明天18点提醒我XX` → 18:00 提醒1次,20:00 超截止不再排
5. (可选)selftest-todo.ts 验表格写入 + 状态读取
