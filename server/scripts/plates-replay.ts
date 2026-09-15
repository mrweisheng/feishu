/**
 * 靓号批次手动重放/排障工具:清除今天的已处理标记,重新按口岸出海报。
 *
 * 用法(服务器上):
 *   cd server && npm run plates:replay
 *
 * 常与日志联用排查:npm run deploy:logs
 * 注意:会真的往输出群重新发海报;每跑一次跑一遍完整管线(LLM 提取 + puppeteer 渲染)。
 */
import 'dotenv/config'
import { replayToday } from '../src/services/platesAutomation.js'

replayToday()
  .then(() => {
    console.log('✅ 靓号重放完成')
    process.exit(0)
  })
  .catch((err: any) => {
    console.error('❌ 靓号重放失败:', err?.stack ?? err?.message ?? err)
    process.exit(1)
  })
