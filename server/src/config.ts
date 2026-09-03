import 'dotenv/config'
import path from 'node:path'

function required(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`缺少环境变量 ${key},请在 server/.env 中配置(参考 .env.example)`)
  return v
}

export const config = {
  FEISHU_APP_ID: required('FEISHU_APP_ID'),
  FEISHU_APP_SECRET: required('FEISHU_APP_SECRET'),
  PORT: Number(process.env.PORT) || 4111,
  /**
   * 监听网卡。默认只绑本机 —— 公网访问走 nginx 反代(nginx 与服务同机,转发 127.0.0.1 即可),
   * 要直连远程访问才需要显式配 HOST=0.0.0.0(注意:/api/messages 等其余接口无鉴权)。
   */
  HOST: process.env.HOST || '127.0.0.1',
  /**
   * 管理页登录账号(单预设账号,非用户体系)。默认值只为开箱即用,
   * 公网部署务必在 .env 改掉 KB_ADMIN_PASSWORD —— 默认口令启动会打告警。
   */
  KB_ADMIN_USER: process.env.KB_ADMIN_USER || 'shengwei',
  KB_ADMIN_PASSWORD: process.env.KB_ADMIN_PASSWORD || '123456',
  // DB_PATH 相对 server/ 目录(运行时 cwd),解析成绝对路径
  DB_PATH: path.resolve(process.cwd(), process.env.DB_PATH || './data/messages.db'),
  // LLM(Anthropic SDK 兼容端点 → MiniMax)
  ANTHROPIC_BASE_URL: required('ANTHROPIC_BASE_URL'),
  ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),
  LLM_MODEL: process.env.LLM_MODEL || 'MiniMax-M3',

  // 客资多维表格(留空 = 只入 SQLite,跳过飞书表格双写)
  BITABLE_CUSTOMER_APP_TOKEN: process.env.BITABLE_CUSTOMER_APP_TOKEN || '',
  BITABLE_CUSTOMER_TABLE_ID: process.env.BITABLE_CUSTOMER_TABLE_ID || '',
  BITABLE_CUSTOMER_LINK: process.env.BITABLE_CUSTOMER_LINK || '',

  // 提醒重启补偿窗口(毫秒):进程重启后,过期但 < 该窗口的提醒补发,>= 的丢弃。
  // 防止服务挂半天后重启半夜轰炸用户;30min 是体验与打扰的平衡点。
  REMINDER_RESEND_WINDOW_MS: Number(process.env.REMINDER_RESEND_WINDOW_MS) || 30 * 60 * 1000,

  // ---- 知识库(RAG) ----
  // 知识库是独立内容源:只能通过管理页录入(文本/粘贴),与飞书消息归档、客资表完全无关。
  // 嵌入走 OpenAI 兼容的 /v1/embeddings(硅基流动 BAAI/bge-m3:1024 维、8192 token、L2 归一化)。
  KB_ENABLED: (process.env.KB_ENABLED ?? '1') !== '0',
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1',
  EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || '',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
  /** 维度必须和模型实际输出一致,启动时自检会校验;不一致不拒绝启动,而是降级为纯关键词检索并告警 */
  EMBEDDING_DIM: Number(process.env.EMBEDDING_DIM) || 1024,
  /** 单个 chunk 的目标字符数(中文约 1 字 ≈ 0.6~1 token,400 字远低于 8192 上限,语义更聚焦) */
  KB_CHUNK_SIZE: Number(process.env.KB_CHUNK_SIZE) || 400,
  /** 相邻 chunk 重叠字符数,避免句子被切断导致语义丢失 */
  KB_CHUNK_OVERLAP: Number(process.env.KB_CHUNK_OVERLAP) || 60,
  /** 嵌入请求并发上限。免费档有固定 RPM/TPM 限流,并发开大只会吃 429 */
  KB_EMBED_CONCURRENCY: Number(process.env.KB_EMBED_CONCURRENCY) || 2,
  /** 检索时向量/BM25 各召回多少条,再做 RRF 融合 */
  KB_SEARCH_CANDIDATES: Number(process.env.KB_SEARCH_CANDIDATES) || 20,
  /** 融合后最终返回给 LLM 的条数 */
  KB_SEARCH_TOP_K: Number(process.env.KB_SEARCH_TOP_K) || 5,
}
