import assert from "node:assert/strict";
import { test } from "node:test";

import {
	AgentOutputError,
	extractJsonObject,
	parseAgentVerdict,
	stripCodeFence,
} from "../agent/judge.ts";

const VALID = {
	is_risk: true,
	reason: 5,
	label: "广告诈骗",
	confidence: 0.92,
	punishment: "ban_1h",
	duration_seconds: 3600,
	evidence: ["加我 VX 详聊"],
	summary: "该玩家在窗口内多次发布站外联系方式。",
};

test("judge: 解析合法 JSON", () => {
	const verdict = parseAgentVerdict(JSON.stringify(VALID));
	assert.equal(verdict.is_risk, true);
	assert.equal(verdict.reason, 5);
	assert.equal(verdict.punishment, "ban_1h");
	assert.equal(verdict.confidence, 0.92);
	assert.deepEqual(verdict.evidence, ["加我 VX 详聊"]);
});

test("judge: 解析 Markdown 包裹的 JSON", () => {
	const text = `\`\`\`json\n${JSON.stringify(VALID, null, 2)}\n\`\`\``;
	const verdict = parseAgentVerdict(text);
	assert.equal(verdict.reason, 5);
	assert.equal(stripCodeFence(text).startsWith("{"), true);
});

test("judge: 容忍 JSON 前后多余解释文字", () => {
	const text = `判断结果如下：\n${JSON.stringify(VALID)}\n以上。`;
	const verdict = parseAgentVerdict(text);
	assert.equal(verdict.punishment, "ban_1h");
});

test("judge: 提取嵌套 JSON 时正确匹配花括号", () => {
	const nested = '{"is_risk":false,"reason":-1,"confidence":0.9,"punishment":"none","summary":"包含 } 字符的说明 {x}"}';
	assert.equal(extractJsonObject(`前缀 ${nested} 后缀`), nested);
	assert.equal(extractJsonObject("没有 JSON"), null);
});

test("judge: 非法 JSON 抛 AgentOutputError", () => {
	assert.throws(() => parseAgentVerdict("{ not json }"), AgentOutputError);
	assert.throws(() => parseAgentVerdict("完全没有 JSON"), AgentOutputError);
	assert.throws(() => parseAgentVerdict("[]"), AgentOutputError);
});

test("judge: 字段缺失或类型错误抛 AgentOutputError", () => {
	const cases: Array<[string, Record<string, unknown>]> = [
		["is_risk", { ...VALID, is_risk: "true" }],
		["reason", { ...VALID, reason: 5.5 }],
		["confidence", { ...VALID, confidence: 1.5 }],
		["punishment", { ...VALID, punishment: "" }],
		["label", { ...VALID, label: 123 }],
		["evidence", { ...VALID, evidence: "abc" }],
	];

	for (const [field, payload] of cases) {
		assert.throws(
			() => parseAgentVerdict(JSON.stringify(payload)),
			AgentOutputError,
			`字段 ${field} 应导致解析失败`,
		);
	}

	const missing = { ...VALID } as Record<string, unknown>;
	delete missing.reason;
	assert.throws(() => parseAgentVerdict(JSON.stringify(missing)), AgentOutputError);
});

test("judge: 非法处罚枚举保留原值，交由护栏处理", () => {
	const verdict = parseAgentVerdict(
		JSON.stringify({ ...VALID, punishment: "ban_forever" }),
	);
	assert.equal(verdict.punishment, "ban_forever");
});

test("judge: evidence 过滤非字符串并截断", () => {
	const verdict = parseAgentVerdict(
		JSON.stringify({
			...VALID,
			evidence: ["a", 1, null, "b", ...Array.from({ length: 30 }, () => "x")],
		}),
	);
	assert.deepEqual(verdict.evidence.slice(0, 2), ["a", "b"]);
	assert.equal(verdict.evidence.length, 20);
});
