import { Mastra } from '@mastra/core'
import { summaryAgent } from './agents/summary-agent.js'

export const mastra = new Mastra({
  agents: { summaryAgent },
})
