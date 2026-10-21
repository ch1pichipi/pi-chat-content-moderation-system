import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { analyzeFile } from "../analyze.ts";
import { resetReportSeq } from "../incremental/state.ts";
import { parseTime } from "../loader/time.ts";

const cwd = process.cwd();
const csvPath = "code/shared/lib/tools/chat_risk_log_scope/__fixtures__/sample_logs.csv";
const jsonPath = "code/shared/lib/tools/chat_risk_log_scope/__fixtures__/sample_logs.json";

function assertBaseline(
	result: Awaited<ReturnType<typeof analyzeFile>>,
): void {
	assert.equal(result.summary.totalCount, 10);
	assert.equal(result.summary.riskCount, 5);
	assert.equal(result.summary.normalCount, 5);
	assert.equal(result.summary.highConfidenceRisk, 2);
	assert.equal(result.summary.lowConfidenceSuspect, 1);
	assert.equal(result.summary.accountCount, 7);
	assert.equal(result.summary.areaServerCount, 10);

	assert.equal(result.riskDistribution.length, 1);
	assert.equal(result.riskDistribution[0].reason, 0);
	assert.equal(result.riskDistribution[0].label, "其他违禁");
	assert.equal(result.riskDistribution[0].count, 5);

	assert.equal(result.accounts.length, 7);
	assert.equal(result.accounts[0].account, "n*************b");
	assert.equal(result.accounts[0].count, 3);
	assert.equal(result.accounts[0].nickname, "不吃香菜");
	assert.equal(result.accounts[1].account, "r***************y");
	assert.equal(result.accounts[1].count, 2);

	assert.equal(result.falsePositives.length, 2);
	assert.equal(result.samples.length, 9);
	assert.deepEqual(
		result.samples.reduce<Record<string, number>>((acc, sample) => {
			acc[sample.purpose] = (acc[sample.purpose] ?? 0) + 1;
			return acc;
		}, {}),
		{ 模型训练样本: 5, 误杀排查样本: 1, 人工复核样本: 3 },
	);

	assert.deepEqual(result.judgementsSummary, {
		total: 5,
		degradedCount: 5,
		falsePositiveCount: 1,
		actionCounts: { 人工复核: 3, 观察: 2 },
	});
	assert.equal(result.warnings.length, 0);
	assert.equal(result.meta.masked, true);
	assert.equal(result.meta.judgeMode, "mock");
	assert.equal(result.meta.totalEntries, 10);
	assert.equal(result.meta.processedEntries, 10);
	assert.ok(result.meta.reportMarkdown.includes("## 7. 后续优化建议"));
}

test("analyze: CSV 文件基准结果", async () => {
	const result = await analyzeFile({
		source: { kind: "file", path: csvPath },
		cwd,
	});
	assertBaseline(result);
});

test("analyze: JSON 文件基准结果与 CSV 一致", async () => {
	const result = await analyzeFile({
		source: { kind: "file", path: jsonPath },
		cwd,
	});
	assertBaseline(result);
});

test("analyze: noMask 时不脱敏账号", async () => {
	const result = await analyzeFile({
		source: { kind: "file", path: csvPath },
		options: { noMask: true },
		cwd,
	});
	assert.equal(result.meta.masked, false);
	assert.equal(result.accounts[0].account, "normal_player_b");
});

test("analyze: json 输出格式的内容可由工具层序列化", async () => {
	const result = await analyzeFile({
		source: { kind: "file", path: csvPath },
		output: { format: "json" },
		cwd,
	});
	assert.ok(result.meta.reportMarkdown.length > 0);
});

test("analyze: 内联 CSV、参数校验与错误", async () => {
	const content = [
		"id,account,reason,confidence,current_message,create_time",
		"1,acc,5,0.9,加微信,2026-07-23 10:00:00",
		"2,acc,-1,0.1,你好,2026-07-23 10:00:01",
	].join("\n");
	const result = await analyzeFile({
		source: { kind: "inline", content, format: "csv" },
		cwd,
	});
	assert.equal(result.summary.totalCount, 2);
	assert.equal(result.summary.riskCount, 1);

	await assert.rejects(
		() =>
			analyzeFile({
				source: { kind: "inline", content, format: "csv" },
				options: { lowConfidence: 0.9, highConfidence: 0.8 },
				cwd,
			}),
		/lowConfidence 不能大于/,
	);

	await assert.rejects(
		() => analyzeFile({ source: { kind: "inline", content }, cwd }),
		/source.format 必须是/,
	);

	await assert.rejects(
		() =>
			analyzeFile({
				source: { kind: "inline", content: "id\n", format: "csv" },
				cwd,
			}),
		/不含任何数据行/,
	);
});

test("analyze: 取消信号", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => analyzeFile({ source: { kind: "file", path: csvPath }, cwd, signal: controller.signal }),
		/操作已取消/,
	);
});

function incrementalContent(): string {
	return JSON.stringify([
		{
			id: "1",
			account: "acc",
			reason: 5,
			confidence: 0.9,
			current_message: "加微信",
			create_time: "2026-07-23 10:00:00.000",
		},
		{
			id: "2",
			account: "acc",
			reason: 3,
			confidence: 0.6,
			current_message: "你妈的",
			create_time: "2026-07-23 10:00:00.000",
		},
		{
			id: "3",
			account: "acc",
			reason: -1,
			confidence: 0.1,
			current_message: "你好",
			create_time: "2026-07-23 10:00:01.000",
		},
	]);
}

test("analyze: 增量模式按游标分批、同毫秒边界不重复", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-analyze-"));
	const content = incrementalContent();
	const firstTime = parseTime("2026-07-23 10:00:00.000");
	const thirdTime = parseTime("2026-07-23 10:00:01.000");
	assert.ok(firstTime && thirdTime);
	const expectedFirstCursor = new Date(firstTime.getTime() + 1).toISOString();
	const expectedSecondCursor = new Date(thirdTime.getTime() + 1).toISOString();

	const first = await analyzeFile({
		source: { kind: "inline", content, format: "json" },
		incremental: { enabled: true, limit: 2 },
		cwd: dir,
	});
	assert.equal(first.meta.processedEntries, 2);
	assert.equal(first.meta.totalEntries, 3);
	assert.equal(first.meta.incremental?.lastTimeBefore, null);
	// 同毫秒两条记录在首批内一起处理，游标为 maxTime + 1ms。
	assert.equal(first.meta.incremental?.lastTimeAfter, expectedFirstCursor);
	assert.equal(first.meta.incremental?.hasMore, true);
	assert.ok(first.warnings.some((w) => w.includes("仍有更多新消息")));

	const second = await analyzeFile({
		source: { kind: "inline", content, format: "json" },
		incremental: { enabled: true, limit: 2 },
		cwd: dir,
	});
	assert.equal(second.meta.processedEntries, 1);
	assert.equal(second.meta.incremental?.lastTimeBefore, expectedFirstCursor);
	assert.equal(second.meta.incremental?.lastTimeAfter, expectedSecondCursor);
	assert.equal(second.meta.incremental?.hasMore, false);

	const third = await analyzeFile({
		source: { kind: "inline", content, format: "json" },
		incremental: { enabled: true, limit: 2 },
		cwd: dir,
	});
	assert.equal(third.meta.processedEntries, 0);
	assert.ok(third.warnings.some((w) => w.includes("无新消息")));
});

test("analyze: 增量模式写报告追加 _seqN", async () => {
	resetReportSeq();
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-report-"));
	const result = await analyzeFile({
		source: { kind: "inline", content: incrementalContent(), format: "json" },
		incremental: { enabled: true, limit: 2 },
		output: { writeReport: true },
		cwd: dir,
	});
	assert.ok(result.meta.reportPath);
	assert.match(result.meta.reportPath!, /^reports\/chat_risk_report_\d{8}_\d{6}_seq1\.md$/);
	const files = await readdir(path.join(dir, "reports"));
	assert.equal(files.length, 1);
	assert.match(files[0], /_seq1\.md$/);

	// 状态文件与报告都位于工作区内。
	const stateFiles = await readdir(path.join(dir, ".cache"));
	assert.deepEqual(stateFiles, ["chat_risk_scope_state.json"]);
});

test("analyze: 全量模式写报告不带 seq", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-report-full-"));
	const result = await analyzeFile({
		source: { kind: "inline", content: incrementalContent(), format: "json" },
		output: { writeReport: true },
		cwd: dir,
	});
	assert.ok(result.meta.reportPath);
	assert.match(result.meta.reportPath!, /^reports\/chat_risk_report_\d{8}_\d{6}\.md$/);
});
