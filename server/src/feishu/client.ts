import { Client, WSClient } from '@larksuiteoapi/node-sdk'
import { config } from '../config.js'

// API 客户端(用于主动调飞书接口:查用户、拉历史消息等)
export const apiClient = new Client({
  appId: config.FEISHU_APP_ID,
  appSecret: config.FEISHU_APP_SECRET,
})

// 长连接客户端(用于接收实时消息事件)
// pingTimeout=60:发心跳后 60s 收不到任何入站帧(含 pong)即判定连接半开,terminate 后走 SDK 自带的 close→重连流程。
// 必须开:NAT/网关静默丢弃连接时不发 close 帧,SDK 默认只监听 close 才重连,不开此参数失联后永不恢复。
export const wsClient = new WSClient({
  appId: config.FEISHU_APP_ID,
  appSecret: config.FEISHU_APP_SECRET,
  wsConfig: { pingTimeout: 60 },
  // 生命周期回调只能挂在构造函数上(start() 仅接受 eventDispatcher),断连/重连必须留痕,否则排查只能靠猜
  onReady: () => console.log('🟢 飞书长连接已就绪'),
  onReconnecting: () => console.warn('🔁 飞书长连接断开,正在重连...'),
  onReconnected: () => console.log('🟢 飞书长连接重连成功'),
  onError: (e) => console.error('❌ 飞书长连接最终失败(重连耗尽):', e?.message ?? e),
})
