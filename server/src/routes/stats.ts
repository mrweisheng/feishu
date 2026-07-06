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
  const limit = Math.max(1, Math.min(Math.trunc(Number(c.req.query('limit')) || 50), 500))
  const offset = Math.max(0, Math.min(Math.trunc(Number(c.req.query('offset')) || 0), 1_000_000))
  // direction/status 白名单校验(非法值不再静默返空集)
  const direction = c.req.query('direction')
  const status = c.req.query('status')
  if (direction !== undefined && direction !== 'income' && direction !== 'expense') {
    return c.json({ error: 'direction 只能是 income 或 expense' }, 400)
  }
  if (status !== undefined && status !== 'settled' && status !== 'pending') {
    return c.json({ error: 'status 只能是 settled 或 pending' }, 400)
  }
  // 数字参数校验:非数字不再静默返空集(极难排查),直接 400
  const projectId = c.req.query('project_id') !== undefined ? Number(c.req.query('project_id')) : undefined
  const from = c.req.query('from') !== undefined ? Number(c.req.query('from')) : undefined
  const to = c.req.query('to') !== undefined ? Number(c.req.query('to')) : undefined
  if ([projectId, from, to].some((v) => v !== undefined && !Number.isFinite(v as number))) {
    return c.json({ error: 'project_id / from / to 必须是数字' }, 400)
  }

  const filters = {
    direction: (direction as TxnDirection) || undefined,
    projectId,
    status: (status as SettlementStatus) || undefined,
    from,
    to,
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
    // 整数相减再单次 /100,避免两次 /100 浮点相减的尾差
    net_hkd: (r.income_hkd_minor - r.expense_hkd_minor) / 100,
    net_rmb: (r.income_rmb_minor - r.expense_rmb_minor) / 100,
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
