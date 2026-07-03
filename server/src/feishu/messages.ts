import { apiClient } from './client.js'

// 回复指定消息(引用回复,挂在原消息下)
export async function replyMessage(messageId: string, text: string): Promise<void> {
  await apiClient.request({
    method: 'POST',
    url: `/open-apis/im/v1/messages/${messageId}/reply`,
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  })
}
