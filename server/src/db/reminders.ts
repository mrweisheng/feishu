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

/**
 * 把所有 remind_at < threshold 的 pending 提醒标记为 expired(丢弃),返回受影响条数。
 * threshold 是"丢弃分界线":重启补偿时传 (now - RESEND_WINDOW),
 * 早于分界线的丢弃(避免服务挂半天重启后补发轰炸),晚于的留给 flushDue 补发。
 */
export function expireOverdueReminders(threshold: number): number {
  return updateExpiredReminders.run(threshold).changes
}

// 取最近一条待发提醒的触发时间(动态定时器调度用),无 pending 返回 null
export function getEarliestPendingReminder(): { id: number; remind_at: number } | null {
  return (earliestPending.get() as { id: number; remind_at: number } | undefined) ?? null
}
