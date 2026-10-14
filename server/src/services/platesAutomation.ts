import path from 'node:path'
import fs from 'node:fs'
import { config } from '../config.js'
import { listChatFileMessagesSince } from '../db/messages.js'
import { addPlates, clearPlatesByDate, listPlatesByDate, type StoredPlate } from '../db/plates.js'
import { downloadMessageFile } from '../feishu/media.js'
import { extractDocumentText } from './docxText.js'
import { extractPlateList } from './platesExtract.js'
import { writeDailyRecordsToBitable, auditAndFixBitable, type DailyRecordGroup } from './platesBitable.js'
import { pickBestPlates, todayDateKey } from './dailyPlates.js'
import {
  normalizePort,
  portFromFileName,
  typeFromFileName,
  resolvePlatePort,
  plateStem,
  isDocFile,
  isImageFile,
  imageMediaTypeFromName,
} from './platesNaming.js'

/**
 * 每日靓号自动化(只存储,不出图)。
 *
 * 触发:监听「每日现牌输出群」的现牌文件消息 → 防抖等本批文件发完 → 一次性处理当天未处理的文件。
 * 补救:服务启动/当天中途上线时,清掉当天标记并整体重跑(上线即验证,当天问题当场暴露)。
 *
 * 素材处理策略(简化版):
 *   - 每个口岸的清单优先读**文档**(docx/txt/md/csv,解析更简单可靠);
 *   - 文档读不出来(下载失败/解析失败/提取不到车牌)时,再读**同一口岸对应的图片**(按文件名主干配对);
 *   - 文档与图片都读不出来 → **放弃该口岸**(标记已处理,不再卡住后续)。
 *
 * 产出:
 *   - 候选车牌落本地 SQLite(保留多天历史,供问答取「最近一天」);
 *   - 同步一份到飞书多维表格「最新現牌」作可视化副本。
 * 不再生成海报。
 */

// ---- 已处理消息 ID 持久化 ----

const processedFile = path.join(path.dirname(config.DB_PATH), 'daily-plates-processed.json')

function loadProcessed(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(processedFile, 'utf8'))
    if (Array.isArray(raw?.processedIds)) return new Set<string>(raw.processedIds)
  } catch { /* 首次运行无文件 */ }
  return new Set()
}

function saveProcessed(set: Set<string>): void {
  // 只留最近 500 条,防无限膨胀
  const ids = [...set].slice(-500)
  fs.writeFileSync(processedFile, JSON.stringify({ processedIds: ids }), 'utf8')
}

/** 北京时间当天 0 点的毫秒时间戳 */
function beijingTodayStartMs(): number {
  return Date.parse(`${todayDateKey()}T00:00:00+08:00`)
}

// ---- 触发与防抖 ----

let pendingTimer: NodeJS.Timeout | null = null

/** 该群出现新的现牌文件消息时调用(内部自带群过滤与防抖合并) */
export function scheduleDailyPlatesRun(chatId: string): void {
  if (!config.PLATES_SOURCE_CHAT_ID || chatId !== config.PLATES_SOURCE_CHAT_ID) return
  if (pendingTimer) return // 已有待处理批次,合并成一次跑
  console.log('📅 靓号自动化:检测到现牌文件,', Math.round(config.PLATES_BATCH_DEBOUNCE_MS / 1000), '秒后汇总提取(等同批文件发完)')
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    runDailyBatch(chatId).catch((e: any) =>
      console.error('【靓号自动化】批次执行失败:', e?.stack ?? e?.message ?? e))
  }, config.PLATES_BATCH_DEBOUNCE_MS)
  // 定时器不阻止进程退出(进程本来就常驻)
  pendingTimer.unref?.()
}

/**
 * 手动重放:清掉今天所有现牌文件的"已处理"标记,并清空今天的本地候选,再整体重跑。
 * 用于验证/排障(npm run plates:replay)——不等下一次消息,当天的问题当场暴露、当场纠正。
 */
export async function replayToday(): Promise<void> {
  const chatId = config.PLATES_SOURCE_CHAT_ID
  if (!chatId) throw new Error('PLATES_SOURCE_CHAT_ID 未配置,无法重放')
  const processed = loadProcessed()
  let removed = 0
  for (const id of listChatFileMessagesSince(chatId, beijingTodayStartMs()).map((r) => r.message_id)) {
    if (processed.delete(id)) removed++
  }
  saveProcessed(processed)
  const cleared = clearPlatesByDate(todayDateKey())
  console.log(`🔁 靓号重放:清除今天 ${removed} 条文件标记、${cleared} 行已存候选,重新处理...`)
  await runDailyBatch(chatId)
}

/** 启动重放:服务一启动就把今天的现牌消息全部重新处理一遍(上线即验证)。 */
export async function catchUpOnStartup(): Promise<void> {
  await replayToday()
}

// ---- 素材单元(文档 + 对应的兜底图片) ----

interface FileMsg {
  messageId: string
  fileKey: string
  name: string
}

/** 一个「单元」= 同一个文件名主干下的一组文件(通常一个文档 + 可选一张同内容的图片) */
interface Unit {
  stem: string
  doc?: FileMsg
  image?: FileMsg
  messageIds: string[]
}

function expectedCountFromName(name: string): number | undefined {
  return Number(name.match(/(\d+)\s*個/)?.[1]) || undefined
}

interface UnitExtraction {
  list: Awaited<ReturnType<typeof extractPlateList>>
  /** 文档路径下用于「号码必须在原文出现」审核的归一文本;图片路径为 ''(无原文可比) */
  normText: string
  fromImage: boolean
  sourceName: string
}

/**
 * 提取一个单元:文档优先;失败(下载/解析/提取)再对同一口岸的图片兜底。
 * @returns 提取结果(plates 非空);两者都读不出来返回 null(调用方放弃该口岸)。
 */
async function extractUnit(u: Unit): Promise<UnitExtraction | null> {
  if (u.doc) {
    const buf = await downloadMessageFile(u.doc.messageId, u.doc.fileKey)
    const text = buf ? extractDocumentText(u.doc.name, buf, 60_000) : null
    if (text && text.trim()) {
      const list = await extractPlateList('', [], text, { expectedCount: expectedCountFromName(u.doc.name) })
      if (list && list.plates.length) {
        return { list, normText: text.replace(/\s+/g, ''), fromImage: false, sourceName: u.doc.name }
      }
      console.warn(`📅 靓号:文档提取不到车牌(${u.doc.name}),尝试对应图片兜底`)
    } else {
      console.warn(`📅 靓号:文档无法解析(${u.doc.name}),尝试对应图片兜底`)
    }
  }
  if (u.image) {
    const buf = await downloadMessageFile(u.image.messageId, u.image.fileKey)
    if (buf) {
      const base64 = buf.toString('base64')
      const mediaType = imageMediaTypeFromName(u.image.name)
      const list = await extractPlateList('', [{ base64, mediaType }], '')
      if (list && list.plates.length) {
        console.log(`🖼️ 靓号:由图片兜底提取成功(${u.image.name})`)
        return { list, normText: '', fromImage: true, sourceName: u.image.name }
      }
      console.warn(`📅 靓号:图片也提取不到车牌(${u.image.name})`)
    } else {
      console.warn(`📅 靓号:图片下载失败(${u.image.name})`)
    }
  }
  return null
}

// ---- 批次执行 ----

async function runDailyBatch(chatId: string): Promise<void> {
  const today = todayDateKey()
  const processed = loadProcessed()

  // 当天未处理的 file 消息 → 解析文件名,归入「文档 / 图片」单元
  const rows = listChatFileMessagesSince(chatId, beijingTodayStartMs())
    .filter((r) => r.message_type === 'file' && !processed.has(r.message_id))
  const units = new Map<string, Unit>()
  for (const r of rows) {
    let fileKey = ''
    let name = ''
    try {
      const c = JSON.parse(r.content || '{}')
      fileKey = c.file_key
      name = c.file_name || c.name || ''
    } catch { /* content 解析失败按无名处理 */ }
    if (!fileKey || (!isDocFile(name) && !isImageFile(name))) {
      console.warn(`📅 靓号:跳过非清单文件「${name || '(无名)'}」(标记已处理)`)
      processed.add(r.message_id)
      continue
    }
    const stem = plateStem(name)
    const u = units.get(stem) ?? { stem, messageIds: [] }
    u.messageIds.push(r.message_id)
    const fm: FileMsg = { messageId: r.message_id, fileKey, name }
    if (isDocFile(name)) {
      if (!u.doc) u.doc = fm
    } else if (!u.image) {
      u.image = fm
    }
    units.set(stem, u)
  }

  // 文件名带口岸的清单在前、混装文档(补充资料)在后:去重时同号码优先保留口岸来源更可靠的
  const unitList = [...units.values()].sort((a, b) => {
    const pa = portFromFileName(a.doc?.name ?? a.image?.name ?? '') ? 0 : 1
    const pb = portFromFileName(b.doc?.name ?? b.image?.name ?? '') ? 0 : 1
    return pa - pb
  })
  if (unitList.length === 0) {
    saveProcessed(processed)
    console.log('📅 靓号自动化:没有待处理的现牌文件,跳过')
    return
  }
  console.log(`📅 靓号自动化:开始处理 ${unitList.length} 个现牌单元`)

  const toStore: StoredPlate[] = []
  // 跨单元去重:同一口岸同一号码只保留第一次(补充资料常与高新清单重叠)
  const seenNumbers = new Map<string, Set<string>>()
  for (const u of unitList) {
    const label = u.doc?.name ?? u.image?.name ?? u.stem
    try {
      const extracted = await extractUnit(u)
      if (!extracted || !extracted.list || !extracted.list.plates.length) {
        console.warn(`📅 靓号:${label} 文档与图片都读不出来,放弃该口岸`)
        for (const id of u.messageIds) processed.add(id)
        continue
      }
      const { list, normText, fromImage, sourceName } = extracted
      // 口岸优先取文件名(格式固定);文件名没有口岸的(补充资料等混装文档)交给逐条解析
      const filePort = portFromFileName(sourceName) ?? (list.port ? normalizePort(list.port) : null)
      for (const p of list.plates) {
        // ── 审核①:文档路径下号码必须能在原文里找到(保证与原始一致);图片路径无原文可比 ──
        if (normText && !normText.includes(p.number)) {
          console.warn(`🛡️ 审核:号码 ${p.number} 在原文中找不到,已剔除(${sourceName})`)
          continue
        }
        // ── 审核②:逐条归口。文件名带口岸的整文件从属;混装文档逐条解析,归不了口即剔除 ──
        const port = filePort ?? resolvePlatePort(p, normText)
        if (!port) {
          console.warn(`🛡️ 审核:${p.number} 归不了口岸(原文/模型均无口岸信息),已剔除(${sourceName})`)
          continue
        }
        // ── 审核③:跨单元去重(同口岸同号码只保留第一次) ──
        const seen = seenNumbers.get(port) ?? new Set<string>()
        if (seen.has(p.number)) {
          console.log(`🛡️ 审核:号码 ${p.number} 已存在(${port}),跳过重复(${sourceName})`)
          continue
        }
        seen.add(p.number)
        seenNumbers.set(port, seen)
        toStore.push({
          dateKey: today,
          port,
          type: typeFromFileName(sourceName, port),
          region: p.region,
          number: p.number,
          note: p.note ?? null,
          sourceFile: sourceName,
          fromImage,
        })
      }
      for (const id of u.messageIds) processed.add(id)
      console.log(`📅 靓号:${label} → 累计候选 ${toStore.length} 个(审核通过)`)
    } catch (err: any) {
      // 未预期异常:保持未处理,等下次批次/启动重放补救(不静默丢数据)
      console.error(`【靓号自动化】处理单元失败 ${label}:`, err?.stack ?? err?.message ?? err)
    }
  }

  // 落本地库(多天历史,幂等)
  const added = addPlates(toStore)
  console.log(`📅 靓号自动化:本地库新增 ${added} 个候选(当天库存 ${listPlatesByDate(today).length} 个)`)

  // 同步飞书多维表格:写最近一天的完整清单(本地为准),再读回审核
  const groups = buildGroupsFromStore(today)
  if (groups.length) {
    await writeDailyRecordsToBitable(today, groups)
    await auditAndFixBitable(today, groups)
  }

  saveProcessed(processed)
  console.log(`📅 靓号自动化:批次完成,新增 ${added} 个候选,覆盖 ${groups.length} 个口岸/类型分组`)
}

/** 从本地库读出某天全部候选,按 口岸+类型+来源文件 分组(供多维表格写入),并标注各口岸精选号 */
function buildGroupsFromStore(dateKey: string): DailyRecordGroup[] {
  const rows = listPlatesByDate(dateKey)
  if (!rows.length) return []

  // 每个口岸的「今日精選」= 该口岸全部号码里分最高的两个
  const ports = [...new Set(rows.map((r) => r.port))]
  const picksByPort = new Map<string, string[]>()
  for (const port of ports) {
    const picks = pickBestPlates(rows.filter((r) => r.port === port).map((r) => ({ region: r.region ?? '粤Z', number: r.number })))
    picksByPort.set(port, picks ? picks.map((p) => p.number) : [])
  }

  const byKey = new Map<string, DailyRecordGroup>()
  for (const r of rows) {
    const key = `${r.port}|${r.type ?? ''}|${r.sourceFile ?? ''}`
    let g = byKey.get(key)
    if (!g) {
      g = {
        port: r.port,
        type: r.type ?? '現牌',
        sourceFile: r.sourceFile ?? '',
        plates: [],
        selectedNumbers: picksByPort.get(r.port) ?? [],
      }
      byKey.set(key, g)
    }
    g.plates.push({ region: r.region ?? '粤Z', number: r.number, note: r.note ?? undefined })
  }
  return [...byKey.values()]
}
