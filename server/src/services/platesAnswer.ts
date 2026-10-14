import { CANON_PORTS, PORT_ALIASES, normalizePort } from './platesNaming.js'
import { pickTopPlates } from './dailyPlates.js'

/**
 * 车牌问答的「答案拼装」(纯函数,可单测)。
 *
 * 只基于代码从本地库读出的真实数据拼答案,不经过模型编造 —— 号码/数量全部来自入参 rows。
 * 支持三类基础问法:
 *   1. 有哪些靓号        → 每个口岸挑几个(问答总是先取「最近有数据的那一天」)
 *   2. 有没有包含某数字  → 精确子串检索,有就列出来,没有就直说没有
 *   3. 某个口岸有多少个  → 逐口岸计数
 */

export interface PlateRecord {
  port: string
  number: string
  region?: string | null
  type?: string | null
  note?: string | null
}

/** 每个口岸在概览里最多列几个靓号 */
const TOP_PER_PORT = 3
/** 检索展示上限(命中太多时截断,避免回复过长) */
const MATCH_CAP = 40
/** 单口岸检索展示上限 */
const MATCH_PER_PORT_CAP = 12

function formatPlate(number: string): string {
  return `粤Z${number}港`
}

/** 2026-10-14 → 10-14 */
function md(dateKey: string): string {
  return dateKey.length >= 10 ? dateKey.slice(5) : dateKey
}

/** 口岸排序:规范口岸在前(固定次序),其余未知口岸按出现次序追加 */
export function orderPorts(ports: string[]): string[] {
  const uniq = [...new Set(ports)]
  return [...CANON_PORTS.filter((p) => uniq.includes(p)), ...uniq.filter((p) => !CANON_PORTS.includes(p))]
}

/** 命中查询里提到的口岸(简繁/口语别名都认),没有则 null */
export function findPort(query: string): string | null {
  for (const alias of Object.keys(PORT_ALIASES)) {
    if (query.includes(alias)) return PORT_ALIASES[alias]
  }
  return null
}

/**
 * 从提问里抽出「要检索的号码片段」。
 * 先剥掉日期(如「8月15号」「2026-08-15」)避免把日期数字误当号码,再取最长的连续数字串。
 * 没有数字 → null(说明不是「包含某号」的问法)。
 */
export function extractContains(query: string): string | null {
  const cleaned = query
    .replace(/\d{4}\s*[-/年]\s*\d{1,2}(\s*[-/月]\s*\d{1,2}\s*日?)?/g, '')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日?/g, '')
    .replace(/\d{1,2}\s*号/g, '')
  const runs = cleaned.match(/\d+/g)
  if (!runs || !runs.length) return null
  return runs.sort((a, b) => b.length - a.length)[0]
}

/** 问的是"数量"还是"有哪些"(数量为 count,其余为 overview) */
export function detectIntent(query: string): 'count' | 'overview' {
  return /多少|几个|几多|几多个|数量|统计|几台|有多少|总共|总数/.test(query) ? 'count' : 'overview'
}

export interface PlatesSnapshot {
  dateKey: string
  total: number
  counts: { port: string; count: number }[]
  topByPort: { port: string; numbers: string[] }[]
}

/** 按口岸汇总(用于概览/计数),口岸按规范次序排 */
export function buildSnapshot(dateKey: string, rows: PlateRecord[]): PlatesSnapshot {
  const byPort = new Map<string, PlateRecord[]>()
  for (const r of rows) {
    const arr = byPort.get(r.port) ?? []
    arr.push(r)
    byPort.set(r.port, arr)
  }
  const ports = orderPorts([...byPort.keys()])
  return {
    dateKey,
    total: rows.length,
    counts: ports.map((p) => ({ port: p, count: byPort.get(p)!.length })),
    topByPort: ports.map((p) => ({ port: p, numbers: pickTopPlates(byPort.get(p)!, TOP_PER_PORT) })),
  }
}

function buildCountAnswer(dateKey: string, counts: { port: string; count: number }[], total: number, portFilter: string | null): string {
  if (portFilter) {
    return `📅 ${md(dateKey)} ${portFilter}口岸现牌共 ${total} 个。`
  }
  const lines = counts.map((c) => `· ${c.port}:${c.count} 个`)
  return `📅 ${md(dateKey)} 各口岸现牌数量(共 ${total} 个):\n${lines.join('\n')}`
}

function buildOverviewAnswer(dateKey: string, rows: PlateRecord[], topByPort: { port: string; numbers: string[] }[], portFilter: string | null): string {
  const header = portFilter
    ? `📅 ${md(dateKey)} ${portFilter}口岸现牌靓号(共 ${rows.length} 个):`
    : `📅 ${md(dateKey)} 现牌靓号(共 ${rows.length} 个):`
  const lines = topByPort
    .filter((t) => t.numbers.length)
    .map((t) => {
      const count = rows.filter((r) => r.port === t.port).length
      return `· ${t.port}(${count}):${t.numbers.map(formatPlate).join('、')}`
    })
  return `${header}\n${lines.join('\n')}`
}

function buildSearchAnswer(dateKey: string, rows: PlateRecord[], contains: string, portFilter: string | null): string {
  const matches = rows.filter((r) => r.number.includes(contains))
  const scope = portFilter ? ` ${portFilter}口岸` : ''
  if (!matches.length) {
    return `📅 ${md(dateKey)}${scope}没有包含「${contains}」的现牌。`
  }
  // 按口岸归组展示
  const byPort = new Map<string, string[]>()
  for (const m of matches) {
    const arr = byPort.get(m.port) ?? []
    arr.push(m.number)
    byPort.set(m.port, arr)
  }
  const ports = orderPorts([...byPort.keys()])
  const lines: string[] = []
  let shown = 0
  for (const p of ports) {
    if (shown >= MATCH_CAP) break
    const nums = byPort.get(p)!
    const shownNums = nums.slice(0, MATCH_PER_PORT_CAP)
    shown += shownNums.length
    const more = nums.length > shownNums.length ? ` 等${nums.length}个` : ''
    lines.push(`· ${p}:${shownNums.map(formatPlate).join('、')}${more}`)
  }
  const tail = matches.length > shown ? `\n(命中较多,以上为部分;共 ${matches.length} 个)` : ''
  return `📅 ${md(dateKey)} 含「${contains}」的现牌共 ${matches.length} 个${scope}:\n${lines.join('\n')}${tail}`
}

/**
 * 根据用户提问 + 最近一天的现牌数据,拼出可直接回复的答案。
 * rows 为空时返回"没有数据"。
 */
export function buildPlatesAnswer(query: string, dateKey: string, rows: PlateRecord[]): string {
  const portFilter = findPort(query)
  const scoped = portFilter ? rows.filter((r) => r.port === portFilter) : rows

  if (!scoped.length) {
    return portFilter
      ? `📅 ${md(dateKey)} ${portFilter}口岸没有现牌数据。`
      : `📅 ${md(dateKey)} 暂时没有现牌数据。`
  }

  const contains = extractContains(query)
  if (contains) return buildSearchAnswer(dateKey, scoped, contains, portFilter)

  const snap = buildSnapshot(dateKey, scoped)
  if (detectIntent(query) === 'count') return buildCountAnswer(dateKey, snap.counts, snap.total, portFilter)
  return buildOverviewAnswer(dateKey, scoped, snap.topByPort, portFilter)
}
