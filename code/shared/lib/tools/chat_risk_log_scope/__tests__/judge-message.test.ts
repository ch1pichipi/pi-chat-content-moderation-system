import assert from "node:assert/strict";
import { test } from "node:test";

import { formatJudgeMessageContent, judgeMessage } from "../judge-message.ts";

test("judge-message: 路径 A（带原判定）- 低置信度", async () => {
	const result = await judgeMessage({
		message: "我要投诉",
		reason: 0,
		confidence: 0.3,
		level: "low",
	});
	assert.equal(result.judgement.suggestedAction, "人工复核");
	assert.equal(result.judgement.isFalsePositive, true);
	assert.equal(result.judgement.degraded, true);
	assert.equal(result.original.reason, 0);
	assert.equal(result.original.confidence, 0.3);
	assert.equal(result.original.reasonLabel, "其他违禁");
	assert.equal(result.meta.judgeMode, "mock");
	assert.equal(result.meta.masked, true);
});

test("judge-message: 路径 A（带原判定）- 高置信度", async () => {
	const result = await judgeMessage({
		message: "加微信",
		reason: 5,
		confidence: 0.95,
	});
	assert.equal(result.judgement.suggestedAction, "加入黑名单");
	assert.equal(result.judgement.aiLabel, "广告诈骗");
	assert.equal(result.judgement.inferredReason, 5);
});

test("judge-message: 路径 B（纯文本）命中关键词", async () => {
	const result = await judgeMessage({ message: "代练 加群 加微信" });
	assert.equal(result.judgement.inferredReason, 5);
	assert.equal(result.judgement.inferredConfidence, 0.8);
	assert.equal(result.judgement.suggestedAction, "加入黑名单");
	assert.ok(result.judgement.matchedKeywords?.length);
	assert.equal(result.original.reason, null);
});

test("judge-message: 路径 B 无命中放行", async () => {
	const result = await judgeMessage({ message: "这个装备怎么样" });
	assert.equal(result.judgement.inferredReason, -1);
	assert.equal(result.judgement.suggestedAction, "放行");
	assert.equal(result.judgement.aiLabel, "正常");
});

test("judge-message: 上下文参与关键词判断", async () => {
	const result = await judgeMessage({
		message: "你好",
		contextMessages: ["加群", "私聊"],
	});
	assert.equal(result.judgement.inferredReason, 5);
	assert.ok(result.judgement.matchedKeywords?.includes("加群"));
});

test("judge-message: 空消息与参数错误抛错", async () => {
	await assert.rejects(() => judgeMessage({ message: "   " }), /message 必须是非空字符串/);
	await assert.rejects(
		() => judgeMessage({ message: "内容", reason: 3 }),
		/需要同时提供 reason 与 confidence/,
	);
	await assert.rejects(
		() => judgeMessage({ message: "内容", reason: 3.5, confidence: 0.9 }),
		/reason 必须是整数/,
	);
	await assert.rejects(
		() => judgeMessage({ message: "内容", reason: 3, confidence: 1.5 }),
		/confidence 必须是 0~1/,
	);
});

test("judge-message: 超长消息截断并告警", async () => {
	const result = await judgeMessage({ message: "正".repeat(10_001) });
	assert.ok(result.warnings.some((w) => w.includes("超过 10000")));
});

test("judge-message: 输出结论文本包含关键字段", async () => {
	const result = await judgeMessage({ message: "加微信", reason: 5, confidence: 0.95 });
	const content = formatJudgeMessageContent(result);
	assert.match(content, /风险类型：广告诈骗/);
	assert.match(content, /建议动作：加入黑名单/);
	assert.match(content, /原判定：广告诈骗/);
	assert.match(content, /判断模式：mock/);
});
