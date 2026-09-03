/**
 * 检索结果融合(纯函数,不碰数据库)。
 *
 * 独立成文件是为了可测:它原本在 services/knowledge.ts 里,而那个模块 import 会
 * 立刻打开 SQLite 连接并读 config —— 一个纯数学函数不该依赖这些才能跑单测。
 */

/**
 * Reciprocal Rank Fusion:score = Σ 1/(k + rank),k 默认 60。
 * 只用排名、不看原始分数,所以两路召回(cosine 距离 / bm25)的分数不需要归一化。
 */
export function reciprocalRankFusion(rankLists: number[][], k = 60): Map<number, number> {
  const scores = new Map<number, number>()
  for (const list of rankLists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
    })
  }
  return scores
}
