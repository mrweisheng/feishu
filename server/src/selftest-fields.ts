// 拉待办表的所有字段元数据(type/选项),用于诊断写入失败 code=1254001 WrongRequestBody 是哪个字段类型不匹配。
// 用法:cd server && npx tsx src/selftest-fields.ts   或   npm run selftest:fields

import { apiClient } from './feishu/client.js'
import { config } from './config.js'

// 飞书 bitable 字段 type 编码 → 中文名
const TYPE_NAME: Record<number, string> = {
  1: '多行文本',
  2: '数字',
  3: '单选',
  4: '多选',
  5: '日期',
  7: '复选框',
  8: '条码',
  11: '人员',
  13: '电话',
  15: '超链接',
  17: '附件',
  18: '关联记录',
  19: '查找引用',
  20: '公式',
  21: '双向关联',
  22: '地理位置',
  23: '群组',
  1001: '创建时间',
  1002: '最后更新时间',
  1003: '创建人',
  1004: '修改人',
  1005: '自动编号',
}

async function main(): Promise<void> {
  if (!config.BITABLE_TODO_APP_TOKEN || !config.BITABLE_TODO_TABLE_ID) {
    console.error('❌ 未配置 BITABLE_TODO_APP_TOKEN / BITABLE_TODO_TABLE_ID')
    process.exit(1)
  }
  console.log(`APP_TOKEN=${config.BITABLE_TODO_APP_TOKEN}`)
  console.log(`TABLE_ID=${config.BITABLE_TODO_TABLE_ID}\n`)
  console.log('待办表字段结构(原样):\n')

  const res: any = await apiClient.request({
    method: 'GET',
    url: `/open-apis/bitable/v1/apps/${config.BITABLE_TODO_APP_TOKEN}/tables/${config.BITABLE_TODO_TABLE_ID}/fields`,
  })
  if (res.code !== 0) {
    console.error(`❌ 拉字段失败 code=${res.code} msg=${res.msg}`)
    process.exit(1)
  }
  const items = res.data?.items ?? []
  for (const f of items) {
    const t = TYPE_NAME[f.type] ?? `未知(${f.type})`
    console.log(`  • "${f.field_name}"  →  类型:${t} (type=${f.type}${f.ui_type ? `, ui_type=${f.ui_type}` : ''})`)
    // 单选/多选:打印已有选项,看"待处理"在不在
    if (f.property?.options?.length) {
      const opts = f.property.options.map((o: any) => o.name).join(' / ')
      console.log(`      选项:[${opts}]`)
    }
    // 人员/群组:是否多选
    if (typeof f.property?.multiple === 'boolean') {
      console.log(`      multiple=${f.property.multiple}`)
    }
  }
  console.log(`\n共 ${items.length} 个字段`)
  process.exit(0)
}

main().catch((err) => {
  console.error('【诊断异常】', err)
  process.exit(1)
})
