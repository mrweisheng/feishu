import 'dotenv/config'
import path from 'node:path'

function required(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`缺少环境变量 ${key},请在 server/.env 中配置(参考 .env.example)`)
  return v
}

export const config = {
  FEISHU_APP_ID: required('FEISHU_APP_ID'),
  FEISHU_APP_SECRET: required('FEISHU_APP_SECRET'),
  PORT: Number(process.env.PORT) || 4111,
  // DB_PATH 相对 server/ 目录(运行时 cwd),解析成绝对路径
  DB_PATH: path.resolve(process.cwd(), process.env.DB_PATH || './data/messages.db'),
  // LLM(Anthropic SDK 兼容端点 → MiniMax)
  ANTHROPIC_BASE_URL: required('ANTHROPIC_BASE_URL'),
  ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),
  LLM_MODEL: process.env.LLM_MODEL || 'MiniMax-M3',

  // 客资多维表格(留空 = 只入 SQLite,跳过飞书表格双写)
  BITABLE_CUSTOMER_APP_TOKEN: process.env.BITABLE_CUSTOMER_APP_TOKEN || '',
  BITABLE_CUSTOMER_TABLE_ID: process.env.BITABLE_CUSTOMER_TABLE_ID || '',
  BITABLE_CUSTOMER_LINK: process.env.BITABLE_CUSTOMER_LINK || '',

  // 提醒重启补偿窗口(毫秒):进程重启后,过期但 < 该窗口的提醒补发,>= 的丢弃。
  // 防止服务挂半天后重启半夜轰炸用户;30min 是体验与打扰的平衡点。
  REMINDER_RESEND_WINDOW_MS: Number(process.env.REMINDER_RESEND_WINDOW_MS) || 30 * 60 * 1000,
}
