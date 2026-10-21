/**
 * 实时审核所需的 Agent 输入结构与输出结果类型。
 *
 * 输入字段名与变更计划 4.2 保持一致（snake_case），方便与审核同学对齐。
 */

export interface AnalysisPlayer {
	account: string;
	nickname: string;
	area: string;
}

export interface AnalysisWindow {
	minutes: number;
	messageCount: number;
}

export interface AnalysisMessage {
	/** chat_risk_logs.id */
	id: string;
	/** 消息时间，格式 YYYY-MM-DD HH:mm:ss.SSS */
	create_time: string;
	content: string;
	/** 该条消息附带的上下文（通常为空数组）。 */
	context: string[];
}

export interface AnalysisLastBan {
	reason: number;
	punishment: string;
	startedAt: string;
}

export interface AnalysisHistorySummary {
	last24hRiskCount: number;
	last24hBanCount: number;
	lastBan: AnalysisLastBan | null;
}

/** 一次分析任务传给 Agent 的完整输入。 */
export interface AnalysisInput {
	player: AnalysisPlayer;
	window: AnalysisWindow;
	recentMessages: AnalysisMessage[];
	historySummary: AnalysisHistorySummary;
}

/** Agent 输出的严格 JSON 结构（未经护栏校验）。 */
export interface AgentVerdict {
	is_risk: boolean;
	reason: number;
	label: string;
	confidence: number;
	punishment: string;
	duration_seconds: number | null;
	evidence: string[];
	summary: string;
}
