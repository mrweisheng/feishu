import { Hono } from 'hono'
import { queryLeads, countLeads } from '../db/customerLeads.js'

export const customerLeadsRoute = new Hono()

// GET /api/customer-leads?limit=50&offset=0&chat_id=xxx
customerLeadsRoute.get('/', (c) => {
  const limit = Math.max(1, Math.min(Math.trunc(Number(c.req.query('limit')) || 50), 200))
  const offset = Math.max(0, Math.min(Math.trunc(Number(c.req.query('offset')) || 0), 1_000_000))
  const chatId = c.req.query('chat_id') || undefined

  const items = queryLeads({ chatId, limit, offset })
  const total = countLeads(chatId)

  return c.json({ total, limit, offset, items })
})
