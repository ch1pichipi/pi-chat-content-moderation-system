import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import type { AnalysisResult, JudgeMessageResult } from "../types.ts";
import registerChatRiskLogScope from "../index.ts";
import { analyzeFileTool } from "../tools/analyze-file.tool.ts";
import { fetchLogsTool } from "../tools/fetch-logs.tool.ts";
import { judgeMessageTool } from "../tools/judge-message.tool.ts";
import { saveJudgementsTool } from "../tools/save-judgements.tool.ts";
import {
	analyzeFileParameters,
	fetchLogsParameters,
	judgeMessageParameters,
	saveJudgementsParameters,
} from "../tools/schema.ts";

type ToolResult = { content: Array<{ type: string; text?: string }>; details: unknown; isError?: boolean };

function textOf(result: ToolResult): string {
	const item = result.content[0];
	assert.equal(item.type, "text");
	return item.text ?? "";
}

const ctxOf = (cwd: string) => ({ cwd }) as never;

const smallCsv = [
	"id,account,reason,confidence,current_message,create_time",
	"1,abcdef,5,0.9,加微信,2026-07-23 10:00:00",
	"2,abcdef,-1,0.1,你好,2026-07-23 10:00:01",
].join("\n");

test("analyze-file tool: 内联 CSV 返回 Markdown 报告与结构化 details", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-tool-"));
	const result = (await analyzeFileTool.execute(
		"call-1",
		{ source: { kind: "inline", content: smallCsv, format: "csv" } },
		undefined,
		undefined,
		ctxOf(dir),
	)) as ToolResult;

	assert.equal(result.isError, undefined);
	const details = result.details as AnalysisResult;
	assert.equal(details.summary.totalCount, 2);
	assert.equal(details.accounts[0].account, "a****f");
	const text = textOf(result);
	assert.match(text, /^# 聊天风险日志分析报告/);
	assert.ok(text.includes("## 7. 后续优化建议"));
});

test("analyze-file tool: json 输出为可解析 JSON 且不含完整报告正文", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-tool-json-"));
	const result = (await analyzeFileTool.execute(
		"call-2",
		{
			source: { kind: "inline", content: smallCsv, format: "csv" },
			output: { format: "json" },
		},
		undefined,
		undefined,
		ctxOf(dir),
	)) as ToolResult;

	const parsed = JSON.parse(textOf(result)) as AnalysisResult;
	assert.equal(parsed.summary.totalCount, 2);
	assert.equal(parsed.meta.reportMarkdown, undefined);
});

test("analyze-file tool: 路径逃逸、文件不存在、行数超限均返回可读错误", async () => {
	const parent = await mkdtemp(path.join(os.tmpdir(), "chat-risk-escape-"));
	const workspace = path.join(parent, "workspace");
	await mkdir(workspace);
	await writeFile(path.join(parent, "outside.csv"), smallCsv, "utf8");

	const escape = (await analyzeFileTool.execute(
		"call-3",
		{ source: { kind: "file", path: "../outside.csv" } },
		undefined,
		undefined,
		ctxOf(workspace),
	)) as ToolResult;
	assert.equal(escape.isError, true);
	assert.match(textOf(escape), /工作区/);

	const missing = (await analyzeFileTool.execute(
		"call-4",
		{ source: { kind: "file", path: "not-found.csv" } },
		undefined,
		undefined,
		ctxOf(workspace),
	)) as ToolResult;
	assert.equal(missing.isError, true);
	assert.match(textOf(missing), /日志文件不存在/);

	const huge = `id,account\n${Array.from({ length: 100_001 }, (_, i) => `${i},acc`).join("\n")}`;
	const overLimit = (await analyzeFileTool.execute(
		"call-5",
		{ source: { kind: "inline", content: huge, format: "csv" } },
		undefined,
		undefined,
		ctxOf(workspace),
	)) as ToolResult;
	assert.equal(overLimit.isError, true);
	assert.match(textOf(overLimit), /超过上限/);
});

test("analyze-file tool: writeReport 写入工作区 reports/", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-tool-write-"));
	const result = (await analyzeFileTool.execute(
		"call-6",
		{
			source: { kind: "inline", content: smallCsv, format: "csv" },
			output: { writeReport: true },
		},
		undefined,
		undefined,
		ctxOf(dir),
	)) as ToolResult;
	const details = result.details as AnalysisResult;
	assert.ok(details.meta.reportPath);
	assert.match(details.meta.reportPath!, /^reports\//);
});

test("analyze-file tool: 超过 20MB 的文件被拒绝", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-tool-big-"));
	await writeFile(path.join(dir, "big.csv"), "x".repeat(20 * 1024 * 1024 + 1), "utf8");
	const result = (await analyzeFileTool.execute(
		"call-big",
		{ source: { kind: "file", path: "big.csv" } },
		undefined,
		undefined,
		ctxOf(dir),
	)) as ToolResult;
	assert.equal(result.isError, true);
	assert.match(textOf(result), /20MB/);
});

test("analyze-file tool: 取消信号返回错误", async () => {
	const controller = new AbortController();
	controller.abort();
	const result = (await analyzeFileTool.execute(
		"call-7",
		{ source: { kind: "inline", content: smallCsv, format: "csv" } },
		controller.signal,
		undefined,
		ctxOf(os.tmpdir()),
	)) as ToolResult;
	assert.equal(result.isError, true);
	assert.match(textOf(result), /已取消/);
});

test("judge-message tool: 纯文本与带原判定两条路径", async () => {
	const pure = (await judgeMessageTool.execute(
		"call-8",
		{ message: "代练 加微信" },
		undefined,
		undefined,
		ctxOf(os.tmpdir()),
	)) as ToolResult;
	assert.equal(pure.isError, undefined);
	const pureDetails = pure.details as JudgeMessageResult;
	assert.equal(pureDetails.judgement.inferredReason, 5);
	assert.equal(pureDetails.judgement.suggestedAction, "加入黑名单");
	assert.match(textOf(pure), /命中关键词/);

	const original = (await judgeMessageTool.execute(
		"call-9",
		{ message: "普通内容", reason: 3, confidence: 0.3 },
		undefined,
		undefined,
		ctxOf(os.tmpdir()),
	)) as ToolResult;
	const originalDetails = original.details as JudgeMessageResult;
	assert.equal(originalDetails.judgement.suggestedAction, "人工复核");
	assert.equal(originalDetails.judgement.isFalsePositive, true);
});

test("judge-message tool: 参数错误返回可读错误", async () => {
	const result = (await judgeMessageTool.execute(
		"call-10",
		{ message: "" },
		undefined,
		undefined,
		ctxOf(os.tmpdir()),
	)) as ToolResult;
	assert.equal(result.isError, true);
	assert.match(textOf(result), /message 必须是非空字符串/);
});

test("工具 Schema: 名称与关键字段", () => {
	assert.equal(analyzeFileTool.name, "chat_risk_log_scope_analyze_file");
	assert.equal(judgeMessageTool.name, "chat_risk_log_scope_judge_message");
	assert.equal(fetchLogsTool.name, "chat_risk_log_scope_fetch_logs");
	assert.equal(saveJudgementsTool.name, "chat_risk_log_scope_save_judgements");
	const analyzeSchema = JSON.stringify(analyzeFileParameters);
	assert.ok(analyzeSchema.includes('"source"'));
	assert.ok(analyzeSchema.includes('"incremental"'));
	assert.ok(analyzeSchema.includes('"writeReport"'));
	const judgeSchema = JSON.stringify(judgeMessageParameters);
	assert.ok(judgeSchema.includes('"reason"'));
	assert.ok(judgeSchema.includes('"confidence"'));
	assert.equal(judgeMessageTool.annotations?.readOnlyHint, true);

	const fetchSchema = JSON.stringify(fetchLogsParameters);
	assert.ok(fetchSchema.includes('"limit"'));
	assert.ok(fetchSchema.includes('"includeJudged"'));
	assert.equal(fetchLogsTool.annotations?.readOnlyHint, true);

	const saveSchema = JSON.stringify(saveJudgementsParameters);
	assert.ok(saveSchema.includes('"judgements"'));
	assert.ok(saveSchema.includes('"log_id"'));
	assert.ok(saveSchema.includes('"is_risk"'));
	assert.equal(saveJudgementsTool.annotations?.readOnlyHint, false);
});

test("extension: 默认工厂注册四个工具", () => {
	const names: string[] = [];
	const fakePi = {
		registerTool: (tool: { name: string }) => {
			names.push(tool.name);
		},
	};
	registerChatRiskLogScope(fakePi as never);
	assert.deepEqual(names, [
		"chat_risk_log_scope_analyze_file",
		"chat_risk_log_scope_judge_message",
		"chat_risk_log_scope_fetch_logs",
		"chat_risk_log_scope_save_judgements",
	]);
});

test("extension: pi loader 可加载并发现四个工具", async () => {
	const extensionPath = path.resolve(import.meta.dirname, "..", "index.ts");
	const result = await discoverAndLoadExtensions([extensionPath], process.cwd());
	assert.deepEqual(result.errors, []);
	const names = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
	assert.ok(names.includes("chat_risk_log_scope_analyze_file"));
	assert.ok(names.includes("chat_risk_log_scope_judge_message"));
	assert.ok(names.includes("chat_risk_log_scope_fetch_logs"));
	assert.ok(names.includes("chat_risk_log_scope_save_judgements"));
});
