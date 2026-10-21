/**
 * 疑似误杀判断（README 功能 2 的补充信号）。
 *
 * 命中任意一条即视为疑似误杀：
 *  1. confidence 低于阈值，且原判定为风险（reason !== -1）；
 *  2. AI 判断结果与原系统判定类型不一致，且 AI 判断倾向"放行"；
 *  3. 命中人工复核字段：judge_result 与 prediction 不一致，或 label 与 prediction 不一致。
 */

import type { AIJudgement, LogEntry } from "./types.ts";
import { isRisk } from "./types.ts";

export interface FalsePositiveConfig {
	lowConfidence: number;
}

export interface FalsePositiveResult {
	isFalsePositive: boolean;
	hits: string[];
}

/**
 * 结合原始日志、AI 判断结果与原系统判定标签，输出疑似误杀判断结果。
 * originalLabel 由调用方通过 RiskMap.label(entry.reason) 计算。
 */
export function evaluateFalsePositive(
	entry: LogEntry,
	judgement: AIJudgement,
	originalLabel: string,
	cfg: FalsePositiveConfig,
): FalsePositiveResult {
	const hits: string[] = [];

	if (isRisk(entry) && entry.confidence < cfg.lowConfidence) {
		hits.push("低置信度：原判定为风险但置信度低于阈值，疑似误杀");
	}

	if (
		judgement.aiLabel !== "" &&
		judgement.aiLabel !== originalLabel &&
		judgement.suggestedAction === "放行"
	) {
		hits.push("AI判断与原系统判定不一致，且AI判断倾向放行");
	}

	if (entry.judgeResult !== "" && entry.prediction !== "" && entry.judgeResult !== entry.prediction) {
		hits.push("命中人工复核字段：judge_result 与 prediction 不一致，存在人工改判记录");
	} else if (entry.label !== "" && entry.prediction !== "" && entry.label !== entry.prediction) {
		hits.push("命中人工复核字段：label 与 prediction 不一致，存在人工改判记录");
	}

	return { isFalsePositive: hits.length > 0, hits };
}
