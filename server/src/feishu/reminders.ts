import {
  getDueReminders,
  getEarliestPendingReminder,
  markReminderSent,
  expireOverdueReminders,
  cancelLaterRounds,
  getBatchMaxRound,
  type DueReminder,
} from '../db/reminders.js'
import { replyMessage } from './messages.js'
import { generateReminderText, setOnReminderAdded } from '../llm.js'
import { getUserName } from './handler.js'
import { getTodoRecords } from './bitable-todo.js'

// 主调度精度:为「最近一条提醒」设动态 setTimeout,到点精确触发,中间零空转。
// 兜底轮询间隔:每 10 分钟慢扫一次,防止动态定时器因误差/新增提醒错过。
const BACKSTOP_INTERVAL_MS = 10 * 60 * 1000

let dynamicTimer: NodeJS.Timeout | null = null

// 发送一条提醒:LLM 生成活泼文案 @用户,失败回退多样化模板
async function sendReminder(r: {
  id: number
  user_open_id: string
  content: string
  original_message_id: string
}): Promise<void> {
  const userName = await getUserName(r.user_open_id).catch(() => '你')
  const text = await generateReminderText(r.content, userName || '你')
  const body = `<at user_id="${r.user_open_id}"></at> ${text}`
  await replyMessage(r.original_message_id, body)
  console.log('⏰ 已发送提醒 id=', r.id, '内容:', r.content)
}

// 渐进式批次提醒:到点读表格状态,把仍"待处理"的待办合并成一条消息列出(不 @十几次)
async function sendBatchReminder(r: DueReminder): Promise<void> {
  let recordIds: string[] = []
  try {
    recordIds = JSON.parse(r.todo_record_ids || '[]')
  } catch {
    recordIds = []
  }
  const records = await getTodoRecords(recordIds)
  if (records.length === 0) {
    // 读取全部失败(网络/权限):放弃本轮,不取消后续(下一轮还会再试)
    console.warn(`📋 批次 ${r.batch_id} round=${r.round} 读取表格全部失败,放弃本轮`)
    return
  }
  const pending = records.filter((x) => x.status === '待处理')
  if (pending.length === 0) {
    // 全完成/取消:不发,取消后续轮次(避免空跑)
    const cancelled = cancelLaterRounds(r.batch_id, r.round)
    console.log(`📋 批次 ${r.batch_id} round=${r.round} 全完成,取消后续 ${cancelled} 轮`)
    return
  }
  const userName = (await getUserName(r.user_open_id).catch(() => '')) || '你'
  const maxRound = getBatchMaxRound(r.batch_id)
  const isLast = r.round >= maxRound
  const list = pending.map((x, i) => `${i + 1}. ${x.content}`).join('\n')
  const head = isLast
    ? `⏰ ${userName},最后提醒!你还有 ${pending.length} 件待办:\n`
    : `📋 ${userName},你还有 ${pending.length} 件待办:\n`
  await replyMessage(r.original_message_id, `<at user_id="${r.user_open_id}"></at> ${head}${list}`)
  console.log(`📋 已发送批次提醒 id=${r.id} batch=${r.batch_id} round=${r.round} 待办=${pending.length} 最后轮=${isLast}`)
}

// 把所有「已到点」的 pending 提醒一次性发出去
async function flushDue(): Promise<void> {
  const due = getDueReminders(Date.now())
  await Promise.all(
    due.map(async (r) => {
      try {
        if (r.batch_id) {
          await sendBatchReminder(r)
        } else {
          await sendReminder(r)
        }
      } catch (err: any) {
        console.error('【提醒发送失败】id=', r.id, 'msg:', err.response?.data?.msg || err.message)
      } finally {
        // 无论成败都标记 sent:原消息被撤回/表格读取失败等情况会永久失败,避免无限重试打扰
        markReminderSent(r.id)
      }
    }),
  )
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

  const delay = Math.max(0, earliest.remind_at - Date.now())
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
 * - 启动时把过期的待发提醒标记为 expired(直接丢弃,不补发)
 * - 动态 setTimeout 精确触发最近一条,中间零空转
 * - 每 10 分钟兜底慢扫一次,防漏
 */
export function startReminderScheduler(): void {
  const dropped = expireOverdueReminders(Date.now())
  if (dropped > 0) console.log(`⏰ 启动时丢弃过期提醒 ${dropped} 条`)

  // 启动即排最近一条(若有到点的立刻发)
  flushDue().catch((e) => console.error('【启动 flush 出错】', e.message))
  scheduleNext()
  startBackstop()
  // 注册钩子:每次新增提醒后重排定时器(若有更早的需提前触发)
  setOnReminderAdded(scheduleNext)
  console.log('⏰ 提醒调度器已启动(动态定时器 + 10分钟兜底轮询)')
}
