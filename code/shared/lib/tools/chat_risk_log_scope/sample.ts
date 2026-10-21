/**
 * 从风险日志中挑选典型样本（README 功能 4）。
 * 五类用途与 Go 版本 sample 包完全一致。
 */

import { type RiskMap, DEFAULT_REASON_MAP } from "./risk-map.ts";
import type { AIJudgement, LogEntry, Sample } from "./types.ts";
import { isRisk } from "./types.ts";

export const SAMPLE_PURPOSES = {
	modelTraining: "模型训练样本",
	falsePositive: "误杀排查样本",
	ruleTuning: "规则优化样本",
	manualReview: "人工复核样本",
	operationAction: "运营处置样本",
} as const;

/** 相似消息聚类的代表消息；v1 未实现聚类，调用方传空数组即可。 */
export interface ClusterRepresentative {
	reasonLabel: string;
	message: string;
	contextSummary: string;
}

interface EntryWithJudgement {
	entry: LogEntry;
	judgement: AIJudgement;
}

/**
 * 按五类推荐用途提取典型样本，每类最多 topN 条。
 * judgements 以 entry.id 为 key，缺失判断结果的条目会被跳过。
 */
export function extractSamples(
	entries: readonly LogEntry[],
	judgements: ReadonlyMap<string, AIJudgement>,
	riskMap: RiskMap,
	topN = 5,
	clusters: readonly ClusterRepresentative[] = [],
): Sample[] {
	const n = topN <= 0 ? 5 : topN;
	return [
		...modelTrainingSamples(entries, judgements, riskMap, n),
		...falsePositiveSamples(entries, judgements, riskMap, n),
		...ruleTuningSamples(entries, judgements, riskMap, n),
		...manualReviewSamples(entries, judgements, riskMap, n),
		...operationSamples(clusters, n),
	];
}

function riskEntriesWithJudgement(
	entries: readonly LogEntry[],
	judgements: ReadonlyMap<string, AIJudgement>,
): EntryWithJudgement[] {
	const out: EntryWithJudgement[] = [];
	for (const entry of entries) {
		if (!isRisk(entry)) continue;
		const judgement = judgements.get(entry.id);
		if (!judgement) continue;
		out.push({ entry, judgement });
	}
	return out;
}

function reasonLabel(riskMap: RiskMap, reason: number): string {
	return riskMap ? riskMap.label(reason) : (DEFAULT_REASON_MAP[reason] ?? "未知类型");
}

function contextSummary(messages: readonly string[], maxLen: number): string {
	if (messages.length === 0) return "（无上下文）";
	const joined = messages.join(" | ");
	if (maxLen > 0) {
		const chars = Array.from(joined);
		if (chars.length > maxLen) return `${chars.slice(0, maxLen).join("")}…`;
	}
	return joined;
}

function toSample(
	entry: LogEntry,
	judgement: AIJudgement,
	riskMap: RiskMap,
	purpose: string,
): Sample {
	return {
		reasonLabel: reasonLabel(riskMap, entry.reason),
		currentMessage: entry.currentMessage,
		contextSummary: contextSummary(entry.contextMessages, 300),
		aiReason: judgement.aiReason,
		purpose,
	};
}

function modelTrainingSamples(
	entries: readonly LogEntry[],
	judgements: ReadonlyMap<string, AIJudgement>,
	riskMap: RiskMap,
	topN: number,
): Sample[] {
	const items = riskEntriesWithJudgement(entries, judgements);
	items.sort((a, b) => b.entry.confidence - a.entry.confidence);
	return buildSamples(items, riskMap, topN, SAMPLE_PURPOSES.modelTraining);
}

function falsePositiveSamples(
	entries: readonly LogEntry[],
	judgements: ReadonlyMap<string, AIJudgement>,
	riskMap: RiskMap,
	topN: number,
): Sample[] {
	const items = riskEntriesWithJudgement(entries, judgements).filter(
		(item) => item.judgement.isFalsePositive,
	);
	items.sort((a, b) => a.entry.confidence - b.entry.confidence);
	return buildSamples(items, riskMap, topN, SAMPLE_PURPOSES.falsePositive);
}

function ruleTuningSamples(
	entries: readonly LogEntry[],
	judgements: ReadonlyMap<string, AIJudgement>,
	riskMap: RiskMap,
	topN: number,
): Sample[] {
	const items = riskEntriesWithJudgement(entries, judgements).filter((item) => {
		const original = reasonLabel(riskMap, item.entry.reason);
		return item.judgement.aiLabel !== "" && item.judgement.aiLabel !== original;
	});
	return buildSamples(items, riskMap, topN, SAMPLE_PURPOSES.ruleTuning);
}

function manualReviewSamples(
	entries: readonly LogEntry[],
	judgements: ReadonlyMap<string, AIJudgement>,
	riskMap: RiskMap,
	topN: number,
): Sample[] {
	const items = riskEntriesWithJudgement(entries, judgements).filter(
		(item) => item.judgement.suggestedAction === "人工复核",
	);
	return buildSamples(items, riskMap, topN, SAMPLE_PURPOSES.manualReview);
}

function operationSamples(
	clusters: readonly ClusterRepresentative[],
	topN: number,
): Sample[] {
	if (clusters.length === 0) return [];
	return clusters.slice(0, topN).map((cluster) => ({
		reasonLabel: cluster.reasonLabel,
		currentMessage: cluster.message,
		contextSummary: cluster.contextSummary,
		aiReason: "",
		purpose: SAMPLE_PURPOSES.operationAction,
	}));
}

function buildSamples(
	items: readonly EntryWithJudgement[],
	riskMap: RiskMap,
	topN: number,
	purpose: string,
): Sample[] {
	return items.slice(0, topN).map((item) => toSample(item.entry, item.judgement, riskMap, purpose));
}
