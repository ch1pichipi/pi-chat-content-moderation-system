/**
 * 整份日志分析编排：加载 → 统计 → 风险映射 → Mock 判断 → 误杀 → 账号 → 样本 → 报告。
 */

import { aggregateAccounts } from "./account.ts";
import { MockJudge } from "./ai/mock.ts";
import {
	DEFAULT_INCREMENTAL_LIMIT,
	DEFAULT_INCREMENTAL_STATE_FILE,
	normalizeAnalyzeOptions,
	type AnalyzeOptionsInput,
} from "./config.ts";
import { evaluateFalsePositive } from "./false-positive.ts";
import { IncrementalState, nextReportSeq } from "./incremental/state.ts";
import { detectFormat, loadFromFile, loadFromText, type LogFormat } from "./loader/index.ts";
import { maskAccount, truncate } from "./mask.ts";
import { renderReport } from "./report/render.ts";
import { writeMarkdownReport } from "./report/write.ts";
import { RiskMap } from "./risk-map.ts";
import { extractSamples } from "./sample.ts";
import { resolveWorkspaceFile, resolveWorkspaceWritePath } from "./security.ts";
import { summarize } from "./stats.ts";
import type {
	AIJudgement,
	AccountSummary,
	AnalysisResult,
	FalsePositiveItem,
	JudgementsSummary,
	LogEntry,
	RiskDistributionRow,
	Sample,
	SuggestedAction,
	Summary,
} from "./types.ts";

export interface AnalyzeSourceInput {
	kind: "file" | "inline";
	path?: string;
	content?: string;
	format?: LogFormat;
}

export interface AnalyzeIncrementalInput {
	enabled?: boolean;
	stateFile?: string;
	limit?: number;
}

export interface AnalyzeOutputInput {
	format?: "json" | "markdown";
	writeReport?: boolean;
}

export interface AnalyzeFileParams {
	source: AnalyzeSourceInput;
	options?: AnalyzeOptionsInput;
	incremental?: AnalyzeIncrementalInput;
	output?: AnalyzeOutputInput;
	/** 工作区根目录；默认使用 process.cwd()。 */
	cwd?: string;
	signal?: AbortSignal;
}

const MAX_WARNINGS_RETURNED = 200;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("操作已取消");
}

function emptySummary(): Summary {
	return {
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
}

function emptyJudgementsSummary(): JudgementsSummary {
	return { total: 0, degradedCount: 0, falsePositiveCount: 0, actionCounts: {} };
}

function buildJudgementsSummary(judgements: readonly AIJudgement[]): JudgementsSummary {
	const actionCounts: Partial<Record<SuggestedAction, number>> = {};
	let degradedCount = 0;
	let falsePositiveCount = 0;
	for (const judgement of judgements) {
		if (judgement.degraded) degradedCount++;
		if (judgement.isFalsePositive) falsePositiveCount++;
		actionCounts[judgement.suggestedAction] =
			(actionCounts[judgement.suggestedAction] ?? 0) + 1;
	}
	return { total: judgements.length, degradedCount, falsePositiveCount, actionCounts };
}

function buildRiskDistribution(
	summary: Summary,
	riskMap: RiskMap,
): RiskDistributionRow[] {
	return Object.entries(summary.reasonCounts)
		.map(([reasonKey, count]) => ({
			reason: Number(reasonKey),
			label: riskMap.label(Number(reasonKey)),
			count,
			ratio: summary.reasonRatios[Number(reasonKey)] ?? 0,
		}))
		.filter((row) => row.reason !== -1)
		.sort((a, b) => b.count - a.count || a.reason - b.reason);
}

function limitWarnings(warnings: string[]): string[] {
	if (warnings.length <= MAX_WARNINGS_RETURNED) return warnings;
	return [
		...warnings.slice(0, MAX_WARNINGS_RETURNED),
		`另有 ${warnings.length - MAX_WARNINGS_RETURNED} 条容错告警已省略`,
	];
}

function effectiveTimeMs(entry: LogEntry): number {
	return entry.createTime ? entry.createTime.getTime() : Number.NEGATIVE_INFINITY;
}

function maskAndTruncateSamples(
	samples: Sample[],
	messageMaxLength: number,
): Sample[] {
	return samples.map((sample) => ({
		...sample,
		currentMessage: truncate(sample.currentMessage, messageMaxLength),
		contextSummary: truncate(sample.contextSummary, messageMaxLength),
	}));
}

function maskAccounts(accounts: AccountSummary[], noMask: boolean): AccountSummary[] {
	return accounts.map((account) => ({
		...account,
		account: maskAccount(account.account, noMask),
	}));
}

function maskFalsePositives(
	items: FalsePositiveItem[],
	noMask: boolean,
	messageMaxLength: number,
): FalsePositiveItem[] {
	return items.map((item) => ({
		...item,
		account: maskAccount(item.account, noMask),
		message: truncate(item.message, messageMaxLength),
	}));
}

/** 执行整份日志分析。 */
export async function analyzeFile(params: AnalyzeFileParams): Promise<AnalysisResult> {
	const startedAt = Date.now();
	const cwd = params.cwd ?? process.cwd();
	const signal = params.signal;
	throwIfAborted(signal);

	const { options, warnings: optionWarnings } = normalizeAnalyzeOptions(params.options ?? {});
	const outputFormat = params.output?.format ?? "markdown";
	if (outputFormat !== "json" && outputFormat !== "markdown") {
		throw new Error('参数 output.format 必须是 "json" 或 "markdown"');
	}

	const warnings: string[] = [...optionWarnings];

	// 1. 加载
	const source = params.source;
	if (!source || typeof source !== "object") {
		throw new Error("source 参数缺失");
	}

	let loaded: { entries: LogEntry[]; warnings: string[]; format: LogFormat };
	let sourceLabel: string;
	if (source.kind === "file") {
		if (!source.path) throw new Error("source.kind=file 时必须提供 source.path");
		const absolutePath = await resolveWorkspaceFile(cwd, source.path);
		sourceLabel = source.path;
		const result = await loadFromFile(absolutePath);
		loaded = result;
		if (source.format && source.format !== result.format) {
			warnings.push(
				`source.format=${source.format} 与文件扩展名推断的 ${result.format} 不一致，已按文件扩展名解析`,
			);
		}
	} else if (source.kind === "inline") {
		if (typeof source.content !== "string" || source.content.trim() === "") {
			throw new Error("source.kind=inline 时必须提供非空 source.content");
		}
		if (source.format !== "csv" && source.format !== "json") {
			throw new Error('source.kind=inline 时 source.format 必须是 "csv" 或 "json"');
		}
		const result = loadFromText(source.content, source.format);
		loaded = result;
		sourceLabel = "inline";
	} else {
		throw new Error('source.kind 必须是 "file" 或 "inline"');
	}

	throwIfAborted(signal);
	warnings.push(...loaded.warnings);

	// 2. 增量过滤
	const incrementalEnabled = params.incremental?.enabled === true;
	const limit = params.incremental?.limit ?? DEFAULT_INCREMENTAL_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
		throw new Error("参数 incremental.limit 必须是 1~10000 之间的整数");
	}

	let entries = loaded.entries;
	let incrementalMeta: AnalysisResult["meta"]["incremental"];
	let state: IncrementalState | null = null;
	let nextCursor: Date | null = null;

	if (incrementalEnabled) {
		const configuredStateFile = params.incremental?.stateFile ?? DEFAULT_INCREMENTAL_STATE_FILE;
		const statePath = await resolveWorkspaceWritePath(cwd, configuredStateFile);
		state = await IncrementalState.load(statePath);
		const lastTimeBefore = state.lastTime ? state.lastTime.toISOString() : null;
		const lastTimeMs = state.lastTime ? state.lastTime.getTime() : Number.NEGATIVE_INFINITY;

		const filtered = loaded.entries
			.filter((entry) => effectiveTimeMs(entry) > lastTimeMs)
			.sort((a, b) => effectiveTimeMs(a) - effectiveTimeMs(b));

		const missingCreateTime = loaded.entries.filter((entry) => !entry.createTime).length;
		if (missingCreateTime > 0) {
			warnings.push(
				`增量模式：${missingCreateTime} 条记录缺少可解析的 create_time，已跳过（无法参与时间游标比较）`,
			);
		}

		const hasMore = filtered.length > limit;
		entries = filtered.slice(0, limit);

		if (entries.length > 0) {
			const maxTime = entries[entries.length - 1].createTime;
			if (maxTime) nextCursor = new Date(maxTime.getTime() + 1);
		}

		incrementalMeta = {
			enabled: true,
			lastTimeBefore,
			lastTimeAfter: nextCursor ? nextCursor.toISOString() : lastTimeBefore,
			limit,
			hasMore,
		};

		if (entries.length === 0) {
			warnings.push("增量模式：无新消息");
			const reportMarkdown = "# 聊天风险日志分析报告\n\n_增量模式：无新消息_\n";
			return {
				summary: emptySummary(),
				riskDistribution: [],
				accounts: [],
				samples: [],
				falsePositives: [],
				judgementsSummary: emptyJudgementsSummary(),
				warnings: limitWarnings(warnings),
				meta: {
					source: sourceLabel,
					totalEntries: loaded.entries.length,
					processedEntries: 0,
					masked: !options.noMask,
					judgeMode: "mock",
					elapsedMs: Date.now() - startedAt,
					reportMarkdown,
					incremental: incrementalMeta,
				},
			};
		}
		if (hasMore) {
			warnings.push(`增量模式：本批处理 ${limit} 条，仍有更多新消息待下次调用处理`);
		}
	}

	throwIfAborted(signal);

	// 3. 统计与风险映射
	const riskMap = new RiskMap(options.reasonMap);
	const summary = summarize(entries, {
		highConfidence: options.highConfidence,
		lowConfidence: options.lowConfidence,
	});

	// 4. Mock 判断（只判断风险日志）
	const riskEntries = entries.filter((entry) => entry.reason !== -1);
	const judge = new MockJudge({
		riskMap,
		highConfidence: options.highConfidence,
		lowConfidence: options.lowConfidence,
	});
	const judgements: AIJudgement[] = await judge.judgeBatch(riskEntries, signal);
	const judgementMap = new Map<string, AIJudgement>();
	for (let i = 0; i < riskEntries.length; i++) {
		judgementMap.set(riskEntries[i].id, judgements[i]);
	}

	// 5. 疑似误杀
	const falsePositives: FalsePositiveItem[] = [];
	for (const entry of riskEntries) {
		const judgement = judgementMap.get(entry.id);
		if (!judgement) continue;
		const result = evaluateFalsePositive(entry, judgement, riskMap.label(entry.reason), {
			lowConfidence: options.lowConfidence,
		});
		if (!result.isFalsePositive) continue;
		falsePositives.push({
			entryId: entry.id,
			account: entry.account,
			message: entry.currentMessage,
			originalLabel: riskMap.label(entry.reason),
			confidence: entry.confidence,
			aiLabel: judgement.aiLabel,
			aiReason: judgement.aiReason,
			hits: result.hits,
		});
	}

	// 6. 重点账号
	const accounts = aggregateAccounts(entries, {
		highConfidence: options.highConfidence,
		repeatWindowMs: options.repeatWindowMinutes * 60_000,
	}, riskMap);

	// 7. 典型样本
	const samples = extractSamples(entries, judgementMap, riskMap, options.topN);

	// 8. 报告
	const judgementsSummary = buildJudgementsSummary(judgements);
	const riskDistribution = buildRiskDistribution(summary, riskMap);
	const generatedAt = new Date();
	const reportSeq = incrementalEnabled && params.output?.writeReport === true ? nextReportSeq() : 0;
	const reportMarkdown = renderReport(
		{
			title: "聊天风险日志分析报告",
			generatedAt,
			inputFile: sourceLabel,
			logCount: entries.length,
			masked: !options.noMask,
			messageMaxLength: options.messageMaxLength,
			reportSeq,
		},
		{ summary, riskDistribution, accounts, samples, falsePositives, judgementsSummary },
	);

	let reportPath: string | undefined;
	if (params.output?.writeReport === true) {
		const written = await writeMarkdownReport(reportMarkdown, {
			cwd,
			generatedAt,
			reportSeq,
		});
		reportPath = written.relativePath;
	}

	// 9. 增量游标落盘（仅在整批分析成功后）
	if (incrementalEnabled && state && nextCursor) {
		state.updateLastTime(nextCursor);
		await state.save();
	}

	const messageMaxLength = options.messageMaxLength;
	return {
		summary,
		riskDistribution,
		accounts: maskAccounts(accounts, options.noMask),
		samples: maskAndTruncateSamples(samples, messageMaxLength),
		falsePositives: maskFalsePositives(falsePositives, options.noMask, messageMaxLength),
		judgementsSummary,
		warnings: limitWarnings(warnings),
		meta: {
			source: sourceLabel,
			totalEntries: loaded.entries.length,
			processedEntries: entries.length,
			masked: !options.noMask,
			judgeMode: "mock",
			reportPath,
			elapsedMs: Date.now() - startedAt,
			reportMarkdown,
			incremental: incrementalMeta,
		},
	};
}

export { detectFormat };
