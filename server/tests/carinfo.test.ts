/**
 * 车源检索(carinfo)纯函数单测:卡片格式化 / 图片截取 / limit 收敛 / post 构造。
 * 不打真实 API、不启动服务 —— 只锁死给用户看的卡片文案行为:
 * 缺字段不漏 undefined、图片永远 ≤6 张、@提问人在首行、链接只来自真实数据。
 *
 * 运行:npm test(或单跑:node --test --import tsx tests/carinfo.test.ts)
 *
 * 注意:carinfo.ts 顶部 import config.ts(校验 .env 环境变量会抛错)和
 * feishu/messages.ts(构造 SDK client,无副作用、不连长连接),
 * 所以沿用 toolRegistry.test.ts 的模式:先注入测试环境变量再动态 import。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.FEISHU_APP_ID = 'test'
process.env.FEISHU_APP_SECRET = 'test'
process.env.ANTHROPIC_BASE_URL = 'http://localhost'
process.env.ANTHROPIC_API_KEY = 'test'

const {
  clampLimit,
  pickImageUrls,
  formatCarCardLines,
  buildCarPostContent,
  truncateText,
  MAX_IMAGES_PER_CAR,
} = await import('../src/services/carinfo.js')

// ---- clampLimit:LLM 传什么都收敛到 [1, max] ----

test('clampLimit:默认 3、越界收敛、脏值兜底', () => {
  assert.equal(clampLimit(undefined, 3), 3)
  assert.equal(clampLimit(1, 3), 1)
  assert.equal(clampLimit(99, 3), 3)
  assert.equal(clampLimit(0, 3), 1)
  assert.equal(clampLimit(-5, 3), 1)
  assert.equal(clampLimit('2', 3), 2) // LLM 偶尔传字符串数字
  assert.equal(clampLimit(null, 3), 3)
  assert.equal(clampLimit('abc', 3), 3)
  assert.equal(clampLimit(2.9, 3), 2) // 小数截断
})

// ---- pickImageUrls:前 6 张 + 封面兜底 ----

test('pickImageUrls:详情图超 6 张只取前 6', () => {
  const urls = Array.from({ length: 10 }, (_, i) => `https://img.example/${i}.jpg`)
  const picked = pickImageUrls(urls, 'https://img.example/cover.jpg')
  assert.equal(picked.length, 6)
  assert.equal(picked[0], 'https://img.example/0.jpg')
  assert.equal(MAX_IMAGES_PER_CAR, 6)
})

test('pickImageUrls:详情没图兜底封面单张;都没就空;非 http 脏数据剔除', () => {
  assert.deepEqual(pickImageUrls(null, 'https://img.example/cover.jpg'), ['https://img.example/cover.jpg'])
  assert.deepEqual(pickImageUrls([], null), [])
  assert.deepEqual(pickImageUrls(undefined, undefined), [])
  assert.deepEqual(pickImageUrls(['not-a-url', 'https://ok.example/a.jpg'], null), ['https://ok.example/a.jpg'])
})

// ---- formatCarCardLines:卡片文案 ----

const FULL_ITEM = {
  vehicle_id: 's2773218',
  car_model: 'ALPHARD 8',
  year: 2022,
  price_text: 'HK$23.9 萬',
  price_verdict: '比同款行情低 40%',
  labels: ['划算 40%', '刚挂牌', '一手车'],
  seats: '8 座位',
  engine_volume: '2500cc',
  mileage_km: 52000,
  age_days: 2,
  hand_count: 0,
  view_count: 1179,
  import_type: '行貨',
  license_until: '26年12月',
  china_plate: true,
  is_swap: false,
  market_basis: '同款 2020-2024 年段中位价 HK$39.9 萬(853 台)',
  market_ref_n: 853,
  car_url: 'https://www.28car.com/sell_dsp.php?h_vid=665579762',
}

test('formatCarCardLines:全字段卡片包含关键信息,不出现 undefined/null 字样', () => {
  const lines = formatCarCardLines(FULL_ITEM, {
    vehicle_id: 's2773218',
    transmission: '自動波 AT',
    fuel_type: '汽油',
    description: '罕有八座位、未出牌、三電動門、真皮座椅',
  })
  const text = lines.join('\n')
  assert.ok(text.includes('ALPHARD 8'))
  assert.ok(text.includes('一手'))
  assert.ok(text.includes('HK$23.9 萬'))
  assert.ok(text.includes('比同款行情低 40%'))
  assert.ok(text.includes('划算 40% · 刚挂牌 · 一手车'))
  assert.ok(text.includes('自動波 AT'))
  assert.ok(text.includes('5.2萬公里'))
  assert.ok(text.includes('挂牌 2 天'))
  // labels 里已带「浏览 1179 次」时,使用状况行不得再重复拼一次
  assert.equal((text.match(/浏览 1179 次/g) ?? []).length, 1)
  assert.ok(text.includes('牌費至 26年12月'))
  assert.ok(text.includes('中港牌'))
  assert.ok(text.includes('853 台'))
  assert.ok(text.includes('罕有八座位'))
  assert.ok(!text.includes('换车帖'), 'is_swap=false 不应出现换车帖')
  for (const line of lines) {
    assert.ok(!/undefined|null|NaN/.test(line), `卡片行出现脏值:${line}`)
  }
})

test('formatCarCardLines:几乎全空的条目也不漏 undefined,且不产生空 emoji 行', () => {
  const lines = formatCarCardLines(
    { vehicle_id: 'x', car_model: 'SOME CAR' },
    null,
  )
  const text = lines.join('\n')
  assert.ok(text.includes('SOME CAR'))
  assert.ok(text.includes('价格待询'), '无价格时显示待询而不是空白')
  for (const line of lines) {
    assert.ok(!/undefined|null|NaN/.test(line), `空条目出现脏值:${line}`)
    assert.ok(line.replace(/^\S+\s*/, '').trim().length > 0, `疑似空行:${line}`)
  }
})

test('formatCarCardLines:labels 无浏览数时使用状况行补上,防信息丢失', () => {
  const lines = formatCarCardLines(
    { ...FULL_ITEM, labels: ['划算 40%', '一手车'] },
    null,
  )
  assert.ok(lines.join('\n').includes('浏览 1179 次'))
})

test('formatCarCardLines:labels 带行貨/中港牌时配置行与extras行不再重复拼', () => {
  // 服务端实际会出现 labels:['刚挂牌','一手车','行貨','中港牌','浏览 11856 次']
  const lines = formatCarCardLines(
    { ...FULL_ITEM, labels: ['刚挂牌', '一手车', '行貨', '中港牌', '浏览 11856 次'], view_count: 11856 },
    { vehicle_id: FULL_ITEM.vehicle_id, transmission: '自動波 AT', fuel_type: '汽油' },
  )
  const text = lines.join('\n')
  assert.equal((text.match(/行貨/g) ?? []).length, 1, '行貨只应出现一次(labels)')
  assert.equal((text.match(/中港牌/g) ?? []).length, 1, '中港牌只应出现一次(labels)')
  assert.equal((text.match(/浏览 11856 次/g) ?? []).length, 1, '浏览数只应出现一次(labels)')
  // 牌費、里程、比价这些 labels 没有的信息仍然保留
  assert.ok(text.includes('牌費至 26年12月'))
  assert.ok(text.includes('5.2萬公里'))
  assert.ok(text.includes('比同款行情低 40%'))
})

test('formatCarCardLines:age_days=0 显示今天刚上;里程空不显示;行情样本少降调', () => {
  const lines = formatCarCardLines(
    { ...FULL_ITEM, age_days: 0, mileage_km: null, market_ref_n: 5, market_basis: '全年代中位 HK$30 萬(5 台)' },
    null,
  )
  const text = lines.join('\n')
  assert.ok(text.includes('今天刚上'))
  assert.ok(!text.includes('萬公里'))
  assert.ok(text.includes('样本较少,仅供参考'))
})

test('formatCarCardLines:detail 缺失时比价结论降级用搜索条目自带字段', () => {
  const lines = formatCarCardLines(FULL_ITEM, null)
  assert.ok(lines.join('\n').includes('比同款行情低 40%'))
})

test('truncateText:超长截断加省略号,不超原样', () => {
  assert.equal(truncateText('abc', 5), 'abc')
  assert.equal(truncateText('abcdef', 5), 'abcde…')
})

// ---- buildCarPostContent:post 富文本形状 ----

test('buildCarPostContent:首段 @提问人+标题,卡片逐行一段,链接来自真实 car_url,图片每张一段', () => {
  const lines = formatCarCardLines(FULL_ITEM, { vehicle_id: 's2773218', transmission: '自動波', fuel_type: '汽油' })
  const content = buildCarPostContent('ou_123', lines, FULL_ITEM.car_url, ['img_key_1', 'img_key_2'])
  const paras = content.zh_cn.content
  assert.ok(Array.isArray(paras))
  // 首段:@ + 标题行
  assert.equal(paras[0][0].tag, 'at')
  assert.equal((paras[0][0] as any).user_id, 'ou_123')
  assert.equal(paras[0][1].tag, 'text')
  assert.match(paras[0][1].text, /ALPHARD 8/)
  // 中间:每行卡片一段
  assert.equal(paras.length, 1 + (lines.length - 1) + 1 + 2)
  // 链接段:href 必须等于真实 car_url(不是 LLM 编的)
  const linkPara = paras[1 + lines.length - 1]
  assert.equal(linkPara[1].tag, 'a')
  assert.equal((linkPara[1] as any).href, FULL_ITEM.car_url)
  // 图片段
  assert.deepEqual(
    paras.slice(-2).map((p: any) => p[0].image_key),
    ['img_key_1', 'img_key_2'],
  )
})

test('buildCarPostContent:无链接无图片时只剩 @+卡片行,不出空段', () => {
  const content = buildCarPostContent('ou_123', ['🚗 只有标题'], null, [])
  const paras = content.zh_cn.content
  assert.equal(paras.length, 1)
  assert.equal(paras[0][0].tag, 'at')
})
