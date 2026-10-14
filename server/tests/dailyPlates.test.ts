import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestPlates, pickTopPlates, scorePlateNumber, todayDateKey } from '../src/services/dailyPlates.js'

// ---- scorePlateNumber:靓度打分(代码规则,不靠模型) ----

test('选号:豹子/尾8 最靚,含 4 大减分', () => {
  assert.ok(scorePlateNumber('888') > scorePlateNumber('886'))
  assert.ok(scorePlateNumber('1688') > scorePlateNumber('1689'))
  assert.ok(scorePlateNumber('1238') > scorePlateNumber('1248'))
  assert.ok(scorePlateNumber('8888') < 0 || scorePlateNumber('1234') < 0)
  assert.ok(scorePlateNumber('1234') < scorePlateNumber('1235'))
})

// ---- pickBestPlates:确定性选号(前二,稳定可复现) ----

test('选号:从 17 个候选里稳定挑出前二', () => {
  const list = [
    { region: '粤Z', number: 'Z9W53' }, { region: '粤Z', number: 'ZKR52' },
    { region: '粤Z', number: 'Z5V35' }, { region: '粤Z', number: 'Z9Y83' },
    { region: '粤Z', number: 'Z9W62' }, { region: '粤Z', number: 'Z9F79' },
    { region: '粤Z', number: 'Z9J79' }, { region: '粤Z', number: 'Z5E25' },
    { region: '粤Z', number: 'Z9G26' }, { region: '粤Z', number: 'ZJS75' },
    { region: '粤Z', number: 'Z6A03' }, { region: '粤Z', number: 'ZH65' },
    { region: '粤Z', number: 'ZKH53' }, { region: '粤Z', number: 'Z5W05' },
    { region: '粤Z', number: 'Z5E00' }, { region: '粤Z', number: 'Z9F38' },
    { region: '粤Z', number: 'Z9G26' },
  ]
  const picks = pickBestPlates(list)!
  assert.equal(picks.length, 2)
  const nums = picks.map((p) => p.number)
  assert.ok(nums.includes('Z5E00'), `应选中 Z5E00,实际 ${nums}`)
})

test('选号:候选不足 2 个返回 null', () => {
  assert.equal(pickBestPlates([{ region: '粤Z', number: 'Z5E00' }]), null)
  assert.equal(pickBestPlates([]), null)
})

// ---- pickTopPlates:问答「每个口岸挑一些」 ----

test('pickTopPlates:按分排序取前 n,不足则全取,n<=0 返回空', () => {
  const list = [{ number: '8888' }, { number: '4412' }, { number: '1234' }, { number: '9E66' }]
  const top2 = pickTopPlates(list, 2)
  assert.equal(top2.length, 2)
  assert.ok(!top2.includes('4412'), `含 4 的号不应进前二:${top2}`)
  assert.deepEqual(pickTopPlates(list, 0), [])
  assert.equal(pickTopPlates([{ number: '12' }], 5).length, 1)
})

// ---- todayDateKey:固定北京时间 ----

test('todayDateKey:返回 YYYY-MM-DD(北京时间)', () => {
  assert.match(todayDateKey(), /^\d{4}-\d{2}-\d{2}$/)
})
