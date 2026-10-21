/**
 * Agent 调用与输出解析。
 *
 * 安全约束（见计划 4.5）：
 *   - 每次分析创建独立内存会话，上下文不串号；
 *   - 不加载任何工具（tools: []），Agent 无法读写文件/数据库/执行命令；
 *   - 单次调用超时后放弃本次封禁；
 *   - 输出必须是严格 JSON，解析失败一律不封禁。
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { MODERATION_SYSTEM_PROMPT, buildAnalysisPrompt } from "./prompt.ts";
import type { AgentVerdict, AnalysisInput } from "./types.ts";

/** 一次性 Agent 判断结果，附带模型标识与降级标记。 */
export interface JudgeResult {
	verdict: AgentVerdict;
	model: string;
	/** true 表示来自 Mock/规则降级，而非真实大模型。 */
	degraded: boolean;
}

export interface Judge {
	judge(input: AnalysisInput, signal?: AbortSignal): Promise<JudgeResult>;
}

/** 输出不是合法 JSON / 字段缺失时抛出。 */
export class AgentOutputError extends Error {
	readonly rawText: string;

	constructor(message: string, rawText = "") {
		super(message);
		this.name = "AgentOutputError";
		this.rawText = rawText;
	}
}

/** Agent 调用超时。 */
export class AgentTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentTimeoutError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 去掉 Markdown 代码块包裹，保留内部文本。 */
export function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
	if (fence) return fence[1].trim();
	return trimmed;
}

/** 从自由文本中截取第一个完整 JSON 对象（容忍模型多写解释文字）。 */
export function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return null;
}

/**
 * 解析 Agent 输出为 AgentVerdict。
 *
 * 只校验结构；合法性（处罚枚举、字段自相矛盾）交给 policy 层判定，
 * 这样非法动作也能作为审计记录保留下来。
 */
export function parseAgentVerdict(text: string): AgentVerdict {
	const raw = stripCodeFence(text);
	const jsonText = raw.startsWith("{") ? raw : extractJsonObject(raw);
	if (!jsonText) {
		throw new AgentOutputError("Agent 输出中没有 JSON 对象", text);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		throw new AgentOutputError(
			`Agent 输出不是合法 JSON: ${(error as Error).message}`,
			jsonText,
		);
	}
	if (!isRecord(parsed)) {
		throw new AgentOutputError("Agent 输出必须是 JSON 对象", jsonText);
	}

	const { is_risk, reason, label, confidence, punishment, duration_seconds, evidence, summary } =
		parsed;

	if (typeof is_risk !== "boolean") {
		throw new AgentOutputError("Agent 输出字段 is_risk 缺失或不是布尔值", jsonText);
	}
	if (typeof reason !== "number" || !Number.isInteger(reason)) {
		throw new AgentOutputError("Agent 输出字段 reason 缺失或不是整数", jsonText);
	}
	if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
		throw new AgentOutputError("Agent 输出字段 confidence 缺失或不在 0~1 之间", jsonText);
	}
	if (typeof punishment !== "string" || punishment.trim() === "") {
		throw new AgentOutputError("Agent 输出字段 punishment 缺失或不是字符串", jsonText);
	}
	if (label !== undefined && typeof label !== "string") {
		throw new AgentOutputError("Agent 输出字段 label 必须是字符串", jsonText);
	}
	if (
		duration_seconds !== undefined &&
		duration_seconds !== null &&
		(typeof duration_seconds !== "number" || !Number.isFinite(duration_seconds))
	) {
		throw new AgentOutputError("Agent 输出字段 duration_seconds 必须是数字或 null", jsonText);
	}
	if (evidence !== undefined && !Array.isArray(evidence)) {
		throw new AgentOutputError("Agent 输出字段 evidence 必须是数组", jsonText);
	}
	if (summary !== undefined && typeof summary !== "string") {
		throw new AgentOutputError("Agent 输出字段 summary 必须是字符串", jsonText);
	}

	return {
		is_risk,
		reason,
		label: typeof label === "string" ? label.trim() : "",
		confidence,
		punishment: punishment.trim(),
		// 服务端不信任 duration_seconds，仅做记录；实际秒数由枚举映射。
		duration_seconds:
			typeof duration_seconds === "number" && Number.isFinite(duration_seconds)
				? duration_seconds
				: null,
		evidence: Array.isArray(evidence)
			? evidence.filter((item): item is string => typeof item === "string").slice(0, 20)
			: [],
		summary: typeof summary === "string" ? summary.trim() : "",
	};
}

function assistantText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(part): part is { type: "text"; text: string } =>
					isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
	}
	return "";
}

export interface PiAgentJudgeOptions {
	/** "provider/model"；留空使用 Pi 当前默认模型。 */
	model?: string;
	timeoutMs: number;
	systemPrompt?: string;
	cwd?: string;
}

let sharedRuntime: ModelRuntime | null = null;

async function getModelRuntime(): Promise<ModelRuntime> {
	if (!sharedRuntime) sharedRuntime = await ModelRuntime.create();
	return sharedRuntime;
}

/** 仅用于测试：释放缓存的 ModelRuntime。 */
export function resetModelRuntime(): void {
	sharedRuntime = null;
}

export class PiAgentJudge implements Judge {
	constructor(private readonly options: PiAgentJudgeOptions) {}

	private async resolveModel(modelRuntime: ModelRuntime) {
		const ref = this.options.model;
		if (!ref) return undefined;
		const slash = ref.indexOf("/");
		if (slash <= 0 || slash === ref.length - 1) {
			throw new Error(`CHAT_AGENT_MODEL 格式应为 provider/model，当前值: ${ref}`);
		}
		const provider = ref.slice(0, slash);
		const modelId = ref.slice(slash + 1);
		const model = modelRuntime.getModel(provider, modelId);
		if (!model) {
			throw new Error(`找不到模型 ${provider}/${modelId}，请检查 ~/.pi/agent/models.json`);
		}
		return model;
	}

	async judge(input: AnalysisInput, signal?: AbortSignal): Promise<JudgeResult> {
		const cwd = this.options.cwd ?? process.cwd();
		const modelRuntime = await getModelRuntime();
		const model = await this.resolveModel(modelRuntime);

		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: this.options.systemPrompt ?? MODERATION_SYSTEM_PROMPT,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			modelRuntime,
			model,
			resourceLoader,
			// 禁止 Agent 使用任何工具：不能读写文件、不能访问数据库、不能执行命令。
			tools: [],
			sessionManager: SessionManager.inMemory(cwd),
		});

		let text = "";
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end") return;
			if (event.message.role !== "assistant") return;
			text += assistantText(event.message);
		});

		let timedOut = false;
		const abortSession = () => {
			void session.abort().catch(() => {});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			abortSession();
		}, this.options.timeoutMs);
		timer.unref?.();
		const onExternalAbort = () => abortSession();
		signal?.addEventListener("abort", onExternalAbort, { once: true });

		const modelName = session.model
			? `${session.model.provider}/${session.model.id}`
			: (this.options.model ?? "unknown");

		try {
			await session.prompt(buildAnalysisPrompt(input), {
				expandPromptTemplates: false,
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onExternalAbort);
			unsubscribe();
			session.dispose();
		}

		if (timedOut) {
			throw new AgentTimeoutError(
				`Agent 调用超过 ${this.options.timeoutMs}ms，本次不封禁`,
			);
		}
		if (signal?.aborted) {
			throw new Error("分析任务已取消");
		}
		if (text.trim() === "") {
			throw new AgentOutputError("Agent 未返回任何内容");
		}

		return { verdict: parseAgentVerdict(text), model: modelName, degraded: false };
	}
}
