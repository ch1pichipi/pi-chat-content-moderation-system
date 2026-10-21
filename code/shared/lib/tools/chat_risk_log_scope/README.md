# chat_risk_log_scope（TypeScript 版）

聊天风险日志分析工具，从 Go 项目 `chat_risk_log_scope` 移植为纯 TypeScript，并以两个 Agent 工具的形式接入内容审核智能体。

- **v1 判断模式**：`mock` 规则判断，**不联网、不读取 API Key**。
- **默认安全策略**：账号脱敏、消息截断、只读输入、默认不落盘。
- **两个入口**：
  - `chat_risk_log_scope_analyze_file`：分析整份日志；
  - `chat_risk_log_scope_judge_message`：判断单条消息。

---

## 1. 快速开始

### 1.1 运行测试与类型检查

```bash
npm install
npm run test:chat-risk        # node:test + tsx
npm run typecheck:chat-risk   # tsc --noEmit
npm run parity:chat-risk      # Go/TS 对拍（需要参考项目与 go）
```

### 1.2 作为 pi 扩展加载

直接指定文件：

```bash
pi --extension ./code/shared/lib/tools/chat_risk_log_scope/index.ts
```

或放入项目扩展目录 `.pi/extensions/chat-risk-log-scope/index.ts`：

```ts
export { default } from "../../../code/shared/lib/tools/chat_risk_log_scope/index.ts";
```

`index.ts` 默认导出 `ExtensionAPI` 工厂，会注册两个工具。

### 1.3 纯 TS API

```ts
import { analyzeFile, judgeMessage } from "./code/shared/lib/tools/chat_risk_log_scope/index.ts";

const analysis = await analyzeFile({
  source: { kind: "file", path: "logs/chat_risk.csv" },
  output: { format: "markdown", writeReport: false },
});

const verdict = await judgeMessage({ message: "代练加微信" });
```

---

## 2. 目录结构

```text
chat_risk_log_scope/
├── index.ts                  # 纯 API 导出 + pi Extension Factory
├── analyze.ts                # 整份日志分析编排
├── judge-message.ts          # 单条消息判断编排
├── types.ts                  # 核心数据结构
├── config.ts                 # 默认配置与参数归一化
├── risk-map.ts               # reason 映射 + 从严处置动作
├── stats.ts                  # 汇总统计
├── mask.ts                   # 账号脱敏、Unicode 截断
├── false-positive.ts         # 疑似误杀规则
├── account.ts                # 账号聚合、重复违规、处置推荐
├── sample.ts                 # 5 类典型样本
├── security.ts               # 工作区路径校验
├── loader/                   # CSV / JSON / 时间解析
├── ai/                       # Judge 接口、MockJudge、关键词规则
├── report/                   # Markdown 渲染与固定目录落盘
├── incremental/              # 增量游标状态（原子写入）
├── scripts/parity-check.ts   # Go/TS 对拍脚本
├── __fixtures__/             # 从 Go 项目复制的样例
└── __tests__/                # 单元测试、集成测试、工具测试
```

---

## 3. 工具一：`chat_risk_log_scope_analyze_file`

### 3.1 参数

```ts
{
  source: {
    kind: "file" | "inline",
    path?: string,                 // kind=file 必填，必须位于工作区内
    content?: string,              // kind=inline 必填
    format?: "csv" | "json"        // inline 必填；file 按扩展名
  },
  options?: {
    highConfidence?: number,       // 默认 0.8
    lowConfidence?: number,        // 默认 0.5
    repeatWindowMinutes?: number,  // 默认 60
    topN?: number,                 // 默认 5，范围 1~50
    noMask?: boolean,              // 默认 false（仅本地演示可关闭脱敏）
    messageMaxLength?: number,     // 默认 200；0 表示不截断
    reasonMap?: Record<string, string> // 自定义 reason 标签
  },
  incremental?: {
    enabled?: boolean,             // 默认 false
    stateFile?: string,            // 默认 .cache/chat_risk_scope_state.json
    limit?: number                 // 默认 100，范围 1~10000
  },
  output?: {
    format?: "json" | "markdown",  // 默认 markdown
    writeReport?: boolean          // 默认 false
  }
}
```

### 3.2 行为

1. 读取并容错解析 CSV/JSON；
2. 增量模式：读取游标，过滤 `createTime > last_time`，按时间升序取最多 `limit` 条；
3. 汇总统计 → reason 映射 → Mock 判断 → 疑似误杀 → 重点账号 → 典型样本；
4. 渲染 7 段 Markdown 报告；
5. `writeReport=true` 时写入工作区 `reports/`，增量模式文件名追加 `_seqN`；
6. 增量分析成功后保存新游标 `maxTime + 1ms`。

### 3.3 返回值

`content` 为 Markdown 报告（或紧凑 JSON）。`details` 结构：

```ts
{
  summary: Summary,
  riskDistribution: Array<{ reason, label, count, ratio }>,
  accounts: AccountSummary[],
  samples: Sample[],
  falsePositives: FalsePositiveItem[],
  judgementsSummary: {
    total, degradedCount, falsePositiveCount, actionCounts
  },
  warnings: string[],
  meta: {
    source, totalEntries, processedEntries,
    masked, judgeMode: "mock", reportPath?, elapsedMs,
    reportMarkdown, incremental?
  }
}
```

### 3.4 示例

```ts
await analyzeFileTool.execute(
  "call-1",
  {
    source: { kind: "file", path: "logs/chat_risk.csv" },
    options: { topN: 3 },
    output: { format: "markdown", writeReport: true },
  },
  undefined,
  undefined,
  ctx, // pi 提供的 ExtensionToolContext，cwd 用于工作区校验
);
```

---

## 4. 工具二：`chat_risk_log_scope_judge_message`

### 4.1 参数

```ts
{
  message: string,
  reason?: number,            // 与 confidence 同时提供时走路径 A
  confidence?: number,        // 0~1
  level?: string,
  contextMessages?: string[],
  account?: string,
  nickname?: string,
  options?: {
    highConfidence?: number,
    lowConfidence?: number,
    noMask?: boolean,
    messageMaxLength?: number,
    reasonMap?: Record<string, string>
  }
}
```

### 4.2 两条判断路径

**路径 A：带 `reason` + `confidence`**

复用整份日志分析的 MockJudge 分支，保证同一条记录在两种入口下结论一致：

- `confidence < lowConfidence` → 疑似误杀，建议人工复核；
- `confidence >= highConfidence` → 维持原判定，按 `SevereAction(reason)` 从严处置；
- 中间区间 → 命中"测试/开玩笑/误触"等误判特征时观察 + 疑似误杀，否则观察。

**路径 B：只有 `message`（可附上下文）**

关键词启发式：

- NFKC、全角转半角、小写、去零宽字符、折叠分隔符；
- 在压缩文本上匹配，可识别 `加*微*信`、`加 微 信` 等简单规避；
- 取命中次数最高的 reason；`confidence = min(0.95, 0.5 + 0.1 × 命中次数)`；
- 无命中 → `reason=-1`、`confidence=0`、建议放行；
- 建议动作复用 `risk-map.ts` 的统一规则。

所有结果 `degraded=true`、`judgeMode="mock"`，**不能作为自动处罚的唯一依据**。

### 4.3 返回值

`content` 为简短结论（风险类型、推断 reason/置信度、建议动作、命中关键词、理由）。
`details` 为 `JudgeMessageResult`，包含 `judgement`、`original`、`warnings`、`meta`。

---

## 5. 业务规则对齐

| 规则 | 说明 |
| --- | --- |
| reason 映射 | 11 种默认标签与 Go 版本一致；未知 reason 返回「未知类型」 |
| 从严处置 | 4/5 → 加入黑名单；1/2/127/-128 → 封禁；3/6/7 → 禁言；其余 → 人工复核 |
| 统计阈值 | `confidence >= highConfidence` 计高置信；`< lowConfidence` 计低置信 |
| 疑似误杀 | 低置信风险 / AI 与原判定不一致且倾向放行 / judge_result 或 label 与 prediction 不一致 |
| 账号聚合 | 按出现次数降序；主要风险平票取较小 reason；重复违规窗口默认 60 分钟 |
| 账号处置 | 高风险 ≥3 → 黑名单；高风险 ≥1 且有重复 → 封禁；高风险 ≥1 → 从严动作；仅重复 → 观察；有风险 → 人工复核；否则放行 |
| 典型样本 | 模型训练、误杀排查、规则优化、人工复核、运营处置（v1 无聚类，运营样本为空） |
| 报告 | 7 段固定结构；账号脱敏；消息按 `messageMaxLength` 截断 |

固定样例（`__fixtures__/sample_logs.csv` / `.json`）的基准结果：

```text
总日志 10 / 风险 5 / 正常 5 / 高置信 2 / 低置信 1
账号 7 / 区服 10 / 疑似误杀 2 / 典型样本 9
判断总数 5 / 降级 5 / 疑似误杀标记 1
建议动作：人工复核 3、观察 2
```

`npm run parity:chat-risk` 会运行 Go 参考版本并逐字段对比上述结果。

---

## 6. 安全与限制

### 6.1 路径安全

- `source.path` 必须位于工作区根目录内；拒绝 `..`、绝对路径逃逸与符号链接逃逸。
- 报告目录固定为 `reports/`，不接受自定义目录。
- 增量状态文件同样限制在工作区内。
- 默认只读输入；只有 `output.writeReport=true` 才写文件。

### 6.2 数据安全

- 默认账号脱敏（保留首尾字符），短账号全掩码。
- 报告和工具返回文本均按 `messageMaxLength` 截断。
- 单条消息判断不返回消息原文，只返回命中关键词和结论。
- 不联网、不读取密钥；消息内容不落盘。

### 6.3 资源限制

| 限制 | 默认值 |
| --- | --- |
| 单文件大小 | 20MB |
| 单文件行数 | 100,000 |
| 增量每批条数 | 100（可配 1~10000） |
| 单条消息判断输入 | 10,000 字符（超出截断并告警） |
| 支持取消 | 全部入口接受 `AbortSignal` |

### 6.4 v1 不包含

- Claude / 其他大模型真实判断（保留 `Judge` 接口）；
- AI 判断缓存；
- 后台常驻 watch（改为每次调用处理一批增量）；
- 时间/账号/reason/区服筛选；
- 相似消息聚类、HTML/CSV/PDF 导出、Web UI、数据库接入。

---

## 7. 测试

```bash
npm run test:chat-risk
npm run typecheck:chat-risk
npm run parity:chat-risk
```

测试覆盖：CSV/JSON 容错、11 种时间格式、reason 映射、阈值边界、脱敏与截断、三条误杀规则、账号聚合、5 类样本、Mock 分支、关键词规避、单条消息两条路径、报告 7 段、增量游标/损坏状态/原子写入、路径逃逸/文件超限/取消信号、两个 ToolDefinition 的 `execute`。
