import { apiClient } from './client.js'
import { config } from '../config.js'
import { setLeadFeishuRecordId, type CustomerLeadRow } from '../db/customerLeads.js'

// 飞书 bitable「客资信息登记表」字段中文名(bitable API 的 fields 对象要按 name 写,不是 id)。
// 改 bitable 字段后这里要同步改。新加字段加在最下面,旧 name 保持不变。
const FIELD_NAMES = {
  leadDate: '线索日期',
  name: '客户名称',  // 用户重命名过:原本是「客户备注」
  wechat: '客户微信',
  isKey: '是否是重点客户',
  needs: '客户需求',
  visited: '是否到店',
  owner: '归属人',
  creator: '创建人',
  registeredAt: '登记时间',
  updatedAt: '更新时间',
} as const

// Date 字段:bitable 实际接受毫秒数(SDK 调用时数字都被当 ms 处理,不像 lark-cli 那样自动判断)。
// 已实测:1784131200000 ms → bitable 显示 "2026-07-16 00:00:00";1784131200(秒)→ 显示 "1970-01-21"。
// 所以直接传 ms,不要再除以 1000。
// (lark-cli 的 datetime 文档说传秒是因为 lark-cli 内部做了判断,SDK 没做这层)
const toBitableDate = (ms: number): number => ms

// 把内部行映射成 bitable 写入格式。
// 未配置的字段(空值)直接不传该 key,避免给 bitable 写 null 把已有值覆盖成空。
function buildFields(lead: {
  lead_date: number
  customer_name: string | null
  customer_wechat: string | null
  customer_needs: string | null
  customer_notes: string | null
  is_key_customer: number
  visited_store: number
  owner_open_id: string | null
  user_open_id: string | null
  created_at: number
  updated_at: number
}): Record<string, any> {
  const fields: Record<string, any> = {}
  fields[FIELD_NAMES.leadDate] = toBitableDate(lead.lead_date)
  fields[FIELD_NAMES.registeredAt] = toBitableDate(lead.created_at)
  fields[FIELD_NAMES.updatedAt] = toBitableDate(lead.updated_at)
  if (lead.customer_name) fields[FIELD_NAMES.name] = lead.customer_name
  if (lead.customer_wechat) fields[FIELD_NAMES.wechat] = lead.customer_wechat
  if (lead.customer_needs) fields[FIELD_NAMES.needs] = lead.customer_needs
  // Person 字段即使是单人也要传数组[{id}],不能传单对象{id}
  if (lead.owner_open_id) fields[FIELD_NAMES.owner] = [{ id: lead.owner_open_id }]
  // 「创建人」不传 — 让飞书多维表格系统自己记录(API 调用方 = 机器人 app),
  // 不要把 @ 机器人的人当成创建人(归属人才是 @ 的人,创建人应该是 app 自己)
  fields[FIELD_NAMES.isKey] = lead.is_key_customer === 1
  fields[FIELD_NAMES.visited] = lead.visited_store === 1
  return fields
}

/** bitable 同步是否启用(三个环境变量都配齐才走双写) */
export function isCustomerBitableEnabled(): boolean {
  return Boolean(config.BITABLE_CUSTOMER_APP_TOKEN && config.BITABLE_CUSTOMER_TABLE_ID)
}

/**
 * 把已写入 SQLite 的客资同步到飞书多维表格。
 * best-effort:失败仅记日志,不影响主流程(SQLite 已是事实源)。
 * @returns 同步成功返回 feishu_record_id;失败或未启用返回 null
 */
export async function syncLeadToBitable(localId: number, lead: CustomerLeadRow): Promise<string | null> {
  if (!isCustomerBitableEnabled()) return null

  const fields = buildFields(lead)

  try {
    const res: any = await apiClient.bitable.v1.appTableRecord.create({
      data: { fields },
      path: {
        app_token: config.BITABLE_CUSTOMER_APP_TOKEN,
        table_id: config.BITABLE_CUSTOMER_TABLE_ID,
      },
      params: { user_id_type: 'open_id' },
    })
    const recordId: string | undefined = res?.data?.record?.record_id
    if (!recordId) {
      console.error('【客资 bitable 同步】返回无 record_id,原始:', JSON.stringify(res).slice(0, 300))
      return null
    }
    // 回写 feishu_record_id 到 SQLite
    setLeadFeishuRecordId(localId, recordId)
    console.log('✅ 客资已同步到飞书表格,local_id=', localId, 'record_id=', recordId)
    return recordId
  } catch (err: any) {
    // SDK 把飞书业务错也包成 throw,res 可能在 err.response.data
    const fbCode = err?.response?.data?.code ?? err?.code
    const fbMsg = err?.response?.data?.msg || err?.message
    console.error(
      '【客资 bitable 同步失败】local_id=',
      localId,
      'code=',
      fbCode ?? '—',
      'msg:',
      fbMsg,
    )
    return null
  }
}
