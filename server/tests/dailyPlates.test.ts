import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTemplateIndex } from '../src/services/dailyPlates.js'

const N = 4

test('当天内复用同一天已选的模板', () => {
  const idx = nextTemplateIndex('2026-09-15', { dateKey: '2026-09-15', index: 2 }, N)
  assert.equal(idx, 2)
})

test('换天按 1234 循环推进,不与上一次相同', () => {
  assert.equal(nextTemplateIndex('2026-09-16', { dateKey: '2026-09-15', index: 0 }, N), 1)
  assert.equal(nextTemplateIndex('2026-09-16', { dateKey: '2026-09-15', index: 1 }, N), 2)
  assert.equal(nextTemplateIndex('2026-09-16', { dateKey: '2026-09-15', index: 2 }, N), 3)
  assert.equal(nextTemplateIndex('2026-09-16', { dateKey: '2026-09-15', index: 3 }, N), 0)
})

test('隔多天也只推进一个(与间隔天数无关)', () => {
  // 1 号用了一次,下次 10 号触发:只看"换天了",推进一个
  assert.equal(nextTemplateIndex('2026-09-10', { dateKey: '2026-09-01', index: 0 }, N), 1)
  assert.equal(nextTemplateIndex('2026-09-10', { dateKey: '2026-09-01', index: 3 }, N), 0)
})

test('历史上第一次使用:随机起点(只断言在合法范围内)', () => {
  for (let i = 0; i < 20; i++) {
    const idx = nextTemplateIndex('2026-09-15', null, N)
    assert.ok(idx >= 0 && idx < N, `随机下标 ${idx} 越界`)
  }
})

test('持久化状态损坏/越界时兜底随机,不崩溃', () => {
  for (let i = 0; i < 20; i++) {
    const idx = nextTemplateIndex('2026-09-15', { dateKey: '2026-09-14', index: 99 }, N)
    assert.ok(idx >= 0 && idx < N, `越界状态兜底失败: ${idx}`)
  }
  assert.equal(nextTemplateIndex('2026-09-15', { dateKey: '2026-09-15', index: 99 }, N) >= 0, true)
})

// ---- maskPlateNumber:海报打码(防比价) ----
import { maskPlateNumber } from '../src/services/dailyPlates.js'

test('打码:遮码位置选"可见部分最靚"的那个', () => {
  // 遮 4 后变顺子:4678 → *678
  assert.equal(maskPlateNumber('4678'), '*678')
  // 遮尾数后像双八:881 → 88*
  assert.equal(maskPlateNumber('881'), '88*')
  // 8F35:遮字母 F,8 頭 5 尾可见
  assert.equal(maskPlateNumber('8F35'), '8*35')
  // 96:遮 6 保留尾 9(9 比 6 更值)
  assert.equal(maskPlateNumber('96'), '9*')
  // 1688:怎么遮都靚,同分取最前 → *688(可见 88 尾叠 + 尾 8)
  assert.equal(maskPlateNumber('1688'), '*688')
})

test('打码:含 4 优先遮 4(同分规则)', () => {
  // 4412:遮任何一个 4 都剩一个 4,但同分时优先遮 4、取最前 → *412
  assert.equal(maskPlateNumber('4412'), '*412')
  // 14 → 1*(遮 4 比遮 1 好:可见部分无 4)
  assert.equal(maskPlateNumber('14'), '1*')
  // JU45:遮 4 后可见 JU5 无忌讳
  assert.equal(maskPlateNumber('JU45'), 'JU*5')
})

// ---- pickBestPlates:确定性选号(代码规则,不靠模型) ----
import { pickBestPlates, scorePlateNumber } from '../src/services/dailyPlates.js'

test('选号:豹子/尾8 最靚,含 4 大减分', () => {
  assert.ok(scorePlateNumber('888') > scorePlateNumber('886'))
  assert.ok(scorePlateNumber('1688') > scorePlateNumber('1689'))
  assert.ok(scorePlateNumber('1238') > scorePlateNumber('1248'))
  assert.ok(scorePlateNumber('8888') < 0 || scorePlateNumber('1234') < 0)
  assert.ok(scorePlateNumber('1234') < scorePlateNumber('1235'))
})

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
  // Z5E00(尾 00/短)与 Z9F79/Z9J79(双 9 尾 9)应为头部;4 无、3 尾的靠后
  const nums = picks.map((p) => p.number)
  assert.ok(nums.includes('Z5E00'), `应选中 Z5E00,实际 ${nums}`)
})
