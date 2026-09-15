import type Anthropic from '@anthropic-ai/sdk'
import { anthropic, modelName } from '../ai/model.js'
import { config } from '../config.js'
import { downloadMessageImage, downloadMessageFile } from '../feishu/media.js'
import { uploadFeishuImage, replyPostWithImage, replyMessage } from '../feishu/messages.js'
import { extractDocumentText } from './docxText.js'
import { maskPlateNumber, pickBestPlates, renderDailyPlateCard, todayDateKey, type PlatePick } from './dailyPlates.js'
import type { LlmContext } from '../llm.js'

/**
 * 每日靓号推荐 —— 确定性管线(2026-09-15 重构)。
 *
 * 旧方案把「视觉提取 + 选号决策 + 大 JSON 工具调用」全压给模型一次完成,
 * 任何一环抖动(不调工具/挑号不合规则/兼容层 stop_reason 异常)整条链就断,稳定性差。
 *
 * 新分工:**模型只做语义提取(口岸+全部车牌,带校验重试),其余全部代码确定性执行**:
 *   提取(port + 候选车牌) → 选号(pickBestPlates 规则打分) → 打码(maskPlateNumber)
 *   → 渲染(puppeteer 模板) → 上传回复(飞书)。
 * 模型不再需要输出工具调用,也就没有"不调工具/调错参数"这类失败模式;
 * 选号永远符合规则、永远可复现。
 */

interface CandidatePlate {
  region: string
  number: string
  note?: string
}

export interface ExtractedList {
  port: string
  portEn?: string
  plates: CandidatePlate[]
}

const EXTRACT_PROMPT = `你是车牌清单提取器。从素材(截图/文字/文档内容)里提取口岸和全部粤Z两地车牌,输出一个 JSON 对象,不要输出任何其他文字:

{
  "port": "口岸中文名(繁体),如「蓮塘」「深圳灣」「港珠澳大橋」;素材没有明确口岸则填空字符串",
  "port_en": "口岸英文名,没有就填空字符串",
  "plates": [
    { "region": "粤Z", "number": "JS75", "note": "批文/状态备注,没有就省略" }
  ]
}

要求:
- 全部车牌原样抄录,一个不漏、不改字;number 只含号牌主体(如 JS75),不含「粤Z」前缀和「港」后缀
- 素材里没有车牌或车牌少于 2 个,plates 返回空数组
- 只提取,不挑选、不评价、不解读号码`

/** 从模型回复里抠出 JSON(容忍 ```json 围栏) */
function parseJsonLoose(text: string): any {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = m ? m[1] : text
  return JSON.parse(raw.trim())
}

function isValidPlate(p: any): boolean {
  return (
    p && typeof p.region === 'string' && p.region.trim() &&
    typeof p.number === 'string' && /^[A-Z0-9]{2,6}$/i.test(p.number.replace(/\s+/g, ''))
  )
}

/**
 * 调模型提取口岸+车牌列表(最多 attempts 次:提取失败/JSON 不合法/被截断都重试)。
 * 返回 null 表示重试后仍提取不出有效结构。
 */
export async function extractPlateList(
  userText: string,
  images: { base64: string; mediaType: 'image/jpeg' | 'image/png' }[],
  docText: string,
  attempts = 2,
): Promise<ExtractedList | null> {
  const content: Anthropic.MessageParam['content'] = []
  const leadText = [userText, docText].filter((t) => t?.trim()).join('\n\n')
  if (leadText) content.push({ type: 'text', text: leadText })
  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })
  }
  content.push({ type: 'text', text: EXTRACT_PROMPT })

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await anthropic.messages.create({
        model: modelName,
        max_tokens: config.LLM_MAX_TOKENS,
        messages: [{ role: 'user', content }],
      })
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      const json = parseJsonLoose(text)
      const port = typeof json?.port === 'string' ? json.port.trim() : ''
      const plates = Array.isArray(json?.plates)
        ? json.plates.filter(isValidPlate).map((p: any) => ({
            region: p.region.trim().toUpperCase(),
            number: p.number.replace(/\s+/g, '').toUpperCase(),
            ...(typeof p.note === 'string' && p.note.trim() ? { note: p.note.trim() } : {}),
          }))
        : []
      if (!port) {
        console.warn(`【靓号提取】第 ${i + 1} 次无口岸,重试...`)
        continue
      }
      console.log(`🔍 靓号提取成功(第 ${i + 1} 次): port=${port}, plates=${plates.length} 个`)
      return { port, portEn: typeof json?.port_en === 'string' && json.port_en.trim() ? json.port_en.trim() : undefined, plates }
    } catch (err: any) {
      console.warn(`【靓号提取】第 ${i + 1} 次失败: ${err.message}`)
    }
  }
  return null
}

/**
 * 靓号管线入口:@消息里带图/文档时先走这条。
 * 返回 true = 已按靓号流程处理(出图或给出引导提示),调用方不再走普通 LLM 问答;
 * 返回 false = 素材不是车牌清单(提取不出口岸+车牌),交给普通 LLM 流程。
 */
export async function tryRunDailyPlatesFlow(ctx: LlmContext, userText: string): Promise<boolean> {
  // 1. 收集素材:图片下载压缩、文档提取文字
  const images: { base64: string; mediaType: 'image/jpeg' | 'image/png' }[] = []
  for (let i = 0; i < (ctx.voucherImageKeys?.length ?? 0); i++) {
    const key = ctx.voucherImageKeys![i]
    const messageId = ctx.imageMessageIds?.[i] || ctx.originalMessageId
    const img = await downloadMessageImage(messageId, key)
    if (img) images.push({ base64: img.base64, mediaType: img.mediaType as 'image/jpeg' | 'image/png' })
  }
  let docText = ''
  for (let i = 0; i < (ctx.voucherFileKeys?.length ?? 0); i++) {
    const f = ctx.voucherFileKeys![i]
    const messageId = ctx.fileMessageIds?.[i] || ctx.originalMessageId
    const buf = await downloadMessageFile(messageId, f.key)
    if (buf) docText += (docText ? '\n' : '') + (extractDocumentText(f.name, buf) ?? '')
  }
  if (!images.length && !docText) return false

  // 2. 模型提取(仅提取,带重试)
  const list = await extractPlateList(userText, images, docText)
  if (!list || !list.port || list.plates.length === 0) return false // 不是车牌素材 → 普通问答

  // 3. 候选不足 2 个:不生成,引导补齐(产品规则:海报必须有两个号对比)
  if (list.plates.length < 2) {
    await replyMessage(
      ctx.originalMessageId,
      `<at user_id="${ctx.userOpenId}"></at> 收到,${list.port}口岸的靓号推荐至少要有 2 个候选车牌才能对比着挑,麻烦把清单补全再发一次 🙏`,
    )
    return true
  }

  // 4. 选号(规则打分,确定性)+ 打码 + 渲染 + 上传回复
  const picks = pickBestPlates(list.plates)
  if (!picks) return false
  try {
    const jpeg = await renderDailyPlateCard({
      port: list.port,
      portEn: list.portEn,
      picks: picks as [PlatePick, PlatePick],
      dateKey: todayDateKey(),
    })
    const imageKey = await uploadFeishuImage(jpeg)
    const maskedLine = picks.map((p) => `${p.region}·${maskPlateNumber(p.number)}·港`).join(' / ')
    await replyPostWithImage(
      ctx.originalMessageId,
      ctx.userOpenId,
      imageKey,
      `🇭🇰 ${list.port}口岸 今日靚號已精選(${maskedLine}),海報如下 👇`,
    )
    console.log(`🖼️ 靓号海报已回复: port=${list.port}, 候选=${list.plates.length}, picks=`, picks.map((p) => `${p.number}(→${maskPlateNumber(p.number)})`))
    return true
  } catch (err: any) {
    console.error('【靓号海报生成/发送失败】', err?.stack ?? err?.message ?? err)
    await replyMessage(
      ctx.originalMessageId,
      `<at user_id="${ctx.userOpenId}"></at> 靓号挑好了,但出图环节失败了(${err.message}),麻烦稍后再发一次 🙏`,
    ).catch(() => {})
    return true
  }
}
