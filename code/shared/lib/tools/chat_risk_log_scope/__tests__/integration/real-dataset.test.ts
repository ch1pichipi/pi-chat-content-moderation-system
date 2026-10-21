/**
 * 100 条真实场景风格数据集的回归测试。
 *
 * 数据集特征：
 * - 100 条日志、10 个账号、3 个区服组合。
 * - 覆盖 9 种 reason，包含广告、辱骂、政治宗教、色情、运营规避、暴恐、渠道禁止等。
 * - 账号行为模式固定，便于验证统计、重点账号、误杀与样本逻辑。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { analyzeFile } from "../../analyze.ts";
import type { AnalysisResult } from "../../types.ts";

const cwd = process.cwd();
const fixtureDir = path.join(
	cwd,
	"code/shared/lib/tools/chat_risk_log_scope/__fixtures__",
);
const csvPath = path.join(
	fixtureDir,
	"logs/real/chat_risk_real_20261020_100.csv",
);
const jsonPath = path.join(
	fixtureDir,
	"logs/real/chat_risk_real_20261020_100.json",
);
const expectedPath = path.join(
	fixtureDir,
	"expected/chat_risk_real_20261020_100.expected.summary.json",
);

const expected = JSON.parse(await readFile(expectedPath, "utf8")) as {
	summary: AnalysisResult["summary"];
	riskDistribution: AnalysisResult["riskDistribution"];
	accounts: AnalysisResult["accounts"];
	judgementsSummary: AnalysisResult["judgementsSummary"];
	falsePositiveCount: number;
	samplesCount: number;
	samplePurposeCounts: Record<string, number>;
};

async function analyzeCsv(noMask = true): Promise<AnalysisResult> {
	return analyzeFile({
		source: { kind: "file", path: csvPath },
		options: { noMask },
		cwd,
	});
}

test("real dataset: 100 条日志、10 个账号的统计与账号聚合稳定", async () => {
	const result = await analyzeCsv();

	assert.equal(result.summary.totalCount, 100);
	assert.equal(result.summary.riskCount, 70);
	assert.equal(result.summary.normalCount, 30);
	assert.equal(result.summary.accountCount, 10);
	assert.equal(result.summary.areaServerCount, 3);
	assert.equal(result.summary.highConfidenceRisk, 40);
	assert.equal(result.summary.lowConfidenceSuspect, 17);

	assert.deepEqual(result.summary, expected.summary);
	assert.deepEqual(result.riskDistribution, expected.riskDistribution);
	assert.deepEqual(result.accounts, expected.accounts);
	assert.deepEqual(result.judgementsSummary, expected.judgementsSummary);
	assert.equal(result.warnings.length, 0);
});

test("real dataset: CSV 与 JSON 输入结果一致", async () => {
	const csv = await analyzeCsv();
	const json = await analyzeFile({
		source: { kind: "file", path: jsonPath },
		options: { noMask: true },
		cwd,
	});

	assert.deepEqual(json.summary, csv.summary);
	assert.deepEqual(json.riskDistribution, csv.riskDistribution);
	assert.deepEqual(json.accounts, csv.accounts);
	assert.deepEqual(json.judgementsSummary, csv.judgementsSummary);
	assert.deepEqual(
		json.falsePositives.map((item) => item.entryId),
		csv.falsePositives.map((item) => item.entryId),
	);
});

test("real dataset: 疑似误杀、样本分布与 Mock 降级统计", async () => {
	const result = await analyzeCsv();

	assert.equal(result.falsePositives.length, expected.falsePositiveCount);
	assert.equal(result.samples.length, expected.samplesCount);

	const purposes = result.samples.reduce<Record<string, number>>((counts, sample) => {
		counts[sample.purpose] = (counts[sample.purpose] ?? 0) + 1;
		return counts;
	}, {});
	assert.deepEqual(purposes, expected.samplePurposeCounts);

	assert.equal(result.judgementsSummary.total, 70);
	assert.equal(result.judgementsSummary.degradedCount, 70);
	assert.equal(result.judgementsSummary.falsePositiveCount, expected.falsePositiveCount);
});

test("real dataset: 默认脱敏且报告包含固定 7 段", async () => {
	const result = await analyzeCsv(false);

	assert.equal(result.meta.masked, true);
	assert.equal(result.summary.accountCount, 10);
	assert.equal(result.accounts[0].account, "u*******1");

	for (const index of [1, 2, 3, 4, 5, 6, 7]) {
		assert.ok(
			result.meta.reportMarkdown.includes(`## ${index}. `),
			`报告缺少第 ${index} 段`,
		);
	}
});
