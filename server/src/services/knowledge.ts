import { config } from '../config.js'
import {
  type DocStatus,
  type KbDoc,
  getDoc,
  getChunksWithDoc,
  insertDoc,
  isVecReady,
  listAllDocIds,
  listDocsByStatus,
  replaceChunks,
  searchFts,
  searchVec,
  updateDocStatus,
} from '../db/knowledgeBase.js'
import { chunkText } from './chunker.js'
import { getEmbedder } from './embedding.js'

/**
 * 知识库服务层:摄入(切片 → 嵌入 → 落库)+ 混合检索(向量 + BM25 → RRF 融合)。
 *
 * 知识库是**独立内容源**:只由 /admin 管理页录入,与飞书消息归档、客资表无关,
 * 不导入任何存量数据。
 */

// ---------------------------------------------------------------- 摄入

/**
 * 异步索引队列(串行)。
 * 为什么串行:嵌入要打外部 API,免费/低价档有 RPM/TPM 限流,
 * 多个文档并发索引只会互相抢额度吃 429。串行最稳,而且单次索引本来就不慢。
 */
let queue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): void {
  queue = queue
    .catch(() => {}) // 前一个任务失败不影响后续任务
    .then(task)
    .catch((err: any) => console.error('【知识库】索引任务异常:', err.message))
}

/** 录入一篇文档(同步落库,异步索引,不阻塞请求) */
export function createDoc(input: { title: string; content: string; sourceType?: string }): KbDoc {
  const id = insertDoc(input)
  enqueue(() => indexDoc(id))
  return getDoc(id)!
}

/**
 * 索引单篇文档 —— 状态机核心。
 * pending → indexing → ready / failed
 *
 * 嵌入失败会保留原文并把状态标 failed(带 error),管理页可看到原因并手动重试,
 * 不会出现"搜不到但不知道为什么"的黑盒。
 */
export async function indexDoc(docId: number): Promise<void> {
  const doc = getDoc(docId)
  if (!doc) return

  updateDocStatus(docId, 'indexing', { error: null })

  try {
    const chunks = chunkText(doc.content, {
      size: config.KB_CHUNK_SIZE,
      overlap: config.KB_CHUNK_OVERLAP,
    })
    if (!chunks.length) {
      updateDocStatus(docId, 'failed', { error: '内容为空或切片后为空', bumpRetry: true })
      return
    }

    // 向量扩展不可用时降级为纯关键词检索:切片和 FTS 照常写,只是没有 embedding
    let embeddings: Array<number[] | null>
    if (isVecReady()) {
      try {
        embeddings = await getEmbedder().embed(chunks)
      } catch (err: any) {
        updateDocStatus(docId, 'failed', { error: `嵌入失败: ${err.message}`, bumpRetry: true })
        console.error(`【知识库】文档 ${docId}「${doc.title}」嵌入失败:`, err.message)
        return
      }
    } else {
      embeddings = chunks.map(() => null)
    }

    replaceChunks(docId, chunks.map((text, i) => ({ text, embedding: embeddings[i] })))
    updateDocStatus(docId, 'ready', {
      error: null,
      chunkCount: chunks.length,
      model: config.EMBEDDING_MODEL,
      dim: isVecReady() ? config.EMBEDDING_DIM : null,
    })
    console.log(`📚 知识库索引完成:「${doc.title}」${chunks.length} 个切片`)
  } catch (err: any) {
    updateDocStatus(docId, 'failed', { error: err.message, bumpRetry: true })
    console.error(`【知识库】文档 ${docId}「${doc.title}」索引失败:`, err.message)
  }
}

/** 手动重新索引(管理页「重建」按钮、以及换模型后批量重建用) */
export function reindexDoc(docId: number): void {
  enqueue(() => indexDoc(docId))
}

/**
 * 启动时对账:把上次没做完 / 已失效的文档重新入队。
 *  - pending / indexing:上次进程退出时没跑完
 *  - stale:嵌入模型或维度变了,旧向量作废
 *  - failed:不自动重跑(大概率是配置或内容问题,需人工看 error 决定)
 */
export function reconcileOnStartup(): number {
  const targets: KbDoc[] = [
    ...listDocsByStatus('pending'),
    ...listDocsByStatus('indexing'),
    ...listDocsByStatus('stale'),
  ]
  for (const d of targets) enqueue(() => indexDoc(d.id))
  if (targets.length) {
    console.log(`📚 知识库启动对账:${targets.length} 篇文档待重新索引`)
  }
  return targets.length
}

/**
 * 全量重建(换模型后一键重来;正文不丢,只重建切片与索引)
 *
 * ⚠️ 必须走 listAllDocIds() 而不是 listDocs():listDocs 有 200 条上限,
 *    传 limit: 10000 也会被钳回 200,第 201 篇之后静默漏掉。
 */
export function rebuildAll(): number {
  const ids = listAllDocIds()
  for (const id of ids) enqueue(() => indexDoc(id))
  return ids.length
}

// ---------------------------------------------------------------- 检索

export interface SearchHit {
  chunkId: number
  docId: number
  docTitle: string
  text: string
  /** RRF 融合分(越高越相关) */
  score: number
  /** 命中来源,便于管理页调参时看清是哪路召回的 */
  via: ('vec' | 'fts')[]
}

/**
 * 混合检索:向量 topN + BM25 topN → RRF 融合 → topK。
 *
 * 为什么必须双路:纯向量对专有名词(车型、合同号、人名)极弱 ——
 * bge-m3 在中文上相关与不相关的 cosine 差距只有 0.2 左右,
 * 遇到 "Alphard 30系" "HT2025062414501664F7" 这类字符串,向量基本靠猜,
 * 而 BM25 精确匹配正好补上这块。反过来,同义表述靠向量。
 *
 * 为什么用 RRF 而不是加权求和:cosine 距离和 bm25 分数的量纲、分布完全不同
 * (前者 0~2,后者负无穷~-0.x),加权需要先归一化且调参困难。
 * RRF 只用排名不看分数,免调参,是混合检索的通行做法。
 */
export async function searchKnowledge(query: string, topK = config.KB_SEARCH_TOP_K): Promise<SearchHit[]> {
  const q = (query || '').trim()
  if (!q) return []

  const candidates = Math.max(topK, config.KB_SEARCH_CANDIDATES)

  // 两路并行召回;任一路失败不影响另一路
  const [vecHits, ftsHits] = await Promise.all([
    recallByVector(q, candidates),
    Promise.resolve(recallByKeyword(q, candidates)),
  ])

  if (!vecHits.length && !ftsHits.length) return []

  const fused = reciprocalRankFusion([
    vecHits.map((h) => h.chunkId),
    ftsHits.map((h) => h.chunkId),
  ])

  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK)
  const chunks = getChunksWithDoc(ranked.map(([id]) => id))
  const byId = new Map(chunks.map((c) => [c.chunkId, c]))

  const hits: SearchHit[] = []
  for (const [chunkId, score] of ranked) {
    const c = byId.get(chunkId)
    if (!c) continue // status 不是 ready 的文档,过滤掉了
    const via: ('vec' | 'fts')[] = []
    if (vecHits.some((h) => h.chunkId === chunkId)) via.push('vec')
    if (ftsHits.some((h) => h.chunkId === chunkId)) via.push('fts')
    hits.push({ chunkId, docId: c.docId, docTitle: c.title, text: c.text, score, via })
  }
  return hits
}

async function recallByVector(q: string, k: number): Promise<Array<{ chunkId: number; distance: number }>> {
  if (!isVecReady()) return []
  try {
    const [qv] = await getEmbedder().embed([q])
    return searchVec(qv, k)
  } catch (err: any) {
    // 检索期嵌入失败(限流/网络):降级为纯关键词,不能让整个检索挂掉
    console.error('【知识库】查询向量化失败,本次降级为纯关键词检索:', err.message)
    return []
  }
}

function recallByKeyword(q: string, k: number): Array<{ chunkId: number; score: number }> {
  return searchFts(q, k)
}

/**
 * RRF 融合见 services/rank.ts。
 * 原本写在本文件,但本模块 import 会立刻打开 SQLite 连接并读 config ——
 * 一个纯数学函数不该依赖这些才能跑单测,所以迁出去了,这里原样 re-export 保持调用方不变。
 */
export { reciprocalRankFusion }
import { reciprocalRankFusion } from './rank.js'

/** 给 LLM 用的检索结果(纯文本,带出处标题) */
export async function searchKnowledgeAsText(query: string, topK = config.KB_SEARCH_TOP_K): Promise<string> {
  const hits = await searchKnowledge(query, topK)
  if (!hits.length) return JSON.stringify({ ok: true, found: 0, results: [], hint: '知识库里没有找到相关内容' })
  return JSON.stringify({
    ok: true,
    found: hits.length,
    results: hits.map((h, i) => ({
      rank: i + 1,
      source: h.docTitle,
      content: h.text,
    })),
  })
}

export type { DocStatus }
