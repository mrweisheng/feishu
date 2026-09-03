/**
 * 切片器 —— 递归字符切分,中文分隔符特化。
 *
 * 不引 LangChain:它默认分隔符是 ["\n\n","\n"," ",""](段落→行→空格→字符),
 * 用在中文上会退化成"按行切",长段落直接被塞进一个 chunk,语义不聚焦。
 * 官方文档也明确:中文/日文/泰文没有词边界,必须覆盖分隔符加全角标点。
 * 这里按「段落 → 行 → 句末标点 → 句中标点 → 空格 → 字符」逐级回退。
 */

/** 回退顺序:先保段落完整,实在太长才退到标点、最后才按字符硬切 */
const SEPARATORS = ['\n\n', '\n', '。', '！', '？', '；', '…', '，', '、', ' ', ''] as const

export interface ChunkOptions {
  /** 目标字符数 */
  size: number
  /** 相邻 chunk 重叠字符数(缓解句子被切断导致的语义丢失) */
  overlap: number
}

/** 归一化:回车换行、连续空行、零宽字符 —— 不处理会让切片边界错位 */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 递归切分:用当前分隔符切不开,就换下一级分隔符再试。
 * 切出来的片段中,超长的会被继续下切,短的直接保留。
 */
function splitRecursive(text: string, seps: readonly string[], limit: number): string[] {
  if (text.length <= limit) return [text]
  const sep = seps[0]
  // 分隔符用尽(最后一级是空串)→ 按字符硬切,保底不丢内容
  if (sep === undefined || sep === '') return splitByChar(text, limit)

  const parts = text.split(sep)
  if (parts.length === 1) return splitRecursive(text, seps.slice(1), limit)

  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    // 除最后一段外,把分隔符还回去,保证拼起来还是原文
    const piece = i < parts.length - 1 ? parts[i] + sep : parts[i]
    if (!piece.trim()) continue
    if (piece.length <= limit) out.push(piece)
    else out.push(...splitRecursive(piece, seps.slice(1), limit))
  }
  return out
}

function splitByChar(text: string, limit: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit))
  return out
}

/** 把零散片段合并成接近 size 的块,相邻块之间保留 overlap 个字符 */
function mergeWithOverlap(pieces: string[], size: number, overlap: number): string[] {
  if (!pieces.length) return []
  const out: string[] = []
  let cur = ''
  for (const piece of pieces) {
    if (!cur) {
      cur = piece
      continue
    }
    if (cur.length + piece.length <= size) {
      cur += piece
      continue
    }
    out.push(cur)
    // 下一段从上一段尾部 overlap 字符开始,避免上下文断档
    cur = overlap > 0 ? cur.slice(Math.max(0, cur.length - overlap)) + piece : piece
  }
  if (cur) out.push(cur)
  return out
}

/** 切分文本 → 切片数组 */
export function chunkText(text: string, opts: ChunkOptions): string[] {
  const clean = normalize(text)
  if (!clean) return []
  const size = Math.max(50, opts.size)
  const overlap = Math.max(0, Math.min(opts.overlap, Math.floor(size / 2)))

  const pieces = splitRecursive(clean, SEPARATORS, size)
  // 单篇只有一个短片段时,合并步骤原样返回,不需要特殊处理
  return mergeWithOverlap(pieces, size, overlap).map((s) => s.trim()).filter(Boolean)
}

/**
 * 保守估算 token 数(用于超限告警,不用于计费)。
 * 中文按 1 字 ≈ 1 token 估(高估),其余字符按 4 字符 ≈ 1 token。
 * 高估是故意的:宁可早报超限,也不能让 chunk 被嵌入模型静默截断。
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}
