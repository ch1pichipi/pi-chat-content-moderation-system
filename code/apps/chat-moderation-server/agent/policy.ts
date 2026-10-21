/**
 * 处罚安全护栏：Agent 只给建议，服务端决定最终处罚。
 *
 * 规则（见变更计划 4.4）：
 *   - 服务端只降级、不升级；
 *   - 置信度、风险类型严重度、最近重复违规次数三者共同构成处罚上限；
 *   - 永久封禁必须同时满足"高危/严重风险 + 置信度 ≥ 0.95 + 有前科"；
 *   - 任何异常（动作非法、字段自相矛盾）都不封禁，转人工复核。
 *
 * 本模块是纯函数，便于单元测试覆盖误封风险。
 */

import { readFileSync } from "node:fs";

import {
	BAN_PUNISHMENT_SECONDS,
	isBanPunishment,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/bans.ts";
import { DEFAULT_REASON_MAP } from "../../../shared/lib/tools/chat_risk_log_scope/risk-map.ts";
import type { SuggestedAction } from "../../../shared/lib/tools/chat_risk_log_scope/types.ts";

/** 处罚枚举，"none" 表示不封禁且不落库。 */
export const PUNISHMENTS = ["none", "ban_1m", "ban_1h", "ban_1d", "ban_3d", "permanent"] as const;
export type Punishment = (typeof PUNISHMENTS)[number];

export const PUNISHMENT_RANK: Readonly<Record<Punishment, number>> = Object.freeze({
	none: 0,
	ban_1m: 1,
	ban_1h: 2,
	ban_1d: 3,
	ban_3d: 4,
	permanent: 5,
});

/** 处罚枚举 -> 秒数；永久与不封禁为 null。 */
export const PUNISHMENT_SECONDS: Readonly<Record<Punishment, number | null>> = Object.freeze({
	none: null,
	...BAN_PUNISHMENT_SECONDS,
});

export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export interface ConfidenceCap {
	/** 置信度下界（含）。 */
	min: number;
	punishment: Punishment;
}

export interface ModerationPolicyConfig {
	/** 置信度区间 -> 处罚上限，按 min 降序。 */
	confidenceCaps: ConfidenceCap[];
	/** reason -> 严重度。 */
	reasonSeverity: Record<number, RiskSeverity>;
	/** 严重度 -> 处罚上限。 */
	severityCaps: Record<RiskSeverity, Punishment>;
	repeat: {
		windowHours: number;
		permanentMinPriorBans: number;
		permanentOnFirstCritical: boolean;
	};
}

export const DEFAULT_MODERATION_POLICY: ModerationPolicyConfig = Object.freeze({
	confidenceCaps: [
		{ min: 0.95, punishment: "permanent" },
		{ min: 0.9, punishment: "ban_3d" },
		{ min: 0.8, punishment: "ban_1d" },
		{ min: 0.6, punishment: "ban_1h" },
	],
	reasonSeverity: {
		0: "low",
		7: "low",
		3: "medium",
		6: "medium",
		1: "high",
		2: "high",
		127: "high",
		[-128]: "high",
		4: "critical",
		5: "critical",
	},
	severityCaps: {
		low: "ban_1h",
		medium: "ban_1d",
		high: "ban_3d",
		critical: "permanent",
	},
	repeat: {
		windowHours: 24,
		permanentMinPriorBans: 2,
		permanentOnFirstCritical: false,
	},
}) as ModerationPolicyConfig;

/** 未知 reason 按低危处理（信息不足时不能重罚）。 */
export const UNKNOWN_REASON_SEVERITY: RiskSeverity = "low";

export function isPunishment(value: unknown): value is Punishment {
	return typeof value === "string" && (PUNISHMENTS as readonly string[]).includes(value);
}

export function rankToPunishment(rank: number): Punishment {
	const found = PUNISHMENTS.find((item) => PUNISHMENT_RANK[item] === rank);
	return found ?? "none";
}

export function minPunishment(...items: Punishment[]): Punishment {
	const [first, ...rest] = items;
	if (!first) return "none";
	return rest.reduce<Punishment>(
		(lowest, item) => (PUNISHMENT_RANK[item] < PUNISHMENT_RANK[lowest] ? item : lowest),
		first,
	);
}

/** 服务端 reason map 对应的标签，未知类型回落到 Agent 标签。 */
export function reasonLabel(reason: number, agentLabel?: string): string {
	const mapped = DEFAULT_REASON_MAP[reason];
	if (mapped) return mapped;
	const fallback = agentLabel?.trim();
	return fallback && fallback !== "" ? fallback : "未知类型";
}

function isSeverity(value: unknown): value is RiskSeverity {
	return typeof value === "string" && (RISK_SEVERITIES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSeverity(value: unknown, field: string): RiskSeverity {
	if (!isSeverity(value)) {
		throw new Error(`${field} 必须是 ${RISK_SEVERITIES.join(" / ")} 之一`);
	}
	return value;
}

function parsePunishment(value: unknown, field: string): Punishment {
	if (!isPunishment(value)) {
		throw new Error(`${field} 必须是 ${PUNISHMENTS.join(" / ")} 之一`);
	}
	return value;
}

/** 校验并归一化策略配置；非法配置直接抛错，避免误封。 */
export function parseModerationPolicy(value: unknown): ModerationPolicyConfig {
	if (!isRecord(value)) throw new Error("处罚策略必须是 JSON 对象");

	const confidenceCapsRaw = value.confidenceCaps;
	if (!isRecord(confidenceCapsRaw) || Object.keys(confidenceCapsRaw).length === 0) {
		throw new Error("处罚策略 confidenceCaps 必须是非空对象");
	}
	const confidenceCaps: ConfidenceCap[] = Object.entries(confidenceCapsRaw).map(([key, cap]) => {
		const min = Number(key);
		if (!Number.isFinite(min) || min < 0 || min > 1) {
			throw new Error(`处罚策略 confidenceCaps 的键必须是 0~1 的数字: ${key}`);
		}
		return { min, punishment: parsePunishment(cap, `confidenceCaps.${key}`) };
	});
	confidenceCaps.sort((a, b) => b.min - a.min);

	const severityRaw = value.reasonSeverity;
	if (!isRecord(severityRaw)) throw new Error("处罚策略 reasonSeverity 必须是对象");
	const reasonSeverity: Record<number, RiskSeverity> = {};
	for (const [key, severity] of Object.entries(severityRaw)) {
		const reason = Number(key);
		if (!Number.isInteger(reason)) {
			throw new Error(`处罚策略 reasonSeverity 的键必须是整数: ${key}`);
		}
		reasonSeverity[reason] = parseSeverity(severity, `reasonSeverity.${key}`);
	}

	const severityCapsRaw = value.severityCaps;
	if (!isRecord(severityCapsRaw)) throw new Error("处罚策略 severityCaps 必须是对象");
	const severityCaps = {} as Record<RiskSeverity, Punishment>;
	for (const severity of RISK_SEVERITIES) {
		severityCaps[severity] = parsePunishment(
			severityCapsRaw[severity],
			`severityCaps.${severity}`,
		);
	}

	const repeatRaw = value.repeat;
	if (!isRecord(repeatRaw)) throw new Error("处罚策略 repeat 必须是对象");
	const windowHours = Number(repeatRaw.windowHours);
	if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 24 * 30) {
		throw new Error("处罚策略 repeat.windowHours 必须是 1~720 之间的整数");
	}
	const permanentMinPriorBans = Number(repeatRaw.permanentMinPriorBans);
	if (!Number.isInteger(permanentMinPriorBans) || permanentMinPriorBans < 1) {
		throw new Error("处罚策略 repeat.permanentMinPriorBans 必须是正整数");
	}
	if (typeof repeatRaw.permanentOnFirstCritical !== "boolean") {
		throw new Error("处罚策略 repeat.permanentOnFirstCritical 必须是布尔值");
	}

	return {
		confidenceCaps,
		reasonSeverity,
		severityCaps,
		repeat: {
			windowHours,
			permanentMinPriorBans,
			permanentOnFirstCritical: repeatRaw.permanentOnFirstCritical,
		},
	};
}

/** 读取策略文件；文件不存在时回落到默认策略。 */
export function loadModerationPolicy(
	filePath: string,
	onWarning?: (message: string) => void,
): ModerationPolicyConfig {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			onWarning?.(`未找到处罚策略文件 ${filePath}，使用内置默认策略`);
			return DEFAULT_MODERATION_POLICY;
		}
		throw new Error(`读取处罚策略失败: ${filePath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`处罚策略文件不是合法 JSON: ${filePath}`);
	}
	return parseModerationPolicy(parsed);
}

export interface PolicyInput {
	isRisk: boolean;
	reason: number;
	confidence: number;
	/** Agent 输出的原始处罚枚举，可能是非法值。 */
	requestedPunishment: string;
	/** 最近 N 小时内该账号的历史封禁数（含已过期/已解封）。 */
	priorBanCount: number;
	/** Agent 返回的标签，仅作参考。 */
	agentLabel?: string;
}

export interface PolicyDecision {
	/** 服务端最终执行的处罚。 */
	applied: Punishment;
	/** Agent 建议的处罚；非法时 null。 */
	requested: Punishment | null;
	/** 实际封禁秒数；none 与 permanent 均为 null。 */
	banSeconds: number | null;
	/** 是否被服务端降级。 */
	adjusted: boolean;
	/** 是否需要人工复核。 */
	manualReview: boolean;
	action: SuggestedAction;
	severity: RiskSeverity | null;
	label: string;
	notes: string[];
}

/** 处罚 -> 判断结果的 action 映射（见计划 4.4.5 第 6 条）。 */
export function punishmentToAction(punishment: Punishment, isRisk: boolean): SuggestedAction {
	switch (punishment) {
		case "permanent":
			return "加入黑名单";
		case "ban_1m":
		case "ban_1h":
		case "ban_1d":
		case "ban_3d":
			return "封禁";
		case "none":
			return isRisk ? "人工复核" : "放行";
	}
}

function confidenceCapFor(config: ModerationPolicyConfig, confidence: number): Punishment {
	for (const cap of config.confidenceCaps) {
		if (confidence >= cap.min) return cap.punishment;
	}
	return "none";
}

function severityFor(config: ModerationPolicyConfig, reason: number): RiskSeverity {
	return config.reasonSeverity[reason] ?? UNKNOWN_REASON_SEVERITY;
}

function repeatCapFor(
	config: ModerationPolicyConfig,
	severity: RiskSeverity,
	confidence: number,
	priorBanCount: number,
): Punishment {
	const highConfidence = confidence >= 0.95;
	const { permanentMinPriorBans, permanentOnFirstCritical } = config.repeat;

	if (priorBanCount >= permanentMinPriorBans) {
		// 有 >= 2 次前科：high / critical 且高置信度才允许永久。
		if (highConfidence && (severity === "high" || severity === "critical")) return "permanent";
		return "ban_3d";
	}
	if (priorBanCount >= 1) {
		// 有 1 次前科：仅 critical + 高置信度允许永久。
		if (highConfidence && severity === "critical") return "permanent";
		return "ban_3d";
	}
	// 无前科：默认不允许永久。
	if (permanentOnFirstCritical && highConfidence && severity === "critical") return "permanent";
	return "ban_3d";
}

function invalidDecision(label: string, requested: Punishment | null, notes: string[]): PolicyDecision {
	return {
		applied: "none",
		requested,
		banSeconds: null,
		adjusted: false,
		manualReview: true,
		action: "人工复核",
		severity: null,
		label,
		notes,
	};
}

/** 根据策略与输入计算最终处罚。 */
export function resolvePolicy(
	config: ModerationPolicyConfig,
	input: PolicyInput,
): PolicyDecision {
	const label = reasonLabel(input.reason, input.agentLabel);
	const requested = isPunishment(input.requestedPunishment) ? input.requestedPunishment : null;
	const confidence = Number.isFinite(input.confidence)
		? Math.min(1, Math.max(0, input.confidence))
		: 0;

	if (!requested) {
		return invalidDecision(label, null, [
			`Agent 处罚动作非法（${JSON.stringify(input.requestedPunishment)}），按不封禁处理并转人工复核`,
		]);
	}

	const reasonIsNormal = input.reason === -1;
	if (input.isRisk !== !reasonIsNormal) {
		return invalidDecision(label, requested, [
			`判断字段自相矛盾（is_risk=${input.isRisk}, reason=${input.reason}），按不封禁处理并转人工复核`,
		]);
	}

	if (!input.isRisk) {
		const adjusted = requested !== "none";
		return {
			applied: "none",
			requested,
			banSeconds: null,
			adjusted,
			manualReview: false,
			action: punishmentToAction("none", false),
			severity: null,
			label,
			notes: adjusted ? ["判断为正常，忽略 Agent 建议的处罚"] : [],
		};
	}

	const severity = severityFor(config, input.reason);
	const severityCap = config.severityCaps[severity];
	const confidenceCap = confidenceCapFor(config, confidence);
	const repeatCap = repeatCapFor(config, severity, confidence, input.priorBanCount);
	const applied = minPunishment(requested, severityCap, confidenceCap, repeatCap);

	const notes: string[] = [];
	const requestedRank = PUNISHMENT_RANK[requested];
	if (PUNISHMENT_RANK[severityCap] < requestedRank) {
		notes.push(`严重度 ${severity}(reason=${input.reason}) 处罚上限 ${severityCap}`);
	}
	if (PUNISHMENT_RANK[confidenceCap] < requestedRank) {
		notes.push(
			`置信度 ${confidence.toFixed(2)} 处罚上限 ${confidenceCap}` +
				(confidenceCap === "none" ? "（低于 0.60 不封禁）" : ""),
		);
	}
	if (PUNISHMENT_RANK[repeatCap] < requestedRank) {
		notes.push(
			`最近 ${config.repeat.windowHours}h 历史封禁 ${input.priorBanCount} 次，处罚上限 ${repeatCap}`,
		);
	}
	if (input.agentLabel && input.agentLabel.trim() !== "" && input.agentLabel !== label) {
		notes.push(`Agent 标签与 reason map 不一致（${input.agentLabel} ≠ ${label}），以服务端为准`);
	}

	return {
		applied,
		requested,
		banSeconds: PUNISHMENT_SECONDS[applied],
		adjusted: applied !== requested,
		manualReview: applied === "none",
		action: punishmentToAction(applied, true),
		severity,
		label,
		notes,
	};
}
