import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { config } from '../config.js'
import { initKnowledgeBase } from './knowledgeBase.js'

// 单例连接:WAL 模式,并发读写更稳。全模块共享同一个 db 句柄。
export const db = new Database(config.DB_PATH)
db.pragma('journal_mode = WAL')

/**
 * 加载 sqlite-vec 向量扩展(知识库用)。
 *
 * ⚠️ sqlite-vec 是 pre-v1(0.1.x),官方明确警告会有 breaking change,所以:
 *   - 加载失败**绝不能拖垮整个服务** → 降级为「关键词检索可用、向量检索不可用」
 *   - vec_chunks 表定位为**派生数据**(见 db/knowledgeBase.ts):最坏情况 DROP 重建即可,
 *     正文(kb_chunks)和 FTS5 索引不受影响,知识库不会丢内容
 */
export const vecAvailable: boolean = ((): boolean => {
  if (!config.KB_ENABLED) {
    console.log('ℹ️ 知识库已关闭(KB_ENABLED=0),跳过 sqlite-vec 加载')
    return false
  }
  try {
    sqliteVec.load(db)
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string }
    console.log(`✅ sqlite-vec 已加载: ${row.v}`)
    return true
  } catch (err: any) {
    console.error(
      '⚠️ sqlite-vec 加载失败,向量检索不可用,知识库将降级为纯关键词检索。',
      '正文与 FTS5 索引不受影响。原因:',
      err.message
    )
    return false
  }
})()

// ---- 建表 ----
db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,        -- 飞书消息ID,去重主键
  chat_id         TEXT NOT NULL,           -- 会话/群ID
  chat_type       TEXT,                    -- p2p | group
  message_type    TEXT,                    -- text | post | image | ...
  sender_open_id  TEXT,
  sender_user_id  TEXT,
  sender_union_id TEXT,
  sender_type     TEXT,                    -- user | app ...
  sender_name     TEXT,                    -- 冗余存名字,省得每次联表
  root_id         TEXT,                    -- 话题根消息ID
  parent_id       TEXT,                    -- 被回复消息ID
  content         TEXT,                    -- 原始 content JSON 字符串
  raw_data        TEXT,                    -- 完整事件 JSON 兜底
  create_time     INTEGER,                 -- 消息发送时间(毫秒)
  received_at     INTEGER,                 -- 入库时间(毫秒)
  source          TEXT NOT NULL,           -- realtime | history
  is_bot          INTEGER DEFAULT 0,       -- 1=机器人/app 发的;实时事件 sender_type='bot',历史 API sender_type='app'
  is_recalled     INTEGER DEFAULT 0,
  updated_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chat_time   ON messages(chat_id, create_time);
CREATE INDEX IF NOT EXISTS idx_sender      ON messages(sender_open_id);
CREATE INDEX IF NOT EXISTS idx_create_time ON messages(create_time);
CREATE INDEX IF NOT EXISTS idx_source      ON messages(source);

CREATE TABLE IF NOT EXISTS mentions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL,
  mention_key TEXT,                        -- content 里的占位符 @_user_1
  open_id     TEXT,
  user_id     TEXT,
  union_id    TEXT,
  name        TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_msg    ON mentions(message_id);
CREATE INDEX IF NOT EXISTS idx_mentions_openid ON mentions(open_id);

CREATE TABLE IF NOT EXISTS reminders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             TEXT NOT NULL,                  -- 群ID(便于排查)
  user_open_id        TEXT NOT NULL,                  -- @谁
  content             TEXT NOT NULL,                  -- 提醒内容
  remind_at           INTEGER NOT NULL,               -- 触发时间(毫秒)
  original_message_id TEXT NOT NULL,                  -- 设提醒的原消息ID,到点reply它
  created_at          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' -- pending | sent | expired
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at, status);

-- 客资登记(飞书「客资信息登记表」的事实源;双写时飞书表格是副本)
CREATE TABLE IF NOT EXISTS customer_leads (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name       TEXT,                          -- 客户姓名(同步 bitable「客户名称」列)
  customer_wechat     TEXT,                          -- 客户微信 ID/账号
  customer_needs      TEXT,                          -- 客户需求
  customer_notes      TEXT,                          -- 客户备注(仅存 SQLite,不同步表格)
  is_key_customer     INTEGER DEFAULT 0,             -- 是否是重点客户(0/1)
  visited_store       INTEGER DEFAULT 0,             -- 是否到店(0/1)
  owner_open_id       TEXT,                          -- 归属人 open_id
  owner_name          TEXT,                          -- 归属人姓名(冗余)
  lead_date           INTEGER NOT NULL,              -- 线索日期(ms)
  feishu_record_id    TEXT UNIQUE,                   -- 飞书表格 record_id(双写关联)
  chat_id             TEXT,                          -- 群 ID(溯源)
  user_open_id        TEXT,                          -- 登记人 open_id(溯源)
  original_message_id TEXT,                          -- 触发消息 ID(溯源/去重)
  is_deleted          INTEGER DEFAULT 0,             -- 软删(表格删除/撤回时置1)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_date    ON customer_leads(lead_date);
CREATE INDEX IF NOT EXISTS idx_lead_chat    ON customer_leads(chat_id);
CREATE INDEX IF NOT EXISTS idx_lead_owner   ON customer_leads(owner_open_id);
CREATE INDEX IF NOT EXISTS idx_lead_deleted ON customer_leads(is_deleted);
`)

// ---- 幂等迁移:老库没有 is_bot 列时补上(全新库已在 CREATE TABLE 里建好) ----
// PRAGMA table_info 查列名;不存在则 ALTER TABLE ADD COLUMN(幂等:已存在会抛错,靠检查跳过)
const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>
if (!cols.some((c) => c.name === 'is_bot')) {
  db.exec('ALTER TABLE messages ADD COLUMN is_bot INTEGER DEFAULT 0')
  // 回填存量数据:历史 API 里机器人消息 sender_type='app',实时事件里是 'bot'(历史库此时全为 app)
  const backfilled = db.prepare(
    `UPDATE messages SET is_bot = 1 WHERE sender_type IN ('app', 'bot') AND is_bot = 0`
  ).run().changes
  console.log(`✅ 已迁移:messages 表新增 is_bot 列,回填 ${backfilled} 条机器人消息`)
}
// is_bot 索引:老库迁移加列后建,新库列已在 CREATE TABLE 里(此句对所有库幂等)
db.exec('CREATE INDEX IF NOT EXISTS idx_is_bot ON messages(is_bot)')

// ---- 知识库建表(独立内容源,与 messages / customer_leads 无任何关联) ----
initKnowledgeBase()
