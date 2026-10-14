import type Anthropic from '@anthropic-ai/sdk'
import { anthropic, modelName } from '../ai/model.js'
import { config } from '../config.js'
import type { CandidatePlate } from './platesNaming.js'

/**
 * 车牌清单提取(仅语义提取,确定性执行留给代码)。
 *
 * 模型只做一件事:从素材(文档纯文字 / 图片)里读出「口岸 + 全部车牌」,输出 JSON。
 * 不选号、不评价、不解读 —— 选号/统计/存储全由代码确定性完成,避免模型抖动导致链路断掉。
 *
 * 素材优先用文档纯文字(见 docxText.ts);文档读不出来时,调用方改用同一口岸的图片兜底
 * (extractPlateList 支持 images 入参)。
 */

export interface ExtractedList {
  port: string
  portEn?: string
  plates: CandidatePlate[]
}

const EXTRACT_PROMPT = `你是车牌清单提取器。从素材(截图/文字/文档内容)里提取口岸和全部粤Z两地车牌,输出一个 JSON 对象,不要输出任何其他文字:

{
  "port": "整篇素材的口岸中文名(繁体),如「蓮塘」「深圳灣」「港珠澳大橋」;素材没有明确口岸、或混合了多个口岸(如补充资料),则填空字符串",
  "port_en": "口岸英文名,没有就填空字符串",
  "plates": [
    { "region": "粤Z", "number": "JS75", "port": "该车牌所属口岸,没有明确写就填空字符串", "note": "批文/状态备注,没有就省略" }
  ]
}

要求:
- 全部车牌原样抄录,一个不漏、不改字;表格可能左右两栏并排,右半边也要提取
- number 填号牌主体,如表格里「粤Z5P16 港」→ number 填「Z5P16」
- 口岸写在车牌原文里的(如「粵Z9H88港深圳灣」「5F55港大橋」),把「深圳灣」「大橋」填到该条的 port,不要丢弃
- 素材里没有车牌或车牌少于 2 个,plates 返回空数组
- 只提取,不挑选、不评价、不解读号码`

/** 从模型回复里抠出 JSON(容忍 ```json 围栏) */
function parseJsonLoose(text: string): any {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = m ? m[1] : text
  return JSON.parse(raw.trim())
}

/**
 * 抢救式归一化:模型返回的车牌写法千变万化(「粤Z5P16 港」「粵Z5P16港」「Z5P16」、
 * 全角字符、带分隔符…),一律归一成标准形 { region:'粤Z', number:'Z5P16' }。
 * 不做格式硬校验,能救就救;救不出合法号牌结构才丢弃。
 */
function normalizePlateEntry(p: any): CandidatePlate | null {
  if (!p || typeof p !== 'object') return null
  const region = typeof p.region === 'string' ? p.region : ''
  const number = typeof p.number === 'string' ? p.number : ''
  // 全角(Ａ-Ｚ ０-９ 等)→ 半角,统一大写
  let token = (region + ' ' + number)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
  // 去空白和各种分隔符
  token = token.replace(/[\s·・.,。:：\-—_/\\()（）「」『』]/g, '')
  // 剥前缀 粤/粵
  token = token.replace(/^[粤粵]+/, '')
  // 剥跨境序列码 Z(号牌固定结构 = 粤Z + 4 位主体,如 粤Z9E66/粤ZJS75)
  if (token.startsWith('Z')) token = token.slice(1)
  // 号码主体固定 4 位;超长说明前面还混着序列码,取尾部 4 位
  if (token.length > 4) token = token.slice(-4)
  if (!/^[A-Z0-9]{3,4}$/.test(token)) return null
  // 号码主体至少含一位数字(纯字母串像地名缩写,多半是误提取)
  if (!/\d/.test(token)) return null
  // note/逐条口岸原样保留(口岸归口审核依赖它们;以前在这里被丢掉导致补充资料整文件错归口)
  const out: CandidatePlate = { region: '粤Z', number: token }
  if (typeof p.port === 'string' && p.port.trim()) out.port = p.port.trim()
  if (typeof p.note === 'string' && p.note.trim()) out.note = p.note.trim()
  return out
}

/**
 * 调模型提取口岸+车牌列表(最多 attempts 次:提取失败/JSON 不合法/数量对不上都重试)。
 * expectedCount:文件名里标的数量(如「23個」),提取不足时触发重试并附纠正提示。
 * 返回 null 表示重试后仍提取不出有效结构。
 */
export async function extractPlateList(
  userText: string,
  images: { base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }[],
  docText: string,
  opts: { attempts?: number; expectedCount?: number } = {},
): Promise<ExtractedList | null> {
  const attempts = opts.attempts ?? 2
  const expectedCount = opts.expectedCount
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
      // 抢救式归一 + 去重
      const plates = Array.isArray(json?.plates)
        ? [...new Map(
            (json.plates as any[])
              .map(normalizePlateEntry)
              .filter((p): p is CandidatePlate => p !== null)
              .map((p) => [p.number, p]),
          ).values()]
        : []
      // 整文档口岸为空只在「逐条口岸也全空」时才重试:补充资料等混装文档整文档本就没有单一口岸,
      // 归口交给下游逐条解析;纯口岸文档连整文档口岸都提不出来说明提取有问题。
      if (!port && !plates.some((p) => p.port)) {
        console.warn(`【靓号提取】第 ${i + 1} 次无口岸,重试... 原始返回前 300 字: ${text.slice(0, 300)}`)
        continue
      }
      // 数量对不上:重试并附纠正提示(最后一轮直接接受,避免白跑)
      if (expectedCount && plates.length < expectedCount && i < attempts - 1) {
        console.warn(`【靓号提取】第 ${i + 1} 次只提到 ${plates.length}/${expectedCount} 个,附纠正提示重试... 原始返回前 300 字: ${text.slice(0, 300)}`)
        content.push({
          type: 'text',
          text: `你刚才只提取到 ${plates.length} 个车牌,素材里应该有约 ${expectedCount} 个。请逐行仔细核对(表格可能左右两栏并排,别漏掉右半边),重新输出完整 JSON。`,
        })
        continue
      }
      console.log(`🔍 靓号提取成功(第 ${i + 1} 次): port=${port || '(混装/无)'}, plates=${plates.length} 个${expectedCount ? `(预期 ${expectedCount})` : ''}`)
      return { port, portEn: typeof json?.port_en === 'string' && json.port_en.trim() ? json.port_en.trim() : undefined, plates }
    } catch (err: any) {
      console.warn(`【靓号提取】第 ${i + 1} 次失败: ${err.message}`)
    }
  }
  return null
}
