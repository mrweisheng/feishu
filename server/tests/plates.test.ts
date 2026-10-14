import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  plateStem,
  portFromFileName,
  typeFromFileName,
  isDocFile,
  isImageFile,
  normalizePort,
} from '../src/services/platesNaming.js'
import { extractContains, findPort, buildPlatesAnswer, type PlateRecord } from '../src/services/platesAnswer.js'

// ---- 文件名解析 / 文档↔图片配对 ----

test('plateStem:同一口岸的文档与图片配对键一致(去扩展名/空白/大小写)', () => {
  const doc = '0915-深圳灣高新現牌-23個.docx'
  const img = '0915-深圳灣高新現牌-23個.png'
  assert.equal(plateStem(doc), plateStem(img))
  assert.equal(plateStem('A.PNG'), plateStem('a.png'))
})

test('portFromFileName / typeFromFileName:从文件名解析口岸与类型', () => {
  const n = '0915-深圳灣高新現牌-23個.docx'
  assert.equal(portFromFileName(n), '深圳灣')
  assert.equal(typeFromFileName(n, '深圳灣'), '高新現牌')
  assert.equal(portFromFileName('0915-莲塘纳税現牌-12個.docx'), '蓮塘')
  assert.equal(portFromFileName('补充资料.docx'), null)
})

test('normalizePort:剥「口岸」后缀 + 简繁归一', () => {
  assert.equal(normalizePort('深圳湾口岸'), '深圳灣')
  assert.equal(normalizePort('蓮塘'), '蓮塘')
})

test('isDocFile / isImageFile:扩展名判定', () => {
  assert.equal(isDocFile('a.docx'), true)
  assert.equal(isDocFile('a.txt'), true)
  assert.equal(isDocFile('a.png'), false)
  assert.equal(isImageFile('a.PNG'), true)
  assert.equal(isImageFile('a.docx'), false)
})

// ---- 提问解析 ----

test('findPort:认简繁/口语口岸别名', () => {
  assert.equal(findPort('深圳湾口岸带数字6的号码有么?'), '深圳灣')
  assert.equal(findPort('蓮塘今天有多少个牌'), '蓮塘')
  assert.equal(findPort('今天有哪些靓号'), null)
})

test('extractContains:剥掉日期后取最长数字串', () => {
  assert.equal(extractContains('深圳湾口岸带数字6的号码有么?'), '6')
  assert.equal(extractContains('有没有包含888的靓号'), '888')
  assert.equal(extractContains('8月15号带数字6的号码'), '6')
  assert.equal(extractContains('今天有哪些靓号'), null)
  assert.equal(extractContains('哪个口岸今天有多少个牌'), null)
})

// ---- 答案拼装 ----

const ROWS: PlateRecord[] = [
  { port: '深圳灣', number: '9E66' },
  { port: '深圳灣', number: '8F88' },
  { port: '深圳灣', number: '1A20' },
  { port: '蓮塘', number: '6B12' },
  { port: '蓮塘', number: '5C33' },
]
const DATE = '2026-10-14'

test('概览:今天有哪些靓号 → 每个口岸挑几个', () => {
  const a = buildPlatesAnswer('今天有哪些靓号', DATE, ROWS)
  assert.ok(a.includes('深圳灣'), a)
  assert.ok(a.includes('粤Z9E66港'), a)
  assert.ok(a.includes('10-14'), a)
})

test('计数:哪个口岸今天有多少个牌 → 逐口岸数量', () => {
  const a = buildPlatesAnswer('哪个口岸今天有多少个牌', DATE, ROWS)
  assert.ok(a.includes('深圳灣:3'), a)
  assert.ok(a.includes('蓮塘:2'), a)
})

test('检索(口岸+数字):深圳湾口岸带数字6的号码有么?', () => {
  const a = buildPlatesAnswer('深圳湾口岸带数字6的号码有么?', DATE, ROWS)
  assert.ok(a.includes('粤Z9E66港'), a) // 深圳灣 里含 6 的只有 9E66
  assert.ok(!a.includes('6B12'), a) // 蓮塘的 6B12 不应出现(口岸已过滤)
  assert.ok(a.includes('1 个'), a)
})

test('检索:没有命中时如实说没有', () => {
  const a = buildPlatesAnswer('有没有包含7的靓号', DATE, ROWS)
  assert.ok(a.includes('没有包含'), a)
})

test('空数据:明确说没有数据,不编', () => {
  assert.ok(buildPlatesAnswer('今天有哪些靓号', DATE, []).includes('没有现牌数据'))
})
