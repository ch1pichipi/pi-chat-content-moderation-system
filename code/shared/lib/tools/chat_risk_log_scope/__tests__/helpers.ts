import type { AIJudgement, LogEntry } from "../types.ts";

/** 构造测试用 LogEntry，未指定字段使用默认值。 */
export function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: "id",
		requestId: "",
		account: "",
		appId: "",
		areaId: "",
		areaName: "",
		serverId: "",
		nickname: "",
		contextMessages: [],
		currentMessage: "",
		judgeResult: "",
		contextType: "",
		reason: -1,
		confidence: 0,
		level: "",
		label: "",
		prediction: "",
		reviewedAt: "",
		forbidConsidered: false,
		forbidDeduped: false,
		reviewedTime: null,
		createTime: null,
		createTimeStr: "",
		warnings: [],
		...overrides,
	};
}

/** 构造测试用 AIJudgement。 */
export function makeJudgement(overrides: Partial<AIJudgement> = {}): AIJudgement {
	return {
		entryId: "id",
		aiLabel: "正常",
		aiReason: "",
		isFalsePositive: false,
		suggestedAction: "放行",
		degraded: true,
		...overrides,
	};
}

/** 从 ISO 字符串构造 Date。 */
export function at(iso: string): Date {
	return new Date(iso);
}
