import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

/**
 * 管理端登录鉴权 —— 单预设账号,不是用户体系。
 *
 * 设计取舍(为什么不用 session 表 / JWT 库):
 * - 只有一个账号,不需要注册/角色/多用户,引库是杀鸡用牛刀
 * - 会话 = 无状态 HMAC 签名 cookie(`用户名.过期时间.签名`):
 *   · 密钥由「飞书 app secret + 账号 + 口令」派生 → 改口令即时全端下线,进程重启不掉线
 *   · 不落库、零迁移,和这个项目的「零额外依赖」风格一致
 * - 所有比较走 sha256 定长摘要 + timingSafeEqual,防逐字符计时攻击
 * - 登录失败按 IP 限流(内存计数),防公网在线爆破默认弱口令
 */

/** 会话 cookie 名 */
export const SESSION_COOKIE_NAME = 'kb_session'
/** 会话有效期:7 天(同事存个书签天天用,别让人天天登录) */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

/**
 * 会话签名密钥。从既有服务端密钥派生而不是随机生成:
 * 随机密钥重启即全端掉线(tsx watch 开发期尤其烦),派生密钥稳定且换口令自动失效。
 */
function sessionSecret(): Buffer {
  return sha256(`kb-admin-session|${config.FEISHU_APP_SECRET}|${config.KB_ADMIN_USER}|${config.KB_ADMIN_PASSWORD}`)
}

/**
 * 校验账号口令。用户名和口令拼一起做摘要再比较:
 * 不区分「用户名错」还是「口令错」(响应统一「账号或密码不正确」),不给枚举线索。
 */
export function verifyCredentials(username: string, password: string): boolean {
  return timingSafeEqual(sha256(`${username}\n${password}`), sha256(`${config.KB_ADMIN_USER}\n${config.KB_ADMIN_PASSWORD}`))
}

/** 签发会话 token:`用户名.过期毫秒.HMAC`。ttlMs 参数仅供测试注入负值,业务别传。 */
export function signSession(username: string, ttlMs: number = SESSION_TTL_MS): string {
  const exp = Date.now() + ttlMs
  const payload = `${username}.${exp}`
  const sig = createHmac('sha256', sessionSecret()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** 校验会话 token:格式 → 过期 → 签名 → 用户名仍匹配(改名后旧会话立即作废)。 */
export function verifySession(token: string | undefined | null): { ok: boolean; username?: string } {
  if (!token) return { ok: false }
  const lastDot = token.lastIndexOf('.')
  const secondLastDot = lastDot > 0 ? token.lastIndexOf('.', lastDot - 1) : -1
  if (secondLastDot < 0) return { ok: false }

  const username = token.slice(0, secondLastDot)
  const expStr = token.slice(secondLastDot + 1, lastDot)
  const sig = token.slice(lastDot + 1)
  if (!/^\d+$/.test(expStr)) return { ok: false }
  if (Number(expStr) < Date.now()) return { ok: false }
  if (username !== config.KB_ADMIN_USER) return { ok: false }

  const expected = createHmac('sha256', sessionSecret()).update(`${username}.${expStr}`).digest('base64url')
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false }
  }
  return { ok: true, username }
}

/** 登录成功后下发的 Set-Cookie 值 */
export function sessionCookie(token: string): string {
  // 不加 Secure:nginx 终止 TLS 后走内网 HTTP 到 node,加 Secure 会把本机 http 调试也废掉;
  // HttpOnly + SameSite=Lax 已挡住脚本读取与跨站 POST(CSRF)
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

/** 退出登录下发的 Set-Cookie 值(即刻过期) */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

// ---------------------------------------------------------------- 登录限流(内存,单进程足够)

/**
 * 公网下默认口令(123456)会被脚本爆破,按 IP 记失败次数:
 * 连错 5 次锁 2 分钟。内存实现 —— 单实例常驻进程(项目硬约束),重启清零可接受。
 */
const MAX_FAILURES = 5
const LOCK_MS = 2 * 60 * 1000
const failures = new Map<string, { count: number; lockedUntil: number }>()

export function loginLockedFor(ip: string): boolean {
  const rec = failures.get(ip)
  if (!rec) return false
  if (rec.lockedUntil > Date.now()) return true
  if (rec.lockedUntil > 0 && rec.lockedUntil <= Date.now()) failures.delete(ip) // 锁过期,清掉
  return false
}

export function recordLoginFailure(ip: string): void {
  const rec = failures.get(ip) ?? { count: 0, lockedUntil: 0 }
  rec.count += 1
  if (rec.count >= MAX_FAILURES) {
    rec.lockedUntil = Date.now() + LOCK_MS
    rec.count = 0 // 锁完重新计数,解锁后再给 5 次机会
  }
  failures.set(ip, rec)
  // 防内存膨胀:超 1000 条时顺手清掉已解锁的陈年记录
  if (failures.size > 1000) {
    const now = Date.now()
    for (const [k, v] of failures) if (v.lockedUntil <= now) failures.delete(k)
  }
}

export function clearLoginFailures(ip: string): void {
  failures.delete(ip)
}
