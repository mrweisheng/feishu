// 多维表格运维脚本(一次性,用完即删):
//   npx tsx setup-bitable.ts list                 —— 列出全部记录(只看,不删)
//   npx tsx setup-bitable.ts delete-all           —— 清空全部记录
//   npx tsx setup-bitable.ts to-single            —— 把「对应业务（群名称）」改成单选
//   npx tsx setup-bitable.ts fields               —— 打印字段定义
import 'dotenv/config'

const APP_ID = process.env.FEISHU_APP_ID
const APP_SECRET = process.env.FEISHU_APP_SECRET
const NODE_TOKEN = 'CQOvwFw5IiEmNSkNglgcrvDnn4f'
const BASE = 'https://open.feishu.cn/open-apis'

async function getToken() {
  const r = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
  const j = await r.json()
  if (j.code !== 0) throw new Error(`token failed: ${JSON.stringify(j)}`)
  return j.tenant_access_token as string
}

async function api(token: string, method: string, path: string, body?: any) {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(`${BASE}${path}`, init)
  const j = await r.json()
  return j
}

async function resolveAppToken(token: string) {
  const node = await api(token, 'GET', `/wiki/v2/spaces/get_node?token=${NODE_TOKEN}&obj_type=wiki`)
  if (node.code !== 0) throw new Error(`get_node 失败: ${JSON.stringify(node)}`)
  return { appToken: node.data.node.obj_token, tableId: 'tblcpgATAP04MyPV' }
}

async function main() {
  const cmd = process.argv[2] || 'list'
  const token = await getToken()
  const { appToken, tableId } = await resolveAppToken(token)
  const R = `/bitable/v1/apps/${appToken}/tables/${tableId}`

  if (cmd === 'fields') {
    const f = await api(token, 'GET', `${R}/fields?page_size=100`)
    for (const x of f.data.items) console.log(`${x.field_id}\t${x.ui_type}\t${x.field_name}`)
    return
  }

  if (cmd === 'get') {
    const rid = process.argv[3]
    const res = await api(token, 'GET', `${R}/records/${rid}`)
    console.log(JSON.stringify(res.data?.record?.fields, null, 2))
    return
  }

  if (cmd === 'list') {
    const all: any[] = []
    let pageToken: string | null = null
    do {
      const q = pageToken ? `${R}/records?page_size=500&page_token=${pageToken}` : `${R}/records?page_size=500`
      const res = await api(token, 'GET', q)
      if (res.code !== 0) throw new Error(JSON.stringify(res))
      all.push(...(res.data.items || []))
      pageToken = res.data.has_more ? res.data.page_token : null
    } while (pageToken)
    console.log(`\n共 ${all.length} 条记录:`)
    for (const rec of all) {
      const f = rec.fields
      const sum = `${f['记录类型'] || ''} | ${f['对应业务（群名称）'] || ''} | ${f['金额'] ?? ''} ${f['币种'] || ''} | ${f['收款对象'] || f['转出对象'] || ''}`
      console.log(`  ${rec.record_id}  ${sum}`)
    }
    return
  }

  if (cmd === 'delete-all') {
    const all: string[] = []
    let pageToken: string | null = null
    do {
      const q = pageToken ? `${R}/records?page_size=500&page_token=${pageToken}` : `${R}/records?page_size=500`
      const res = await api(token, 'GET', q)
      if (res.code !== 0) throw new Error(JSON.stringify(res))
      all.push(...(res.data.items || []).map((x: any) => x.record_id))
      pageToken = res.data.has_more ? res.data.page_token : null
    } while (pageToken)
    console.log(`待删除 ${all.length} 条`)
    for (let i = 0; i < all.length; i += 500) {
      const batch = all.slice(i, i + 500)
      const res = await api(token, 'POST', `${R}/records/batch_delete`, { records: batch })
      console.log(`删除批次 ${i / 500 + 1}:`, res.code === 0 ? `✅ ${batch.length} 条` : JSON.stringify(res))
    }
    return
  }

  if (cmd === 'subscribe') {
    // 订阅这个多维表格的云文档事件(接收记录变更):npx tsx setup-bitable.ts subscribe
    const res = await api(token, 'POST', `/drive/v1/files/${appToken}/subscribe?file_type=bitable`)
    console.log(`订阅(app_token=${appToken}):`, res.code === 0 ? '✅ 成功' : `❌ code=${res.code} msg=${res.msg}`)
    console.log(JSON.stringify(res))
    return
  }

  if (cmd === 'rename') {
    // 改列名(保留原类型/属性,只动 field_name):npx tsx setup-bitable.ts rename 旧列名 新列名
    const from = process.argv[3]
    const to = process.argv[4]
    if (!from || !to) { console.error('用法: rename <旧列名> <新列名>'); process.exit(1) }
    const fl = await api(token, 'GET', `${R}/fields?page_size=100`)
    const target = fl.data.items.find((x: any) => x.field_name === from)
    if (!target) { console.log(`❌ 找不到字段「${from}」`); return }
    console.log(`当前:${target.ui_type} (type=${target.type}) field_id=${target.field_id}`)
    const res = await api(token, 'PUT', `${R}/fields/${target.field_id}`, {
      field_id: target.field_id,
      field_name: to,
      type: target.type,
      ui_type: target.ui_type,
      property: target.property || {},
    })
    console.log(res.code === 0 ? `✅ 已把「${from}」改名为「${to}」` : `❌ 改名失败: ${JSON.stringify(res)}`)
    return
  }

  if (cmd === 'to-single') {
    // 找到「对应业务（群名称）」字段
    const fl = await api(token, 'GET', `${R}/fields?page_size=100`)
    const target = fl.data.items.find((x: any) => x.field_name === '对应业务（群名称）')
    if (!target) return console.log('❌ 找不到字段「对应业务（群名称）」')
    console.log(`当前:${target.ui_type} (type=${target.type}) field_id=${target.field_id}`)
    if (target.ui_type === 'SingleSelect') return console.log('已经是单选,无需改')
    const res = await api(token, 'PUT', `${R}/fields/${target.field_id}`, {
      field_id: target.field_id,
      field_name: target.field_name,
      type: 3,
      ui_type: 'SingleSelect',
      property: { options: [] },
    })
    console.log(res.code === 0 ? '✅ 已改为单选' : `❌ 改失败(可能需在表格界面手动改): ${JSON.stringify(res)}`)
    return
  }

  console.log('未知命令,可用: list | delete-all | to-single | rename | fields')
}

main().catch((e) => { console.error('💥', e); process.exit(1) })
