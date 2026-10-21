import type { SuggestedAction } from "../types.ts";

export interface DbConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	connectionLimit: number;
}

/** 从 chat_risk_logs 读取的盲测日志，不包含任何判定字段。 */
export interface BlindLogRecord {
	id: string;
	request_id: string;
	account: string;
	nickname: string;
	app_id: string;
	area_id: string;
	area_name: string;
	server_id: string;
	context_messages: string[];
	current_message: string;
	context_type: string;
	create_time: string | null;
}

/** 写入 chat_risk_judgements 的 Agent 判断结果。 */
export interface AgentJudgementInput {
	log_id: string;
	is_risk: boolean;
	reason: number;
	label: string;
	confidence: number;
	action: SuggestedAction;
	evidence?: string[];
	/** Agent 建议的处罚枚举（审计用）。 */
	punishment_requested?: string | null;
	/** 服务端护栏后实际执行的处罚枚举。 */
	punishment_applied?: string | null;
	/** 实际封禁秒数；永久封禁为 null。 */
	ban_seconds?: number | null;
	/** 是否被服务端降级。 */
	policy_adjusted?: boolean;
	/** 降级/人工复核原因。 */
	policy_note?: string | null;
	agent_model?: string;
	judged_at?: string;
}

export interface SavedJudgement extends AgentJudgementInput {
	judged_at: string;
}

export interface FetchLogsOptions {
	limit: number;
	includeJudged: boolean;
	createTimeFrom?: string;
	createTimeTo?: string;
}
