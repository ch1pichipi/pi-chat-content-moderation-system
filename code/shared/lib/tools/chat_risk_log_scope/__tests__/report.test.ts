import assert from "node:assert/strict";
import { test } from "node:test";

import { renderReport, type ReportData } from "../report/render.ts";
import type { Summary } from "../types.ts";

function summary(overrides: Partial<Summary> = {}): Summary {
	return {
		totalCount: 2,
		riskCount: 1,
		normalCount: 1,
		reasonCounts: { [-1]: 1, 5: 1 },
		reasonRatios: { [-1]: 0.5, 5: 0.5 },
		highConfidenceRisk: 1,
		lowConfidenceSuspect: 0,
		accountCount: 1,
		areaServerCount: 1,
		...overrides,
	};
}

function reportData(): ReportData {
	return {
		summary: summary(),
		riskDistribution: [{ reason: 5, label: "广告诈骗", count: 1, ratio: 0.5 }],
		accounts: [
			{
				account: "abcdef",
				nickname: "昵称|测试",
				count: 1,
				mainReason: 5,
				mainReasonLabel: "广告诈骗",
				highRiskCount: 1,
				suspectedRepeat: false,
				recommendedAction: "加入黑名单",
			},
		],
		samples: [
			{
				reasonLabel: "广告诈骗",
				currentMessage: "这是一条很长的消息内容",
				contextSummary: "上下文",
				aiReason: "理由",
				purpose: "模型训练样本",
			},
		],
		falsePositives: [
			{
				entryId: "log_1",
				account: "abcdef",
				message: "疑似误杀消息",
				originalLabel: "广告诈骗",
				confidence: 0.4,
				aiLabel: "广告诈骗",
				aiReason: "低置信度",
				hits: ["低置信度：原判定为风险但置信度低于阈值，疑似误杀"],
			},
		],
		judgementsSummary: {
			total: 1,
			degradedCount: 1,
			falsePositiveCount: 1,
			actionCounts: { 加入黑名单: 1 },
		},
	};
}

test("report: 7 段结构完整", () => {
	const markdown = renderReport(
		{
			title: "聊天风险日志分析报告",
			generatedAt: new Date(2026, 6, 23, 14, 48, 53),
			inputFile: "inline",
			logCount: 2,
			masked: true,
			messageMaxLength: 200,
		},
		reportData(),
	);
	for (const heading of [
		"## 1. 本次日志概览",
		"## 2. 风险类型分布",
		"## 3. 重点账号列表",
		"## 4. 典型样本",
		"## 5. 疑似误杀样本",
		"## 6. 处置建议",
		"## 7. 后续优化建议",
	]) {
		assert.ok(markdown.includes(heading), heading);
	}
	assert.match(markdown, /\*\*生成时间\*\*: 2026-07-23 14:48:53/);
	assert.ok(markdown.includes("**报告结束**"));
});

test("report: 默认脱敏、消息截断、表格转义", () => {
	const data = reportData();
	const markdown = renderReport(
		{
			title: "报告",
			generatedAt: new Date(),
			inputFile: "inline",
			logCount: 2,
			masked: true,
			messageMaxLength: 3,
		},
		data,
	);
	assert.ok(markdown.includes("a****f"));
	assert.ok(!markdown.includes("abcdef"));
	assert.ok(markdown.includes("这是一…"));
	assert.ok(markdown.includes("昵称\\|测试"));
});

test("report: noMask 时展示原账号", () => {
	const markdown = renderReport(
		{
			title: "报告",
			generatedAt: new Date(),
			inputFile: "inline",
			logCount: 2,
			masked: false,
			messageMaxLength: 200,
		},
		reportData(),
	);
	assert.ok(markdown.includes("abcdef"));
	assert.ok(!markdown.includes("a****f"));
});

test("report: 空数据展示占位文案", () => {
	const markdown = renderReport(
		{
			title: "报告",
			generatedAt: new Date(),
			inputFile: "inline",
			logCount: 0,
			masked: true,
			messageMaxLength: 200,
		},
		{
			summary: summary({
				totalCount: 0,
				riskCount: 0,
				normalCount: 0,
				reasonCounts: {},
				reasonRatios: {},
				highConfidenceRisk: 0,
				lowConfidenceSuspect: 0,
				accountCount: 0,
				areaServerCount: 0,
			}),
			riskDistribution: [],
			accounts: [],
			samples: [],
			falsePositives: [],
			judgementsSummary: { total: 0, degradedCount: 0, falsePositiveCount: 0, actionCounts: {} },
		},
	);
	assert.ok(markdown.includes("_无风险日志_"));
	assert.ok(markdown.includes("_无重点账号_"));
	assert.ok(markdown.includes("_无典型样本_"));
	assert.ok(markdown.includes("_无疑似误杀样本_"));
	assert.ok(markdown.includes("_无处置建议_"));
});

test("report: 增量模式显示报告序号", () => {
	const markdown = renderReport(
		{
			title: "报告",
			generatedAt: new Date(),
			inputFile: "inline",
			logCount: 2,
			masked: true,
			messageMaxLength: 200,
			reportSeq: 3,
		},
		reportData(),
	);
	assert.match(markdown, /^# 报告 <3>/);
	assert.ok(markdown.includes("**报告序号**: 3"));
});
