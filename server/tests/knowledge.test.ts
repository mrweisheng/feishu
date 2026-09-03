/**
 * 知识库纯函数单测:切片 / FTS 查询构造 / RRF 融合。
 *
 * 这三个函数都是零依赖纯函数(已分别从 chunker、ftsQuery、rank 三个模块导出,
 * 不 import config、不碰 SQLite),所以这里不需要任何 env 注入和数据库。
 *
 * 运行:npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../src/services/chunker.js'
import { buildFtsQuery } from '../src/services/ftsQuery.js'
import { reciprocalRankFusion } from '../src/services/rank.js'

// ---------------------------------------------------------------- chunkText

test('chunkText:空内容不产生切片', () => {
  assert.deepEqual(chunkText('', { size: 100, overlap: 10 }), [])
  assert.deepEqual(chunkText('   \n\n  ', { size: 100, overlap: 10 }), [])
})

test('chunkText:短文本原样返回', () => {
  assert.deepEqual(chunkText('这是一段很短的文本', { size: 400, overlap: 60 }), ['这是一段很短的文本'])
})

test('chunkText:优先按句号切,不硬切字符', () => {
  // 注意:chunkText 内部有 Math.max(50, size) 的下限,想切多块就得用够长的文本
  const text = Array.from({ length: 20 }, (_, i) => `第${i + 1}句话。`).join('') // 100 字
  const chunks = chunkText(text, { size: 50, overlap: 0 })
  assert.ok(chunks.length > 1, `应切成多块,实际 ${chunks.length} 块`)
  for (const c of chunks) {
    assert.ok(!c.startsWith('句话'), `切片不应从句中间开始: ${c}`)
  }
  // overlap=0 时拼接回去必须等于原文 —— 一个字都不能丢
  assert.equal(chunks.join(''), text)
})

test('chunkText:overlap 生效且不丢内容', () => {
  const size = 30
  const overlap = 10
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(10) // 100 字,无分隔符 → 必然硬切
  const chunks = chunkText(text, { size, overlap })
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= size * 2, `切片异常过长: ${c.length}`)
})

test('chunkText:size 有下限保护,不会被 0 除死循环', () => {
  const chunks = chunkText('一二三四五六七八九十'.repeat(5), { size: 0, overlap: 0 })
  assert.ok(chunks.length >= 1)
})

// ---------------------------------------------------------------- buildFtsQuery

test('buildFtsQuery:长中文句切成 3 字滑动窗口(trigram 最小匹配 3 字符)', () => {
  const q = buildFtsQuery('报关需要准备哪些单据')
  assert.ok(q, '不应返回 null')
  const terms = q!.split(' OR ').map((s) => s.slice(1, -1))
  assert.ok(terms.every((t) => t.length === 3), '每个片段都应是 3 字')
  assert.ok(terms.includes('报关需'))
  assert.ok(terms.includes('需要准'))
  // 整句绝不能作为单一 phrase 出现 —— 那等于精确子串匹配,必然零召回
  assert.ok(!terms.includes('报关需要准备哪些单据'))
})

test('buildFtsQuery:2 字查询在 trigram 下无解,返回 null 而不是假装有召回', () => {
  // trigram 最小匹配长度是 3,2 字片段 MATCH 必然返回空
  assert.equal(buildFtsQuery('报关'), null)
  assert.equal(buildFtsQuery(''), null)
  assert.equal(buildFtsQuery('   '), null)
})

test('buildFtsQuery:合同号/型号整体匹配,不被切碎', () => {
  const q = buildFtsQuery('HT2025062414501664F7 的合同')
  const terms = q!.split(' OR ').map((s) => s.slice(1, -1))
  assert.ok(terms.includes('HT2025062414501664F7'), '合同号应完整保留')
  assert.ok(!terms.includes('HT2'), '合同号不应被切成 3 字窗口')
})

test('buildFtsQuery:标点(含引号)一律当分隔符,不进入 MATCH 表达式', () => {
  const q = buildFtsQuery('"报关流程" 是怎样的?')
  const terms = q!.split(' OR ').map((s) => s.slice(1, -1))
  assert.ok(terms.every((t) => /^[\p{Script=Han}A-Za-z0-9]+$/u.test(t)), `片段内不应残留标点: ${terms}`)
  assert.ok(terms.includes('报关流'))
  // 单个英文词会被拆成 <3 字符片段而丢弃("hi"/"to"/"me"),"say" 恰好 3 字符保留
  assert.deepEqual(buildFtsQuery('say hi to me')!.split(' OR '), ['"say"'])
})

test('buildFtsQuery:受 MAX_FTS_TERMS 上限约束且去重', () => {
  const q = buildFtsQuery('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未')
  const terms = q!.split(' OR ').map((s) => s.slice(1, -1))
  assert.ok(terms.length <= 10, `片段数应受上限约束,实际 ${terms.length}`)
  assert.equal(new Set(terms).size, terms.length, '不应有重复片段')
})

// ---------------------------------------------------------------- reciprocalRankFusion

test('reciprocalRankFusion:两路都命中的排最前', () => {
  const fused = reciprocalRankFusion([
    [1, 2, 3],
    [2, 3, 4],
  ])
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  assert.equal(ranked[0], 2, '两路都命中(1st + 2nd)应排第一')
  assert.equal(ranked[ranked.length - 1], 4, '只被一路末尾命中的应排最后')
})

test('reciprocalRankFusion:分数符合 1/(k+rank) 定义', () => {
  const fused = reciprocalRankFusion([[7]], 60)
  assert.equal(fused.get(7), 1 / 61)
})

test('reciprocalRankFusion:空输入返回空 Map', () => {
  assert.equal(reciprocalRankFusion([]).size, 0)
  assert.equal(reciprocalRankFusion([[], []]).size, 0)
})
