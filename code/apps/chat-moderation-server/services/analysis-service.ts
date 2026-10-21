/**
 * 分析调度服务。
 *
 * 关键行为（见计划 4.5 / 8）：
 *   - 每个账号一条串行队列，同一账号同一时间只跑一次分析；
 *   - 连续消息按 debounceMs 合并，只分析最新窗口；
 *   - 全局并发上限，避免本地模型打满；
 *   - 分析失败/超时/输出异常一律不封禁，只写人工复核记录；
 *   - 结果通过 SSE 推送给前端。
 */

import type { Pool } from "mysql2/promise";

import {
	createBan,
	fetchActiveBan,
	type ChatPlayerBanRecord,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/bans.ts";
import { formatMysqlDateTime } from "../../../shared/lib/tools/chat_risk_log_scope/db/datetime.ts";
import { saveJudgementReturningId } from "../../../shared/lib/tools/chat_risk_log_scope/db/judgements.ts";
import {
	fetchRecentMessages,
	type ChatMessageRecord,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/messages.ts";
import type { Judge, JudgeResult } from "../agent/judge.ts";
import {
	resolvePolicy,
	type ModerationPolicyConfig,
	type Punishment,
} from "../agent/policy.ts";
import type { AnalysisInput, AnalysisMessage } from "../agent/types.ts";
import type { EventSink, JudgementView, ServerEvent } from "../events.ts";
import { AccountQueue } from "./account-queue.ts";
import { buildHistorySummary, countPriorBans, toBanView } from "./ban-service.ts";

export interface AnalysisServiceOptions {
	pool: Pool;
	/** 主 Agent（Pi 默认模型）。 */
	judge: Judge;
	/** 降级 Agent（关键词 Mock）；为 undefined 表示不降级。 */
	fallbackJudge?: Judge;
	policy: ModerationPolicyConfig;
	events?: EventSink;
	windowMinutes: number;
	maxMessages: number;
	lookbackHours: number;
	debounceMs: number;
	concurrency: number;
	/** 服务启动时间；早于该时间的种子日志不参与分析。 */
	serviceStartedAt: Date;
	now?: () => Date;
	logger?: (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

export interface AnalysisResult {
	account: string;
	messageId: string | null;
	judgement: JudgementView | null;
	error?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toAnalysisMessage(message: ChatMessageRecord): AnalysisMessage {
	return {
		id: message.id,
		create_time: message.createTime ?? "",
		content: message.content,
		context: message.contextMessages,
	};
}

export class AnalysisService {
	private readonly pool: Pool;
	private readonly judge: Judge;
	private readonly fallbackJudge?: Judge;
	private readonly policy: ModerationPolicyConfig;
	private readonly events?: EventSink;
	private readonly now: () => Date;
	private readonly logger: NonNullable<AnalysisServiceOptions["logger"]>;
	private readonly options: AnalysisServiceOptions;
	private readonly queue: AccountQueue<AnalysisResult>;

	constructor(options: AnalysisServiceOptions) {
		this.options = options;
		this.pool = options.pool;
		this.judge = options.judge;
		this.fallbackJudge = options.fallbackJudge;
		this.policy = options.policy;
		this.events = options.events;
		this.now = options.now ?? (() => new Date());
		this.logger = options.logger ?? (() => {});
		this.queue = new AccountQueue<AnalysisResult>({
			debounceMs: options.debounceMs,
			concurrency: options.concurrency,
			worker: (account) => this.analyze(account),
			onError: (account, error) => {
				this.logger("error", `分析任务异常 ${account}: ${errorMessage(error)}`, error);
			},
		});
	}

	/** 玩家发消息后调用；同一账号在 debounce 窗口内只触发一次分析。 */
	enqueue(account: string): void {
		this.queue.enqueue(account);
	}

	/** 跳过防抖立即分析（测试与手工排查用）；账号正在分析时返回 null。 */
	async analyzeNow(account: string): Promise<AnalysisResult | null> {
		return this.queue.runNow(account);
	}

	async waitForIdle(timeoutMs = 30_000): Promise<void> {
		return this.queue.waitForIdle(timeoutMs);
	}

	pendingCount(): number {
		return this.queue.pendingCount();
	}

	stop(): void {
		this.queue.stop();
	}

	private emit(event: ServerEvent): void {
		try {
			this.events?.emit(event);
		} catch (error) {
			this.logger("warn", `推送事件失败: ${errorMessage(error)}`);
		}
	}

	private async analyze(account: string): Promise<AnalysisResult> {
		const now = this.now();
		const windowStart = new Date(now.getTime() - this.options.windowMinutes * 60_000);
		// 只分析服务启动后玩家新发送的消息，种子日志保持历史原样。
		const since =
			windowStart.getTime() > this.options.serviceStartedAt.getTime()
				? windowStart
				: this.options.serviceStartedAt;

		const messages = await fetchRecentMessages(this.pool, account, {
			limit: this.options.maxMessages,
			since,
		});
		if (messages.length === 0) {
			this.logger("info", `${account} 分析窗口内没有新消息，跳过`);
			return { account, messageId: null, judgement: null };
		}
		const latest = messages[messages.length - 1];

		let history;
		try {
			history = await buildHistorySummary(
				this.pool,
				account,
				this.options.lookbackHours,
				now,
			);
		} catch (error) {
			const message = errorMessage(error);
			await this.recordManualReview(account, latest, now, `历史统计失败: ${message}`);
			this.emit({ type: "analysis_failed", account, messageId: latest.id, error: message });
			return { account, messageId: latest.id, judgement: null, error: message };
		}

		const input: AnalysisInput = {
			player: {
				account,
				nickname: latest.nickname || account,
				area: [latest.areaName, latest.serverId].filter(Boolean).join("/"),
			},
			window: {
				minutes: this.options.windowMinutes,
				messageCount: messages.length,
			},
			recentMessages: messages.map(toAnalysisMessage),
			historySummary: history,
		};

		this.emit({
			type: "analysis_started",
			account,
			messageId: latest.id,
			windowMinutes: this.options.windowMinutes,
			messageCount: messages.length,
		});

		let result: JudgeResult | null = null;
		let agentError: unknown = null;
		try {
			result = await this.judge.judge(input);
		} catch (error) {
			agentError = error;
			this.logger(
				"warn",
				`Agent 分析失败 ${account}（${latest.id}）: ${errorMessage(error)}`,
			);
		}

		if (!result && this.fallbackJudge) {
			try {
				const fallback = await this.fallbackJudge.judge(input);
				result = { ...fallback, degraded: true };
				this.logger("warn", `已降级为关键词 Mock 分析 ${account}`);
			} catch (error) {
				agentError = agentError ?? error;
			}
		}

		if (!result) {
			const message = errorMessage(agentError ?? "Agent 未返回结果");
			await this.recordManualReview(account, latest, now, message);
			this.emit({ type: "analysis_failed", account, messageId: latest.id, error: message });
			return { account, messageId: latest.id, judgement: null, error: message };
		}

		return this.applyVerdict(account, latest, now, input, result);
	}

	/** 分析失败时写一条"人工复核"记录，既留痕也便于审计。 */
	private async recordManualReview(
		account: string,
		message: ChatMessageRecord,
		now: Date,
		error: string,
	): Promise<void> {
		try {
			await saveJudgementReturningId(this.pool, {
				log_id: message.id,
				is_risk: false,
				reason: -1,
				label: "正常",
				confidence: 0,
				action: "人工复核",
				evidence: [],
				punishment_requested: null,
				punishment_applied: "none",
				ban_seconds: null,
				policy_adjusted: false,
				policy_note: `Agent 分析异常，转人工复核：${error}`,
				agent_model: "unavailable",
				judged_at: formatMysqlDateTime(now),
			});
		} catch (writeError) {
			this.logger(
				"error",
				`写入人工复核记录失败 ${account}: ${errorMessage(writeError)}`,
			);
		}
	}

	private async applyVerdict(
		account: string,
		message: ChatMessageRecord,
		now: Date,
		input: AnalysisInput,
		result: JudgeResult,
	): Promise<AnalysisResult> {
		const verdict = result.verdict;
		// 护栏的"前科"窗口以处罚策略为准（默认 24h），与 Agent 历史摘要窗口解耦。
		const priorBanCount = await countPriorBans(
			this.pool,
			account,
			this.policy.repeat.windowHours,
			now,
		);
		const decision = resolvePolicy(this.policy, {
			isRisk: verdict.is_risk,
			reason: verdict.reason,
			confidence: verdict.confidence,
			requestedPunishment: verdict.punishment,
			priorBanCount,
			agentLabel: verdict.label,
		});

		const notes = [...decision.notes];
		if (result.degraded) notes.push("Agent 不可用，已降级为关键词 Mock 判断");

		let hasActiveBan = false;
		if (decision.applied !== "none") {
			const existing = await fetchActiveBan(this.pool, account, now);
			if (existing) {
				hasActiveBan = true;
				notes.push("已存在生效封禁，跳过重复创建");
			}
		}

		const judgementId = await saveJudgementReturningId(this.pool, {
			log_id: message.id,
			is_risk: verdict.is_risk,
			reason: verdict.reason,
			label: decision.label,
			confidence: verdict.confidence,
			action: decision.action,
			evidence: verdict.evidence,
			punishment_requested: verdict.punishment,
			punishment_applied: decision.applied,
			ban_seconds: decision.banSeconds,
			policy_adjusted: decision.adjusted,
			policy_note: notes.length > 0 ? notes.join("；") : null,
			agent_model: `${result.model}${result.degraded ? " (mock)" : ""}`,
			judged_at: formatMysqlDateTime(now),
		});

		let ban: ChatPlayerBanRecord | null = null;
		if (decision.applied !== "none" && !hasActiveBan) {
			ban = await this.createBanFor({
				account,
				message,
				judgementId,
				punishment: decision.applied,
				label: decision.label,
				reason: verdict.reason,
				now,
			});
		}

		const judgement: JudgementView = {
			messageId: message.id,
			isRisk: verdict.is_risk,
			reason: verdict.reason,
			label: decision.label,
			confidence: verdict.confidence,
			punishment: decision.applied,
			requestedPunishment: verdict.punishment,
			adjusted: decision.adjusted,
			manualReview: decision.manualReview,
			evidence: verdict.evidence,
			summary: verdict.summary,
			policyNote: notes.length > 0 ? notes.join("；") : null,
			model: result.model,
			degraded: result.degraded,
			ban: ban ? toBanView(ban, now) : null,
		};

		this.emit({ type: "analysis_completed", account, messageId: message.id, judgement });
		return { account, messageId: message.id, judgement };
	}

	private async createBanFor(input: {
		account: string;
		message: ChatMessageRecord;
		judgementId: number;
		punishment: Exclude<Punishment, "none">;
		label: string;
		reason: number;
		now: Date;
	}): Promise<ChatPlayerBanRecord> {
		const ban = await createBan(this.pool, {
			account: input.account,
			log_id: input.message.id,
			judgement_id: input.judgementId,
			reason: input.reason,
			label: input.label,
			punishment: input.punishment,
			startAt: input.now,
		});
		this.emit({ type: "ban_started", account: input.account, ban: toBanView(ban, input.now) });
		return ban;
	}
}
