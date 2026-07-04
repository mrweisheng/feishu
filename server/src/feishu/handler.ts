import { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { apiClient, wsClient } from './client.js'
import { saveMessage, fillSenderName } from '../db/messages.js'
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

// 判断是否 @了机器人;是则返回去掉 @占位符后的纯问题文本,否则返回 null
function extractQuestion(message: any, botId: string): string | null {
  if (message.message_type !== 'text') return null
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const atBot = mentions.some((m: any) => m?.id?.open_id === botId)
  if (!atBot) return null

  let raw = ''
  try {
    raw = JSON.parse(message.content).text || ''
  } catch {
    return null
  }
  return raw.replace(/@_user_\d+/g, '').trim()
}

// 解析消息文本(用于日志展示),失败回退为 [非文本消息]
function parseMessageText(message: any): string {
  let text = '[非文本消息]'
  try {
    const contentObj = JSON.parse(message.content)
    text = contentObj.text || text
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
 * 处理 @机器人的群消息:走 LLM 一问一答并回复。
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

  const question = extractQuestion(message, botOpenId)
  if (!question) return

  console.log('🤖 @机器人提问:', question)
  const ctx: LlmContext = {
    originalMessageId: message.message_id,
    userOpenId: openId,
    chatId: message.chat_id,
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
  loadBotOpenId().then((id) => { botOpenId = id })

  // 注册消息事件 + 多维表格记录变更事件(反向同步)
  const eventDispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data: FeishuEvent) => {
      await handleIncomingMessage(data)
    },
    'drive.file.bitable_record_changed_v1': async (data: FeishuEvent) => {
      await handleBitableRecordChanged(data)
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
