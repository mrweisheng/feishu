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
  content             TEXT NOT NULL,                  -- 提醒内容(渐进式批次存空,到点动态聚合)
  remind_at           INTEGER NOT NULL,               -- 触发时间(毫秒)
  original_message_id TEXT NOT NULL,                  -- 设提醒的原消息ID,到点reply它
  created_at          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',-- pending | sent | expired
  batch_id            TEXT NOT NULL DEFAULT '',       -- 渐进式批次ID(set_reminder 单次提醒留空)
  round               INTEGER NOT NULL DEFAULT 0,     -- 第几轮 1/2/3(单次=0)
  todo_record_ids     TEXT NOT NULL DEFAULT ''        -- JSON数组:该批次待办的飞表 record_id
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at, status);

-- 我方收款方式(启动时由 db/paymentMethods.ts 幂等 seed)
CREATE TABLE IF NOT EXISTS payment_methods (
  key      TEXT PRIMARY KEY,            -- huaxin_hkd | chen_zhenyao_rmb | li_fangliang_hkd | personal_alipay | personal_wechat | cash
  label    TEXT NOT NULL,               -- 显示名
  currency TEXT NOT NULL,               -- HKD | RMB | ANY
  details  TEXT NOT NULL DEFAULT ''     -- 完整户名/账号/行号,前端展示用
);

-- 业务/客户(群名归一化的标准名册)
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,      -- 业务/客户标准名(LLM 归一化后逐字照抄)
  created_at INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

-- 收支流水(统一表,direction 区分收款/转出)
CREATE TABLE IF NOT EXISTS transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  direction            TEXT NOT NULL,                   -- income | expense
  kind                 TEXT NOT NULL DEFAULT '',        -- 款项性质/用途(新办尾款/过户/水费卷款...)
  occurred_at          INTEGER NOT NULL,                -- 业务日期(毫秒,该日 Asia/Shanghai 00:00)
  occurred_month       TEXT NOT NULL,                   -- 'YYYY-MM',冗余便于按月聚合,免时区计算
  our_account          TEXT,                            -- income: payment_methods.key;expense: NULL
  counterparty_name    TEXT,                            -- income: 客户名
  counterparty_account TEXT,                            -- expense: 对方账户(自由文本)
  amount_minor         INTEGER NOT NULL,                -- 金额最小单位(RMB=分,HKD=仙),避浮点
  currency             TEXT NOT NULL,                   -- HKD | RMB
  amount_raw           TEXT NOT NULL DEFAULT '',        -- 原始金额文本,审计("17万"等)
  settlement_status    TEXT NOT NULL DEFAULT 'pending', -- settled | pending
  settlement_note      TEXT NOT NULL DEFAULT '',        -- 结算明细自由文本
  project_id           INTEGER NOT NULL REFERENCES projects(id),
  project_name_raw     TEXT NOT NULL DEFAULT '',        -- 用户手打原始群名,审计
  transfer_type        TEXT NOT NULL DEFAULT '',        -- 可选,如"业务收入"
  note                 TEXT NOT NULL DEFAULT '',        -- 可装备注
  chat_id              TEXT NOT NULL DEFAULT '',        -- 记账消息来源群(可追溯,非业务键)
  user_open_id         TEXT NOT NULL DEFAULT '',        -- 记账人
  original_message_id  TEXT NOT NULL DEFAULT '',        -- @消息 id,便于回复/纠正
  feishu_record_id     TEXT NOT NULL DEFAULT '',        -- 多维表格记录 id(双写同步/纠正用)
  voucher_image_keys   TEXT NOT NULL DEFAULT '',        -- 凭证图 image_key(JSON 数组,事实源,可随时重传)
  voucher_file_tokens  TEXT NOT NULL DEFAULT '',        -- 凭证上传表格后的 file_token(JSON 数组,缓存避免重传)
  counterparty_account_type TEXT NOT NULL DEFAULT '',   -- expense:对方账户类型(现金/支付宝/微信/银行卡)
  is_deleted           INTEGER NOT NULL DEFAULT 0,       -- 软删标记:0=正常,1=表格删除(留档溯源,统计/列表全排除)
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_project      ON transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_txn_occurred     ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_txn_dir_status   ON transactions(direction, settlement_status);
CREATE INDEX IF NOT EXISTS idx_txn_user_created ON transactions(user_open_id, created_at);
`)

// ---- 幂等增量迁移:给已存在的 messages.db 补新列(新建库由上面的 CREATE 直接带上) ----
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    console.log(`📦 数据迁移:${table} 增加列 ${column}`)
  }
}
addColumnIfMissing('transactions', 'feishu_record_id', "feishu_record_id TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('transactions', 'counterparty_account_type', "counterparty_account_type TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('transactions', 'is_deleted', 'is_deleted INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('reminders', 'batch_id', "batch_id TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('reminders', 'round', 'round INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('reminders', 'todo_record_ids', "todo_record_ids TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('transactions', 'voucher_image_keys', "voucher_image_keys TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('transactions', 'voucher_file_tokens', "voucher_file_tokens TEXT NOT NULL DEFAULT ''")

// idx_reminders_batch 引用 batch_id 列,必须在上面迁移补列之后建(旧库 reminders 表已存在但无该列,放建表 exec 块里会 no such column)
db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_batch ON reminders(batch_id, round)')
