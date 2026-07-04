// 后台 API 封装(开发期经 vite proxy 走到 localhost:4111)

export interface MessageItem {
  message_id: string
  chat_id: string
  chat_type: string
  message_type: string
  sender_name: string | null
  content: string | null
  create_time: number | null
  source: string
}

export interface MessageList {
  total: number
  limit: number
  offset: number
  items: MessageItem[]
}

export async function fetchMessages(params: { limit?: number; offset?: number; chat_id?: string } = {}): Promise<MessageList> {
  const qs = new URLSearchParams()
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.offset) qs.set('offset', String(params.offset))
  if (params.chat_id) qs.set('chat_id', params.chat_id)
  const res = await fetch(`/api/messages?${qs.toString()}`)
  if (!res.ok) throw new Error(`拉取消息失败: ${res.status}`)
  return res.json()
}

// ---- 收支统计 ----

export interface ProjectTotal {
  project_id: number
  project_name: string
  income_hkd: number
  income_rmb: number
  expense_hkd: number
  expense_rmb: number
  net_hkd: number
  net_rmb: number
  count: number
  last_at: number | null
}

export interface MonthlyTotal {
  month: string
  income_hkd: number
  income_rmb: number
  expense_hkd: number
  expense_rmb: number
  count: number
}

export interface TransactionItem {
  id: number
  direction: 'income' | 'expense'
  kind: string
  occurred_at: number
  occurred_month: string
  our_account: string | null
  counterparty_name: string | null
  counterparty_account: string | null
  amount_minor: number
  currency: string
  amount_raw: string
  settlement_status: 'settled' | 'pending'
  settlement_note: string
  project_id: number
  project_name_raw: string
  transfer_type: string
  note: string
  created_at: number
  amount: number
  project_name?: string | null
}

export async function fetchByProject(): Promise<{ items: ProjectTotal[] }> {
  const res = await fetch('/api/stats/by-project')
  if (!res.ok) throw new Error(`拉取业务汇总失败: ${res.status}`)
  return res.json()
}

export async function fetchMonthly(year?: string): Promise<{ items: MonthlyTotal[] }> {
  const qs = new URLSearchParams()
  if (year) qs.set('year', year)
  const res = await fetch(`/api/stats/monthly?${qs.toString()}`)
  if (!res.ok) throw new Error(`拉取月度汇总失败: ${res.status}`)
  return res.json()
}

export async function fetchUnsettled(): Promise<{ items: TransactionItem[] }> {
  const res = await fetch('/api/stats/unsettled')
  if (!res.ok) throw new Error(`拉取待结清单失败: ${res.status}`)
  return res.json()
}

export async function fetchTransactions(
  params: { direction?: string; status?: string; limit?: number; offset?: number } = {}
): Promise<{ total: number; items: TransactionItem[] }> {
  const qs = new URLSearchParams()
  if (params.direction) qs.set('direction', params.direction)
  if (params.status) qs.set('status', params.status)
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.offset) qs.set('offset', String(params.offset))
  const res = await fetch(`/api/stats/transactions?${qs.toString()}`)
  if (!res.ok) throw new Error(`拉取流水失败: ${res.status}`)
  return res.json()
}
