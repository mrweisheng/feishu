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

/**
 * 上传一张图片到飞书(im/v1/images),返回 image_key(用于图片消息/富文本)。
 * 走 SDK 官方接口,直接收 Buffer,由 SDK 组装 multipart。
 */
export async function uploadFeishuImage(buf: Buffer): Promise<string> {
  const res = await apiClient.im.v1.image.create({
    data: { image_type: 'message', image: buf },
  })
  const key = res?.image_key
  if (!key) throw new Error(`上传图片无 image_key 返回: ${JSON.stringify(res)?.slice(0, 300)}`)
  return key
}

/**
 * 回复一条富文本(post)消息:文字 + @用户 + 图片(同一条富文本里,引用挂在原消息下)。
 */
export async function replyPostWithImage(
  messageId: string,
  userOpenId: string,
  imageKey: string,
  text: string,
): Promise<void> {
  const content = {
    zh_cn: {
      content: [
        [
          { tag: 'text', text: `${text}\n` },
          { tag: 'at', user_id: userOpenId },
        ],
        [{ tag: 'img', image_key: imageKey }],
      ],
    },
  }
  await apiClient.request({
    method: 'POST',
    url: `/open-apis/im/v1/messages/${messageId}/reply`,
    data: {
      msg_type: 'post',
      content: JSON.stringify(content),
    },
  })
}
