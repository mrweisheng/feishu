/**
 * 现牌批次手动重放/排障工具:清除今天的已处理标记与已存候选,重新提取入库(不出图)。
 *
 * 用法(服务器上):
 *   cd server && npm run plates:replay
 *
 * 常与日志联用排查:npm run deploy:logs
 * 注意:会清空当天已存候选并整体重跑一遍(LLM 提取 + 本地入库 + 多维表格同步)。
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
