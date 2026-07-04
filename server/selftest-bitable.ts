// 多维表格双写自测(用完即删,全程自清理):
//   走 bitable.ts 真实路径写 1 收 + 1 支 → 回读校验字段 → 删两条 → 清掉自测业务选项
// 用法: !npx tsx selftest-bitable.ts
import 'dotenv/config'
import { writeTransactionToBitable } from './src/feishu/bitable.js'
import type { TransactionRow } from './src/db/transactions.js'

const APP_TOKEN = process.env.BITABLE_APP_TOKEN!
const TABLE_ID = process.env.BITABLE_TABLE_ID!
const BASE = 'https://open.feishu.cn/open-apis'
const PROJ = '【自测】请删除'

async function getToken() {
  const r = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
  })
  return (await r.json()).tenant_access_token
}
async function api(token: string, method: string, path: string, body?: any) {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(`${BASE}${path}`, init)
  return r.json()
}

const now = Date.now()
const income: TransactionRow = {
  id: 0, direction: 'income', kind: '自测尾款', occurred_at: now, occurred_month: '2026-07',
  our_account: 'huaxin_hkd', counterparty_name: '自测客户', counterparty_account: null,
  counterparty_account_type: '', amount_minor: 123456, currency: 'HKD', amount_raw: 'HKD 1234.56',
  settlement_status: 'settled', settlement_note: '自测明细', project_id: 0, project_name_raw: PROJ,
  transfer_type: '', note: '', chat_id: '', user_open_id: '', original_message_id: '',
  feishu_record_id: '', created_at: now, updated_at: now,
}
const expense: TransactionRow = {
  id: 0, direction: 'expense', kind: '自测过户', occurred_at: now, occurred_month: '2026-07',
  our_account: null, counterparty_name: '自测收款人', counterparty_account: '6222000 工商银行 海丰支行',
  counterparty_account_type: '银行卡', amount_minor: 88800, currency: 'RMB', amount_raw: '888',
  settlement_status: 'pending', settlement_note: '', project_id: 0, project_name_raw: PROJ,
  transfer_type: '', note: '', chat_id: '', user_open_id: '', original_message_id: '',
  feishu_record_id: '', created_at: now, updated_at: now,
}

async function main() {
  console.log('== 写入(走 bitable.ts 真实路径) ==')
  const r1 = await writeTransactionToBitable(income, PROJ)
  const r2 = await writeTransactionToBitable(expense, PROJ)
  console.log('income  record_id =', r1)
  console.log('expense record_id =', r2)
  if (!r1 || !r2) { console.log('❌ 写入失败,看上面的【多维表格写入失败】日志'); return }

  const token = await getToken()
  const R = `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}`

  console.log('\n== 回读校验(确认字段名/选项文案/数值都对) ==')
  for (const [label, rid] of [['收款', r1], ['转出', r2]] as const) {
    const res = await api(token, 'GET', `${R}/records/${rid}`)
    console.log(`\n[${label}] ${rid}`)
    console.log(JSON.stringify(res.data?.record?.fields, null, 2))
  }

  console.log('\n== 清理:删除两条自测记录 ==')
  const del = await api(token, 'POST', `${R}/records/batch_delete`, { records: [r1, r2] })
  console.log(del.code === 0 ? '✅ 已删除' : `删除失败: ${JSON.stringify(del)}`)

  console.log('\n== 清理:移除自测业务选项(若业务字段是单选) ==')
  const fl = await api(token, 'GET', `${R}/fields?page_size=100`)
  const field = (fl.data.items || []).find((x: any) => x.field_name === '对应业务（群名称）')
  if (field && field.ui_type === 'SingleSelect') {
    const opts = (field.property?.options || []).filter((o: any) => o.name !== PROJ)
    const upd = await api(token, 'PUT', `${R}/fields/${field.field_id}`, {
      field_id: field.field_id, field_name: field.field_name, type: 3, ui_type: 'SingleSelect',
      property: { options: opts.map((o: any) => ({ name: o.name })) },
    })
    console.log(upd.code === 0 ? '✅ 已移除自测选项' : `移除选项失败: ${JSON.stringify(upd)}`)
  } else {
    console.log('业务字段非单选,无需移除选项')
  }
  console.log('\n🏁 自测完成')
}

main().catch((e) => { console.error('💥', e); process.exit(1) })
