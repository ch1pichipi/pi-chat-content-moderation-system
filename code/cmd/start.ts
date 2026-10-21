/**
 * 内容审核 Agent 启动入口
 *
 * 结构对齐 L05-tools/05a-query-data.ts：
 *   ① 工具定义：改为从 code/shared/lib/tools/chat_risk_log_scope 引入
 *   ② 注册：通过 createAgentSession 的 customTools 注入
 *   ③ 运行：发起一次示例提问，打印回复与工具调用
 *
 * 输出约定（避免日志与正文混在一起）：
 *   - stdout：只放模型最终的助手正文；默认按完整消息一次性输出。
 *   - stderr：工具调用、运行状态、错误等诊断信息。
 *   - 需要真正的逐字流式输出时，设置环境变量 CHAT_RISK_STREAM=1。
 *
 * 运行（在项目根目录或 code/ 目录下均可）：
 *   npx tsx code/cmd/start.ts
 *   npx tsx code/cmd/start.ts 1>answer.txt 2>agent.log   # 正文与日志分开落文件
 *   CHAT_RISK_STREAM=1 npx tsx code/cmd/start.ts         # 逐字流式（日志仍在 stderr）
 */
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join, relative } from "node:path";
import {
  analyzeFileTool,
  judgeMessageTool,
} from "../shared/lib/tools/chat_risk_log_scope/index.ts";

const STREAM_TEXT = process.env.CHAT_RISK_STREAM === "1";

// ── 输出通道：诊断信息统一走 stderr，避免污染 stdout 的正文 ──
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** 从工具结果中提取正文，失败时用来显示真正的错误原因。 */
function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

// 样例文件按“当前工作目录”转成相对路径：
// 在仓库根目录或 code/ 目录下运行都能正确定位。
const fixtureAbsolute = join(
  import.meta.dirname,
  "../shared/lib/tools/chat_risk_log_scope/__fixtures__/sample_logs.csv",
);
const fixturePath = relative(process.cwd(), fixtureAbsolute) || fixtureAbsolute;

// ═════════ ① 说明书 + ② 干活：工具来自 chat_risk_log_scope ═════════
// analyzeFileTool：整份聊天风险日志分析（统计 / 重点账号 / 样本 / 误杀 / 报告）
// judgeMessageTool：单条聊天消息风险判断（原判定分支 / 关键词启发式）
const customTools = [analyzeFileTool, judgeMessageTool];

// ═════════ ③ 注册 + 运行 ═════════
const modelRuntime = await ModelRuntime.create();
const model = (await modelRuntime.getAvailable())[0];
if (!model) throw new Error("没有可用模型，请检查 ~/.pi/agent/models.json");

const { session } = await createAgentSession({
  cwd: process.cwd(),
  model,
  modelRuntime,
  customTools, // ★ 注入聊天风险日志分析工具
  sessionManager: SessionManager.inMemory(),
});

try {
  // 缓冲一条助手消息的正文：
  // - 默认在 message_end 一次性写出，日志不会插进句子中间；
  // - CHAT_RISK_STREAM=1 时改为逐字写出（日志仍走 stderr）。
  let assistantText = "";

  session.subscribe((event) => {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") assistantText = "";
        break;

      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta") break;
        if (STREAM_TEXT) {
          process.stdout.write(update.delta);
        } else {
          assistantText += update.delta;
        }
        break;
      }

      case "message_end":
        if (event.message.role === "assistant") {
          if (!STREAM_TEXT && assistantText !== "") {
            // 一条消息一次性写出，避免与日志交错。
            process.stdout.write(
              assistantText.endsWith("\n") ? assistantText : `${assistantText}\n`,
            );
          }
          assistantText = "";
        }
        break;

      case "tool_execution_start":
        log(`🔧 调用工具：${event.toolName}`);
        break;

      case "tool_execution_end":
        if (event.isError) {
          log(`❌ 工具失败：${event.toolName}\n${toolResultText(event.result)}`);
        } else {
          log(`✅ 工具完成：${event.toolName}`);
        }
        break;

      default:
        break;
    }
  });

  const question = [
    `请分析 ${fixturePath} 的整体风险，`,
    "再判断单条消息「代练 加微信 加群」的风险，最后给出处置建议。",
  ].join("");
  log(`💬 问：${question}`);
  await session.prompt(question);
  log("🏁 会话结束");
} finally {
  session.dispose();
}
