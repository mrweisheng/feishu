import { Hono } from 'hono'
import { messagesRoute } from './messages.js'
import { statsRoute } from './stats.js'

// 业务 API 路由聚合。新增模块时在此挂载,入口 index.ts 只需引入一次。
export const apiRoutes = new Hono()
apiRoutes.route('/messages', messagesRoute)
apiRoutes.route('/stats', statsRoute)
