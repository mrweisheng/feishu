import type Anthropic from '@anthropic-ai/sdk'
import { anthropic, modelName } from './ai/model.js'
import { addReminder, addBatchReminders } from './db/reminders.js'
import {
  addTransaction,
  getLatestByUser,
  getTransaction,
  updateTransaction,
  summaryByDirection,
  listTransactions,
  financeSummary,
  customerGroups,
  listCustomers,
  type TransactionPatch,
  type FinanceFilters,
} from './db/transactions.js'
import { resolveProject, listProjectNames, findProjectIdByName, getProjectName } from './db/projects.js'
import { PAYMENT_METHODS, PAYMENT_METHOD_KEYS } from './db/paymentMethods.js'
import { getWeather } from './services/weather.js'
import { writeTransactionToBitable, updateTransactionInBitable } from './feishu/bitable.js'
import { createTodoInBitable } from './feishu/bitable-todo.js'
import { config } from './config.js'

// 当前时间字符串(Asia/Shanghai),注入 system prompt 让 LLM 有时间观念
function currentTimeStr(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).format(new Date())
}

// 解析业务日期(YYYY-MM-DD 或 YYYY/M/D)→ 该日 Asia/Shanghai 00:00 的毫秒 + 'YYYY-MM'
function parseOccurred(date: string): { occurredAt: number; occurredMonth: string } | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(date.trim())
  if (!m) return null
  const y = m[1]
  const mo = m[2].padStart(2, '0')
  const d = m[3].padStart(2, '0')
  const occurredAt = Date.parse(`${y}-${mo}-${d}T00:00:00+08:00`)
  if (isNaN(occurredAt)) return null
  return { occurredAt, occurredMonth: `${y}-${mo}` }
}

// 解析查询日期边界(YYYY-MM-DD 或 YYYY/M/D)→ Asia/Shanghai 毫秒。startOfDay=该日00:00,否则该日23:59:59
function parseDateBound(date: string, startOfDay: boolean): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(date.trim())
  if (!m) return null
  const y = m[1]
  const mo = m[2].padStart(2, '0')
  const d = m[3].padStart(2, '0')
  const iso = startOfDay ? `${y}-${mo}-${d}T00:00:00+08:00` : `${y}-${mo}-${d}T23:59:59+08:00`
  const t = Date.parse(iso)
  return isNaN(t) ? null : t
}

// ts 所在 Asia/Shanghai 日期的 H:M(0-23,0-59)对应的时间戳(毫秒)
function shanghaiAt(ts: number, hour: number, minute: number): number {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts)).split('-').map(Number)
  return Date.parse(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
}

// 次日 Asia/Shanghai 的 H:M 时间戳(无具体时间时渐进式提醒的起点,默认次日9:30)
function nextDayAt(hour: number, minute: number): number {
  return shanghaiAt(Date.now() + 24 * 3600_000, hour, minute)
}

// ts 在 Asia/Shanghai 时区的友好描述:相对今天(今天/明天/M月D日)+ HH:MM
function formatShanghaiRelative(ts: number): string {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts)).split('-').map(Number)
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts))
  const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number)
  const today0 = Date.parse(`${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}T00:00:00+08:00`)
  const that0 = Date.parse(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`)
  const diffDays = Math.round((that0 - today0) / 86400000)
  if (diffDays === 0) return `今天 ${time}`
  if (diffDays === 1) return `明天 ${time}`
  return `${m}月${d}日 ${time}`
}

// create_todo 成功后后端直接拼回复(绕过 LLM):链接必带 + 语气俏皮 + 随机开头避免死板
const TODO_REPLY_OPENERS = ['好嘞～已帮你建', '安排上!已建', '收到～已帮你建', '没问题,已入库']
function buildTodoReply(
  items: string[],
  rounds: { round: number; remindAt: number }[],
  link: string,
): string {
  const opener = TODO_REPLY_OPENERS[Math.floor(Math.random() * TODO_REPLY_OPENERS.length)]
  const lines: string[] = [`✅ ${opener} ${items.length} 条待办:`]
  for (const c of items) lines.push(`- ${c}`)
  const first = formatShanghaiRelative(rounds[0].remindAt)
  const later = rounds.slice(1).map((r) =>
    new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(r.remindAt)),
  )
  if (rounds.length === 1) {
    lines.push(`⏰ ${first} 提醒你一次(当晚 8 点前没法再排更多轮啦)`)
  } else {
    lines.push(`⏰ ${first} 第一轮,之后 ${later.join('、')} 各查一次(没完成才再叨扰你哈)`)
  }
  if (link) lines.push(`🔗 查看待办:${link}`)
  return lines.join('\n')
}

// 我方收款方式提示串(供 system prompt 告诉 LLM 可选 key)
const PAYMENT_METHODS_HINT = PAYMENT_METHODS.map((m) => `${m.key}(${m.label})`).join('、')
const VALID_METHOD_KEYS = new Set(PAYMENT_METHOD_KEYS)

const SET_REMINDER_TOOL = {
  name: 'set_reminder',
  description: '为用户设置一条定时提醒。到点会在群里@用户并回复原消息。当用户说"X分钟后提醒我...""下午X点提醒我..."等时调用。remind_at 必须是未来的时间。',
  input_schema: {
    type: 'object' as const,
    properties: {
      remind_at: {
        type: 'string',
        description: '提醒触发绝对时间,ISO 8601 格式,如 "2026-07-03T13:05:00+08:00"。根据当前时间推算,必须在未来。',
      },
      content: {
        type: 'string',
        description: '提醒内容,简短。如"喝水"、"出门拿快递"。',
      },
    },
    required: ['remind_at', 'content'],
  },
}

const GET_WEATHER_TOOL = {
  name: 'get_weather',
  description: '查询某城市天气。可查当前实时,也可查未来日期(预报范围约3天)。用户问"XX天气怎样""明天/后天XX天气""热不热""要带伞吗"等时调用。',
  input_schema: {
    type: 'object' as const,
    properties: {
      city: {
        type: 'string',
        description: '城市名,中文或英文,如"北京"、"上海"、"武汉"。',
      },
      date: {
        type: 'string',
        description: '可选。要查询的日期,ISO 格式 YYYY-MM-DD,如"2026-07-04"。用户说"今天"则不传此字段(查实时);"明天/后天/具体日期"则换算成日期传入。仅支持未来约3天。',
      },
    },
    required: ['city'],
  },
}

const CREATE_TODO_TOOL = {
  name: 'create_todo',
  description: '在飞书待办事项表创建待办并排渐进式提醒(3轮:起点、+2h、+3h,晚8点截止,每轮检查表格状态,未完成才提醒)。用户 @你 + 待办内容 + wiki 链接时调用。多对象(如"回访客户A、B、C")拆成 contents 数组一次调用。',
  input_schema: {
    type: 'object' as const,
    properties: {
      contents: {
        type: 'array',
        items: { type: 'string' },
        description: '待办内容数组。单条也用数组包,如["回访客户A"];多对象每项一条,如["回访客户A","回访客户B","回访客户C"]。去掉链接和时间词。',
      },
      remind_at: {
        type: 'string',
        description: '可选。起点时间 ISO 8601,如 "2026-07-07T09:30:00+08:00"。有具体时间传它(第1次提醒=该时间);没具体时间不传(默认次日9:30起)。后端自动排 +2h、+3h 两轮,晚8点前截止,每轮未完成才提醒。',
      },
    },
    required: ['contents'],
  },
}

const RECORD_INCOME_TOOL = {
  name: 'record_income',
  description:
    '记录一笔收款(客户转给我们)。当用户发来按模板写的收款信息(款项性质/日期/收款账户/收款对象/金额/结算状态/业务群名)时调用。务必把业务名(project_name)与已有业务逐字对齐。',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', description: '款项性质/用途——即模板第1项括号里的说明文字。逐字照抄用户原文,不要理解/改写/归类/补全(用户写"新办尾款"就传"新办尾款")。' },
      date: { type: 'string', description: '业务日期 YYYY-MM-DD,如"2026-07-03"' },
      our_account: {
        type: 'string',
        description: '我方收款账户 key。只能是:' + PAYMENT_METHODS_HINT,
      },
      counterparty: { type: 'string', description: '收款对象(客户名字)' },
      amount: { type: 'number', description: '金额主单位数值。"17万"=170000、"HKD 1800"=1800。' },
      currency: { type: 'string', description: '币种:HKD 或 RMB' },
      settlement_status: { type: 'string', description: '结算状态:settled(已结清) 或 pending(待结清)。不确定填 pending。' },
      project_name: { type: 'string', description: '业务/群名。必须与已有业务逐字一致;确为全新业务才填新名字。' },
      settlement_note: { type: 'string', description: '可选。结算明细原文,如"总价19万,定金5万➕尾款14万"。' },
      transfer_type: { type: 'string', description: '可选。转账类型,如"业务收入"。' },
      note: { type: 'string', description: '可选。备注。' },
      amount_raw: { type: 'string', description: '可选。用户原始金额文本,如"17万""HKD $1800",留作审计。' },
    },
    required: ['kind', 'date', 'our_account', 'counterparty', 'amount', 'currency', 'settlement_status', 'project_name'],
  },
}

const RECORD_EXPENSE_TOOL = {
  name: 'record_expense',
  description:
    '记录一笔转出(我们付给别人)。当用户发来按模板写的转出信息(转出+用途/日期/对方账户/金额/结算状态/业务群名)时调用。务必把业务名与已有业务逐字对齐。',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', description: '转出用途——即模板第1项"转出"后面括号里的说明文字。逐字照抄用户原文,不要理解/改写/归类/补全(用户写"兵哥华哥杂费"就传"兵哥华哥杂费")。' },
      date: { type: 'string', description: '业务日期 YYYY-MM-DD' },
      counterparty: { type: 'string', description: '可选。转出对象(收款人名字)' },
      counterparty_account_type: { type: 'string', description: '对方收款方式:现金 / 支付宝 / 微信 / 银行卡(四选一)。从对方账户描述判断。' },
      counterparty_account: { type: 'string', description: '对方收款账户详情(自由文本,含户名/卡号/开户行,或"车场付于现金")' },
      amount: { type: 'number', description: '金额主单位数值。"17万"=170000。' },
      currency: { type: 'string', description: '币种:HKD 或 RMB' },
      settlement_status: { type: 'string', description: '结算状态:settled 或 pending。不确定填 pending。' },
      project_name: { type: 'string', description: '业务/群名。必须与已有业务逐字一致;确为全新业务才填新名字。' },
      settlement_note: { type: 'string', description: '可选。结算明细原文。' },
      note: { type: 'string', description: '可选。备注。' },
      amount_raw: { type: 'string', description: '可选。用户原始金额文本,留作审计。' },
    },
    required: ['kind', 'date', 'counterparty_account', 'amount', 'currency', 'settlement_status', 'project_name'],
  },
}

const CORRECT_TRANSACTION_TOOL = {
  name: 'correct_transaction',
  description:
    '纠正已记录的流水(改金额/币种/结算状态/业务归属/款项性质等)。target_id 不传=纠正该用户最近一条。',
  input_schema: {
    type: 'object' as const,
    properties: {
      target_id: { type: 'number', description: '可选。要纠正的流水 id;不传则纠正最近一条。' },
      project_name: { type: 'string', description: '可选。改挂到的业务名(与已有业务逐字对齐)。' },
      amount: { type: 'number', description: '可选。新金额主单位数值。' },
      currency: { type: 'string', description: '可选。HKD 或 RMB。' },
      settlement_status: { type: 'string', description: '可选。settled 或 pending。' },
      settlement_note: { type: 'string', description: '可选。结算明细。' },
      kind: { type: 'string', description: '可选。款项性质/用途(逐字照抄,不改写)。' },
      note: { type: 'string', description: '可选。备注。' },
    },
    required: [],
  },
}

const QUERY_FINANCE_TOOL = {
  name: 'query_finance',
  description:
    '查询收付款流水并汇总。可按 收/支方向、客户、业务、结算状态、币种、日期范围 过滤。返回 笔数 + 收入/支出按 HKD/RMB 分别合计(不跨币种换算),可选附明细列表。用户问"现在有几笔收款/各多少""某客户总额""待结清金额""某月收款"等时调用。不确定客户名时先调 list_customers。',
  input_schema: {
    type: 'object' as const,
    properties: {
      direction: { type: 'string', description: '可选。income=收款,expense=转出。不传=收+支都算。' },
      customer: { type: 'string', description: '可选。客户名(收款对象/转出对象)。务必用 list_customers 返回的准确写法(简繁/大小写要对齐),否则查不到。' },
      project_name: { type: 'string', description: '可选。业务/群名,与已有业务逐字一致。' },
      status: { type: 'string', description: '可选。settled=已结清,pending=待结清。' },
      currency: { type: 'string', description: '可选。HKD 或 RMB。' },
      from: { type: 'string', description: '可选。起始日期 YYYY-MM-DD(含)。' },
      to: { type: 'string', description: '可选。结束日期 YYYY-MM-DD(含)。' },
      with_items: { type: 'boolean', description: '可选。true=附上最多10条明细;默认 false(只要汇总)。' },
    },
    required: [],
  },
}

const CUSTOMER_GROUPS_TOOL = {
  name: 'customer_groups',
  description:
    '查某客户一共有几个业务(群)及每个业务的收支。客户名取自 list_customers 的准确写法。"几个群=该客户找我们办了几笔业务"。用户问"X有几个群""X做了几笔业务""X的所有业务"时调用。',
  input_schema: {
    type: 'object' as const,
    properties: {
      customer: { type: 'string', description: '客户名。务必用 list_customers 返回的准确写法(简繁/大小写要对齐)。' },
    },
    required: ['customer'],
  },
}

const LIST_CUSTOMERS_TOOL = {
  name: 'list_customers',
  description:
    '列出所有客户(收款对象/转出对象去重)及各自笔数/业务数/收支合计。用途:① 用户问"有哪些客户/谁还没结清";② 调 query_finance/customer_groups 前核对客户名的准确写法。',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
}

export interface LlmContext {
  originalMessageId: string
  userOpenId: string
  chatId: string
}

// 转出账户类型归一(只允许写入多维表格单选的 4 个选项之一;判不出留空)
const VALID_EXPENSE_ACCOUNT_TYPES = new Set(['现金', '支付宝', '微信', '银行卡'])
function normalizeAccountType(raw?: string): string {
  if (!raw) return ''
  const s = raw.trim()
  if (VALID_EXPENSE_ACCOUNT_TYPES.has(s)) return s
  if (/现金/.test(s)) return '现金'
  if (/支付宝/.test(s)) return '支付宝'
  if (/微信/.test(s)) return '微信'
  if (/银行|工行|建行|农行|中行|招行|卡号|转账|汇款/.test(s)) return '银行卡'
  return ''
}

// 取业务标准名(纠正时若没改业务,用它回查当前名)
function projectNameOf(projectId: number): string {
  return listProjectNames().find((p) => p.id === projectId)?.name ?? ''
}

// 落库后 best-effort 同步多维表格,并把 record_id 回写(SQLite 是唯一事实源,失败不影响)
async function syncToBitable(id: number, projectName: string): Promise<void> {
  const row = getTransaction(id)
  if (!row) return
  const rid = await writeTransactionToBitable(row, projectName)
  if (rid) updateTransaction(id, { feishuRecordId: rid })
}

async function executeTool(name: string, input: any, ctx: LlmContext): Promise<string> {
  if (name === 'set_reminder') {
    const { remind_at, content } = input as { remind_at: string; content: string }
    const ts = Date.parse(remind_at)
    if (isNaN(ts)) return JSON.stringify({ ok: false, error: '时间格式无法解析' })
    if (ts <= Date.now()) return JSON.stringify({ ok: false, error: '提醒时间已过去,请给一个未来的时间' })
    const id = addReminder({
      chatId: ctx.chatId,
      userOpenId: ctx.userOpenId,
      content,
      remindAt: ts,
      originalMessageId: ctx.originalMessageId,
    })
    console.log('⏰ 已设置提醒 id=', id, '内容:', content, '触发时间:', new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
    // 通知调度器:可能有更早的提醒需要重排定时器(由 reminders.ts 注入,避免循环依赖)
    onReminderAdded?.()
    return JSON.stringify({ ok: true, remind_at, content })
  }
  if (name === 'create_todo') {
    const { contents, remind_at } = input as { contents: string[]; remind_at?: string }
    // 去重 + 去空
    const items = Array.from(new Set((contents || []).map((s) => s.trim()).filter(Boolean)))
    if (!items.length) return JSON.stringify({ ok: false, error: '待办内容(contents)不能为空' })

    // 起点:有 remind_at 用它(校验未来);没传 = 次日 9:30 Asia/Shanghai
    let startTs: number
    if (remind_at) {
      startTs = Date.parse(remind_at)
      if (isNaN(startTs)) return JSON.stringify({ ok: false, error: '提醒时间格式无法解析' })
      if (startTs <= Date.now()) return JSON.stringify({ ok: false, error: '提醒时间已过去,请给一个未来的时间' })
    } else {
      startTs = nextDayAt(9, 30)
    }

    // 逐条写表格,收集成功的 record_id
    const recordIds: string[] = []
    for (const c of items) {
      const rid = await createTodoInBitable({ content: c, userOpenId: ctx.userOpenId })
      if (rid) recordIds.push(rid)
    }
    if (!recordIds.length) return JSON.stringify({ ok: false, error: '待办表格写入全部失败' })

    // 算 3 轮 + 截止(起点当天 20:00 Asia/Shanghai,超过则不排)
    const day20 = shanghaiAt(startTs, 20, 0)
    const rounds: { round: number; remindAt: number }[] = [{ round: 1, remindAt: startTs }]
    const r2 = startTs + 2 * 3600_000
    const r3 = startTs + 3 * 3600_000
    if (r2 <= day20) rounds.push({ round: 2, remindAt: r2 })
    if (r3 <= day20) rounds.push({ round: 3, remindAt: r3 })

    const batchId = `${ctx.originalMessageId}-${Date.now()}`
    addBatchReminders({
      batchId,
      chatId: ctx.chatId,
      userOpenId: ctx.userOpenId,
      originalMessageId: ctx.originalMessageId,
      todoRecordIds: recordIds,
      rounds,
    })
    onReminderAdded?.()

    const roundStr = rounds
      .map((r) => new Date(r.remindAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }))
      .join('、')
    console.log(`📋 已创建待办 batch=${batchId} 条数=${recordIds.length} 轮次=${rounds.length} 起点=${new Date(startTs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
    return JSON.stringify({
      ok: true,
      todo_count: recordIds.length,
      contents: items,
      start_at: new Date(startTs).toISOString(),
      rounds: rounds.map((r) => ({ round: r.round, at: new Date(r.remindAt).toISOString() })),
      rounds_time_str: roundStr,
      bitable_link: config.BITABLE_TODO_LINK,
      __reply: buildTodoReply(items, rounds, config.BITABLE_TODO_LINK),
    })
  }
  if (name === 'get_weather') {
    const { city, date } = input as { city: string; date?: string }
    try {
      const w = await getWeather(city, date)
      return JSON.stringify({
        ok: true,
        city: w.city,
        date: w.date ?? null,
        isForecast: w.isForecast,
        temperature: w.temperature,
        description: w.description,
        humidity: w.humidity,
        wind: w.wind,
      })
    } catch (err: any) {
      console.error('【天气查询失败】city=', city, 'date=', date ?? '(now)', 'msg:', err.message)
      return JSON.stringify({ ok: false, error: `查询${city}天气失败:${err.message}` })
    }
  }
  if (name === 'record_income') {
    const inp = input as {
      kind?: string; date: string; our_account: string; counterparty?: string
      amount: number; currency: string; settlement_status?: string; project_name: string
      settlement_note?: string; transfer_type?: string; note?: string; amount_raw?: string
    }
    const occ = parseOccurred(inp.date)
    if (!occ) return JSON.stringify({ ok: false, error: `日期无法解析:${inp.date}(需 YYYY-MM-DD)` })
    if (!['HKD', 'RMB'].includes(inp.currency)) return JSON.stringify({ ok: false, error: 'currency 必须是 HKD 或 RMB' })
    if (typeof inp.amount !== 'number' || !(inp.amount > 0)) return JSON.stringify({ ok: false, error: '金额必须为正数' })
    if (!VALID_METHOD_KEYS.has(inp.our_account)) return JSON.stringify({ ok: false, error: `收款账户未知:${inp.our_account}`, methods: PAYMENT_METHODS_HINT })
    if (!inp.project_name?.trim()) return JSON.stringify({ ok: false, error: '业务名(project_name)不能为空' })
    const project = resolveProject(inp.project_name)
    const id = addTransaction({
      direction: 'income',
      kind: inp.kind || '',
      occurredAt: occ.occurredAt,
      occurredMonth: occ.occurredMonth,
      ourAccount: inp.our_account,
      counterpartyName: inp.counterparty || null,
      counterpartyAccount: null,
      counterpartyAccountType: '',
      amountMinor: Math.round(inp.amount * 100),
      currency: inp.currency,
      amountRaw: inp.amount_raw || '',
      settlementStatus: inp.settlement_status === 'settled' ? 'settled' : 'pending',
      settlementNote: inp.settlement_note || '',
      projectId: project.id,
      projectNameRaw: inp.project_name,
      transferType: inp.transfer_type || '',
      note: inp.note || '',
      chatId: ctx.chatId,
      userOpenId: ctx.userOpenId,
      originalMessageId: ctx.originalMessageId,
    })
    console.log(`💰 记收款 id=${id} 业务="${project.name}"${project.isNew ? '(新)' : ''} ${inp.amount} ${inp.currency} 对象=${inp.counterparty || '-'}`)
    await syncToBitable(id, project.name)
    const s = summaryByDirection('income')
    return JSON.stringify({ ok: true, id, direction: 'income', project_name: project.name, project_is_new: project.isNew, amount: inp.amount, currency: inp.currency, summary: { count: s.count, totals: s.totals }, bitable_link: config.BITABLE_LINK })
  }
  if (name === 'record_expense') {
    const inp = input as {
      kind?: string; date: string; counterparty?: string; counterparty_account_type?: string; counterparty_account?: string
      amount: number; currency: string; settlement_status?: string; project_name: string
      settlement_note?: string; note?: string; amount_raw?: string
    }
    const occ = parseOccurred(inp.date)
    if (!occ) return JSON.stringify({ ok: false, error: `日期无法解析:${inp.date}(需 YYYY-MM-DD)` })
    if (!['HKD', 'RMB'].includes(inp.currency)) return JSON.stringify({ ok: false, error: 'currency 必须是 HKD 或 RMB' })
    if (typeof inp.amount !== 'number' || !(inp.amount > 0)) return JSON.stringify({ ok: false, error: '金额必须为正数' })
    if (!inp.project_name?.trim()) return JSON.stringify({ ok: false, error: '业务名(project_name)不能为空' })
    const project = resolveProject(inp.project_name)
    const id = addTransaction({
      direction: 'expense',
      kind: inp.kind || '',
      occurredAt: occ.occurredAt,
      occurredMonth: occ.occurredMonth,
      ourAccount: null,
      counterpartyName: inp.counterparty || null,
      counterpartyAccount: inp.counterparty_account || '',
      counterpartyAccountType: normalizeAccountType(inp.counterparty_account_type),
      amountMinor: Math.round(inp.amount * 100),
      currency: inp.currency,
      amountRaw: inp.amount_raw || '',
      settlementStatus: inp.settlement_status === 'settled' ? 'settled' : 'pending',
      settlementNote: inp.settlement_note || '',
      projectId: project.id,
      projectNameRaw: inp.project_name,
      transferType: '',
      note: inp.note || '',
      chatId: ctx.chatId,
      userOpenId: ctx.userOpenId,
      originalMessageId: ctx.originalMessageId,
    })
    console.log(`💸 记转出 id=${id} 业务="${project.name}"${project.isNew ? '(新)' : ''} ${inp.amount} ${inp.currency}`)
    await syncToBitable(id, project.name)
    const s = summaryByDirection('expense')
    return JSON.stringify({ ok: true, id, direction: 'expense', project_name: project.name, project_is_new: project.isNew, amount: inp.amount, currency: inp.currency, summary: { count: s.count, totals: s.totals }, bitable_link: config.BITABLE_LINK })
  }
  if (name === 'correct_transaction') {
    const inp = input as {
      target_id?: number; project_name?: string; amount?: number; currency?: string
      settlement_status?: string; settlement_note?: string; kind?: string; note?: string
    }
    const txn = inp.target_id ? getTransaction(inp.target_id) : getLatestByUser(ctx.userOpenId)
    if (!txn) return JSON.stringify({ ok: false, error: inp.target_id ? `找不到流水 id=${inp.target_id}` : '你还没有可纠正的流水' })
    const patch: TransactionPatch = {}
    let newProjectName: string | null = null
    if (inp.project_name?.trim()) {
      const p = resolveProject(inp.project_name)
      patch.projectId = p.id
      patch.projectNameRaw = inp.project_name
      newProjectName = p.name
    }
    if (typeof inp.amount === 'number' && inp.amount > 0) patch.amountMinor = Math.round(inp.amount * 100)
    if (inp.currency) patch.currency = inp.currency
    if (inp.settlement_status) patch.settlementStatus = inp.settlement_status === 'settled' ? 'settled' : 'pending'
    if (inp.settlement_note !== undefined) patch.settlementNote = inp.settlement_note
    if (inp.kind !== undefined) patch.kind = inp.kind
    if (inp.note !== undefined) patch.note = inp.note
    const changed = updateTransaction(txn.id, patch)
    console.log(`✏️ 纠正流水 id=${txn.id} 改动字段=[${Object.keys(patch).join(',')}]`)
    if (changed) {
      const updated = getTransaction(txn.id)
      const projName = newProjectName ?? projectNameOf(txn.project_id)
      if (updated && projName) await updateTransactionInBitable(updated.feishu_record_id, updated, projName)
    }
    return JSON.stringify({ ok: changed, id: txn.id, updated_fields: Object.keys(patch) })
  }
  if (name === 'list_customers') {
    const rows = listCustomers()
    return JSON.stringify({
      ok: true,
      count: rows.length,
      customers: rows.map((r) => ({
        name: r.name,
        count: r.count,
        group_count: r.group_count,
        income: { HKD: r.income_hkd, RMB: r.income_rmb },
        expense: { HKD: r.expense_hkd, RMB: r.expense_rmb },
      })),
    })
  }
  if (name === 'customer_groups') {
    const { customer } = input as { customer: string }
    const name_ = customer?.trim()
    if (!name_) return JSON.stringify({ ok: false, error: 'customer 不能为空' })
    const res = customerGroups(name_)
    if (!res.matched) {
      const known = listCustomers().map((c) => c.name)
      return JSON.stringify({ ok: false, error: `没找到客户「${name_}」`, hint: '核对简繁/大小写,或用 list_customers 看全部客户', known_customers: known })
    }
    return JSON.stringify({
      ok: true,
      customer: res.customer,
      group_count: res.group_count,
      totals: { count: res.totals.count, income: res.totals.income, expense: res.totals.expense },
      groups: res.projects.map((p) => ({
        name: p.project_name,
        count: p.count,
        income: { HKD: p.income_hkd, RMB: p.income_rmb },
        expense: { HKD: p.expense_hkd, RMB: p.expense_rmb },
        net: { HKD: p.net_hkd, RMB: p.net_rmb },
        last_at: p.last_at,
      })),
    })
  }
  if (name === 'query_finance') {
    const inp = input as {
      direction?: string; customer?: string; project_name?: string; status?: string
      currency?: string; from?: string; to?: string; with_items?: boolean
    }
    const filters: FinanceFilters = {}
    if (inp.direction === 'income' || inp.direction === 'expense') filters.direction = inp.direction
    if (inp.customer?.trim()) filters.counterparty = inp.customer.trim()
    if (inp.project_name?.trim()) {
      const pid = findProjectIdByName(inp.project_name.trim())
      if (pid === null) {
        return JSON.stringify({
          ok: false,
          error: `没找到业务「${inp.project_name}」(要与已有业务逐字一致)`,
          known_projects: listProjectNames().map((p) => p.name),
        })
      }
      filters.projectId = pid
    }
    if (inp.status === 'settled' || inp.status === 'pending') filters.status = inp.status
    if (inp.currency === 'HKD' || inp.currency === 'RMB') filters.currency = inp.currency
    if (inp.from) {
      const t = parseDateBound(inp.from, true)
      if (t !== null) filters.from = t
    }
    if (inp.to) {
      const t = parseDateBound(inp.to, false)
      if (t !== null) filters.to = t
    }
    const s = financeSummary(filters)
    const out: Record<string, unknown> = {
      ok: true,
      summary: { count: s.count, income: s.income, expense: s.expense },
      filters,
    }
    if (inp.with_items) {
      const rows = listTransactions({ ...filters, limit: 10, offset: 0 })
      out.items = rows.map((r) => ({
        id: r.id,
        direction: r.direction,
        date: r.occurred_at,
        month: r.occurred_month,
        kind: r.kind,
        amount: r.amount_minor / 100,
        currency: r.currency,
        counterparty: r.counterparty_name,
        project: getProjectName(r.project_id),
        status: r.settlement_status,
      }))
      out.items_truncated = rows.length >= 10
    }
    return JSON.stringify(out)
  }
  return JSON.stringify({ ok: false, error: `未知工具: ${name}` })
}

// 新增提醒后的回调钩子(由 reminders.ts 注册,避免 llm ↔ reminders 循环依赖)
let onReminderAdded: (() => void) | null = null
export function setOnReminderAdded(fn: () => void): void {
  onReminderAdded = fn
}

/**
 * 调用 LLM。带 set_reminder 工具,走标准 tool-use loop(最多 3 轮)。
 * ctx 提供群/用户/原消息上下文,工具执行时用。
 */
export async function askLLM(question: string, ctx: LlmContext): Promise<string> {
  // 已有业务名单注入,供 LLM 把用户手打的群名逐字对齐(容错大小写/错字/简繁)
  const projectList = listProjectNames().map((p) => p.name)
  const projectListStr = projectList.length ? projectList.join('、') : '(暂无)'

  const system = `你是一个有帮助又活泼的群助手。当前时间:${currentTimeStr()}(UTC+8, Asia/Shanghai)。用户在飞书群里@你交流。
回答风格:像群里熟悉的朋友,语气轻松、自然、偶尔用 emoji 调节气氛,避免机械感和官腔。简短直接,不说废话。
你能力:
- 设置定时提醒:用户说"X分钟后/下午X点提醒我..."时,调用 set_reminder 工具,remind_at 传 ISO 8601 绝对时间(如 2026-07-03T13:05:00+08:00)。确认成功后用轻松的话告诉用户几点会提醒、提醒什么,别只回干巴巴的「已设置」。
- 查询天气:用户问某地天气、要不要带伞、穿什么时,调用 get_weather 工具。可查当前(不传 date)或未来日期(传 date=YYYY-MM-DD,支持约3天预报)。
  · 用户说"今天/现在"→ 不传 date;说"明天/后天/具体日期"→ 根据当前日期换算成 YYYY-MM-DD 传入 date。
  · 拿到结果后用口语转述(别说"温度32湿度55%",要说"32度挺热的,注意防晒 ☀️")。预报给的是最高/最低温,要说"明天 28~35度"。
  · 用户没说城市时,先问一句在哪个城市。
- 记录收款/支出:用户发来半结构化记账文字(按模板:收款 7 项 / 转出 6 项)时,解析后调用工具入库,别把它当闲聊。
  · 收款(客户转给我们)→ record_income;转出(我们付给别人)→ record_expense。
  · 款项性质/用途(kind):模板第1项"收款/转出"后面括号里的说明(如"新办尾款""兵哥华哥杂费")。**必须逐字照抄原文,不要理解、改写、归类或补全**,用户写什么就原样传什么;没有括号说明就传空字符串。
  · 金额写法多样,你要换算成主单位数值传 amount:"17万"=170000、"14万"=140000、"HKD 1800"/"$1800"/"1800HKD"=1800、"210479"=210479;并把币种 HKD/RMB 传 currency,同时把用户原始金额文本传 amount_raw 留底。
  · 收款账户(our_account,只能是这几个 key 之一):${PAYMENT_METHODS_HINT}。用户说法对照:"陈振耀/大陆工商/工商银行"→chen_zhenyao_rmb;"华星/港币账户/华侨银行"→huaxin_hkd;"LI FANGLIANG/ZA/杂费账户"→li_fangliang_hkd;"支付宝/个人支付宝/赵欣朵"→personal_alipay;"微信/个人微信"→personal_wechat;"现金/港币现金/人民币现金"→cash。
  · 转出(我们付给别人)时,还要判断对方收款方式 counterparty_account_type:现金/支付宝/微信/银行卡 四选一(看账户描述:微信→微信、支付宝→支付宝、银行/卡号/转账→银行卡、给现金→现金);收款人名传 counterparty,账户详情(户名/卡号/开户行原文)传 counterparty_account。
  · 业务名(project_name)是最关键字段,关系去重统计。已有业务清单:${projectListStr}。**必须从清单里逐字照抄准确的业务名(不改简繁、不改大小写、不改标点、不加不减字)**;只有确认是全新业务才填一个干净的新名字。这步务必认真,写错会把同一笔业务拆成两条。
  · 结算状态:用户说"已结清/结清/全部结清/已結清"→settled;"待结清/未结清/还没/待結清"→pending;不确定就填 pending。settlement_note 存明细原文。
  · 入库后回复必须包含三段:(1) 本笔确认——收/支、金额+币种、用途说明(即 kind,逐字原样,如"新办尾款""兵哥华哥杂费")、对象或账户、业务名(说明已有还是新建)、结算状态;有结算明细(settlement_note)也可顺带提一句;(2) 该方向累计——用工具返回的 summary(count + totals),格式"📊 目前共 N 笔收款/转出:<币种> <合计>",只列 totals 里出现的币种(只有港币就只说港币,不要提 0 的币种),金额用千分位;(3) 表格链接——把工具返回的 bitable_link 原样附上一行"🔗 查看明细:<链接>";若 bitable_link 为空则省略第三段。
  · 例(收款):"✅ 已记收款 HKD 1,800(用途:新办尾款·黄锦洪),业务『黄锦洪港珠澳大桥新办』已结清。\n📊 目前共 5 笔收款:HKD 12,000、RMB 3,500。\n🔗 查看明细:https://..."
  · 例(转出):"✅ 已记转出 HKD 1,077(用途:兵哥华哥杂费·LI LUOHUA),业务『5月21日粤Z6Y18港莲塘现牌 换车』已结清。\n📊 目前共 1 笔转出:HKD 1,077。\n🔗 查看明细:https://..."
- 纠正流水:用户说"把上一条的金额改成X""把最近一条归到Y业务""上一条改成已结清"等时,调用 correct_transaction(target_id 不传=你最近一条),只传要改的字段。
- 查询收支:用户问"现在有几笔收款/各多少""X客户总共收了多少""X做了几个业务(群)""待结清多少""某月收款多少"等时,调用查询工具,别凭空编数字。
  · 不确定客户名写法时先 list_customers 拿准确名(简繁/大小写要对齐),再 query_finance / customer_groups;业务名同样要与已有业务逐字一致。
  · 金额**务必按币种分开报:港币和人民币绝不能加在一起,也不要换算**(工具返回的 income/expense 已按 HKD/RMB 分开)。某币种为 0 就别提它。报金额用主单位+千分位(如"HKD 12,000")。
  · 一般先报汇总(笔数 + 各币种合计);用户追问明细时再 query_finance 带 with_items=true(最多10条)。查无结果要如实说"没有记录",别编。
- 创建待办:用户 @你 且消息带飞书多维表格/wiki 链接 + 待办/回访/跟进/处理等意图时(如"明天9:30提醒我回访客户A、B、C <链接>""明天提醒我完成报销 <链接>"),调 create_todo。
  · contents = 待办内容数组,去掉链接和时间词。多对象(如"回访客户A、B、C")拆成多项,一次调用传 ["回访客户A","回访客户B","回访客户C"];单条也用数组包 ["整理周报"]。不要为多对象调多次。
  · remind_at = 起点时间 ISO 8601。用户说了具体时间("明天9:30""下午3点"等)就换算传入(第1次提醒=该时间);没说具体时间("明天提醒我XX")就不传(默认次日9:30起)。
  · 后端自动排渐进式3轮提醒(起点、+2h、+3h,晚8点截止,每轮检查表格状态,未完成才提醒,合并成一条消息列出)。LLM 不用管轮次。
  · 入库后回复:✅ 已创建 N 条待办 + 列出内容 + 第一次提醒时间(及后续两轮时间)。例:"✅ 已创建3条待办:回访客户A、回访客户B、回访客户C\n⏰ 第一次提醒:明天9:30,之后11:30、14:30各查一次(没完成才提醒)\n🔗 查看待办:<bitable_link>"。bitable_link 为空则省略链接行。`

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: question },
  ]

  for (let i = 0; i < 3; i++) {
    const res = await anthropic.messages.create({
      model: modelName,
      max_tokens: 1000,
      system,
      tools: [
        SET_REMINDER_TOOL,
        GET_WEATHER_TOOL,
        CREATE_TODO_TOOL,
        RECORD_INCOME_TOOL,
        RECORD_EXPENSE_TOOL,
        CORRECT_TRANSACTION_TOOL,
        QUERY_FINANCE_TOOL,
        CUSTOMER_GROUPS_TOOL,
        LIST_CUSTOMERS_TOOL,
      ],
      messages,
    })

    const textParts: string[] = []
    const toolUses: Anthropic.ToolUseBlock[] = []
    for (const block of res.content) {
      if (block.type === 'text') textParts.push(block.text)
      else if (block.type === 'tool_use') toolUses.push(block)
    }

    if (res.stop_reason === 'tool_use' && toolUses.length) {
      // 把 assistant 完整回复入历史(含 tool_use block,维持推理链)
      messages.push({ role: 'assistant', content: res.content })
      // 执行工具并回灌 tool_result
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        const result = await executeTool(tu.name, tu.input, ctx)
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result })
        // create_todo 成功后后端已拼好回复(__reply),直接返回绕过 LLM 最终生成,保证链接必带 + 语气稳定俏皮
        try {
          const parsed = JSON.parse(result)
          if (parsed && typeof parsed.__reply === 'string') return parsed.__reply
        } catch {}
      }
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    // 无工具调用(或结束),返回文本
    const text = textParts.join('').trim()
    if (!text) {
      console.error('【LLM 警告】返回无 text 内容,stop_reason:', res.stop_reason, '原始 content:', JSON.stringify(res.content))
    }
    return text
  }

  // 兜底:循环用尽仍未结束
  return '（抱歉,处理超时,请重试）'
}

// 到点提醒的多样化模板(LLM 失败时兜底,避免重复死板)
const REMINDER_TEMPLATES = [
  (content: string) => `⏰ 时间到啦!别忘:${content} 💪`,
  (content: string) => `🔔 叮~ 该${content}了,快去吧!`,
  (content: string) => `📢 提醒送达:${content},行动起来~`,
  (content: string) => `✨ 到点咯,记得${content}哦~`,
  (content: string) => `⏰ 嘿!${content}的时间到了 🚀`,
  (content: string) => `🎯 别忘了:${content},冲冲冲!`,
]

function fallbackReminderText(content: string): string {
  const tpl = REMINDER_TEMPLATES[Math.floor(Math.random() * REMINDER_TEMPLATES.length)]
  return tpl(content)
}

/**
 * 到点触发时,让 LLM 生成一句活泼、带 emoji 的提醒语。
 * 失败则回退到本地多样化模板(保证不死板、不重复)。
 */
export async function generateReminderText(content: string, userName: string): Promise<string> {
  try {
    const res = await anthropic.messages.create({
      model: modelName,
      max_tokens: 150,
      messages: [
        {
          role: 'user',
          content: `现在是定时提醒触发时间。要提醒用户「${userName}」的事情是:${content}。

请生成一句简短(15-30字)、活泼、有趣、带 emoji 的提醒语,直接 @用户。
要求:
- 像朋友间轻松的口吻,别像机器人播报
- 不要用「提醒您」「请注意」这种客套话
- 只输出提醒语本身,不要解释、不要引号、不要多余换行`,
        },
      ],
    })
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    return text || fallbackReminderText(content)
  } catch (err: any) {
    console.error('【提醒文案 LLM 生成失败,回退模板】msg:', err.message)
    return fallbackReminderText(content)
  }
}
