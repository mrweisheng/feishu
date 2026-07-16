import { apiClient } from './client.js'
import type { Readable } from 'node:stream'
import sharp from 'sharp'

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export interface DownloadedImage {
  base64: string
  mediaType: ImageMediaType
  originalBytes: number
  finalBytes: number
}

/**
 * 通过 im.messageResource.get 下载消息里的图片,自动压缩后返回 base64。
 * - 长边 ≤ 1568: Anthropic 推荐上限,过小会让 LLM 把中文"小"误认成拉丁"J"
 * - 输出统一 JPEG q90(q80 在小字下糊得厉害,中文识别率掉)
 * - 原图已 < 200KB 跳过压缩,直接用原图(避免无谓的画质损失)
 * - sharp 不可用 / 失败:兜底用原图 + 警告日志
 * type 参数必传(image / file 等),SDK 不传会 400。
 */
export async function downloadMessageImage(messageId: string, fileKey: string): Promise<DownloadedImage | null> {
  let raw: Buffer
  try {
    const res: any = await apiClient.im.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: fileKey },
    })
    const stream: Readable | undefined = res?.getReadableStream?.()
    if (!stream) {
      console.warn('【下载图片】无 readable stream,messageId=', messageId, 'fileKey=', fileKey)
      return null
    }
    raw = await streamToBuffer(stream)
  } catch (err: any) {
    const fb = err.response?.data
    console.error('【下载图片失败】messageId=', messageId, 'fileKey=', fileKey,
      'http:', err.response?.status, 'code:', fb?.code, 'msg:', fb?.msg || err.message)
    return null
  }
  if (raw.length === 0) {
    console.warn('【下载图片】空 buffer,messageId=', messageId, 'fileKey=', fileKey)
    return null
  }

  // 小图直接用,免去无谓的转码损失
  if (raw.length < 200 * 1024) {
    return {
      base64: raw.toString('base64'),
      mediaType: detectMediaType(raw),
      originalBytes: raw.length,
      finalBytes: raw.length,
    }
  }

  // 大图走 sharp 压缩
  try {
    const compressed = await sharp(raw)
      .rotate() // 按 EXIF 自动旋正(手机截图经常方向错)
      .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: false })
      .toBuffer()
    console.log(`📷 压缩图片: ${(raw.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`)
    return {
      base64: compressed.toString('base64'),
      mediaType: 'image/jpeg',
      originalBytes: raw.length,
      finalBytes: compressed.length,
    }
  } catch (err: any) {
    // sharp 失败(原生库问题、格式异常等)——兜底用原图,但记 warning
    console.warn('【图片压缩失败, 用原图】messageId=', messageId, 'msg:', err.message)
    return {
      base64: raw.toString('base64'),
      mediaType: detectMediaType(raw),
      originalBytes: raw.length,
      finalBytes: raw.length,
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

// 看 magic bytes 识别图片格式;不识别就当 jpeg
function detectMediaType(buf: Buffer): ImageMediaType {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
    if (
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length >= 12 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
      return 'image/webp'
    }
  }
  return 'image/jpeg'
}

