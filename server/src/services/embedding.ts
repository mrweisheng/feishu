import { config } from '../config.js'

/**
 * 嵌入客户端 —— provider adapter 模式。
 *
 * 为什么不能直接"包一层 OpenAI SDK 就完事":
 * 不同厂商的 embeddings 协议**并不统一**。实测 MiniMax 用的是
 * `{model, texts, type}` → `{vectors: [[...]]}`,跟 OpenAI 的
 * `{model, input}` → `{data: [{embedding}]}` 完全不是一回事,
 * 按 OpenAI 格式打会直接 400。所以这里留出 adapter 接口,
 * 换 provider 只需新增一个实现,不用动摄入/检索逻辑。
 *
 * 当前默认实现 = OpenAI 兼容格式(硅基流动 BAAI/bge-m3 走这套)。
 */

export interface Embedder {
  /** 模型 id,会写进 kb_docs.embedding_model 做指纹校验 */
  id: string
  /** 维度 */
  dimensions: number
  /** 批量嵌入,返回顺序与输入一致 */
  embed(texts: string[]): Promise<number[][]>
}

/** 单批条数:官方未标上限,16 条是"够快又不至于单请求过大"的保守值 */
const BATCH_SIZE = 16
/** 429 / 5xx 的重试次数与退避基数 */
const MAX_RETRIES = 3
const RETRY_BASE_MS = 1000

class EmbeddingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** OpenAI 兼容格式:{model, input} → {data:[{embedding, index}]} */
class OpenAiCompatibleEmbedder implements Embedder {
  constructor(
    readonly id: string,
    readonly dimensions: number,
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return []
    const out: number[][] = new Array(texts.length)

    // 分批 + 限并发:免费/低价档有 RPM/TPM 限流,并发开大只会吃 429
    const batches: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const idx: number[] = []
      for (let j = i; j < Math.min(i + BATCH_SIZE, texts.length); j++) idx.push(j)
      batches.push(idx)
    }

    let cursor = 0
    const workers = new Array(Math.max(1, config.KB_EMBED_CONCURRENCY)).fill(null).map(async () => {
      while (cursor < batches.length) {
        const idx = batches[cursor++]
        const vecs = await this.requestBatch(idx.map((i) => texts[i]))
        idx.forEach((i, n) => { out[i] = vecs[n] })
      }
    })
    await Promise.all(workers)
    return out
  }

  private async requestBatch(input: string[]): Promise<number[][]> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: this.id, input, encoding_format: 'float' }),
          // 硬超时:网络挂起时不能把启动自检 / 检索无限拖住
          signal: AbortSignal.timeout(30_000),
        })
        if (res.status === 429 || res.status >= 500) {
          // 限流/服务端错误:指数退避后重试。
          // ⚠️ 必须在这里记下 lastErr:重试耗尽后抛出的是它,不记的话最终错误
          //    消息会是 "undefined"(4 次全吃 429 时必然走到这条路,排查时非常困惑)
          lastErr = new EmbeddingError(`HTTP ${res.status}`, res.status)
          if (attempt === MAX_RETRIES) break // 最后一次不再空等一轮退避
          const wait = RETRY_BASE_MS * 2 ** attempt
          console.warn(`【嵌入】${res.status},${wait}ms 后重试(${attempt + 1}/${MAX_RETRIES})`)
          await sleep(wait)
          continue
        }
        const json: any = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new EmbeddingError(json?.message || json?.error?.message || `HTTP ${res.status}`, res.status)
        }
        const data = json?.data
        if (!Array.isArray(data) || data.length !== input.length) {
          throw new EmbeddingError(`嵌入响应条数不符:期望 ${input.length},实际 ${data?.length ?? 0}`)
        }
        // 按 index 还原顺序(部分 provider 不保证顺序)
        const sorted = [...data].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
        return sorted.map((d: any) => {
          const v = d?.embedding
          if (!Array.isArray(v) || v.length !== this.dimensions) {
            throw new EmbeddingError(`嵌入维度不符:期望 ${this.dimensions},实际 ${v?.length ?? 0}`)
          }
          return v as number[]
        })
      } catch (err: any) {
        lastErr = err
        // 客户端错误(401/400 等)重试无意义,直接抛
        if (err instanceof EmbeddingError && err.status && err.status < 500 && err.status !== 429) throw err
        if (attempt === MAX_RETRIES) break
        await sleep(RETRY_BASE_MS * 2 ** attempt)
      }
    }
    throw lastErr instanceof Error ? lastErr : new EmbeddingError(String(lastErr))
  }
}

let cached: Embedder | null = null

/** 按 config 创建(单例)嵌入客户端 */
export function getEmbedder(): Embedder {
  if (cached) return cached
  if (!config.EMBEDDING_API_KEY) {
    throw new EmbeddingError('未配置 EMBEDDING_API_KEY,知识库嵌入不可用(向量检索关闭后仍可纯关键词检索)')
  }
  cached = new OpenAiCompatibleEmbedder(
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIM,
    config.EMBEDDING_BASE_URL,
    config.EMBEDDING_API_KEY
  )
  return cached
}

export interface SelfCheckResult {
  ok: boolean
  model: string
  expectedDim: number
  actualDim: number | null
  latencyMs: number
  error?: string
}

/**
 * 启动自检:打一条测试文本,校验「模型实际返回维度 == 配置维度」。
 *
 * 为什么必须做:bge-m3 的输出是 1024 维且不支持 dimensions 参数,
 * 一旦 MODEL 和 DIM 配错(换模型忘了改 DIM),全库向量都会写错,
 * 检索时不会报错,只会静默返回垃圾结果。
 *
 * 注意自检**不阻断启动**:失败时服务照常起,只是降级为纯关键词检索(FTS5),
 * 由 index.ts 打印告警并跳过启动对账。这是刻意的取舍 —— 嵌入服务临时抖动
 * 不该让飞书长连接整个起不来,消息归档和客资登记比知识库更重要。
 */
export async function selfCheckEmbedder(): Promise<SelfCheckResult> {
  const started = Date.now()
  const base = { model: config.EMBEDDING_MODEL, expectedDim: config.EMBEDDING_DIM }
  try {
    const emb = getEmbedder()
    const [vec] = await emb.embed(['知识库启动自检'])
    const actualDim = vec?.length ?? null
    const ok = actualDim === config.EMBEDDING_DIM
    return { ok, ...base, actualDim, latencyMs: Date.now() - started, error: ok ? undefined : `维度不符:配置 ${config.EMBEDDING_DIM},实际 ${actualDim}` }
  } catch (err: any) {
    return { ok: false, ...base, actualDim: null, latencyMs: Date.now() - started, error: err.message }
  }
}
