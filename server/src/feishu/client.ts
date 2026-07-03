import { Client, WSClient } from '@larksuiteoapi/node-sdk'
import { config } from '../config.js'

// API 客户端(用于主动调飞书接口:查用户、拉历史消息等)
export const apiClient = new Client({
  appId: config.FEISHU_APP_ID,
  appSecret: config.FEISHU_APP_SECRET,
})

// 长连接客户端(用于接收实时消息事件)
export const wsClient = new WSClient({
  appId: config.FEISHU_APP_ID,
  appSecret: config.FEISHU_APP_SECRET,
})
