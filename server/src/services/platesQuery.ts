import { latestPlatesDate, listPlatesByDate } from '../db/plates.js'
import { buildPlatesAnswer, type PlateRecord } from './platesAnswer.js'

/**
 * 车牌问答入口:总是取「最近有数据的那一天」(今天有就用今天,没有就用昨天,以此类推),
 * 把该天的真实数据交给纯函数 buildPlatesAnswer 拼出答案。
 *
 * 只读本地 SQLite;不访问网络、不经过模型编造数据。
 */

export interface PlatesAnswer {
  ok: boolean
  /** 实际取数的日期(YYYY-MM-DD),无数据时不带 */
  date?: string
  /** 本地还没有任何现牌数据 */
  empty?: boolean
  /** 可直接回复的答案文本 */
  answer: string
}

export function answerPlatesQuestion(query: string): PlatesAnswer {
  const date = latestPlatesDate()
  if (!date) {
    return { ok: true, empty: true, answer: '目前还没有现牌数据(还没收到过现牌清单)。' }
  }
  const rows = listPlatesByDate(date) as unknown as PlateRecord[]
  return { ok: true, date, answer: buildPlatesAnswer(query ?? '', date, rows) }
}
