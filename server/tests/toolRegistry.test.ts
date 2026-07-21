/**
 * 工具注册表 + 事实接管 的纯函数单测。
 * 锁死行为:防假链接、防 LLM 假宣布成功、真实条数/链接由代码决定。
 *
 * 运行:npm test(底层 node --test + tsx,零额外依赖)
 *
 * 注意:toolRegistry.ts 顶部 import config.ts,后者在校验 .env 环境变量时会抛错。
 * 所以这里先注入测试用环境变量,再 import 被测模块(ESM import 是提升的,
 * 用动态 import() 推迟到 env 设置之后)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---- 在 import 被测模块前,先填好 config.ts 要求的环境变量 ----
process.env.FEISHU_APP_ID = 'test'
process.env.FEISHU_APP_SECRET = 'test'
process.env.ANTHROPIC_BASE_URL = 'http://localhost'
process.env.ANTHROPIC_API_KEY = 'test'
// 真实链接来源(模拟 .env 里的 BITABLE_CUSTOMER_LINK)
const REAL_CUSTOMER_LINK = 'https://uipxp5adkne.feishu.cn/wiki/GAmHwqNGbi1ICzkAdErc9bLmnmb'
process.env.BITABLE_CUSTOMER_LINK = REAL_CUSTOMER_LINK

const { stripAllUrls, buildSystemAttestation, normalizeName, dateKeyShanghai, stripDatePrefix } = await import('../src/llm/toolRegistry.js')
type LedgerEntry = import('../src/llm/toolRegistry.js').LedgerEntry

// ---------- stripAllUrls:一刀切全清,锁死"合法域名+编造路径"也拦得住 ----------
test('stripAllUrls:伪造的 feishu.cn/base/xxx 链接必须被清掉', () => {
  // 这正是本次 bug 里 LLM 编的假链接 —— hostname 合法(feishu.cn),路径编造
  const fake = '已登记 9 条 👉 https://feishu.cn/base/SBHsbJxfCaN3q6sEHMacX5UnnTc'
  const out = stripAllUrls(fake)
  assert.ok(!/https?:\/\//i.test(out), '清洗后绝不能残留任何 http(s) 链接')
  assert.ok(out.includes('已登记 9 条'), '非链接文字应保留')
})

test('stripAllUrls:多个链接、带 markdown 包裹的也全清', () => {
  const t = '看 [表格](https://x.com/a) 和 https://feishu.cn/base/ABC 以及 http://evil.com/x'
  const out = stripAllUrls(t)
  assert.ok(!/https?:\/\//i.test(out))
  assert.ok(!out.includes('evil.com'))
})

test('stripAllUrls:没有链接的文本原样保留', () => {
  const t = '你好,我帮你登记啦 ☀️'
  assert.equal(stripAllUrls(t), t)
})

test('stripAllUrls:空字符串/null 安全', () => {
  assert.equal(stripAllUrls(''), '')
})

// ---------- buildSystemAttestation:事实接管,只信账本不信 LLM ----------

test('事实接管:账本 0 条写工具 → 不追加任何东西(纯闲聊场景)', () => {
  const ledger: LedgerEntry[] = []
  assert.equal(buildSystemAttestation(ledger), '')
})

test('事实接管:只有读工具(天气)→ 不追加(读工具不参与事实接管)', () => {
  const ledger: LedgerEntry[] = [
    { tool: 'get_weather', category: 'read', ok: true },
  ]
  assert.equal(buildSystemAttestation(ledger), '')
})

test('事实接管:本轮 0 条客资成功 → 诚实声明"实际未成功,请重发"(核心反幻觉)', () => {
  // 模拟本次 bug:LLM 嘴上说"已登记 9 条",但账本里压根没有写工具执行记录
  const ledger: LedgerEntry[] = []
  const llmText = '已登记 9 条:徐途似锦、Y、KK...'
  const out = buildSystemAttestation(ledger, llmText)
  // 关键:账本 0 条 + LLM 嘴上说"已登记" → 系统必须戳穿,输出"实际未成功"
  assert.ok(out.includes('实际未成功'), 'LLM 声称成功但账本空时,必须戳穿"实际未成功"')
  assert.ok(/重发|重新发|换张/.test(out), '应提醒用户重发')
  assert.ok(!out.includes(REAL_CUSTOMER_LINK), '未成功时绝不贴链接')
})

test('事实接管:账本空 + LLM 没声称登记(纯闲聊)→ 不追加', () => {
  const ledger: LedgerEntry[] = []
  const llmText = '你好呀,今天天气不错 ☀️'
  assert.equal(buildSystemAttestation(ledger, llmText), '')
})

test('事实接管:账本空 + LLM 编"给你录了" → 戳穿(覆盖各种声称词)', () => {
  const ledger: LedgerEntry[] = []
  for (const claim of ['已登记5条', '给你录了', '帮你登好了', '录入成功', '已记下张三']) {
    const out = buildSystemAttestation(ledger, claim)
    assert.ok(out.includes('实际未成功'), `声称词"${claim}"应被戳穿`)
  }
})

test('事实接管:3 条客资全成功 → 真实条数 + 名字 + 唯一真实链接', () => {
  const ledger: LedgerEntry[] = [
    { tool: 'record_customer_info', category: 'write', ok: true, summary: '徐途似锦', linkKey: 'customer' },
    { tool: 'record_customer_info', category: 'write', ok: true, summary: '雅琴', linkKey: 'customer' },
    { tool: 'record_customer_info', category: 'write', ok: true, summary: 'KK', linkKey: 'customer' },
  ]
  const out = buildSystemAttestation(ledger)
  assert.ok(out.includes('已登记客资 3 条'), '应输出真实条数 3')
  assert.ok(out.includes('「徐途似锦」'), '应列名字')
  assert.ok(out.includes('「雅琴」'))
  assert.ok(out.includes('「KK」'))
  assert.ok(out.includes(REAL_CUSTOMER_LINK), '应贴唯一真实链接(config 注入)')
  // 链接只出现一次(整批只贴一次)
  assert.equal((out.match(new RegExp(REAL_CUSTOMER_LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1)
})

test('事实接管:部分成功 → 成功的列出来,失败数如实补一句', () => {
  const ledger: LedgerEntry[] = [
    { tool: 'record_customer_info', category: 'write', ok: true, summary: '张三', linkKey: 'customer' },
    { tool: 'record_customer_info', category: 'write', ok: false, error: '客户姓名为空' },
    { tool: 'record_customer_info', category: 'write', ok: false, error: '客户姓名为空' },
  ]
  const out = buildSystemAttestation(ledger)
  assert.ok(out.includes('已登记客资 1 条'))
  assert.ok(out.includes('「张三」'))
  assert.ok(out.includes('2 条失败'), '失败数应如实告知')
})

test('事实接管:全部失败 → 明确"实际未成功"+ 提醒重发', () => {
  const ledger: LedgerEntry[] = [
    { tool: 'record_customer_info', category: 'write', ok: false, error: '客户姓名为空' },
    { tool: 'record_customer_info', category: 'write', ok: false, error: '客户姓名为空' },
  ]
  const out = buildSystemAttestation(ledger)
  assert.ok(out.includes('实际未成功'), '必须诚实声明未成功')
  assert.ok(/重发|重新发|换张/.test(out), '应提醒用户重发')
  assert.ok(!out.includes(REAL_CUSTOMER_LINK), '全失败时绝不贴链接')
})

test('事实接管:set_reminder 成功 → 报数量,不贴链接(无 linkKey)', () => {
  const ledger: LedgerEntry[] = [
    { tool: 'set_reminder', category: 'write', ok: true, summary: '喝水' },
  ]
  const out = buildSystemAttestation(ledger)
  assert.ok(out.includes('已设置提醒 1 条'))
  assert.ok(!/https?:\/\//.test(out), '提醒工具不该带链接')
})

test('事实接管:多工具混合(客资+提醒)→ 各自独立报告', () => {
  const ledger: LedgerEntry[] = [
    { tool: 'record_customer_info', category: 'write', ok: true, summary: '李四', linkKey: 'customer' },
    { tool: 'set_reminder', category: 'write', ok: true, summary: '开会' },
    { tool: 'get_weather', category: 'read', ok: true }, // 读工具不出现
  ]
  const out = buildSystemAttestation(ledger)
  assert.ok(out.includes('已登记客资 1 条'))
  assert.ok(out.includes('已设置提醒 1 条'))
  assert.ok(!out.includes('天气')) // 读工具不进事实接管
})

// ---------- normalizeName:去重归一化 ----------

test('normalizeName:普通空格全去掉', () => {
  assert.equal(normalizeName('徐 途 似 锦'), '徐途似锦')
  assert.equal(normalizeName('徐途似锦'), '徐途似锦')
})

test('normalizeName:全角空格/Tab/换行也全去掉', () => {
  assert.equal(normalizeName('徐途似锦'), '徐途似锦') // 全角空格
  assert.equal(normalizeName('徐途\t似锦'), '徐途似锦') // tab
  assert.equal(normalizeName('徐途\n似锦'), '徐途似锦') // 换行
})

test('normalizeName:大小写保留(Y ≠ y)', () => {
  assert.equal(normalizeName('Y'), 'Y')
  assert.equal(normalizeName('y'), 'y')
  assert.notEqual(normalizeName('Y'), normalizeName('y'), '大小写不同算不同客户')
})

test('normalizeName:首尾空白 trim', () => {
  assert.equal(normalizeName('  雅琴  '), '雅琴')
  assert.equal(normalizeName('\t雅琴\n'), '雅琴')
})

test('normalizeName:空串安全', () => {
  assert.equal(normalizeName(''), '')
})

// ---------- dateKeyShanghai:跨日去重的"同一天"判定 ----------
// 这是去重正确性的核心 —— 14:16 和 23:59 同属一天,跨零点才算下一天;必须固定北京时间。

test('dateKeyShanghai:同一天不同时刻 → 同一个 key', () => {
  // 2026-07-17 凌晨、中午、深夜 都是 07-17
  const k1 = dateKeyShanghai(Date.parse('2026-07-17T00:00:01+08:00'))
  const k2 = dateKeyShanghai(Date.parse('2026-07-17T14:34:30+08:00'))
  const k3 = dateKeyShanghai(Date.parse('2026-07-17T23:59:59+08:00'))
  assert.equal(k1, '2026-07-17')
  assert.equal(k2, '2026-07-17')
  assert.equal(k3, '2026-07-17')
})

test('dateKeyShanghai:跨零点 → 不同 key(防跨日去重错位)', () => {
  // 7-17 深夜 23:59 和 7-18 凌晨 00:01 不是同一天
  const k1 = dateKeyShanghai(Date.parse('2026-07-17T23:59:59+08:00'))
  const k2 = dateKeyShanghai(Date.parse('2026-07-18T00:00:01+08:00'))
  assert.notEqual(k1, k2, '跨零点必须算不同天,否则去重会跨日错位')
  assert.equal(k1, '2026-07-17')
  assert.equal(k2, '2026-07-18')
})

test('dateKeyShanghai:UTC 时间戳按北京时间归日(防部署到 UTC 机器差 8h)', () => {
  // UTC 2026-07-16 16:00:00 = 北京 2026-07-17 00:00:00 → 应算 07-17
  const k = dateKeyShanghai(Date.parse('2026-07-16T16:00:00Z'))
  assert.equal(k, '2026-07-17', '必须按北京时间归日,不能按 UTC')
})

// ---------- stripDatePrefix:去重口径与维格表一致的关键 ----------
// 维格表存的是剥离后的纯名字,去重比对若用原始带前缀名 → 对不上 → 重复录入(本次复审抓到的 bug)

test('stripDatePrefix:剥 "60717/雅琴" → "雅琴"', () => {
  assert.equal(stripDatePrefix('60717/雅琴'), '雅琴')
})

test('stripDatePrefix:剥 "7.13 雷思诺" → "雷思诺"', () => {
  assert.equal(stripDatePrefix('7.13 雷思诺'), '雷思诺')
})

test('stripDatePrefix:剥 "60716/林佳" → "林佳"', () => {
  assert.equal(stripDatePrefix('60716/林佳'), '林佳')
})

test('stripDatePrefix:纯数字名 "3" 不被剥(没有分隔符+后续)', () => {
  // 关键:"3" 是合法客户名,不能被当日期前缀剥成空
  assert.equal(stripDatePrefix('3'), '3')
})

test('stripDatePrefix:无前缀的原样返回', () => {
  assert.equal(stripDatePrefix('徐途似锦'), '徐途似锦')
  assert.equal(stripDatePrefix('Y'), 'Y')
})

test('去重口径一致:stripDatePrefix + normalizeName 后,"60717/雅琴" 与 "雅琴" 相同', () => {
  // 这是本次复审修复的核心:LLM 传带前缀的名,维格表存纯名,两者归一化后必须相等才能正确去重
  const fromLLM = normalizeName(stripDatePrefix('60717/雅琴'))
  const fromBitable = normalizeName(stripDatePrefix('雅琴'))
  assert.equal(fromLLM, fromBitable, '带前缀和不带前缀归一化后必须相同,否则去重失效')
  assert.equal(fromLLM, '雅琴')
})

test('去重口径一致:带空格的 "60717 / 雅琴" 也能正确归一', () => {
  const fromLLM = normalizeName(stripDatePrefix('60717 / 雅琴'))
  assert.equal(fromLLM, '雅琴')
})

// ---------- 去重场景:维格表已有 → 跳过 ----------

test('事实接管:去重跳过要单独报告(成功 + 跳过)', () => {
  // 模拟:本批识别 3 条,1 条全新(成功),1 条维格表已有(跳过),1 条失败
  const ledger: LedgerEntry[] = [
    { tool: 'record_customer_info', category: 'write', ok: true, summary: '张三', linkKey: 'customer' },
    { tool: 'record_customer_info', category: 'write', ok: false, skipped: true, summary: '雅琴', error: '重复' },
    { tool: 'record_customer_info', category: 'write', ok: false, summary: '', error: '姓名为空' },
  ]
  const out = buildSystemAttestation(ledger)
  assert.ok(out.includes('已登记客资 1 条'), '成功数 1')
  assert.ok(out.includes('「张三」'))
  assert.ok(out.includes('1 条重复已跳过'), '应报告跳过数')
  assert.ok(out.includes('「雅琴」'), '跳过的名字也要列出')
  assert.ok(out.includes('1 条失败'))
})

test('事实接管:本批全部重复 → 明确告知"全部与已有重复"', () => {
  const ledger: LedgerEntry[] = [
    { tool: 'record_customer_info', category: 'write', ok: false, skipped: true, summary: '雅琴', error: '重复' },
    { tool: 'record_customer_info', category: 'write', ok: false, skipped: true, summary: 'KK', error: '重复' },
  ]
  const out = buildSystemAttestation(ledger)
  assert.ok(out.includes('全部与维格表当天已有记录重复'))
  assert.ok(out.includes('「雅琴」'))
  assert.ok(out.includes('「KK」'))
  assert.ok(!out.includes(REAL_CUSTOMER_LINK), '全跳过时绝不贴链接')
})
