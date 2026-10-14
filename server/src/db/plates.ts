import { db } from './index.js'

/**
 * 现牌车牌本地存储(SQLite,唯一事实源之一)。
 *
 * 每次从现牌群提取出的候选车牌按「批次日期 + 口岸 + 号码」落库,保留**多天历史**
 * (多维表格只留最新一批作可视化副本,问答要「今天没有就用昨天」,必须有历史)。
 *
 * 幂等:UNIQUE(date_key, port, number) + INSERT OR IGNORE —— 当天多次批次、启动重放
 * 都不会产生重复行(重放会先清空当天再重写,以反映源文件可能的更正)。
 */

export interface StoredPlate {
  /** 批次日期(北京时间 YYYY-MM-DD) */
  dateKey: string
  port: string
  /** 类型,如 高新現牌 / 納稅現牌 */
  type: string | null
  /** 号牌前缀,一般「粤Z」 */
  region: string
  /** 号牌主体,如 9E66 */
  number: string
  note: string | null
  /** 来源文件名(文档或图片) */
  sourceFile: string | null
  /** 是否由图片兜底提取(文档读不出来时) */
  fromImage: boolean
}

/** 查询用的行(字段名用 camelCase 方便上层) */
export interface PlateRow {
  port: string
  type: string | null
  region: string | null
  number: string
  note: string | null
  sourceFile: string | null
  fromImage: number
}

const insertPlate = db.prepare(`
INSERT OR IGNORE INTO plates (date_key, port, type, region, number, note, source_file, from_image, created_at)
VALUES (@date_key, @port, @type, @region, @number, @note, @source_file, @from_image, @created_at)
`)

/** 批量落库(事务 + 去重)。返回真正新增的行数。 */
export function addPlates(rows: StoredPlate[]): number {
  if (!rows.length) return 0
  const now = Date.now()
  const tx = db.transaction((rs: StoredPlate[]) => {
    let n = 0
    for (const r of rs) {
      const info = insertPlate.run({
        date_key: r.dateKey,
        port: r.port,
        type: r.type,
        region: r.region,
        number: r.number,
        note: r.note,
        source_file: r.sourceFile,
        from_image: r.fromImage ? 1 : 0,
        created_at: now,
      })
      n += info.changes
    }
    return n
  })
  return tx(rows)
}

const clearByDate = db.prepare('DELETE FROM plates WHERE date_key = ?')

/** 清空某一天的全部记录(重放时先清再写,反映更正) */
export function clearPlatesByDate(dateKey: string): number {
  return clearByDate.run(dateKey).changes
}

const listByDate = db.prepare(
  `SELECT port, type, region, number, note, source_file AS sourceFile, from_image AS fromImage
   FROM plates WHERE date_key = ? ORDER BY port ASC, number ASC`,
)

export function listPlatesByDate(dateKey: string): PlateRow[] {
  return listByDate.all(dateKey) as unknown as PlateRow[]
}

const latestDate = db.prepare('SELECT MAX(date_key) AS d FROM plates')

/** 最近有数据的那一天(YYYY-MM-DD);无任何数据返回 null。问答据此"今天没有就用最近一天" */
export function latestPlatesDate(): string | null {
  const row = latestDate.get() as { d: string | null } | undefined
  return row?.d ?? null
}
