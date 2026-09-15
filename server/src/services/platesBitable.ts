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
}const TABLE_NAME = '最新現牌'
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
  const app = res?.data?.app
  if (!app?.app_token) throw new Error(`创建多维表格失败: ${JSON.stringify(res?.data ?? res)?.slice(0, 300)}`)
  state.appToken = app.app_token as string
  // 创建响应自带 url(元数据查询接口反而不带,必须在这里存下来)
  if (app.url) state.appUrl = app.url
  saveState(state)
  console.log(`📊 靓号多维表格已自动创建, app_token=${app.app_token}(分享此表格链接给同事即可查看)`)
  return state.appToken as string
}

/**
 * 拿多维表格访问链接。按序兜底:
 *   1. 创建时捕获的 url(创建响应里有,元数据查询接口没有);
 *   2. 用客资表链接里的租户域名拼标准格式(https://<租户域名>/base/<app_token>);
 *   3. 都不行返回 null(海报不带链接,但数据已入库)。
 */
async function getAppUrl(appToken: string, tableId?: string): Promise<string | null> {
  const state = loadState()
  const base = state.appUrl ?? (config.BITABLE_CUSTOMER_LINK ? `${new URL(config.BITABLE_CUSTOMER_LINK).origin}/base/${appToken}` : null)
  if (!base) return null
  return tableId ? `${base}?table=${tableId}` : base
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
    return await getAppUrl(appToken, tableId)
  } catch (err: any) {
    console.error('【靓号多维表格入库失败】(不影响海报出图)', err?.response?.data?.msg || (err?.message ?? err))
    if (err?.response?.data?.code === 99991672) {
      console.error('👉 多维表格权限不足:到飞书开放平台给应用开通 bitable:app 权限后重跑即可')
    }
    return null
  }
}

// ---- 入表审核与自动修复 ----

interface ExpectedRow {
  number: string // 归一化后的号牌主体(如 9E66)
  port: string
  type: string
  note: string
  selected: boolean
  sourceFile: string
}

function buildExpectedRows(groups: DailyRecordGroup[]): ExpectedRow[] {
  const rows: ExpectedRow[] = []
  for (const g of groups) {
    for (const p of g.plates) {
      rows.push({
        number: p.number,
        port: g.port,
        type: g.type,
        note: p.note ?? '',
        selected: g.selectedNumbers.includes(p.number),
        sourceFile: g.sourceFile,
      })
    }
  }
  return rows
}

/** 从 bitable 读回全部记录,归一成可比较的行 */
async function readActualRows(appToken: string, tableId: string): Promise<ExpectedRow[]> {
  const rows: ExpectedRow[] = []
  let pageToken: string | undefined
  do {
    const res: any = await apiClient.request({
      method: 'GET',
      url: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
    })
    for (const r of res?.data?.items ?? []) {
      const f = r.fields ?? {}
      const numText = Array.isArray(f['車牌號碼']) ? f['車牌號碼'][0]?.text : f['車牌號碼']
      const num = String(numText ?? '')
        .replace(/^[粤粵]+/i, '')
        .replace(/[港澳]+$/, '')
        .trim()
      const sel = f['是否今日精選']
      rows.push({
        number: num,
        port: String(f['口岸'] ?? ''),
        type: String(f['類型'] ?? ''),
        note: String(f['批文情況'] ?? ''),
        selected: sel === true || sel === 1,
        sourceFile: String(f['來源文件'] ?? ''),
      })
    }
    pageToken = res?.data?.has_more ? res?.data?.page_token : undefined
  } while (pageToken)
  return rows
}

function rowKey(r: ExpectedRow): string {
  return `${r.number}|${r.port}|${r.type}|${r.selected ? 1 : 0}`
}

/** 逐行比对(多重集合),返回不一致的摘要;一致返回 null */
function diffRows(expected: ExpectedRow[], actual: ExpectedRow[]): string | null {
  if (actual.length !== expected.length) {
    return `行数不符:期望 ${expected.length},实际 ${actual.length}`
  }
  // 重复号码检测(同号在表里出现两次就是错)
  const numCount = new Map<string, number>()
  for (const r of actual) numCount.set(r.number, (numCount.get(r.number) ?? 0) + 1)
  const dups = [...numCount.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  if (dups.length) return `存在重复号码:${dups.join('、')}`
  const key = (r: ExpectedRow) => rowKey(r)
  const exp = new Set(expected.map(key))
  const act = new Set(actual.map(key))
  for (const k of exp) if (!act.has(k)) return `缺少预期行:${k}`
  for (const k of act) if (!exp.has(k)) return `多出意外行:${k}`
  return null
}

/**
 * 入表审核:读回维格表逐行与预期比对(号码/口岸/类型/精选/行数/重复),
 * 不一致自动清空重写修复并二次验证。
 */
export async function auditAndFixBitable(dateKey: string, groups: DailyRecordGroup[]): Promise<void> {
  try {
    const appToken = await ensureAppToken()
    const tableId = await ensureTable(appToken)
    const expected = buildExpectedRows(groups)
    const actual = await readActualRows(appToken, tableId)
    const diff = diffRows(expected, actual)
    if (!diff) {
      console.log(`🛡️ 审核:维格表 ${actual.length} 行与预期完全一致(无重复,口岸/类型/精选均正确)`)
      return
    }
    console.warn(`🛡️ 审核:维格表不一致(${diff}),自动修复:清空重写...`)
    await clearTableRecords(appToken, tableId)
    const records = buildExpectedRows(groups).map((r) => ({
      fields: {
        '車牌號碼': `粤Z${r.number}港`,
        '口岸': r.port,
        '類型': r.type,
        ...(r.note ? { '批文情況': r.note } : {}),
        '是否今日精選': r.selected,
        '批次日期': dateKey,
        '來源文件': r.sourceFile,
      },
    }))
    for (let i = 0; i < records.length; i += 500) {
      await apiClient.request({
        method: 'POST',
        url: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
        data: { records: records.slice(i, i + 500) },
      })
    }
    const recheck = diffRows(expected, await readActualRows(appToken, tableId))
    if (recheck) console.error(`🛡️ 审核:修复后仍不一致(${recheck}),请人工检查维格表`)
    else console.log(`🛡️ 审核:自动修复完成,重读 ${expected.length} 行全部一致 ✅`)
  } catch (err: any) {
    console.error('【靓号维格表审核失败】(不影响已发出的海报)', err?.response?.data?.msg || (err?.message ?? err))
  }
}
