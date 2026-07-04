import { db } from './index.js'

export interface PaymentMethod {
  key: string
  label: string // 必须与多维表格「收款账户」单选选项逐字一致(写入时直接当选项值)
  currency: string // HKD | RMB | ANY(仅元数据,不做强制校验)
  details: string
}

// 我方收款方式。label 与多维表格选项保持一致;首次启动后入库,可在库里直接维护。
export const PAYMENT_METHODS: PaymentMethod[] = [
  {
    key: 'huaxin_hkd',
    label: '华星资源开发有限公司-华侨银行（港币）',
    currency: 'HKD',
    details:
      '户名:华星资源开发有限公司 CHINA STAR RESOURCE DEVELOPMENT LIMITED | 华侨银行:035-802-129-690-051 | 转数快 FPS:131-831-406',
  },
  {
    key: 'chen_zhenyao_rmb',
    label: '陈振耀-工商银行（人民币）',
    currency: 'RMB',
    details:
      '户名:陈振耀 | 工商银行:2009020501023937427 | 网点号:0205 | 汕尾海丰东门头支行 | 地址:海丰县城人民中路7号 | 电话:0660-6623712',
  },
  {
    key: 'li_fangliang_hkd',
    label: 'LI FANGLIANG-ZA Bank（港币）',
    currency: 'HKD',
    details: '户名:LI FANGLIANG | ZA Bank:881023112711 | 银行编号:387 | 分行编号:747 | FPS ID:127813822',
  },
  {
    key: 'personal_alipay',
    label: '个人支付宝',
    currency: 'ANY',
    details: '户名:赵欣朵 | 支付宝(个人)',
  },
  {
    key: 'personal_wechat',
    label: '个人微信',
    currency: 'ANY',
    details: '户名:赵欣朵 | 微信(个人)',
  },
  {
    key: 'cash',
    label: '现金',
    currency: 'ANY',
    details: '现金(港币现金/人民币现金,以金额币种为准)',
  },
]

const upsertMethod = db.prepare(`
INSERT INTO payment_methods (key, label, currency, details)
VALUES (@key, @label, @currency, @details)
ON CONFLICT(key) DO UPDATE SET
  label = excluded.label,
  currency = excluded.currency,
  details = excluded.details
`)

const listAllMethods = db.prepare(
  `SELECT key, label, currency, details FROM payment_methods ORDER BY key`
)

// 启动时幂等 seed:upsert 当前配置 + 清理已废弃的 key(保持库与常量一致)
export function seedPaymentMethods(): void {
  for (const m of PAYMENT_METHODS) {
    upsertMethod.run({ key: m.key, label: m.label, currency: m.currency, details: m.details })
  }
  const placeholders = PAYMENT_METHOD_KEYS.map(() => '?').join(',')
  db.prepare(`DELETE FROM payment_methods WHERE key NOT IN (${placeholders})`).run(...PAYMENT_METHOD_KEYS)
}

export function listPaymentMethods(): PaymentMethod[] {
  return listAllMethods.all() as PaymentMethod[]
}

export const PAYMENT_METHOD_KEYS = PAYMENT_METHODS.map((m) => m.key)

// 模块加载副作用:db/index.ts 先建表,这里幂等补收款方式
seedPaymentMethods()
