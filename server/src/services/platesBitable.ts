import fs from 'node:fs'
import path from 'node:path'
import { apiClient } from '../feishu/client.js'
import { config } from '../config.js'
import type { CandidatePlate } from './platesAutomation.js'

/**
 * 每日现牌入库飞书多维表格(bitable):一张固定表「最新現牌」存**最新一批**候选车牌。
 * 每次批次写入前先清空旧记录(全删再插),表里永远只反映最新一次现牌发布。
 *
 * 表字段:
 *   車牌號碼(text) / 口岸(text) / 類型(text:高新現牌、納稅現牌…)
 *   批文情況(text) / 是否今日精選(checkbox) / 批次日期(text) / 來源文件(text)
 *
 * 多维表格 app 的定位:
 *   1. .env 配了 PLATES_BITABLE_APP_TOKEN → 用现成的(推荐,人为可控);
 *   2. 没配 → 机器人自动创建一个「每日靚號現牌」app,token 持久化到 data/ 目录复用。
 *      (机器人自建的表格在机器人自己的云空间,把链接分享出去即可查看)
 * 需要 bitable:app 权限(创建/建表/写记录);报 99991672 按日志里的链接开通。
 */

interface DailyRecordGroup {
  port: string
  type: string
  sourceFile: string
  plates: CandidatePlate[]
  selectedNumbers: string[]
}

interface BitableState {
  appToken?: string
  tableId?: string
  appUrl?: string
}

const TABLE_NAME = '最新現牌'
const stateFile = path.join(path.dirname(config.DB_PATH), 'daily-plates-bitable.json')

function loadState(): BitableState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    return { appToken: raw?.appToken || undefined, tableId: raw?.tableId || undefined }
  } catch {
    return {}
  }
}

function saveState(state: BitableState): void {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
}

/** 拿多维表格 app token:优先 .env 配置,否则自动创建一个并持久化 */
async function ensureAppToken(): Promise<string> {
  const state = loadState()
  if (state.appToken) return state.appToken
  if (config.PLATES_BITABLE_APP_TOKEN) {
    state.appToken = config.PLATES_BITABLE_APP_TOKEN
    saveState(state)
    return state.appToken
  }
  const res: any = await apiClient.request({
    method: 'POST',
    url: '/open-apis/bitable/v1/apps',
    data: { name: '每日靚號現牌' },
  })
  const token = res?.data?.app?.app_token
  if (!token) throw new Error(`创建多维表格失败: ${JSON.stringify(res?.data ?? res)?.slice(0, 300)}`)
  state.appToken = token
  saveState(state)
  console.log(`📊 靓号多维表格已自动创建, app_token=${token}(分享此表格链接给同事即可查看)`)
  return token
}

async function findTableByName(appToken: string, name: string): Promise<string | null> {
  const res: any = await apiClient.request({
    method: 'GET',
    url: `/open-apis/bitable/v1/apps/${appToken}/tables`,
    params: { page_size: 100 },
  })
  const items = res?.data?.items ?? []
  const hit = items.find((t: any) => t.name === name)
  return hit?.table_id ?? null
}

/** 拿固定的「最新現牌」表,没有就创建;table_id 缓存复用 */
async function ensureTable(appToken: string): Promise<string> {
  const state = loadState()
  if (state.tableId) return state.tableId

  const existing = await findTableByName(appToken, TABLE_NAME)
  if (existing) {
    state.tableId = existing
    saveState(state)
    return existing
  }

  const res: any = await apiClient.request({
    method: 'POST',
    url: `/open-apis/bitable/v1/apps/${appToken}/tables`,
    data: {
      table: {
        name: TABLE_NAME,
        default_view_name: '表格',
        fields: [
          { field_name: '車牌號碼', type: 1 }, // 1 = 多行文本
          { field_name: '口岸', type: 1 },
          { field_name: '類型', type: 1 },
          { field_name: '批文情況', type: 1 },
          { field_name: '是否今日精選', type: 7 }, // 7 = 复选框
          { field_name: '批次日期', type: 1 },
          { field_name: '來源文件', type: 1 },
        ],
      },
    },
  })
  const tableId = res?.data?.table_id
  if (!tableId) throw new Error(`建表失败(${TABLE_NAME}): ${JSON.stringify(res?.data ?? res)?.slice(0, 300)}`)
  state.tableId = tableId
  saveState(state)
  console.log(`📊 靓号数据表已创建: ${TABLE_NAME} (table_id=${tableId})`)
  return tableId
}

/** 拿多维表格的访问链接(自建 app 也会返回 url),失败返回 null */
async function getAppUrl(appToken: string): Promise<string | null> {
  const state = loadState()
  if (state.appUrl) return state.appUrl
  try {
    const res: any = await apiClient.request({
      method: 'GET',
      url: `/open-apis/bitable/v1/apps/${appToken}`,
    })
    const url = res?.data?.app?.url
    if (url) {
      state.appUrl = url
      saveState(state)
    }
    return url ?? null
  } catch {
    return null
  }
}

/** 清空表里全部旧记录(list → batch_delete,每批 500) */
async function clearTableRecords(appToken: string, tableId: string): Promise<number> {
  const res: any = await apiClient.request({
    method: 'GET',
    url: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    params: { page_size: 500 },
  })
  const ids: string[] = (res?.data?.items ?? []).map((r: any) => r.record_id)
  for (let i = 0; i < ids.length; i += 500) {
    await apiClient.request({
      method: 'POST',
      url: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`,
      data: { records: ids.slice(i, i + 500) },
    })
  }
  return ids.length
}

/**
 * 把最新一批候选写入多维表格「最新現牌」表(先清空再写入,表里永远只有最新一次的)。
 * 返回多维表格链接(发海报时附上);失败返回 null,best-effort 不影响海报出图。
 */
export async function writeDailyRecordsToBitable(
  dateKey: string,
  groups: DailyRecordGroup[],
): Promise<string | null> {
  if (!groups.length) return null
  try {
    const appToken = await ensureAppToken()
    const tableId = await ensureTable(appToken)

    const removed = await clearTableRecords(appToken, tableId)

    const records: { fields: Record<string, any> }[] = []
    for (const g of groups) {
      for (const p of g.plates) {
        records.push({
          fields: {
            '車牌號碼': `粤Z${p.number}港`,
            '口岸': g.port,
            '類型': g.type,
            ...(p.note ? { '批文情況': p.note } : {}),
            '是否今日精選': g.selectedNumbers.includes(p.number),
            '批次日期': dateKey,
            '來源文件': g.sourceFile,
          },
        })
      }
    }
    // batch_create 单次上限 500,逐批写
    for (let i = 0; i < records.length; i += 500) {
      await apiClient.request({
        method: 'POST',
        url: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
        data: { records: records.slice(i, i + 500) },
      })
    }
    const selected = groups.reduce((n, g) => n + g.selectedNumbers.length, 0)
    console.log(`📊 靓号数据已入库多维表格: 清空 ${removed} 行旧记录,写入 ${records.length} 行最新候选(精選 ${selected})`)
    return await getAppUrl(appToken)
  } catch (err: any) {
    console.error('【靓号多维表格入库失败】(不影响海报出图)', err?.response?.data?.msg || (err?.message ?? err))
    if (err?.response?.data?.code === 99991672) {
      console.error('👉 多维表格权限不足:到飞书开放平台给应用开通 bitable:app 权限后重跑即可')
    }
    return null
  }
}
