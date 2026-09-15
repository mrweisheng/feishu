import path from 'node:path'
import { config } from '../config.js'
import { listChatFileMessagesSince } from '../db/messages.js'
import { downloadMessageFile } from '../feishu/media.js'
import { sendPostWithImage, uploadFeishuImage } from '../feishu/messages.js'
import { extractDocumentText } from './docxText.js'
import { extractPlateList } from './platesFlow.js'
import { maskPlateNumber, pickBestPlates, renderDailyPlateCard, todayDateKey, type PlatePick } from './dailyPlates.js'
import fs from 'node:fs'

/**
 * 每日靓号自动化:监听「每日现牌输出群」的现牌文件,自动汇总各口岸出海报。
 *
 * 触发:该群出现 file 消息(docx 现牌清单)→ 防抖等本批文件发完 → 一次性处理当天全部未处理文件。
 * 补救:服务启动/当天中途上线时,查当天消息里未处理的文件补跑(消息已由历史补漏/实时归档入库)。
 * 汇总:同一口岸多种类型(高新/納稅/高型…)的清单合并为一个候选池,再规则选号出一张海报;
 *       通常 4 个口岸(深圳灣/蓮塘/沙頭角/港珠澳)出 4 张,回复到该群对应文件消息下面。
 * 已处理消息 ID 持久化,重启不会重复出图。
 */

interface CandidatePlate {
  region: string
  number: string
  note?: string
}

const CANON_PORTS = ['深圳灣', '蓮塘', '沙頭角', '港珠澳']
const PORT_ALIASES: Record<string, string> = {
  '深圳湾': '深圳灣', '深圳灣': '深圳灣',
  '莲塘': '蓮塘', '蓮塘': '蓮塘',
  '沙头角': '沙頭角', '沙頭角': '沙頭角',
  '港珠澳': '港珠澳', '港珠澳大橋': '港珠澳', '港珠澳大桥': '港珠澳',
}

function normalizePort(name: string): string {
  const bare = name.replace(/口岸$/, '').trim()
  return PORT_ALIASES[bare] ?? bare
}

/** 从文件名解析口岸:如「0915-深圳灣高新現牌-23個.docx」→ 深圳灣 */
function portFromFileName(name: string): string | null {
  for (const alias of Object.keys(PORT_ALIASES)) {
    if (name.includes(alias)) return PORT_ALIASES[alias]
  }
  return null
}

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
  console.log('📅 靓号自动化:检测到现牌文件,', Math.round(config.PLATES_BATCH_DEBOUNCE_MS / 1000), '秒后汇总生成(等同批文件发完)')
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    runDailyBatch(chatId).catch((e: any) =>
      console.error('【靓号自动化】批次执行失败:', e?.stack ?? e?.message ?? e))
  }, config.PLATES_BATCH_DEBOUNCE_MS)
  // 定时器不阻止进程退出(进程本来就常驻)
  pendingTimer.unref?.()
}

/** 启动补救:当天已有现牌文件但未处理(如上午发布、下午才上线),补跑一次 */
export async function catchUpOnStartup(): Promise<void> {
  const chatId = config.PLATES_SOURCE_CHAT_ID
  if (!chatId) return
  const unprocessed = listUnprocessed(chatId)
  if (unprocessed.length > 0) {
    console.log(`📅 靓号自动化:发现今天 ${unprocessed.length} 条未处理的现牌文件,启动补救流程`)
    await runDailyBatch(chatId)
  } else {
    console.log('📅 靓号自动化:今天暂无未处理的现牌文件')
  }
}

function listUnprocessed(chatId: string): { messageId: string; fileKey: string; name: string }[] {
  const processed = loadProcessed()
  return listChatFileMessagesSince(chatId, beijingTodayStartMs())
    .filter((r) => r.message_type === 'file' && !processed.has(r.message_id))
    .map((r) => {
      try {
        const c = JSON.parse(r.content || '{}')
        // 飞书 file 消息的文件名字段是 file_name(旧版兼容 name)
        return { messageId: r.message_id, fileKey: c.file_key, name: c.file_name || c.name || '' }
      } catch {
        return { messageId: r.message_id, fileKey: '', name: '' }
      }
    })
    .filter((f) => {
      if (!f.fileKey) return false
      if (!/\.docx?$/i.test(f.name)) {
        console.warn(`📅 靓号自动化:跳过非 docx 文件「${f.name || '(无名)'}」`)
        return false
      }
      return true
    })
}

// ---- 批次执行 ----

async function runDailyBatch(chatId: string): Promise<void> {
  const files = listUnprocessed(chatId)
  if (files.length === 0) {
    console.log('📅 靓号自动化:没有未处理的现牌文件,跳过')
    return
  }
  console.log(`📅 靓号自动化:开始处理 ${files.length} 个现牌文件`)

  // 按口岸汇总(优先 docx:同批的 png 内容相同,跳过)
  const byPort = new Map<string, { plates: CandidatePlate[] }>()
  for (const f of files) {
    if (!/\.docx?$/i.test(f.name)) continue // png 等跳过(内容与 docx 相同)
    try {
      const buf = await downloadMessageFile(f.messageId, f.fileKey)
      const docText = buf ? extractDocumentText(f.name, buf, 60_000) : null
      if (!docText) {
        console.warn(`【靓号自动化】文档无法解析,跳过: ${f.name}`)
        continue
      }
      const list = await extractPlateList('', [], docText)
      if (!list || !list.plates.length) {
        console.warn(`【靓号自动化】文档提取不到车牌,跳过: ${f.name}`)
        continue
      }
      // 口岸优先取文件名(格式固定),提取结果做兜底
      const portKey = portFromFileName(f.name) ?? normalizePort(list.port)
      const agg = byPort.get(portKey) ?? { plates: [] }
      agg.plates.push(...list.plates)
      byPort.set(portKey, agg)
      console.log(`📅 靓号自动化:${f.name} → ${portKey} ${list.plates.length} 个候选`)
    } catch (err: any) {
      console.error(`【靓号自动化】处理文件失败 ${f.name}:`, err?.message ?? err)
    }
  }

  // 每个口岸出一张海报,回复到该口岸最后一条文件消息下面
  const orderedPorts = [...CANON_PORTS, ...[...byPort.keys()].filter((p) => !CANON_PORTS.includes(p))]
  let okCount = 0
  for (const port of orderedPorts) {
    const group = byPort.get(port)
    if (!group) continue
    if (group.plates.length < 2) {
      console.warn(`📅 靓号自动化:${port} 候选只有 ${group.plates.length} 个,不足 2 个,跳过`)
      continue
    }
    try {
      const picks = pickBestPlates(group.plates) as [PlatePick, PlatePick]
      const jpeg = await renderDailyPlateCard({
        port,
        picks,
        dateKey: todayDateKey(),
      })
      const imageKey = await uploadFeishuImage(jpeg)
      const maskedLine = picks.map((p) => `${p.region}·${maskPlateNumber(p.number)}·港`).join(' / ')
      await sendPostWithImage(config.PLATES_OUTPUT_CHAT_ID, imageKey, `🇭🇰 ${port}口岸 今日靚號已精選(${maskedLine}),海報如下 👇`)
      okCount++
      console.log(`🖼️ 靓号海报已发送: ${port}, 候选 ${group.plates.length} 个, picks=`, picks.map((p) => `${p.number}(→${maskPlateNumber(p.number)})`))
    } catch (err: any) {
      console.error(`【靓号自动化】${port} 出图失败:`, err?.stack ?? err?.message ?? err)
    }
  }

  // 无论成败都标记已处理:失败重跑靠用户手动 @,避免每天自动反复重试
  const processed = loadProcessed()
  for (const f of files) processed.add(f.messageId)
  saveProcessed(processed)
  console.log(`📅 靓号自动化:批次完成,${orderedPorts.filter((p) => byPort.has(p)).length} 个口岸,成功出图 ${okCount} 张`)
}
