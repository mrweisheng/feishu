import { Hono } from 'hono'
import {
  listTransactions,
  countTransactions,
  totalsByProject,
  totalsByMonth,
  unsettledList,
  type TxnDirection,
  type SettlementStatus,
} from '../db/transactions.js'
import { listProjectNames } from '../db/projects.js'
import { listPaymentMethods } from '../db/paymentMethods.js'

export const statsRoute = new Hono()

// 最小单位(分/仙)→ 主单位数值,供前端直接展示
function major(minor: number | null | undefined): number {
  return (minor ?? 0) / 100
}

// GET /api/stats/transactions?direction=&project_id=&status=&from=&to=&limit=&offset=
statsRoute.get('/transactions', (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 500)
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0)
  const filters = {
    direction: (c.req.query('direction') as TxnDirection) || undefined,
    projectId: c.req.query('project_id') ? Number(c.req.query('project_id')) : undefined,
    status: (c.req.query('status') as SettlementStatus) || undefined,
    from: c.req.query('from') ? Number(c.req.query('from')) : undefined,
    to: c.req.query('to') ? Number(c.req.query('to')) : undefined,
    limit,
    offset,
  }
  const rows = listTransactions(filters)
  const items = rows.map((r) => ({ ...r, amount: major(r.amount_minor) }))
  const total = countTransactions(filters)
  return c.json({ total, limit, offset, items })
})

// GET /api/stats/by-project —— 按业务汇总(分币种,不跨币种换算)
statsRoute.get('/by-project', (c) => {
  const rows = totalsByProject()
  const items = rows.map((r) => ({
    project_id: r.project_id,
    project_name: r.project_name,
    income_hkd: major(r.income_hkd_minor),
    income_rmb: major(r.income_rmb_minor),
    expense_hkd: major(r.expense_hkd_minor),
    expense_rmb: major(r.expense_rmb_minor),
    net_hkd: major(r.income_hkd_minor) - major(r.expense_hkd_minor),
    net_rmb: major(r.income_rmb_minor) - major(r.expense_rmb_minor),
    count: r.count,
    last_at: r.last_at,
  }))
  return c.json({ items })
})

// GET /api/stats/monthly?year=2026 —— 按月汇总
statsRoute.get('/monthly', (c) => {
  const year = c.req.query('year') || undefined
  const rows = totalsByMonth(year)
  const items = rows.map((r) => ({
    month: r.month,
    income_hkd: major(r.income_hkd_minor),
    income_rmb: major(r.income_rmb_minor),
    expense_hkd: major(r.expense_hkd_minor),
    expense_rmb: major(r.expense_rmb_minor),
    count: r.count,
  }))
  return c.json({ items })
})

// GET /api/stats/unsettled —— 待结清清单
statsRoute.get('/unsettled', (c) => {
  const items = unsettledList().map((t) => ({ ...t, amount: major(t.amount_minor) }))
  return c.json({ items })
})

// GET /api/stats/projects —— 所有业务/客户
statsRoute.get('/projects', (c) => {
  return c.json({ items: listProjectNames() })
})

// GET /api/stats/methods —— 我方收款方式
statsRoute.get('/methods', (c) => {
  return c.json({ items: listPaymentMethods() })
})
