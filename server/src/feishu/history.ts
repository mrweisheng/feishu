import { saveMessage, getMaxCreateTimeOfChat, listKnownChatIds } from '../db/messages.js'

// 重叠窗口:从上次最后一条消息时间往前回退5分钟,靠 message_id 去重吸收
const OVERLAP_MS = 5 * 60 * 1000
const PAGE_SIZE = 50
const MAX_PAGES = 500 // 防异常死循环

/**
 * 把历史API返回的单条消息适配成实时事件相同的结构,复用 saveMessage 入库。
 * 历史 API: sender={id,id_type,sender_type}, msg_type, body.content, create_time(毫秒)
 * 实时事件: sender.sender_id.{open_id|user_id|union_id}, message_type, content, create_time(毫秒)
 */
function adapt(item: any): Record<string, any> {
  const sid = item.sender || {}
  const senderIdObj: Record<string, string> = {}
  if (sid.id_type === 'open_id')  senderIdObj.open_id  = sid.id
  else if (sid.id_type === 'user_id')  senderIdObj.user_id  = sid.id
  else if (sid.id_type === 'union_id') senderIdObj.union_id = sid.id
  // id_type=app_id 时无对应列,靠 raw_data 兜底

  let mentions
  if (Array.isArray(item.mentions) && item.mentions.length) {
    mentions = item.mentions.map((m: any) => {
      let idObj: Record<string, string> = {}
      if (m.id && typeof m.id === 'object') {
        idObj = m.id // 已是 {open_id,...} 形态
      } else if (m.id != null) {
        if (m.id_type === 'open_id')  idObj.open_id  = m.id
        else if (m.id_type === 'user_id')  idObj.user_id  = m.id
        else if (m.id_type === 'union_id') idObj.union_id = m.id
      }
      return { key: m.key, id: idObj, name: m.name }
    })
  }

  return {
    sender: { sender_id: senderIdObj, sender_type: sid.sender_type },
    message: {
      message_id:  item.message_id,
      chat_id:     item.chat_id,
      chat_type:   item.chat_type,
      message_type: item.message_type || item.msg_type, // 历史 API 字段名是 msg_type
      content:     item.body?.content ?? null,
      create_time: item.create_time, // 已是毫秒字符串,与实时事件一致
      root_id:     item.root_id ?? null,
      parent_id:   item.parent_id ?? null,
      mentions,
    },
  }
}

// 拉取指定群在 [startMs, endMs] 内的全部历史消息(毫秒),分页入库
async function fetchChatSince(apiClient: any, chatId: string, startMs: number, endMs: number): Promise<number> {
  const startSec = String(Math.floor(startMs / 1000))
  const endSec   = String(Math.floor(endMs   / 1000))
  let pageToken: string | null = null
  let hasMore = true
  let total = 0

  for (let i = 0; hasMore && i < MAX_PAGES; i++) {
    const params: Record<string, any> = {
      container_id_type: 'chat',
      container_id: chatId,
      start_time: startSec,
      end_time: endSec,
      page_size: PAGE_SIZE,
      sort_type: 'ByCreateTimeAsc',
    }
    if (pageToken) params.page_token = pageToken

    const res = await apiClient.request({
      method: 'GET',
      url: '/open-apis/im/v1/messages',
      params,
    })

    if (res.code !== 0) {
      throw new Error(`code=${res.code} msg=${res.msg}`)
    }

    const items = res.data?.items || []
    for (const item of items) {
      if (saveMessage(adapt(item), 'history')) total++
    }

    hasMore = !!res.data?.has_more
    pageToken = res.data?.page_token || null
  }
  return total
}

// 拉取机器人所在的所有群(含 p2p),作为补漏目标 + 冷启动种子
async function listBotChats(apiClient: any): Promise<Array<{ chat_id: string; name: string | null; chat_type: string | null }>> {
  const chats: Array<{ chat_id: string; name: string | null; chat_type: string | null }> = []
  let pageToken: string | null = null
  for (let i = 0; i < 100; i++) {
    const params: Record<string, any> = { page_size: 100, user_id_type: 'open_id' }
    if (pageToken) params.page_token = pageToken
    const res = await apiClient.request({
      method: 'GET',
      url: '/open-apis/im/v1/chats',
      params,
    })
    if (res.code !== 0) {
      throw new Error(`list chats code=${res.code} msg=${res.msg}`)
    }
    for (const c of (res.data?.items || [])) {
      chats.push({ chat_id: c.chat_id, name: c.name, chat_type: c.chat_type })
    }
    if (!res.data?.has_more) break
    pageToken = res.data?.page_token || null
  }
  return chats
}

/**
 * 历史补漏:以「机器人所在群」为目标(冷启动也能用),从库里该群最后一条消息时间增量拉取。
 * @returns 本次新增条数
 */
export async function fetchHistoryGap(apiClient: any): Promise<number> {
  console.log('\n=== 历史补漏开始 ===')

  // 目标群 = 机器人所在群(API 实时拉取,自动覆盖新加入的群,且解决冷启动)
  let targets
  try {
    targets = await listBotChats(apiClient)
  } catch (e: any) {
    console.error('拉取群列表失败,回退到库中已知群:', e.message)
    targets = listKnownChatIds().map((chat_id) => ({ chat_id, name: null, chat_type: null }))
  }

  if (!targets.length) {
    console.log('未获取到任何群(机器人可能未加入任何群,或缺少 im:chat:readonly 权限),跳过补漏。')
    return 0
  }
  console.log(`目标群 ${targets.length} 个`)

  const now = Date.now()
  let total = 0

  for (const { chat_id, name } of targets) {
    // 没记录就拉最近7天;有记录则从最后一条往前回退5分钟重叠
    const lastMs = getMaxCreateTimeOfChat(chat_id) || (now - 7 * 24 * 60 * 60 * 1000)
    const startMs = Math.max(0, lastMs - OVERLAP_MS)

    if (startMs >= now) {
      console.log(`群 ${name || chat_id}: 暂无需补漏`)
      continue
    }

    const label = name ? `${name} (${chat_id})` : chat_id
    try {
      const n = await fetchChatSince(apiClient, chat_id, startMs, now)
      total += n
      console.log(`群 ${label}: 新增 ${n} 条 (起 ${new Date(startMs).toLocaleString()})`)
    } catch (e: any) {
      console.error(`群 ${label} 补漏失败:`, e.message)
    }
  }

  console.log(`=== 历史补漏完成,共新增 ${total} 条 ===\n`)
  return total
}
