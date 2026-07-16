import {
  getDueReminders,
  getEarliestPendingReminder,
  markReminderSent,
  expireOverdueReminders,
  type DueReminder,
} from '../db/reminders.js'
import { replyMessage } from './messages.js'
import { generateReminderText, setOnReminderAdded } from '../llm.js'
import { getUserName } from './handler.js'
import { config } from '../config.js'

// 主调度精度:为「最近一条提醒」设动态 setTimeout,到点精确触发,中间零空转。
// 兜底轮询间隔:每 10 分钟慢扫一次,防止动态定时器因误差/新增提醒错过。
const BACKSTOP_INTERVAL_MS = 10 * 60 * 1000
// Node setTimeout 上限 ≈ 24.85 天(2^31 - 1 ms),超过会被静默 clamp 到 1ms,导致远期提醒被立即触发。
// 把动态定时器最长设为 24h,触发后再 scheduleNext 排下一条;10 分钟兜底轮询也覆盖这条路径。
const MAX_DYNAMIC_TIMER_MS = 24 * 60 * 60 * 1000

let dynamicTimer: NodeJS.Timeout | null = null

// 发送一条提醒:LLM 生成活泼文案 @用户,失败回退多样化模板。
// 迟到的提醒(重启补发等)自动补一句"迟到了X分钟",避免用户收到一句"时间到啦"却不知所云。
async function sendReminder(r: DueReminder): Promise<void> {
  const userName = await getUserName(r.user_open_id).catch(() => '你')
  const text = await generateReminderText(r.content, userName || '你')
  // 迟到判定:实际触发时间比预定晚超过 30s(留一点抖动余量,正常动态定时器精度内不算迟到)
  const lateMs = Date.now() - r.remind_at
  const lateSuffix = lateMs > 30_000 ? `(抱歉,这条提醒迟到了 ${Math.round(lateMs / 60000)} 分钟)` : ''
  const body = `<at user_id="${r.user_open_id}"></at> ${text}${lateSuffix ? ' ' + lateSuffix : ''}`
  await replyMessage(r.original_message_id, body)
  console.log('⏰ 已发送提醒 id=', r.id, '内容:', r.content, lateSuffix ? `(${lateSuffix})` : '')
}

// flushDue 互斥:动态定时器与 10min 兜底轮询可能重叠(单次发送窗口 2-6s),
// 不互斥会重复发送同一条 pending 提醒
let flushing = false
// 把所有「已到点」的 pending 提醒一次性发出去
async function flushDue(): Promise<void> {
  if (flushing) return // 已有进行中的 flush:跳过;被跳过的 due 仍是 pending,由 scheduleNext/backstop 补发
  flushing = true
  try {
    const due = getDueReminders(Date.now())
    await Promise.all(
      due.map(async (r: DueReminder) => {
        try {
          await sendReminder(r)
        } catch (err: any) {
          console.error('【提醒发送失败】id=', r.id, 'msg:', err.response?.data?.msg || err.message)
        } finally {
          // 无论成败都标记 sent:原消息被撤回等情况会永久失败,避免无限重试打扰
          markReminderSent(r.id)
        }
      }),
    )
  } finally {
    flushing = false
  }
}

/**
 * 动态调度:为最近一条 pending 提醒设一个精确 setTimeout。
 * - 没有 pending → 啥也不设,等下次 addReminder 或兜底轮询再排
 * - remind_at 已过去 → 立即触发
 * 否则按 (remind_at - now) 设时器;触发后 flushDue + 重排下一条
 */
function scheduleNext(): void {
  if (dynamicTimer) {
    clearTimeout(dynamicTimer)
    dynamicTimer = null
  }

  const earliest = getEarliestPendingReminder()
  if (!earliest) return // 无待发提醒,零空转

  const delay = Math.max(0, Math.min(earliest.remind_at - Date.now(), MAX_DYNAMIC_TIMER_MS))
  dynamicTimer = setTimeout(async () => {
    dynamicTimer = null
    try {
      await flushDue()
    } catch (err: any) {
      console.error('【提醒 flush 出错】', err.message)
    }
    // 处理完后重排下一条(若有)
    scheduleNext()
  }, delay)
}

// 兜底慢轮询:补动态定时器漏掉的情况(时钟漂移 / 新增提醒间未重排 / 进程刚恢复)
function startBackstop(): void {
  setInterval(async () => {
    try {
      await flushDue()
    } catch (err: any) {
      console.error('【兜底轮询 flush 出错】', err.message)
    }
    // 同时重排动态定时器,吸收新增的更早提醒
    scheduleNext()
  }, BACKSTOP_INTERVAL_MS)
}

/**
 * 启动提醒调度器(混合模式)。
 * - 启动时做重启补偿:过期但 < 补偿窗口(默认30min)的提醒立即补发;
 *   超过窗口的丢弃(避免服务挂半天后重启半夜轰炸用户)
 * - 动态 setTimeout 精确触发最近一条,中间零空转
 * - 每 10 分钟兜底慢扫一次,防漏
 */
export function startReminderScheduler(): void {
  const now = Date.now()
  // 重启补偿:只丢弃「过期超过补偿窗口」的;窗口内的留给紧接的 flushDue 补发
  const expireThreshold = now - config.REMINDER_RESEND_WINDOW_MS
  const dropped = expireOverdueReminders(expireThreshold)
  if (dropped > 0) {
    console.log(`⏰ 启动时丢弃过期提醒 ${dropped} 条(超过 ${Math.round(config.REMINDER_RESEND_WINDOW_MS / 60000)}min 未发)`)
  }

  // 启动即排最近一条:窗口内补发的过期提醒 + 已到点的都会被 flushDue 发出(各自有日志)
  flushDue().catch((e) => console.error('【启动 flush 出错】', e.message))
  scheduleNext()
  startBackstop()
  // 注册钩子:每次新增提醒后重排定时器(若有更早的需提前触发)
  setOnReminderAdded(scheduleNext)
  console.log('⏰ 提醒调度器已启动(动态定时器 + 10分钟兜底轮询,重启补偿窗口',
    Math.round(config.REMINDER_RESEND_WINDOW_MS / 60000) + 'min)')
}
