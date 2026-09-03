# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

飞书群机器人助手服务,围绕单进程后台构建,核心能力四块:

1. **消息归档**:飞书群消息(实时 + 每 24h 历史补漏)落 SQLite,HTTP API 可分页查看
2. **@机器人问答(LLM)**:基于 MiniMax(Anthropic SDK 兼容端点)的 tool-use loop,工具覆盖
   ① 定时提醒 ② 天气查询(实时/多日预报) ③ **客资登记**(发微信联系人截图自动逐条录入,当前最重的能力) ④ 知识库检索
3. **客资单向同步**:客资数据 best-effort 写飞书多维表格「客资信息登记表」作可视化副本(SQLite 是唯一事实源)
4. **知识库(RAG)**:独立内容源(与消息归档/客资无关),经 `/admin` 管理页录入 → 中文切片 → bge-m3 向量 + FTS5 trigram 双路召回 → RRF 融合 → LLM 检索问答

后台同时通过 `@mastra/hono` 暴露 Mastra agent 端点。除知识库管理页(`web/index.html`,单文件零构建)外无其他前端。

## 架构

```
飞书 ──长连接──▶ [server/ 单进程] ──写──▶ messages.db (SQLite,唯一事实源)
                      │  │                     │
                      │  ├── Hono HTTP API ◀──┘  (读 SQLite)
                      │  │    ├── /api/messages            (分页消息)
                      │  │    ├── /api/customer-leads      (分页客资)
                      │  │    └── /api/knowledge           (知识库管理,登录鉴权)
                      │  │
                      │  ├── /admin 知识库管理页(单文件 HTML,登录鉴权;公网经 nginx:knowledge.eazycar.top)
                      │  │
                      │  ├── Mastra agent 端点(/api/agents/summary-agent)
                      │  │
                      │  ├── @机器人 LLM(tool-use loop,最多 3 轮)
                      │  │    ├── set_reminder / get_weather / get_weather_forecast
                      │  │    ├── record_customer_info  ──best-effort──▶ 飞书「客资信息登记表」
                      │  │    └── search_knowledge_base ─▶ 混合检索(向量+BM25→RRF)
                      │  │
                      │  ├── 提醒调度器(动态 setTimeout + 10min 兜底轮询 + 重启补偿)
                      │  │
                      │  └── worker: 长连接收消息 + 每24h历史补漏
                      │
                      └── 事实接管(toolRegistry.ts):LLM 只说话,成败/数量/链接由代码统计
```

**关键约束**:后台进程必须常驻、单实例运行(长连接 + 定时器 + 提醒调度器依赖)。多实例会导致长连接重复收消息、提醒重复触发。

## 常用命令

```bash
# 后台开发(tsx 热重载) / 构建生产 / 启动
cd server && npm run dev
cd server && npm run build && npm start

# 单测(node:test + tsx,零额外依赖)
cd server && npm test

# 跑单个测试文件(快速迭代)
cd server && node --test --import tsx tests/toolRegistry.test.ts

# 跑单个测试用例(npm test 加 -t <pattern> 即可)
cd server && npm test -- -t "stripAllUrls"
```

首次运行需要 `cp server/.env.example server/.env` 并填入飞书应用凭证 + MiniMax API Key。客资多维表格相关变量可选(留空则客资只入 SQLite,不同步飞书表格)。

> **不要主动 `npm run dev`**——服务启动后会占端口、跑长连接;验证由用户自己启动,改完代码让用户跑。

## 探索代码

`mcp__codegraph__codegraph_explore` 是已索引的代码库搜索,**优先用**它来回答「X 怎么工作」「X 在哪里」「X 被谁调用」类问题,而不是 Read + Grep 自己搜。CodeGraph 一次返回带行号的源 + 调用链,比手动 Read 节省大量 token,且对即将修改的代码能看到 blast radius。

Read 用于:CodeGraph 没找到的内容、读 README/.env.example/CLAUDE.md 这类纯文档、读完整长文件做深度编辑。

## 技术栈

| 层 | 技术 |
|---|---|
| 后台运行时 | Node.js + TypeScript + ESM + Hono |
| 飞书 SDK | `@larksuiteoapi/node-sdk`(API 客户端 + 长连接 WS 客户端) |
| 数据库 | `better-sqlite3`(WAL 模式),文件路径由 `DB_PATH` 环境变量控制 |
| LLM | Anthropic SDK 兼容端点(`@anthropic-ai/sdk` + `@ai-sdk/anthropic`),指向 MiniMax |
| AI Agent | Mastra(`@mastra/core` + `@mastra/hono`),通过 AI SDK 复用同一 LLM |
| 图片处理 | `sharp`(联系人截图下载后压缩喂 LLM 视觉) |
| 拼音 | `pinyin-pro`(天气城市名拼音兜底识别) |
| 校验 | `zod` |
| 构建/测试 | tsup(后台,ESM/es2023)、node:test(单测) |

## 后台单进程三合一(+ 客资单向同步)

`server/src/index.ts` 在一个 Node 进程中并行启动:

1. **飞书 Worker**(`feishu/handler.ts`)
   - 注册事件:`im.message.receive_v1`(群消息)。**只订阅消息事件,不订阅多维表格变更事件**(客资是单向同步,无反向)
   - 长连接接收实时消息 -> 入库 `source=realtime`
   - 启动 5 秒后执行一次历史补漏,之后每 24 小时一次(`source=history`,靠 `message_id` 去重)
   - 启动时异步拉取机器人自身 `open_id`(走 `/open-apis/bot/v3/info/`,带重试 + 运行期懒加载自愈),用于判断"@机器人"
   - @机器人的群消息 -> 提取文字 + 图片 -> 调 `askLLM` -> 引用回复原消息。**两种形态**:① 直接 @提问;② **回复某条消息 + @机器人(可不打字)= 补录模式**,把"被回复消息"原文(文字+图)当上下文喂给 LLM(`loadParentContext` 先查 SQLite 归档,缺失回退飞书 API),LLM 自己判断是录客资还是回答问题;`ctx.imageMessageIds` 记每张图所属消息 id(父消息的图必须用父消息 id 下载,不能混用)
   - **ACK 时序关键**:飞书长连接在 handler 返回后才发 ACK。慢操作(查名字 + LLM tool-use,慢则十几秒)若 await 会拖住 ACK -> 触发重连 -> 断流。解法:同步快操作(落库 + 去重)留体内 await,慢操作(补名字 + 日志 + @问答)整体 `fire-and-forget` 异步化,彻底解耦 ACK 与 LLM 耗时
   - 启动提醒调度器

2. **业务 HTTP API**(`routes/`)
   - `routes/index.ts` 聚合后挂到 `/api`
   - `routes/messages.ts`:`GET /api/messages?limit&offset&chat_id&include_bot` 分页读 SQLite(默认排除机器人消息,`include_bot=true` 才返回)
   - `routes/customerLeads.ts`:`GET /api/customer-leads?limit&offset&chat_id` 分页读客资
   - 新模块在此注册,`index.ts` 只需引入一次

3. **Mastra Agent**(`mastra/`)
   - `mastra/index.ts` 注册 `summaryAgent`(示例:消息总结助手),经 `@mastra/hono` 的 `MastraServer` 暴露 `/api/agents/summary-agent`

4. **客资单向同步**(`feishu/bitable-customer.ts`,挂在 worker 之上)
   - 正向:`record_customer_info` 入 SQLite 成功后,best-effort 同步到飞书「客资信息登记表」,把返回的 `record_id` 回写 SQLite
   - **无反向**:不订阅表格变更事件,表格里手改/删除不会回写 SQLite
   - SQLite 是事实源,飞书表格同步失败不影响 SQLite;留空 `BITABLE_CUSTOMER_*` 即纯 SQLite 模式

## 代码组织

按职责分(具体文件用 CodeGraph 或 `ls` 探):

- `db/` — 持久化层。`index.ts` 单例连接 + schema + 幂等迁移(sqlite-vec 加载失败自动降级,不拖垮服务);`messages/reminders/customerLeads/knowledgeBase` 四个仓储,业务层零 SQL。
- `ai/model.ts` — LLM 配置(Anthropic SDK 用于手写 tool-use loop,AI SDK 用于 Mastra agent,两者指向同一 MiniMax 端点)。
- `config.ts` — 集中读 `.env`,缺必填项启动即抛错。`HOST` 默认 127.0.0.1(公网走 nginx 反代无需改);管理页单账号登录 `KB_ADMIN_USER/KB_ADMIN_PASSWORD`(默认 shengwei/123456,非用户体系)。
- `llm.ts` — @机器人问答入口 + 5 个工具实现 + `finalizeReply`(拼系统核对段)。
- `llm/toolRegistry.ts` — **事实接管核心**(写工具登记表 / 系统核对段生成 / URL 清洗 / 去重归一化纯函数,有单测)。
- `services/weather.ts` — `open-meteo` 封装(中文城市名→拼音兜底→剥行政区后缀,一次请求拿实时+多日)。
- `services/knowledge.ts` — 知识库服务层:异步串行索引队列(状态机 pending→indexing→ready/failed/stale)+ 混合检索(向量 + BM25 → RRF)。启动自检失败跳过对账,防瞬时故障把全库钉死在 failed。
- `services/embedding.ts` — OpenAI 兼容嵌入客户端(provider adapter,分批 + 限并发 + 指数退避 + 维度自检);`chunker.ts` 中文特化递归切片;`ftsQuery.ts` / `rank.ts` 纯函数(trigram 滑窗 MATCH 构造 / RRF,有单测)。
- `feishu/` — 飞书 SDK 封装:`client`(apiClient + wsClient)/ `handler`(消息事件 + worker 启动 + ACK 异步化)/ `history`(24h 历史补漏)/ `messages`(reply)/ `media`(图片下载压缩)/ `reminders`(调度器)/ `bitable-customer`(客资单向同步)。
- `routes/` — Hono HTTP 路由(messages / customerLeads / knowledge),挂到 `/api`;knowledgeBase 内含单账号登录(/login /logout /session)+ 会话中间件。
- `services/auth.ts` — 管理端登录鉴权:凭证校验 + HMAC 会话签名/校验 + 登录限流(纯函数,有单测)。
- `web/index.html` — 知识库管理页(单文件零构建,挂 `/admin`,含登录界面,按会话切换登录/应用视图)。
- `mastra/` — Mastra agent 定义。
- `tests/toolRegistry.test.ts`、`tests/knowledge.test.ts` — `node:test` 单测,覆盖事实接管、去重归一化、切片、FTS 查询构造、RRF。

## LLM 工具系统(`llm.ts`)

`askLLM` 走标准 Anthropic tool-use loop,最多 3 轮,`max_tokens=1000`。

### 通用

- **系统 prompt 注入当前时间**(`Asia/Shanghai`),让 LLM 有时间观念
- **上下文**:`LlmContext = { originalMessageId, userOpenId, chatId, voucherImageKeys, imageMessageIds? }`,工具执行时用(知道回复到哪条消息、@谁、每张图用哪个消息 id 下载)
- **图片直接进 LLM 视觉**:联系人截图经 `buildUserContent` 下载压缩后作为 `image` block 喂给 LLM 识别(客资场景的核心输入);文字可空(纯图 @机器人也能触发登记)
- **失败兜底**:LLM 报错时回复"开小差了,稍后再试";`askLLM` 工具调用用尽 3 轮兜底"处理超时,请重试"

### 工具清单(共 5 个)

| 工具 | 用途 | 入库目标 |
|---|---|---|
| `set_reminder` | 定时提醒(短时单次) | `reminders` 表,调度器到点 reply 原消息 |
| `get_weather` | 查某城市当前实时或某一个具体日期的天气 | 不入库,直接调 open-meteo |
| `get_weather_forecast` | 一次性查未来多天逐日预报(最多3天) | 不入库,直接调 open-meteo |
| `record_customer_info` | 登记一条客资(销售线索) | `customer_leads` 表 + best-effort 同步飞书表格 |
| `search_knowledge_base` | 检索公司知识库(`KB_ENABLED=0` 时整个工具不下发) | 不入库,只读 `kb_chunks` |

`search_knowledge_base` 是**读工具**(category='read'),不参与事实接管——否则每条回答都会被追加莫名其妙的系统核对段。系统 prompt 要求:查到就基于结果回答并说明出处;查不到就直说没有,**绝不编造**。

### 事实接管(`llm/toolRegistry.ts`)-- 核心设计

**原则:事实与叙述分离。**「成功了几条」「链接是啥」这些关键事实永远由代码统计真实工具执行结果决定,LLM 只负责组织语言,不能宣布事实、不能贴链接。整个修复针对「LLM 假宣布成功 + 编假链接」类问题,从架构上杜绝。

- **账本 `LedgerEntry`**:`executeTool` 每次执行真实记录 `{tool, category:'write'|'read', ok, skipped?, summary?, error?, linkKey?}`。事实接管只信账本,不信 LLM 的嘴
- **`buildSystemAttestation(ledger, llmText)`**:LLM 吐完文字后,`finalizeReply` 调用它生成「📋 系统核对」追加段,规则(按 tool 分组,每组只贴一次链接):
  - 该组 ≥1 条成功 👉 真实条数 + 名字列表 + config 真实链接
  - 该组全失败 👉 诚实声明「实际未成功,请重发」
  - 全部重复跳过 👉 告知「全部与维格表当天已有记录重复」
  - 账本无写工具记录、但 LLM 文字声称「已登记/录入了」(`CLAIMS_REGISTER` 正则命中)👉 追加「实际未成功」戳穿幻觉;无声称则当纯闲聊不追加
- **`stripAllUrls`**:一刀切清掉 LLM 文字里所有 `http(s)` 链接(不做白名单--白名单会被「合法域名+编造路径」绕过)。链接只能由 `buildSystemAttestation` 从 `LINK_SOURCES`(即 config)注入
- **写工具登记表 `WRITE_TOOLS`**:`record_customer_info`(linkKey='customer')、`set_reminder`(无 linkKey)。`isWriteTool` 判断是否参与事实接管。**未来新增写维格表功能(订单/售后/预约),只要在 `llm.ts` 写工具函数 + 在这里登记一行,防撒谎/防假链接/事实接管全自动获得**
- **链接来源 `LINK_SOURCES`**:key -> config 真实 URL(`customer -> BITABLE_CUSTOMER_LINK`),LLM 永远取不到

### 客资录入的关键设计

- **客户姓名必填**,其他字段(微信/需求/备注/是否重点/是否到店/线索日期)能填就填,不知道就空;**没给日期默认今天**(`lead_date` 不传)
- **归属人自动填当前 @你的人**(这条线索归谁);**创建人飞书系统自动记录**(API 调用方 = 机器人 app),LLM 不传
- **批量录入(图)**:用户发微信联系人截图并 @机器人 -> LLM 逐条解析(可并行 8-10 个 tool_use block)-> 每条调一次 `record_customer_info`
  - 看到联系人截图**默认直接录入,不反问**"要不要登记"(纯 @无文字或文字就是要登记,一律直接录)
  - **唯一不录的例外**:文字明显是查询/核对/修改/删除意图("这个录过没""删掉这个""改成XX")-> 按文字意图回答,绝不录入(误录会污染表格)
  - 两种截图场景:搜索结果列表(多联系人,备注名带日期前缀,逐行解析,看不到微信号就空)/ 单联系人详情(只 1 条,有微信号就填)
  - 同事备注无统一格式:日期和姓名可能用斜杠/空格/点/横线隔,可能是 4 位纯数字 / M.DD / M月DD日;**拆出日期后,日期之后整段就是客户名称,整段照抄**,不再拆子字段,也不加"备注名:"等标签
  - 拆日期靠 LLM 看图,不套固定模式;年份没明示就当前年
- **去重(以飞书维格表为事实源)**:`record_customer_info` 执行时,按实际 `lead_date` 的"日"拉维格表当天已有名字(`listExistingNamesOnDate`,filter `ExactDate` 当天),归一化后同名同日即跳过(同一天不会有两个同名备注,不误杀)
  - **去重比对口径必须与维格表存储口径一致**:维格表存的是 `addLead` 剥离日期前缀后的纯名字,所以比对前也要 `stripDatePrefix` + `normalizeName`,否则"60717/雅琴"对不上维格表的"雅琴" -> 重复录入
  - **`DedupCtx`**:本轮首次出现 `record_customer_info` 时初始化,`existingByDate`(Map<日期, 名字Set>,同一天只拉一次,失败存空集降级不去重)+ `justAdded`(Set<日期|名字>,防本批内 LLM 重复登同一条)。写库成功才提交 `justAdded` 占坑(写库失败不占,允许重试)
  - **按实际 lead_date 的日查,不用 Date.now()**--补录历史图时 lead_date 是历史日期,用今天的数据去重会跨日错位
- **DB 层兜底(`addLead`)**:`stripDatePrefix` 剥掉客户名开头的日期前缀(防 LLM 偶尔不拆把“60717/雅琴”整个塞进 name 污染表格「客户名称」列)。备注(`customer_notes`)仅存 SQLite,不同步飞书表格(要备注在表格里自己写)
- **图片不入库**:`customer_leads` 表无图片字段,联系人截图只是临时下载喂 LLM 识别,不持久化 image_key
- **录入成功后的回复**:LLM 只说自然的话("帮你登记啦"),**不数数、不贴链接**;条数+名字+链接由「系统核对」段自动追加(`bitable_synced=false` 时 LLM 补一句"飞书表格同步失败,本地 SQLite 里有,需要排查")

到点提醒的文案(`generateReminderText`)走 LLM 生成,失败时回退到 6 条本地多样化模板(随机挑),避免重复死板。

## 客资单向同步(`feishu/bitable-customer.ts`)

客资写入飞书表格,可关可开(留空 `BITABLE_CUSTOMER_APP_TOKEN/TABLE_ID` 即跳过,纯 SQLite 模式)。

1. `record_customer_info` 入 SQLite 成功后,`syncLeadToBitable()` 调 `appTableRecord.create`
2. **字段映射**:内部行 -> 表格列名(`线索日期 / 客户名称 / 客户微信 / 客户需求 / 是否是重点客户 / 是否到店 / 归属人 / 创建人 / 登记时间 / 更新时间`)
   - Date 字段传毫秒数(SDK 把数字当 ms 处理,不要除以 1000)
   - 归属人是 Person 字段,单人也要传数组 `[{id: open_id}]`
   - 「创建人」不传,让飞书系统自己记录(API 调用方 = 机器人 app),不要把 @机器人的人当创建人
   - 空值字段不传 key,避免给 bitable 写 null 覆盖已有值
3. 表格返回的 `record_id` 写回 SQLite `customer_leads.feishu_record_id`
4. **best-effort**:失败仅记日志,不影响 SQLite(事实源)
5. **去重预拉**:`listExistingNamesOnDate` 用 filter `ExactDate` 拉当日已有记录(page_size 500),供录入前查重;未启用或拉取失败返回空 Set(降级为不去重,靠人工清)

## 知识库(RAG)

独立内容源:**只能通过 `/admin` 管理页录入**,与消息归档、客资表零关联。链路:录入 → 中文切片 → bge-m3 嵌入 → sqlite-vec + FTS5 双索引 → 混合检索 → `search_knowledge_base` 工具。

### 关键设计

- **事实源 vs 派生数据**:`kb_docs`(原文)+ `kb_chunks`(切片)+ `kb_chunks_fts`(FTS5 外部内容表)是事实源;`vec_chunks`(sqlite-vec)是**可随时 DROP 重建的派生表**。sqlite-vec 是 pre-v1 扩展,加载失败只降级为纯关键词检索,不拖垮服务
- **维度绑定模型**:vec0 建表维度写死,启动时检测配置维度变化 → DROP 重建 + ready 文档标 stale;嵌入响应维度与配置不符直接抛错(换模型必须同步改 `EMBEDDING_DIM`,自检失败不拒绝启动,降级 + 告警 + 跳过对账)
- **文档状态机**:`pending → indexing → ready / failed`;换模型后 `ready → stale`。启动对账只重跑 pending/indexing/stale,且**自检通过才对账**——否则一次瞬时故障会把全库钉死在 failed
- **索引队列串行**:嵌入打外部 API 有 RPM 限流,并发只会吃 429;失败标 failed 带错误原因,管理页可看可手动重试
- **混合检索**:向量(同义表述)+ BM25(专有名词/合同号精确匹配)各召回 N 条 → RRF 融合(只用排名不看分数,免调参)→ topK,只返回 `status='ready'` 的文档
- **FTS5 trigram 两条硬约束**(写查询前必看):连续汉字串是一整个 phrase(等于精确子串匹配,自然语句零召回)→ 长汉字串切 3 字滑动窗口 OR;最小匹配长度 3(2 字片段必然空)
- **BigInt 主键**:vec0 的 INTEGER PRIMARY KEY 必须绑 BigInt,JS number 会被绑成 REAL 直接报错
- **鉴权**(services/auth.ts):单预设账号登录,会话 = 无状态 HMAC cookie(`用户名.过期时间.签名`,密钥由 app secret + 账号口令派生 → 改口令即时全端下线、进程重启不掉线,7 天有效);凭证与签名全走 sha256 定长摘要 + timingSafeEqual 防计时攻击;登录连错 5 次按 IP(X-Real-IP,nginx 传入)锁 2 分钟。登录/探测/登出路由注册在 requireLogin 中间件**之前**(Hono 按注册顺序执行,先命中的 handler 直接返回不会落入鉴权);`/admin` 页面本身无数据不做服务端拦截,前端探测 /session 切换登录视图

## 提醒调度器(`feishu/reminders.ts`)

混合调度模式,平衡精度与可靠性:

- **动态 setTimeout**:为"最近一条 pending"设精确触发定时器(最长 24h,超 24h 会被 Node 静默 clamp 到 1ms 导致立即触发,所以封顶 24h,触发后再 `scheduleNext` 排下一条),到点 `flushDue`,处理完再 `scheduleNext` 重排;无 pending 时零空转
- **10 分钟兜底轮询**:补动态定时器可能漏的情况(时钟漂移 / 新增提醒间未重排 / 进程恢复),同时重排动态定时器吸收新增的更早提醒
- **flushDue 互斥**(`flushing` 标志):动态定时器与兜底轮询可能重叠(单次发送窗口 2-6s),不互斥会重复发送同一条 pending
- **重启补偿**:`expireOverdueReminders(now - REMINDER_RESEND_WINDOW_MS)` 把"过期超过补偿窗口(默认30min)"的 pending 标记 `expired` 丢弃,窗口内的留给紧接的 `flushDue` 补发(防服务挂半天后重启半夜轰炸用户)
- **迟到提示**:实际触发比预定晚 >30s 时自动补一句"(抱歉,这条提醒迟到了 X 分钟)"
- **新增提醒钩子**:`llm.ts` 调用 `setOnReminderAdded(scheduleNext)`,若新增的提醒比当前定时器更早,立刻重排
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
| `is_bot` | 1=机器人/app 发的(实时事件 sender_type='bot',历史 API sender_type='app',都算);查询默认过滤 |
| `is_recalled` / `updated_at` | 撤回标记 / 更新时间 |

索引:`idx_chat_time(chat_id, create_time)` / `idx_sender` / `idx_create_time` / `idx_source` / `idx_is_bot`

### mentions

@提及表,外键 `message_id -> messages.message_id`。

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

### customer_leads

客资登记表(飞书「客资信息登记表」的事实源;双写时飞书表格是副本)。

| 字段 | 说明 |
|---|---|
| `customer_name` | 客户姓名(addLead 已剥日期前缀;bitable「客户名称」列) |
| `customer_wechat` | 客户微信 ID/账号 |
| `customer_needs` | 客户需求 |
| `customer_notes` | 客户备注(仅存 SQLite,不同步飞书表格;备注在表格里自己写) |
| `is_key_customer` | 是否重点客户(0/1) |
| `visited_store` | 是否到店(0/1) |
| `owner_open_id` / `owner_name` | 归属人 open_id(@你的人)+ 姓名冗余(v1 不阻塞填充) |
| `lead_date` | 线索日期(毫秒) |
| `feishu_record_id` | 飞书表格 record id(双写关联,UNIQUE) |
| `chat_id` / `user_open_id` / `original_message_id` | 登记消息溯源(补录场景存被回复消息 id;普通 @ 存触发消息 id) |
| `is_deleted` | 软删标记(0=正常,1=已删;统计/列表全排除) |
| `created_at` / `updated_at` | 落库/更新时间 |

索引:`idx_lead_date` / `idx_lead_chat` / `idx_lead_owner` / `idx_lead_deleted`

**入库去重**:历史补漏与实时收消息共用 `saveMessage`,靠 `message_id` 主键 `INSERT OR IGNORE` 吸收。**mentions 仅在 messages 真新增时插入**(事务包裹),避免重投递时重复落库。

## 飞书历史补漏(`feishu/history.ts`)

- **目标群**:启动时实时拉机器人所在群(`/open-apis/im/v1/chats`),自动覆盖新加入的群,解决冷启动无种子问题;API 失败时回退到库中已知 `chat_id`
- **增量起点**:从该群最后一条 `create_time` 往前回退 5 分钟重叠窗口(`OVERLAP_MS`),无记录则拉最近 7 天
- **入库**:复用实时事件 `saveMessage` 路径,标记 `source=history`,靠主键去重
- **分页**:50 条/页,最多 500 页防死循环,按 `ByCreateTimeAsc` 升序
- **补名字**:历史 API 的 sender 无姓名字段,`fetchHistoryGap` 接收 `resolveName` 回调,对每个新增用户消息按 open_id 去重批量补名(复用 handler 的 userCache),机器人/系统消息跳过

## 环境变量

`server/.env`(参考 `.env.example`):

| 变量 | 必填 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | 是 | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用 App Secret |
| `PORT` | 否 | HTTP 端口,默认 `4111` |
| `HOST` | 否 | 监听网卡,默认 `127.0.0.1`(仅本机);公网访问走 nginx 反代(见 `deploy/nginx-knowledge.conf` + `deploy/部署指南.md`) |
| `KB_ADMIN_USER` / `KB_ADMIN_PASSWORD` | 否 | 管理页登录账号/口令,默认 `shengwei` / `123456`(公网部署必须改口令,默认值启动会告警) |
| `DB_PATH` | 否 | SQLite 路径(相对 server/),默认 `./data/messages.db` |
| `ANTHROPIC_BASE_URL` | 是 | LLM 端点,指向 MiniMax(`.env.example` 默认 `https://api.minimaxi.com/anthropic`) |
| `ANTHROPIC_API_KEY` | 是 | MiniMax API Key |
| `LLM_MODEL` | 否 | 模型名,默认 `MiniMax-M3` |
| `BITABLE_CUSTOMER_APP_TOKEN` | 否 | 客资多维表格 app_token(留空 = 只入 SQLite,跳过飞书表格同步) |
| `BITABLE_CUSTOMER_TABLE_ID` | 否 | 客资多维表格 table_id |
| `BITABLE_CUSTOMER_LINK` | 否 | 客资表格链接(登记成功后「系统核对」段附上) |
| `REMINDER_RESEND_WINDOW_MS` | 否 | 提醒重启补偿窗口(毫秒,默认 1800000=30min):重启后过期但 < 该窗口的提醒补发,>= 的丢弃 |
| `KB_ENABLED` | 否 | 知识库总开关,`0` 关闭(不加载 sqlite-vec、不下发检索工具),默认开 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | 否* | 嵌入端点(OpenAI 兼容 `/v1/embeddings`),默认硅基流动 `BAAI/bge-m3` 1024 维;*开知识库且要向量检索则 KEY 必填,缺了降级为纯关键词检索 |
| `KB_CHUNK_SIZE` / `KB_CHUNK_OVERLAP` | 否 | 切片目标字符数 / 重叠,默认 400 / 60 |
| `KB_EMBED_CONCURRENCY` | 否 | 嵌入并发上限,默认 2(免费档限流,开大吃 429) |
| `KB_SEARCH_CANDIDATES` / `KB_SEARCH_TOP_K` | 否 | 检索双路各召回候选数 / 融合后返回条数,默认 20 / 5 |

## 飞书应用权限

### 基础(消息归档 + @问答 + 提醒)

- `im:message` - 接收消息事件
- `im:message.group_at_msg:readonly` / `im:message:readonly` - 读群消息
- `im:chat:readonly` - 拉机器人所在群(历史补漏用)
- `contact:user.base:readonly` - 查用户姓名(发件人缓存)
- `im:message:send_as_bot` - 以应用身份 reply 消息(@问答、提醒回复用)

### 客资同步(可选,启用飞书表格同步时需要)

- `bitable:app:readonly` / `bitable:app` - 读写客资多维表格

> 无需 `drive:drive`--客资是单向同步,不订阅云文档变更事件,不反向回写。

### 「事件订阅」配置

开长连接模式,订阅:
- `im.message.receive_v1`(消息)

把机器人加入要监听的群。

## 测试

`server/tests/` 用 `node:test` + `tsx`,零额外测试依赖,`npm test` 运行。

### toolRegistry.test.ts(事实接管与去重归一化)

- `stripAllUrls`:伪造 feishu.cn 链接、多链接、markdown 包裹均全清;无链接原样保留
- `buildSystemAttestation`:0 条写工具不追加 / 读工具不追加 / 账本空+LLM 声称成功->戳穿 / 全成功->真实条数+名字+唯一链接 / 部分成功->列成功+失败数 / 全失败->"实际未成功" / 去重跳过单独报告 / set_reminder 不贴链接 / 多工具混合各自报告
- `normalizeName`:普通空格/全角空格/Tab/换行全去;大小写保留(Y≠y);首尾 trim
- `dateKeyShanghai`:同一天不同时刻同 key / 跨零点不同 key / UTC 时间戳按北京时间归日
- `stripDatePrefix`:剥"60717/雅琴"->"雅琴"等;纯数字名"3"不剥;去重口径一致性(带前缀与纯名归一后相等)

### knowledge.test.ts(知识库纯函数)

- `chunkText`:空内容零切片 / 短文本原样 / 按句号切不硬切字符 / overlap 不丢内容 / size=0 下限保护不死循环
- `buildFtsQuery`:长中文句切 3 字滑窗 / 2 字查询返回 null / 合同号整体保留不切碎 / 标点当分隔符 / 条数上限 + 去重
- `reciprocalRankFusion`:两路都命中的排最前 / 分数符合 1/(k+rank) / 空输入

### auth.test.ts(管理端登录鉴权)

- `verifyCredentials`:账号口令全对才通过 / 大小写敏感 / 尾随空格不原谅
- `verifySession`:签名往返 / 空与乱格式拒绝 / 过期拒绝 / 篡改签名、用户名、过期时间一律拒绝 / 签名合法但用户名与配置不符(改名后旧会话作废)

> 测试文件顶部先注入测试用环境变量再动态 `import()` 被测模块(因 `toolRegistry.ts` 顶部 import `config.ts`,后者在校验 .env 时会抛错)。`knowledge.test.ts` 只测纯函数模块(ftsQuery/rank/chunker),不碰 config 与 SQLite。
