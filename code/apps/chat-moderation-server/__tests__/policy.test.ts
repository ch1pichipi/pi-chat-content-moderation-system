import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
	DEFAULT_MODERATION_POLICY,
	PUNISHMENT_SECONDS,
	loadModerationPolicy,
	parseModerationPolicy,
	punishmentToAction,
	resolvePolicy,
	type PolicyInput,
} from "../agent/policy.ts";

const POLICY_FILE = path.resolve(
	import.meta.dirname,
	"../../../../config/moderation-policy.json",
);

function input(overrides: Partial<PolicyInput>): PolicyInput {
	return {
		isRisk: true,
		reason: 5,
		confidence: 0.92,
		requestedPunishment: "ban_1h",
		priorBanCount: 0,
		...overrides,
	};
}

test("policy: 计划 4.4.6 的示例全部符合预期", () => {
	const policy = DEFAULT_MODERATION_POLICY;

	const cases: Array<{
		name: string;
		input: PolicyInput;
		expected: string;
		adjusted?: boolean;
	}> = [
		{
			name: "无前科时永久降级为 3 天（critical + 置信度 0.93）",
			input: input({
				requestedPunishment: "permanent",
				reason: 5,
				confidence: 0.93,
				priorBanCount: 0,
			}),
			expected: "ban_3d",
			adjusted: true,
		},
		{
			name: "置信度 0.72 上限为 1 小时",
			input: input({
				requestedPunishment: "ban_1d",
				reason: 3,
				confidence: 0.72,
				priorBanCount: 0,
			}),
			expected: "ban_1h",
			adjusted: true,
		},
		{
			name: "critical + 0.97 + 1 次前科允许永久",
			input: input({
				requestedPunishment: "permanent",
				reason: 4,
				confidence: 0.97,
				priorBanCount: 1,
			}),
			expected: "permanent",
			adjusted: false,
		},
		{
			name: "low 严重度上限 1 小时",
			input: input({
				requestedPunishment: "permanent",
				reason: 0,
				confidence: 0.99,
				priorBanCount: 5,
			}),
			expected: "ban_1h",
			adjusted: true,
		},
		{
			name: "置信度低于 0.60 不封禁",
			input: input({
				requestedPunishment: "ban_1h",
				reason: 5,
				confidence: 0.58,
				priorBanCount: 0,
			}),
			expected: "none",
			adjusted: true,
		},
		{
			name: "服务端不升级，尊重较低的 ban_1m",
			input: input({
				requestedPunishment: "ban_1m",
				reason: 5,
				confidence: 0.96,
				priorBanCount: 2,
			}),
			expected: "ban_1m",
			adjusted: false,
		},
	];

	for (const item of cases) {
		const decision = resolvePolicy(policy, item.input);
		assert.equal(decision.applied, item.expected, item.name);
		if (item.adjusted !== undefined) {
			assert.equal(decision.adjusted, item.adjusted, item.name);
		}
	}
});

test("policy: 永久封禁需要前科，且 high/critical 必须高置信度", () => {
	const policy = DEFAULT_MODERATION_POLICY;

	// 无前科：即使 critical + 0.99 也不允许永久
	assert.equal(
		resolvePolicy(
			policy,
			input({ requestedPunishment: "permanent", reason: 4, confidence: 0.99, priorBanCount: 0 }),
		).applied,
		"ban_3d",
	);

	// 1 次前科 + high（非 critical）：不允许永久
	assert.equal(
		resolvePolicy(
			policy,
			input({ requestedPunishment: "permanent", reason: 1, confidence: 0.99, priorBanCount: 1 }),
		).applied,
		"ban_3d",
	);

	// 2 次前科 + high + 0.95：重复违规允许永久，但 high 严重度上限仍是 ban_3d
	assert.equal(
		resolvePolicy(
			policy,
			input({ requestedPunishment: "permanent", reason: 1, confidence: 0.95, priorBanCount: 2 }),
		).applied,
		"ban_3d",
	);

	// 2 次前科 + critical + 0.95：允许永久
	assert.equal(
		resolvePolicy(
			policy,
			input({ requestedPunishment: "permanent", reason: 4, confidence: 0.95, priorBanCount: 2 }),
		).applied,
		"permanent",
	);

	// 2 次前科但置信度不足 0.95：不允许永久
	assert.equal(
		resolvePolicy(
			policy,
			input({ requestedPunishment: "permanent", reason: 4, confidence: 0.94, priorBanCount: 2 }),
		).applied,
		"ban_3d",
	);
});

test("policy: 异常输入不封禁并转人工复核", () => {
	const policy = DEFAULT_MODERATION_POLICY;

	const invalidAction = resolvePolicy(
		policy,
		input({ requestedPunishment: "ban_999", reason: 5, confidence: 0.99 }),
	);
	assert.equal(invalidAction.applied, "none");
	assert.equal(invalidAction.manualReview, true);
	assert.equal(invalidAction.action, "人工复核");
	assert.equal(invalidAction.requested, null);

	const contradictory = resolvePolicy(
		policy,
		input({ isRisk: true, reason: -1, confidence: 0.99, requestedPunishment: "ban_3d" }),
	);
	assert.equal(contradictory.applied, "none");
	assert.equal(contradictory.manualReview, true);

	const normalButRisky = resolvePolicy(
		policy,
		input({ isRisk: false, reason: 5, confidence: 0.99, requestedPunishment: "ban_3d" }),
	);
	assert.equal(normalButRisky.applied, "none");
	assert.equal(normalButRisky.manualReview, true);

	const normal = resolvePolicy(
		policy,
		input({ isRisk: false, reason: -1, confidence: 0.9, requestedPunishment: "none" }),
	);
	assert.equal(normal.applied, "none");
	assert.equal(normal.manualReview, false);
	assert.equal(normal.action, "放行");

	const riskyButNoBan = resolvePolicy(
		policy,
		input({ isRisk: true, reason: 5, confidence: 0.9, requestedPunishment: "none" }),
	);
	assert.equal(riskyButNoBan.applied, "none");
	assert.equal(riskyButNoBan.manualReview, true);
	assert.equal(riskyButNoBan.action, "人工复核");
});

test("policy: 未知 reason 按低危处理，标签以服务端 reason map 为准", () => {
	const decision = resolvePolicy(
		DEFAULT_MODERATION_POLICY,
		input({
			requestedPunishment: "permanent",
			reason: 999,
			confidence: 0.99,
			priorBanCount: 5,
			agentLabel: "未知高危",
		}),
	);
	assert.equal(decision.applied, "ban_1h");
	assert.equal(decision.severity, "low");
	// reason 999 不在 map 中，回落到 Agent 标签
	assert.equal(decision.label, "未知高危");

	const mismatched = resolvePolicy(
		DEFAULT_MODERATION_POLICY,
		input({ requestedPunishment: "ban_1h", reason: 5, confidence: 0.9, agentLabel: "其他" }),
	);
	assert.equal(mismatched.label, "广告诈骗");
	assert.ok(mismatched.notes.some((note) => note.includes("标签与 reason map 不一致")));
});

test("policy: 处罚秒数由枚举映射，不信任 Agent 传入值", () => {
	assert.deepEqual(PUNISHMENT_SECONDS, {
		none: null,
		ban_1m: 60,
		ban_1h: 3600,
		ban_1d: 86400,
		ban_3d: 259200,
		permanent: null,
	});
	const decision = resolvePolicy(
		DEFAULT_MODERATION_POLICY,
		input({ requestedPunishment: "ban_1d", reason: 3, confidence: 0.85 }),
	);
	assert.equal(decision.applied, "ban_1d");
	assert.equal(decision.banSeconds, 86400);
});

test("policy: action 映射符合计划 4.4.5 第 6 条", () => {
	assert.equal(punishmentToAction("permanent", true), "加入黑名单");
	assert.equal(punishmentToAction("ban_1m", true), "封禁");
	assert.equal(punishmentToAction("ban_1h", true), "封禁");
	assert.equal(punishmentToAction("ban_1d", true), "封禁");
	assert.equal(punishmentToAction("ban_3d", true), "封禁");
	assert.equal(punishmentToAction("none", true), "人工复核");
	assert.equal(punishmentToAction("none", false), "放行");
});

test("policy: config/moderation-policy.json 与内置默认策略一致", () => {
	const fromFile = loadModerationPolicy(POLICY_FILE);
	assert.deepEqual(fromFile.confidenceCaps, DEFAULT_MODERATION_POLICY.confidenceCaps);
	assert.deepEqual(fromFile.severityCaps, DEFAULT_MODERATION_POLICY.severityCaps);
	assert.deepEqual(fromFile.reasonSeverity, DEFAULT_MODERATION_POLICY.reasonSeverity);
	assert.deepEqual(fromFile.repeat, DEFAULT_MODERATION_POLICY.repeat);
});

test("policy: 非法配置直接抛错", () => {
	const raw = JSON.parse(readFileSync(POLICY_FILE, "utf8")) as Record<string, unknown>;

	assert.throws(
		() => parseModerationPolicy({ ...raw, confidenceCaps: { "1.2": "ban_1h" } }),
		/confidenceCaps/,
	);
	assert.throws(
		() => parseModerationPolicy({ ...raw, confidenceCaps: { "0.9": "ban_2h" } }),
		/confidenceCaps/,
	);
	assert.throws(
		() => parseModerationPolicy({ ...raw, severityCaps: { low: "ban_1h" } }),
		/severityCaps/,
	);
	assert.throws(
		() => parseModerationPolicy({ ...raw, repeat: { windowHours: 0, permanentMinPriorBans: 2, permanentOnFirstCritical: false } }),
		/repeat.windowHours/,
	);

	const fallback = loadModerationPolicy(path.join(import.meta.dirname, "missing.json"));
	assert.deepEqual(fallback, DEFAULT_MODERATION_POLICY);
});
