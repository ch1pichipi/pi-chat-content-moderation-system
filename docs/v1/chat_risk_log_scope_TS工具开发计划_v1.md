# chat_risk_log_scope TypeScript 工具开发计划（v1）

- 版本：v1
- 日期：2026-10-20
- 目标项目：`pi-chat-content-moderation-system`
- 参考项目：`D:\projects\chat_risk_log_scope`（Go 实现）
- 落地目录：`code/shared/lib/tools/chat_risk_log_scope`
- 调用方：内容审核智能体（基于 `@earendil-works/pi-coding-agent`）

---

## 1. 背景与目标

参考项目 `chat_risk_log_scope` 是一个用 Go 编写的聊天风险日志分析 CLI，具备以下能力：

1. 读取 CSV / JSON 聊天风险日志，字段容错。
2. 风险日志汇总统计。
3. AI 辅助判断（Claude API，失败时降级为规则/Mock）。
4. 重点账号聚合与处置建议。
5. 典型样本提取（5 类用途）。
6. 疑似误杀排查。
7. 生成 Markdown 分析报告。
8. 增量处理（watch + 状态文件）。

本项目需要把上述能力以 **纯 TypeScript** 的形式移植到：

```text
code/shared/lib/tools/chat_risk_log_scope/
```

并封装成智能体可调用的工具，让审核智能体直接获得结构化统计、重点账号、疑似误杀和报告，而不是让模型自己读大文件、手工统计。

**核心目标：**

- 功能对齐 Go 版本，保留关键业务规则与输出结构。
- 提供两个明确入口：**整份日志分析** 与 **单条消息分析**。
- v1 判断统一使用 `mock` 规则，不接入外部大模型 API。
- 默认脱敏、只读输入、受控落盘，符合内容审核场景的安全要求。
- 可单元测试、可回归测试、可与 Go 版本做结果对拍。

---

## 2. 本期决策与范围

### 2.1 已确认决策

| 编号 | 决策 |
| --- | --- |
| 1 | v1 使用 `mock` 规则判断，不接入 Claude API；保留 `Judge` 接口，真实模型判断放入 v2 |
| 2 | 设计两个入口：`chat_risk_log_scope_analyze_file`（整份日志）与 `chat_risk_log_scope_judge_message`（单条消息） |
| 3 | 报告固定写入 `reports/`，文件名自动追加时间戳 |
| 4 | v1 不加入时间/账号/reason/区服筛选，移至 v2 |
| 5 | 接受新增本地 devDependencies：`typescript`、`@types/node`，以及直接依赖 `typebox` |

### 2.2 本期包含（v1）

- Core 分析链路：加载 → 统计 → 风险映射 → Mock 判断 → 误杀 → 账号 → 样本 → 报告。
- CSV / JSON 读取与容错解析。
- 整份日志分析入口，支持单次全量与游标式增量。
- 单条消息分析入口：支持已有原判定信息和纯文本消息两种用法。
- 阈值、reason 映射、样本数量、脱敏、消息截断等配置。
- Mock 消息关键词规则与文本归一化（防简单规避）。
- Markdown 报告渲染；默认返回文本，可选写入 `reports/`。
- 两个智能体工具定义、参数 Schema、结构化返回值。
- 单元测试、固定样例回归测试、Go/TS 对拍脚本。
- 使用说明 README。

### 2.3 本期不包含（v2 候选）

- Claude / 其他大模型真实判断。
- AI 判断结果缓存（v1 无网络调用，不需要）。
- 后台常驻 watch 轮询（改为每次调用处理一批增量）。
- 时间/账号/reason/区服筛选。
- 相似消息聚类（Go 版本本身未实现）。
- HTML / CSV / PDF 报告导出。
- Web UI / 可视化。
- 数据库或消息队列接入。
- 多租户权限体系。

---

## 3. 现状分析

### 3.1 参考项目模块清单

| Go 模块 | 职责 | v1 是否移植 |
| --- | --- | --- |
| `internal/model` | 数据结构、风险动作枚举 | 是 |
| `internal/loader` | CSV/JSON 解析、时间解析、字段容错 | 是 |
| `internal/riskmap` | reason → 中文标签、从严处置动作 | 是 |
| `internal/stats` | 汇总统计 | 是 |
| `internal/ai/mock` | 规则判断 | 是，并扩展单条消息关键词判断 |
| `internal/ai/claude` | Claude 调用、重试、并发、降级 | 否（v2） |
| `internal/ai/cache` | SHA-256 缓存 | 否（v2） |
| `internal/falsepositive` | 疑似误杀规则 | 是 |
| `internal/account` | 重点账号聚合、重复违规 | 是 |
| `internal/sample` | 5 类典型样本 | 是 |
| `internal/mask` | 账号脱敏、文本截断 | 是 |
| `internal/config` | 配置加载、密钥安全校验 | 是（改为 TS 配置对象） |
| `internal/report` | Markdown 报告 | 是 |
| `internal/state` | 增量状态 | 是（改造为游标式） |
| `cmd/chatrisk` | CLI 编排 | 改为 `analyze.ts` + Tool 适配 |
| `cmd/gendata` | 测试数据生成 | 否，复用现有 testdata |
| watch 模式 | 长驻轮询 | 否，改为显式增量调用 |

### 3.2 目标项目现状

- `code/shared/lib/tools/chat_risk_log_scope/` 当前为空目录。
- 根目录 `package.json` 已有 `@earendil-works/pi-coding-agent` 与 `tsx`，无 TypeScript 配置、无测试脚本。
- 已存在审核人设与输出规范：`code/prompts/analyst/*.md`。
- `pi-coding-agent` 的工具注册方式为：

```ts
pi.registerTool({
  name: "...",
  description: "...",
  parameters: Type.Object({ ... }),
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... }
});
```

因此本工具需要同时提供：

1. **纯函数 API**：便于单测、被其他 TS 代码复用。
2. **两个 ToolDefinition**：供 `pi.registerTool` 注册。
3. **默认导出的 Extension Factory**：便于作为 pi 扩展加载。

---

## 4. 总体方案

### 4.1 方案选型

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A. TS 全量重写 | 按 Go 模块逐层移植为纯 TS | **采用** |
| B. TS 包装 Go 二进制 | 子进程调用 `chatrisk` | 不采用：部署重、跨平台差、Agent 环境不稳 |
| C. 只做统计 | 由 Agent 自身判断 | 部分采用：v1 用 Mock 规则完成基线判断 |

### 4.2 分层设计

```text
┌─────────────────────────────────────────────┐
│ Tool Adapters                               │
│ - analyze-file.tool.ts                      │
│ - judge-message.tool.ts                     │
│ - 参数校验、路径安全、结果格式化、错误映射     │
├─────────────────────────────────────────────┤
│ Orchestration                               │
│ - analyze.ts：整份日志分析编排                │
│ - judge-message.ts：单条消息判断编排          │
├─────────────────────────────────────────────┤
│ Domain Core                                 │
│ - stats / account / sample / false-positive │
│ - risk-map / mask                           │
├─────────────────────────────────────────────┤
│ Infrastructure                              │
│ - loader(csv/json/time)                     │
│ - ai(mock / mock-keywords)                  │
│ - incremental state                         │
│ - report render                             │
└─────────────────────────────────────────────┘
```

**设计原则：**

- Domain Core 全部为纯函数或显式依赖注入，便于测试。
- 文件 IO 放在 Infrastructure，不与统计规则耦合。
- Tool Adapter 只做参数转换、安全校验和输出裁剪，不写业务规则。
- v1 默认无网络请求；默认不写文件，只有显式 `writeReport` 才落盘。
- 所有时间解析使用本地时区语义，与 Go 版本保持一致。

### 4.3 目录结构

```text
code/shared/lib/tools/chat_risk_log_scope/
├── index.ts                     # 默认导出 Extension Factory；注册两个工具
├── tools/
│   ├── analyze-file.tool.ts     # 整份日志分析工具
│   ├── judge-message.tool.ts    # 单条消息分析工具
│   └── schema.ts                # TypeBox 参数 Schema
├── analyze.ts                   # 整份日志分析编排
├── judge-message.ts             # 单条消息判断编排
├── types.ts                     # LogEntry / Summary / Judgement / Report 等
├── config.ts                    # 默认配置、配置合并、参数归一化
├── risk-map.ts                  # reason 默认映射 + SevereAction
├── stats.ts                     # 汇总统计
├── mask.ts                      # 账号脱敏、Unicode 截断
├── false-positive.ts            # 疑似误杀规则
├── account.ts                   # 账号聚合、重复违规、处置推荐
├── sample.ts                    # 典型样本提取
├── loader/
│   ├── index.ts                 # 按扩展名分发
│   ├── csv.ts                   # RFC4180 容错 CSV
│   ├── json.ts                  # 宽松 JSON 解析
│   └── time.ts                  # 多格式时间解析
├── ai/
│   ├── index.ts                 # Judge 接口（v2 扩展点）
│   ├── mock.ts                  # 原判定规则判断 + 单条消息判断
│   └── mock-keywords.ts         # 默认关键词、文本归一化、命中评分
├── report/
│   └── render.ts                # Markdown 报告渲染
├── incremental/
│   └── state.ts                 # 增量游标读写（原子写入）
├── __fixtures__/                # 从 Go testdata 复制的样例
└── README.md                    # 使用说明、参数、安全约束
```

---

## 5. Agent 工具契约

### 5.1 入口一：`chat_risk_log_scope_analyze_file`

分析整份日志文件（或内联 CSV/JSON），执行完整分析链路。

#### 参数

```ts
{
  source: {
    kind: "file" | "inline",
    path?: string,          // kind=file 时必填
    content?: string,       // kind=inline 时必填
    format?: "csv" | "json" // inline 时必填；file 时按扩展名
  },
  options?: {
    highConfidence?: number,       // 默认 0.8
    lowConfidence?: number,        // 默认 0.5
    repeatWindowMinutes?: number,  // 默认 60
    topN?: number,                 // 默认 5
    noMask?: boolean,              // 默认 false
    messageMaxLength?: number,     // 默认 200
    reasonMap?: Record<string, string>
  },
  incremental?: {
    enabled?: boolean,              // 默认 false
    stateFile?: string,             // 默认 .cache/chat_risk_scope_state.json
    limit?: number                  // 默认 100
  },
  output?: {
    format?: "json" | "markdown",   // 默认 markdown
    writeReport?: boolean           // 默认 false
  }
}
```

#### 行为

1. 读取并解析 CSV / JSON。
2. 若 `incremental.enabled=true`：
   - 读取状态文件中的 `lastTime`。
   - 仅处理 `createTime > lastTime` 的记录。
   - 按 `createTime` 升序、最多 `limit` 条。
   - 成功后保存新游标 `maxTime + 1ms`。
3. 统计与风险映射。
4. 对风险日志执行 Mock 判断。
5. 生成疑似误杀、重点账号、典型样本。
6. 返回结构化结果；`output.format=markdown` 时同时返回报告文本。
7. `writeReport=true` 时写入：

```text
reports/chat_risk_report_YYYYMMDD_HHmmss.md
```

增量模式文件名追加 `_seqN`，N 为本次进程内的处理批次序号。

#### 返回值

- `content`：Markdown 报告或紧凑 JSON。
- `details`：

```ts
{
  summary: Summary,
  riskDistribution: Array<{ reason: number, label: string, count: number, ratio: number }>,
  accounts: AccountSummary[],
  samples: Sample[],
  falsePositives: FalsePositiveItem[],
  judgementsSummary: {
    total: number,
    degradedCount: number,
    falsePositiveCount: number,
    actionCounts: Record<SuggestedAction, number>
  },
  warnings: string[],
  meta: {
    source: string,
    totalEntries: number,
    processedEntries: number,
    masked: boolean,
    judgeMode: "mock",
    reportPath?: string,
    elapsedMs: number
  }
}
```

---

### 5.2 入口二：`chat_risk_log_scope_judge_message`

只分析调用方输入的单条消息，不读日志文件。

#### 参数

```ts
{
  message: string,

  // 可选：如果调用方已有原系统判定信息，则走与日志分析完全一致的 MockJudge
  reason?: number,
  confidence?: number,
  level?: string,

  // 可选：上下文消息
  contextMessages?: string[],

  // 可选：附加信息
  account?: string,
  nickname?: string,

  options?: {
    highConfidence?: number,   // 默认 0.8
    lowConfidence?: number,    // 默认 0.5
    noMask?: boolean,          // 默认 false
    messageMaxLength?: number, // 默认 200
    reasonMap?: Record<string, string>
  }
}
```

#### 两种判断路径

**路径 A：带 `reason` + `confidence`**

直接复用 Go 版本 `MockJudge` 的分支逻辑，保证与日志分析结果一致：

- `confidence < lowConfidence` → 疑似误杀，建议人工复核。
- `confidence >= highConfidence` → 维持原判定，按 `SevereAction(reason)` 从严处置。
- 中间区间 → 命中误判关键词则观察/疑似误杀，否则观察。

**路径 B：只有 `message`（推荐 Agent 使用）**

使用 Mock 关键词规则做启发式判断：

1. 文本归一化：
   - Unicode NFKC。
   - 全角转半角。
   - 转小写。
   - 去除零宽字符、重复分隔符。
   - 生成去空格/去符号的"压缩文本"用于规避匹配。
2. 按 reason 分组匹配默认关键词，例如：
   - `5` 广告诈骗：代练、外挂、私服、加群、加微信、加QQ、返利、低价出售、收号、卖号。
   - `3` 侮辱谩骂：常见辱骂词与变体。
   - `6` 运营规避：私聊、加我、联系方式、VX、威信。
   - `1/2/4/7` 保留可配置关键词，默认不内置高危敏感词。
3. 命中计分：
   - 取命中次数最高的 reason 作为 `reason`。
   - `confidence = min(0.95, 0.5 + 0.1 × 命中次数)`。
   - 无命中 → `reason = -1`，`confidence = 0`，建议放行。
4. 处置动作复用 `risk-map.ts` 的统一规则。
5. 所有结果 `degraded = true`，并在结果中标注 `mock`。

> 说明：路径 B 是关键词启发式，不具备语义理解能力；低置信度或疑似场景应建议人工复核，不能作为自动处罚的唯一依据。

#### 返回值

- `content`：简短结论文本（含风险类型、置信度、建议动作、命中关键词）。
- `details`：

```ts
{
  judgement: {
    entryId: string,
    aiLabel: string,
    aiReason: string,
    isFalsePositive: boolean,
    suggestedAction: SuggestedAction,
    degraded: true,
    matchedKeywords: string[],
    inferredReason: number,
    inferredConfidence: number
  },
  warnings: string[],
  meta: {
    judgeMode: "mock",
    masked: boolean,
    elapsedMs: number
  }
}
```

---

### 5.3 注册方式

`index.ts` 同时提供：

```ts
// 纯 API
export { analyzeFile } from "./analyze.ts";
export { judgeMessage } from "./judge-message.ts";
export { analyzeFileTool, judgeMessageTool } from "./tools/index.ts";

// pi 扩展
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { analyzeFileTool, judgeMessageTool } from "./tools/index.ts";

export default function registerChatRiskLogScope(pi: ExtensionAPI) {
  pi.registerTool(analyzeFileTool);
  pi.registerTool(judgeMessageTool);
}
```

后续可在 `.pi/extensions/` 或项目统一扩展入口中加载该文件。

---

## 6. 模块迁移映射

| 参考实现 | TS 实现 | 关键对齐点 |
| --- | --- | --- |
| `model.LogEntry` | `types.ts` | 字段名保持 snake_case 输入兼容 |
| `loader.LoadCSV/JSON` | `loader/csv.ts`、`loader/json.ts` | 表头大小写不敏感、缺列容错、坏行跳过并记录 warning |
| `loader.parseTime` | `loader/time.ts` | 11 种时间格式、本地时区 |
| `riskmap.DefaultMap` | `risk-map.ts` | 11 种 reason 标签完全一致 |
| `riskmap.SevereAction` | `risk-map.ts` | 处置动作映射完全一致 |
| `stats.Summarize` | `stats.ts` | 总数/风险数/高置信/低置信/账号数/区服数 |
| `mask.Account/Truncate` | `mask.ts` | 按 Unicode code point 处理，短账号全掩码 |
| `falsepositive.Evaluate` | `false-positive.ts` | 三条命中规则与文案一致 |
| `account.Aggregate` | `account.ts` | 主要风险类型、重复违规窗口、推荐动作 |
| `sample.Extract` | `sample.ts` | 5 类样本、TopN、排序规则 |
| `ai.MockJudge` | `ai/mock.ts` | 阈值分支与误判关键词一致 |
| `ai.ClaudeJudge` | v2 | v1 不实现 |
| `ai.Cache` | v2 | v1 无网络调用，不需要 |
| `config.Load` | `config.ts` | 默认值一致；改为 TS 对象 |
| `report.Generate` | `report/render.ts` | 7 段结构、表格字段、脱敏/截断 |
| `state.State` | `incremental/state.ts` | last_time + report_seq，原子写入 |
| `cmd/chatrisk analyze` | `analyze.ts` | 单次全量链路 |
| `cmd/chatrisk --watch` | `analyze-file.incremental` | 单批处理，不常驻 |

---

## 7. 关键实现细节

### 7.1 加载与容错

- CSV 使用自实现 RFC4180 解析器，避免新增运行时依赖。
- 表头按小写列名匹配，列顺序任意，缺失列使用默认值。
- 以下情况不中断，写入 `warnings`：
  - 缺 `id` / `account`
  - `reason` 非法（降级为 `-1`）
  - `confidence` 非法（置 `0`）
  - 时间无法解析
  - `context_messages` 格式异常
- 空文件、无数据行、格式不支持 → 抛错，返回 `isError: true`。
- 单文件默认上限：`20MB` / `100,000` 行；超出时明确报错，避免 Agent 卡死。

### 7.2 时间与增量

- 支持与 Go 一致的 11 种格式，使用本地时区。
- 增量游标条件：`createTime > lastTime`，按时间升序处理。
- 保存游标时使用 `maxTime + 1ms`，避免同毫秒边界重复。
- `report_seq` 每次进程启动从 0 开始，与 Go 版本一致。
- 状态文件采用 `写临时文件 → rename` 原子替换。

### 7.3 Mock 判断

**日志条目判断：**

- 完全复刻 Go `MockJudge` 的阈值分支和文案。
- 所有结果 `degraded = true`。

**单条消息判断：**

- 带 `reason` + `confidence` 时走上述日志条目逻辑。
- 纯消息时走 `mock-keywords.ts`：
  - 归一化 + 关键词命中。
  - 输出推断 reason、confidence、命中词。
  - 无命中返回正常。
- 关键词表支持后续配置扩展；v1 内置广告、辱骂、运营规避等通用词，避免内置不可控的高危词。

### 7.4 脱敏与文本处理

- `mask.Account`：保留首尾字符，中间用 `*`；长度 ≤2 全部掩码。
- `mask.Truncate`：按 code point 截断，追加 `…`。
- 报告和 Tool 返回文本默认脱敏、截断。
- 单条消息判断结果默认不返回完整原文，只返回命中关键词和结论。

### 7.5 报告

- 使用 TS 模板字符串渲染，不移植 Go `text/template`。
- 保持 7 段结构：
  1. 本次日志概览
  2. 风险类型分布
  3. 重点账号列表
  4. 典型样本
  5. 疑似误杀样本
  6. 处置建议
  7. 后续优化建议
- 默认只在返回值中输出 Markdown，不落盘。
- `writeReport=true` 时：
  - 固定写入 `reports/`，不接受自定义目录。
  - 文件名：`chat_risk_report_YYYYMMDD_HHmmss.md`。
  - 增量模式追加 `_seqN`。
  - 若同名文件已存在，追加 `_1`、`_2` 避免覆盖。

---

## 8. 安全与合规要求

1. **路径安全**
   - `source.path` 必须解析到工作区根目录内。
   - 拒绝 `..`、绝对路径逃逸、符号链接逃逸。
   - 报告目录固定为 `reports/`，不接受外部路径。
   - 默认只读输入；只有显式 `writeReport` 才写文件。

2. **默认脱敏**
   - `noMask` 默认 `false`。
   - 账号保留首尾字符，中间用 `*`。
   - 消息按 `messageMaxLength` 截断。
   - 报告与 Tool 返回文本均脱敏。

3. **无外部数据外发**
   - v1 不联网、不读取 API Key。
   - 后续接入 Claude 时，必须显式开启并单独做合规评估。

4. **数据处理边界**
   - 默认不将日志原文写入磁盘。
   - 报告写入需用户显式开启。
   - 工具参数中的消息内容只用于本次判断，不落盘。

5. **资源限制**
   - 文件大小、行数、增量条数、消息长度均有上限。
   - 支持 `AbortSignal`，Agent 取消时停止处理。

---

## 9. 测试计划

### 9.1 测试工具

- Node 22 内置 `node:test` + `node:assert/strict`。
- 通过 `tsx` 运行 TS 测试：

```json
{
  "scripts": {
    "test:chat-risk": "node --import tsx --test \"code/shared/lib/tools/chat_risk_log_scope/**/*.test.ts\"",
    "typecheck:chat-risk": "tsc --noEmit -p code/shared/lib/tools/chat_risk_log_scope/tsconfig.json"
  }
}
```

新增本地 devDependencies：`typescript`、`@types/node`；新增直接依赖：`typebox`。

### 9.2 单元测试清单

| 模块 | 测试点 |
| --- | --- |
| `loader/csv` | 正常表头、乱序表头、缺列、坏行、空文件、引号/逗号转义 |
| `loader/json` | 数组、数字/字符串混用、context 数组/分隔字符串、空文件 |
| `loader/time` | 11 种格式、毫秒/微秒/纳秒、非法时间、本地时区 |
| `risk-map` | 11 种 reason、未知 reason、SevereAction 全分支 |
| `stats` | 阈值边界 0.5/0.8、空账号、区服去重、占比 |
| `mask` | ASCII/中文/emoji、长度 ≤2、noMask、截断 |
| `false-positive` | 三条规则独立命中、组合命中、无命中 |
| `account` | 分组、最新昵称、主要 risk 平票、重复窗口、推荐动作 |
| `sample` | 5 类样本、排序、TopN 越界、缺失 judgement |
| `ai/mock` | 日志：正常/低/高/中间区间；消息：命中/无命中/多类型命中/归一化规避 |
| `judge-message` | 带原判定、纯消息、上下文、空消息、超长消息 |
| `report` | 7 段完整、空数据、脱敏、截断 |
| `incremental` | 游标过滤、同毫秒边界、状态损坏、原子写入 |
| `tools` | 参数校验、路径逃逸、文件超限、取消信号、错误映射 |

### 9.3 回归与对拍

1. 从参考项目复制：
   - `testdata/sample_logs.csv`
   - `testdata/sample_logs.json`
   - `reports/example_report.md`（如有）
2. 用 Go 版本在 `--mock` 模式生成基准结果：
   - 统计 JSON
   - 账号列表
   - 样本列表
   - 疑似误杀列表
3. TS 版本对同一输入生成同结构结果，做字段级对比。
4. 允许的差异：
   - 浮点格式
   - 报告中的生成时间
   - 排序稳定性差异（必须逐一确认）

### 9.4 E2E

- 阶段 1：直接调用两个 `ToolDefinition.execute()`，校验 `content` 与 `details`。
- 阶段 2：在 pi SDK 测试会话中加载扩展，验证两个工具可被发现、可被调用。
- 阶段 3：
  - 日志样例跑通全量分析与增量分析。
  - 单条消息跑通"带原判定"和"纯文本"两种路径。

### 9.5 真实测试用例目录与命名

真实用例分三类存放：**输入样本**、**期望输出**、**测试代码**。

```text
code/shared/lib/tools/chat_risk_log_scope/
├── __tests__/
│   ├── unit/
│   │   ├── loader.csv.test.ts
│   │   ├── loader.json.test.ts
│   │   ├── loader.time.test.ts
│   │   ├── risk-map.test.ts
│   │   ├── stats.test.ts
│   │   ├── mask.test.ts
│   │   ├── false-positive.test.ts
│   │   ├── account.test.ts
│   │   ├── sample.test.ts
│   │   ├── mock.test.ts
│   │   └── report.test.ts
│   ├── integration/
│   │   ├── analyze-file.real.test.ts
│   │   ├── judge-message.real.test.ts
│   │   └── incremental.real.test.ts
│   └── helpers/
│       └── load-fixture.ts
└── __fixtures__/
    ├── README.md
    ├── logs/
    │   ├── sample/
    │   │   ├── sample_logs.csv
    │   │   └── sample_logs.json
    │   ├── real/
    │   │   ├── game_chat_20261020_100.csv
    │   │   └── game_chat_20261020_100.json
    │   └── private/                  # 原始真实日志，仅本地，必须 gitignore
    ├── messages/
    │   ├── ad_real_20261020.jsonl
    │   ├── abuse_real_20261020.jsonl
    │   └── normal_real_20261020.jsonl
    └── expected/
        ├── game_chat_20261020_100.expected.summary.json
        ├── game_chat_20261020_100.expected.accounts.json
        ├── game_chat_20261020_100.expected.samples.json
        ├── game_chat_20261020_100.expected.false-positive.json
        └── game_chat_20261020_100.expected.report.md
```

**命名规则：**

- 日志输入：`<场景>_<日期>_<条数>.csv|json`，例如 `game_chat_20261020_100.csv`。
- 单条消息用例：`<风险类别>_<日期>.jsonl`，每行一个独立用例。
- 期望输出：与输入同 basename，追加 `.expected.<模块>.json` 或 `.expected.report.md`。
- 单元测试：`<模块名>.test.ts`，与模块名一一对应。
- 集成测试：`<工具名>.real.test.ts`。
- 原始未脱敏日志必须放在 `__fixtures__/logs/private/` 并加入 `.gitignore`；脱敏后才能移入 `logs/real/`。

**单条消息 JSONL 格式：**

```json
{"id":"ad_001","message":"...","contextMessages":["..."],"reason":5,"confidence":0.86,"expected":{"reason":5,"action":"观察","isFalsePositive":false}}
{"id":"normal_001","message":"...","contextMessages":[],"expected":{"reason":-1,"action":"放行","isFalsePositive":false}}
```

`__fixtures__/README.md` 需记录每个用例的来源、采集日期、脱敏方式、用途和期望结果说明。

---

## 10. 实施计划（检查清单）

### 阶段 0：脚手架与基准（0.5 天）

- [x] `C0-1` 创建目录结构与 `tsconfig.json`。
- [x] `C0-2` 复制 Go 样例数据到 `__fixtures__/`。
- [x] `C0-3` 增加 `typescript`、`@types/node`、`typebox` 依赖及测试脚本。
- [x] `C0-4` 用 Go 版本生成 mock 模式基准输出。

**验收：** 空项目可运行 `test:chat-risk` 与 `typecheck`。

### 阶段 1：基础领域层（1 天）

- [x] `C1-1` `types.ts`：LogEntry、AIJudgement、Summary、AccountSummary、Sample、FalsePositiveItem、AnalysisResult。
- [x] `C1-2` `loader/time.ts` + 单测。
- [x] `C1-3` `loader/csv.ts` + 单测。
- [x] `C1-4` `loader/json.ts` + 单测。
- [x] `C1-5` `risk-map.ts` + 单测。
- [x] `C1-6` `stats.ts` + 单测。
- [x] `C1-7` `mask.ts` + 单测。

**验收：** 从两份 fixture 读出的条目数与 Go 版本一致；统计结果一致。

### 阶段 2：业务规则层（1 天）

- [x] `C2-1` `false-positive.ts` + 单测。
- [x] `C2-2` `account.ts` + 单测。
- [x] `C2-3` `sample.ts` + 单测。
- [x] `C2-4` `config.ts`：默认值、合并、参数归一化。

**验收：** 账号、样本、误杀结果与 Go 基准一致；未知 reason 不崩溃。

### 阶段 3：Mock 判断层（1 天）

- [x] `C3-1` `ai/index.ts`：Judge 接口（v2 扩展点）。
- [x] `C3-2` `ai/mock.ts`：日志条目判断 + 单条消息判断。
- [x] `C3-3` `ai/mock-keywords.ts`：归一化、默认词表、命中评分。
- [x] `C3-4` 单测：阈值边界、关键词命中、规避变体、无命中。

**验收：** 日志判断与 Go 版本一致；单条消息可输出可解释的 reason/confidence/action。

### 阶段 4：报告与增量（0.5 天）

- [x] `C4-1` `report/render.ts` + 单测。
- [x] `C4-2` `incremental/state.ts` + 单测。
- [x] `C4-3` 固定 `reports/` 路径与时间戳命名。
- [x] `C4-4` 增量流程集成测试。

**验收：** 报告 7 段完整；增量不重复处理边界记录。

### 阶段 5：Tool 适配与注册（0.5 天）

- [x] `C5-1` `analyze.ts`：整份日志分析编排。
- [x] `C5-2` `judge-message.ts`：单条消息判断编排。
- [x] `C5-3` `tools/schema.ts` + 两个 ToolDefinition。
- [x] `C5-4` `index.ts`：默认导出 Extension Factory，注册两个工具。
- [x] `C5-5` 路径安全、文件大小、行数限制、AbortSignal、报告落盘。

**验收：** 两个 Tool 可被 pi 发现；参数错误返回可读错误；默认不写文件、不联网。

### 阶段 6：测试与对拍（1 天）

- [x] `C6-1` 单元测试覆盖率 ≥ 80%。
- [x] `C6-2` Go/TS 基准对拍。
- [x] `C6-3` pi SDK 内两个工具调用 E2E。
- [x] `C6-4` 大文件/超限/恶意路径/取消等异常测试。
- [x] `C6-5` 修复差异并记录。

**验收：** 所有测试通过；关键结果无不可解释差异。

### 阶段 7：文档与审查（0.5 天）

- [x] `C7-1` README：两个入口、参数、示例、限制、安全说明。
- [x] `C7-2` 在项目文档中记录工具加载方式。
- [x] `C7-3` 代码审查：类型、错误处理、安全、可读性。
- [x] `C7-4` 更新 v1 计划状态。

**验收：** 新同学可照 README 调用；安全项逐条确认。

**总工期预估：约 5 ~ 6 个工作日。**

---

## 11. 验收标准（Definition of Done）

- [x] 支持 CSV / JSON 输入，字段容错行为与 Go 版本一致。
- [x] 正确识别 11 种 reason 风险类型。
- [x] 整份日志入口输出统计、风险分布、重点账号、样本、疑似误杀、报告。
- [x] 单条消息入口支持"带原判定"和"纯文本关键词"两种判断路径。
- [x] Mock 日志判断结果与 Go 版本一致。
- [x] 7 段 Markdown 报告完整。
- [x] 增量模式按 `create_time` 游标处理，不重复、不丢数据。
- [x] 报告固定写入 `reports/`，文件名带时间戳。
- [x] 两个 Tool 参数 Schema 明确，错误可读。
- [x] 默认脱敏、默认不落盘、v1 不联网。
- [x] 单元测试 + 回归测试 + E2E 全部通过。
- [x] README 完成，安全限制写明。

---

## 12. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| TS 与 Go 的 Unicode/时间/CSV 行为差异 | 结果不一致 | 对拍 + 固定样例 + 边界单测 |
| 单条消息关键词规则过粗 | 误判/漏判 | 结果标注 mock；低置信度建议人工复核；词表可扩展 |
| 大文件导致内存/超时 | Agent 卡死 | 文件大小/行数上限 + 超时 + AbortSignal |
| 日志含 PII 被写入报告 | 合规风险 | 默认脱敏、默认不落盘 |
| 路径穿越或任意写 | 安全问题 | 工作区路径校验 + 固定 `reports/` 目录 |
| 增量状态损坏 | 重复/漏处理 | 容错读取、原子写入、损坏时明确报错 |
| 依赖未声明（typebox） | 安装后运行失败 | 已在 v1 显式声明直接依赖 |

---

## 13. 后续增强（v2）

1. Claude / 其他大模型真实判断，保留 Judge 接口接入。
2. AI 判断结果缓存（SHA-256 key + 原子写入）。
3. 相似消息聚类与运营处置样本。
4. 时间/账号/reason/区服筛选与更细粒度聚合（频道、时段）。
5. 报告模板可配置。
6. HTML / CSV 导出。
7. 与审核工单系统联动，生成处置任务。
8. 人工复核反馈闭环，校正误杀规则。
9. 流式解析与百万级日志处理。

---

## 14. 已确认事项

1. v1 判断模式：`mock`。
2. 工具入口：整份日志分析 + 单条消息分析，共两个。
3. 报告路径：固定 `reports/`，自动时间戳。
4. v1 不加入筛选。
5. 接受新增 `typescript`、`@types/node`、`typebox`。

---

## 15. 完成情况（v1 交付记录）

- 交付目录：`code/shared/lib/tools/chat_risk_log_scope/`
- 功能入口：
  - `chat_risk_log_scope_analyze_file`（整份日志 / 增量）
  - `chat_risk_log_scope_judge_message`（原判定 / 纯文本关键词）
- 新增依赖：`typebox`（直接依赖）、`typescript`、`@types/node`（devDependencies）。
- 常用命令：
  - `npm run test:chat-risk`：78+ 项单元/集成/工具测试；
  - `npm run typecheck:chat-risk`：严格 TypeScript 类型检查；
  - `npm run parity:chat-risk`：与 Go 参考版本逐字段对拍。
- 固定样例对拍结果：summary / riskDistribution / accounts / samples /
  falsePositiveIds / actionCounts / judgements 全部一致。
- 测试覆盖：核心领域模块（stats / risk-map / mask / false-positive / account /
  sample / time / loader / report / incremental）行覆盖率接近 100%；
  全量测试分支覆盖率约 86.8%（Node 内置覆盖率，多进程合并口径）。
- 安全项：工作区路径校验、固定 `reports/`、默认脱敏/截断、默认不落盘、
  20MB/100,000 行限制、AbortSignal、无网络请求。
- 使用说明：见 `code/shared/lib/tools/chat_risk_log_scope/README.md`。
