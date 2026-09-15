import zlib from 'node:zlib'

/**
 * 从 Buffer 里提取文档纯文字(当前支持:docx / txt / md / csv)。
 * 场景:群里发文档(口岸 + 一堆车牌),@机器人生成靓号推荐——LLM 读不了二进制,
 * 先在这里转成纯文本再喂给它。
 *
 * docx 是 zip 包,word/document.xml 是正文。这里实现了一个最小的 zip 读取器
 * (只解析 central directory,支持 stored/deflate 两种压缩),不引额外依赖。
 */

// ---- 最小 zip 读取 ----

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

/** 定位 EOCD(End Of Central Directory),返回 central directory 起始偏移和条目数 */
function locateEOCD(buf: Buffer): { cdOffset: number; count: number } | null {
  // EOCD 签名 0x06054b50,注释最长 65535,从尾部往前扫
  const minStart = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue
    const count = buf.readUInt16LE(i + 10)
    const cdOffset = buf.readUInt32LE(i + 16)
    return { cdOffset, count }
  }
  return null
}

/** 解析 central directory,列出所有条目 */
function listEntries(buf: Buffer): ZipEntry[] {
  const eocd = locateEOCD(buf)
  if (!eocd) throw new Error('不是有效的 zip 文件(找不到 EOCD)')
  const entries: ZipEntry[] = []
  let p = eocd.cdOffset
  for (let i = 0; i < eocd.count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break // central dir file header
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compressedSize, localHeaderOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 读出 zip 里某个文件的原始字节 */
function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`zip 条目 ${entry.name} local header 损坏`)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw) // stored
  if (entry.method === 8) return zlib.inflateRawSync(raw) // deflate
  throw new Error(`zip 条目 ${entry.name} 用了不支持的压缩方式 method=${entry.method}`)
}

// ---- XML → 纯文字 ----

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    // 连续空行压成一行,LLM 不需要原始排版
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 提取文档纯文字。
 * @returns 提取出的文字;格式不支持/解析失败返回 null(调用方决定怎么向用户解释)
 */
export function extractDocumentText(fileName: string, buf: Buffer, maxChars = 20_000): string | null {
  const lower = fileName.toLowerCase()
  try {
    if (lower.endsWith('.docx')) {
      const entries = listEntries(buf)
      const doc = entries.find((e) => e.name === 'word/document.xml')
      if (!doc) return null
      const xml = readEntry(buf, doc).toString('utf8')
      return xmlToText(xml).slice(0, maxChars)
    }
    if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) {
      return buf.toString('utf8').slice(0, maxChars)
    }
  } catch (err: any) {
    console.error('【文档解析失败】file=', fileName, 'msg:', err.message)
    return null
  }
  return null
}
