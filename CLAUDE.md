# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

飞书群机器人助手服务,围绕单进程后台构建,核心能力三块:

1. **消息归档**:飞书群消息(实时 + 每 24h 历史补漏)落 SQLite,前端可分页查看
2. **@机器人问答(LLM)**:基于 MiniMax(Anthropic SDK 兼容端点)的 tool-use loop,工具覆盖
   ① 定时提醒 ② 天气查询 ③ **业务收支记账**(收/支录入、纠错、查询,这是当前最重的能力)
3. **多维表格双向同步**:记账数据双写到飞书多维表格作为审计/可视化副本,表格改动反向回写 SQLite(SQLite 是唯一事实源)

后台同时通过 `@mastra/hono` 暴露 Mastra agent 端点。前后端分离,web 端提供消息列表 + 收支统计仪表盘。

## 架构

```
飞书 ──长连接──▶ [server/ 单进程] ──写──▶ messages.db (SQLite,唯一事实源)
                      │  │                     │
                      │  ├── Hono HTTP API ◀──┘  (读 SQLite)
                      │  │    ├── /api/messages            (分页消息)
                      │  │    └── /api/stats/*             (业务/月份/待结清/流水)
                      │  │
                      │  ├── Mastra agent 端点(/api/agents/summary-agent)
                      │  │
                      │  ├── @机器人 LLM(tool-use loop,最多 3 轮)
                      │  │    ├── set_reminder / get_weather
                      │  │    └── record_income / record_expense / correct_transaction
                      │  │        query_finance / customer_groups / list_customers
                      │  │
                      │  ├── 提醒调度器(动态 setTimeout + 10min 兜底轮询)
                      │  │
                      │  ├── 飞书多维表格双向同步(可选,SQLite 失败不阻断)
                      │  │    ├── 正向:记账 → 写飞书表格 → 回写 record_id
                      │  │    └── 反向:订阅 drive.file.bitable_record_changed_v1 → 回写 SQLite
                      │  │
                      │  └── worker: 长连接收消息 + 每24h历史补漏
```

**关键约束**:后台进程必须常驻、单实例运行(长连接 + 定时器 + 提醒调度器依赖)。多实例会导致长连接重复收消息、提醒重复触发、记账重复。

## 常用命令

```bash
# 后台开发(tsx 热重载)
cd server && npm run dev

# 后台构建/生产启动
cd server && npm run build && npm start

# 前端开发(Vite,端口 5173,/api 代理到 4111)
cd web && npm run dev

# 前端构建
cd web && npm run build
```

首次运行需要 `cp server/.env.example server/.env` 并填入飞书应用凭证 + MiniMax API Key。多维表格相关变量可选(留空则记账只入 SQLite)。

## 技术栈

| 层 | 技术 |
|---|---|
| 后台运行时 | Node.js + TypeScript + ESM + Hono |
| 飞书 SDK | `@larksuiteoapi/node-sdk`(API 客户端 + 长连接 WS 客户端) |
| 数据库 | `better-sqlite3`(WAL 模式),文件路径由 `DB_PATH` 环境变量控制 |
| LLM | Anthropic SDK 兼容端点(`@anthropic-ai/sdk` + `@ai-sdk/anthropic`),指向 MiniMax |
| AI Agent | Mastra(`@mastra/core` + `@mastra/hono`),通过 AI SDK 复用同一 LLM |
| 前端 | Vue 3 + Vite + TypeScript |
| 构建工具 | tsup(后台,ESM/es2023)、Vite(前端) |

## 后台单进程四合一(+ 双向同步)

`server/src/index.ts` 在一个 Node 进程中并行启动:

1. **飞书 Worker**(`feishu/handler.ts`)
   - 注册事件:`im.message.receive_v1`(群消息)+ `drive.file.bitable_record_changed_v1`(多维表格变更)
   - 长连接接收实时消息 → 入库 `source=realtime`
   - 启动 5 秒后执行一次历史补漏,之后每 24 小时一次(`source=history`,靠 `message_id` 去重)
   - 启动时异步拉取机器人自身 `open_id`(走 `/open-apis/bot/v3/info/`),用于判断"@机器人"
   - @机器人的群消息 → 提取问题 → 调 `askLLM` → 引用回复原消息。**两种形态**:① 直接 @提问;② **回复某条消息 + @机器人(可不打字)= 补录模式**,把"被回复消息"原文当上下文喂给 LLM(`loadParentContent` 先查 SQLite 归档,缺失回退飞书 API),是收支就录入、是问题就回答;`ctx.sourceMessageId` 记被回复消息 id 供去重 + 溯源
   - 启动提醒调度器 + 多维表格事件订阅(`subscribeBitable`)

2. **业务 HTTP API**(`routes/`)
   - `routes/index.ts` 聚合后挂到 `/api`
   - `routes/messages.ts`:`GET /api/messages?limit&offset&chat_id` 分页读 SQLite
   - `routes/stats.ts`:`/api/stats/{transactions,by-project,monthly,unsettled,projects,methods}`
   - 新模块在此注册,`index.ts` 只需引入一次

3. **Mastra Agent**(`mastra/`)
   - `mastra/index.ts` 注册 `summaryAgent`,经 `@mastra/hono` 的 `MastraServer` 暴露 `/api/agents/summary-agent`

4. **多维表格双向同步**(`feishu/bitable.ts`,挂在 worker 之上)
   - 正向:记账工具执行成功后,best-effort 同步到飞书表格,把返回的 `record_id` 回写 SQLite
   - 反向:长连接收到表格变更事件 → 拉最新值 → 反向映射 → 已存在则更新、否则插入;表格删除 → SQLite 软删(`is_deleted=1`)
   - SQLite 是事实源,任何一边失败都不影响另一边;回环靠"与现有行比对一致则跳过"+ 60s 窗口匹配刚写入但还没回写 record_id 的行 防抖

## 代码组织

- `db/`:持久化层。`db/index.ts` 单例连接(WAL)+ 建表 schema + 幂等增量迁移,各仓储全部预编译语句,业务层零 SQL。
  - `db/messages.ts` — 消息/提及(实时 + 历史)
  - `db/reminders.ts` — 定时提醒 CRUD
  - `db/payment_methods` → `db/paymentMethods.ts` — 我方收款方式(HKD/RMB/支付宝/微信/现金),启动时 `seedPaymentMethods()` 幂等 upsert + 清理废弃 key
  - `db/projects.ts` — 业务/客户名册(`resolveProject` 大小写不敏感精确命中复用,否则新建)
  - `db/transactions.ts` — 收支流水 CRUD + 纠正 patch + 多维表格反向同步(`feishu_record_id` / `softDeleteByFeishuRecordId` / `findRecentEcho` 60s 回环兜底)+ 聚合查询(`totalsByProject` / `totalsByMonth` / `financeSummary` / `customerGroups` / `listCustomers`)
- `ai/model.ts`:统一 LLM 配置,导出 `anthropic`(Anthropic SDK 客户端,用于 `llm.ts` 手写 tool-use loop)、`model`(AI SDK LanguageModel,用于 Mastra agent)、`modelName`。
- `config.ts`:集中读 `.env`,导出 `config`,所有缺失必填项启动即抛错。
- `llm.ts`:@机器人问答入口 + 8 个工具的实现逻辑。
- `services/weather.ts` — `wttr.in` 免费、无 key、中文友好,`format=j1` 返回结构化 JSON,weatherCode 映射中文描述,`date` 不传=实时,传=预报。
- `feishu/`:
  - `client.ts` — `apiClient`(主动调飞书接口)+ `wsClient`(长连接收事件)
  - `handler.ts` — 消息事件入口、机器人 open_id、@问答路由、worker 启动、用户姓名缓存、重复消息早退
  - `history.ts` — 历史补漏,目标=机器人所在群(API 实时拉,失败回退库中已知),5 分钟重叠窗口
  - `messages.ts` — `replyMessage`(引用回复原消息)
  - `reminders.ts` — 提醒调度器(动态 setTimeout + 10min 兜底轮询)
  - `bitable.ts` — **多维表格双向同步**(正向写入 + 反向事件处理 + 字段映射 + 单选项动态补 + 凭证附件上传 + 回环防抖)
- `routes/` — HTTP 路由
- `mastra/` — Mastra 智能体定义

## LLM 工具系统(`llm.ts`)

`askLLM` 走标准 Anthropic tool-use loop,最多 3 轮。

### 通用

- **系统 prompt 注入当前时间**(`Asia/Shanghai`)+ **已有业务名单**(`projects.name` 列表),让 LLM 直接知道"今天几号/几点"和"业务名要逐字照抄"
- **上下文**:`LlmContext = { originalMessageId, userOpenId, chatId }`,工具执行时用(知道回复到哪条消息、@谁、追溯记账消息)
- **失败兜底**:LLM 报错时回复"开小差了,稍后再试",避免用户以为没反应;`askLLM` 工具调用用尽 3 轮兜底"处理超时,请重试"

### 工具清单(共 8 个)

| 工具 | 用途 | 入库目标 |
|---|---|---|
| `set_reminder` | 定时提醒 | `reminders` 表,调度器到点 reply 原消息 |
| `get_weather` | 天气查询(实时/预报) | 不入库,直接调 wttr.in |
| `record_income` | 收款(客户 → 我方) | `transactions(direction=income)` |
| `record_expense` | 转出(我方 → 别人) | `transactions(direction=expense)` |
| `correct_transaction` | 纠错最近一笔或指定 id 的流水 | `transactions` update,字段走白名单 |
| `query_finance` | 按条件聚合(笔数 + HKD/RMB 分计) | 只读 |
| `customer_groups` | 某客户跨业务的收支 | 只读 |
| `list_customers` | 所有客户去重 + 各自笔数/业务数/收支 | 只读 |

### 记账工具的关键设计

- **币种分开,不跨币种换算**:HKD/RMB 严格分开报,绝不能加在一起,也不换算
- **业务名(`project_name`)逐字照抄**:`resolveProject` 走大小写不敏感精确命中复用;LLM prompt 强约束"从已有清单逐字照抄",错字/简繁不同会拆成两个业务
- **款项性质(`kind`)逐字照抄原文**:不归类、不改写、不补全;用户写"新办尾款"就传"新办尾款"
- **金额**:`amount` 传主单位数值(`17万 → 170000`),`amount_minor` 库内以最小单位(分/仙)存整数,避浮点;`amount_raw` 存原始文本("17万""HKD $1800")留作审计
- **结算状态**:`settled` / `pending`,不确定默认 `pending`,`settlement_note` 存明细原文
- **收款账户 `our_account`**(`paymentMethods.key`):`huaxin_hkd` / `chen_zhenyao_rmb` / `li_fangliang_hkd` / `personal_alipay` / `personal_wechat` / `cash`
- **转出账户类型归一**:只允许 4 个枚举(`现金 / 支付宝 / 微信 / 银行卡`),LLM 描述里含"支付宝"等关键词时自动归一,判不出留空
- **必填校验**:收款/转出消息缺「日期/金额/币种」任意一项 → LLM 不调 record 工具,直接提示用户核对(绝不脑补日期/默认今天)
- **防重复录入(两层去重,在 record 工具 insert 前)**:① **源消息 id 精确去重**——补录场景同一条被回复消息不会被录第二次(`findIdByOriginalMessageId`,不受日期影响);② **语义签名去重**——重发/字段换序/改写,只要解析后核心字段相同(方向/币种/金额/对象/用途/群/日期,income 再加收款账户)就拦(`findDuplicateBySignature`)。用户说"强制录入/再录一笔"时 `allow_duplicate=true` 跳过第②层(第①层同消息仍拦)。软删行(`is_deleted=1`)不计入,删后可重录
- **记账成功后的回复三段式**:① 本笔确认 ② 该方向累计 ③ 多维表格链接(若配 `BITABLE_LINK`)

到点提醒的文案(`generateReminderText`)走 LLM 生成,失败时回退到 6 条本地多样化模板(随机挑),避免重复死板。

## 多维表格双向同步(`feishu/bitable.ts`)

记账的核心数据流,可关可开(留空 `BITABLE_APP_TOKEN/TABLE_ID` 即跳过飞书表格,纯 SQLite 模式)。

### 正向(记账 → 飞书表格)

1. `record_income/record_expense/correct_transaction` 入 SQLite 成功后,`syncToBitable()` 调 `writeTransactionToBitable` / `updateTransactionInBitable`
2. **字段映射**:内部 key → 表格列名(`记录类型 / 日期 / 收款账户 / 收款对象 / 币种 / 金额 / 结算状态 / 结算备注 / 对应业务(群名称) / 转出账户类型 / 转出账户详情 / 转出对象 / 款项说明`),枚举值走 LABEL 映射(`income → 收款`、`settled → 已结清` 等)
3. **单选项动态补**:`ensureOption()` 在写入前把"对应业务(群名称)"列里不存在的业务名补成新选项(只对动态单选字段生效,固定枚举单选字段跳过)
4. 表格返回的 `record_id` 写回 SQLite `transactions.feishu_record_id`
5. **best-effort**:失败仅记日志,不影响 SQLite(事实源)

### 反向(飞书表格 → SQLite)

1. `subscribeBitable()` 启动时调用,订阅 `drive.file.bitable_record_changed_v1`(幂等)
2. 收到变更事件后 `handleBitableRecordChanged` 处理每条 action:
   - `record_deleted` → `softDeleteByFeishuRecordId` 软删(`is_deleted=1`,统计/列表已排除,留档溯源)
   - `record_added` / `record_edited` → 拉最新 fields → `reverseMapFields` 反向映射 → 与现有行比对一致则跳过(防回环) → 否则 update/insert
3. **回环兜底**:刚正向写入但 `feishu_record_id` 还没回写的行(60s 窗口),用 `findRecentEcho`(方向/金额/币种/日期全等)匹配关联,避免被当成表格手填再插一条

### 凭证图(附件)

记账消息里带的凭证图(post 富文本里的 `img` block)端到端流程。**双写启用时**才会上传到表格;留空 `BITABLE_*` 时只存 SQLite 的 image_key,不上传。

1. **抓取**:`handler.ts` 的 `extractQuestion` 解析 @机器人的 post 消息,取出文字问题 + 凭证图 `image_key` 列表(text 消息无图)。image_key 放进 `LlmContext.voucherImageKeys` **只透传给工具,不进 LLM prompt**(省 token、防泄漏)。
2. **入库**:`record_income/record_expense` 经 `packImages` 把 image_key 数组转 JSON 存 `transactions.voucher_image_keys`(事实源)。
3. **上传附件**:正向 `writeTransactionToBitable` → `ensureVoucherTokens` → `uploadVoucherImages`,用 `im.messageResource.get` 下载消息里的原图(必须用这个接口,`im.image.get` 只能下机器人自己发的图),再 `drive.media.uploadAll` 传到表格拿 `file_token`。单张失败 best-effort 跳过继续其余。
4. **缓存 token**:`voucher_file_tokens` 存 file_token(JSON)。**纠正时若 image_key 数量没变就复用缓存**,避免重复上传/重复附件。
5. **写表格**:`buildFields` 把 `[{ file_token }]` 写到「凭证」附件列;列不存在或非附件类型则整段跳过,不阻断其余字段。
6. **反向不回拉**:反向同步只读业务字段,凭证附件不回写 SQLite(单向)。

## 提醒调度器(`feishu/reminders.ts`)

混合调度模式,平衡精度与可靠性:

- **动态 setTimeout**:为"最近一条 pending"设精确触发定时器,到点 `flushDue`,处理完再 `scheduleNext` 重排下一条;无 pending 时零空转
- **10 分钟兜底轮询**:补动态定时器可能漏的情况(时钟漂移 / 新增提醒 / 进程恢复)
- **新增提醒钩子**:`llm.ts` 调用 `setOnReminderAdded(scheduleNext)`,若新增的提醒比当前定时器更早,立刻重排
- **启动时清理**:`expireOverdueReminders(now)` 把"过期的 pending"标记 `expired`,**直接丢弃不补发**(用户决策)
- **发送策略**:无论 reply 成败都标记 `sent`,避免原消息被撤回等导致无限重试

## 数据库设计

`server/src/db/index.ts` 单例连接(WAL 模式),建表 + 幂等增量迁移(给已存在的库补新列)。

### messages

主表,`message_id` 为主键(`INSERT OR IGNORE` 去重)。

| 字段 | 说明 |
|---|---|
| `message_id` | 飞书消息 ID,主键 |
| `chat_id` / `chat_type` | 会话 / 群 ID 与类型(p2p \| group) |
| `message_type` | text \| post \| image \| ... |
| `sender_open_id` / `sender_user_id` / `sender_union_id` / `sender_type` | 发送人 ID 三件套 + 类型 |
| `sender_name` | 冗余存姓名,异步回填 |
| `root_id` / `parent_id` | 话题根 / 被回复消息 ID |
| `content` | 原始 content JSON 字符串 |
| `raw_data` | 完整事件 JSON 兜底 |
| `create_time` / `received_at` | 发送时间 / 入库时间(毫秒) |
| `source` | `realtime` \| `history` |
| `is_recalled` / `updated_at` | 撤回标记 / 更新时间 |

索引:`idx_chat_time(chat_id, create_time)` / `idx_sender` / `idx_create_time` / `idx_source`

### mentions

@提及表,外键 `message_id → messages.message_id`。

| 字段 | 说明 |
|---|---|
| `mention_key` | content 里的占位符 `@_user_1` |
| `open_id` / `user_id` / `union_id` / `name` | 被 @ 用户 ID 三件套 + 名字 |

索引:`idx_mentions_msg` / `idx_mentions_openid`

### reminders

定时提醒表,调度器读取 `status='pending' AND remind_at <= now` 的记录。

| 字段 | 说明 |
|---|---|
| `chat_id` | 群 ID(便于排查) |
| `user_open_id` | @谁 |
| `content` | 提醒内容 |
| `remind_at` | 触发时间(毫秒) |
| `original_message_id` | 设提醒的原消息 ID,到点 reply 它 |
| `created_at` | 创建时间 |
| `status` | `pending` \| `sent` \| `expired` |

索引:`idx_reminders_due(remind_at, status)`

### payment_methods

我方收款方式(`huaxin_hkd` / `chen_zhenyao_rmb` / `li_fangliang_hkd` / `personal_alipay` / `personal_wechat` / `cash`),启动时 `seedPaymentMethods()` 幂等 upsert + 清理废弃 key。

| 字段 | 说明 |
|---|---|
| `key` | 主键(`huaxin_hkd` 等) |
| `label` | 显示名(必须与多维表格「收款账户」单选选项逐字一致) |
| `currency` | HKD \| RMB \| ANY |
| `details` | 完整户名/账号/行号,前端展示用 |

### projects

业务/客户名册(群名归一化的标准名册)。

| 字段 | 说明 |
|---|---|
| `id` | 主键 |
| `name` | 标准业务名(LLM 归一化后逐字照抄,`UNIQUE` + `COLLATE NOCASE`) |
| `note` | 备注 |
| `created_at` | 创建时间 |

索引:`idx_projects_name`

### transactions

收支流水(统一表,`direction` 区分)。**注意:HKD/RMB 严格分开,绝不相加或换算。**

| 字段 | 说明 |
|---|---|
| `direction` | `income` \| `expense` |
| `kind` | 款项性质/用途(逐字照抄用户原文,如"新办尾款""兵哥华哥杂费") |
| `occurred_at` / `occurred_month` | 业务日期(毫秒,该日 Asia/Shanghai 00:00)+ 'YYYY-MM' 冗余 |
| `our_account` | income: `payment_methods.key`;expense: NULL |
| `counterparty_name` | income: 客户名;expense: 转出对象 |
| `counterparty_account` | expense: 对方账户详情(自由文本) |
| `counterparty_account_type` | expense: 对方账户类型(现金/支付宝/微信/银行卡) |
| `amount_minor` | 金额最小单位(RMB=分,HKD=仙),整数,避浮点 |
| `currency` | HKD \| RMB |
| `amount_raw` | 原始金额文本("17万"等),审计 |
| `settlement_status` / `settlement_note` | `settled` \| `pending` + 明细原文 |
| `project_id` / `project_name_raw` | 业务外键 + 用户手打原始群名(审计) |
| `transfer_type` / `note` | 可选,转账类型/备注 |
| `chat_id` / `user_open_id` / `original_message_id` | 记账消息溯源(补录场景存**被回复消息** id 便于去重 + 溯源;普通 @ 存触发消息 id;表格手填时为空) |
| `feishu_record_id` | 多维表格记录 id(双写关联) |
| `voucher_image_keys` | 凭证图 image_key 数组的 JSON(事实源,来自 post 富文本) |
| `voucher_file_tokens` | 凭证上传多维表格后的 file_token 数组 JSON(缓存,纠正时复用) |
| `is_deleted` | 软删标记:0=正常,1=表格删除(留档溯源,**统计/列表全排除**) |
| `created_at` / `updated_at` | 落库/更新时间 |

索引:`idx_txn_project` / `idx_txn_occurred` / `idx_txn_dir_status` / `idx_txn_user_created`

**入库去重**:历史补漏与实时收消息共用 `saveMessage`,靠 `message_id` 主键 `INSERT OR IGNORE` 吸收。**mentions 仅在 messages 真新增时插入**,避免重投递时重复落库。

## 飞书历史补漏(`feishu/history.ts`)

- **目标群**:启动时实时拉机器人所在群(`/open-apis/im/v1/chats`),自动覆盖新加入的群,解决冷启动无种子问题;API 失败时回退到库中已知 `chat_id`
- **增量起点**:从该群最后一条 `create_time` 往前回退 5 分钟重叠窗口(`OVERLAP_MS`),无记录则拉最近 7 天
- **入库**:复用实时事件 `saveMessage` 路径,标记 `source=history`,靠主键去重
- **分页**:50 条/页,最多 500 页防死循环,按 `ByCreateTimeAsc` 升序

## 前端结构(`web/`)

```
web/src/
├── App.vue                  # 入口:双 tab 切换(stats | messages),各自刷新
├── api.ts                   # fetchMessages + 4 个统计接口(fetchByProject/Monthly/Unsettled/Transactions)
├── components/
│   ├── MessageList.vue      # 消息卡片列表(姓名/时间/source 标签/content)
│   └── StatsView.vue        # 收支统计:按业务汇总 + 按月汇总 + 待结清 三块表格
├── main.ts
└── env.d.ts
```

Vite 开发期 `proxy: '/api' → http://localhost:4111`,免跨域。前端只读 API,不直接调 Mastra 端点。

## 环境变量

`server/.env`(参考 `.env.example`):

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `PORT` | 否 | HTTP 端口,默认 `4111` |
| `DB_PATH` | 否 | SQLite 路径(相对 server/),默认 `./data/messages.db` |
| `ANTHROPIC_BASE_URL` | 是 | LLM 端点,指向 MiniMax(`.env.example` 默认 `https://api.minimaxi.com/anthropic`) |
| `ANTHROPIC_API_KEY` | 是 | MiniMax API Key |
| `LLM_MODEL` | 否 | 模型名,默认 `MiniMax-M3` |
| `BITABLE_APP_TOKEN` | 否 | 飞书多维表格 app_token(留空 = 只入 SQLite,跳过双写) |
| `BITABLE_TABLE_ID` | 否 | 飞书多维表格 table_id |
| `BITABLE_LINK` | 否 | 多维表格链接(录入后回复里附上) |

## 飞书应用权限

### 基础(消息归档 + @问答 + 提醒)

- `im:message` — 接收消息事件
- `im:message.group_at_msg:readonly` / `im:message:readonly` — 读群消息
- `im:chat:readonly` — 拉机器人所在群(历史补漏用)
- `contact:user.base:readonly` — 查用户姓名(发件人缓存)
- `im:message:send_as_bot` — 以应用身份 reply 消息(@问答、提醒回复用)

### 多维表格双向同步(可选,启用双写时需要)

- `bitable:app:readonly` / `bitable:app` — 读写多维表格
- `drive:drive` — 订阅云文档事件(`drive.file.bitable_record_changed_v1`)

### 「事件订阅」配置

开长连接模式,订阅:
- `im.message.receive_v1`(消息)
- `drive.file.bitable_record_changed_v1`(多维表格记录变更,启用双写时)

把机器人加入要监听的群。