/**
 * chat_risk_log_scope —— 聊天风险日志分析工具（TypeScript 版）。
 *
 * 同时提供：
 *  1. 纯函数/编排 API：便于单元测试与其他 TS 代码复用；
 *  2. 两个 ToolDefinition：供 pi.registerTool 注册；
 *  3. 默认导出的 Extension Factory：便于作为 pi 扩展加载。
 *
 * v1 不联网、不读取密钥；默认脱敏、默认不落盘。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { analyzeFileTool } from "./tools/analyze-file.tool.ts";
import { judgeMessageTool } from "./tools/judge-message.tool.ts";

export { analyzeFile } from "./analyze.ts";
export type {
	AnalyzeFileParams,
	AnalyzeIncrementalInput,
	AnalyzeOutputInput,
	AnalyzeSourceInput,
} from "./analyze.ts";
export type { AnalyzeOptionsInput as AnalyzeOptions } from "./config.ts";
export { judgeMessage, formatJudgeMessageContent } from "./judge-message.ts";
export type { JudgeMessageParams } from "./judge-message.ts";

export { analyzeFileTool, judgeMessageTool } from "./tools/index.ts";
export type { AnalyzeFileToolDetails, JudgeMessageToolDetails } from "./tools/index.ts";
export {
	analyzeFileParameters,
	judgeMessageParameters,
	type AnalyzeFileToolParams,
	type JudgeMessageToolParams,
} from "./tools/schema.ts";

export type {
	AIJudgement,
	AccountSummary,
	AnalysisResult,
	FalsePositiveItem,
	JudgeMessageResult,
	JudgementsSummary,
	LogEntry,
	RiskDistributionRow,
	Sample,
	SuggestedAction,
	Summary,
} from "./types.ts";
export { isRisk, SUGGESTED_ACTIONS } from "./types.ts";

export { RiskMap, DEFAULT_REASON_MAP, severeAction } from "./risk-map.ts";
export { summarize } from "./stats.ts";
export { maskAccount, truncate } from "./mask.ts";
export { evaluateFalsePositive } from "./false-positive.ts";
export { aggregateAccounts } from "./account.ts";
export { extractSamples, SAMPLE_PURPOSES } from "./sample.ts";
export { renderReport } from "./report/render.ts";
export { IncrementalState, nextReportSeq, resetReportSeq } from "./incremental/state.ts";
export { loadFromFile, loadFromText, detectFormat } from "./loader/index.ts";
export { parseTime } from "./loader/time.ts";
export { DEFAULT_KEYWORDS, inferRiskFromKeywords, normalizeText } from "./ai/mock-keywords.ts";
export { MockJudge, judgeByKeywords, judgeByOriginalVerdict } from "./ai/mock.ts";
export type { Judge } from "./ai/index.ts";

/** pi 扩展工厂：注册两个聊天风险日志工具。 */
export default function registerChatRiskLogScope(pi: ExtensionAPI): void {
	pi.registerTool(analyzeFileTool);
	pi.registerTool(judgeMessageTool);
}
