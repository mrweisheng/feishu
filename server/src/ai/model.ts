import Anthropic from '@anthropic-ai/sdk'
import { createAnthropic } from '@ai-sdk/anthropic'
import { config } from '../config.js'

// 统一 LLM 出口:Anthropic SDK 兼容端点 → MiniMax(由 ANTHROPIC_* 环境变量驱动)
// - askLLM(@问答、tool use)用 Anthropic SDK 客户端
// - Mastra agent 用 AI SDK 模型
// 两边共享同一份 baseURL/apiKey/model 配置,避免散落多处。

// Anthropic SDK 客户端(@anthropic-ai/sdk,用于手写 tool-use loop)
export const anthropic = new Anthropic()

// AI SDK LanguageModel 工厂(@ai-sdk/anthropic,用于 Mastra Agent)
const aiSdkAnthropic = createAnthropic({
  baseURL: config.ANTHROPIC_BASE_URL,
  apiKey: config.ANTHROPIC_API_KEY,
})

// Mastra Agent 用的模型实例
export const model = aiSdkAnthropic(config.LLM_MODEL)

// 统一模型名(Anthropic SDK 直接用字符串)
export const modelName = config.LLM_MODEL
