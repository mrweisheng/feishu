import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

/**
 * 每日靓号推荐卡片渲染:往 daily_plates_v2 的 HTML 模板里注入当日数据,
 * 用 puppeteer(无头 Chrome)对 .canvas 元素截图,输出 PNG Buffer。
 *
 * 模板是设计稿(4 种风格),DOM 结构约定一致:
 *   .canvas          卡片画布(截图对象)
 *   .kicker          期号线「中港兩地牌 · YYYY.MM.DD」(03 号模板没有这行,跳过)
 *   .port            口岸名(如「蓮塘口岸」)
 *   .en              口岸英文名(仅 01 号模板有,可选)
 *   .plate × 2       车牌,内含 .region / .digits / .suffix
 */

export interface PlatePick {
  /** 号牌前缀,如「粤Z」 */
  region: string
  /** 号牌主体,如「JS75」 */
  number: string
}

/**
 * 号码打码:同行都在发完整号码,用户看到一模一样的号会去比价。
 * 遮码位置不是固定的,而是"遮掉之后,看得见的部分要显得最靚"——
 * 平平无奇的号,遮对一位反而身价倍增(如 4678 → *678 像顺子,881 → 88* 像双八字)。
 *
 * 实现:对每一个候选遮码位置,给"遮码后的可见部分"按港人拣牌逻辑打分,取最高分:
 *   - 大加分:可见部分出现豹子/连叠(888)、尾叠(88/99)、顺子(678)、一路發(168/1688);
 *   - 小加分:可见尾数 8/9/6;
 *   - 减分:可见部分仍含 4(遮掉的那位不算,所以含 4 的号天然倾向遮 4)、可见尾数 3/7 等弱尾;
 *   - 同分时的次序偏好:遮 4 > 遮字母(字母不带吉凶)> 遮靠前的位置。
 */
function visibleScore(masked: string): number {
  const digits = masked.replace(/\*/g, '')
  let score = 0
  if (masked.includes('4')) score -= 800
  if (/(\d)\1\1/.test(masked)) score += 1000 // 豹子/三连
  if (/012|123|234|345|456|567|678|789/.test(masked)) score += 600 // 顺子
  if (/1688|168/.test(masked)) score += 300 // 一路發
  if (/(\d)\1$/.test(digits)) score += 400 // 尾叠(可见数字的尾部)
  const tail = digits.slice(-1)
  score += ({ '8': 150, '9': 100, '6': 80 } as Record<string, number>)[tail] ?? 0
  score -= ({ '3': 100, '7': 60, '5': 20, '1': 10, '0': 10 } as Record<string, number>)[tail] ?? 0
  return score
}

export function maskPlateNumber(number: string): string {
  let best = { idx: -1, masked: '', score: -Infinity }
  for (let i = 0; i < number.length; i++) {
    const chars = number.split('')
    const hidden = chars[i]
    chars[i] = '*'
    const masked = chars.join('')
    let score = visibleScore(masked)
    if (hidden === '4') score += 60 // 同分优先遮 4
    if (/[A-Za-z]/.test(hidden)) score += 30 // 同分优先遮字母
    if (score > best.score) best = { idx: i, masked, score }
  }
  return best.masked
}

export interface DailyPlateCardOptions {
  /** 口岸中文名(不带"口岸"后缀也会自动补),如「蓮塘」 */
  port: string
  /** 口岸英文名(可选,模板不支持该行时自动跳过) */
  portEn?: string
  /** 精选的两个号(顺序即展示顺序,第一个带「特選」章) */
  picks: [PlatePick, PlatePick]
  /** 卡片日期(北京时间 YYYY-MM-DD),由调用方传入当天日期,不取原素材里的日期 */
  dateKey: string
}

// 模板清单(随机选用,4 种风格换着出,避免每天千篇一律)
const TEMPLATE_FILES = [
  'daily_premium_plates_v2_01_onyx.html',
  'daily_premium_plates_v2_02_gallery.html',
  'daily_premium_plates_v2_03_emerald.html',
  'daily_premium_plates_v2_04_express.html',
]

/** 模板目录定位:开发时 cwd=server(模板在仓库根 ../daily_plates_v2),兼容从仓库根启动的情况 */
function findTemplateDir(): string {
  const candidates = [
    path.resolve(process.cwd(), '..', 'daily_plates_v2'),
    path.resolve(process.cwd(), 'daily_plates_v2'),
    // 打包产物在 server/dist,再兜一层 src 路径
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../daily_plates_v2'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, TEMPLATE_FILES[0]))) return dir
  }
  throw new Error(`找不到靓号模板目录 daily_plates_v2(找过: ${candidates.join(', ')})`)
}

/** YYYY-MM-DD → YYYY.MM.DD(模板期号线用的点分格式) */
function dotDate(dateKey: string): string {
  return dateKey.replaceAll('-', '.')
}

/**
 * 模板选择策略(与真实日期无关,只看"北京时间当天"是否为同一天):
 *   - 当天内所有海报固定用同一个模板(当天第一次触发时定下);
 *   - 换天后第一次触发,按 1234 次序循环推进一个(天然不会与上一次相同);
 *   - 历史上第一次使用时随机选一个起点。
 * 状态持久化到 data/ 目录(与 messages.db 同目录),服务重启不打断"当天同模板"的约定。
 */
interface TemplateState {
  dateKey: string
  index: number
}

let templateState: TemplateState | null = null

function templateStateFile(): string {
  return path.join(path.dirname(config.DB_PATH), 'daily-plates-state.json')
}

function loadTemplateState(): TemplateState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(templateStateFile(), 'utf8'))
    if (raw && typeof raw.dateKey === 'string' && Number.isInteger(raw.index)) return raw
  } catch { /* 文件不存在/损坏 → 当作无历史 */ }
  return null
}

function saveTemplateState(state: TemplateState): void {
  try {
    fs.writeFileSync(templateStateFile(), JSON.stringify(state), 'utf8')
  } catch (err: any) {
    // 落盘失败只影响"重启后同天同模板",不影响本次出图,记日志即可
    console.warn('【靓号模板状态落盘失败】', err.message)
  }
}

/** 纯函数:给定今天和上次使用状态,算出本次模板下标(单测覆盖) */
export function nextTemplateIndex(today: string, last: TemplateState | null, count: number): number {
  if (last && last.dateKey === today && last.index >= 0 && last.index < count) return last.index
  if (last && Number.isInteger(last.index) && last.index >= 0 && last.index < count) {
    return (last.index + 1) % count // 换天:按 1234 循环推进,不会与上一次相同
  }
  return Math.floor(Math.random() * count) // 首次使用:随机起点
}

function resolveTemplateIndexForToday(): number {
  const today = todayDateKey()
  if (templateState?.dateKey === today) return templateState.index
  const last = templateState ?? loadTemplateState()
  const index = nextTemplateIndex(today, last, TEMPLATE_FILES.length)
  templateState = { dateKey: today, index }
  saveTemplateState(templateState)
  return index
}

/** 常见口岸英文名兜底表(模板 01 的 .en 行需要;LLM 没传 port_en 时按口岸名查) */
const PORT_EN_MAP: Record<string, string> = {
  '莲塘': 'LIANTANG',
  '蓮塘': 'LIANTANG',
  '深圳湾': 'SHENZHEN BAY',
  '深圳灣': 'SHENZHEN BAY',
  '深圳': 'SHENZHEN BAY',
  '港珠澳': 'HZMB',
  '港珠澳大桥': 'HZMB',
  '港珠澳大橋': 'HZMB',
  '文锦渡': 'MAN KAM TO',
  '文錦渡': 'MAN KAM TO',
  '皇岗': 'HUANGGANG',
  '皇崗': 'HUANGGANG',
  '罗湖': 'LO WU',
  '羅湖': 'LO WU',
  '福田': 'FUTIAN',
  '沙头角': 'SHA TAU KOK',
  '沙頭角': 'SHA TAU KOK',
  '香园围': 'HEUNG YUEN WAI',
  '香園圍': 'HEUNG YUEN WAI',
}

/** 查口岸英文名:优先 LLM 传的,再查字典(口岸名剥掉"口岸"后缀比对) */
function resolvePortEn(port: string, portEn?: string): string | undefined {
  if (portEn?.trim()) return portEn.trim()
  const bare = port.replace(/口岸$/, '')
  return PORT_EN_MAP[bare] ?? PORT_EN_MAP[port]
}

/**
 * 单个号码的"靚度"打分(港人拣牌逻辑,代码确定性执行):
 *   大加分:豹子/三连(888)、顺子(678)、一路發(168/1688)、尾叠(88/99)
 *   小加分:尾 8/9/6;叠字母(BB/AA)、号码短而齐
 *   减分:含 4(每个 -800)、弱尾 3/7/5/1/0
 */
export function scorePlateNumber(number: string): number {
  let s = 0
  const fours = (number.match(/4/g) || []).length
  s -= fours * 800
  if (/(\d)\1\1/.test(number)) s += 1000
  if (/012|123|234|345|456|567|678|789/.test(number)) s += 600
  if (/1688|168/.test(number)) s += 300
  if (/(\d)\1$/.test(number)) s += 400
  if (/([A-Z])\1/i.test(number)) s += 100
  s += ({ '8': 150, '9': 100, '6': 80 } as Record<string, number>)[number.slice(-1)] ?? 0
  s -= ({ '3': 100, '7': 60, '5': 20, '1': 10, '0': 10 } as Record<string, number>)[number.slice(-1)] ?? 0
  s += Math.max(0, (7 - number.length) * 15) // 短而齐更稀有
  return s
}

/**
 * 从候选里挑出最靚的 2 个(确定性,取分最高的两个,稳定可复现)。
 */
export function pickBestPlates(plates: { region: string; number: string; note?: string }[]): [PlatePick, PlatePick] | null {
  if (plates.length < 2) return null
  const sorted = [...plates].sort((a, b) => scorePlateNumber(b.number) - scorePlateNumber(a.number))
  return [
    { region: sorted[0].region, number: sorted[0].number },
    { region: sorted[1].region, number: sorted[1].number },
  ]
}

/** 渲染靓号推荐卡片,返回 PNG Buffer。抛错由调用方兜底(LLM 会收到 ok:false)。 */
export async function renderDailyPlateCard(opts: DailyPlateCardOptions): Promise<Buffer> {
  const dir = findTemplateDir()
  const template = path.join(dir, TEMPLATE_FILES[resolveTemplateIndexForToday()])

  // 懒加载:puppeteer + Chromium 体积大,不在服务启动路径上;每次渲染临时开一个页面
  const { default: puppeteer } = await import('puppeteer')
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1080, height: 1440, deviceScaleFactor: 2 })
    await page.goto(`file://${template.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' })

    // 字体一致性:模板字体栈首选 PingFang HK / Songti TC / Helvetica Neue(苹果/商业字体,服务器没有,
    // Chromium 会退到系统默认字体,导致"排版一致但字形不对")。这里用 @font-face 把字体栈里出现的
    // 家族名统一映射到随仓库分发的 Noto TC 可变字体(daily_plates_v2/fonts/,OFL 协议可分发),
    // 保证 Windows 开发机与 Linux 服务器渲染出完全相同的字形。变量字体覆盖 100-900 全字重。
    const fontsDir = `${dir.replace(/\\/g, '/')}/fonts`
    const fontFace = (families: string[], file: string) =>
      families
        .map(
          (f) =>
            `@font-face{font-family:'${f}';src:url('file://${fontsDir}/${file}');font-weight:100 900;font-display:block;}`,
        )
        .join('')
    await page.addStyleTag({
      content:
        fontFace(['PingFang HK', 'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei'], 'NotoSansTC-VF.ttf') +
        fontFace(['Songti TC', 'Noto Serif TC', 'STSong', 'SimSun'], 'NotoSerifTC-VF.ttf') +
        fontFace(['Helvetica Neue', 'Helvetica', 'Arial'], 'NotoSansTC-VF.ttf'),
    })
    // 等 @font-face 全部加载完成再动 DOM/截图,否则首帧可能用回退字体
    await page.evaluateHandle('document.fonts.ready')

    // 用运行时 new Function 构造页面脚本:tsx/esbuild 会给 TS 源码里的箭头函数注入
    // __name 调试辅助,浏览器上下文没有这个符号,直接传函数会 ReferenceError。
    //
    // 各模板日期/口岸的槽位不同,必须按模板实际 DOM 填,才能 100% 还原设计稿:
    //   01 onyx    日期在 .kicker(带 <i> 菱形装饰):「<i></i>中港兩地牌 · 2026.09.14」;口岸 .port + 英文 .en
    //   02 gallery 日期在 .kicker(纯文字):「中港兩地牌 · 2026.09.14」;口岸 .port
    //   03 emerald 无日期槽位;口岸 .port
    //   04 express 日期在右上 .tag(「2026.09.14<br>DAILY」),.kicker 只有「中港兩地牌」;口岸 .port
    // 共同:两个 .plate 的 .region/.digits/.suffix;.plate 内的 .sep 菱形是独立元素,只改文字不碰结构。
    const fillFn = new Function('o', `
      var portName = o.port.endsWith('口岸') ? o.port : (o.port + '口岸')
      var port = document.querySelector('.port')
      if (port) port.textContent = portName

      // 期号线:保留 <i> 菱形装饰(直接覆盖 textContent 会把装饰元素删掉,破坏设计稿)
      var tag = document.querySelector('.tag')
      var kicker = document.querySelector('.kicker')
      if (tag) {
        // 04 号:日期在右上 tag,期号线只放主题词(与原稿一致,不加日期)
        tag.innerHTML = o.dateDot + '<br>DAILY'
        if (kicker) kicker.innerHTML = kicker.querySelector('i') ? '<i></i>中港兩地牌' : '中港兩地牌'
      } else if (kicker) {
        kicker.innerHTML = kicker.querySelector('i')
          ? '<i></i>中港兩地牌 · ' + o.dateDot
          : '中港兩地牌 · ' + o.dateDot
      }

      // 英文口岸行(仅 01 有;查不到英文就隐藏整行,不留错误文案)
      var en = document.querySelector('.en')
      if (en) {
        if (o.portEn) en.textContent = o.portEn.toUpperCase() + ' · PREMIUM PLATES'
        else en.style.display = 'none'
      }

      // 两个车牌:号码打码展示(防比价),遮码规则见 maskPlateNumber
      const plates = document.querySelectorAll('.plate')
      o.picks.forEach(function (pick, i) {
        var el = plates[i]
        if (!el) return
        ;['region', 'digits', 'suffix'].forEach(function (cls) {
          var n = el.querySelector('.' + cls)
          if (n) n.textContent = cls === 'region' ? pick.region : (cls === 'digits' ? pick.masked : '港')
        })
      })
      // 第三个及以后的车牌(模板里没有,防御性清掉)
      plates.forEach(function (el, i) { if (i >= 2) el.remove() })
    `)
    await page.evaluate(fillFn as (o: unknown) => void, {
      port: opts.port,
      portEn: resolvePortEn(opts.port, opts.portEn) || '',
      dateDot: dotDate(opts.dateKey),
      picks: opts.picks.map((p) => ({ region: p.region, masked: maskPlateNumber(p.number) })),
    })

    const canvas = await page.$('.canvas')
    if (!canvas) throw new Error('模板里找不到 .canvas 元素')
    const raw = Buffer.from(await canvas.screenshot({ type: 'png' }))

    // 2x 截图(2160px 宽)有 5MB+,直接转 JPEG(q88)+ 限宽 1600,体积降到几百 KB,清晰度肉眼无损
    const { default: sharp } = await import('sharp')
    return sharp(raw)
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer()
  } finally {
    await browser.close()
  }
}

/** 北京时间当天的 YYYY-MM-DD(卡片日期一律取发消息当天,与素材里的日期无关) */
export function todayDateKey(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
}
