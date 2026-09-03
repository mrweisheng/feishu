import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { MastraServer } from '@mastra/hono'
import { config } from './config.js'
import { mastra } from './mastra/index.js'
import { apiRoutes } from './routes/index.js'
import { startFeishuWorker } from './feishu/handler.js'
import { selfCheckEmbedder } from './services/embedding.js'
import { reconcileOnStartup } from './services/knowledge.js'

const app = new Hono()

// 业务 API(读 SQLite)
app.route('/api', apiRoutes)

// 管理页(单文件,CSS/JS 全内联,零构建)。页面本身不含任何数据,未登录只显示登录框,
// 登录与会话由 /api/knowledge/login|logout|session 承担,所以这里不做服务端拦截。
// 直接读文件返回,不挂静态目录 —— 没有额外资源文件,也就不受 serveStatic 路径重写行为影响。
//
// ⚠️ 用 import.meta.url 定位而不是 process.cwd():从仓库根目录执行
//    `node server/dist/index.js` 时 cwd 不是 server/,按 cwd 拼路径会 404。
//    开发(src/index.ts)与生产(dist/index.js)下 ../web/index.html 都指向 server/web/。
const ADMIN_HTML_CANDIDATES = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/index.html'),
  path.resolve(process.cwd(), 'web/index.html'),
]
const adminHtml = ((): string | null => {
  for (const p of ADMIN_HTML_CANDIDATES) {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      /* 换下一个候选路径 */
    }
  }
  console.warn(`⚠️ 未找到 web/index.html(已尝试 ${ADMIN_HTML_CANDIDATES.join('、')}),/admin 将返回 404`)
  return null
})()
const renderAdmin = (c: { html: (s: string) => Response | Promise<Response> }) =>
  adminHtml
    ? c.html(adminHtml)
    : new Response('未找到 web/index.html', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
app.get('/admin', (c) => renderAdmin(c))
app.get('/admin/', (c) => renderAdmin(c))

// 知识库启动自检:维度对不上就明说降级,不带着错误配置静默跑
if (config.KB_ENABLED) {
  const check = await selfCheckEmbedder()
  if (check.ok) {
    console.log(`✅ 嵌入模型自检通过:${check.model} · ${check.actualDim} 维 · ${check.latencyMs}ms`)
    // 只有自检通过才对账。自检失败(key 配错 / 维度不符 / 嵌入服务临时挂)时若照常对账,
    // 每篇文档都会因嵌入失败被标成 failed —— 一次启动时的瞬时故障会把全库永久钉死在 failed,
    // 只能人工一篇篇重建。自检不通过时保持 pending/stale,等下次启动自检通过再补。
    const n = reconcileOnStartup()
    if (n) console.log(`   (${n} 篇待重新索引,已入队)`)
  } else {
    console.error(`⚠️ 嵌入模型自检失败:${check.error}`)
    console.error('  → 知识库仍可录入,但向量检索不可用,将降级为纯关键词检索(FTS5)')
    console.error('  → 已跳过启动对账(避免瞬时故障把文档批量标成 failed),下次启动自检通过时自动补做')
  }
}

// 管理页单账号登录:默认口令只保开箱即用,公网部署(经 nginx 暴露)前必须改掉
if (config.KB_ADMIN_PASSWORD === '123456') {
  console.warn('⚠️ 管理页口令为默认值(123456),公网部署前请在 .env 中修改 KB_ADMIN_PASSWORD')
}

// 2. Mastra 端点(自动暴露 /api/agents/<id> 等)
const mastraServer = new MastraServer({ app, mastra })
await mastraServer.init()

// 3. 启动飞书 worker(长连接 + 历史补漏调度),与 HTTP 并行
startFeishuWorker()

serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  const host = config.HOST.includes(':') ? `[${config.HOST}]` : config.HOST
  console.log(`✅ HTTP 服务监听 http://${host}:${info.port}`)
  if (config.HOST === '127.0.0.1' || config.HOST === 'localhost' || config.HOST === '::1') {
    console.log('   (仅本机可访问;公网访问走 nginx 反代即可,无需改 HOST)')
  } else {
    console.warn('   ⚠️ 当前监听非本机地址:知识库 API 有登录保护,但 /api/messages、/api/customer-leads 等其余接口无鉴权,请确认网络可达范围')
  }
})
