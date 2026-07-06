# 工具接入:待办事项(写飞书多维表格 + 可选群提醒)

## 目标
@机器人 + 待办内容 + 飞书多维表格/wiki 链接 → 在「待办事项表」里创建一条待办;若用户说了时间,同时复用现有提醒调度器到点在群里 @用户回复原消息。

例:`@机器人 明天提醒我回访客户A https://dcnqipytu7ep.feishu.cn/wiki/QgTawlvA7i2hshkPSHuc7qw9nIh`
→ 表格新增一行(事件内容="回访客户A",责任人=说话人,通知群组=当前群,处理状态="待处理")+ 明天到点群内 @提问者回复原消息。

## 表格结构(已调研,wiki node token 直接当 app_token 可读可写)
表「待办事项表」`table_id=tblUNKsWsW6cT9ry`,字段:

| 字段 | 类型 | 写入策略 |
|---|---|---|
| 待办ID | 自动编号 | 不填(自动) |
| 事件内容 | 文本 | **填** = content |
| 责任人 | 人员(User) | **填** = `[{"id": ctx.userOpenId}]` |
| 处理状态 | 单选 | **填** = "待处理"(选项已存在) |
| 处理结果 | 文本 | 不填(创建时留空) |
| 创建人 | 人员(User) | 不填(留空,用户已定) |
| 通知群组 | 群组(GroupChat) | **填** = `[{"chat_id": ctx.chatId}]` |
| 创建时间 / 更新人 / 更新时间 | 自动 | 不填(系统自动) |

**表格无日期字段** → 时间不落表格,靠 `set_reminder` 机制到点群提醒。

## 关键决策(用户已定)
1. 时间处理:**写表格 + 设群提醒**(复用现有 `addReminder` + 调度器,到点 reply 原消息 @用户)。
2. 字段填充:**责任人=说话人,通知群组=当前群,创建人留空**。
3. 待办不入 SQLite:表格是事实源,目前只创建不查询,不做反向同步(避免流水那套复杂度)。best-effort 写入,失败只 log 不阻断提醒。
4. 工具参数:`content`(必填)+ `remind_at`(可选,ISO 8601;不传=只写表格不提醒)。

## 文件改动

### 1. 新增 `feishu/bitable-todo.ts` — 待办表格写入
参考 `bitable.ts` 的 `writeTransactionToBitable` 模式(best-effort,失败 log 返回 null)。

```typescript
import { apiClient } from './client.js'
import { config } from '../config.js'

const ENABLED = !!(config.BITABLE_TODO_APP_TOKEN && config.BITABLE_TODO_TABLE_ID)
const APP = config.BITABLE_TODO_APP_TOKEN
const TABLE = config.BITABLE_TODO_TABLE_ID
const basePath = `/open-apis/bitable/v1/apps/${APP}/tables/${TABLE}`

const F = {
  content: '事件内容',
  owner: '责任人',
  status: '处理状态',
  chat: '通知群组',
} as const

let warnedDisabled = false
function skipLog() { /* 同 bitable.ts,只告警一次 */ }

export async function createTodoInBitable(input: {
  content: string
  userOpenId: string
  chatId: string
}): Promise<string | null> {
  if (!ENABLED) { skipLog(); return null }
  try {
    const fields: Record<string, any> = {
      [F.content]: input.content,
      [F.status]: '待处理',
      [F.owner]: [{ id: input.userOpenId }],
      [F.chat]: [{ chat_id: input.chatId }],
    }
    const res: any = await apiClient.request({
      method: 'POST', url: `${basePath}/records`, data: { fields },
    })
    if (res.code !== 0) throw new Error(`code=${res.code} msg=${res.msg}`)
    const rid = res.data?.record?.record_id ?? null
    console.log(`📋 已创建待办 record=${rid} 内容="${input.content}"`)
    return rid
  } catch (err: any) {
    console.error('【待办表格写入失败】', err.message ?? err)
    return null
  }
}
```

### 2. `llm.ts` — 注册 `create_todo` 工具
- 新增 `CREATE_TODO_TOOL` 常量:
  - `content`(string,必填):待办内容,如"回访客户A"。去掉链接和时间词。
  - `remind_at`(string,可选):ISO 8601 绝对时间。用户说"明天/下午X点/具体日期"时换算传入,后端到点群提醒;没说时间不传。
- `executeTool` 新增 `create_todo` 分支:
  1. 校验 `content` 非空。
  2. `const recordId = await createTodoInBitable({ content, userOpenId: ctx.userOpenId, chatId: ctx.chatId })`。
  3. 若 `remind_at` 存在:校验可解析 + 未来时间(复用 set_reminder 同款校验)→ `addReminder({ chatId, userOpenId, content, remindAt: ts, originalMessageId: ctx.originalMessageId })` → `onReminderAdded?.()`。时间非法或已过去 → 返回 `{ ok:false, error }`,不创建待办(与 set_reminder 行为一致)。
  4. 返回 `{ ok:true, record_id: recordId, content, remind_at?, bitable_link: config.BITABLE_TODO_LINK }`。
- `tools` 数组加入 `CREATE_TODO_TOOL`。
- `system` prompt 新增一段(活泼口语,跟现有风格对齐):
  > - 创建待办:用户 @你 且消息带飞书多维表格/wiki 链接 + 待办/回访/跟进/处理等意图时(如"明天提醒我回访客户A <链接>""帮我记个待办:XX <链接>"),调 create_todo。
  >   · content = 待办事项本身(去掉链接和时间词),如"回访客户A"。
  >   · 若用户说了时间("明天""下午3点""7月10号"等),换算成 ISO 8601 绝对时间传 remind_at,后端会到点在群里 @你 提醒;没说时间就不传 remind_at(只入表格)。
  >   · 入库后回复:✅ 已创建待办「<内容>」+(若有 remind_at)「⏰ <时间> 会提醒你」+ 一行「🔗 查看待办:<bitable_link>」(链接为空则省略)。

### 3. `config.ts` — 新增 3 个配置
```typescript
BITABLE_TODO_APP_TOKEN: process.env.BITABLE_TODO_APP_TOKEN || '',
BITABLE_TODO_TABLE_ID: process.env.BITABLE_TODO_TABLE_ID || '',
BITABLE_TODO_LINK: process.env.BITABLE_TODO_LINK || '',
```

### 4. `.env.example` — 新增配置项说明
```
# 待办事项多维表格(可选:留空则跳过表格写入,只设提醒)。
# wiki 链接里的 node token 可直接当 app_token 用,table_id 从表格 URL 或 API 取
BITABLE_TODO_APP_TOKEN=QgTawlvA7i2hshkPSHuc7qw9nIh
BITABLE_TODO_TABLE_ID=tblUNKsWsW6cT9ry
# 待办表格链接(创建后回复里附上,便于点击查看)
BITABLE_TODO_LINK=https://dcnqipytu7ep.feishu.cn/wiki/QgTawlvA7i2hshkPSHuc7qw9nIh
```

### 5. 用户侧:把上述 3 个值填进 `server/.env`
(实现时我会在 .env.example 留好,实际 .env 由你填——但 token/table_id/链接我都查到了,可直接给你填好。)

## 不需要改的
- `handler.ts` / `index.ts`:工具在 llm.ts 内部注册,ctx 已含 `userOpenId/chatId/originalMessageId`,无需改动。
- `db/`:待办不入 SQLite,无需新表。
- `feishu/reminders.ts`:调度器复用,无需改动。

## 飞书应用权限
- `bitable:app`(读写多维表格)— 现有流水双写应已开通;若未开通需在飞书后台加。
- 写记录需要机器人为该表格协作者且有编辑权限(你确认下机器人是否已加入这个待办表的协作者)。

## 验证(由你启动服务后测)
1. 填好 `.env` 三个新配置,`cd server && npm run dev` 启动。
2. 群里 @机器人:`明天下午3点提醒我回访客户A <wiki链接>`
   - 期望:表格新增一行(事件内容=回访客户A,责任人=你,通知群组=当前群,状态=待处理);机器人回复确认 + 提醒时间 + 表格链接;明天15:00 群内收到 @你的提醒回复原消息。
3. 群里 @机器人:`帮我记个待办,整理周报 <wiki链接>`(无时间)
   - 期望:表格新增一行,机器人回复确认 + 表格链接,不设提醒。
4. (可选)写一个 selftest 脚本单独验表格写入(参考 `selftest-bitable.ts`,写一条→回读→删除),`!npx tsx selftest-todo.ts`。

## 清理
- 调研脚本 `inspect-todo-bitable.ts` 实现完成后删除(用完即删,跟 selftest 同惯例)。
