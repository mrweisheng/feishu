// 后台 API 封装(开发期经 vite proxy 走到 localhost:4111)

export interface MessageItem {
  message_id: string
  chat_id: string
  chat_type: string
  message_type: string
  sender_name: string | null
  content: string | null
  create_time: number | null
  source: string
}

export interface MessageList {
  total: number
  limit: number
  offset: number
  items: MessageItem[]
}

export async function fetchMessages(params: { limit?: number; offset?: number; chat_id?: string } = {}): Promise<MessageList> {
  const qs = new URLSearchParams()
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.offset) qs.set('offset', String(params.offset))
  if (params.chat_id) qs.set('chat_id', params.chat_id)
  const res = await fetch(`/api/messages?${qs.toString()}`)
  if (!res.ok) throw new Error(`拉取消息失败: ${res.status}`)
  return res.json()
}
