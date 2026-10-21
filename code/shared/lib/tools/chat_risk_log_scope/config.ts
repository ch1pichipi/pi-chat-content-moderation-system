/**
 * 工具配置：默认值、参数归一化与校验。
 *
 * v1 配置以 TS 对象形式从工具参数传入，不读取 YAML、不读取任何密钥。
 */

export interface AnalyzeOptionsInput {
	highConfidence?: number;
	lowConfidence?: number;
	repeatWindowMinutes?: number;
	topN?: number;
	noMask?: boolean;
	messageMaxLength?: number;
	reasonMap?: Record<string, string>;
}

export interface ResolvedAnalyzeOptions {
	highConfidence: number;
	lowConfidence: number;
	repeatWindowMinutes: number;
	topN: number;
	noMask: boolean;
	messageMaxLength: number;
	reasonMap: Record<string, string>;
}

/** 单条消息输入长度上限，避免超长文本导致匹配性能问题。 */
export const MAX_MESSAGE_INPUT_LENGTH = 10_000;

export const DEFAULT_ANALYZE_OPTIONS: Readonly<ResolvedAnalyzeOptions> = Object.freeze({
	highConfidence: 0.8,
	lowConfidence: 0.5,
	repeatWindowMinutes: 60,
	topN: 5,
	noMask: false,
	messageMaxLength: 200,
	reasonMap: {},
});

export interface NormalizedOptions<T> {
	options: T;
	warnings: string[];
}

function assertProbability(value: unknown, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`参数 options.${name} 必须是 0~1 之间的数字`);
	}
	return value;
}

function assertNonNegativeNumber(value: unknown, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`参数 options.${name} 必须是非负数字`);
	}
	return value;
}

function normalizeReasonMap(
	reasonMap: Record<string, string> | undefined,
	warnings: string[],
): Record<string, string> {
	if (!reasonMap) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(reasonMap)) {
		if (!/^[+-]?\d+$/.test(key.trim())) {
			warnings.push(`reasonMap 中的键 ${JSON.stringify(key)} 不是整数，已忽略`);
			continue;
		}
		if (typeof value !== "string" || value.trim() === "") {
			warnings.push(`reasonMap 中 ${key} 的标签为空，已忽略`);
			continue;
		}
		out[String(Number(key))] = value;
	}
	return out;
}

/** 归一化整份日志分析参数；非法参数直接抛错，由工具层转换为可读错误。 */
export function normalizeAnalyzeOptions(
	input: AnalyzeOptionsInput = {},
): NormalizedOptions<ResolvedAnalyzeOptions> {
	const warnings: string[] = [];

	const highConfidence = assertProbability(
		input.highConfidence,
		"highConfidence",
		DEFAULT_ANALYZE_OPTIONS.highConfidence,
	);
	const lowConfidence = assertProbability(
		input.lowConfidence,
		"lowConfidence",
		DEFAULT_ANALYZE_OPTIONS.lowConfidence,
	);
	if (lowConfidence > highConfidence) {
		throw new Error("参数 options.lowConfidence 不能大于 options.highConfidence");
	}

	const repeatWindowMinutes = assertNonNegativeNumber(
		input.repeatWindowMinutes,
		"repeatWindowMinutes",
		DEFAULT_ANALYZE_OPTIONS.repeatWindowMinutes,
	);

	let topN = DEFAULT_ANALYZE_OPTIONS.topN;
	if (input.topN !== undefined) {
		if (!Number.isInteger(input.topN) || input.topN < 1 || input.topN > 50) {
			throw new Error("参数 options.topN 必须是 1~50 之间的整数");
		}
		topN = input.topN;
	}

	let messageMaxLength = DEFAULT_ANALYZE_OPTIONS.messageMaxLength;
	if (input.messageMaxLength !== undefined) {
		if (
			!Number.isInteger(input.messageMaxLength) ||
			input.messageMaxLength < 0 ||
			input.messageMaxLength > 5000
		) {
			throw new Error("参数 options.messageMaxLength 必须是 0~5000 之间的整数（0 表示不截断）");
		}
		messageMaxLength = input.messageMaxLength;
	}

	return {
		options: {
			highConfidence,
			lowConfidence,
			repeatWindowMinutes,
			topN,
			noMask: input.noMask === true,
			messageMaxLength,
			reasonMap: normalizeReasonMap(input.reasonMap, warnings),
		},
		warnings,
	};
}

export interface JudgeMessageOptionsInput {
	highConfidence?: number;
	lowConfidence?: number;
	noMask?: boolean;
	messageMaxLength?: number;
	reasonMap?: Record<string, string>;
}

export interface ResolvedJudgeMessageOptions {
	highConfidence: number;
	lowConfidence: number;
	noMask: boolean;
	messageMaxLength: number;
	reasonMap: Record<string, string>;
}

/** 归一化单条消息判断参数。 */
export function normalizeJudgeMessageOptions(
	input: JudgeMessageOptionsInput = {},
): NormalizedOptions<ResolvedJudgeMessageOptions> {
	const warnings: string[] = [];
	const highConfidence = assertProbability(
		input.highConfidence,
		"highConfidence",
		DEFAULT_ANALYZE_OPTIONS.highConfidence,
	);
	const lowConfidence = assertProbability(
		input.lowConfidence,
		"lowConfidence",
		DEFAULT_ANALYZE_OPTIONS.lowConfidence,
	);
	if (lowConfidence > highConfidence) {
		throw new Error("参数 options.lowConfidence 不能大于 options.highConfidence");
	}

	let messageMaxLength = DEFAULT_ANALYZE_OPTIONS.messageMaxLength;
	if (input.messageMaxLength !== undefined) {
		if (
			!Number.isInteger(input.messageMaxLength) ||
			input.messageMaxLength < 0 ||
			input.messageMaxLength > 5000
		) {
			throw new Error("参数 options.messageMaxLength 必须是 0~5000 之间的整数（0 表示不截断）");
		}
		messageMaxLength = input.messageMaxLength;
	}

	return {
		options: {
			highConfidence,
			lowConfidence,
			noMask: input.noMask === true,
			messageMaxLength,
			reasonMap: normalizeReasonMap(input.reasonMap, warnings),
		},
		warnings,
	};
}

/** 增量配置默认值。 */
export const DEFAULT_INCREMENTAL_STATE_FILE = ".cache/chat_risk_scope_state.json";
export const DEFAULT_INCREMENTAL_LIMIT = 100;
