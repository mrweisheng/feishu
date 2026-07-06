import { db } from './index.js'

const insertReminder = db.prepare(`
INSERT INTO reminders (chat_id, user_open_id, content, remind_at, original_message_id, created_at, status)
VALUES (@chat_id, @user_open_id, @content, @remind_at, @original_message_id, @created_at, 'pending')
`)
const selectDueReminders = db.prepare(
  `SELECT * FROM reminders WHERE status='pending' AND remind_at <= ?`
)
const updateReminderSent = db.prepare(
  `UPDATE reminders SET status='sent' WHERE id = ?`
)
const updateExpiredReminders = db.prepare(
  `UPDATE reminders SET status='expired' WHERE status='pending' AND remind_at < ?`
)

// 最近一条待发提醒(动态 setTimeout 用):没有 pending 时返回 null
const earliestPending = db.prepare(
  `SELECT id, remind_at FROM reminders WHERE status='pending' ORDER BY remind_at ASC LIMIT 1`
)

// 渐进式批次提醒:一个批次最多3轮,每轮一条;到点动态聚合表格待办状态
const insertBatchReminder = db.prepare(`
INSERT INTO reminders (chat_id, user_open_id, content, remind_at, original_message_id, created_at, status, batch_id, round, todo_record_ids)
VALUES (@chat_id, @user_open_id, @content, @remind_at, @original_message_id, @created_at, 'pending', @batch_id, @round, @todo_record_ids)
`)
const cancelLaterRoundsStmt = db.prepare(
  `UPDATE reminders SET status='expired' WHERE batch_id=? AND round>? AND status='pending'`
)
const maxRoundStmt = db.prepare(
  `SELECT MAX(round) AS max_round FROM reminders WHERE batch_id=? AND status IN ('pending','sent')`
)

export interface NewReminderInput {
  chatId: string
  userOpenId: string
  content: string
  remindAt: number
  originalMessageId: string
}

export interface DueReminder {
  id: number
  chat_id: string
  user_open_id: string
  content: string
  remind_at: number
  original_message_id: string
  batch_id: string
  round: number
  todo_record_ids: string
}

export function addReminder(r: NewReminderInput): number {
  return insertReminder.run({
    chat_id: r.chatId,
    user_open_id: r.userOpenId,
    content: r.content,
    remind_at: r.remindAt,
    original_message_id: r.originalMessageId,
    created_at: Date.now(),
  }).lastInsertRowid as number
}

export function getDueReminders(now: number): DueReminder[] {
  return selectDueReminders.all(now) as DueReminder[]
}

export function markReminderSent(id: number): void {
  updateReminderSent.run(id)
}

// 把所有「到点未发」且 remind_at < now 的标记为过期,返回受影响条数
export function expireOverdueReminders(now: number): number {
  return updateExpiredReminders.run(now).changes
}

// 取最近一条待发提醒的触发时间(动态定时器调度用),无 pending 返回 null
export function getEarliestPendingReminder(): { id: number; remind_at: number } | null {
  return (earliestPending.get() as { id: number; remind_at: number } | undefined) ?? null
}

// ---- 渐进式批次提醒 ----

export interface BatchRoundInput {
  round: number
  remindAt: number
}

export interface AddBatchRemindersInput {
  batchId: string
  chatId: string
  userOpenId: string
  originalMessageId: string
  todoRecordIds: string[]
  rounds: BatchRoundInput[]
}

/** 插入一个渐进式批次的多轮提醒(事务)。content 留空,到点动态聚合表格待办。 */
export function addBatchReminders(input: AddBatchRemindersInput): void {
  const tx = db.transaction((rs: BatchRoundInput[]) => {
    const now = Date.now()
    const idsJson = JSON.stringify(input.todoRecordIds)
    for (const r of rs) {
      insertBatchReminder.run({
        chat_id: input.chatId,
        user_open_id: input.userOpenId,
        content: '',
        remind_at: r.remindAt,
        original_message_id: input.originalMessageId,
        created_at: now,
        batch_id: input.batchId,
        round: r.round,
        todo_record_ids: idsJson,
      })
    }
  })
  tx(input.rounds)
}

/** 全完成时取消同批次后续轮次(避免空跑到点还要查表格)。返回取消条数。 */
export function cancelLaterRounds(batchId: string, afterRound: number): number {
  return cancelLaterRoundsStmt.run(batchId, afterRound).changes
}

/** 取同批次最大轮次(到点那轮 round==max 即最后轮,消息加"最后提醒")。无记录返回0。 */
export function getBatchMaxRound(batchId: string): number {
  const row = maxRoundStmt.get(batchId) as { max_round: number | null } | undefined
  return row?.max_round ?? 0
}
