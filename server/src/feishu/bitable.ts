import path from 'node:path'
import fs from 'node:fs'
import type { Readable } from 'node:stream'
import { apiClient } from './client.js'
import { config } from '../config.js'
import {
  type TransactionRow,
  type TxnDirection,
  type SettlementStatus,
  type NewTransactionInput,
  addTransaction,
  updateTransaction,
  getTxnByFeishuRecordId,
  softDeleteByFeishuRecordId,
  findRecentEcho,
  packImages,
  unpackImages,
} from '../db/transactions.js'
import { PAYMENT_METHODS } from '../db/paymentMethods.js'
import { resolveProject, getProjectName } from '../db/projects.js'

// 双写是否启用(未配 app_token/table_id 则跳过,只入 SQLite)
const ENABLED = !!(config.BITABLE_APP_TOKEN && config.BITABLE_TABLE_ID)

// ---- 字段名(必须与多维表格表头逐字一致,含全角括号) ----
const F = {
  type: '记录类型',
  date: '日期',
  account: '收款账户',
  counterparty: '收款对象',
  currency: '币种',
  amount: '金额',
  settle: '结算状态',
  settleNote: '结算备注',
  project: '对应业务（群名称）',
  expenseType: '转出账户类型',
  expenseDetail: '转出账户详情',
  expenseObj: '转出对象',
  kind: '款项说明',
  voucher: '凭证',
} as const

// 内部值 → 多维表格单选精确文案
const DIRECTION_LABEL: Record<string, string> = { income: '收款', expense: '转出' }
const SETTLEMENT_LABEL: Record<string, string> = { settled: '已结清', pending: '未结清' }
const ACCOUNT_LABEL: Record<string, string> = Object.fromEntries(
  PAYMENT_METHODS.map((m) => [m.key, m.label])
)

const APP = config.BITABLE_APP_TOKEN
const TABLE = config.BITABLE_TABLE_ID
const basePath = `/open-apis/bitable/v1/apps/${APP}/tables/${TABLE}`

interface FieldInfo {
  field_id: string
  ui_type: string
  options: Set<string>
}
let fieldsCache: Map<string, FieldInfo> | null = null
let warnedDisabled = false

async function loadFields(): Promise<Map<string, FieldInfo>> {
  if (fieldsCache) return fieldsCache
  const res: any = await apiClient.request({
    method: 'GET',
    url: `${basePath}/fields`,
    params: { page_size: 100 },
  })
  if (res.code !== 0) throw new Error(`拉取字段失败 code=${res.code} msg=${res.msg}`)
  const map = new Map<string, FieldInfo>()
  for (const f of res.data.items || []) {
    const opts = (f.property?.options || []).map((o: any) => o.name) as string[]
    map.set(f.field_name, { field_id: f.field_id, ui_type: f.ui_type, options: new Set(opts) })
  }
  fieldsCache = map
  return map
}

// 单选字段若选项不存在则补一个(best-effort,失败不阻断写入;只对动态的「对应业务」有意义,
// 其它单选字段是固定枚举,由表维护)。字段是文本类型则直接跳过(写值即可)。
async function ensureOption(fieldName: string, value: string): Promise<void> {
  try {
    const info = (await loadFields()).get(fieldName)
    if (!info || info.ui_type !== 'SingleSelect' || info.options.has(value)) return
    const res: any = await apiClient.request({
      method: 'PUT',
      url: `${basePath}/fields/${info.field_id}`,
      data: {
        field_id: info.field_id,
        field_name: fieldName,
        type: 3,
        ui_type: 'SingleSelect',
        property: { options: [...info.options, value].map((name) => ({ name })) },
      },
    })
    if (res.code === 0) info.options.add(value)
    else console.warn(`【补单选选项「${value}」未成功 code=${res.code},继续尝试写入】`)
  } catch (err: any) {
    console.warn('【ensureOption 异常,继续尝试写入】', err.message ?? err)
  }
}

// 把内部行组装成多维表格 fields(只填有值的,空值省略)
function buildFields(
  t: TransactionRow,
  projectName: string,
  voucherTokens: string[],
): Record<string, any> {
  const fields: Record<string, any> = {
    [F.type]: DIRECTION_LABEL[t.direction] ?? t.direction,
    [F.date]: t.occurred_at,
    [F.currency]: t.currency,
    [F.amount]: t.amount_minor / 100,
    [F.settle]: SETTLEMENT_LABEL[t.settlement_status] ?? '未结清',
    [F.project]: projectName,
  }
  if (t.kind) fields[F.kind] = t.kind
  if (t.settlement_note) fields[F.settleNote] = t.settlement_note
  if (t.direction === 'income') {
    if (t.our_account) fields[F.account] = ACCOUNT_LABEL[t.our_account] ?? t.our_account
    if (t.counterparty_name) fields[F.counterparty] = t.counterparty_name
  } else {
    if (t.counterparty_account_type) fields[F.expenseType] = t.counterparty_account_type
    if (t.counterparty_account) fields[F.expenseDetail] = t.counterparty_account
    if (t.counterparty_name) fields[F.expenseObj] = t.counterparty_name
  }
  if (voucherTokens.length) fields[F.voucher] = voucherTokens.map((tok) => ({ file_token: tok }))
  return fields
}

// ===================== 凭证图片(附件)=====================

// Readable 流收成 Buffer(messageResource.get 返回的是流,uploadAll 要 Buffer)
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function extFromContentType(ct: string | undefined): string {
  if (!ct) return 'jpg'
  if (ct.includes('png')) return 'png'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('gif')) return 'gif'
  return 'jpg'
}

// 凭证列是否存在且为附件类型(缓存:列通常不变;不存在则整段跳过,不阻断其余字段)
let voucherFieldEnabled: boolean | null = null
async function hasVoucherField(): Promise<boolean> {
  if (voucherFieldEnabled !== null) return voucherFieldEnabled
  try {
    const info = (await loadFields()).get(F.voucher)
    voucherFieldEnabled = !!info && info.ui_type === 'Attachment'
    if (!voucherFieldEnabled) {
      console.warn(`ℹ️ 多维表格未找到「${F.voucher}」附件列(或类型非附件),凭证图片将不写入。如需凭证,请确认该列已建且类型=附件,然后重启服务`)
    }
  } catch {
    voucherFieldEnabled = false
  }
  return voucherFieldEnabled
}

/**
 * 下载消息里的凭证图并上传到多维表格,返回 file_token 数组。
 * 单张失败 best-effort 跳过继续其余;全部失败返回空数组(不阻断记录写入)。
 * 用户发的图必须走 im.messageResource.get(im.image.get 只下机器人自己传的图)。
 */
async function uploadVoucherImages(imageKeys: string[], messageId: string): Promise<string[]> {
  const tokens: string[] = []
  if (!messageId) {
    console.warn('【凭证上传跳过】缺少 message_id,无法下载消息图片')
    return tokens
  }
  for (let i = 0; i < imageKeys.length; i++) {
    const imageKey = imageKeys[i]
    try {
      const dl: any = await apiClient.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: imageKey },
      })
      const stream: Readable | undefined = dl?.getReadableStream?.()
      if (!stream) throw new Error('下载返回空流')
      const buf = await streamToBuffer(stream)
      if (!buf.length) throw new Error('下载图片字节为空')
      const up: any = await apiClient.drive.media.uploadAll({
        data: {
          file_name: `voucher_${i + 1}.${extFromContentType(dl?.headers?.['content-type'])}`,
          parent_type: 'bitable_image',
          parent_node: APP,
          size: buf.length,
          file: buf,
        },
      })
      const token = up?.file_token
      if (token) tokens.push(token)
      else throw new Error('上传返回无 file_token')
    } catch (err: any) {
      console.warn(`【凭证上传失败】image_key=${imageKey}:`, err?.message ?? err, '(已跳过该张,继续其余)')
    }
  }
  return tokens
}

/**
 * 确保一笔记录有可用的凭证 file_token:已缓存且数量匹配→复用(纠正时凭证没变,避免重复上传/重复附件);
 * 否则下载+上传,并把结果回写 SQLite。无凭证图 / 列不存在 → 返回空。
 */
async function ensureVoucherTokens(t: TransactionRow): Promise<string[]> {
  const imageKeys = unpackImages(t.voucher_image_keys)
  if (!imageKeys.length) return []
  if (!(await hasVoucherField())) return []
  const cached = unpackImages(t.voucher_file_tokens)
  if (cached.length === imageKeys.length) return cached
  const tokens = await uploadVoucherImages(imageKeys, t.original_message_id)
  if (tokens.length) {
    updateTransaction(t.id, { voucherFileTokens: packImages(tokens) })
    console.log(`🖼️ 凭证已上传 ${tokens.length}/${imageKeys.length} 张 → 多维表格(业务记录 id=${t.id})`)
  }
  return tokens
}

function skipLog(): void {
  if (!warnedDisabled) {
    console.log('ℹ️ 多维表格双写未启用(未配 BITABLE_APP_TOKEN/TABLE_ID),只入 SQLite')
    warnedDisabled = true
  }
}

/**
 * 新增一条记录到多维表格。best-effort:失败只记日志返回 null,不影响 SQLite(唯一事实源)。
 * @returns 多维表格 record_id;未启用或失败返回 null
 */
export async function writeTransactionToBitable(
  t: TransactionRow,
  projectName: string
): Promise<string | null> {
  if (!ENABLED) {
    skipLog()
    return null
  }
  try {
    await ensureOption(F.project, projectName)
    const voucherTokens = await ensureVoucherTokens(t)
    const res: any = await apiClient.request({
      method: 'POST',
      url: `${basePath}/records`,
      data: { fields: buildFields(t, projectName, voucherTokens) },
    })
    if (res.code !== 0) throw new Error(`code=${res.code} msg=${res.msg}`)
    const rid = res.data?.record?.record_id ?? null
    console.log(`📤 已同步多维表格 record=${rid} (业务=${projectName})`)
    return rid
  } catch (err: any) {
    console.error('【多维表格写入失败,仅入 SQLite】', err.message ?? err)
    return null
  }
}

/** 纠正时同步更新多维表格已有记录。无 record_id / 未启用 / 失败均跳过(以 SQLite 为准)。 */
export async function updateTransactionInBitable(
  recordId: string | null | undefined,
  t: TransactionRow,
  projectName: string
): Promise<void> {
  if (!ENABLED) {
    skipLog()
    return
  }
  if (!recordId) return
  try {
    await ensureOption(F.project, projectName)
    const voucherTokens = await ensureVoucherTokens(t)
    const res: any = await apiClient.request({
      method: 'PUT',
      url: `${basePath}/records/${recordId}`,
      data: { fields: buildFields(t, projectName, voucherTokens) },
    })
    if (res.code !== 0) throw new Error(`code=${res.code} msg=${res.msg}`)
    console.log(`📤 已同步多维表格更新 record=${recordId}`)
  } catch (err: any) {
    console.error('【多维表格更新失败,以 SQLite 为准】', err.message ?? err)
  }
}

// ===================== 反向同步(多维表格 → SQLite)=====================

// 表格文案 → 内部枚举(正向 LABEL 的逆映射)
const DIRECTION_REVERSE: Record<string, TxnDirection> = { '收款': 'income', '转出': 'expense' }
const SETTLEMENT_REVERSE: Record<string, SettlementStatus> = { '已结清': 'settled', '未结清': 'pending' }
const ACCOUNT_REVERSE: Record<string, string> = Object.fromEntries(
  PAYMENT_METHODS.map((m) => [m.label, m.key])
)

// ---- 取值工具(表格读回的值类型不统一:Text/SingleSelect=string, DateTime=number, Number=string) ----
function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as any).text) : String(x)))
      .join('')
  }
  return String(v)
}
function asNumber(v: unknown): number {
  if (typeof v === 'number') return v
  const n = Number(v)
  return isNaN(n) ? 0 : n
}
// 毫秒时间戳 → 'YYYY-MM'(Asia/Shanghai),给 occurred_month 用
function monthFromMs(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date(ms))
}

interface ReversedTxn {
  direction: TxnDirection
  kind: string
  occurredAt: number
  occurredMonth: string
  ourAccount: string | null
  counterpartyName: string | null
  counterpartyAccount: string
  counterpartyAccountType: string
  amountMinor: number
  currency: string
  settlementStatus: SettlementStatus
  settlementNote: string
  projectName: string
}

// 把一条表格记录的 fields(按列名)反向映射成内部结构。关键字段缺失返回 null(调用方跳过,不写脏数据)。
function reverseMapFields(fields: Record<string, any>): ReversedTxn | null {
  const direction = DIRECTION_REVERSE[asText(fields[F.type])]
  if (!direction) return null
  const occurredAt = asNumber(fields[F.date])
  if (!occurredAt) return null
  const amountMinor = Math.round(asNumber(fields[F.amount]) * 100)
  if (!(amountMinor > 0)) return null
  const currency = asText(fields[F.currency])
  if (currency !== 'HKD' && currency !== 'RMB') return null
  const projectName = asText(fields[F.project])
  if (!projectName) return null

  let ourAccount: string | null = null
  let counterpartyName: string | null = null
  let counterpartyAccount = ''
  let counterpartyAccountType = ''
  if (direction === 'income') {
    ourAccount = ACCOUNT_REVERSE[asText(fields[F.account])] ?? null
    counterpartyName = asText(fields[F.counterparty]) || null
  } else {
    counterpartyName = asText(fields[F.expenseObj]) || null
    counterpartyAccount = asText(fields[F.expenseDetail])
    counterpartyAccountType = asText(fields[F.expenseType])
  }
  return {
    direction,
    kind: asText(fields[F.kind]),
    occurredAt,
    occurredMonth: monthFromMs(occurredAt),
    ourAccount,
    counterpartyName,
    counterpartyAccount,
    counterpartyAccountType,
    amountMinor,
    currency,
    settlementStatus: SETTLEMENT_REVERSE[asText(fields[F.settle])] ?? 'pending',
    settlementNote: asText(fields[F.settleNote]),
    projectName,
  }
}

// 反向后与现有行比对,完全一致=回环或无意义变动,跳过。
function snapshotEqual(row: TransactionRow, rev: ReversedTxn): boolean {
  return (
    row.direction === rev.direction &&
    row.kind === rev.kind &&
    row.occurred_at === rev.occurredAt &&
    row.amount_minor === rev.amountMinor &&
    row.currency === rev.currency &&
    (row.our_account ?? '') === (rev.ourAccount ?? '') &&
    (row.counterparty_name ?? '') === (rev.counterpartyName ?? '') &&
    (row.counterparty_account ?? '') === rev.counterpartyAccount &&
    (row.counterparty_account_type ?? '') === rev.counterpartyAccountType &&
    row.settlement_status === rev.settlementStatus &&
    row.settlement_note === rev.settlementNote &&
    getProjectName(row.project_id) === rev.projectName
  )
}

// 拉一条表格记录的 fields;失败返回 null。
async function fetchRecord(recordId: string): Promise<Record<string, any> | null> {
  const res: any = await apiClient.request({ method: 'GET', url: `${basePath}/records/${recordId}` })
  if (res.code !== 0) {
    console.warn(`【反向同步】拉取记录失败 record=${recordId} code=${res.code} msg=${res.msg}`)
    return null
  }
  return res.data?.record?.fields ?? null
}

/** 启动时订阅这个多维表格的云文档事件(幂等:已订阅也成功)。best-effort,失败只告警不阻断主流程。 */
export async function subscribeBitable(): Promise<void> {
  if (!ENABLED) return
  try {
    const res: any = await apiClient.request({
      method: 'POST',
      url: `/open-apis/drive/v1/files/${APP}/subscribe`,
      params: { file_type: 'bitable' },
    })
    if (res.code === 0) console.log('📡 已订阅多维表格记录变更事件(云端可能已订阅,幂等)')
    else console.log(`📡 订阅云文档事件 code=${res.code} msg=${res.msg}(若已订阅可忽略)`)
  } catch (err: any) {
    console.warn('【订阅云文档事件失败,反向同步不可用】', err.message ?? err)
  }
}

// 原始事件落盘一份(每次覆盖),便于首次联调排查结构
const DEBUG_FILE = path.resolve(path.dirname(config.DB_PATH), 'bitable-event-debug.json')
function dumpRaw(data: unknown): void {
  try {
    fs.writeFileSync(DEBUG_FILE, JSON.stringify(data, null, 2))
  } catch {
    /* 调试用,失败忽略 */
  }
}

/**
 * 处理多维表格记录变更事件(长连接推送)。表格里的增/改/删 → 同步回 SQLite。
 *  - record_deleted            → 软删(is_deleted=1,留档,统计/列表已排除)
 *  - record_added/record_edited → 拉最新值反向映射 → 已存在则更新、否则插入
 * 防回环:与现有行一致跳过;查不到 feishu_record_id 时用 60s 窗口匹配刚正向写入的行。
 */
export async function handleBitableRecordChanged(data: any): Promise<void> {
  // 入口立刻留痕:先证明事件已到达,再 dump 原始 payload(覆盖写)。
  // 此前的 log 全在 actions 校验之后,事件结构若与预期不符会静默 return,看不出到底有没有进来。
  // 放在 ENABLED 之前:即便双写未启用,也能确认事件是否到达长连接(诊断优先)。
  console.log('📥 [反向同步] 收到 bitable 变更事件')
  dumpRaw(data)
  if (!ENABLED) return
  const event = data?.event ?? data
  const actions = Array.isArray(event?.action_list) ? event.action_list : []
  if (!actions.length) {
    console.warn('⚠️ [反向同步] 事件到达但 action_list 为空(payload 结构可能变了,见 debug 文件)')
    return
  }

  for (const a of actions) {
    const recordId: string = a.record_id
    const action: string = a.action
    if (!recordId) continue
    try {
      if (action === 'record_deleted') {
        const changed = softDeleteByFeishuRecordId(recordId)
        console.log(
          changed
            ? `🗑️ 表格删除 → 软删 SQLite record=${recordId}`
            : `🗑️ 表格删除,SQLite 无对应记录 record=${recordId}`
        )
        continue
      }

      // record_added / record_edited
      const fields = await fetchRecord(recordId)
      if (!fields) continue
      const rev = reverseMapFields(fields)
      if (!rev) {
        console.log(`⏭️ 反向同步:关键字段不全(类型/日期/金额/币种/业务),跳过 record=${recordId}`)
        continue
      }

      const existing = getTxnByFeishuRecordId(recordId)
      if (existing && existing.is_deleted === 0 && snapshotEqual(existing, rev)) {
        console.log(`⏭️ 反向同步:与 SQLite 一致,跳过(回环/无变化) record=${recordId}`)
        continue
      }

      if (existing) {
        const p = resolveProject(rev.projectName)
        updateTransaction(existing.id, {
          direction: rev.direction,
          kind: rev.kind,
          occurredAt: rev.occurredAt,
          occurredMonth: rev.occurredMonth,
          amountMinor: rev.amountMinor,
          currency: rev.currency,
          ourAccount: rev.ourAccount,
          counterpartyName: rev.counterpartyName,
          counterpartyAccount: rev.counterpartyAccount,
          counterpartyAccountType: rev.counterpartyAccountType,
          settlementStatus: rev.settlementStatus,
          settlementNote: rev.settlementNote,
          projectId: p.id,
          projectNameRaw: rev.projectName,
          isDeleted: 0, // 曾被软删的行在表格里又被编辑 → 恢复
        })
        console.log(`✏️ 反向同步:更新 SQLite id=${existing.id} record=${recordId} 业务="${p.name}"`)
        continue
      }

      // 无对应行:先判断是不是机器人刚正向写入、还没回写 record_id 的(回环兜底)
      const echo = findRecentEcho(rev)
      if (echo) {
        updateTransaction(echo.id, { feishuRecordId: recordId })
        console.log(`🔗 反向同步:关联到刚写入的 SQLite id=${echo.id} record=${recordId}(回环)`)
        continue
      }

      // 真·表格手填的新行 → 入库
      const p = resolveProject(rev.projectName)
      const id = addTransaction({
        direction: rev.direction,
        kind: rev.kind,
        occurredAt: rev.occurredAt,
        occurredMonth: rev.occurredMonth,
        ourAccount: rev.ourAccount,
        counterpartyName: rev.counterpartyName,
        counterpartyAccount: rev.counterpartyAccount,
        counterpartyAccountType: rev.counterpartyAccountType,
        amountMinor: rev.amountMinor,
        currency: rev.currency,
        amountRaw: asText(fields[F.amount]),
        settlementStatus: rev.settlementStatus,
        settlementNote: rev.settlementNote,
        projectId: p.id,
        projectNameRaw: rev.projectName,
        transferType: '',
        note: '',
        chatId: '',
        userOpenId: '',
        originalMessageId: '',
        voucherImageKeys: '',
        voucherFileTokens: '',
      } satisfies NewTransactionInput)
      updateTransaction(id, { feishuRecordId: recordId })
      console.log(
        `➕ 反向同步:表格新行入库 id=${id} record=${recordId} 业务="${p.name}"(${rev.direction} ${rev.amountMinor / 100} ${rev.currency})`
      )
    } catch (err: any) {
      console.error(`【反向同步处理异常】record=${recordId} action=${action}`, err.message ?? err)
    }
  }
}
