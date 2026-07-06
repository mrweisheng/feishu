// 递增写入测试:从「仅事件内容」开始,逐步加字段,定位 code=1254001 是哪个字段炸的。
// open_id / chat_id 自动从 SQLite 取最近一条真实用户消息,零配置。
// 用法:cd server && npx tsx src/selftest-write.ts   或   npm run selftest:write

import Database from 'better-sqlite3'
import { apiClient } from './feishu/client.js'
import { config } from './config.js'

const APP = config.BITABLE_TODO_APP_TOKEN
const TABLE = config.BITABLE_TODO_TABLE_ID
const basePath = `/open-apis/bitable/v1/apps/${APP}/tables/${TABLE}`

// 从归档库取最近一个真实用户的 open_id + chat_id 作为测试值
const db = new Database(config.DB_PATH, { readonly: true })
const row = db
  .prepare("SELECT sender_open_id, chat_id FROM messages WHERE sender_type='user' AND sender_open_id IS NOT NULL ORDER BY received_at DESC LIMIT 1")
  .get() as { sender_open_id: string; chat_id: string } | undefined
db.close()
if (!row) {
  console.error('❌ SQLite 里没有真实用户消息,没法取测试 open_id/chat_id')
  process.exit(1)
}
const TEST_OPEN_ID = row.sender_open_id
const TEST_CHAT_ID = row.chat_id
console.log(`测试值:open_id=${TEST_OPEN_ID}  chat_id=${TEST_CHAT_ID}\n`)

async function tryWrite(label: string, fields: Record<string, any>): Promise<string | null> {
  try {
    const res: any = await apiClient.request({ method: 'POST', url: `${basePath}/records`, data: { fields } })
    if (res.code !== 0) {
      console.log(`❌ [${label}] 失败 code=${res.code} msg=${res.msg}`)
      return null
    }
    const rid = res.data?.record?.record_id ?? ''
    console.log(`✅ [${label}] 成功 rid=${rid}`)
    return rid
  } catch (e: any) {
    console.log(`❌ [${label}] 异常 ${e.message ?? e}`)
    return null
  }
}

async function del(rid: string): Promise<void> {
  try {
    await apiClient.request({ method: 'DELETE', url: `${basePath}/records/${rid}` })
    console.log(`   已清理测试记录 ${rid}`)
  } catch {
    console.warn(`   ⚠️ 清理失败 ${rid},请手动删`)
  }
}

async function main(): Promise<void> {
  if (!APP || !TABLE) {
    console.error('❌ 未配置 BITABLE_TODO_APP_TOKEN / BITABLE_TODO_TABLE_ID')
    process.exit(1)
  }

  const steps: [string, Record<string, any>][] = [
    ['仅事件内容', { 事件内容: '[selftest-write] step1' }],
    ['内容+处理状态', { 事件内容: '[selftest-write] step2', 处理状态: '待处理' }],
    ['内容+状态+责任人', { 事件内容: '[selftest-write] step3', 处理状态: '待处理', 责任人: [{ id: TEST_OPEN_ID }] }],
    ['全部(加通知群组)', { 事件内容: '[selftest-write] step4', 处理状态: '待处理', 责任人: [{ id: TEST_OPEN_ID }], 通知群组: [{ chat_id: TEST_CHAT_ID }] }],
  ]

  for (const [label, fields] of steps) {
    const rid = await tryWrite(label, fields)
    if (!rid) {
      console.log(`\n👉 定位:加完上一步还成功,这一步【${label}】失败 —— 问题出在这一步新加的字段`)
      process.exit(0)
    }
    await del(rid)
  }
  console.log('\n✅ 全部字段写入都成功 —— 那问题可能在 LLM 传的 content 值(含特殊字符?)或并发,需要进一步看实际请求')
  process.exit(0)
}

main().catch((err) => {
  console.error('【诊断异常】', err)
  process.exit(1)
})
