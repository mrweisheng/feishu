import { apiClient } from './client.js'
import { config } from '../config.js'

// 待办事项表写入是否启用(未配 app_token/table_id 则跳过,只设提醒不入表格)
const ENABLED = !!(config.BITABLE_TODO_APP_TOKEN && config.BITABLE_TODO_TABLE_ID)
const APP = config.BITABLE_TODO_APP_TOKEN
const TABLE = config.BITABLE_TODO_TABLE_ID
const basePath = `/open-apis/bitable/v1/apps/${APP}/tables/${TABLE}`

// ---- 字段名(必须与多维表格表头逐字一致) ----
const F = {
  content: '事件内容',
  owner: '责任人',
  status: '处理状态',
} as const

let warnedDisabled = false
function skipLog(): void {
  if (!warnedDisabled) {
    console.log('ℹ️ 待办表格写入未启用(未配 BITABLE_TODO_APP_TOKEN/TABLE_ID),只设提醒不入表格')
    warnedDisabled = true
  }
}

/**
 * 在待办事项表新增一条记录(处理状态=待处理,责任人=说话人)。「通知群组」字段暂不写(群组类型字段写入报 1254001,格式待定)。
 * best-effort:失败只记日志返回 null,不影响后续提醒设置。
 * @returns 多维表格 record_id;未启用或失败返回 null
 */
export async function createTodoInBitable(input: {
  content: string
  userOpenId: string
}): Promise<string | null> {
  if (!ENABLED) {
    skipLog()
    return null
  }
  try {
    const fields: Record<string, any> = {
      [F.content]: input.content,
      [F.status]: '待处理',
      [F.owner]: [{ id: input.userOpenId }],
    }
    const res: any = await apiClient.request({
      method: 'POST',
      url: `${basePath}/records`,
      data: { fields },
    })
    if (res.code !== 0) throw new Error(`code=${res.code} msg=${res.msg}`)
    const rid = res.data?.record?.record_id ?? null
    console.log(`📋 已创建待办 record=${rid} 内容="${input.content}"`)
    return rid
  } catch (err: any) {
    console.error('【待办表格写入失败】', err.message ?? err)
    return null
  }
}

// 表格读回的值类型不统一(Text/SingleSelect=string,也可能 array),归一成字符串
function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as any).text) : String(x)))
      .join('')
  }
  return String(v)
}

/**
 * 批量读待办记录的处理状态 + 事件内容(到点提醒前用,筛出仍"待处理"的)。
 * 逐条 GET,失败的跳过。未启用或全失败返回空数组。
 */
export async function getTodoRecords(
  recordIds: string[]
): Promise<{ record_id: string; status: string; content: string }[]> {
  if (!ENABLED || !recordIds.length) return []
  const out: { record_id: string; status: string; content: string }[] = []
  for (const rid of recordIds) {
    try {
      const res: any = await apiClient.request({
        method: 'GET',
        url: `${basePath}/records/${rid}`,
      })
      if (res.code !== 0) {
        console.warn(`【待办状态读取失败】record=${rid} code=${res.code} msg=${res.msg}`)
        continue
      }
      const fields = res.data?.record?.fields ?? {}
      out.push({
        record_id: rid,
        status: asText(fields[F.status]),
        content: asText(fields[F.content]),
      })
    } catch (err: any) {
      console.warn(`【待办状态读取异常】record=${rid}`, err.message ?? err)
    }
  }
  return out
}
