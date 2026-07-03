import { Hono } from 'hono'
import { queryMessages, countMessages } from '../db/messages.js'

export const messagesRoute = new Hono()

// GET /api/messages?limit=50&offset=0&chat_id=xxx
messagesRoute.get('/', (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  const chatId = c.req.query('chat_id') || undefined

  const items = queryMessages({ chatId, limit, offset })
  const total = countMessages()

  return c.json({ total, limit, offset, items })
})
