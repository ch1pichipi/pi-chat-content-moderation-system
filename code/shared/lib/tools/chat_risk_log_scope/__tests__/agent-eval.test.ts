import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
	formatScoreReport,
	parseAgentOutput,
	parseGroundTruth,
	scoreAgentJudgements,
	type AgentPrediction,
	type GroundTruthLabel,
} from "../agent-eval/score.ts";

const evalDir = path.join(
	process.cwd(),
	"code/shared/lib/tools/chat_risk_log_scope/__fixtures__/agent-eval",
);
const blindPath = path.join(evalDir, "blind/agent_eval_20261020_100.jsonl");
const groundTruthPath = path.join(evalDir, "ground-truth/agent_eval_20261020_100.labels.json");

function parseJsonLines(text: string): Array<Record<string, unknown>> {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("agent eval: 盲测集不包含任何判定字段，账号可聚合且不超过 10 个", async () => {
	const blind = parseJsonLines(await readFile(blindPath, "utf8"));
	const labels = parseGroundTruth(await readFile(groundTruthPath, "utf8")).labels;

	assert.equal(blind.length, 100);
	assert.equal(labels.length, 100);
	assert.equal(new Set(blind.map((entry) => entry.id)).size, 100);
	assert.equal(new Set(blind.map((entry) => entry.account)).size, 10);

	const forbiddenKeys = [
		"reason",
		"confidence",
		"judge_result",
		"label",
		"prediction",
		"reviewed_at",
		"level",
		"expected_reason",
		"expected_label",
		"expected_action",
	];
	for (const entry of blind) {
		for (const key of forbiddenKeys) {
			assert.equal(Object.prototype.hasOwnProperty.call(entry, key), false, `${entry.id} 泄露字段 ${key}`);
		}
		assert.equal(typeof entry.current_message, "string");
		assert.ok((entry.current_message as string).length > 0);
	}

	assert.deepEqual(
		new Set(labels.map((label) => label.id)),
		new Set(blind.map((entry) => entry.id)),
	);
});

test("agent eval: 使用 ground truth 回放时所有指标为 1", async () => {
	const groundTruth = parseGroundTruth(await readFile(groundTruthPath, "utf8"));
	const predictions: AgentPrediction[] = groundTruth.labels.map((label) => ({
		id: label.id,
		isRisk: label.expectedRisk,
		reason: label.expectedReason,
		label: label.expectedLabel,
		confidence: label.expectedRisk ? 0.9 : 0.1,
		action: label.expectedAction,
		evidence: [],
	}));

	const report = scoreAgentJudgements(groundTruth.dataset, groundTruth.labels, predictions);
	assert.equal(report.matched, 100);
	assert.equal(report.missingIds.length, 0);
	assert.equal(report.extraIds.length, 0);
	assert.equal(report.binary.accuracy, 1);
	assert.equal(report.binary.precision, 1);
	assert.equal(report.binary.recall, 1);
	assert.equal(report.binary.f1, 1);
	assert.equal(report.reason.accuracy, 1);
	assert.equal(report.reason.macroF1, 1);
	assert.equal(report.action.accuracy, 1);
	assert.ok(report.confidence);
	assert.ok(report.confidence!.brierScore < 0.02);

	const markdown = formatScoreReport(report);
	assert.match(markdown, /# Agent 独立判断评测报告/);
	assert.match(markdown, /## 2\. reason 分类/);
	assert.match(markdown, /## 4\. 难度分组/);
});

test("agent eval: 评分能识别误报、动作错误与缺失预测", () => {
	const labels: GroundTruthLabel[] = [
		{
			id: "1",
			expectedRisk: false,
			expectedReason: -1,
			expectedLabel: "正常",
			expectedAction: "放行",
			difficulty: "easy",
		},
		{
			id: "2",
			expectedRisk: true,
			expectedReason: 5,
			expectedLabel: "广告诈骗",
			expectedAction: "加入黑名单",
			difficulty: "easy",
		},
		{
			id: "3",
			expectedRisk: true,
			expectedReason: 3,
			expectedLabel: "侮辱谩骂",
			expectedAction: "禁言",
			difficulty: "hard",
		},
	];
	const predictions: AgentPrediction[] = [
		{
			id: "1",
			isRisk: true,
			reason: 5,
			label: "广告诈骗",
			confidence: 0.8,
			action: "加入黑名单",
			evidence: [],
		},
		{
			id: "2",
			isRisk: true,
			reason: 5,
			label: "广告诈骗",
			confidence: 0.9,
			action: "观察",
			evidence: [],
		},
	];

	const report = scoreAgentJudgements("unit", labels, predictions);
	assert.deepEqual(report.missingIds, ["3"]);
	assert.deepEqual(report.extraIds, []);
	assert.equal(report.matched, 2);
	assert.equal(report.binary.tp, 1);
	assert.equal(report.binary.fp, 1);
	assert.equal(report.binary.tn, 0);
	// 缺失预测不计入混淆矩阵，由 coverage / missingIds 单独暴露。
	assert.equal(report.binary.fn, 0);
	assert.equal(report.binary.recall, 1);
	assert.equal(report.binary.coverage, 2 / 3);
	assert.equal(report.binary.accuracy, 1 / 3);
	assert.equal(report.reason.accuracy, 1 / 3);
	assert.equal(report.action.accuracy, 0);
	assert.equal(report.difficulty.find((item) => item.difficulty === "hard")?.reasonAccuracy, 0);
});

test("agent eval: 支持 JSONL、代码块包裹与非法输出校验", () => {
	const predictions = parseAgentOutput(
		[
			"```json",
			'{"id":"1","is_risk":false,"reason":-1,"label":"正常","confidence":0.9,"action":"放行"}',
			'{"id":"2","is_risk":true,"reason":5,"label":"广告诈骗","confidence":0.8,"action":"加入黑名单"}',
			"```",
		].join("\n"),
	);
	assert.equal(predictions.length, 2);
	assert.equal(predictions[1].reason, 5);

	assert.throws(
		() => parseAgentOutput('{"id":"1","is_risk":false,"reason":-1,"confidence":1.2,"action":"放行"}'),
		/confidence 必须在 0~1/,
	);
	assert.throws(
		() => parseAgentOutput('{"id":"1","is_risk":false,"reason":-1,"confidence":0.5,"action":"放行"}\n{"id":"1","is_risk":false,"reason":-1,"confidence":0.5,"action":"放行"}'),
		/重复 id/,
	);
});
