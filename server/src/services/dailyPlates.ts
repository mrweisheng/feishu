/**
 * 靓号打分与选号(纯函数,确定性,可单测)。
 *
 * 号码的「靚度」按港人拣牌逻辑打分成确定性规则:豹子/连叠、顺子、一路發、尾叠加分,
 * 含 4、弱尾(3/7/5/1/0)减分。选号与问答里的「每个口岸挑一些」都基于同一套打分,
 * 保证同一批数据每次得到一样的排序、可复现。
 *
 * 注:模板渲染(海报出图)与打码逻辑已随「不做图」下线,本模块不再依赖 config / 模板目录 / puppeteer。
 */

export interface PlatePick {
  /** 号牌前缀,如「粤Z」 */
  region: string
  /** 号牌主体,如「JS75」 */
  number: string
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
 * 仍用于多维表格「是否今日精選」列的打勾,以及默认展示。
 */
export function pickBestPlates(plates: { region: string; number: string }[]): [PlatePick, PlatePick] | null {
  if (plates.length < 2) return null
  const sorted = [...plates].sort((a, b) => scorePlateNumber(b.number) - scorePlateNumber(a.number))
  return [
    { region: sorted[0].region, number: sorted[0].number },
    { region: sorted[1].region, number: sorted[1].number },
  ]
}

/**
 * 取分数最高的前 n 个号码(用于问答「今天有哪些靓号 → 每个口岸挑一些出来」)。
 * 返回号码主体(如 9E66),展示格式由调用方按需拼装。
 */
export function pickTopPlates(plates: { number: string }[], n: number): string[] {
  return [...plates]
    .sort((a, b) => scorePlateNumber(b.number) - scorePlateNumber(a.number))
    .slice(0, Math.max(0, n))
    .map((p) => p.number)
}

/** 北京时间当天的 YYYY-MM-DD(一律取当天,与素材里的日期无关) */
export function todayDateKey(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
}
