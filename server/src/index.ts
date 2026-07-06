import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { MastraServer } from '@mastra/hono'
import { config } from './config.js'
import { mastra } from './mastra/index.js'
import { apiRoutes } from './routes/index.js'
import { startFeishuWorker } from './feishu/handler.js'

const app = new Hono()

// CORS:仅当配置了 CORS_ORIGINS 白名单才放行对应来源;留空则不挂中间件
// (浏览器默认同源策略,跨域被拒)。避免无差别 cors() 放行任意来源,
// 防止 ?limit=-1 等接口被任意网页拉取全库。
if (config.CORS_ORIGINS) {
  const origins = new Set(config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean))
  app.use('*', cors({
    origin: (origin) => (origin && origins.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }))
}

// 1. 业务 API(读 SQLite)
app.route('/api', apiRoutes)

// 2. Mastra 端点(自动暴露 /api/agents/<id> 等)
const mastraServer = new MastraServer({ app, mastra })
await mastraServer.init()

// 3. 启动飞书 worker(长连接 + 历史补漏调度),与 HTTP 并行
startFeishuWorker()

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`✅ HTTP 服务监听 http://localhost:${info.port}`)
})
