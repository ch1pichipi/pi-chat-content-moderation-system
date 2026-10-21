/**
 * 单条消息判断编排。
 *
 * 路径 A：调用方提供原系统 reason + confidence，复用与日志分析一致的 MockJudge 分支。
 * 路径 B：只有消息文本，使用 Mock 关键词启发式推断。
 */

import { judgeByKeywords, judgeByOriginalVerdict, type MockJudgeConfig } from "./ai/mock.ts";
import {
	MAX_MESSAGE_INPUT_LENGTH,
	normalizeJudgeMessageOptions,
	type JudgeMessageOptionsInput,
} from "./config.ts";
import { RiskMap } from "./risk-map.ts";
import type { AIJudgement, JudgeMessageResult } from "./types.ts";

export interface JudgeMessageParams {
	message: string;
	reason?: number;
	confidence?: number;
	level?: string;
	contextMessages?: string[];
	account?: string;
	nickname?: string;
	options?: JudgeMessageOptionsInput;
	signal?: AbortSignal;
}

function assertOptionalString(value: unknown, name: string): void {
	if (value !== undefined && typeof value !== "string") {
		throw new Error(`参数 ${name} 必须是字符串`);
	}
}

/** 判断单条消息。 */
export async function judgeMessage(params: JudgeMessageParams): Promise<JudgeMessageResult> {
	const startedAt = Date.now();
	if (params.signal?.aborted) throw new Error("操作已取消");

	if (typeof params.message !== "string" || params.message.trim() === "") {
		throw new Error("参数 message 必须是非空字符串");
	}
	assertOptionalString(params.level, "level");
	assertOptionalString(params.account, "account");
	assertOptionalString(params.nickname, "nickname");
	if (
		params.contextMessages !== undefined &&
		(!Array.isArray(params.contextMessages) ||
			params.contextMessages.some((item) => typeof item !== "string"))
	) {
		throw new Error("参数 contextMessages 必须是字符串数组");
	}

	const { options, warnings } = normalizeJudgeMessageOptions(params.options ?? {});

	let message = params.message;
	if (Array.from(message).length > MAX_MESSAGE_INPUT_LENGTH) {
		message = Array.from(message).slice(0, MAX_MESSAGE_INPUT_LENGTH).join("");
		warnings.push(`消息长度超过 ${MAX_MESSAGE_INPUT_LENGTH} 字符，判断时仅使用前 ${MAX_MESSAGE_INPUT_LENGTH} 字符`);
	}

	const riskMap = new RiskMap(options.reasonMap);
	const cfg: MockJudgeConfig = {
		riskMap,
		highConfidence: options.highConfidence,
		lowConfidence: options.lowConfidence,
	};

	const hasOriginalVerdict = params.reason !== undefined || params.confidence !== undefined;
	let judgement: AIJudgement;
	let originalReason: number | null = null;
	let originalConfidence: number | null = null;

	if (hasOriginalVerdict) {
		if (params.reason === undefined || params.confidence === undefined) {
			throw new Error("路径 A 需要同时提供 reason 与 confidence");
		}
		if (!Number.isInteger(params.reason)) {
			throw new Error("参数 reason 必须是整数");
		}
		if (
			typeof params.confidence !== "number" ||
			!Number.isFinite(params.confidence) ||
			params.confidence < 0 ||
			params.confidence > 1
		) {
			throw new Error("参数 confidence 必须是 0~1 之间的数字");
		}

		originalReason = params.reason;
		originalConfidence = params.confidence;

		// 与原系统一致性：路径 A 只使用当前消息与原始判定信息。
		judgement = judgeByOriginalVerdict(
			{
				message,
				reason: params.reason,
				confidence: params.confidence,
				level: params.level,
			},
			cfg,
		);
		judgement.inferredReason = params.reason;
		judgement.inferredConfidence = params.confidence;
	} else {
		const context = (params.contextMessages ?? [])
			.filter((item) => item.trim() !== "")
			.join(" | ");
		const combined = context === "" ? message : `${message} | ${context}`;
		const result = judgeByKeywords(combined, cfg);
		judgement = result.judgement;
	}

	if (params.signal?.aborted) throw new Error("操作已取消");

	return {
		judgement,
		original: {
			reason: originalReason,
			confidence: originalConfidence,
			level: params.level ?? "",
			reasonLabel: originalReason === null ? "" : riskMap.label(originalReason),
		},
		warnings,
		meta: {
			judgeMode: "mock",
			masked: !options.noMask,
			elapsedMs: Date.now() - startedAt,
		},
	};
}

/** 生成简短的模型可读结论文本。 */
export function formatJudgeMessageContent(result: JudgeMessageResult): string {
	const { judgement, original } = result;
	const lines: string[] = [];
	lines.push(`风险类型：${judgement.aiLabel}`);
	if (judgement.inferredReason !== undefined) {
		lines.push(`推断 reason：${judgement.inferredReason}`);
	}
	if (judgement.inferredConfidence !== undefined) {
		lines.push(`推断置信度：${judgement.inferredConfidence.toFixed(2)}`);
	}
	lines.push(`建议动作：${judgement.suggestedAction}`);
	lines.push(`疑似误杀：${judgement.isFalsePositive ? "是" : "否"}`);
	if (judgement.matchedKeywords && judgement.matchedKeywords.length > 0) {
		lines.push(`命中关键词：${judgement.matchedKeywords.join("、")}`);
	}
	if (original.reason !== null) {
		lines.push(
			`原判定：${original.reasonLabel}（reason=${original.reason}，confidence=${original.confidence?.toFixed(2)}）`,
		);
	}
	lines.push(`判断模式：${result.meta.judgeMode}（规则判断，需结合人工复核）`);
	lines.push(`理由：${judgement.aiReason}`);
	return lines.join("\n");
}
