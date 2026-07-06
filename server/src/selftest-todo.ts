// 待办表格「写→读→删」链路自测:不用等提醒时间,直接验权限 + 字段名 + API 通不通。
// 用法:cd server && npx tsx src/selftest-todo.ts   或   npm run selftest:todo
//
// 跑之前先填下面这个测试参数(从归档库取真实值):
//   open_id:SQLite 里 `select sender_open_id from messages limit 1`,或前端消息卡片
// 注意:owner 是「人员」字段,传不存在的 open_id 飞书会报错,必须用真实的。

import { createTodoInBitable, getTodoRecords } from './feishu/bitable-todo.js'
import { apiClient } from './feishu/client.js'
import { config } from './config.js'

// ====== 测试参数(改成你自己的真实值) ======
const TEST_USER_OPEN_ID = 'ou_xxxxxxxxxxxxxxxxxxxxxx' // ← 改真实(SQLite: select sender_open_id from messages limit 1)
// ============================================

const TEST_CONTENT = `[selftest] 读写删链路测试 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`

async function deleteRecord(recordId: string): Promise<boolean> {
  const res: any = await apiClient.request({
    method: 'DELETE',
    url: `/open-apis/bitable/v1/apps/${config.BITABLE_TODO_APP_TOKEN}/tables/${config.BITABLE_TODO_TABLE_ID}/records/${recordId}`,
  })
  if (res.code !== 0) {
    console.error(`❌ 删除失败 code=${res.code} msg=${res.msg}`)
    return false
  }
  return true
}

async function main(): Promise<void> {
  console.log('=== 待办表格读写删自测开始 ===\n')

  if (!config.BITABLE_TODO_APP_TOKEN || !config.BITABLE_TODO_TABLE_ID) {
    console.error('❌ 未配置 BITABLE_TODO_APP_TOKEN / BITABLE_TODO_TABLE_ID,请先填 server/.env')
    process.exit(1)
  }
  if (TEST_USER_OPEN_ID.startsWith('ou_xxx')) {
    console.error('❌ 请先改脚本顶部的 TEST_USER_OPEN_ID 为真实值')
    process.exit(1)
  }
  console.log(`APP_TOKEN=${config.BITABLE_TODO_APP_TOKEN}`)
  console.log(`TABLE_ID=${config.BITABLE_TODO_TABLE_ID}\n`)

  // 1. 写
  console.log(`[1/3] 写入一条待办:内容="${TEST_CONTENT}"`)
  const rid = await createTodoInBitable({
    content: TEST_CONTENT,
    userOpenId: TEST_USER_OPEN_ID,
  })
  if (!rid) {
    console.error('❌ 写入失败 —— 看上面「待办表格写入失败」日志:多半是权限不足、字段名不对、或 owner/chat_id 无效')
    process.exit(1)
  }
  console.log(`✅ 写入成功 record_id=${rid}\n`)

  // 2. 读
  console.log('[2/3] 读回这条记录的状态和内容')
  const records = await getTodoRecords([rid])
  if (records.length === 0) {
    console.error('❌ 读取失败 —— 权限或 record_id 问题,正在清理测试记录...')
    await deleteRecord(rid)
    process.exit(1)
  }
  const r = records[0]
  console.log(`✅ 读取成功:status="${r.status}" content="${r.content}"`)
  if (r.status !== '待处理') console.warn(`⚠️ 期望 status="待处理",实际="${r.status}"(检查表格「处理状态」字段默认值/选项)`)
  if (r.content !== TEST_CONTENT) console.warn('⚠️ 内容读回不一致')
  console.log('')

  // 3. 删
  console.log('[3/3] 删除这条测试记录')
  const ok = await deleteRecord(rid)
  if (!ok) {
    console.error('❌ 删除失败 —— 请手动到表格删掉这条 [selftest] 测试记录')
    process.exit(1)
  }
  console.log('✅ 删除成功\n')

  console.log('=== 全部通过 ✅ 读写删链路正常,权限和字段名都没问题 ===')
  process.exit(0)
}

main().catch((err) => {
  console.error('【自测异常】', err)
  process.exit(1)
})
