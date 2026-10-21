/**
 * Agent 工具：chat_risk_log_scope_analyze_file
 * 分析整份日志文件（或内联 CSV/JSON），返回结构化统计与 Markdown 报告。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";

import { analyzeFile } from "../analyze.ts";
import type { AnalysisResult } from "../types.ts";
import { analyzeFileParameters } from "./schema.ts";

export type AnalyzeFileToolDetails = AnalysisResult | { error: string };

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 构造 Agent 可读的 content。 */
export function formatAnalyzeFileContent(result: AnalysisResult, format: "json" | "markdown"): string {
	if (format === "markdown") {
		return result.meta.reportMarkdown;
	}
	// 紧凑 JSON：不重复输出完整报告正文，避免 content 过长。
	const { reportMarkdown: _reportMarkdown, ...meta } = result.meta;
	return JSON.stringify({ ...result, meta });
}

export const analyzeFileTool = defineTool<typeof analyzeFileParameters, AnalyzeFileToolDetails>({
	name: "chat_risk_log_scope_analyze_file",
	label: "聊天风险日志分析",
	description:
		"读取并分析聊天风险日志（CSV/JSON），执行汇总统计、Mock 规则判断、疑似误杀排查、重点账号聚合与典型样本提取，输出 7 段 Markdown 报告或紧凑 JSON。默认脱敏、默认不写文件、不联网。",
	promptSnippet: "分析整份聊天风险日志，输出风险统计、重点账号、典型样本与疑似误杀",
	promptGuidelines: [
		"需要整体风险评估、账号画像或误杀排查时使用本工具，而不是让模型自己读大文件手工统计。",
		"默认只返回报告文本；只有用户明确要求保存时才设置 output.writeReport=true。",
		"v1 判断为 mock 规则结果，不能作为自动处罚的唯一依据，需结合人工复核。",
	],
	parameters: analyzeFileParameters,
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		try {
			const result = await analyzeFile({
				source: params.source,
				options: params.options,
				incremental: params.incremental,
				output: params.output,
				cwd: ctx?.cwd ?? process.cwd(),
				signal,
			});
			const content = formatAnalyzeFileContent(result, params.output?.format ?? "markdown");
			return {
				content: [{ type: "text" as const, text: content }],
				details: result,
			};
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: `分析失败: ${toErrorMessage(error)}` }],
				details: { error: toErrorMessage(error) },
				isError: true,
			};
		}
	},
});
