/**
 * FTS5 MATCH 表达式构造(纯函数,不碰数据库)。
 *
 * 独立成文件是为了可测:它原本在 db/knowledgeBase.ts 里,而那个模块 import 会
 * 立刻打开 SQLite 连接 —— 一个纯字符串函数不该依赖 DB 才能跑单测。
 */

/**
 * 把自然语言查询转成 FTS5 MATCH 表达式。
 *
 * ⚠️ trigram 分词器的两条实测约束(不看这两条写出来的查询会静默零召回):
 *   1. 连续汉字串会被当成**一整个 phrase**。「报关需要准备哪些单据」在正文里
 *      没有这串连续字符 → 一条都召回不了,等于精确子串匹配。
 *   2. **最小匹配长度是 3**。2 字片段(「报关」)MATCH 必然返回空。
 *
 * 所以策略是:
 *   - <3 字符:丢弃(留着只会给 BM25 添噪,反正匹配不到)
 *   - 纯汉字且 >=4 字:切成 3 字滑动窗口(步长 1)后 OR —— 命中任意 3 字组合即召回
 *   - 含字母数字(合同号 HT2025...、车型 Alphard、英文术语):整体精确匹配,
 *     切开反而会丢掉精确性,这正是 BM25 相对向量的优势所在
 */
const MAX_FTS_TERMS = 10

export function buildFtsQuery(query: string): string | null {
  const parts = (query || '')
    .split(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+/u)
    .map((s) => s.trim())
    .filter(Boolean)

  const terms: string[] = []
  for (const p of parts) {
    if (p.length < 3) continue // 见上:trigram 匹配不到
    if (/[A-Za-z0-9]/.test(p)) {
      terms.push(p) // 合同号/型号/英文:整体精确匹配
      continue
    }
    if (p.length === 3) {
      terms.push(p)
      continue
    }
    for (let i = 0; i < p.length - 2; i++) terms.push(p.slice(i, i + 3))
  }

  const uniq = [...new Set(terms)].slice(0, MAX_FTS_TERMS)
  if (!uniq.length) return null
  return uniq.map((p) => `"${p.replace(/"/g, '""')}"`).join(' OR ')
}
