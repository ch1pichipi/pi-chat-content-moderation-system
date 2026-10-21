# chat-moderation-server 实时聊天审核与封禁服务

把原有离线日志分析工具改造成常驻 Node 服务 + 网页前端：

- 玩家在网页发送聊天消息 → 消息入库（`chat_risk_logs`，无标签）
- 后台异步调用 Pi Agent 分析该玩家最近窗口的消息
- Agent 给出风险判断与处罚建议，服务端按护栏决定最终处罚
- 命中处罚写入 `chat_player_bans`，封禁期间服务端拒绝发送（HTTP 423）
- 结果通过 SSE 实时推送到前端，支持封禁倒计时、提前解封、切换玩家

实现依据：`docs/v1/实时聊天封禁服务变更计划_v1.md`。

## 快速开始

```bash
# 1. 配置数据库（config/database.json，已 gitignore）
cp config/database.example.json config/database.json   # Windows: copy

# 2. 执行迁移（幂等，可重复执行）
npm run db:init:chat-risk

# 3. 导入 100 条历史种子日志（可选，已有可跳过）
npm run db:seed:chat-risk

# 4. 启动服务
npm run server
# 浏览器打开 http://127.0.0.1:3000
```

服务默认只监听 `127.0.0.1:3000`，不暴露公网。

### 没有可用模型时

```bash
CHAT_AGENT_MODE=mock npm run server   # 关键词 Mock，仅用于测试/联调
```

`mock` 模式的置信度上限为 0.75，不会触发 1 天以上的封禁。未设置该变量时使用 Pi 当前配置的默认模型；真实模型调用失败会自动降级到 Mock（可用 `CHAT_AGENT_FALLBACK_MOCK=0` 关闭），降级会在 `policy_note` 与 SSE 结果中标注。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHAT_SERVER_HOST` | `127.0.0.1` | 监听地址 |
| `CHAT_SERVER_PORT` | `3000` | 监听端口 |
| `CHAT_AGENT_MODE` | `pi` | `pi` / `auto`（等价 pi）/ `mock` |
| `CHAT_AGENT_MODEL` | 空 | `provider/model`；留空用 Pi 默认模型 |
| `CHAT_AGENT_TIMEOUT_MS` | `20000` | 单次 Agent 调用超时，超时不封禁 |
| `CHAT_AGENT_CONCURRENCY` | `2` | 全局 Agent 并发上限 |
| `CHAT_AGENT_FALLBACK_MOCK` | `1` | Agent 失败时是否降级到 Mock |
| `CHAT_ANALYSIS_WINDOW_MINUTES` | `10` | 分析窗口分钟数 |
| `CHAT_ANALYSIS_MAX_MESSAGES` | `50` | 分析窗口最大消息数（超出丢最早） |
| `CHAT_ANALYSIS_LOOKBACK_HOURS` | `24` | 历史风险/封禁统计回看小时数 |
| `CHAT_ANALYSIS_DEBOUNCE_MS` | `1500` | 同账号连续消息防抖 |
| `CHAT_MESSAGE_MAX_LENGTH` | `2000` | 单条消息长度上限 |
| `CHAT_POLICY_PATH` | `config/moderation-policy.json` | 处罚护栏策略文件 |

数据库连接沿用 `code/shared/lib/tools/chat_risk_log_scope/db/client.ts` 的规则：
环境变量 `CHAT_RISK_DB_*` > `config/database.json` > 内置默认值。

## 目录结构

```text
code/apps/chat-moderation-server/
├── index.ts                  # 服务入口（启动、优雅退出）
├── config.ts                 # 端口/窗口/Agent 配置
├── events.ts                 # SSE 事件与对外视图类型
├── http/
│   ├── server.ts             # Node http：静态页面 + API
│   ├── routes.ts             # REST 路由
│   └── sse.ts                # SSE 广播中心
├── services/
│   ├── account-queue.ts      # 按账号串行 + 防抖 + 全局并发（纯逻辑，可单测）
│   ├── analysis-service.ts   # 取窗口、调 Agent、执行护栏、写库、推送
│   ├── ban-service.ts        # 封禁视图、历史摘要
│   ├── message-service.ts    # 发消息、封禁校验、内容校验
│   └── player-service.ts     # 玩家列表 / 聊天记录 / 状态
├── agent/
│   ├── judge.ts              # Pi SDK 调用、超时、严格 JSON 解析
│   ├── prompt.ts             # 审核 Prompt
│   ├── policy.ts             # 处罚护栏（纯函数）
│   ├── mock.ts               # 关键词 Mock（测试/降级）
│   └── types.ts              # Agent 输入输出结构
├── public/                   # index.html / app.js / style.css（零构建）
└── __tests__/                # 单元测试 + DB 集成测试
```

数据库层复用并扩展了共享工具：

- `db/migrations/002_player_bans.sql`：封禁表
- `db/migrations/003_judgement_policy.sql`：判断结果处罚审计字段
- `db/bans.ts`、`db/messages.ts`、`db/judgements.ts`

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/players?limit=100` | 玩家列表、最后消息时间、当前封禁 |
| GET | `/api/players/:account/messages?limit=50` | 最近聊天记录 |
| POST | `/api/players/:account/messages` | 发送消息；封禁中返回 423 |
| GET | `/api/players/:account/status` | 封禁状态与剩余秒数 |
| POST | `/api/players/:account/unban` | 提前解封 |
| GET | `/api/events` | SSE：hello / message_created / analysis_started / analysis_completed / analysis_failed / ban_started / ban_lifted |
| GET | `/api/health` | 健康检查与运行配置 |

发送成功返回 `202 Accepted`，此时仅代表消息已入库，分析结果通过 SSE 推送。

## 处罚护栏

- Agent 只给建议，服务端只降级、不升级。
- 处罚上限由三者取最小：风险类型严重度、置信度区间、最近 24h 历史封禁数。
- 永久封禁必须同时满足：`critical` 风险 + 置信度 ≥ 0.95 + 有前科（默认 2 次；1 次前科时只允许 `critical`）。
- JSON 解析失败、字段缺失、动作非法、超时、`is_risk` 与 `reason` 自相矛盾：一律不封禁，写入 `action=人工复核` 的判断记录。
- 审计字段 `punishment_requested` / `punishment_applied` / `ban_seconds` / `policy_adjusted` / `policy_note` 记录降级过程。

阈值在 `config/moderation-policy.json` 中调整，调整后必须更新
`__tests__/policy.test.ts`，避免误封。

## 测试

```bash
npm run typecheck                       # 共享工具 + 服务
npm test                                # 单元测试（不连库）
CHAT_RISK_DB_TEST=1 npm test            # 含数据库集成测试（会写入并清理测试账号数据）
```

服务侧测试覆盖：

- 处罚护栏（计划 4.4.6 全部示例、永久封禁条件、异常输入）
- Agent 输出解析（合法 JSON、Markdown 包裹、多余文字、非法字段）
- 队列防抖/串行/并发/停止
- 配置解析与校验
- 封禁表与判断审计字段（DB）
- 端到端：发消息 → 分析 → 封禁 → 423 → 解封 → 恢复（DB + HTTP）

## 排查

| 现象 | 处理 |
| --- | --- |
| 启动报 `chat_player_bans 表不存在` | 执行 `npm run db:init:chat-risk` |
| 前端一直"分析中" | 查看服务端日志；Agent 超时会推送 `analysis_failed` 并转人工复核 |
| 发送一直返回 423 | 在页面点"提前解封"，或检查 `chat_player_bans` 中 active 记录 |
| Agent 无可用模型 | 检查 `~/.pi/agent/models.json` / `auth.json`，或临时用 `CHAT_AGENT_MODE=mock` |
| 想确认护栏是否生效 | 查询 `chat_risk_judgements` 的 `punishment_requested` / `punishment_applied` / `policy_note` |
