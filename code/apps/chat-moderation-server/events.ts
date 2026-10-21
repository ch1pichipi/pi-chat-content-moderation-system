/**
 * 服务端推送事件（SSE）与对外的视图类型。
 *
 * 前端只依赖这里的结构，数据库字段名不直接暴露。
 */

import type { BanPunishment, BanState } from "../../shared/lib/tools/chat_risk_log_scope/db/bans.ts";

/** 封禁状态视图（camelCase，便于前端直接使用）。 */
export interface BanView {
	id: number;
	account: string;
	punishment: BanPunishment;
	reason: number;
	label: string;
	startAt: string;
	endAt: string | null;
	/** 剩余秒数；永久封禁或已失效为 null。 */
	remainingSeconds: number | null;
	permanent: boolean;
	status: BanState;
}

export interface ChatMessageView {
	id: string;
	account: string;
	nickname: string;
	areaName: string;
	serverId: string;
	content: string;
	createTime: string | null;
}

export interface JudgementView {
	messageId: string;
	isRisk: boolean;
	reason: number;
	label: string;
	confidence: number;
	/** 服务端最终执行的处罚。 */
	punishment: string;
	/** Agent 原始建议，便于前端展示降级情况。 */
	requestedPunishment: string | null;
	adjusted: boolean;
	manualReview: boolean;
	evidence: string[];
	summary: string;
	policyNote: string | null;
	model: string;
	degraded: boolean;
	ban: BanView | null;
}

export type ServerEvent =
	| { type: "message_created"; account: string; message: ChatMessageView }
	| {
			type: "analysis_started";
			account: string;
			messageId: string;
			windowMinutes: number;
			messageCount: number;
	  }
	| { type: "analysis_completed"; account: string; messageId: string; judgement: JudgementView }
	| { type: "analysis_failed"; account: string; messageId: string; error: string }
	| { type: "ban_started"; account: string; ban: BanView }
	| { type: "ban_lifted"; account: string }
	| { type: "ban_expired"; account: string };

export interface EventSink {
	emit(event: ServerEvent): void;
}
