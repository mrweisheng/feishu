import type Anthropic from '@anthropic-ai/sdk'
import { anthropic, modelName } from './ai/model.js'
import { addReminder } from './db/reminders.js'
import { addLead, getLeadById } from './db/customerLeads.js'
import { syncLeadToBitable, listExistingNamesOnDate } from './feishu/bitable-customer.js'
import { downloadMessageImage } from './feishu/media.js'
import { getWeather, getWeatherForecast } from './services/weather.js'
import {
  type LedgerEntry,
  isWriteTool,
  buildSystemAttestation,
  stripAllUrls,
  normalizeName,
  stripDatePrefix,
  dateKeyShanghai,
} from './llm/toolRegistry.js'

// 当前时间字符串(Asia/Shanghai),注入 system prompt 让 LLM 有时间观念
function currentTimeStr(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  }).format(new Date())
}

// 解析 LLM 给的 remind_at:无时区信息时按 Asia/Shanghai(+08:00)兜底,避免按服务器时区解析导致 8h 漂移。
// 支持:ISO 8601 带时区("2026-07-03T13:05:00+08:00" / "...Z")、无时区("2026-07-03T13:05:00" / "2026-07-03 13:05")。
const HAS_TIMEZONE = /[Zz]$|[+-]\d{2}:?\d{2}$/
function parseRemindAt(input: string): number {
  let s = input.trim()
  // 归一化:把 "YYYY-MM-DD HH:MM[:SS]" 形式的空格替换成 T(纯日期会保留原样由 Date.parse 处理)
  s = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/, '$1T$2')
  if (!HAS_TIMEZONE.test(s)) {
    s += '+08:00'
  }
  return Date.parse(s)
}

const SET_REMINDER_TOOL = {
  name: 'set_reminder',
  description: '设置一条单次提醒(到点@用户一次)。用于到点通知一声就完的事:喝水、拿快递、吃药、下午3点开会、1小时后叫我、5分钟后提醒我打电话。remind_at 必须是未来的时间。',
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
  description: '查询某城市当前实时天气,或某一个具体日期的预报。用户问"现在/今天XX天气""明天/后天XX天气""XX热不热"时调用。注意:本工具一次只查一个时刻;若用户问"接下来""未来几天""这周天气"这种想要多天列表的,改用 get_weather_forecast。',
  input_schema: {
    type: 'object' as const,
    properties: {
      city: {
        type: 'string',
        description: '城市名,中文或英文,如"北京"、"上海"、"武汉"。',
      },
      date: {
        type: 'string',
        description: '可选。要查询的日期,ISO 格式 YYYY-MM-DD,如"2026-07-04"。用户说"今天"或"现在"则不传此字段(查实时);"明天/后天/具体日期"则换算成日期传入。仅支持未来约3天。',
      },
    },
    required: ['city'],
  },
}

const GET_WEATHER_FORECAST_TOOL = {
  name: 'get_weather_forecast',
  description: '一次性查询某城市未来多天逐日预报(最多3天:今天/明天/后天)。用户问"接下来天气""未来几天""这周天气""未来一周""几天天气"等想要一个列表时调用本工具,不要逐天调 get_weather。拿到后用列表口语化转述,不要说"拿不到一周",如实说明最多3天即可。',
  input_schema: {
    type: 'object' as const,
    properties: {
      city: {
        type: 'string',
        description: '城市名,中文或英文,如"武汉"、"上海"。',
      },
    },
    required: ['city'],
  },
}

const RECORD_CUSTOMER_INFO_TOOL = {
  name: 'record_customer_info',
  description: '登记一条客资(销售线索)。当用户说"记一下张三来咨询了""新客户李四""XX加了微信,需求是..."等需要登记线索时调用。客户姓名必填;其他字段(微信、需求、备注、是否重点、是否到店、线索日期)能填就填,不知道就空着。用户没给日期就默认今天。归属人自动填当前 @你的人(这条线索归谁);创建人飞书系统自动记录(API 调用方 = 机器人 app),不用管。',
  input_schema: {
    type: 'object' as const,
    properties: {
      customer_name: {
        type: 'string',
        description: '客户姓名,必填(不写名字没法登记)。',
      },
      customer_wechat: {
        type: 'string',
        description: '客户微信 ID/账号(可选)。',
      },
      customer_needs: {
        type: 'string',
        description: '客户需求(可选,简述)。',
      },
      customer_notes: {
        type: 'string',
        description: '客户备注(可选,其他想记的)。',
      },
      is_key_customer: {
        type: 'boolean',
        description: '是否是重点客户(可选,bool)。',
      },
      visited_store: {
        type: 'boolean',
        description: '是否到店(可选,bool)。',
      },
      lead_date: {
        type: 'string',
        description: '线索日期(可选)。ISO 8601 带时区字符串,缺时区按 UTC+8 解释。用户说"今天"就传当前时间(不传也行,默认现在);说"昨天" "上周" "2026-07-10" 这类具体日期时算出对应时间。',
      },
    },
    required: ['customer_name'],
  },
}

export interface LlmContext {
  originalMessageId: string
  userOpenId: string
  chatId: string
  /** 消息里的图片 file_key(image 类型或 post 富文本里的 img block) */
  voucherImageKeys: string[]
  /** 每张图对应的 message_id(补录模式下,父消息的图要用父消息 id 下载,不能混用) */
  imageMessageIds?: string[]
}

/**
 * 去重上下文:按线索日期缓存维格表已有名字,批量录入时跨条共用。
 * 同一天只拉一次维格表;本批出现多个不同日期(补录历史图)时,每个新日期各拉一次。
 * 注:listExistingNamesOnDate 内部失败时返回空 Set 不抛,所以拉失败 = 该日当作"没有重复",
 * 缓存空集即可,不需要单独的 failedDates(失败已隐含在空集里,下次同日仍命中空集不重拉)。
 */
export interface DedupCtx {
  /** key=日期(北京时间 YYYY-MM-DD)→ 该日维格表已有归一化名字集合(拉失败存空集) */
  existingByDate: Map<string, Set<string>>
  /** 本批已成功录入的"日期|归一化名字"(防同一批内 LLM 重复登同一个同日的) */
  justAdded: Set<string>
}

/** 拉某日的维格表已有名字并塞进 DedupCtx 缓存(同一天只拉一次,失败存空集) */
async function ensureExistingForDate(dedup: DedupCtx, leadTs: number): Promise<Set<string>> {
  const key = dateKeyShanghai(leadTs)
  const cached = dedup.existingByDate.get(key)
  if (cached) return cached
  const raw = await listExistingNamesOnDate(leadTs)
  const normalized = new Set<string>()
  // 维格表侧也走同样的 stripDatePrefix + normalize,口径完全对齐
  // (防人工直接在表格里手填了带"60717/"前缀的名字)
  for (const n of raw) normalized.add(normalizeName(stripDatePrefix(n)))
  dedup.existingByDate.set(key, normalized)
  console.log(`📋 去重预拉(${key}):维格表该日已有 ${normalized.size} 条`)
  return normalized
}

/**
 * 执行单个工具,返回给 LLM 的 JSON 字符串(维持原协议),同时把真实结果记进 ledger。
 * ledger 是「事实源」,后续事实接管(buildSystemAttestation)只信它,不信 LLM 的嘴。
 * 单个工具异常 catch 后返 ok:false,不让整个 loop 崩。
 */
async function executeTool(name: string, input: any, ctx: LlmContext, ledger: LedgerEntry[], dedup?: DedupCtx): Promise<string> {
  const record = (entry: LedgerEntry): void => { ledger.push(entry) }

  if (name === 'set_reminder') {
    const { remind_at, content } = input as { remind_at: string; content: string }
    const ts = parseRemindAt(remind_at)
    if (isNaN(ts)) {
      record({ tool: name, category: 'write', ok: false, error: '时间格式无法解析' })
      return JSON.stringify({ ok: false, error: '时间格式无法解析' })
    }
    if (ts <= Date.now()) {
      record({ tool: name, category: 'write', ok: false, error: '提醒时间已过去' })
      return JSON.stringify({ ok: false, error: '提醒时间已过去,请给一个未来的时间' })
    }
    try {
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
      record({ tool: name, category: 'write', ok: true, summary: content })
      return JSON.stringify({ ok: true, remind_at, content })
    } catch (err: any) {
      record({ tool: name, category: 'write', ok: false, error: err.message })
      return JSON.stringify({ ok: false, error: `设置提醒失败: ${err.message}` })
    }
  }
  if (name === 'get_weather') {
    const { city, date } = input as { city: string; date?: string }
    try {
      const w = await getWeather(city, date)
      record({ tool: name, category: 'read', ok: true })
      return JSON.stringify({
        ok: true,
        city: w.city,
        date: w.date ?? null,
        isForecast: w.isForecast,
        temperature: w.temperature, // 实时=实际温度;预报=最高/最低
        feelsLike: w.feelsLike ?? null, // 实时体感温度(预报无);高温高湿时与实际相差大,务必告知用户
        description: w.description,
        humidity: w.humidity,
        wind: w.wind,
      })
    } catch (err: any) {
      console.error('【天气查询失败】city=', city, 'date=', date ?? '(now)', 'msg:', err.message)
      record({ tool: name, category: 'read', ok: false, error: err.message })
      return JSON.stringify({ ok: false, error: `查询${city}天气失败:${err.message}` })
    }
  }
  if (name === 'get_weather_forecast') {
    const { city } = input as { city: string }
    try {
      const f = await getWeatherForecast(city)
      record({ tool: name, category: 'read', ok: true })
      return JSON.stringify({
        ok: true,
        city: f.city,
        days: f.days.map((d) => ({
          date: d.date,
          weekday: d.weekday,
          temperature: d.temperature,
          description: d.description,
          humidity: d.humidity,
          wind: d.wind,
        })),
      })
    } catch (err: any) {
      console.error('【天气预报查询失败】city=', city, 'msg:', err.message)
      record({ tool: name, category: 'read', ok: false, error: err.message })
      return JSON.stringify({ ok: false, error: `查询${city}天气预报失败:${err.message}` })
    }
  }
  if (name === 'record_customer_info') {
    const {
      customer_name,
      customer_wechat,
      customer_needs,
      customer_notes,
      is_key_customer,
      visited_store,
      lead_date,
    } = input as {
      customer_name: string
      customer_wechat?: string
      customer_needs?: string
      customer_notes?: string
      is_key_customer?: boolean
      visited_store?: boolean
      lead_date?: string
    }

    const name = (customer_name || '').trim()
    if (!name) {
      record({ tool: 'record_customer_info', category: 'write', ok: false, error: '客户姓名为空' })
      return JSON.stringify({ ok: false, error: '客户姓名是必填的,登记不了匿名线索' })
    }
    // 本批去重的占位:去重通过后先标记,真正写库成功后才提交到 justAdded(避免写库失败却占了坑)
    let pendingBatchKey: string | null = null

    // 解析 lead_date:无时区按 +08:00 兜底;解析失败默认 now
    let leadTs = Date.now()
    if (lead_date && lead_date.trim()) {
      const ts = parseRemindAt(lead_date.trim())
      if (!isNaN(ts)) leadTs = ts
    }

    // 去重:以维格表为事实源。归一化后名字(去空白,大小写敏感)与「维格表该日已有」或「本批同日已加」相同 → 跳过。
    // 同一天不会有两个同名备注(业务现实),所以同名同日即重复,不误杀。
    // ⚠️ 按实际 lead_date 的"日"查,不能用 Date.now()——补录历史图时 lead_date 是历史日期,
    //    用今天的数据去重会跨日错位。
    if (dedup) {
      // ⚠️ 去重比对口径必须和维格表存储口径一致:维格表存的是 addLead 剥离日期前缀后的纯名字,
      // 所以这里也要先 stripDatePrefix 再 normalize,否则 LLM 传"60717/雅琴"会和维格表的"雅琴"对不上 → 重复录入。
      const norm = normalizeName(stripDatePrefix(name))
      const dayKey = dateKeyShanghai(leadTs)
      const existing = await ensureExistingForDate(dedup, leadTs)
      const batchKey = `${dayKey}|${norm}` // 本批去重带日期,不同日同名不算本批重复
      if (existing.has(norm) || dedup.justAdded.has(batchKey)) {
        record({ tool: 'record_customer_info', category: 'write', ok: false, skipped: true, summary: name, error: `与${dayKey}已有/本批已录重复` })
        console.log(`⏭️ 去重跳过:「${name}」(${dayKey})已存在,不重复录入`)
        return JSON.stringify({ ok: false, skipped: true, error: `客户「${name}」(${dayKey})已登记过,已跳过(去重)` })
      }
      // 记下本批这条(用闭包变量,成功录入后正式提交到 justAdded)
      pendingBatchKey = batchKey
    }

    try {
      const localId = addLead({
        customerName: name,
        customerWechat: customer_wechat?.trim() || null,
        customerNeeds: customer_needs?.trim() || null,
        customerNotes: customer_notes?.trim() || null,
        isKeyCustomer: !!is_key_customer,
        visitedStore: !!visited_store,
        ownerOpenId: ctx.userOpenId,
        ownerName: null, // 名字由 handler 异步补/或在展示时按需查;v1 不阻塞
        leadDate: leadTs,
        chatId: ctx.chatId,
        userOpenId: ctx.userOpenId,
        originalMessageId: ctx.originalMessageId,
      })

      // 异步同步到飞书 bitable(失败不影响主流程)
      const fresh = getLeadById(localId)!
      const feishuRecordId = await syncLeadToBitable(localId, fresh)

      // 关键:记账。summary 用 DB 兜底后的真实名字(localId 对应行已被 addLead 剥过日期前缀)。
      // 注意 record 的 tool 字段是工具名 'record_customer_info',不是客户名。
      record({
        tool: 'record_customer_info',
        category: 'write',
        ok: true,
        summary: fresh.customer_name || name,
        linkKey: 'customer',
      })
      // 成功录入 → 提交本批去重占位(写库成功才占坑,写库失败不占,允许重试)
      if (dedup && pendingBatchKey) dedup.justAdded.add(pendingBatchKey)
      return JSON.stringify({
        ok: true,
        lead_id: localId,
        customer_name: fresh.customer_name || name,
        lead_date: leadTs,
        // 注意:不再把 bitable_link 返回给 LLM —— 链接只能由事实接管从 config 注入,杜绝 LLM 编链接。
        // 飞书是否同步成功的信号用 bitable_synced 传给 LLM(用于它转述提醒同事排查)。
        bitable_synced: !!feishuRecordId,
      })
    } catch (err: any) {
      record({ tool: 'record_customer_info', category: 'write', ok: false, error: err.message })
      return JSON.stringify({ ok: false, error: `登记客资失败: ${err.message}` })
    }
  }
  record({ tool: name, category: 'read', ok: false, error: `未知工具: ${name}` })
  return JSON.stringify({ ok: false, error: `未知工具: ${name}` })
}

// 新增提醒后的回调钩子(由 reminders.ts 注册,避免 llm ↔ reminders 循环依赖)
let onReminderAdded: (() => void) | null = null
export function setOnReminderAdded(fn: () => void): void {
  onReminderAdded = fn
}

/**
 * 调用 LLM。带 set_reminder / 天气工具,走标准 tool-use loop(最多 3 轮)。
 * ctx 提供群/用户/原消息上下文,工具执行时用。
 */
export async function askLLM(question: string, ctx: LlmContext): Promise<string> {
  const system = `你是一个有帮助又活泼的群助手。当前时间:${currentTimeStr()}(UTC+8, Asia/Shanghai)。用户在飞书群里@你交流。
回答风格:像群里熟悉的朋友,语气轻松、自然、偶尔用 emoji 调节气氛,避免机械感和官腔。简短直接,不说废话。
你能力:
- 设置单次提醒:当用户让你到点提醒某事(喝水、拿快递、出门、吃药、下午3点开会、1小时后叫我、5分钟后提醒我打电话等)时调用 set_reminder。remind_at 必须传**带时区**的 ISO 8601 绝对时间(如 2026-07-03T13:05:00+08:00 或 2026-07-03T13:05:00Z)。**绝对不要省略时区** — 缺时区会被强行按北京时间(+08:00)解释,如果用户实际不在北京就可能差 8 小时。确认成功后用轻松的话告诉用户几点会提醒、提醒什么。
- 查询天气:用户问某地天气、要不要带伞、穿什么时调用天气工具。
  · 两个工具:get_weather 查"当前实时"或"某一个具体日期"(一次一个时刻);get_weather_forecast 查"未来多天逐日列表"(一次拿全部,最多3天)。
  · 用户说"现在/今天XX天气"→ get_weather 不传 date;说"明天/后天/具体某天"→ get_weather 传 date=YYYY-MM-DD。
  · 用户说"接下来""未来几天""这周""未来一周""几天天气"等想要多天列表时 → 必须用 get_weather_forecast(别逐天调 get_weather,更别说"拿不到一周")。如实告诉用户最多能查3天,把拿到的逐日结果列出来即可。
  · 拿到结果后用口语转述(别说"温度32湿度55%",要说"32度挺热的,注意防晒 ☀️")。预报给的是最高/最低温,要说"明天 28~35度"。
  · ⚠️ **实际温度 vs 体感温度**:实时天气返回里 temperature 是实际温度、feelsLike 是体感温度(高温高湿时体感比实际高很多,如实际34°体感可达44°)。**两者都告诉用户**:先报实际温度,体感明显更高时补一句"体感有44°,闷热得很"(只报实际温度会让用户低估热度;把体感当实际温度报也会误导)。不要纠结、不要说"我看错了",如实把两个数都讲清楚即可。
  · 用户没说城市时,先问一句在哪个城市。
- 登记客资:用户说"记一下XX来咨询了""新客户XX""XX加了微信,需求是..."这种要登记销售线索的话,调用 record_customer_info。**客户姓名必填**,其他字段(微信/需求/备注/是否重点/是否到店/线索日期)能填就填,不知道就空着。**没给日期就默认今天**(lead_date 不传)。**归属人自动填当前 @你的人**(这条线索归谁);**创建人飞书系统自动记录**(API 调用方 = 机器人 app),你不用管,也不要在工具入参里传。
  · **重要:你只负责「登记」这个动作和自然的口头反馈,「成功几条」「链接是啥」由系统在回复末尾自动追加核对信息,你不要宣布具体数量、不要在回复里贴任何链接(URL)。** 你可以说"我帮你登记啦""记下了"这种自然的话,但不要说"已登记 N 条"这种带数字的成败结论,更不要编或贴任何网址。看到系统追加的「📋 系统核对」段时理解那是后台真实数据即可。
  · bitable_synced 是 false 时顺便补一句"飞书表格同步失败,本地 SQLite 里有,需要排查"。
  · 不去重,录就录;用户要"我之前录过了别再录"再说,目前工具直接落库。
- 批量录入(图):用户发的图片如果是微信联系人截图,就从中提取客户信息登记。**普通照片/表情包/风景图就正常聊天,别瞎调工具**。
  · ⚠️ **看到联系人截图默认直接录入,不要反问"要不要登记"、不要等用户再确认**。用户发来联系人截图并 @了你,正常意图就是登记,直接逐条调 record_customer_info。**纯@无文字、或文字就是要登记**→一律直接录,这是最常见的正确行为,别多此一问。
  · **唯一不录的例外**:用户带了文字、且文字明显**不是**要登记时——如"这个录过没""有没有重复""这个微信号对吗""删掉这个""改成XX""这个客户是谁""查一下XX"这类**查询/核对/修改/删除**意图——**按文字意图回答,绝对不要录入**。判断不准时宁可按文字意图回答,因为误录会污染表格、要人工清。
  · 两种场景:
    · 搜索结果列表(多联系人,显示名带日期前缀)→ 逐行解析,**图里看不到微信号就空着**
    · 单联系人详情(有"朋友资料""发消息"按钮)→ **只 1 条**,备注名里日期+姓名,图里能看到微信号就填
  · 同事备注**没有统一格式**:日期和姓名可能用斜杠/空格/点/横线任何符号隔,可能 4 位纯数字 / M.DD / M月DD日 / 别的写法——**自己看图,别套固定模式**;年份没明示就当前年。
  · **拆出日期后,日期之后整段就是客户名称,整段照抄,不要再分产品/品牌/中文括号里人名/其他子字段,也不要在 customer_name 里加任何"备注名:""来源:""微信号:""品牌:"等字段标签**。例:7.13 智能感应灯具 开关(雷思诺) → customer_name 传 "智能感应灯具 开关(雷思诺)"(整段,不是只取 "雷思诺");60716/林佳 → 传 "林佳";7.13 雷思诺 → 传 "雷思诺"。
  · 名字大多是中文或中英混搭(林佳、小y、Louis),**别把中文"小"误认成拉丁"J/j"**(LLM 视觉弱项)。
  · 图里看不到联系人信息就**直接问一句**"你发的这是联系人截图吗?",别瞎编,也不要假装登记成功。
  · 每条都调一次 record_customer_info(可以并行 8-10 个 tool_use block);lead_date 传当天 00:00:00 +08:00 的 ISO 字符串(YYYY-MM-DDTHH:mm:ss+08:00,工具内部会转);customer_name 传整段客户名称(上一条规则);is_key_customer 和 visited_store 都不传(默认 false);customer_wechat 图里有就填,没就空;customer_notes **只有用户明确说"备注:xxx""笔记:xxx""补充:xxx"时才填,别瞎编**(图片识别时一律不传)。
  · 录完用自然的话告诉用户(如"帮你登记啦,系统会核对条数贴在下面"),**不要自己数数、不要说"已登记 N 条"、不要贴链接** —— 条数和链接由系统核对段自动追加,你说了也会被覆盖/清洗。
  · 看 tool result 的 bitable_synced 字段:任一 false 就告诉用户"飞书表格同步失败,本地 SQLite 里有,需要排查",但具体几条成功以系统核对段为准。
其余问题正常闲聊回答即可。
**全局铁律:你的回复里绝对不许出现任何 http(s) 网址/链接(URL)。** 链接一律由系统按真实成功结果从配置注入。你若需要提到表格,说"表格"即可,不要拼任何 URL。`

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: await buildUserContent(question, ctx) },
  ]

  // 执行账本:这一轮 LLM 到底真正执行了什么(写工具成败/读工具)。事实接管只信它,不信 LLM 的嘴。
  const ledger: LedgerEntry[] = []

  // 去重上下文:懒加载 —— 本轮首次出现 record_customer_info 时预拉一次维格表当天已有名字,
  // 之后所有 record_customer_info 共用这一份(批量场景一次拉取比对 N 次,不打 N 次接口)。
  let dedup: DedupCtx | null = null

  for (let i = 0; i < 3; i++) {
    const res = await anthropic.messages.create({
      model: modelName,
      max_tokens: 1000,
      system,
      tools: [
        SET_REMINDER_TOOL,
        GET_WEATHER_TOOL,
        GET_WEATHER_FORECAST_TOOL,
        RECORD_CUSTOMER_INFO_TOOL,
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
      // 单个工具异常不能让整个 LLM 循环崩:catch 后返 ok:false 给 LLM 自行决定下一步

      // 去重上下文:本轮首次要登客资时初始化(空容器,真正拉维格表延迟到 executeTool 里按每条的实际 lead_date 拉)。
      // 这样补录历史图(lead_date 是历史日期)时,会拉对应历史日期的数据,而不是错误地拉今天。
      if (!dedup && toolUses.some((tu) => tu.name === 'record_customer_info')) {
        dedup = { existingByDate: new Map(), justAdded: new Set() }
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        let result: string
        try {
          result = await executeTool(tu.name, tu.input, ctx, ledger, dedup ?? undefined)
        } catch (err: any) {
          console.error('【工具执行异常】name=', tu.name, 'msg:', err.message, 'stack:', err.stack)
          // 工具炸了:既返给 LLM ok:false,也按「写工具失败」记账(读工具炸了不影响事实接管)
          if (isWriteTool(tu.name)) {
            ledger.push({ tool: tu.name, category: 'write', ok: false, error: err.message })
          }
          result = JSON.stringify({ ok: false, error: `工具内部错误: ${err.message}` })
        }
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
    return finalizeReply(text, ledger)
  }

  return '（抱歉,处理超时,请重试）'
}

// 构造首条 user message 的 content:text(可空)+ 任何图片
// 缺图就只是 text,缺文就只是图,两者都缺基本不会出现(handler 已早退)
async function buildUserContent(question: string, ctx: LlmContext): Promise<Anthropic.MessageParam['content']> {
  const content: Anthropic.MessageParam['content'] = []
  if (question.trim()) {
    content.push({ type: 'text', text: question })
  }
  if (ctx.voucherImageKeys && ctx.voucherImageKeys.length) {
    console.log('📷 收到', ctx.voucherImageKeys.length, '张图片,开始下载并附带给 LLM...')
    for (let i = 0; i < ctx.voucherImageKeys.length; i++) {
      const key = ctx.voucherImageKeys[i]
      // 补录模式下 imageMessageIds[i] 是该图所在消息的 id;否则用 originalMessageId
      const messageId = ctx.imageMessageIds?.[i] || ctx.originalMessageId
      const img = await downloadMessageImage(messageId, key)
      if (img) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64,
          },
        })
      }
    }
  }
  return content
}

/**
 * 事实接管(整个修复的核心):LLM 吐完文字后,代码先处理再发给用户。
 *   1. stripAllUrls —— LLM 文字里的所有 http(s) 链接一刀切全清(白名单会被合法域名+编造路径绕过,
 *      本次 bug 的直接成因)。链接只能由 buildSystemAttestation 从 config 注入。
 *   2. buildSystemAttestation —— 按 ledger 真实统计追加「系统核对」段:
 *      写工具 ≥1 成功 → 真实条数 + 名字 + config 真实链接(整批只贴一次);
 *      写工具全失败 → 诚实声明「实际未成功,请重发」。
 *      这样用户看到的成败/数量/链接永远来自后台真实数据,LLM 嘴上的话不作数。
 */
function finalizeReply(llmText: string, ledger: LedgerEntry[]): string {
  const cleanedText = stripAllUrls(llmText)
  // 把 LLM 原文也传进去:账本无写工具记录、但 LLM 嘴上声称"已登记"时,交叉检测戳穿幻觉
  const attest = buildSystemAttestation(ledger, llmText)
  if (!attest) return cleanedText
  // 系统核对段独立成段,与 LLM 叙述分开,让用户一眼区分「机器人的话」vs「后台核对」
  return cleanedText ? `${cleanedText}\n\n${attest}` : attest
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
