/**
 * 按账号维度聚合日志，识别重点/高风险账号（README 功能 3）。
 */

import { DEFAULT_REASON_MAP, type RiskMap, severeAction } from "./risk-map.ts";
import type { AccountSummary, LogEntry, SuggestedAction } from "./types.ts";
import { isRisk } from "./types.ts";

export interface AccountConfig {
	/** 高风险消息置信度阈值，默认 0.8。 */
	highConfidence: number;
	/** 重复违规判定的时间窗口（毫秒），默认 60 分钟。 */
	repeatWindowMs: number;
}

/** 按 account 分组聚合，输出按出现次数降序排列的重点账号列表。空账号不参与聚合。 */
export function aggregateAccounts(
	entries: readonly LogEntry[],
	cfg: AccountConfig,
	riskMap: RiskMap,
): AccountSummary[] {
	const groups = new Map<string, LogEntry[]>();
	for (const entry of entries) {
		if (entry.account === "") continue;
		const group = groups.get(entry.account);
		if (group) group.push(entry);
		else groups.set(entry.account, [entry]);
	}

	const summaries: AccountSummary[] = [];
	for (const [account, items] of groups) {
		summaries.push(summarizeAccount(account, items, cfg, riskMap));
	}

	// 稳定排序：次数相同时保持首次出现顺序。
	summaries.sort((a, b) => b.count - a.count);
	return summaries;
}

function summarizeAccount(
	account: string,
	items: LogEntry[],
	cfg: AccountConfig,
	riskMap: RiskMap,
): AccountSummary {
	const summary: AccountSummary = {
		account,
		nickname: "",
		count: items.length,
		mainReason: 0,
		mainReasonLabel: "",
		highRiskCount: 0,
		suspectedRepeat: false,
		recommendedAction: "放行",
	};

	summary.nickname = latestNickname(items);

	const reasonCounts = new Map<number, number>();
	const riskItems: LogEntry[] = [];
	for (const entry of items) {
		if (!isRisk(entry)) continue;
		reasonCounts.set(entry.reason, (reasonCounts.get(entry.reason) ?? 0) + 1);
		riskItems.push(entry);
		if (entry.confidence >= cfg.highConfidence) summary.highRiskCount++;
	}

	const main = mainReason(reasonCounts, riskMap);
	summary.mainReason = main.reason;
	summary.mainReasonLabel = main.label;
	summary.suspectedRepeat = suspectedRepeat(riskItems, cfg.repeatWindowMs);
	summary.recommendedAction = recommendAction(summary, riskMap);
	return summary;
}

/** 取 reviewedTime 最新一条记录的昵称；若均无有效时间，取最后一条非空昵称。 */
function latestNickname(items: readonly LogEntry[]): string {
	let nickname = "";
	let hasTime = false;
	let latestMs = -Infinity;
	for (const entry of items) {
		if (entry.nickname === "") continue;
		const ms = entry.reviewedTime ? entry.reviewedTime.getTime() : NaN;
		if (!Number.isFinite(ms)) {
			if (nickname === "") nickname = entry.nickname;
			continue;
		}
		if (!hasTime || ms > latestMs) {
			hasTime = true;
			latestMs = ms;
			nickname = entry.nickname;
		}
	}
	return nickname;
}

/** 返回出现频次最高的 reason；频次相同时取数值较小的 reason，保证结果可复现。 */
function mainReason(
	reasonCounts: Map<number, number>,
	riskMap: RiskMap,
): { reason: number; label: string } {
	if (reasonCounts.size === 0) return { reason: 0, label: "" };
	const reasons = [...reasonCounts.keys()].sort((a, b) => a - b);
	let best = reasons[0];
	for (const reason of reasons.slice(1)) {
		if ((reasonCounts.get(reason) ?? 0) > (reasonCounts.get(best) ?? 0)) best = reason;
	}
	const label = riskMap ? riskMap.label(best) : DEFAULT_REASON_MAP[best];
	return { reason: best, label };
}

/**
 * 判断是否疑似重复违规：同一 reason 的风险条目中，存在任意两条记录时间差 <= window。
 * 条目缺少有效时间时退化为"同一 reason 至少 2 条"的宽松判定。
 */
function suspectedRepeat(riskItems: readonly LogEntry[], windowMs: number): boolean {
	const byReason = new Map<number, LogEntry[]>();
	for (const entry of riskItems) {
		const group = byReason.get(entry.reason);
		if (group) group.push(entry);
		else byReason.set(entry.reason, [entry]);
	}

	for (const group of byReason.values()) {
		if (group.length < 2) continue;
		if (windowMs <= 0) return true;

		const times: number[] = [];
		for (const entry of group) {
			if (entry.reviewedTime) times.push(entry.reviewedTime.getTime());
		}
		if (times.length === 0) return true;

		times.sort((a, b) => a - b);
		for (let i = 1; i < times.length; i++) {
			if (times[i] - times[i - 1] <= windowMs) return true;
		}
	}
	return false;
}

/** 基于高风险消息数量与重复违规情况给出推荐处置动作。 */
export function recommendAction(summary: AccountSummary, riskMap: RiskMap): SuggestedAction {
	if (summary.highRiskCount >= 3) return "加入黑名单";
	if (summary.highRiskCount >= 1 && summary.suspectedRepeat) return "封禁";
	if (summary.highRiskCount >= 1) return severeAction(summary.mainReason);
	if (summary.suspectedRepeat) return "观察";
	if (summary.mainReason !== 0 || summary.mainReasonLabel !== "") return "人工复核";
	// riskMap 参数保留在签名中，与 Go 版本保持一致，便于后续扩展。
	void riskMap;
	return "放行";
}
