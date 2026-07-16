import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { apiClient, wsClient } from './client.js'
import { saveMessage, fillSenderName, getMessageById } from '../db/messages.js'
import { fetchHistoryGap } from './history.js'
import { askLLM, type LlmContext } from '../llm.js'
import { replyMessage } from './messages.js'
import { startReminderScheduler } from './reminders.js'

// 飞书事件 payload 结构复杂,不做强类型化
type FeishuEvent = Record<string, any>

// 用户信息缓存(同一用户只查询一次通讯录 API)
const userCache = new Map<string, string>()

// 机器人自身的 open_id,启动时拉取一次,用于判断"@机器人"
let botOpenId: string | null = null

// 修复后:手动拼接URL,彻底规避占位符不生效的问题
export async function getUserName(openId: string): Promise<string> {
  if (userCache.has(openId)) {
    return userCache.get(openId)!
  }

  try {
    // 直接把 open_id 拼进 URL,不用占位符
    const res = await apiClient.request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${openId}`,
      params: {
        user_id_type: 'open_id',
      },
    })

    const name = res.data.user.name
    userCache.set(openId, name)
    return name
  } catch (err: any) {
    console.error('\n【错误】获取用户信息失败:')
    console.error('HTTP状态码:', err.response?.status || err.status)
    console.error('业务错误码:', err.response?.data?.code || err.code)
    console.error('错误信息:', err.response?.data?.msg || err.message)
    console.error('')
    return '未知用户'
  }
}

// 获取机器人自身 open_id(启动时调用一次,失败则 @问答功能不可用)
async function loadBotOpenId(): Promise<string | null> {
  try {
    const res: any = await apiClient.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info/',
    })
    // 飞书 /bot/v3/info 返回 { code, msg, bot: { open_id, ... } }(注意:业务数据在 bot 字段,非 data)
    const id = res?.bot?.open_id ?? res?.data?.open_id
    if (id) {
      console.log('✅ 机器人 open_id 已获取:', id)
      return id
    }
    console.error('【警告】获取机器人信息返回无 open_id,@问答功能不可用,原始返回:', JSON.stringify(res))
    return null
  } catch (err: any) {
    console.error('【警告】获取机器人信息失败,@问答功能不可用: status=', err.response?.status ?? '—', err.response?.data?.msg || err.message)
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 启动时带重试拉取机器人 open_id:启动瞬间 tenant_access_token 可能尚未缓存就绪、或网络抖动,
// 旧实现一次失败即永久不可用。间隔递增重试直到成功,覆盖启动期瞬时故障。
async function loadBotOpenIdWithRetry(): Promise<string | null> {
  const delays = [2_000, 5_000, 15_000, 30_000]
  let id = await loadBotOpenId()
  for (let i = 0; !id && i < delays.length; i++) {
    console.warn(`【bot open_id】未就绪,${delays[i] / 1000}s 后重试(${i + 1}/${delays.length})`)
    await sleep(delays[i])
    id = await loadBotOpenId()
  }
  return id
}

// 懒加载兜底:运行期 botOpenId 为空(启动重试也全失败)时,由首条 @消息触发重新拉取,实现自愈。
// 60s 节流防频繁打接口;lastBotOpenIdAttempt 在 await 前置位,并发到达的多条 @消息只触发一次实际请求。
let lastBotOpenIdAttempt = 0
const BOT_OPEN_ID_RETRY_MS = 60_000
async function ensureBotOpenId(): Promise<string | null> {
  if (botOpenId) return botOpenId
  const now = Date.now()
  if (now - lastBotOpenIdAttempt < BOT_OPEN_ID_RETRY_MS) return null
  lastBotOpenIdAttempt = now
  const id = await loadBotOpenId()
  if (id) botOpenId = id
  return id
}

// 富文本 post 取 locale 段(兼容 zh_cn/en_us/裸结构),返回扁平后的 block 数组
function postBlocks(contentObj: any): any[] {
  const locale =
    contentObj?.zh_cn || contentObj?.en_us || contentObj?.ja_jp ||
    (contentObj && typeof contentObj === 'object' && Object.keys(contentObj).length
      ? contentObj[Object.keys(contentObj)[0]]
      : null) ||
    contentObj
  return Array.isArray(locale?.content) ? locale.content.flat() : []
}

// 抽取消息的文字 + 图片 file_key(text / post / image 三种类型都覆盖),不做 @机器人 判断。
// content 解析失败 → 返回 null;文字可能为空字符串(如纯图 post);图片数组可能为空。
function extractContent(message: any): { text: string; imageKeys: string[] } | null {
  let contentObj: any
  try {
    contentObj = JSON.parse(message.content)
  } catch {
    return null
  }

  const imageKeys: string[] = []
  let text = ''

  if (message.message_type === 'text') {
    text = (contentObj.text || '').replace(/@_user_\d+/g, '').trim()
  } else if (message.message_type === 'post') {
    for (const b of postBlocks(contentObj)) {
      if (!b || typeof b !== 'object') continue
      if ((b.tag === 'text' || b.tag === 'a') && typeof b.text === 'string') text += b.text
      if (b.tag === 'img' && typeof b.image_key === 'string') imageKeys.push(b.image_key)
    }
    text = text.replace(/@_user_\d+/g, '').trim()
  } else if (message.message_type === 'image') {
    if (typeof contentObj.image_key === 'string') imageKeys.push(contentObj.image_key)
  } else {
    return null
  }

  return { text, imageKeys }
}

// 解析消息文本(用于日志展示),失败回退为 [非文本消息]
function parseMessageText(message: any): string {
  let text = '[非文本消息]'
  try {
    const contentObj = JSON.parse(message.content)
    if (message.message_type === 'text') {
      text = contentObj.text || text
    } else if (message.message_type === 'post') {
      const blocks = postBlocks(contentObj)
      const t = blocks
        .filter((b: any) => b && (b.tag === 'text' || b.tag === 'a'))
        .map((b: any) => b.text || '')
        .join('')
      const imgs = blocks.filter((b: any) => b?.tag === 'img').length
      text = (t || '[富文本无文字]') + (imgs ? ` [${imgs}张图]` : '')
    }
  } catch {
    console.log('消息解析失败,原始内容:', message.content)
  }
  return text
}

// 「补录模式」:回复某条历史消息 + @机器人时,把被回复的那条消息作为上下文下载并喂给 LLM。
// 用户场景:先发张微信联系人截图(没@机器人),过会儿想起来,回到那条消息选择回复 + @机器人,
// 这条历史图作为上下文,LLM 自己判断是录线索还是回答问题。
// 实现:SQLite 优先(归档一直在跑,命中率 99%),查不到再回退飞书 API(机器人入群前的旧消息)。
async function loadParentContext(parentId: string): Promise<{ text: string; imageKeys: string[] } | null> {
  // 1. SQLite 归档优先
  const row = getMessageById(parentId)
  if (row?.content) {
    const c = extractContent({ message_type: row.message_type, content: row.content })
    if (c && (c.text || c.imageKeys.length)) return c
  }
  // 2. 回退飞书 API(原消息不在库里,如机器人入群前发的旧消息)
  try {
    const res: any = await apiClient.im.v1.message.get({
      path: { message_id: parentId },
    })
    const item = res?.data?.items?.[0]
    if (item) {
      return extractContent({ message_type: item.msg_type, content: item.body?.content })
    }
  } catch (err: any) {
    console.warn('【补录模式】拉取被回复消息失败(飞书 API 回退失败):', err.response?.data?.msg || err.message)
  }
  return null
}

// 打印一条入库消息的日志
function logIncomingMessage(userName: string, message: any, text: string): void {
  console.log('\n===== 收到群消息 =====')
  console.log('发送人:', userName)
  console.log('群ID:', message.chat_id)
  console.log('消息内容:', text)
  console.log('发送时间:', new Date(Number(message.create_time)).toLocaleString())
  console.log('======================\n')
}

/**
 * 处理 @机器人的群消息:走 LLM 一问一答并回复。
 * 调用方已保证只在「新消息(非重复投递)」时进入,重复消息在 handleIncomingMessage 早退。
 */
async function tryAnswerMention(message: any, openId: string): Promise<void> {
  if (message.chat_type !== 'group') return

  if (!botOpenId) {
    // botOpenId 未就绪(启动拉取失败):含 @ 的消息触发懒加载重试,实现运行期自愈
    if (Array.isArray(message.mentions) && message.mentions.length) {
      console.log('⚠️ botOpenId 未就绪,尝试重新拉取...')
      const id = await ensureBotOpenId()
      if (!id) {
        console.log('⚠️ botOpenId 仍未就绪,暂无法处理 @机器人消息')
        return
      }
    } else {
      return
    }
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const atBot = mentions.some((m: any) => m?.id?.open_id === botOpenId)
  if (!atBot) return

  const own = extractContent(message)
  let userText = own?.text ?? ''
  let imageKeys = own?.imageKeys ?? []
  let imageMessageIds: string[] | undefined

  // 「补录模式」:如果当前消息是「回复某条历史消息」(@机器人时往往没文字,光靠图触发),
  // 把被回复的那条消息作为上下文下载下来喂给 LLM(图片 + 文字合并)。
  // 失败/无父消息时降级:不附加上下文,只处理当前消息。
  if (message.parent_id) {
    const parentCtx = await loadParentContext(message.parent_id)
    if (parentCtx) {
      if (parentCtx.text) {
        // 把父消息文字拼到 userText 前面,LLM 一看就知道这是上下文
        userText = userText
          ? `【被回复的消息】\n${parentCtx.text}\n\n【当前消息】\n${userText}`
          : `【被回复的消息】\n${parentCtx.text}`
      }
      if (parentCtx.imageKeys.length) {
        // 父消息的图放在前面(更早进入 LLM 视野),当前消息的图追加在后
        imageKeys = [...parentCtx.imageKeys, ...imageKeys]
        // 每张图对应的 message_id:父消息的图用父消息 id,当前消息的图用 originalMessageId
        const parentImageIds = parentCtx.imageKeys.map(() => message.parent_id!)
        imageMessageIds = [...parentImageIds, ...imageKeys.slice(parentCtx.imageKeys.length).map(() => message.message_id)]
      }
      console.log('📎 补录模式:载入父消息上下文, parent_id=', message.parent_id,
        '父消息图', parentCtx.imageKeys.length, '张,文字', parentCtx.text.length, '字')
    }
  }

  // 文字和图片都为空 → 纯 @机器人无内容可处理,忽略
  if (!userText && imageKeys.length === 0) return

  if (userText) console.log('🤖 @机器人:', userText)
  else if (imageKeys.length) console.log('🤖 @机器人: [图片 x', imageKeys.length, ']')
  const ctx: LlmContext = {
    originalMessageId: message.message_id,
    userOpenId: openId,
    chatId: message.chat_id,
    voucherImageKeys: imageKeys,
    imageMessageIds,
  }

  try {
    const answer = await askLLM(userText, ctx)
    console.log('🤖 LLM 回答:', answer.slice(0, 200))
    try {
      await replyMessage(message.message_id, `<at user_id="${openId}"></at> ${answer}`)
      console.log('💬 已回复 @机器人提问, message_id:', message.message_id)
    } catch (err: any) {
      console.error('【回复飞书失败】code:', err.response?.data?.code ?? err.status ?? '—', 'msg:', err.response?.data?.msg || err.message)
    }
  } catch (err: any) {
    // askLLM 失败:回复兜底,避免用户以为没反应
    console.error('【LLM 调用失败】status:', err.status ?? '—', 'msg:', err.message)
    await replyMessage(message.message_id, `<at user_id="${openId}"></at> 开小差了,稍后再试`)
      .catch((e: any) => console.error('【兜底回复也失败】', e.response?.data?.msg || e.message))
  }
}

/**
 * 单条实时消息的完整处理流程:落库 → 补名字 → 日志 → @机器人问答。
 *
 * ⚠️ ACK 时序关键:飞书 SDK 的长连接是在「handler 返回后才发 ACK」(见 SDK
 * handleEventData:yield invoke(handler) 之后才 sendMessage 回 ACK)。本函数
 * 末尾的「查名字 + 日志 + @机器人 LLM 问答」涉及多次网络往返(通讯录 API +
 * MiniMax tool-use loop,慢则十几秒)。若 await 它们,handler 长时间不返回 →
 * ACK 迟迟不发 → 飞书服务端判定连接卡住 → 触发重连 → 重连期间新消息收不到
 * (表现为「时好时坏」:LLM 快时正常、慢时断流)。
 *
 * 解法:把「同步快操作」(落库 + 去重判断)留在函数体内 await,保证 handler
 * 迅速返回、SDK 及时 ACK;把「慢操作」整体 fire-and-forget 异步化(.catch
 * 兜底防 unhandledRejection),彻底解耦 ACK 与 LLM 耗时。
 */
async function handleIncomingMessage(data: FeishuEvent): Promise<void> {
  const { message, sender } = data
  const openId = sender.sender_id.open_id

  // 先落库(INSERT OR IGNORE 去重,source=realtime)—— 同步,毫秒级,阻塞 ACK 无妨
  const isNew = saveMessage(data, 'realtime')

  // 飞书长连接会重投递同一条消息(ACK 超时/连接抖动/服务端重试均触发)。
  // 靠 message_id 主键去重:重复消息直接早退,不打详细日志、不重复处理。
  // 去重判断必须在「异步化之前」同步完成,否则重复投递会被异步处理两次。
  if (!isNew) {
    const sentAt = new Date(Number(message.create_time))
    const receivedAt = new Date()
    const lagMs = receivedAt.getTime() - sentAt.getTime()
    console.log(
      `⏭️ 重复消息已跳过(飞书重投递), message_id: ${message.message_id}` +
      ` | 发送时间: ${sentAt.toLocaleString()}` +
      ` | 入库时间: ${receivedAt.toLocaleString()}` +
      ` | 重投递延迟: ${lagMs}ms`
    )
    return
  }

  console.log('✅ 已入库 message_id:', message.message_id)

  // 慢操作整体异步化:查名字(通讯录 API)+ 日志 + @机器人问答(LLM tool-use)。
  // 不 await → handler 立刻返回 → SDK 立刻 ACK → 不再因 LLM 慢而断流。
  processMessageAsync(message, openId).catch((e: any) =>
    console.error('【异步消息处理异常】 message_id:', message.message_id, e?.stack ?? e?.message ?? e)
  )
}

/**
 * 实时消息的慢处理部分(从 handleIncomingMessage 拆出):补名字 → 日志 → @机器人问答。
 * 被 fire-and-forget 调用,自身耗时不再阻塞飞书 ACK。
 */
async function processMessageAsync(message: any, openId: string): Promise<void> {
  // 异步补名字,拿到后回填
  const userName = await getUserName(openId)
  if (userName) fillSenderName(message.message_id, userName)

  const text = parseMessageText(message)
  logIncomingMessage(userName, message, text)

  await tryAnswerMention(message, openId)
}

/**
 * 启动飞书 worker:注册消息事件 + 启动长连接 + 调度历史补漏。
 * 与 HTTP 服务并行运行在同一个进程里。
 */
export function startFeishuWorker(): void {
  // 异步拉取机器人 open_id(带重试,覆盖启动瞬间抖动;未就绪期间 @消息会触发懒加载兜底)
  loadBotOpenIdWithRetry().then((id) => { botOpenId = id }).catch((e: any) => console.error('【loadBotOpenId 未捕获】', e?.message ?? e))

  // 注册消息事件
  // 顶层 try/catch:任一未预期异常都兜住,避免 async 回调 reject 冒泡到 SDK、拖垮长连接
  const eventDispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data: FeishuEvent) => {
      try { await handleIncomingMessage(data) }
      catch (e: any) { console.error('【消息事件处理异常】', e?.stack ?? e?.message ?? e) }
    },
  })

  // 启动长连接
  wsClient.start({ eventDispatcher })
  console.log('✅ 飞书长连接已启动,正在监听群消息...')

  // 历史补漏调度:启动5秒后跑一次,之后每24小时一次(source=history,靠message_id去重)
  // 注入 getUserName:历史消息 API 不返回姓名,补漏后按 open_id 批量补名(复用 userCache 去重)
  const ONE_DAY_MS = 24 * 60 * 60 * 1000
  const backfill = () => fetchHistoryGap(apiClient, getUserName).catch(e => console.error('【补漏出错】', e.message))
  setTimeout(backfill, 5000)
  setInterval(backfill, ONE_DAY_MS)
  console.log('⏰ 历史补漏已调度:启动5秒后执行一次,之后每24小时一次')

  // 提醒调度器:每60秒轮询到点的提醒,reply 原消息 @用户
  startReminderScheduler()
}
