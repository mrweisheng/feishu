// 与 db/messages.ts 等模块保持一致:从这里 import db,副作用会触发建表与迁移。
// ⚠️ 不要改成延迟绑定(let db 由 init 赋值)——那样只导入本模块时 db 从未初始化,
//    所有查询会报 "Cannot read properties of undefined (reading 'prepare')"。
//    循环依赖是安全的:函数声明在 ESM 实例化阶段提升,db/index.ts 最后才调 initKnowledgeBase。
import { db, vecAvailable } from './index.js'
import { config } from '../config.js'

/**
 * 知识库数据层 —— 所有 vec / FTS5 相关 SQL 集中在这一个文件。
 *
 * ⚠️ 设计前提(务必理解,否则改动会踩坑):
 *
 * 1. **知识库是独立内容源**。只由 /admin 管理页录入,与 messages(飞书消息归档)、
 *    customer_leads(客资表)没有任何关联,不导入存量数据。
 *
 * 2. **vec_chunks 是派生数据,不是事实源**。
 *    事实源 = kb_docs(原文) + kb_chunks(切片正文) + kb_chunks_fts(关键词索引)。
 *    sqlite-vec 是 pre-v1(0.1.x)扩展,有 breaking change 风险,所以把它隔离成
 *    可随时 DROP 重建的派生表:扩展炸了最坏就是删掉重来,内容不会丢,
 *    关键词检索照常工作。
 *
 * 3. **维度绑定模型**。vec0 表一旦建成维度就固定(float[N]),换嵌入模型必须重建。
 *    这里在建表时检测维度变化:不一致 → DROP 重建 + 把所有 ready 文档标 stale
 *    (不静默返回错误结果,由管理页提示"需重建索引")。
 */

/** 文档状态机:pending → indexing → ready / failed;换模型后 ready → stale */
export type DocStatus = 'pending' | 'indexing' | 'ready' | 'failed' | 'stale'

export interface KbDoc {
  id: number
  title: string
  content: string
  source_type: string
  status: DocStatus
  embedding_model: string | null
  embedding_dim: number | null
  error: string | null
  retry_count: number
  chunk_count: number
  created_at: number
  updated_at: number
}

/**
 * 列表视图:不含 content。
 * 列表接口刻意不查正文(可能几十万字),所以这个类型必须和 KbDoc 分开 ——
 * 否则调用方会以为拿得到 content,实际是 undefined。
 */
export type KbDocListItem = Omit<KbDoc, 'content'>

export interface KbChunkRow {
  id: number
  doc_id: number
  seq: number
  text: string
}

// ---------------------------------------------------------------- 建表

export function initKnowledgeBase(): void {

  db.exec(`
  CREATE TABLE IF NOT EXISTS kb_docs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,                      -- 录入的原文(事实源)
    source_type     TEXT NOT NULL DEFAULT 'text',       -- text | file
    status          TEXT NOT NULL DEFAULT 'pending',    -- pending | indexing | ready | failed | stale
    embedding_model TEXT,                               -- 建索引时的模型指纹
    embedding_dim   INTEGER,
    error           TEXT,                               -- 失败原因(排查用)
    retry_count     INTEGER NOT NULL DEFAULT 0,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kb_docs_status ON kb_docs(status);
  CREATE INDEX IF NOT EXISTS idx_kb_docs_time   ON kb_docs(created_at DESC);

  CREATE TABLE IF NOT EXISTS kb_chunks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id     INTEGER NOT NULL,
    seq        INTEGER NOT NULL,                        -- 切片序号(保序)
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);

  -- 关键词检索(FTS5 + trigram):中文无需装分词器,开箱可用。
  -- 外部内容表(content='kb_chunks'):正文只存一份,不冗余。
  CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
    text,
    content='kb_chunks',
    content_rowid='id',
    tokenize='trigram'
  );
  `)

  ensureVecTable()
}

/**
 * 向量表的建表/重建。vec0 的维度写死在建表 SQL 里,换模型必须重建。
 * 检测到维度不符 → DROP 重建(安全:派生数据)→ 已有索引标 stale 等重建。
 */
function ensureVecTable(): void {
  if (!isVecReady()) return

  const want = config.EMBEDDING_DIM
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get() as { sql?: string } | undefined

  if (row?.sql) {
    const m = row.sql.match(/float\[(\d+)\]/i)
    if (m && Number(m[1]) === want) return // 维度一致,直接用
    // 维度变了:DROP 重建,已有向量全部作废
    db.exec('DROP TABLE vec_chunks')
    const affected = db
      .prepare("UPDATE kb_docs SET status='stale', error=?, updated_at=? WHERE status='ready'")
      .run(`嵌入维度由 ${m?.[1] ?? '?'} 变为 ${want},需重建索引`, Date.now()).changes
    console.warn(`⚠️ vec_chunks 维度变化(${m?.[1] ?? '?'} → ${want}),已重建向量表;${affected} 篇文档标记为待重建`)
  }

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    chunk_id  INTEGER PRIMARY KEY,
    embedding float[${want}]
  )`)
}

/** 向量检索当前是否可用(扩展加载成功 + 表已建) */
export function isVecReady(): boolean {
  return vecAvailable
}

// ---------------------------------------------------------------- 文档 CRUD

export function insertDoc(input: { title: string; content: string; sourceType?: string }): number {
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO kb_docs (title, content, source_type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    )
    .run(input.title, input.content, input.sourceType ?? 'text', now, now)
  return Number(info.lastInsertRowid)
}

export function getDoc(id: number): KbDoc | undefined {
  return db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(id) as KbDoc | undefined
}

const LIST_COLUMNS =
  'id, title, source_type, status, embedding_model, embedding_dim, error, retry_count, chunk_count, created_at, updated_at'

/** 文档状态白名单(路由层校验用,避免把任意字符串喂进 SQL) */
export const DOC_STATUSES = ['pending', 'indexing', 'ready', 'failed', 'stale'] as const

export function isDocStatus(v: unknown): v is DocStatus {
  return typeof v === 'string' && (DOC_STATUSES as readonly string[]).includes(v)
}

/** 列表(不含正文)。limit 有 200 上限,分页用 */
export function listDocs(opts: { limit?: number; offset?: number; status?: string } = {}): KbDocListItem[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
  const offset = Math.max(0, opts.offset ?? 0)
  if (opts.status) {
    return db
      .prepare(`SELECT ${LIST_COLUMNS} FROM kb_docs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(opts.status, limit, offset) as KbDocListItem[]
  }
  return db
    .prepare(`SELECT ${LIST_COLUMNS} FROM kb_docs ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as KbDocListItem[]
}

/**
 * 全量重建专用:只取 id,**不受 listDocs 的 200 上限约束**。
 *
 * 为什么必须单独开一个查询:全量重建是整个知识库的兜底操作(换嵌入模型后必做),
 * 走 listDocs 会被钳到 200 篇 —— 超出部分不报错、不提示,静默漏掉,
 * 用户以为重建完了,实际有一批文档永远停留在旧向量上。
 */
export function listAllDocIds(): number[] {
  return (db.prepare('SELECT id FROM kb_docs ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
}

export function countDocs(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM kb_docs').get() as { c: number }).c
}

export function updateDocStatus(
  id: number,
  status: DocStatus,
  extra: { error?: string | null; chunkCount?: number; model?: string; dim?: number | null; bumpRetry?: boolean } = {}
): void {
  db.prepare(
    `UPDATE kb_docs SET
       status = ?,
       error = ?,
       chunk_count = COALESCE(?, chunk_count),
       embedding_model = COALESCE(?, embedding_model),
       embedding_dim = COALESCE(?, embedding_dim),
       retry_count = retry_count + ?,
       updated_at = ?
     WHERE id = ?`
  ).run(
    status,
    extra.error ?? null,
    extra.chunkCount ?? null,
    extra.model ?? null,
    extra.dim ?? null,
    extra.bumpRetry ? 1 : 0,
    Date.now(),
    id
  )
}

/** 删除文档及其全部切片(三张表同步清理;FTS5 外部内容表删除必须回喂旧值) */
export function deleteDoc(id: number): boolean {
  const tx = db.transaction((docId: number) => {
    db.prepare("INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) SELECT 'delete', id, text FROM kb_chunks WHERE doc_id = ?").run(docId)
    if (isVecReady()) {
      db.prepare('DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)').run(docId)
    }
    db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId)
    return db.prepare('DELETE FROM kb_docs WHERE id = ?').run(docId).changes
  })
  return tx(id) > 0
}

/** 清空某文档的切片(重新索引前用),保留文档记录 */
export function clearChunks(docId: number): void {
  db.prepare("INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) SELECT 'delete', id, text FROM kb_chunks WHERE doc_id = ?").run(docId)
  if (isVecReady()) {
    db.prepare('DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)').run(docId)
  }
  db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId)
}

// ---------------------------------------------------------------- 切片写入

/**
 * 原子替换某文档的全部切片 + 向量 + FTS 记录。
 * 中途抛错由调用方(状态机)捕获并把文档标 failed。
 */
export function replaceChunks(docId: number, chunks: Array<{ text: string; embedding: number[] | null }>): number {
  const tx = db.transaction((docId: number, chunks: Array<{ text: string; embedding: number[] | null }>) => {
    clearChunks(docId)
    const now = Date.now()
    const insChunk = db.prepare('INSERT INTO kb_chunks (doc_id, seq, text, created_at) VALUES (?, ?, ?, ?)')
    const insFts = db.prepare('INSERT INTO kb_chunks_fts (rowid, text) VALUES (?, ?)')
    const insVec = isVecReady()
      ? db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)')
      : null

    for (let i = 0; i < chunks.length; i++) {
      const { text, embedding } = chunks[i]
      // ⚠️ 主键必须用 BigInt:sqlite-vec 对 vec0 的 INTEGER PRIMARY KEY 校验极严,
      //    JS number 会被 better-sqlite3 绑成 REAL → 报 "Only integers are allows for primary key"
      const chunkId = Number(insChunk.run(docId, i, text, now).lastInsertRowid)
      insFts.run(chunkId, text)
      if (insVec && embedding) {
        insVec.run(BigInt(chunkId), toVecBlob(embedding))
      }
    }
    return chunks.length
  })
  return tx(docId, chunks)
}

/** number[] → sqlite-vec 期望的 BLOB(little-endian float32) */
function toVecBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

export function listChunks(docId: number): KbChunkRow[] {
  return db
    .prepare('SELECT id, doc_id, seq, text FROM kb_chunks WHERE doc_id = ? ORDER BY seq')
    .all(docId) as KbChunkRow[]
}

// ---------------------------------------------------------------- 检索

/** 向量 KNN:返回按距离升序(越近越好)的 chunk */
export function searchVec(queryVec: number[], k: number): Array<{ chunkId: number; distance: number }> {
  if (!isVecReady()) return []
  const rows = db
    .prepare('SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(toVecBlob(queryVec), k) as Array<{ chunk_id: number | bigint; distance: number }>
  return rows.map((r) => ({ chunkId: Number(r.chunk_id), distance: r.distance }))
}

/**
 * FTS5 关键词检索(BM25,越小越相关)。
 * 查询串做转义 + 片段切分(见 buildFtsQuery);匹配不到就返回空数组,
 * 由上层降级为纯向量检索,不报错。
 */
export function searchFts(query: string, k: number): Array<{ chunkId: number; score: number }> {
  const match = buildFtsQuery(query)
  if (!match) return []
  try {
    const rows = db
      .prepare('SELECT rowid, bm25(kb_chunks_fts) AS score FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? ORDER BY score LIMIT ?')
      .all(match, k) as Array<{ rowid: number | bigint; score: number }>
    return rows.map((r) => ({ chunkId: Number(r.rowid), score: r.score }))
  } catch (err: any) {
    // 查询语法意外触发 FTS5 错误时静默降级,不拖垮整个检索
    console.warn('【知识库】FTS5 查询失败,本次降级为纯向量检索:', err.message)
    return []
  }
}

/**
 * 查询串构造见 services/ftsQuery.ts。
 * 原本写在本文件,但本模块 import 会立刻打开 SQLite 连接 ——
 * 一个纯字符串函数不该依赖 DB 才能跑单测,所以迁出去了,这里原样 re-export 保持调用方不变。
 */
export { buildFtsQuery }
import { buildFtsQuery } from '../services/ftsQuery.js'

/** 按 id 批量取切片正文 + 所属文档标题 */
export function getChunksWithDoc(chunkIds: number[]): Array<{
  chunkId: number
  docId: number
  seq: number
  text: string
  title: string
}> {
  if (!chunkIds.length) return []
  const placeholders = chunkIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      // ⚠️ 只取 status='ready' 的文档:stale(换模型后待重建)文档的向量已作废,
      //    放进来就是给 LLM 喂垃圾;failed 文档压根没有 chunk,加这道过滤是兜底。
      `SELECT c.id AS chunkId, c.doc_id AS docId, c.seq AS seq, c.text AS text, d.title AS title
       FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
       WHERE c.id IN (${placeholders}) AND d.status = 'ready'`
    )
    .all(...chunkIds) as Array<{ chunkId: number; docId: number; seq: number; text: string; title: string }>
  // 按传入顺序还原(SQLite 的 IN 不保序,而 RRF 的排名顺序是有意义的)
  const byId = new Map(rows.map((r) => [r.chunkId, r]))
  return chunkIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r)
}

// ---------------------------------------------------------------- 维护

/** 知识库统计(管理页概览用)。注意 indexing 是真实存在的中间态,不能漏统计 */
export function kbStats(): Record<'docs' | 'chunks' | DocStatus, number> & { vecReady: boolean } {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  const byStatus = (s: DocStatus) =>
    (db.prepare('SELECT COUNT(*) AS c FROM kb_docs WHERE status = ?').get(s) as { c: number }).c
  return {
    docs: one('SELECT COUNT(*) AS c FROM kb_docs'),
    chunks: one('SELECT COUNT(*) AS c FROM kb_chunks'),
    ready: byStatus('ready'),
    failed: byStatus('failed'),
    stale: byStatus('stale'),
    pending: byStatus('pending'),
    indexing: byStatus('indexing'),
    vecReady: isVecReady(),
  }
}

/** 把所有 stale / failed 文档捞出来(供启动时自动重建) */
export function listDocsByStatus(status: DocStatus): KbDoc[] {
  return db.prepare('SELECT * FROM kb_docs WHERE status = ? ORDER BY id').all(status) as KbDoc[]
}
