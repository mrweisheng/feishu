import { config } from '../config.js'

/**
 * 工具注册表 —— 从架构上杜绝「LLM 假宣布成功 + 编假链接」类问题。
 *
 * 核心原则:**事实与叙述分离**。
 * 「成功了几条」「链接是啥」这些关键事实,永远由代码统计真实工具执行结果决定,
 * LLM 只负责组织语言(叙述),不能宣布事实、不能贴链接。
 *
 * 每个有副作用、用户关心成败的「写工具」在这里登记一行,
 * 账本记录 / 事实接管 / 链接注入这三段保护逻辑全部通用,读注册表自动跑。
 * 未来新增写维格表的功能(订单/售后/预约……),只要:
 *   1. 在 llm.ts 里写工具函数本身(业务逻辑)
 *   2. 在这里登记一行(写工具 + 成功话术 + 链接来源)
 * 防撒谎 / 防假链接 / 事实接管 全自动获得,绕不过去。
 */

/** 一条账本记录:一次工具执行的真实结果(不经 LLM 的嘴) */
export interface LedgerEntry {
  /** 工具名 */
  tool: string
  /** 写工具才参与事实接管;读工具(天气)记了但不影响回复追加 */
  category: 'write' | 'read'
  /** 这次执行成功没(代码判定,不信 LLM) */
  ok: boolean
  /** 跳过(去重命中)——不算成功也不算失败,系统核对段单独报告"重复已跳过" */
  skipped?: boolean
  /** 人类可读成功摘要,如「登记客资「徐途似锦」」(成功时填) */
  summary?: string
  /** 失败原因(失败时填,便于排查) */
  error?: string
  /** 该工具成功后该贴哪个 config 链接(对应 LINK_SOURCES 的 key) */
  linkKey?: string
}

/** 写工具登记项 */
export interface WriteToolSpec {
  /** 工具名,对应 executeTool 里的分支名 */
  name: string
  /** 成功后该贴的链接 key(指向 LINK_SOURCES);不需要贴链接就不传 */
  linkKey?: string
}

/**
 * 链接来源表:key → config 里的真实 URL。
 * 链接**只能**从这里取(来自 .env 配置),LLM 文字里的链接一律 stripAllUrls 删掉。
 * 新增一个写维格表的功能,在这里加一行。
 */
const LINK_SOURCES: Record<string, string | null> = {
  customer: config.BITABLE_CUSTOMER_LINK || null,
  // 未来:order: config.BITABLE_ORDER_LINK || null,
  // 未来:appointment: config.BITABLE_APPOINTMENT_LINK || null,
}

/** 已登记的写工具集(用于判断某工具算不算「写工具」) */
const WRITE_TOOLS = new Map<string, WriteToolSpec>([
  ['record_customer_info', { name: 'record_customer_info', linkKey: 'customer' }],
  ['set_reminder', { name: 'set_reminder' }], // 写工具(改 DB + 调度),同源 bug 一起根治,但不贴链接
  // 未来:record_order / record_after_sale / record_appointment ...
])

/** 某工具是不是写工具(读工具如天气不参与事实接管) */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}

/** 拿写工具登记项(用于 loop 里构造账本) */
export function getWriteToolSpec(name: string): WriteToolSpec | undefined {
  return WRITE_TOOLS.get(name)
}

/** 按 linkKey 聚合拿真实链接(只在 ≥1 条成功时才贴) */
export function getLink(linkKey: string): string | null {
  return LINK_SOURCES[linkKey] ?? null
}

/**
 * 事实接管:拿整轮的账本 + LLM 原文,生成「系统核对」追加段。
 * 这是整个修复的核心 —— 用户看到的成败/数量/链接,全部由这里产出,与 LLM 文字无关。
 *
 * 规则(按 tool 分组,每组只贴一次链接):
 *  - 该组 ≥1 条成功 👉 「📋 系统核对:已登记客资 N 条:[名字们] 👉 <真实链接>」
 *  - 该组有过调用但 0 条成功 👉 「⚠️ 系统核对:本次实际未成功登记任何客资,请重新发图」
 *  - 无链接的写工具(如 set_reminder)只报成败数量,不贴链接
 *  - 账本无写工具记录,但 LLM 文字里却声称「已登记/录了 N 条」(本次 bug 的典型形态:
 *    LLM 读对了图却偷懒没调工具,直接编文本)👉 追加「⚠️ 系统核对:本次实际未成功登记,
 *    请重新发图」戳穿谎言,不让"假成功"蒙混过关
 *  - 账本无写工具记录、LLM 文字也无登记声称(纯闲聊)👉 不追加
 *
 * @param ledger 本轮真实工具执行账本(事实源)
 * @param llmText LLM 吐出的原文(用于交叉检测"声称成功却没真调工具"的幻觉)
 * @returns 追加段(可能为空字符串)。调用方负责拼到 LLM 文字末尾。
 */
export function buildSystemAttestation(ledger: LedgerEntry[], llmText?: string): string {
  // 只看写工具
  const writes = ledger.filter((e) => e.category === 'write')

  // 账本无写工具记录 —— 可能是纯闲聊(正常),也可能是 LLM 编了"已登记"却没真调工具(bug)
  // 用 LLM 原文交叉检测:出现登记类声称词就戳穿,否则当作纯闲聊不追加
  if (writes.length === 0) {
    if (llmText && CLAIMS_REGISTER.test(llmText)) {
      return '⚠️ 系统核对:本次实际未成功登记任何客资(机器人未真正执行录入),请重新发图或换张清晰的图'
    }
    return ''
  }

  // 按 tool 分组(同一工具的多条执行聚合)
  const groups = new Map<string, LedgerEntry[]>()
  for (const e of writes) {
    if (!groups.has(e.tool)) groups.set(e.tool, [])
    groups.get(e.tool)!.push(e)
  }

  const lines: string[] = []
  for (const [tool, entries] of groups) {
    const spec = getWriteToolSpec(tool)
    const label = TOOL_LABELS[tool] ?? tool

    // 三态分清:成功 / 跳过(去重重复)/ 失败
    const okEntries = entries.filter((e) => e.ok && !e.skipped)
    const skipEntries = entries.filter((e) => e.skipped)
    const failEntries = entries.filter((e) => !e.ok && !e.skipped)

    if (okEntries.length > 0) {
      // 成功:列数量 + 名字 + 链接
      const names = okEntries
        .map((e) => e.summary)
        .filter((s): s is string => !!s)
      const namesPart = names.length ? `:${names.map((n) => `「${n}」`).join('、')}` : ''
      let line = `📋 系统核对:已${label} ${okEntries.length} 条${namesPart}`
      // 跳过的(重复)如实补一句
      if (skipEntries.length > 0) {
        const skipNames = skipEntries.map((e) => e.summary).filter((s): s is string => !!s)
        const skipPart = skipNames.length ? `:${skipNames.map((n) => `「${n}」`).join('、')}` : ''
        line += `(另有 ${skipEntries.length} 条重复已跳过${skipPart})`
      }
      // 失败的也如实补一句
      if (failEntries.length > 0) line += `(${failEntries.length} 条失败)`
      // 贴真实链接(只有 ≥1 条成功才贴,且整组只贴一次)
      if (spec?.linkKey) {
        const link = getLink(spec.linkKey)
        if (link) line += `\n👉 ${link}`
      }
      lines.push(line)
    } else if (skipEntries.length > 0 && failEntries.length === 0) {
      // 全部是重复跳过:告知用户,别让他以为系统坏了
      const skipNames = skipEntries.map((e) => e.summary).filter((s): s is string => !!s)
      const skipPart = skipNames.length ? `:${skipNames.map((n) => `「${n}」`).join('、')}` : ''
      lines.push(`📋 系统核对:本次 ${skipEntries.length} 条全部与维格表当天已有记录重复,已跳过${skipPart}`)
    } else {
      // 全失败(无成功无跳过):诚实声明 + 提醒重发
      lines.push(`⚠️ 系统核对:本次实际未成功${label}任何条目(尝试 ${entries.length} 次全部失败),请重发或换张清晰的图`)
    }
  }

  return lines.join('\n')
}

/**
 * LLM 文本里"声称已登记/录入客资"的关键词。
 * 用于交叉检测"账本 0 条写工具、LLM 却嘴上说成功了"的幻觉形态(本次 bug)。
 * 命中即追加系统核对戳穿,不命中则当纯闲聊放过(避免给纯聊天乱追加)。
 */
const CLAIMS_REGISTER = /已登记|已录入|已记录|登记了|录入了|给你录|帮你登|已记下|新增了|已添加|录成功|登记成功|录入成功/

/** 工具的人类可读动词(label),用于「系统核对」措辞 */
const TOOL_LABELS: Record<string, string> = {
  record_customer_info: '登记客资',
  set_reminder: '设置提醒',
  // 未来按需补
}

/**
 * 一刀切 URL 全清:删除文本里所有 http(s) 链接。
 * 不做白名单 —— 白名单(子串 includes)会被「合法域名 + 编造路径」绕过(本次 bug 的直接原因)。
 * 链接只能由 buildSystemAttestation 从 config 注入,LLM 永远不许贴。
 */
export function stripAllUrls(text: string): string {
  if (!text) return text
  return text.replace(/https?:\/\/\S+/gi, '').replace(/[ \t]+$/gm, '').trimEnd()
}

/**
 * 客户名称归一化(用于去重比对)。
 * 规则:
 *  - 去掉所有 Unicode 空白字符(普通空格、全角空格、零宽空格、Tab、换行等)
 *    —— 手机复制粘贴常带隐藏空白,只去普通空格会让去重失效
 *  - 大小写保留(用户明确:大小写不同算不同客户。代价:LLM 读图认大小写不稳定,偶尔漏判)
 *  - 首尾 trim
 * 「徐途似锦」/「徐 途 似 锦」/「徐途似锦」(全角空格)→ 归一化后都是「徐途似锦」
 */
export function normalizeName(name: string): string {
  return name.replace(/\s+/g, '').trim()
}

/**
 * 剥离客户名开头的日期前缀(如 "60717/雅琴" → "雅琴","7.13 雷思诺" → "雷思诺")。
 *
 * 为什么去重要管这个:维格表里存的是 addLead 剥离后的纯名字(见 customerLeads.ts),
 * 如果去重比对时用 LLM 传来的原始名(可能带"60717/"前缀),就跟维格表里对不上 →
 * 该判重复的判不出来 → 重复录入。所以去重前必须先剥,跟维格表存储口径一致。
 *
 * 规则(与 customerLeads.ts 的兜底正则完全一致,单一事实源):
 *  - 只剥"日期+分隔符+非空后续"
 *  - 纯数字名(如 "3")没有分隔符+后续,不会被剥,原样返回
 *  - 剥不出(不匹配)原样返回
 */
const DATE_PREFIX_RE = /^\d{1,5}(?:[.\/\-]\d{1,2}){0,2}月?\d{0,2}日?[\/\s.\-]+(.+)$/
export function stripDatePrefix(name: string): string {
  const m = name.match(DATE_PREFIX_RE)
  if (m && m[1].trim()) return m[1].trim()
  return name
}

/**
 * 把毫秒时间戳转成北京时间(Asia/Shanghai)的 YYYY-MM-DD。
 * 用于去重的"同一天"判定 —— 14:16 和 23:59 同属一天,00:00:01 跨日算下一天。
 * 必须固定 Asia/Shanghai,不能用服务器时区(否则部署到 UTC 机器上会差 8 小时)。
 */
export function dateKeyShanghai(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms)).replace(/\//g, '-')
}
