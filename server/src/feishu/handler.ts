import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { apiClient, wsClient } from './client.js'
import { saveMessage, fillSenderName, getMessageById } from '../db/messages.js'
import { fetchHistoryGap } from './history.js'
import { askLLM, type LlmContext } from '../llm.js'
import { replyMessage } from './messages.js'
import { startReminderScheduler } from './reminders.js'
import { subscribeBitable, handleBitableRecordChanged } from './bitable.js'

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

// 纯内容抽取(text 取文字 / post 取文字 + 凭证图 image_key),不做 @机器人 判断。
// content 解析失败或非 text/post 类型 → 返回 null;文字可能为空字符串(如纯图 post)。
function extractContent(message: any): { text: string; imageKeys: string[] } | null {
  let contentObj: any
  try {
    contentObj = JSON.parse(message.content)
  } catch {
    return null
  }

  if (message.message_type === 'text') {
    const text = (contentObj.text || '').replace(/@_user_\d+/g, '').trim()
    return { text, imageKeys: [] }
  }

  if (message.message_type === 'post') {
    let text = ''
    const imageKeys: string[] = []
    for (const b of postBlocks(contentObj)) {
      if (!b || typeof b !== 'object') continue
      if ((b.tag === 'text' || b.tag === 'a') && typeof b.text === 'string') text += b.text
      else if (b.tag === 'img' && typeof b.image_key === 'string') imageKeys.push(b.image_key)
    }
    text = text.replace(/@_user_\d+/g, '').trim()
    return { text, imageKeys }
  }

  return null
}

// 取"被回复消息"内容(文字 + 凭证图)。优先查 SQLite 归档,缺失再回退飞书 API。
// 用于补录:用户回复一条收/支消息并@机器人,把那条原消息当上下文喂给 LLM。
async function loadParentContent(parentId: string): Promise<{ text: string; imageKeys: string[] } | null> {
  // 1. SQLite 归档优先(机器人对所有所在群都落库,命中率几乎 100%)
  const row = getMessageById(parentId)
  if (row?.content) {
    const c = extractContent({ message_type: row.message_type, content: row.content })
    if (c && (c.text || c.imageKeys.length)) return c
  }
  // 2. 回退飞书 API(原消息不在库里,如机器人入群前发的旧消息)
  try {
    const res: any = await apiClient.request({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${parentId}`,
      params: { message_id_type: 'message_id' },
    })
    const item = res?.data?.items?.[0] ?? res?.data
    const c = item?.msg_type && item?.body?.content
      ? extractContent({ message_type: item.msg_type, content: item.body.content })
      : null
    if (c && (c.text || c.imageKeys.length)) return c
  } catch (err: any) {
    console.warn('【拉取被回复消息失败】', err.response?.data?.msg || err.message)
  }
  return null
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
 * 处理 @机器人的群消息:走 LLM 一问一答并回复。两种形态:
 *  ① 直接 @机器人 提问 —— 抽本条消息文字作问题。
 *  ② 回复某条消息 + @机器人(可不打字)—— 把"被回复消息"当上下文喂给 LLM:
 *     是收/支记录就补录、是问题就回答、不像有效请求就自然回应。
 * 调用方已保证只在「新消息(非重复投递)」时进入,重复消息在 handleIncomingMessage 早退。
 */
async function tryAnswerMention(message: any, openId: string): Promise<void> {
  if (message.chat_type !== 'group') return

  if (!botOpenId) {
    // botOpenId 未就绪(拉取中或失败),收到含 @ 的消息时提示
    if (Array.isArray(message.mentions) && message.mentions.length) {
      console.log('⚠️ botOpenId 未就绪,暂无法处理 @机器人消息')
    }
    return
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const atBot = mentions.some((m: any) => m?.id?.open_id === botOpenId)
  if (!atBot) return

  const own = extractContent(message)
  const userText = own?.text ?? ''
  const replyImageKeys = own?.imageKeys ?? []

  let question = userText
  let imageKeys = replyImageKeys
  let sourceMessageId: string | undefined

  // 回复某条消息 + @机器人 → 把被回复消息当上下文(可补录,可不打字)
  if (message.parent_id) {
    const parent = await loadParentContent(message.parent_id)
    if (parent) {
      const header = userText
        ? `（用户回复了一条消息并@机器人,本次补充说:${userText}。下方"【被回复的消息】"是这次对话的上下文,请据此判断要做什么。）`
        : `（用户回复了一条消息并@机器人,没有额外打字,意图是让机器人处理下方这条"【被回复的消息】"。请判断它是什么并相应处理。）`
      question = `${header}\n【被回复的消息】\n${parent.text}`
      // 凭证图:被回复消息里的图优先,合并本条回复里带的图
      const seen = new Set(parent.imageKeys)
      imageKeys = [...parent.imageKeys, ...replyImageKeys.filter((k) => !seen.has(k))]
      sourceMessageId = message.parent_id
      console.log(`↩️ 补录模式:被回复消息作为上下文(${parent.text.length}字${parent.imageKeys.length ? `, ${parent.imageKeys.length}张凭证图` : ''})`)
    } else if (!userText) {
      // 拉不到原消息、用户也没打字 → 没法处理,提示一下
      console.log('↩️ 回复+@机器人,但被回复消息拉不到且无文字,提示用户')
      await replyMessage(message.message_id, `<at user_id="${openId}"></at> 没看到你回复的那条消息内容诶,要不把要办的事直接发给我?`)
        .catch((e: any) => console.error('【兜底回复失败】', e.response?.data?.msg || e.message))
      return
    }
    // 拉不到原消息但有 userText → 当普通问答,用 userText 继续往下走
  } else if (!userText) {
    // 非回复、且无文字(纯 @机器人)→ 无内容可处理,忽略
    return
  }

  console.log('🤖 @机器人:', userText || '(无文字,走补录)', imageKeys.length ? `(附带 ${imageKeys.length} 张凭证图)` : '')
  const ctx: LlmContext = {
    originalMessageId: message.message_id,
    userOpenId: openId,
    chatId: message.chat_id,
    voucherImageKeys: imageKeys.length ? imageKeys : undefined,
    sourceMessageId,
  }

  try {
    const answer = await askLLM(question, ctx)
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
 */
async function handleIncomingMessage(data: FeishuEvent): Promise<void> {
  const { message, sender } = data
  const openId = sender.sender_id.open_id

  // 先落库(INSERT OR IGNORE 去重,source=realtime)
  const isNew = saveMessage(data, 'realtime')

  // 飞书长连接会重投递同一条消息(ACK 超时/连接抖动/服务端重试均会触发)。
  // 靠 message_id 主键去重:重复消息直接早退,不打详细日志、不重复处理。
  if (!isNew) {
    console.log('⏭️ 重复消息已跳过(飞书重投递), message_id:', message.message_id)
    return
  }

  console.log('✅ 已入库 message_id:', message.message_id)

  // 异步补名字,拿到后回填
  const userName = await getUserName(openId)
  if (userName) fillSenderName(message.message_id, userName)

  const text = parseMessageText(message)
  logIncomingMessage(userName, message, text)

  // isNew 恒为 true(重复已在上面早退),这里只走一次
  await tryAnswerMention(message, openId)
}

/**
 * 启动飞书 worker:注册消息事件 + 启动长连接 + 调度历史补漏。
 * 与 HTTP 服务并行运行在同一个进程里。
 */
export function startFeishuWorker(): void {
  // 异步拉取机器人 open_id(不阻塞启动;未就绪期间收到的 @消息会被跳过)
  loadBotOpenId().then((id) => { botOpenId = id }).catch((e: any) => console.error('【loadBotOpenId 未捕获】', e?.message ?? e))

  // 注册消息事件 + 多维表格记录变更事件(反向同步)
  // 顶层 try/catch:任一未预期异常都兜住,避免 async 回调 reject 冒泡到 SDK、拖垮长连接
  const eventDispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data: FeishuEvent) => {
      try { await handleIncomingMessage(data) }
      catch (e: any) { console.error('【消息事件处理异常】', e?.stack ?? e?.message ?? e) }
    },
    'drive.file.bitable_record_changed_v1': async (data: FeishuEvent) => {
      try { await handleBitableRecordChanged(data) }
      catch (e: any) { console.error('【多维表格事件处理异常】', e?.stack ?? e?.message ?? e) }
    },
  })

  // 启动长连接
  wsClient.start({ eventDispatcher })
  console.log('✅ 飞书长连接已启动,正在监听群消息...')
  // 订阅多维表格云文档事件(幂等),开启「表格改动 → 回写 SQLite」反向同步
  subscribeBitable().catch((e) => console.warn('【订阅多维表格失败】', e.message ?? e))

  // 历史补漏调度:启动5秒后跑一次,之后每24小时一次(source=history,靠message_id去重)
  const ONE_DAY_MS = 24 * 60 * 60 * 1000
  setTimeout(() => {
    fetchHistoryGap(apiClient).catch(e => console.error('【补漏出错】', e.message))
  }, 5000)
  setInterval(() => {
    fetchHistoryGap(apiClient).catch(e => console.error('【补漏出错】', e.message))
  }, ONE_DAY_MS)
  console.log('⏰ 历史补漏已调度:启动5秒后执行一次,之后每24小时一次')

  // 提醒调度器:每60秒轮询到点的提醒,reply 原消息 @用户
  startReminderScheduler()
}
