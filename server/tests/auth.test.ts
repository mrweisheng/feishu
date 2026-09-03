/**
 * 管理端登录鉴权纯函数单测:凭证校验 / 会话签名 / 过期 / 篡改 / 改名失效。
 *
 * auth.ts 顶部 import config.ts(缺必填项会抛错),所以沿用 toolRegistry.test.ts 的套路:
 * 先注入测试环境变量,再动态 import。密码学函数零 IO,跑得飞快。
 */
process.env.FEISHU_APP_ID = 'test-app-id'
process.env.FEISHU_APP_SECRET = 'test-app-secret'
process.env.ANTHROPIC_BASE_URL = 'https://test.example'
process.env.ANTHROPIC_API_KEY = 'test-key'
process.env.KB_ADMIN_USER = 'shengwei'
process.env.KB_ADMIN_PASSWORD = 'test-password-123'

const { verifyCredentials, signSession, verifySession, SESSION_COOKIE_NAME } = await import('../src/services/auth.js')

import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------- verifyCredentials

test('verifyCredentials:账号口令全对才通过', () => {
  assert.equal(verifyCredentials('shengwei', 'test-password-123'), true)
  assert.equal(verifyCredentials('shengwei', 'wrong'), false)
  assert.equal(verifyCredentials('other', 'test-password-123'), false)
  assert.equal(verifyCredentials('', ''), false)
})

test('verifyCredentials:大小写敏感,不做 trim 之外的原谅', () => {
  assert.equal(verifyCredentials('Shengwei', 'test-password-123'), false)
  // 尾随空格的口令不该通过
  assert.equal(verifyCredentials('shengwei', 'test-password-123 '), false)
})

// ---------------------------------------------------------------- signSession / verifySession

test('signSession → verifySession 往返通过,且带出用户名', () => {
  const token = signSession('shengwei')
  const s = verifySession(token)
  assert.equal(s.ok, true)
  assert.equal(s.username, 'shengwei')
})

test('verifySession:空 / 乱格式 token 拒绝', () => {
  assert.equal(verifySession(undefined).ok, false)
  assert.equal(verifySession(null).ok, false)
  assert.equal(verifySession('').ok, false)
  assert.equal(verifySession('abc').ok, false)
  assert.equal(verifySession('a.b').ok, false)
  assert.equal(verifySession('user.notanumber.sig').ok, false)
})

test('verifySession:过期会话拒绝(ttl 传负值模拟过去签发的 token)', () => {
  const token = signSession('shengwei', -1000)
  assert.equal(verifySession(token).ok, false)
})

test('verifySession:篡改签名 / 篡改用户名 / 篡改过期时间一律拒绝', () => {
  const token = signSession('shengwei')
  const [user, exp] = token.split('.')
  // 签名换成垃圾
  assert.equal(verifySession(`${user}.${exp}.AAAA`).ok, false)
  // 用户名换掉(签名对不上)
  assert.equal(verifySession(`hacker.${exp}.${token.split('.')[2]}`).ok, false)
  // 过期时间往未来拨(签名对不上)
  assert.equal(verifySession(`${user}.${Number(exp) + 999999999}.${token.split('.')[2]}`).ok, false)
})

test('verifySession:签名合法但用户名与当前配置不符(改名后旧会话作废)', () => {
  // 用别的用户名签出来的 token 签名是合法的,但配置里只有 shengwei → 必须拒绝
  const token = signSession('someone-else')
  assert.equal(verifySession(token).ok, false)
})

test('cookie 名固定,前后端契约', () => {
  assert.equal(SESSION_COOKIE_NAME, 'kb_session')
})
