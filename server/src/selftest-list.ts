// 列出待办表的所有记录 + 该文档下所有数据表,确认记录到底有没有写入、TABLE_ID 对应哪个 tab。
// 用法:cd server && npx tsx src/selftest-list.ts   或   npm run selftest:list

import { apiClient } from './feishu/client.js'
import { config } from './config.js'

function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as any).text) : String(x))).join('')
  return String(v)
}

async function main(): Promise<void> {
  if (!config.BITABLE_TODO_APP_TOKEN || !config.BITABLE_TODO_TABLE_ID) {
    console.error('❌ 未配置 BITABLE_TODO_APP_TOKEN / BITABLE_TODO_TABLE_ID')
    process.exit(1)
  }

  // 1. 列出该文档下所有数据表,确认 TABLE_ID 对应哪个
  console.log('=== 该文档下的所有数据表 ===')
  const tablesRes: any = await apiClient.request({
    method: 'GET',
    url: `/open-apis/bitable/v1/apps/${config.BITABLE_TODO_APP_TOKEN}/tables`,
  })
  if (tablesRes.code !== 0) {
    console.error(`❌ 拉数据表列表失败 code=${tablesRes.code} msg=${tablesRes.msg}`)
  } else {
    for (const t of tablesRes.data?.items ?? []) {
      const mark = t.table_id === config.BITABLE_TODO_TABLE_ID ? '  ← 当前配置的 TABLE_ID' : ''
      console.log(`  ${t.table_id}  「${t.name}」${mark}`)
    }
  }
  console.log(`\n配置的 TABLE_ID = ${config.BITABLE_TODO_TABLE_ID}\n`)

  // 2. 拉该表所有记录
  console.log('=== 该表记录 ===')
  const res: any = await apiClient.request({
    method: 'GET',
    url: `/open-apis/bitable/v1/apps/${config.BITABLE_TODO_APP_TOKEN}/tables/${config.BITABLE_TODO_TABLE_ID}/records`,
    params: { page_size: 100 },
  })
  if (res.code !== 0) {
    console.error(`❌ 拉记录失败 code=${res.code} msg=${res.msg}`)
    process.exit(1)
  }
  const items = res.data?.items ?? []
  console.log(`共 ${items.length} 条记录:`)
  for (const it of items) {
    const f = it.fields ?? {}
    console.log(`  ${it.record_id}  [${asText(f['处理状态']) || '无状态'}]  ${asText(f['事件内容'])}`)
  }
  if (items.length === 0) console.log('  (空)')
  process.exit(0)
}

main().catch((err) => {
  console.error('【诊断异常】', err)
  process.exit(1)
})
