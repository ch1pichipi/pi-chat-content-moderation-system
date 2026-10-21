import assert from "node:assert/strict";
import { test } from "node:test";

import { inferRiskFromKeywords, normalizeText } from "../ai/mock-keywords.ts";
import {
	judgeByKeywords,
	judgeByOriginalVerdict,
	judgeLogEntry,
	looksLikeFalsePositiveText,
	type MockJudgeConfig,
} from "../ai/mock.ts";
import { RiskMap } from "../risk-map.ts";
import { makeEntry } from "./helpers.ts";

const cfg: MockJudgeConfig = {
	riskMap: new RiskMap(),
	highConfidence: 0.8,
	lowConfidence: 0.5,
};

test("mock: 正常消息直接放行", () => {
	const judgement = judgeLogEntry(
		makeEntry({ id: "1", reason: -1, confidence: 0.99 }),
		cfg,
	);
	assert.equal(judgement.suggestedAction, "放行");
	assert.equal(judgement.degraded, true);
	assert.equal(judgement.isFalsePositive, false);
	assert.match(judgement.aiReason, /原系统判定为正常/);
});

test("mock: 低置信度风险判为疑似误杀并建议人工复核", () => {
	const judgement = judgeLogEntry(makeEntry({ id: "1", reason: 3, confidence: 0.3 }), cfg);
	assert.equal(judgement.suggestedAction, "人工复核");
	assert.equal(judgement.isFalsePositive, true);
	assert.match(judgement.aiReason, /置信度仅 0\.30 低于阈值 0\.50/);
});

test("mock: 高置信度维持原判定并从严处置", () => {
	const cases: Array<[number, string]> = [
		[4, "加入黑名单"],
		[5, "加入黑名单"],
		[1, "封禁"],
		[2, "封禁"],
		[3, "禁言"],
		[6, "禁言"],
		[7, "禁言"],
		[127, "封禁"],
		[-128, "封禁"],
		[0, "人工复核"],
	];
	for (const [reason, action] of cases) {
		const judgement = judgeLogEntry(makeEntry({ id: "1", reason, confidence: 0.95 }), cfg);
		assert.equal(judgement.suggestedAction, action, `reason=${reason}`);
		assert.match(judgement.aiReason, /建议从严处置/);
		assert.equal(judgement.degraded, true);
	}
});

test("mock: 中间区间命中疑似误判特征时观察 + 疑似误杀", () => {
	const judgement = judgeLogEntry(
		makeEntry({ id: "1", reason: 3, confidence: 0.6, currentMessage: "只是开玩笑而已" }),
		cfg,
	);
	assert.equal(judgement.suggestedAction, "观察");
	assert.equal(judgement.isFalsePositive, true);
	assert.match(judgement.aiReason, /疑似误判特征/);
	assert.equal(looksLikeFalsePositiveText("TEST message"), true);
	assert.equal(looksLikeFalsePositiveText("普通违规内容"), false);
});

test("mock: 中间区间无命中时观察但不标疑似误杀", () => {
	const judgement = judgeLogEntry(
		makeEntry({ id: "1", reason: 3, confidence: 0.6, currentMessage: "普通违规内容" }),
		cfg,
	);
	assert.equal(judgement.suggestedAction, "观察");
	assert.equal(judgement.isFalsePositive, false);
	assert.match(judgement.aiReason, /规则判断维持原判定/);
});

test("mock: 文本归一化与规避变体", () => {
	assert.equal(normalizeText("ＡＢＣ　１２３"), "abc 123");
	assert.equal(normalizeText("加\u200b微\u200b信"), "加微信");

	const plain = inferRiskFromKeywords("加微信");
	assert.equal(plain.reason, 5);
	assert.equal(plain.confidence, 0.6);
	assert.deepEqual(plain.matchedKeywords, ["加微信"]);

	for (const variant of ["加 微 信", "加*微*信", "加\u200b微信"]) {
		const match = inferRiskFromKeywords(variant);
		assert.equal(match.reason, 5, variant);
		assert.equal(match.confidence, 0.6, variant);
	}

	const fullWidth = inferRiskFromKeywords("Ｖ　Ｘ");
	assert.equal(fullWidth.reason, 6);
	assert.match(fullWidth.matchedKeywords[0], /vx/i);
});

test("mock: 关键词命中计分与多类型取最高", () => {
	const multi = inferRiskFromKeywords("代练 加群 加微信");
	assert.equal(multi.reason, 5);
	assert.equal(multi.hitCount, 3);
	assert.equal(multi.confidence, 0.8);

	const mixed = inferRiskFromKeywords("傻逼代练加群加微信");
	assert.equal(mixed.reason, 5);
	assert.equal(mixed.confidence, 0.8);

	assert.equal(inferRiskFromKeywords("你个傻逼").reason, 3);
	assert.equal(inferRiskFromKeywords("私聊我").reason, 6);
	assert.equal(inferRiskFromKeywords("我要投诉").reason, -1);
	assert.equal(inferRiskFromKeywords("我要投诉").confidence, 0);
});

test("mock: 关键词路径输出可解释结果", () => {
	const result = judgeByKeywords("加微信代练", cfg);
	assert.equal(result.match.reason, 5);
	assert.equal(result.judgement.inferredReason, 5);
	assert.equal(result.judgement.inferredConfidence, 0.7);
	assert.equal(result.judgement.suggestedAction, "加入黑名单");
	assert.ok(result.judgement.matchedKeywords?.includes("加微信"));
	assert.equal(result.judgement.degraded, true);

	const normal = judgeByKeywords("这个装备怎么样", cfg);
	assert.equal(normal.judgement.inferredReason, -1);
	assert.equal(normal.judgement.suggestedAction, "放行");
});

test("mock: 路径 A 复用日志判断逻辑", () => {
	const low = judgeByOriginalVerdict(
		{ message: "内容", reason: 3, confidence: 0.3, level: "low" },
		cfg,
	);
	assert.equal(low.suggestedAction, "人工复核");
	assert.equal(low.isFalsePositive, true);

	const high = judgeByOriginalVerdict({ message: "内容", reason: 5, confidence: 0.9 }, cfg);
	assert.equal(high.suggestedAction, "加入黑名单");
	assert.equal(high.aiLabel, "广告诈骗");

	const normal = judgeByOriginalVerdict({ message: "内容", reason: -1, confidence: 0.9 }, cfg);
	assert.equal(normal.suggestedAction, "放行");
});
