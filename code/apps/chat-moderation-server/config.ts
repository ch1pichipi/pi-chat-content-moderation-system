/**
 * 实时聊天封禁服务配置。
 *
 * 所有阈值都有默认值，可通过环境变量覆盖；非法值直接抛错，避免带着错误配置启动。
 */

import path from "node:path";

export type AgentMode = "pi" | "mock";

export interface AnalysisConfig {
	/** 分析窗口：最近 N 分钟。 */
	windowMinutes: number;
	/** 分析窗口：最多 M 条消息。 */
	maxMessages: number;
	/** 历史统计回看小时数（风险数、封禁数）。 */
	lookbackHours: number;
	/** 同账号连续消息的防抖时间（毫秒）。 */
	debounceMs: number;
	/** 全局 Agent 并发上限。 */
	agentConcurrency: number;
	/** 单次 Agent 调用超时（毫秒）。 */
	agentTimeoutMs: number;
	/** 单条消息长度上限（字符）。 */
	maxMessageLength: number;
	/** 启动时间之前的种子日志不参与分析。 */
	serviceStartedAt: Date;
}

export interface ServerConfig {
	host: string;
	port: number;
	publicDir: string;
	policyPath: string;
	agentMode: AgentMode;
	/** 指定模型，格式 "provider/model"；留空使用 Pi 当前默认模型。 */
	agentModel?: string;
	/** Agent 失败时是否降级到关键词 Mock。 */
	agentFallbackToMock: boolean;
	analysis: AnalysisConfig;
}

export interface LoadServerConfigOptions {
	cwd?: string;
	/** 便于测试固定"服务启动时间"。 */
	now?: Date;
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function readInt(
	env: NodeJS.ProcessEnv,
	key: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = readString(env, key);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${key} 必须是 ${min}~${max} 之间的整数，当前值: ${raw}`);
	}
	return value;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
	const raw = readString(env, key);
	if (raw === undefined) return fallback;
	if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
	if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
	throw new Error(`${key} 必须是布尔值（1/0、true/false），当前值: ${raw}`);
}

function readAgentMode(env: NodeJS.ProcessEnv): AgentMode {
	const raw = readString(env, "CHAT_AGENT_MODE")?.toLowerCase();
	if (raw === undefined || raw === "pi" || raw === "auto") return "pi";
	if (raw === "mock") return "mock";
	throw new Error("CHAT_AGENT_MODE 只能是 pi / auto / mock");
}

export function loadServerConfig(
	env: NodeJS.ProcessEnv = process.env,
	options: LoadServerConfigOptions = {},
): ServerConfig {
	const cwd = options.cwd ?? process.cwd();
	const port = readInt(env, "CHAT_SERVER_PORT", 3000, 1, 65_535);
	const host = readString(env, "CHAT_SERVER_HOST") ?? "127.0.0.1";

	const windowMinutes = readInt(env, "CHAT_ANALYSIS_WINDOW_MINUTES", 10, 1, 24 * 60);
	const maxMessages = readInt(env, "CHAT_ANALYSIS_MAX_MESSAGES", 50, 1, 200);
	const lookbackHours = readInt(env, "CHAT_ANALYSIS_LOOKBACK_HOURS", 24, 1, 24 * 30);
	const debounceMs = readInt(env, "CHAT_ANALYSIS_DEBOUNCE_MS", 1_500, 0, 10_000);
	const agentConcurrency = readInt(env, "CHAT_AGENT_CONCURRENCY", 2, 1, 16);
	const agentTimeoutMs = readInt(env, "CHAT_AGENT_TIMEOUT_MS", 20_000, 1_000, 300_000);
	const maxMessageLength = readInt(env, "CHAT_MESSAGE_MAX_LENGTH", 2_000, 1, 10_000);

	const agentModel = readString(env, "CHAT_AGENT_MODEL");
	const policyPath = path.resolve(
		cwd,
		readString(env, "CHAT_POLICY_PATH") ?? "config/moderation-policy.json",
	);

	return {
		host,
		port,
		publicDir: path.resolve(cwd, "code/apps/chat-moderation-server/public"),
		policyPath,
		agentMode: readAgentMode(env),
		agentModel,
		agentFallbackToMock: readBoolean(env, "CHAT_AGENT_FALLBACK_MOCK", true),
		analysis: {
			windowMinutes,
			maxMessages,
			lookbackHours,
			debounceMs,
			agentConcurrency,
			agentTimeoutMs,
			maxMessageLength,
			serviceStartedAt: options.now ?? new Date(),
		},
	};
}
