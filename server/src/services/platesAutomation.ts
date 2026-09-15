import path from 'node:path'
import { config } from '../config.js'
import { listChatFileMessagesSince } from '../db/messages.js'
import { downloadMessageFile } from '../feishu/media.js'
import { sendPostWithImage, uploadFeishuImage } from '../feishu/messages.js'
import { extractDocumentText } from './docxText.js'
import { extractPlateList } from './platesFlow.js'
import { writeDailyRecordsToBitable } from './platesBitable.js'
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

export interface CandidatePlate {
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

/** 从文件名解析类型:如「0915-深圳灣高新現牌-23個.docx」→ 高新現牌 */
function typeFromFileName(name: string, portKey: string): string {
  let t = name
    .replace(/\.[^.]+$/, '') // 去扩展名
    .replace(/^\d{3,4}-/, '') // 去日期前缀
    .replace(new RegExp(portKey, 'g'), '') // 去口岸名
    .replace(/-\d+\s*個.*$/, '') // 去「-23個」尾巴
  t = t.replace(/^[-_\s]+|-[-_\s]+$/g, '').trim()
  return t || '現牌'
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

/**
 * 手动重放:清除今天所有现牌文件的"已处理"标记后重新跑一遍批次。
 * 用于验证/排障(npm run plates:replay)——不等下一次消息,当天的问题当场暴露、当场重出。
 * 注意:会在输出群重新发海报(旧海报不会撤回)。
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
  console.log(`🔁 靓号重放:已清除今天 ${removed} 条文件的已处理标记,重新处理...`)
  await runDailyBatch(chatId)
}

/** 启动重放:服务一启动就把今天的现牌消息全部重新处理一遍(清除当天已处理标记)。
 * 用于每次上线即验证当天产出;之后按正常流程标记,处理过的不再重复。 */export async function catchUpOnStartup(): Promise<void> {
  await replayToday()
}

// ---- 批次执行 ----

async function runDailyBatch(chatId: string): Promise<void> {
  const processed = loadProcessed()
  // 未处理的消息:docx 进管线;png 等直接标记已处理(内容与 docx 相同,单独处理没有意义)
  const rows = listChatFileMessagesSince(chatId, beijingTodayStartMs())
    .filter((r) => r.message_type === 'file' && !processed.has(r.message_id))
  const files: { messageId: string; fileKey: string; name: string }[] = []
  for (const r of rows) {
    let fileKey = ''
    let name = ''
    try {
      const c = JSON.parse(r.content || '{}')
      fileKey = c.file_key
      name = c.file_name || c.name || ''
    } catch { /* content 解析失败按无名处理 */ }
    if (!fileKey || !/\.docx?$/i.test(name)) {
      console.warn(`📅 靓号自动化:跳过非 docx 文件「${name || '(无名)'}」(标记已处理)`)
      processed.add(r.message_id)
      continue
    }
    files.push({ messageId: r.message_id, fileKey, name })
  }
  if (files.length === 0) {
    saveProcessed(processed)
    console.log('📅 靓号自动化:没有待处理的现牌 docx,跳过')
    return
  }
  console.log(`📅 靓号自动化:开始处理 ${files.length} 个现牌文件`)

  // 按口岸汇总;记录每个文件归属的口岸,用于成功后精准标记
  const byPort = new Map<string, { plates: CandidatePlate[] }>()
  const portOfFile = new Map<string, string>()
  // 供多维表格入库:每个文件的口岸/类型/候选明细
  const fileGroups: { port: string; type: string; sourceFile: string; plates: CandidatePlate[] }[] = []
  for (const f of files) {
    try {
      const buf = await downloadMessageFile(f.messageId, f.fileKey)
      const docText = buf ? extractDocumentText(f.name, buf, 60_000) : null
      if (!docText) {
        console.warn(`【靓号自动化】文档无法解析: ${f.name}(保持未处理,下次补救重试)`)
        continue
      }
      const list = await extractPlateList('', [], docText, {
        expectedCount: Number(f.name.match(/(\d+)\s*個/)?.[1]) || undefined,
      })
      if (!list || !list.plates.length) {
        console.warn(`【靓号自动化】文档提取不到车牌: ${f.name}(保持未处理,下次补救重试)`)
        continue
      }
      // 口岸优先取文件名(格式固定),提取结果做兜底
      const portKey = portFromFileName(f.name) ?? normalizePort(list.port)
      portOfFile.set(f.messageId, portKey)
      const agg = byPort.get(portKey) ?? { plates: [] }
      agg.plates.push(...list.plates)
      byPort.set(portKey, agg)
      fileGroups.push({ port: portKey, type: typeFromFileName(f.name, portKey), sourceFile: f.name, plates: list.plates })
      console.log(`📅 靓号自动化:${f.name} → ${portKey} ${list.plates.length} 个候选`)
    } catch (err: any) {
      console.error(`【靓号自动化】处理文件失败 ${f.name}:`, err?.message ?? err)
    }
  }

  // 每个口岸出一张海报,发到输出群(chat_id 直发);精选号留档,供多维表格打勾
  const orderedPorts = [...CANON_PORTS, ...[...byPort.keys()].filter((p) => !CANON_PORTS.includes(p))]
  const donePorts = new Set<string>() // 出图成功 or 合法跳过(候选不足)
  const picksByPort = new Map<string, [PlatePick, PlatePick]>()
  for (const port of orderedPorts) {
    const group = byPort.get(port)
    if (!group) continue
    if (group.plates.length < 2) {
      console.warn(`📅 靓号自动化:${port} 候选只有 ${group.plates.length} 个,不足 2 个,跳过`)
      donePorts.add(port) // 合法跳过也算处理完,避免每次启动反复重试
      continue
    }
    picksByPort.set(port, pickBestPlates(group.plates) as [PlatePick, PlatePick])
  }

  // 先入库拿多维表格链接(海报文案附上),再发海报;入库失败不影响海报
  const bitableUrl = await writeDailyRecordsToBitable(
    todayDateKey(),
    fileGroups.map((g) => ({ ...g, selectedNumbers: (picksByPort.get(g.port) ?? []).map((p) => p.number) })),
  )

  let okCount = 0
  for (const port of orderedPorts) {
    const picks = picksByPort.get(port)
    if (!picks) continue
    try {
      // 打码避让:两张海报位的打码形态不能一样(如 9G88/9H88 都遮中间会都变成 9*88)
      const masked1 = maskPlateNumber(picks[0].number)
      const masked2 = maskPlateNumber(picks[1].number, [masked1])
      const maskedLine = picks.map((p, i) => `${p.region}·${i === 0 ? masked1 : masked2}·港`).join(' / ')
      const jpeg = await renderDailyPlateCard({
        port,
        picks,
        dateKey: todayDateKey(),
      })
      const imageKey = await uploadFeishuImage(jpeg)
      await sendPostWithImage(
        config.PLATES_OUTPUT_CHAT_ID,
        imageKey,
        `🇭🇰 ${port}口岸 今日靚號已精選(${maskedLine}) 👇`,
        bitableUrl ? { text: '📋 完整候選清單(最新現牌)', url: bitableUrl } : undefined,
      )
      donePorts.add(port)
      okCount++
      console.log(`🖼️ 靓号海报已发送: ${port}, 候选 ${byPort.get(port)!.plates.length} 个, picks= [${picks[0].number}(→${masked1}), ${picks[1].number}(→${masked2})]`)
    } catch (err: any) {
      console.error(`【靓号自动化】${port} 出图失败(文件保持未处理,下次补救重试):`, err?.stack ?? err?.message ?? err)
    }
  }

  // 标记策略:只有「成功出图的口岸」和「合法跳过的口岸」对应的文件才标已处理;
  // 提取失败/出图失败的文件保持未处理,下次启动补救时自动重试。
  for (const f of files) {
    const port = portOfFile.get(f.messageId)
    if (port && donePorts.has(port)) processed.add(f.messageId)
  }
  saveProcessed(processed)
  console.log(`📅 靓号自动化:批次完成,${orderedPorts.filter((p) => byPort.has(p)).length} 个口岸,成功出图 ${okCount} 张`)
}
