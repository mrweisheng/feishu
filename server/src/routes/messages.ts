import { Hono } from 'hono'
import { queryMessages, countMessages } from '../db/messages.js'

export const messagesRoute = new Hono()

// GET /api/messages?limit=50&offset=0&chat_id=xxx
messagesRoute.get('/', (c) => {
  // 双向夹紧:Math.min 只能封顶,负数 limit 会被 SQLite 当"无上限"(全表泄露),必须 Math.max 兜底 + 取整
  const limit = Math.max(1, Math.min(Math.trunc(Number(c.req.query('limit')) || 50), 200))
  const offset = Math.max(0, Math.min(Math.trunc(Number(c.req.query('offset')) || 0), 1_000_000))
  const chatId = c.req.query('chat_id') || undefined
  // 默认排除机器人消息(只看用户发言);传 include_bot=true 才返回机器人回复
  const includeBot = c.req.query('include_bot') === 'true'

  const items = queryMessages({ chatId, limit, offset, includeBot })
  const total = countMessages(includeBot)

  return c.json({ total, limit, offset, items })
})
