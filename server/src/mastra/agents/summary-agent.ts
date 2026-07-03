import { Agent } from '@mastra/core/agent'
import { model } from '../../ai/model.js'

// 示例 agent:走 MiniMax(由 ANTHROPIC_* 环境变量驱动,统一在 ai/model.ts 配置)。
// 后续扩展业务能力时,在此基础上加 instructions / tools / memory。
export const summaryAgent = new Agent({
  id: 'summary-agent',
  name: '消息总结助手',
  instructions: '你是一个消息总结助手,帮助用户总结群聊消息。',
  model,
})
