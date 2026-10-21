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
import { fetchLogsTool } from "./tools/fetch-logs.tool.ts";
import { judgeMessageTool } from "./tools/judge-message.tool.ts";
import { saveJudgementsTool } from "./tools/save-judgements.tool.ts";

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

export { analyzeFileTool, judgeMessageTool, fetchLogsTool, saveJudgementsTool } from "./tools/index.ts";
export type {
	AnalyzeFileToolDetails,
	JudgeMessageToolDetails,
	FetchLogsToolDetails,
	SaveJudgementsToolDetails,
} from "./tools/index.ts";
export {
	analyzeFileParameters,
	judgeMessageParameters,
	fetchLogsParameters,
	saveJudgementsParameters,
	type AnalyzeFileToolParams,
	type JudgeMessageToolParams,
	type FetchLogsToolParams,
	type SaveJudgementsToolParams,
} from "./tools/schema.ts";

export { getDbPool, createDbPool, closeDbPool, loadDbConfig } from "./db/client.ts";
export { fetchLogs, upsertLogs, countLogs, countUnjudgedLogs } from "./db/logs.ts";
export {
	saveJudgements,
	saveJudgementReturningId,
	countJudgements,
	fetchJudgementsByLogIds,
} from "./db/judgements.ts";
export {
	BAN_PUNISHMENTS,
	BAN_PUNISHMENT_SECONDS,
	BAN_STATUSES,
	banRemainingSeconds,
	countBansSince,
	createBan,
	expireStaleBans,
	fetchActiveBan,
	fetchActiveBans,
	fetchBansForAccount,
	fetchLastBan,
	isBanActive,
	isBanPunishment,
	liftActiveBan,
} from "./db/bans.ts";
export type {
	BanPunishment,
	BanState,
	ChatPlayerBanRecord,
	CreateBanInput,
} from "./db/bans.ts";
export {
	createMessageId,
	countRecentRiskJudgements,
	fetchMessageById,
	fetchRecentMessages,
	insertMessage,
	listPlayers,
} from "./db/messages.ts";
export type {
	ChatMessageRecord,
	FetchRecentMessagesOptions,
	InsertMessageInput,
	PlayerOverview,
} from "./db/messages.ts";
export { formatMysqlDateTime, parseMysqlDateTime } from "./db/datetime.ts";
export type {
	AgentJudgementInput,
	BlindLogRecord,
	DbConfig,
	FetchLogsOptions,
} from "./db/types.ts";

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

/** pi 扩展工厂：注册聊天风险日志分析、数据库读取与判断结果写回工具。 */
export default function registerChatRiskLogScope(pi: ExtensionAPI): void {
	pi.registerTool(analyzeFileTool);
	pi.registerTool(judgeMessageTool);
	pi.registerTool(fetchLogsTool);
	pi.registerTool(saveJudgementsTool);
}
