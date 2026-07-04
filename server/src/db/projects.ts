import { db } from './index.js'

const findByName = db.prepare(
  `SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE`
)
const insertProject = db.prepare(
  `INSERT INTO projects (name, created_at) VALUES (?, ?)`
)
const listNames = db.prepare(`SELECT id, name FROM projects ORDER BY name`)
const renameStmt = db.prepare(`UPDATE projects SET name = ? WHERE id = ?`)
const moveTxns = db.prepare(
  `UPDATE transactions SET project_id = ? WHERE project_id = ?`
)
const deleteProject = db.prepare(`DELETE FROM projects WHERE id = ?`)

export interface ProjectRow {
  id: number
  name: string
}

export interface ResolvedProject {
  id: number
  name: string
  isNew: boolean
}

/**
 * 解析业务名:大小写不敏感精确命中则复用,否则新建。
 * 注意:只做精确匹配(简繁/错字容错交给 LLM 在 system prompt 里逐字照抄已有名)。
 */
export function resolveProject(name: string): ResolvedProject {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('业务名不能为空')
  const hit = findByName.get(trimmed) as ProjectRow | undefined
  if (hit) return { id: hit.id, name: hit.name, isNew: false }
  const info = insertProject.run(trimmed, Date.now())
  return { id: info.lastInsertRowid as number, name: trimmed, isNew: true }
}

export function listProjectNames(): ProjectRow[] {
  return listNames.all() as ProjectRow[]
}

const byId = db.prepare(`SELECT id, name FROM projects WHERE id = ?`)
export function getProjectName(id: number): string {
  return (byId.get(id) as ProjectRow | undefined)?.name ?? ''
}

/**
 * 只读查找业务 id(大小写不敏感精确命中),找不到返回 null。
 * 查询用,不会新建——区别于 resolveProject(那会把陌生名字落库)。
 */
export function findProjectIdByName(name: string): number | null {
  const hit = findByName.get(name.trim()) as ProjectRow | undefined
  return hit ? hit.id : null
}

export function renameProject(id: number, newName: string): boolean {
  return renameStmt.run(newName.trim(), id).changes > 0
}

/**
 * 合并业务:把 fromId 下所有流水改挂到 toId,再删 fromId。返回迁移条数。
 * 用于纠正"同一笔业务被建成两个 project"的情况。
 */
export function mergeProjects(fromId: number, toId: number): number {
  if (fromId === toId) return 0
  const tx = db.transaction(() => {
    const moved = moveTxns.run(toId, fromId).changes
    deleteProject.run(fromId)
    return moved
  })
  return tx()
}
