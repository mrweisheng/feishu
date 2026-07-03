import { db } from './index.js'

// 飞书事件 payload 结构复杂,不做强类型化,保持与原逻辑 1:1
type FeishuEvent = Record<string, any>

// ---- 预编译语句 ----
const insertMessage = db.prepare(`
INSERT OR IGNORE INTO messages (
  message_id, chat_id, chat_type, message_type,
  sender_open_id, sender_user_id, sender_union_id, sender_type, sender_name,
  root_id, parent_id, content, raw_data,
  create_time, received_at, source
) VALUES (
  @message_id, @chat_id, @chat_type, @message_type,
  @sender_open_id, @sender_user_id, @sender_union_id, @sender_type, @sender_name,
  @root_id, @parent_id, @content, @raw_data,
  @create_time, @received_at, @source
)
`)

const insertMention = db.prepare(`
INSERT INTO mentions (message_id, mention_key, open_id, user_id, union_id, name)
VALUES (@message_id, @mention_key, @open_id, @user_id, @union_id, @name)
`)

const updateSenderName = db.prepare(
  `UPDATE messages SET sender_name = ? WHERE message_id = ?`
)

const countAll = db.prepare('SELECT COUNT(*) AS c FROM messages')

const listAll = db.prepare(
  `SELECT message_id, chat_id, chat_type, message_type, sender_name, content, create_time, source
   FROM messages ORDER BY create_time DESC LIMIT ? OFFSET ?`
)

const listByChat = db.prepare(
  `SELECT message_id, chat_id, chat_type, message_type, sender_name, content, create_time, source
   FROM messages WHERE chat_id = ? ORDER BY create_time DESC LIMIT ? OFFSET ?`
)

const maxCreateTimeOfChat = db.prepare(
  'SELECT MAX(create_time) AS t FROM messages WHERE chat_id = ?'
)

const knownChatIds = db.prepare(
  'SELECT DISTINCT chat_id FROM messages WHERE chat_id IS NOT NULL'
)

export interface MessageRow {
  message_id: string
  chat_id: string
  chat_type: string | null
  message_type: string | null
  sender_name: string | null
  content: string | null
  create_time: number | null
  source: string
}

export interface QueryMessagesParams {
  chatId?: string
  limit: number
  offset: number
}

/**
 * 入库一条消息。message_id 重复时跳过(含其 mentions)。
 * @returns 是否真正新增(true=新消息,false=已存在跳过)
 */
export function saveMessage(data: FeishuEvent, source: 'realtime' | 'history' = 'realtime'): boolean {
  const { message, sender } = data
  const now = Date.now()

  const info = insertMessage.run({
    message_id:      message.message_id,
    chat_id:         message.chat_id,
    chat_type:       message.chat_type,
    message_type:    message.message_type,
    sender_open_id:  sender?.sender_id?.open_id ?? null,
    sender_user_id:  sender?.sender_id?.user_id ?? null,
    sender_union_id: sender?.sender_id?.union_id ?? null,
    sender_type:     sender?.sender_type ?? null,
    sender_name:     null, // 异步补,由 handler 拿到名字后回填
    root_id:         message.root_id ?? null,
    parent_id:       message.parent_id ?? null,
    content:         message.content ?? null,
    raw_data:        JSON.stringify(data),
    create_time:     Number(message.create_time) || null,
    received_at:     now,
    source,
  })

  // 只有主表真正新增时,才插 mentions(避免旧消息重复插)
  if (info.changes > 0 && Array.isArray(message.mentions)) {
    for (const m of message.mentions) {
      insertMention.run({
        message_id:  message.message_id,
        mention_key: m.key ?? null,
        open_id:     m.id?.open_id ?? null,
        user_id:     m.id?.user_id ?? null,
        union_id:    m.id?.union_id ?? null,
        name:        m.name ?? null,
      })
    }
  }

  return info.changes > 0
}

// 回填发送人姓名(拿到名字后调用)
export function fillSenderName(messageId: string, name: string): void {
  updateSenderName.run(name, messageId)
}

// 列表查询:可选按 chat_id 过滤,统一走预编译语句
export function queryMessages({ chatId, limit, offset }: QueryMessagesParams): MessageRow[] {
  return (
    chatId
      ? listByChat.all(chatId, limit, offset)
      : listAll.all(limit, offset)
  ) as MessageRow[]
}

export function countMessages(): number {
  return (countAll.get() as { c: number }).c
}

// 某群最后一条消息的 create_time(历史补漏增量起点),无记录返回 null
export function getMaxCreateTimeOfChat(chatId: string): number | null {
  const row = maxCreateTimeOfChat.get(chatId) as { t: number | null } | undefined
  return row?.t ?? null
}

// 库中已知的所有 chat_id(拉群列表失败时的回退目标)
export function listKnownChatIds(): string[] {
  return knownChatIds.all().map((r: any) => r.chat_id as string)
}
