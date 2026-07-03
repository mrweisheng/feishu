import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { MastraServer } from '@mastra/hono'
import { config } from './config.js'
import { mastra } from './mastra/index.js'
import { apiRoutes } from './routes/index.js'
import { startFeishuWorker } from './feishu/handler.js'

const app = new Hono()

// 允许前端跨域访问(开发期;生产可收紧来源)
app.use('*', cors())

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
