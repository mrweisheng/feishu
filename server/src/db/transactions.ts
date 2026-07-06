import { db } from './index.js'

export type TxnDirection = 'income' | 'expense'
export type SettlementStatus = 'settled' | 'pending'

export interface NewTransactionInput {
  direction: TxnDirection
  kind: string
  occurredAt: number // 毫秒
  occurredMonth: string // 'YYYY-MM'
  ourAccount: string | null // income: payment_methods.key
  counterpartyName: string | null // income: 客户名
  counterpartyAccount: string | null // expense: 对方账户详情(自由文本)
  counterpartyAccountType: string // expense: 对方账户类型(现金/支付宝/微信/银行卡)
  amountMinor: number // 最小单位(分/仙)
  currency: string // HKD | RMB
  amountRaw: string
  settlementStatus: SettlementStatus
  settlementNote: string
  projectId: number
  projectNameRaw: string
  transferType: string
  note: string
  chatId: string
  userOpenId: string
  originalMessageId: string
  voucherImageKeys: string   // 凭证图 image_key 数组的 JSON 字符串(事实源)
  voucherFileTokens: string  // 凭证上传多维表格后的 file_token 数组的 JSON 字符串(缓存)
}

export interface TransactionRow {
  id: number
  direction: TxnDirection
  kind: string
  occurred_at: number
  occurred_month: string
  our_account: string | null
  counterparty_name: string | null
  counterparty_account: string | null
  counterparty_account_type: string
  amount_minor: number
  currency: string
  amount_raw: string
  settlement_status: SettlementStatus
  settlement_note: string
  project_id: number
  project_name_raw: string
  transfer_type: string
  note: string
  chat_id: string
  user_open_id: string
  original_message_id: string
  feishu_record_id: string
  voucher_image_keys: string
  voucher_file_tokens: string
  is_deleted: number
  created_at: number
  updated_at: number
}

// 凭证图片标识数组 ↔ JSON 字符串互转(库内存 TEXT;空/坏 JSON 一律视为空数组,防御老数据)
export function packImages(keys: string[]): string {
  return keys && keys.length ? JSON.stringify(keys) : ''
}
export function unpackImages(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : []
  } catch {
    return []
  }
}

// ---- 写入 ----
const insertTxn = db.prepare(`
INSERT INTO transactions (
  direction, kind, occurred_at, occurred_month,
  our_account, counterparty_name, counterparty_account, counterparty_account_type,
  amount_minor, currency, amount_raw,
  settlement_status, settlement_note,
  project_id, project_name_raw, transfer_type, note,
  chat_id, user_open_id, original_message_id,
  voucher_image_keys, voucher_file_tokens,
  created_at, updated_at
) VALUES (
  @direction, @kind, @occurred_at, @occurred_month,
  @our_account, @counterparty_name, @counterparty_account, @counterparty_account_type,
  @amount_minor, @currency, @amount_raw,
  @settlement_status, @settlement_note,
  @project_id, @project_name_raw, @transfer_type, @note,
  @chat_id, @user_open_id, @original_message_id,
  @voucher_image_keys, @voucher_file_tokens,
  @created_at, @updated_at
)
`)

export function addTransaction(t: NewTransactionInput): number {
  const now = Date.now()
  return insertTxn.run({
    direction: t.direction,
    kind: t.kind,
    occurred_at: t.occurredAt,
    occurred_month: t.occurredMonth,
    our_account: t.ourAccount,
    counterparty_name: t.counterpartyName,
    counterparty_account: t.counterpartyAccount,
    counterparty_account_type: t.counterpartyAccountType,
    amount_minor: t.amountMinor,
    currency: t.currency,
    amount_raw: t.amountRaw,
    settlement_status: t.settlementStatus,
    settlement_note: t.settlementNote,
    project_id: t.projectId,
    project_name_raw: t.projectNameRaw,
    transfer_type: t.transferType,
    note: t.note,
    chat_id: t.chatId,
    user_open_id: t.userOpenId,
    original_message_id: t.originalMessageId,
    voucher_image_keys: t.voucherImageKeys,
    voucher_file_tokens: t.voucherFileTokens,
    created_at: now,
    updated_at: now,
  }).lastInsertRowid as number
}

// ---- 纠正(动态 patch,字段名走白名单,不接受用户控制的列名) ----
export interface TransactionPatch {
  direction?: TxnDirection
  isDeleted?: number
  kind?: string
  amountMinor?: number
  currency?: string
  amountRaw?: string
  settlementStatus?: SettlementStatus
  settlementNote?: string
  transferType?: string
  note?: string
  projectId?: number
  projectNameRaw?: string
  ourAccount?: string | null
  counterpartyName?: string | null
  counterpartyAccount?: string | null
  counterpartyAccountType?: string
  feishuRecordId?: string
  occurredAt?: number
  occurredMonth?: string
  voucherImageKeys?: string
  voucherFileTokens?: string
}

const PATCH_COL: Record<keyof TransactionPatch, string> = {
  direction: 'direction',
  isDeleted: 'is_deleted',
  kind: 'kind',
  amountMinor: 'amount_minor',
  currency: 'currency',
  amountRaw: 'amount_raw',
  settlementStatus: 'settlement_status',
  settlementNote: 'settlement_note',
  transferType: 'transfer_type',
  note: 'note',
  projectId: 'project_id',
  projectNameRaw: 'project_name_raw',
  ourAccount: 'our_account',
  counterpartyName: 'counterparty_name',
  counterpartyAccount: 'counterparty_account',
  counterpartyAccountType: 'counterparty_account_type',
  feishuRecordId: 'feishu_record_id',
  occurredAt: 'occurred_at',
  occurredMonth: 'occurred_month',
  voucherImageKeys: 'voucher_image_keys',
  voucherFileTokens: 'voucher_file_tokens',
}

export function updateTransaction(id: number, patch: TransactionPatch): boolean {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  for (const key of Object.keys(patch) as (keyof TransactionPatch)[]) {
    if (patch[key] === undefined) continue
    sets.push(`${PATCH_COL[key]} = @${key}`)
    params[key] = patch[key]
  }
  if (!sets.length) return false
  sets.push('updated_at = @updated_at')
  params.updated_at = Date.now()
  const stmt = db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = @id`)
  return stmt.run(params).changes > 0
}

// ---- 单条查询 ----
const byId = db.prepare(`SELECT * FROM transactions WHERE id = ?`)
export function getTransaction(id: number): TransactionRow | null {
  return (byId.get(id) as TransactionRow | undefined) ?? null
}

const latestByUser = db.prepare(
  `SELECT * FROM transactions WHERE user_open_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1`
)
export function getLatestByUser(openId: string): TransactionRow | null {
  return (latestByUser.get(openId) as TransactionRow | undefined) ?? null
}

// ---- 去重查询(防重复录入) ----

// 第①层:按"源消息 id"精确去重。补录同一条被回复消息时命中(不受日期影响)。
const byOriginalMsgId = db.prepare(
  `SELECT id FROM transactions WHERE original_message_id = ? AND is_deleted = 0 LIMIT 1`
)
export function findIdByOriginalMessageId(messageId: string): number | null {
  const row = byOriginalMsgId.get(messageId) as { id: number } | undefined
  return row?.id ?? null
}

// 第②层:语义签名去重。重发 / 字段换序 / 改写,只要解析后核心字段相同就视为同一笔。
// 收入多比一项 our_account;转出暂不带对方账户信息(按需要再加)。
export interface DupSignature {
  direction: TxnDirection
  currency: string
  amountMinor: number
  counterpartyName: string | null
  kind: string
  projectId: number
  occurredAt: number
  ourAccount: string | null
}
const dupBySigIncome = db.prepare(
  `SELECT id FROM transactions
   WHERE is_deleted = 0 AND direction = ? AND currency = ? AND amount_minor = ?
     AND IFNULL(counterparty_name, '') = ? AND kind = ? AND project_id = ? AND occurred_at = ?
     AND our_account = ?
   LIMIT 1`
)
const dupBySigExpense = db.prepare(
  `SELECT id FROM transactions
   WHERE is_deleted = 0 AND direction = ? AND currency = ? AND amount_minor = ?
     AND IFNULL(counterparty_name, '') = ? AND kind = ? AND project_id = ? AND occurred_at = ?
   LIMIT 1`
)
export function findDuplicateBySignature(sig: DupSignature): number | null {
  const cp = (sig.counterpartyName ?? '').trim()
  const kind = (sig.kind ?? '').trim()
  const row = (sig.direction === 'income'
    ? dupBySigIncome.get(sig.direction, sig.currency, sig.amountMinor, cp, kind, sig.projectId, sig.occurredAt, sig.ourAccount ?? '')
    : dupBySigExpense.get(sig.direction, sig.currency, sig.amountMinor, cp, kind, sig.projectId, sig.occurredAt)
  ) as { id: number } | undefined
  return row?.id ?? null
}

// ---- 列表(动态过滤) ----
export interface ListTxnFilters {
  direction?: TxnDirection
  counterparty?: string // 收款对象/转出对象,COLLATE NOCASE 精确匹配
  projectId?: number
  status?: SettlementStatus
  currency?: string // HKD | RMB
  from?: number // occurred_at >=
  to?: number // occurred_at <=
  limit: number
  offset: number
}

type CountFilters = Omit<ListTxnFilters, 'limit' | 'offset'>

function applyFilters(f: {
  direction?: string
  counterparty?: string
  projectId?: number
  status?: string
  currency?: string
  from?: number
  to?: number
}) {
  const where: string[] = ['is_deleted = 0']
  const params: unknown[] = []
  if (f.direction) {
    where.push('direction = ?')
    params.push(f.direction)
  }
  if (f.counterparty) {
    where.push('counterparty_name = ? COLLATE NOCASE')
    params.push(f.counterparty)
  }
  if (f.projectId !== undefined) {
    where.push('project_id = ?')
    params.push(f.projectId)
  }
  if (f.status) {
    where.push('settlement_status = ?')
    params.push(f.status)
  }
  if (f.currency) {
    where.push('currency = ?')
    params.push(f.currency)
  }
  if (f.from !== undefined) {
    where.push('occurred_at >= ?')
    params.push(f.from)
  }
  if (f.to !== undefined) {
    where.push('occurred_at <= ?')
    params.push(f.to)
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params }
}

export function listTransactions(f: ListTxnFilters): TransactionRow[] {
  const { clause, params } = applyFilters(f)
  const sql = `SELECT * FROM transactions ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`
  return db.prepare(sql).all(...params, f.limit, f.offset) as TransactionRow[]
}

export function countTransactions(f: CountFilters): number {
  const { clause, params } = applyFilters(f)
  const sql = `SELECT COUNT(*) AS c FROM transactions ${clause}`
  return (db.prepare(sql).get(...params) as { c: number }).c
}

// ---- 聚合统计 ----
export interface ProjectTotalRow {
  project_id: number
  project_name: string
  income_hkd_minor: number
  income_rmb_minor: number
  expense_hkd_minor: number
  expense_rmb_minor: number
  count: number
  last_at: number | null
}

const byProjectStmt = db.prepare(`
SELECT p.id AS project_id, p.name AS project_name,
  SUM(CASE WHEN t.direction='income'  AND t.currency='HKD' THEN t.amount_minor ELSE 0 END) AS income_hkd_minor,
  SUM(CASE WHEN t.direction='income'  AND t.currency='RMB' THEN t.amount_minor ELSE 0 END) AS income_rmb_minor,
  SUM(CASE WHEN t.direction='expense' AND t.currency='HKD' THEN t.amount_minor ELSE 0 END) AS expense_hkd_minor,
  SUM(CASE WHEN t.direction='expense' AND t.currency='RMB' THEN t.amount_minor ELSE 0 END) AS expense_rmb_minor,
  COUNT(t.id) AS count,
  MAX(t.occurred_at) AS last_at
FROM projects p
LEFT JOIN transactions t ON t.project_id = p.id AND t.is_deleted = 0
GROUP BY p.id, p.name
ORDER BY (MAX(t.occurred_at) IS NULL), MAX(t.occurred_at) DESC
`)
export function totalsByProject(): ProjectTotalRow[] {
  return byProjectStmt.all() as ProjectTotalRow[]
}

export interface MonthlyTotalRow {
  month: string
  income_hkd_minor: number
  income_rmb_minor: number
  expense_hkd_minor: number
  expense_rmb_minor: number
  count: number
}

const byMonthAll = db.prepare(`
SELECT occurred_month AS month,
  SUM(CASE WHEN direction='income'  AND currency='HKD' THEN amount_minor ELSE 0 END) AS income_hkd_minor,
  SUM(CASE WHEN direction='income'  AND currency='RMB' THEN amount_minor ELSE 0 END) AS income_rmb_minor,
  SUM(CASE WHEN direction='expense' AND currency='HKD' THEN amount_minor ELSE 0 END) AS expense_hkd_minor,
  SUM(CASE WHEN direction='expense' AND currency='RMB' THEN amount_minor ELSE 0 END) AS expense_rmb_minor,
  COUNT(*) AS count
FROM transactions WHERE is_deleted = 0 GROUP BY occurred_month ORDER BY occurred_month DESC
`)
const byMonthYear = db.prepare(`
SELECT occurred_month AS month,
  SUM(CASE WHEN direction='income'  AND currency='HKD' THEN amount_minor ELSE 0 END) AS income_hkd_minor,
  SUM(CASE WHEN direction='income'  AND currency='RMB' THEN amount_minor ELSE 0 END) AS income_rmb_minor,
  SUM(CASE WHEN direction='expense' AND currency='HKD' THEN amount_minor ELSE 0 END) AS expense_hkd_minor,
  SUM(CASE WHEN direction='expense' AND currency='RMB' THEN amount_minor ELSE 0 END) AS expense_rmb_minor,
  COUNT(*) AS count
FROM transactions WHERE occurred_month LIKE ? AND is_deleted = 0 GROUP BY occurred_month ORDER BY occurred_month DESC
`)
export function totalsByMonth(year?: string): MonthlyTotalRow[] {
  if (year) return byMonthYear.all(`${year}-%`) as MonthlyTotalRow[]
  return byMonthAll.all() as MonthlyTotalRow[]
}

export interface UnsettledRow extends TransactionRow {
  project_name: string | null
}
const unsettledStmt = db.prepare(`
SELECT t.*, p.name AS project_name FROM transactions t
LEFT JOIN projects p ON p.id = t.project_id
WHERE t.settlement_status = 'pending' AND t.is_deleted = 0
ORDER BY t.occurred_at DESC
`)
export function unsettledList(): UnsettledRow[] {
  return unsettledStmt.all() as UnsettledRow[]
}

// ---- 按方向汇总(给录入后回复用:总笔数 + 各币种合计,主单位) ----
export interface DirectionSummary {
  count: number
  totals: Record<string, number> // currency -> 主单位金额(只含有记录的币种)
}
const summaryByDirStmt = db.prepare(`
SELECT currency, SUM(amount_minor) AS s, COUNT(*) AS c
FROM transactions WHERE direction = ? AND is_deleted = 0 GROUP BY currency
`)
export function summaryByDirection(direction: TxnDirection): DirectionSummary {
  const rows = summaryByDirStmt.all(direction) as { currency: string; s: number | null; c: number }[]
  const totals: Record<string, number> = {}
  let count = 0
  for (const r of rows) {
    if (r.c > 0) {
      totals[r.currency] = (r.s ?? 0) / 100
      count += r.c
    }
  }
  return { count, totals }
}

// ---- 查询聚合(机器人问答用:按 客户/业务/方向/状态/币种/日期 过滤;HKD/RMB 分开,不跨币种换算) ----

export interface FinanceFilters {
  direction?: TxnDirection
  counterparty?: string // 收款对象/转出对象,COLLATE NOCASE 精确匹配(用 listCustomers 拿准确名)
  projectId?: number
  status?: SettlementStatus
  currency?: string // HKD | RMB
  from?: number // occurred_at >=
  to?: number // occurred_at <=
}

export interface FinanceSummary {
  count: number
  income: { HKD: number; RMB: number } // 主单位
  expense: { HKD: number; RMB: number } // 主单位
}

/** 按条件聚合:笔数 + 收/支各币种合计(主单位)。港币/人民币分开,绝不相加或换算。 */
export function financeSummary(f: FinanceFilters = {}): FinanceSummary {
  const { clause, params } = applyFilters(f)
  const rows = db
    .prepare(
      `SELECT direction, currency, SUM(amount_minor) AS s, COUNT(*) AS c
       FROM transactions ${clause}
       GROUP BY direction, currency`
    )
    .all(...params) as { direction: TxnDirection; currency: string; s: number | null; c: number }[]
  const out: FinanceSummary = { count: 0, income: { HKD: 0, RMB: 0 }, expense: { HKD: 0, RMB: 0 } }
  for (const r of rows) {
    out.count += r.c
    if (r.currency === 'HKD' || r.currency === 'RMB') {
      out[r.direction][r.currency] += (r.s ?? 0) / 100
    }
  }
  return out
}

export interface CustomerRow {
  name: string
  count: number
  group_count: number // 不重复业务数
  income_hkd: number
  income_rmb: number
  expense_hkd: number
  expense_rmb: number
}

/** 列出所有客户(收款对象/转出对象去重)+ 各自笔数/业务数/收支合计(主单位)。给 LLM 对齐名字用。 */
export function listCustomers(): CustomerRow[] {
  const raw = db
    .prepare(
      `SELECT counterparty_name AS name,
        SUM(CASE WHEN direction='income'  AND currency='HKD' THEN amount_minor ELSE 0 END) AS income_hkd_minor,
        SUM(CASE WHEN direction='income'  AND currency='RMB' THEN amount_minor ELSE 0 END) AS income_rmb_minor,
        SUM(CASE WHEN direction='expense' AND currency='HKD' THEN amount_minor ELSE 0 END) AS expense_hkd_minor,
        SUM(CASE WHEN direction='expense' AND currency='RMB' THEN amount_minor ELSE 0 END) AS expense_rmb_minor,
        COUNT(*) AS count,
        COUNT(DISTINCT project_id) AS group_count
       FROM transactions
       WHERE is_deleted = 0 AND counterparty_name IS NOT NULL AND counterparty_name != ''
       GROUP BY counterparty_name
       ORDER BY counterparty_name COLLATE NOCASE`
    )
    .all() as Array<{
      name: string
      count: number
      group_count: number
      income_hkd_minor: number
      income_rmb_minor: number
      expense_hkd_minor: number
      expense_rmb_minor: number
    }>
  return raw.map((r) => ({
    name: r.name,
    count: r.count,
    group_count: r.group_count,
    income_hkd: r.income_hkd_minor / 100,
    income_rmb: r.income_rmb_minor / 100,
    expense_hkd: r.expense_hkd_minor / 100,
    expense_rmb: r.expense_rmb_minor / 100,
  }))
}

export interface CustomerGroupRow {
  project_id: number
  project_name: string
  count: number
  income_hkd: number
  income_rmb: number
  expense_hkd: number
  expense_rmb: number
  net_hkd: number
  net_rmb: number
  last_at: number | null
}

export interface CustomerGroupsResult {
  customer: string
  matched: boolean
  group_count: number
  projects: CustomerGroupRow[]
  totals: FinanceSummary
}

/**
 * 某客户的业务(群)清单:按 counterparty_name 匹配(COLLATE NOCASE),聚合到每个 project。
 * 「多个群 = 多个业务」即 group_count。matched=false 表示没找到该客户(调用方提示名字不对)。
 */
export function customerGroups(name: string): CustomerGroupsResult {
  const raw = db
    .prepare(
      `SELECT p.id AS project_id, p.name AS project_name,
        SUM(CASE WHEN t.direction='income'  AND t.currency='HKD' THEN t.amount_minor ELSE 0 END) AS income_hkd_minor,
        SUM(CASE WHEN t.direction='income'  AND t.currency='RMB' THEN t.amount_minor ELSE 0 END) AS income_rmb_minor,
        SUM(CASE WHEN t.direction='expense' AND t.currency='HKD' THEN t.amount_minor ELSE 0 END) AS expense_hkd_minor,
        SUM(CASE WHEN t.direction='expense' AND t.currency='RMB' THEN t.amount_minor ELSE 0 END) AS expense_rmb_minor,
        COUNT(t.id) AS count,
        MAX(t.occurred_at) AS last_at
       FROM transactions t
       JOIN projects p ON p.id = t.project_id
       WHERE t.is_deleted = 0 AND t.counterparty_name = ? COLLATE NOCASE
       GROUP BY p.id, p.name
       ORDER BY MAX(t.occurred_at) DESC`
    )
    .all(name) as Array<{
      project_id: number
      project_name: string
      count: number
      income_hkd_minor: number
      income_rmb_minor: number
      expense_hkd_minor: number
      expense_rmb_minor: number
      last_at: number | null
    }>
  const projects: CustomerGroupRow[] = raw.map((r) => {
    const income_hkd = r.income_hkd_minor / 100
    const income_rmb = r.income_rmb_minor / 100
    const expense_hkd = r.expense_hkd_minor / 100
    const expense_rmb = r.expense_rmb_minor / 100
    return {
      project_id: r.project_id,
      project_name: r.project_name,
      count: r.count,
      income_hkd,
      income_rmb,
      expense_hkd,
      expense_rmb,
      net_hkd: income_hkd - expense_hkd,
      net_rmb: income_rmb - expense_rmb,
      last_at: r.last_at,
    }
  })
  const totals: FinanceSummary = {
    count: projects.reduce((s, p) => s + p.count, 0),
    income: {
      HKD: projects.reduce((s, p) => s + p.income_hkd, 0),
      RMB: projects.reduce((s, p) => s + p.income_rmb, 0),
    },
    expense: {
      HKD: projects.reduce((s, p) => s + p.expense_hkd, 0),
      RMB: projects.reduce((s, p) => s + p.expense_rmb, 0),
    },
  }
  return { customer: name, matched: projects.length > 0, group_count: projects.length, projects, totals }
}

// ---- 反向同步(多维表格 → SQLite)----
const byFeishuRecordId = db.prepare(`SELECT * FROM transactions WHERE feishu_record_id = ?`)
export function getTxnByFeishuRecordId(recordId: string): TransactionRow | null {
  return (byFeishuRecordId.get(recordId) as TransactionRow | undefined) ?? null
}

const softDeleteStmt = db.prepare(
  `UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE feishu_record_id = ? AND is_deleted = 0`
)
/** 表格里删除一行 → SQLite 软删(置 is_deleted=1,留档溯源,统计/列表已排除)。返回是否命中。 */
export function softDeleteByFeishuRecordId(recordId: string): boolean {
  return softDeleteStmt.run(Date.now(), recordId).changes > 0
}

// 回环兜底:机器人刚正向写入、还没回写 feishu_record_id 的行(60s 窗口)。
// 防止「POST 建记录 → 事件先到 → 查不到 feishu_record_id → 误当成表格手填再插一条」的竞态。
const recentEchoStmt = db.prepare(`
SELECT * FROM transactions
WHERE is_deleted = 0 AND feishu_record_id = ''
  AND direction = ? AND amount_minor = ? AND currency = ? AND occurred_at = ?
  AND created_at >= ?
ORDER BY created_at DESC LIMIT 1`)
export function findRecentEcho(rev: {
  direction: TxnDirection; amountMinor: number; currency: string; occurredAt: number
}): TransactionRow | null {
  return (
    (recentEchoStmt.get(rev.direction, rev.amountMinor, rev.currency, rev.occurredAt, Date.now() - 60000) as
      | TransactionRow
      | undefined) ?? null
  )
}
