import Database from 'better-sqlite3'
import { config } from '../config.js'

// 单例连接:WAL 模式,并发读写更稳。全模块共享同一个 db 句柄。
export const db = new Database(config.DB_PATH)
db.pragma('journal_mode = WAL')

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
`)
