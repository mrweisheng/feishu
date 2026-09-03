import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { config } from '../config.js'
import {
  SESSION_COOKIE_NAME,
  clearLoginFailures,
  clearSessionCookie,
  loginLockedFor,
  recordLoginFailure,
  sessionCookie,
  signSession,
  verifyCredentials,
  verifySession,
} from '../services/auth.js'
import {
  DOC_STATUSES,
  deleteDoc,
  getDoc,
  isDocStatus,
  isVecReady,
  kbStats,
  listChunks,
  listDocs,
} from '../db/knowledgeBase.js'
import { createDoc, reindexDoc, rebuildAll, searchKnowledge } from '../services/knowledge.js'

/**
 * 知识库管理 API。
 *
 * 知识库是独立内容源:只通过这里录入,与飞书消息归档、客资表没有任何关联。
 * 前端页面见 web/index.html,挂在 /admin。
 *
 * 鉴权:单预设账号登录(KB_ADMIN_USER / KB_ADMIN_PASSWORD,默认 shengwei / 123456),
 * 会话走 HttpOnly cookie。登录/登出/探测路由注册在 requireLogin 之前 ——
 * Hono 按注册顺序执行,先命中的 handler 直接返回,不会落入后面的鉴权中间件。
 */
export const knowledgeBaseRoute = new Hono()

/** 知识库是否被整体关闭(放在最前:关了连登录也不该响应) */
knowledgeBaseRoute.use('*', async (c, next) => {
  if (!config.KB_ENABLED) {
    return c.json({ error: '知识库已关闭(KB_ENABLED=0)' }, 503)
  }
  await next()
})

/** 来源 IP:nginx 反代时用 X-Real-IP(登录限流按此计数);直连时归为 unknown */
function clientIp(c: Context): string {
  return c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

// POST /api/knowledge/login —— 登录,成功下发会话 cookie
knowledgeBaseRoute.post('/login', async (c) => {
  let body: { username?: string; password?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求体必须是 JSON' }, 400)
  }
  const username = (body.username ?? '').trim()
  const password = body.password ?? ''

  const ip = clientIp(c)
  if (loginLockedFor(ip)) {
    return c.json({ error: '失败次数过多,已临时锁定,请 2 分钟后再试' }, 429)
  }
  if (!username || !password || !verifyCredentials(username, password)) {
    recordLoginFailure(ip)
    return c.json({ error: '账号或密码不正确' }, 401)
  }
  clearLoginFailures(ip)
  c.header('Set-Cookie', sessionCookie(signSession(username)))
  return c.json({ ok: true })
})

// GET /api/knowledge/session —— 前端探测登录态(401 = 未登录)
knowledgeBaseRoute.get('/session', (c) => {
  const s = verifySession(getCookie(c, SESSION_COOKIE_NAME))
  if (!s.ok) return c.json({ ok: false }, 401)
  return c.json({ ok: true, username: s.username })
})

// POST /api/knowledge/logout —— 登出,即刻过期 cookie
knowledgeBaseRoute.post('/logout', (c) => {
  c.header('Set-Cookie', clearSessionCookie())
  return c.json({ ok: true })
})

/** 会话校验中间件:保护下方全部业务路由 */
const requireLogin: MiddlewareHandler = async (c, next) => {
  const s = verifySession(getCookie(c, SESSION_COOKIE_NAME))
  if (!s.ok) return c.json({ error: '未登录或会话已过期' }, 401)
  await next()
}
knowledgeBaseRoute.use('*', requireLogin)

// GET /api/knowledge/stats —— 概览
knowledgeBaseRoute.get('/stats', (c) => {
  return c.json({ ...kbStats(), model: config.EMBEDDING_MODEL, dim: config.EMBEDDING_DIM })
})

// GET /api/knowledge/docs?limit=50&offset=0&status=ready —— 列表(不含正文)
knowledgeBaseRoute.get('/docs', (c) => {
  const limit = Math.max(1, Math.min(Math.trunc(Number(c.req.query('limit')) || 50), 200))
  const offset = Math.max(0, Math.min(Math.trunc(Number(c.req.query('offset')) || 0), 1_000_000))
  const rawStatus = c.req.query('status') || undefined
  // 枚举校验:非法值直接 400,而不是让 SQL 静默返回空列表(排查时无法区分"没数据"和"拼错了")
  if (rawStatus !== undefined && !isDocStatus(rawStatus)) {
    return c.json({ error: `status 非法,可选:${DOC_STATUSES.join(' | ')}` }, 400)
  }
  const items = listDocs({ limit, offset, status: rawStatus })
  const total = rawStatus ? kbStats()[rawStatus] : kbStats().docs
  return c.json({ total, limit, offset, items })
})

// GET /api/knowledge/docs/:id —— 详情(含原文 + 切片)
knowledgeBaseRoute.get('/docs/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'id 不合法' }, 400)
  const doc = getDoc(id)
  if (!doc) return c.json({ error: '文档不存在' }, 404)
  return c.json({ ...doc, chunks: listChunks(id) })
})

// POST /api/knowledge/docs —— 录入。{ title, content }
knowledgeBaseRoute.post('/docs', async (c) => {
  let body: { title?: string; content?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求体必须是 JSON' }, 400)
  }
  const title = (body.title ?? '').trim()
  const content = (body.content ?? '').trim()
  if (!title) return c.json({ error: '标题不能为空' }, 400)
  if (!content) return c.json({ error: '内容不能为空' }, 400)
  if (content.length > 500_000) return c.json({ error: '内容过长(上限 50 万字)' }, 400)

  const doc = createDoc({ title, content, sourceType: 'text' })
  return c.json({ ok: true, id: doc.id, status: doc.status })
})

// DELETE /api/knowledge/docs/:id
knowledgeBaseRoute.delete('/docs/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'id 不合法' }, 400)
  if (!deleteDoc(id)) return c.json({ error: '文档不存在' }, 404)
  return c.json({ ok: true })
})

// POST /api/knowledge/docs/:id/reindex —— 单篇重建(失败重试 / 内容更新后重来)
knowledgeBaseRoute.post('/docs/:id/reindex', (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'id 不合法' }, 400)
  if (!getDoc(id)) return c.json({ error: '文档不存在' }, 404)
  reindexDoc(id)
  return c.json({ ok: true, message: '已加入重建队列' })
})

// POST /api/knowledge/rebuild —— 全量重建(换嵌入模型后用;正文不丢)
knowledgeBaseRoute.post('/rebuild', (c) => {
  const n = rebuildAll()
  return c.json({ ok: true, queued: n })
})

// POST /api/knowledge/search —— 试搜(管理页调试/验收用)。{ query, topK }
knowledgeBaseRoute.post('/search', async (c) => {
  let body: { query?: string; topK?: number }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求体必须是 JSON' }, 400)
  }
  const query = (body.query ?? '').trim()
  if (!query) return c.json({ error: '查询词不能为空' }, 400)
  const topK = Math.max(1, Math.min(Math.trunc(Number(body.topK) || config.KB_SEARCH_TOP_K), 20))

  const started = Date.now()
  try {
    const hits = await searchKnowledge(query, topK)
    return c.json({
      ok: true,
      query,
      tookMs: Date.now() - started,
      vecReady: isVecReady(),
      found: hits.length,
      results: hits.map((h) => ({
        docId: h.docId,
        docTitle: h.docTitle,
        score: Number(h.score.toFixed(6)),
        via: h.via,
        text: h.text,
      })),
    })
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 500)
  }
})
