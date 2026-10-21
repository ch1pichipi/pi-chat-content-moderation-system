/**
 * MockJudge：完全离线、确定性的规则判断。
 *
 * - 日志条目判断分支与 Go 版本 internal/ai/mock.go 保持一致，保证与日志分析结果对齐。
 * - 单条消息判断使用 mock-keywords 的关键词启发式。
 * - 所有结果 degraded = true，并在工具输出中标注 judgeMode = "mock"。
 */

import { DEFAULT_REASON_MAP, RiskMap, severeAction } from "../risk-map.ts";
import type { AIJudgement, LogEntry, SuggestedAction } from "../types.ts";
import { isRisk } from "../types.ts";
import type { Judge } from "./index.ts";
import { inferRiskFromKeywords, type KeywordMatch } from "./mock-keywords.ts";

export interface MockJudgeConfig {
	riskMap: RiskMap;
	highConfidence: number;
	lowConfidence: number;
}

/** 极简的"疑似误判文本"关键词，与 Go 版本 commonFalsePositiveHints 一致。 */
const COMMON_FALSE_POSITIVE_HINTS = ["测试", "test", "开玩笑", "误触", "复制粘贴"];

export function looksLikeFalsePositiveText(message: string): boolean {
	const lower = message.toLowerCase();
	return COMMON_FALSE_POSITIVE_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}

function reasonLabel(riskMap: RiskMap, reason: number): string {
	return riskMap ? riskMap.label(reason) : (DEFAULT_REASON_MAP[reason] ?? "未知类型");
}

/** 对单条日志生成规则判断结果（纯函数）。 */
export function judgeLogEntry(entry: LogEntry, cfg: MockJudgeConfig): AIJudgement {
	const label = reasonLabel(cfg.riskMap, entry.reason);

	if (!isRisk(entry)) {
		return {
			entryId: entry.id,
			aiLabel: label,
			aiReason: "原系统判定为正常，未命中任何风险关键词，规则判断维持放行。",
			isFalsePositive: false,
			suggestedAction: "放行",
			degraded: true,
		};
	}

	const suspectKeyword = looksLikeFalsePositiveText(entry.currentMessage);

	if (entry.confidence < cfg.lowConfidence) {
		return {
			entryId: entry.id,
			aiLabel: label,
			aiReason: `原判定为${label}，但置信度仅 ${entry.confidence.toFixed(2)} 低于阈值 ${cfg.lowConfidence.toFixed(2)}，疑似误杀，建议人工复核。`,
			isFalsePositive: true,
			suggestedAction: "人工复核",
			degraded: true,
		};
	}

	if (entry.confidence >= cfg.highConfidence) {
		return {
			entryId: entry.id,
			aiLabel: label,
			aiReason: `原判定为${label}，置信度 ${entry.confidence.toFixed(2)} 达到高阈值 ${cfg.highConfidence.toFixed(2)}，规则判断维持原判定，建议从严处置。`,
			isFalsePositive: false,
			suggestedAction: severeAction(entry.reason),
			degraded: true,
		};
	}

	if (suspectKeyword) {
		return {
			entryId: entry.id,
			aiLabel: label,
			aiReason: `原判定为${label}，置信度 ${entry.confidence.toFixed(2)} 处于中间区间，且消息内容存在疑似误判特征，建议观察。`,
			isFalsePositive: true,
			suggestedAction: "观察",
			degraded: true,
		};
	}

	return {
		entryId: entry.id,
		aiLabel: label,
		aiReason: `原判定为${label}，置信度 ${entry.confidence.toFixed(2)} 处于中间区间，规则判断维持原判定，建议观察。`,
		isFalsePositive: false,
		suggestedAction: "观察",
		degraded: true,
	};
}

/** 实现 Judge 接口的 Mock 判断器。 */
export class MockJudge implements Judge {
	constructor(private readonly cfg: MockJudgeConfig) {}

	async judgeBatch(entries: readonly LogEntry[], signal?: AbortSignal): Promise<AIJudgement[]> {
		const results: AIJudgement[] = [];
		for (const entry of entries) {
			if (signal?.aborted) throw new Error("操作已取消");
			results.push(judgeLogEntry(entry, this.cfg));
		}
		return results;
	}
}

export interface OriginalVerdictInput {
	message: string;
	reason: number;
	confidence: number;
	level?: string;
	entryId?: string;
}

/**
 * 路径 A：调用方已有原系统判定信息时，复用日志条目判断逻辑，保证结果一致。
 */
export function judgeByOriginalVerdict(
	input: OriginalVerdictInput,
	cfg: MockJudgeConfig,
): AIJudgement {
	const entry: LogEntry = {
		id: input.entryId ?? "message",
		requestId: "",
		account: "",
		appId: "",
		areaId: "",
		areaName: "",
		serverId: "",
		nickname: "",
		contextMessages: [],
		currentMessage: input.message,
		judgeResult: "",
		contextType: "",
		reason: input.reason,
		confidence: input.confidence,
		level: input.level ?? "",
		label: "",
		prediction: "",
		reviewedAt: "",
		forbidConsidered: false,
		forbidDeduped: false,
		reviewedTime: null,
		createTime: null,
		createTimeStr: "",
		warnings: [],
	};
	return judgeLogEntry(entry, cfg);
}

export interface KeywordJudgeResult {
	judgement: AIJudgement;
	match: KeywordMatch;
}

/** 路径 B：只有纯文本消息时，使用关键词启发式判断。 */
export function judgeByKeywords(
	message: string,
	cfg: MockJudgeConfig,
	keywordOverrides?: Readonly<Record<number, readonly string[]>>,
): KeywordJudgeResult {
	const match = inferRiskFromKeywords(message, keywordOverrides);

	if (match.reason === -1) {
		return {
			match,
			judgement: {
				entryId: "message",
				aiLabel: "正常",
				aiReason: "未命中任何风险关键词，规则判断建议放行。",
				isFalsePositive: false,
				suggestedAction: "放行",
				degraded: true,
				matchedKeywords: [],
				inferredReason: -1,
				inferredConfidence: 0,
			},
		};
	}

	const label = reasonLabel(cfg.riskMap, match.reason);
	const action: SuggestedAction = severeAction(match.reason);
	const keywordText = match.matchedKeywords.join("、");

	return {
		match,
		judgement: {
			entryId: "message",
			aiLabel: label,
			aiReason: `关键词启发式命中「${keywordText}」（共 ${match.hitCount} 次），推断风险类型为${label}，推断置信度 ${match.confidence.toFixed(2)}。该结果为 mock 规则判断，建议结合上下文与人工复核确认。`,
			isFalsePositive: false,
			suggestedAction: action,
			degraded: true,
			matchedKeywords: match.matchedKeywords,
			inferredReason: match.reason,
			inferredConfidence: match.confidence,
		},
	};
}
