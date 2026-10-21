import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregateAccounts } from "../account.ts";
import { evaluateFalsePositive } from "../false-positive.ts";
import { maskAccount, truncate } from "../mask.ts";
import { DEFAULT_REASON_MAP, RiskMap, severeAction } from "../risk-map.ts";
import { extractSamples } from "../sample.ts";
import { summarize } from "../stats.ts";
import { makeEntry, makeJudgement } from "./helpers.ts";

test("riskmap: 11 种默认 reason 标签与未知标签", () => {
	const map = new RiskMap();
	const expected: Record<number, string> = {
		[-1]: "正常",
		0: "其他违禁",
		1: "政治宗教",
		2: "色情低俗",
		3: "侮辱谩骂",
		4: "暴恐犯罪",
		5: "广告诈骗",
		6: "运营规避",
		7: "特殊字符",
		127: "渠道禁止",
		[-128]: "访问屏蔽",
	};
	for (const [reason, label] of Object.entries(expected)) {
		assert.equal(map.label(Number(reason)), label);
	}
	assert.equal(Object.keys(DEFAULT_REASON_MAP).length, 11);
	assert.equal(map.label(999), "未知类型");
});

test("riskmap: overrides 覆盖/扩展默认表", () => {
	const map = new RiskMap({ "0": "自定义违禁", "99": "新增类型" });
	assert.equal(map.label(0), "自定义违禁");
	assert.equal(map.label(99), "新增类型");
	assert.equal(map.label(1), "政治宗教");
});

test("riskmap: SevereAction 全分支", () => {
	assert.equal(severeAction(4), "加入黑名单");
	assert.equal(severeAction(5), "加入黑名单");
	assert.equal(severeAction(1), "封禁");
	assert.equal(severeAction(2), "封禁");
	assert.equal(severeAction(127), "封禁");
	assert.equal(severeAction(-128), "封禁");
	assert.equal(severeAction(3), "禁言");
	assert.equal(severeAction(6), "禁言");
	assert.equal(severeAction(7), "禁言");
	assert.equal(severeAction(0), "人工复核");
	assert.equal(severeAction(-1), "人工复核");
	assert.equal(severeAction(999), "人工复核");
});

test("stats: 阈值边界 0.5 / 0.8", () => {
	const entries = [
		makeEntry({ reason: 0, confidence: 0.5 }),
		makeEntry({ reason: 0, confidence: 0.8 }),
		makeEntry({ reason: 0, confidence: 0.499 }),
		makeEntry({ reason: -1, confidence: 0.99 }),
	];
	const summary = summarize(entries, { highConfidence: 0.8, lowConfidence: 0.5 });
	assert.equal(summary.totalCount, 4);
	assert.equal(summary.riskCount, 3);
	assert.equal(summary.normalCount, 1);
	assert.equal(summary.highConfidenceRisk, 1);
	assert.equal(summary.lowConfidenceSuspect, 1);
	assert.equal(summary.reasonCounts[0], 3);
	assert.equal(summary.reasonRatios[0], 0.75);
});

test("stats: 空账号忽略、区服去重、空输入", () => {
	const summary = summarize(
		[
			makeEntry({ account: "", areaId: "a", serverId: "1" }),
			makeEntry({ account: "acc", areaId: "a", serverId: "1" }),
			makeEntry({ account: "acc", areaId: "b", serverId: "" }),
		],
		{ highConfidence: 0.8, lowConfidence: 0.5 },
	);
	assert.equal(summary.accountCount, 1);
	assert.equal(summary.areaServerCount, 2);

	const empty = summarize([], { highConfidence: 0.8, lowConfidence: 0.5 });
	assert.equal(empty.totalCount, 0);
	assert.deepEqual(empty.reasonCounts, {});
});

test("mask: ASCII / 中文 / emoji / 短账号", () => {
	assert.equal(maskAccount("abcdef"), "a****f");
	assert.equal(maskAccount("账号一"), "账*一");
	assert.equal(maskAccount("ab"), "**");
	assert.equal(maskAccount("a"), "*");
	assert.equal(maskAccount("😀ab😀"), "😀**😀");
	assert.equal(maskAccount("😀😀"), "**");
	assert.equal(maskAccount("abcdef", true), "abcdef");
	assert.equal(maskAccount(""), "");
});

test("mask: 按 code point 截断", () => {
	assert.equal(truncate("abcdef", 3), "abc…");
	assert.equal(truncate("😀😀😀", 2), "😀😀…");
	assert.equal(truncate("abc", 3), "abc");
	assert.equal(truncate("abcdef", 0), "abcdef");
});

test("false-positive: 三条规则独立命中", () => {
	const low = evaluateFalsePositive(
		makeEntry({ reason: 3, confidence: 0.4 }),
		makeJudgement({ aiLabel: "侮辱谩骂" }),
		"侮辱谩骂",
		{ lowConfidence: 0.5 },
	);
	assert.equal(low.isFalsePositive, true);
	assert.ok(low.hits.some((h) => h.includes("低置信度")));

	const aiAllow = evaluateFalsePositive(
		makeEntry({ reason: 3, confidence: 0.9 }),
		makeJudgement({ aiLabel: "正常", suggestedAction: "放行" }),
		"侮辱谩骂",
		{ lowConfidence: 0.5 },
	);
	assert.ok(aiAllow.hits.some((h) => h.includes("AI判断与原系统判定不一致")));

	const manual = evaluateFalsePositive(
		makeEntry({ reason: 3, confidence: 0.9, judgeResult: "正常", prediction: "侮辱谩骂" }),
		makeJudgement({ aiLabel: "侮辱谩骂" }),
		"侮辱谩骂",
		{ lowConfidence: 0.5 },
	);
	assert.ok(manual.hits.some((h) => h.includes("judge_result")));

	const labelMismatch = evaluateFalsePositive(
		makeEntry({ reason: 3, confidence: 0.9, label: "正常", prediction: "侮辱谩骂" }),
		makeJudgement({ aiLabel: "侮辱谩骂" }),
		"侮辱谩骂",
		{ lowConfidence: 0.5 },
	);
	assert.ok(labelMismatch.hits.some((h) => h.includes("label")));
});

test("false-positive: 组合命中与无命中", () => {
	const combo = evaluateFalsePositive(
		makeEntry({ reason: 3, confidence: 0.4, judgeResult: "正常", prediction: "侮辱谩骂" }),
		makeJudgement({ aiLabel: "正常", suggestedAction: "放行" }),
		"侮辱谩骂",
		{ lowConfidence: 0.5 },
	);
	assert.equal(combo.hits.length, 3);

	const none = evaluateFalsePositive(
		makeEntry({ reason: 3, confidence: 0.9 }),
		makeJudgement({ aiLabel: "侮辱谩骂", suggestedAction: "禁言" }),
		"侮辱谩骂",
		{ lowConfidence: 0.5 },
	);
	assert.equal(none.isFalsePositive, false);
});

test("account: 分组、最新昵称、主要风险平票取较小 reason", () => {
	const entries = [
		makeEntry({
			account: "acc",
			reason: 5,
			confidence: 0.9,
			nickname: "旧昵称",
			reviewedTime: new Date("2026-07-23T10:00:00Z"),
		}),
		makeEntry({
			account: "acc",
			reason: 3,
			confidence: 0.9,
			nickname: "新昵称",
			reviewedTime: new Date("2026-07-23T11:00:00Z"),
		}),
		makeEntry({ account: "", reason: 5 }),
	];
	const accounts = aggregateAccounts(
		entries,
		{ highConfidence: 0.8, repeatWindowMs: 60 * 60_000 },
		new RiskMap(),
	);
	assert.equal(accounts.length, 1);
	assert.equal(accounts[0].count, 2);
	assert.equal(accounts[0].nickname, "新昵称");
	assert.equal(accounts[0].mainReason, 3);
	assert.equal(accounts[0].mainReasonLabel, "侮辱谩骂");
	assert.equal(accounts[0].highRiskCount, 2);
	assert.equal(accounts[0].recommendedAction, "禁言");
});

test("account: 无时间时昵称取首个非空", () => {
	const accounts = aggregateAccounts(
		[
			makeEntry({ account: "acc", nickname: "A" }),
			makeEntry({ account: "acc", nickname: "B" }),
		],
		{ highConfidence: 0.8, repeatWindowMs: 60 * 60_000 },
		new RiskMap(),
	);
	assert.equal(accounts[0].nickname, "A");
});

test("account: 重复违规窗口与推荐动作分支", () => {
	const base = new Date("2026-07-23T10:00:00Z");
	const makeRepeat = (gapMs: number) =>
		aggregateAccounts(
			[
				makeEntry({ account: "r", reason: 6, confidence: 0.6, reviewedTime: base }),
				makeEntry({
					account: "r",
					reason: 6,
					confidence: 0.6,
					reviewedTime: new Date(base.getTime() + gapMs),
				}),
			],
			{ highConfidence: 0.8, repeatWindowMs: 60 * 60_000 },
			new RiskMap(),
		)[0];

	assert.equal(makeRepeat(30 * 60_000).suspectedRepeat, true);
	assert.equal(makeRepeat(90 * 60_000).suspectedRepeat, false);
	assert.equal(makeRepeat(30 * 60_000).recommendedAction, "观察");

	const highRiskRepeat = aggregateAccounts(
		[
			makeEntry({ account: "r", reason: 5, confidence: 0.9, reviewedTime: base }),
			makeEntry({
				account: "r",
				reason: 5,
				confidence: 0.9,
				reviewedTime: new Date(base.getTime() + 1000),
			}),
		],
		{ highConfidence: 0.8, repeatWindowMs: 60 * 60_000 },
		new RiskMap(),
	)[0];
	assert.equal(highRiskRepeat.recommendedAction, "封禁");

	const singleHigh = aggregateAccounts(
		[makeEntry({ account: "r", reason: 3, confidence: 0.9 })],
		{ highConfidence: 0.8, repeatWindowMs: 60 * 60_000 },
		new RiskMap(),
	)[0];
	assert.equal(singleHigh.recommendedAction, "禁言");

	const normalOnly = aggregateAccounts(
		[makeEntry({ account: "r", reason: -1 })],
		{ highConfidence: 0.8, repeatWindowMs: 60 * 60_000 },
		new RiskMap(),
	)[0];
	assert.equal(normalOnly.recommendedAction, "放行");
});

test("sample: 五类样本、排序、topN 与缺失判断跳过", () => {
	const entries = [
		makeEntry({ id: "1", reason: 3, confidence: 0.6, currentMessage: "m1" }),
		makeEntry({ id: "2", reason: 5, confidence: 0.9, currentMessage: "m2" }),
		makeEntry({ id: "3", reason: 6, confidence: 0.4, currentMessage: "m3" }),
		makeEntry({ id: "4", reason: 7, confidence: 0.95, currentMessage: "m4", contextMessages: ["c"] }),
		makeEntry({ id: "5", reason: -1, confidence: 0.99 }),
	];
	const judgements = new Map([
		[
			"1",
			makeJudgement({
				entryId: "1",
				aiLabel: "侮辱谩骂",
				suggestedAction: "观察",
			}),
		],
		[
			"2",
			makeJudgement({
				entryId: "2",
				aiLabel: "正常",
				suggestedAction: "加入黑名单",
				isFalsePositive: true,
			}),
		],
		[
			"3",
			makeJudgement({
				entryId: "3",
				aiLabel: "运营规避",
				suggestedAction: "人工复核",
				isFalsePositive: true,
			}),
		],
		["4", makeJudgement({ entryId: "4", aiLabel: "特殊字符", suggestedAction: "禁言" })],
	]);
	const samples = extractSamples(entries, judgements, new RiskMap(), 2);

	const model = samples.filter((s) => s.purpose === "模型训练样本");
	assert.deepEqual(
		model.map((s) => s.currentMessage),
		["m4", "m2"],
	);

	const fp = samples.filter((s) => s.purpose === "误杀排查样本");
	assert.deepEqual(
		fp.map((s) => s.currentMessage),
		["m3", "m2"],
	);

	const tuning = samples.filter((s) => s.purpose === "规则优化样本");
	assert.deepEqual(
		tuning.map((s) => s.currentMessage),
		["m2"],
	);

	const manual = samples.filter((s) => s.purpose === "人工复核样本");
	assert.deepEqual(
		manual.map((s) => s.currentMessage),
		["m3"],
	);

	assert.equal(samples.some((s) => s.purpose === "运营处置样本"), false);
});

test("sample: 运营处置样本来自聚类代表消息", () => {
	const samples = extractSamples([], new Map(), new RiskMap(), 2, [
		{ reasonLabel: "广告诈骗", message: "m1", contextSummary: "c1" },
		{ reasonLabel: "广告诈骗", message: "m2", contextSummary: "c2" },
		{ reasonLabel: "广告诈骗", message: "m3", contextSummary: "c3" },
	]);
	assert.equal(samples.length, 2);
	assert.equal(samples[0].purpose, "运营处置样本");
	assert.equal(samples[0].aiReason, "");
});
