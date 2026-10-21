/**
 * 风险日志汇总统计（README 功能 1）。
 * 纯函数实现，便于单元测试与其它 TS 代码复用。
 */

import type { LogEntry, Summary } from "./types.ts";
import { isRisk } from "./types.ts";

export interface StatsConfig {
	highConfidence: number;
	lowConfidence: number;
}

/** 对给定日志条目计算汇总统计结果。 */
export function summarize(entries: readonly LogEntry[], cfg: StatsConfig): Summary {
	const summary: Summary = {
		totalCount: 0,
		riskCount: 0,
		normalCount: 0,
		reasonCounts: {},
		reasonRatios: {},
		highConfidenceRisk: 0,
		lowConfidenceSuspect: 0,
		accountCount: 0,
		areaServerCount: 0,
	};

	const accounts = new Set<string>();
	const areaServers = new Set<string>();

	for (const entry of entries) {
		summary.totalCount++;
		summary.reasonCounts[entry.reason] = (summary.reasonCounts[entry.reason] ?? 0) + 1;

		if (isRisk(entry)) {
			summary.riskCount++;
			if (entry.confidence >= cfg.highConfidence) summary.highConfidenceRisk++;
			if (entry.confidence < cfg.lowConfidence) summary.lowConfidenceSuspect++;
		} else {
			summary.normalCount++;
		}

		if (entry.account !== "") accounts.add(entry.account);
		if (entry.areaId !== "" || entry.serverId !== "") {
			areaServers.add(`${entry.areaId}/${entry.serverId}`);
		}
	}

	summary.accountCount = accounts.size;
	summary.areaServerCount = areaServers.size;

	if (summary.totalCount > 0) {
		for (const [reason, count] of Object.entries(summary.reasonCounts)) {
			summary.reasonRatios[Number(reason)] = count / summary.totalCount;
		}
	}

	return summary;
}
