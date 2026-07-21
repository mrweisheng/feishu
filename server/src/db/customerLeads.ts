import { db } from './index.js'
import { stripDatePrefix } from '../llm/toolRegistry.js'

// ---- 预编译语句 ----
// 插入一条客资(返回新行 id)。不做去重 —— 用户说"录就录",重了手动删。
const insertLead = db.prepare(`
INSERT INTO customer_leads (
  customer_name, customer_wechat, customer_needs, customer_notes,
  is_key_customer, visited_store,
  owner_open_id, owner_name,
  lead_date,
  chat_id, user_open_id, original_message_id,
  created_at, updated_at
) VALUES (
  @customer_name, @customer_wechat, @customer_needs, @customer_notes,
  @is_key_customer, @visited_store,
  @owner_open_id, @owner_name,
  @lead_date,
  @chat_id, @user_open_id, @original_message_id,
  @created_at, @updated_at
)
`)

const setFeishuRecordId = db.prepare(
  `UPDATE customer_leads SET feishu_record_id = ?, updated_at = ? WHERE id = ?`
)

const listAll = db.prepare(`
SELECT id, customer_name, customer_wechat, customer_needs, customer_notes,
       is_key_customer, visited_store, owner_open_id, owner_name,
       lead_date, feishu_record_id, chat_id, user_open_id, original_message_id,
       created_at, updated_at
FROM customer_leads
WHERE is_deleted = 0
ORDER BY lead_date DESC, id DESC
LIMIT ? OFFSET ?
`)

const listByChat = db.prepare(`
SELECT id, customer_name, customer_wechat, customer_needs, customer_notes,
       is_key_customer, visited_store, owner_open_id, owner_name,
       lead_date, feishu_record_id, chat_id, user_open_id, original_message_id,
       created_at, updated_at
FROM customer_leads
WHERE is_deleted = 0 AND chat_id = ?
ORDER BY lead_date DESC, id DESC
LIMIT ? OFFSET ?
`)

const countAll = db.prepare(
  `SELECT COUNT(*) AS c FROM customer_leads WHERE is_deleted = 0`
)

const countByChat = db.prepare(
  `SELECT COUNT(*) AS c FROM customer_leads WHERE is_deleted = 0 AND chat_id = ?`
)

const byId = db.prepare(
  `SELECT * FROM customer_leads WHERE id = ?`
)

const softDelete = db.prepare(
  `UPDATE customer_leads SET is_deleted = 1, updated_at = ? WHERE id = ?`
)

const softDeleteByFeishuRecordId = db.prepare(
  `UPDATE customer_leads SET is_deleted = 1, updated_at = ? WHERE feishu_record_id = ?`
)

export interface CustomerLeadRow {
  id: number
  customer_name: string | null
  customer_wechat: string | null
  customer_needs: string | null
  customer_notes: string | null
  is_key_customer: number
  visited_store: number
  owner_open_id: string | null
  owner_name: string | null
  lead_date: number
  feishu_record_id: string | null
  chat_id: string | null
  user_open_id: string | null
  original_message_id: string | null
  created_at: number
  updated_at: number
}

export interface NewLeadInput {
  customerName: string | null
  customerWechat: string | null
  customerNeeds: string | null
  customerNotes: string | null
  isKeyCustomer: boolean
  visitedStore: boolean
  ownerOpenId: string | null
  ownerName: string | null
  leadDate: number
  chatId: string
  userOpenId: string
  originalMessageId: string
}

/**
 * 插入一条客资。不做去重 -- 用户说“录就录”,重了手动删。
 * customer_name 直接写飞书表格「客户名称」列;customer_notes 仅存 SQLite,不同步表格
 * (备注要的话在飞书表格里自己写)。
 * @returns 新行的 id
 */
export function addLead(input: NewLeadInput): number {
  // DB 层兜底:customer_name 必须有值。LLM 层已 trim 校验,但万一有别的写入路径绕过,
  // 这里直接 throw,由上层(executeTool 的 try/catch)转成 {ok:false} 返回给 LLM。
  let name = input.customerName?.trim()
  if (!name) throw new Error('customer_name 不能为空')

  // DB 层兜底:LLM 偶尔不拆日期前缀(批量录入时尤甚),会把"60717/雅琴"整个塞进
  // customer_name,而 customer_name 是直接写飞书表格「客户名称」列的字段,不剥就会污染表格。
  // 这里剥掉开头的日期+分隔符,保留后面整段名字。
  // 复用 toolRegistry.stripDatePrefix(与去重比对同一份正则,单一事实源,避免两处不一致)
  const clean = stripDatePrefix(name)
  if (clean !== name) {
    console.log(`【客资姓名兜底】日期前缀剥离:"${name}" -> "${clean}"`)
    name = clean
  }

  const now = Date.now()
  return insertLead.run({
    customer_name: name,
    customer_wechat: input.customerWechat,
    customer_needs: input.customerNeeds,
    customer_notes: input.customerNotes?.trim() || null,
    is_key_customer: input.isKeyCustomer ? 1 : 0,
    visited_store: input.visitedStore ? 1 : 0,
    owner_open_id: input.ownerOpenId,
    owner_name: input.ownerName,
    lead_date: input.leadDate,
    chat_id: input.chatId,
    user_open_id: input.userOpenId,
    original_message_id: input.originalMessageId,
    created_at: now,
    updated_at: now,
  }).lastInsertRowid as number
}

/** 把飞书表格返回的 record_id 回写进 SQLite(双写关联) */
export function setLeadFeishuRecordId(id: number, feishuRecordId: string): void {
  setFeishuRecordId.run(feishuRecordId, Date.now(), id)
}

export interface QueryLeadsParams {
  chatId?: string
  limit: number
  offset: number
}

export function queryLeads({ chatId, limit, offset }: QueryLeadsParams): CustomerLeadRow[] {
  return (
    chatId
      ? listByChat.all(chatId, limit, offset)
      : listAll.all(limit, offset)
  ) as CustomerLeadRow[]
}

export function countLeads(chatId?: string): number {
  const row = (chatId ? countByChat.get(chatId) : countAll.get()) as { c: number } | undefined
  return row?.c ?? 0
}

export function getLeadById(id: number): CustomerLeadRow | null {
  return (byId.get(id) as CustomerLeadRow | undefined) ?? null
}

/** 按飞书 record_id 软删(反向同步用) */
export function softDeleteLeadByFeishuRecordId(feishuRecordId: string): number {
  return softDeleteByFeishuRecordId.run(Date.now(), feishuRecordId).changes
}

/** 按本地 id 软删 */
export function softDeleteLeadById(id: number): number {
  return softDelete.run(Date.now(), id).changes
}
