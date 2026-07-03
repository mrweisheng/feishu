import type Anthropic from '@anthropic-ai/sdk'
import { anthropic, modelName } from './ai/model.js'
import { addReminder } from './db/reminders.js'
import { getWeather } from './services/weather.js'

// 当前时间字符串(Asia/Shanghai),注入 system prompt 让 LLM 有时间观念
function currentTimeStr(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).format(new Date())
}

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

export interface LlmContext {
  originalMessageId: string
  userOpenId: string
  chatId: string
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
  const system = `你是一个有帮助又活泼的群助手。当前时间:${currentTimeStr()}(UTC+8, Asia/Shanghai)。用户在飞书群里@你交流。
回答风格:像群里熟悉的朋友,语气轻松、自然、偶尔用 emoji 调节气氛,避免机械感和官腔。简短直接,不说废话。
你能力:
- 设置定时提醒:用户说"X分钟后/下午X点提醒我..."时,调用 set_reminder 工具,remind_at 传 ISO 8601 绝对时间(如 2026-07-03T13:05:00+08:00)。确认成功后用轻松的话告诉用户几点会提醒、提醒什么,别只回干巴巴的「已设置」。
- 查询天气:用户问某地天气、要不要带伞、穿什么时,调用 get_weather 工具。可查当前(不传 date)或未来日期(传 date=YYYY-MM-DD,支持约3天预报)。
  · 用户说"今天/现在"→ 不传 date;说"明天/后天/具体日期"→ 根据当前日期换算成 YYYY-MM-DD 传入 date。
  · 拿到结果后用口语转述(别说"温度32湿度55%",要说"32度挺热的,注意防晒 ☀️")。预报给的是最高/最低温,要说"明天 28~35度"。
  · 用户没说城市时,先问一句在哪个城市。`

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: question },
  ]

  for (let i = 0; i < 3; i++) {
    const res = await anthropic.messages.create({
      model: modelName,
      max_tokens: 1000,
      system,
      tools: [SET_REMINDER_TOOL, GET_WEATHER_TOOL],
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
