/**
 * 现牌文件名 / 口岸解析(纯函数,可单测)。
 *
 * 「每日现牌输出群」里,每个口岸的现牌清单通常发一个文档(偶尔同时配一张同内容的图片),
 * 文件名形如「0915-深圳灣高新現牌-23個.docx」。这里集中处理三件事:
 *   1. 口岸别名归一(简繁/口语写法 → 规范繁体口岸名);
 *   2. 从文件名解析口岸与类型;
 *   3. 文档 ↔ 图片的配对键(去掉扩展名后的文件名主干)。
 *
 * 为什么单独成模块:这些是纯字符串规则,不依赖 config/DB,便于 `node:test` 直接覆盖。
 */

export interface CandidatePlate {
  region: string
  number: string
  port?: string
  note?: string
}

/** 规范口岸集合(海报时代的固定四口岸,现用于输出排序) */
export const CANON_PORTS = ['深圳灣', '蓮塘', '沙頭角', '港珠澳']

/** 口岸别名 → 规范繁体名。键的书写形式要覆盖简/繁/全称。 */
export const PORT_ALIASES: Record<string, string> = {
  '深圳湾': '深圳灣', '深圳灣': '深圳灣',
  '莲塘': '蓮塘', '蓮塘': '蓮塘',
  '沙头角': '沙頭角', '沙頭角': '沙頭角',
  '港珠澳': '港珠澳', '港珠澳大橋': '港珠澳', '港珠澳大桥': '港珠澳',
}

/** 口岸名归一:剥「口岸」后缀 + 查别名表 */
export function normalizePort(name: string): string {
  const bare = name.replace(/口岸$/, '').trim()
  return PORT_ALIASES[bare] ?? bare
}

/** 从文件名解析口岸:如「0915-深圳灣高新現牌-23個.docx」→ 深圳灣 */
export function portFromFileName(name: string): string | null {
  for (const alias of Object.keys(PORT_ALIASES)) {
    if (name.includes(alias)) return PORT_ALIASES[alias]
  }
  return null
}

/** 从文件名解析类型:如「0915-深圳灣高新現牌-23個.docx」→ 高新現牌 */
export function typeFromFileName(name: string, portKey: string): string {
  let t = name
    .replace(/\.[^.]+$/, '') // 去扩展名
    .replace(/^\d{3,4}-/, '') // 去日期前缀
    .replace(new RegExp(portKey, 'g'), '') // 去口岸名
    .replace(/-\d+\s*個.*$/, '') // 去「-23個」尾巴
  t = t.replace(/^[-_\s]+|-[-_\s]+$/g, '').trim()
  return t || '現牌'
}

/**
 * 逐条口岸解析:在原文里定位号码,取其后最近出现的口岸别名(如「9H88港深圳灣」→ 深圳灣)。
 * 找不到回退到模型给的逐条 port;再返回 null 表示归不了口,由调用方丢弃。
 */
export function resolvePlatePort(p: { number: string; port?: string; note?: string }, normText: string): string | null {
  const at = normText.indexOf(p.number)
  if (at >= 0) {
    // 号码往后扫一小段(口岸紧跟在「港」后面,如「9H88港深圳灣」),取偏移最近的别名
    const window = normText.slice(at + p.number.length, at + p.number.length + 12)
    let best: { port: string; offset: number } | null = null
    for (const alias of Object.keys(PORT_ALIASES)) {
      const idx = window.indexOf(alias)
      if (idx >= 0 && (!best || idx < best.offset)) best = { port: PORT_ALIASES[alias], offset: idx }
    }
    if (best) return best.port
  }
  for (const alias of Object.keys(PORT_ALIASES)) {
    if ((p.port ?? '').includes(alias)) return PORT_ALIASES[alias]
  }
  return null
}

/**
 * 文档 ↔ 图片配对键:去掉扩展名后归一(去所有空白 + 转小写)。
 * 现牌群里同一口岸的文档与图片「去掉扩展名之后文件名几乎是相同的」,归一后即可稳定配对。
 */
export function plateStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/\s+/g, '').toLowerCase()
}

const DOC_EXT_RE = /\.(docx|txt|md|csv)$/i
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i

/** 是不是可解析的清单文档(docx/txt/md/csv) */
export function isDocFile(name: string): boolean {
  return DOC_EXT_RE.test(name)
}

/** 是不是图片(png/jpg/webp/gif) */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT_RE.test(name)
}

/** 图片扩展名 → 喂给 LLM 的 media_type(兜底 jpeg) */
export function imageMediaTypeFromName(name: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const l = name.toLowerCase()
  if (l.endsWith('.png')) return 'image/png'
  if (l.endsWith('.gif')) return 'image/gif'
  if (l.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
