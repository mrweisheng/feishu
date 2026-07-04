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
  // 多维表格双写(可选:不配则只入 SQLite,跳过飞书表格写入)
  BITABLE_APP_TOKEN: process.env.BITABLE_APP_TOKEN || '',
  BITABLE_TABLE_ID: process.env.BITABLE_TABLE_ID || '',
  // 多维表格链接(录入后回复里附上,便于点击查看)
  BITABLE_LINK: process.env.BITABLE_LINK || '',
}
