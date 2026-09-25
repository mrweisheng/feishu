import sharp from 'sharp'
import { config } from '../config.js'
import { uploadFeishuImage, replyPostRich } from '../feishu/messages.js'

/**
 * 车源检索(carinfo HTTP API)客户端 + 群发卡片编排。
 *
 * 接入文档:SEARCHCAR.md(服务方提供);选型走 HTTP API 而非 MCP——
 * 机器人自带 tool-use loop,MCP 客户端那套会话管理纯属多余负担。
 *
 * 分层:
 * - 纯函数(有单测):clampLimit / pickImageUrls / formatCarCardLines / buildCarPostContent
 * - API 客户端:searchCars / getCarDetail / downloadCarImage
 * - 编排:searchAndDeliverCars —— 检索 → 每台车详情取图 → 下载 → 上传飞书 → 引用回复卡片
 *
 * 事实接管口径:卡片文案(价格/比价/行情)全部由代码从 API 真实数据拼装,
 * LLM 不参与车辆事实的叙述,收尾只做简短总结。
 */

/** 需求约定:每台车最多发前 6 张图 */
export const MAX_IMAGES_PER_CAR = 6

// 飞书 im/v1/images 上传上限 10MB;车源图是 CDN 缩略 jpg(实测 ~60-100KB),留足余量
const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024

// /search 默认走服务端大模型解析(实测几秒,极端被网关 60s 切断),45s 客户端超时
const SEARCH_TIMEOUT_MS = 45_000
const DETAIL_TIMEOUT_MS = 15_000
const IMAGE_TIMEOUT_MS = 20_000

// ---- 类型(API 响应子集,只声明用到的字段)----

export interface CarSearchItem {
  vehicle_id: string
  car_model: string
  car_brand?: string
  year?: number
  price?: number
  price_text?: string
  car_url?: string
  image_url?: string | null
  seats?: string | null
  engine_volume?: string | null
  mileage_km?: number | null
  age_days?: number | null
  hand_count?: number | null
  view_count?: number | null
  import_type?: string | null
  license_until?: string | null
  china_plate?: boolean
  is_swap?: boolean
  market_ref_n?: number | null
  market_basis?: string | null
  labels?: string[]
  price_verdict?: string | null
}

export interface CarDetail {
  vehicle_id: string
  images?: string[] | null
  description?: string | null
  transmission?: string | null
  fuel_type?: string | null
  [k: string]: unknown
}

export interface CarSearchResult {
  summary?: string
  items: CarSearchItem[]
  total_matched?: number
  parse_source?: string
}

/** 已发出卡片的车的极简事实(回给 LLM 收尾用,防它编) */
export interface SentCarFact {
  vehicle_id: string
  model: string
  price: string
}

export interface CarDeliveryResult {
  ok: boolean
  /** 成功发出卡片的台数(0 = 没发任何东西) */
  sent: number
  totalMatched?: number
  cars: SentCarFact[]
  failedImages?: number
  error?: string
}

// ---- 纯函数(单测覆盖)----

/** LLM 给的 limit 收敛:未传/脏值 → 默认 3;越界钳到 [1, max](防一次几十张图轰炸群) */
export function clampLimit(raw: unknown, max: number, dflt = 3): number {
  // null 要显式排除:Number(null)===0 会被当成合法值
  const n = raw == null || raw === '' ? NaN : typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.trunc(n), 1), Math.max(1, max))
}

/** 详情 images 取前 6 张;详情没图时兜底用搜索条目的封面图(单张);都没有 → 空 */
export function pickImageUrls(detailImages: string[] | null | undefined, fallbackCover?: string | null): string[] {
  const list = Array.isArray(detailImages) && detailImages.length ? detailImages : (fallbackCover ? [fallbackCover] : [])
  return list.filter((u) => typeof u === 'string' && u.startsWith('http')).slice(0, MAX_IMAGES_PER_CAR)
}

/** 里程公里数 → 香港习惯读法:52000 → 「5.2萬公里」;null → null */
function formatMileage(km: number | null | undefined): string | null {
  if (km == null || !Number.isFinite(km) || km <= 0) return null
  const wan = km / 10000
  // 整数萬直接显示,否则一位小数
  return `${wan >= 10 ? Math.round(wan) : Math.round(wan * 10) / 10}萬公里`
}

/** 车况描述截断:超过 max 字符加省略号 */
export function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 把一台车的字段拼成卡片文案行(纯函数)。
 * 可选字段缺失时整行省略,绝不输出 undefined/null 字样。
 * detail 缺失(详情接口挂了)时降级用搜索条目字段,卡片照样发。
 */
export function formatCarCardLines(item: CarSearchItem, detail?: CarDetail | null): string[] {
  const lines: string[] = []

  // 标题:🚗 2022年 ALPHARD 8 · 一手
  const handText = item.hand_count === 0 ? '一手' : item.hand_count && item.hand_count > 0 ? `${item.hand_count}手` : ''
  const title = `🚗 ${item.year ? `${item.year}年 ` : ''}${item.car_model}`.replace(/\s+/g, ' ').trim()
  lines.push(handText ? `${title} · ${handText}` : title)

  // 价格 + 比价结论(结论来自详情接口,可能没有)
  const verdict = detail?.price_verdict || item.price_verdict
  lines.push(`💰 ${item.price_text ?? '价格待询'}${verdict ? `(${verdict})` : ''}`)

  // 服务端打好的短标签:「划算 40%」「刚挂牌」「一手车」…
  if (item.labels?.length) lines.push(`✨ ${item.labels.join(' · ')}`)

  // labels 里已有的信息(浏览/行貨/水貨/中港牌/换车帖)不再往下面的行里重复拼
  const labelText = (item.labels ?? []).join(' ')
  const labelHas = (s: string): boolean => labelText.includes(s)

  // 配置行:座位 / 排量 / 波箱 / 燃料 / 进口(进口类型 labels 带过就不再拼)
  const specs = [
    item.seats,
    item.engine_volume,
    detail?.transmission,
    detail?.fuel_type,
    item.import_type && !labelHas(item.import_type) ? item.import_type : null,
  ].filter((s): s is string => !!s && s.trim() !== '')
  if (specs.length) lines.push(`⚙️ ${specs.join(' · ')}`)

  // 使用状况:里程 / 挂牌天数 / 浏览
  const usage = [
    formatMileage(item.mileage_km),
    item.age_days != null && item.age_days >= 0 ? (item.age_days === 0 ? '今天刚上' : `挂牌 ${item.age_days} 天`) : null,
    !labelHas('浏览') && item.view_count != null && item.view_count > 0 ? `浏览 ${item.view_count} 次` : null,
  ].filter((s): s is string => !!s)
  if (usage.length) lines.push(`🛤️ ${usage.join(' · ')}`)

  // 牌費 / 中港牌 / 换车帖(香港买家关心的点,有才出现;labels 已带的跳过)
  const extras = [
    item.license_until ? `牌費至 ${item.license_until}` : null,
    item.china_plate && !labelHas('中港') ? '中港牌' : null,
    item.is_swap && !labelHas('换车') ? '换车帖' : null,
  ].filter((s): s is string => !!s)
  if (extras.length) lines.push(`🧧 ${extras.join(' · ')}`)

  // 行情依据;样本太少时如实降调
  if (item.market_basis) {
    const thin = item.market_ref_n != null && item.market_ref_n > 0 && item.market_ref_n < 10
    lines.push(`📊 ${item.market_basis}${thin ? '(样本较少,仅供参考)' : ''}`)
  }

  // 车况描述(详情接口才有)
  const desc = detail?.description?.trim()
  if (desc) lines.push(`📝 ${truncateText(desc, 60)}`)

  return lines
}

// ---- post 富文本构造(纯函数,单测覆盖)----

export type PostRun =
  | { tag: 'text'; text: string }
  | { tag: 'at'; user_id: string }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'img'; image_key: string }

/**
 * 构造飞书 post 消息 content:首段 @提问人 + 标题,卡片各行一段,
 * 原帖链接一段,图片每张一段。
 */
export function buildCarPostContent(userOpenId: string, lines: string[], carUrl: string | null, imageKeys: string[]) {
  const content: PostRun[][] = []
  const first: PostRun[] = [{ tag: 'at', user_id: userOpenId }]
  // @ 后面直接跟标题行,同一paragraph内联
  if (lines.length) first.push({ tag: 'text', text: ` ${lines[0]}` })
  content.push(first)
  for (const line of lines.slice(1)) content.push([{ tag: 'text', text: line }])
  if (carUrl) content.push([{ tag: 'text', text: '🔗 ' }, { tag: 'a', text: '查看车源原帖', href: carUrl }])
  for (const key of imageKeys) content.push([{ tag: 'img', image_key: key }])
  return { zh_cn: { content } }
}

// ---- API 客户端 ----

async function carinfoFetch<T>(path: string, timeoutMs: number): Promise<T> {
  const res = await fetch(`${config.CARINFO_API_BASE}${path}`, {
    headers: { 'X-API-Key': config.CARINFO_API_KEY },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: string; error?: string; message?: string }
      detail = body.detail || body.error || body.message || ''
    } catch { /* 非 JSON 响应,只有状态码 */ }
    throw new Error(`carinfo ${path} HTTP ${res.status}${detail ? `:${detail}` : ''}`)
  }
  return (await res.json()) as T
}

/** 自然语言检索(服务端自带 LLM 解析,支持中英/粤语混合) */
export async function searchCars(query: string, limit: number): Promise<CarSearchResult> {
  const q = encodeURIComponent(query)
  return carinfoFetch<CarSearchResult>(`/search?q=${q}&limit=${limit}`, SEARCH_TIMEOUT_MS)
}

/** 单车详情(图片全量列表 + 文字描述 + 比价结论都在这) */
export async function getCarDetail(vehicleId: string): Promise<CarDetail> {
  return carinfoFetch<CarDetail>(`/vehicle/${encodeURIComponent(vehicleId)}`, DETAIL_TIMEOUT_MS)
}

function isJpegOrPng(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  return buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
}

/**
 * 下载车源图并转成飞书可上传的格式(png/jpeg 直用,webp 等走 sharp 转 jpeg)。
 * 任何一步失败返回 null(调用方跳过该图,不影响整卡发送)。
 */
export async function downloadCarImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      // CDN 对无 UA 请求可能 403,带上常规浏览器 UA
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const raw = Buffer.from(await res.arrayBuffer())
    if (raw.length === 0 || raw.length > FEISHU_IMAGE_MAX_BYTES) return null
    if (isJpegOrPng(raw)) return raw
    return await sharp(raw).jpeg({ quality: 90 }).toBuffer()
  } catch {
    return null
  }
}

// ---- 编排:检索 + 发卡 ----

export interface DeliverContext {
  originalMessageId: string
  userOpenId: string
  chatId: string
}

/**
 * 完整搜车流程:检索 → 逐台取详情图片(前 6 张)→ 下载 → 上传飞书 → 引用回复用户提问。
 * 单台车失败跳过(其余照发);全部失败才算失败。抛错仅在检索阶段(API 挂了/超时)。
 */
export async function searchAndDeliverCars(query: string, limit: number, ctx: DeliverContext): Promise<CarDeliveryResult> {
  const search = await searchCars(query, limit)
  const items = search.items ?? []
  if (items.length === 0) {
    return { ok: true, sent: 0, totalMatched: search.total_matched ?? 0, cars: [] }
  }

  let failedImages = 0
  const sentCars: SentCarFact[] = []

  // 逐台发(保持顺序);同一台车内的图片下载/上传相互并行
  for (const item of items) {
    try {
      const detail = await getCarDetail(item.vehicle_id).catch((e: any) => {
        console.warn(`【搜车】详情获取失败 ${item.vehicle_id}:`, e?.message ?? e)
        return null
      })
      const imageUrls = pickImageUrls(detail?.images, item.image_url)
      const downloads = await Promise.all(imageUrls.map((u) => downloadCarImage(u)))
      const imageKeys: string[] = []
      for (const buf of downloads) {
        if (!buf) { failedImages++; continue }
        try {
          imageKeys.push(await uploadFeishuImage(buf))
        } catch {
          failedImages++
        }
      }
      const lines = formatCarCardLines(item, detail)
      const content = buildCarPostContent(ctx.userOpenId, lines, item.car_url ?? null, imageKeys)
      await replyPostRich(ctx.originalMessageId, content)
      sentCars.push({ vehicle_id: item.vehicle_id, model: item.car_model, price: item.price_text ?? '—' })
      console.log(`🚗 已发车卡:${item.car_model} ${item.price_text ?? ''} 图 ${imageKeys.length}/${imageUrls.length} 张`)
    } catch (err: any) {
      console.error(`【搜车】单车发送失败 ${item.vehicle_id}:`, err?.response?.data?.msg || err?.message || err)
    }
  }

  if (sentCars.length === 0) {
    return { ok: false, sent: 0, cars: [], error: '候选车卡片全部发送失败,请稍后再试' }
  }
  return { ok: true, sent: sentCars.length, totalMatched: search.total_matched, cars: sentCars, failedImages }
}
