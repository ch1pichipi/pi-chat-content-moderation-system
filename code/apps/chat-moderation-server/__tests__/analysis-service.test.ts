import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool } from "mysql2/promise";

import { createDbPool, loadDbConfig } from "../../../shared/lib/tools/chat_risk_log_scope/db/client.ts";
import { fetchActiveBan } from "../../../shared/lib/tools/chat_risk_log_scope/db/bans.ts";
import { fetchJudgementsByLogIds } from "../../../shared/lib/tools/chat_risk_log_scope/db/judgements.ts";
import { insertMessage } from "../../../shared/lib/tools/chat_risk_log_scope/db/messages.ts";
import type { Judge } from "../agent/judge.ts";
import { DEFAULT_MODERATION_POLICY } from "../agent/policy.ts";
import type { AgentVerdict, AnalysisInput } from "../agent/types.ts";
import type { ServerEvent } from "../events.ts";
import { AnalysisService, type AnalysisServiceOptions } from "../services/analysis-service.ts";
import { PlayerBannedError, sendMessage } from "../services/message-service.ts";

const dbTestEnabled = process.env.CHAT_RISK_DB_TEST === "1";
const skip = dbTestEnabled ? false : "设置 CHAT_RISK_DB_TEST=1 后运行";

function makeVerdict(overrides: Partial<AgentVerdict> = {}): AgentVerdict {
	return {
		is_risk: true,
		reason: 5,
		label: "广告诈骗",
		confidence: 0.92,
		punishment: "permanent",
		duration_seconds: null,
		evidence: ["加我微信详聊"],
		summary: "窗口内多次发布站外联系方式。",
		...overrides,
	};
}

interface FakeJudge {
	judge: Judge;
	inputs: AnalysisInput[];
}

function makeJudge(
	handler: (input: AnalysisInput) => AgentVerdict | Promise<AgentVerdict>,
): FakeJudge {
	const inputs: AnalysisInput[] = [];
	return {
		inputs,
		judge: {
			async judge(input) {
				inputs.push(input);
				return { verdict: await handler(input), model: "fake-model", degraded: false };
			},
		},
	};
}

function makeService(
	pool: Pool,
	judge: Judge,
	events: ServerEvent[],
	overrides: Partial<AnalysisServiceOptions> = {},
): AnalysisService {
	return new AnalysisService({
		pool,
		judge,
		policy: DEFAULT_MODERATION_POLICY,
		events: { emit: (event) => events.push(event) },
		windowMinutes: 10,
		maxMessages: 50,
		lookbackHours: 24,
		debounceMs: 0,
		concurrency: 2,
		serviceStartedAt: new Date(Date.now() - 60_000),
		now: () => new Date(),
		...overrides,
	});
}

async function cleanup(pool: Pool, account: string, logIds: string[]): Promise<void> {
	await pool.query("DELETE FROM chat_player_bans WHERE account = ?", [account]);
	if (logIds.length > 0) {
		const placeholders = logIds.map(() => "?").join(", ");
		await pool.query(`DELETE FROM chat_risk_judgements WHERE log_id IN (${placeholders})`, logIds);
		await pool.query(`DELETE FROM chat_risk_logs WHERE id IN (${placeholders})`, logIds);
	}
}

test("analysis: 风险消息 -> 服务端降级为 3 天封禁 -> 拒绝发送", { skip }, async () => {
	const pool = createDbPool(loadDbConfig());
	const account = `__test_analysis_risk_${Date.now()}`;
	const logIds: string[] = [];
	try {
		const message = await sendMessage(pool, {
			account,
			content: "加我微信详聊，低价出售",
			maxLength: 2000,
		});
		logIds.push(message.id);

		const fake = makeJudge(() => makeVerdict());
		const events: ServerEvent[] = [];
		const service = makeService(pool, fake.judge, events);

		const result = await service.analyzeNow(account);
		assert.ok(result);
		assert.equal(result.messageId, message.id);
		assert.ok(result.judgement);

		// 无前科 + critical + 0.92 -> 置信度上限 ban_3d
		assert.equal(result.judgement.punishment, "ban_3d");
		assert.equal(result.judgement.requestedPunishment, "permanent");
		assert.equal(result.judgement.adjusted, true);
		assert.equal(result.judgement.isRisk, true);
		assert.ok(result.judgement.ban);

		// Agent 输入结构符合计划 4.2
		assert.equal(fake.inputs.length, 1);
		const input = fake.inputs[0];
		assert.equal(input.player.account, account);
		assert.equal(input.window.minutes, 10);
		assert.equal(input.window.messageCount, 1);
		assert.equal(input.recentMessages[0].id, message.id);
		assert.equal(input.historySummary.last24hBanCount, 0);
		assert.equal(input.historySummary.last24hRiskCount, 0);
		assert.equal(input.historySummary.lastBan, null);

		// 判断结果写库并带审计字段
		const [saved] = await fetchJudgementsByLogIds(pool, [message.id]);
		assert.equal(saved.punishment_requested, "permanent");
		assert.equal(saved.punishment_applied, "ban_3d");
		assert.equal(saved.ban_seconds, 259_200);
		assert.equal(saved.policy_adjusted, true);
		assert.equal(saved.action, "封禁");
		assert.ok(saved.policy_note && saved.policy_note.length > 0);

		// 封禁记录关联判断结果
		const active = await fetchActiveBan(pool, account);
		assert.ok(active);
		assert.equal(active.punishment, "ban_3d");
		assert.equal(active.log_id, message.id);
		assert.equal(active.judgement_id, saved.id);

		// 封禁期间服务端拒绝发送
		await assert.rejects(
			() => sendMessage(pool, { account, content: "继续发广告", maxLength: 2000 }),
			(error: unknown) => error instanceof PlayerBannedError,
		);

		// SSE 事件顺序
		assert.deepEqual(
			events.map((event) => event.type),
			["analysis_started", "ban_started", "analysis_completed"],
		);

		// 第二次分析：存在生效封禁，不再重复创建
		const second = await service.analyzeNow(account);
		assert.equal(second?.judgement?.ban, null);
		assert.equal(await fetchActiveBan(pool, account) !== null, true);
	} finally {
		await cleanup(pool, account, logIds);
		await pool.end();
	}
});

test("analysis: 正常消息不封禁", { skip }, async () => {
	const pool = createDbPool(loadDbConfig());
	const account = `__test_analysis_normal_${Date.now()}`;
	const logIds: string[] = [];
	try {
		const message = await insertMessage(pool, { account, content: "今晚一起打副本吗？" });
		logIds.push(message.id);

		const fake = makeJudge(() =>
			makeVerdict({
				is_risk: false,
				reason: -1,
				label: "正常",
				confidence: 0.88,
				punishment: "none",
				evidence: [],
				summary: "正常游戏交流。",
			}),
		);
		const events: ServerEvent[] = [];
		const service = makeService(pool, fake.judge, events);

		const result = await service.analyzeNow(account);
		assert.equal(result?.judgement?.punishment, "none");
		assert.equal(result?.judgement?.ban, null);
		assert.equal(result?.judgement?.manualReview, false);
		assert.equal(await fetchActiveBan(pool, account), null);

		const [saved] = await fetchJudgementsByLogIds(pool, [message.id]);
		assert.equal(saved.action, "放行");
		assert.equal(saved.is_risk, false);

		// 仍然可以发送
		const next = await sendMessage(pool, { account, content: "好的", maxLength: 2000 });
		logIds.push(next.id);
	} finally {
		await cleanup(pool, account, logIds);
		await pool.end();
	}
});

test("analysis: Agent 超时/异常不封禁，记录人工复核", { skip }, async () => {
	const pool = createDbPool(loadDbConfig());
	const account = `__test_analysis_fail_${Date.now()}`;
	const logIds: string[] = [];
	try {
		const message = await insertMessage(pool, { account, content: "随便聊聊" });
		logIds.push(message.id);

		const fake = makeJudge(() => {
			throw new Error("Agent 调用超过 20000ms，本次不封禁");
		});
		const events: ServerEvent[] = [];
		const service = makeService(pool, fake.judge, events);

		const result = await service.analyzeNow(account);
		assert.equal(result?.judgement, null);
		assert.ok(result?.error?.includes("20000ms"));
		assert.equal(await fetchActiveBan(pool, account), null);

		const [saved] = await fetchJudgementsByLogIds(pool, [message.id]);
		assert.equal(saved.action, "人工复核");
		assert.equal(saved.is_risk, false);
		assert.equal(saved.punishment_applied, "none");
		assert.ok(saved.policy_note?.includes("人工复核"));

		assert.deepEqual(
			events.map((event) => event.type),
			["analysis_started", "analysis_failed"],
		);
	} finally {
		await cleanup(pool, account, logIds);
		await pool.end();
	}
});

test("analysis: 窗口只取最近 N 条，且排除服务启动前的历史消息", { skip }, async () => {
	const pool = createDbPool(loadDbConfig());
	const account = `__test_analysis_window_${Date.now()}`;
	const logIds: string[] = [];
	try {
		// 5 条新消息，时间递增，便于断言截断顺序
		const base = Date.now() - 5_000;
		for (let index = 1; index <= 5; index++) {
			const message = await insertMessage(pool, {
				account,
				content: `消息 ${index}`,
				createTime: new Date(base + index * 1_000),
			});
			logIds.push(message.id);
		}
		// 1 条 20 分钟前的消息，超出 10 分钟窗口
		const old = await insertMessage(pool, {
			account,
			content: "很久以前的消息",
			createTime: new Date(Date.now() - 20 * 60_000),
		});
		logIds.push(old.id);

		const fake = makeJudge(() =>
			makeVerdict({ is_risk: false, reason: -1, confidence: 0.9, punishment: "none" }),
		);
		const events: ServerEvent[] = [];
		const service = makeService(pool, fake.judge, events, { maxMessages: 3 });

		await service.analyzeNow(account);
		assert.equal(fake.inputs.length, 1);
		const input = fake.inputs[0];
		assert.equal(input.window.messageCount, 3);
		assert.deepEqual(
			input.recentMessages.map((item) => item.content),
			["消息 3", "消息 4", "消息 5"],
		);

		// 服务启动后再分析：历史消息全部被排除
		const fresh = makeJudge(() => makeVerdict({ is_risk: false, reason: -1 }));
		const serviceAfterStart = makeService(pool, fresh.judge, events, {
			serviceStartedAt: new Date(Date.now() + 1_000),
		});
		const result = await serviceAfterStart.analyzeNow(account);
		assert.equal(result?.messageId, null);
		assert.equal(fresh.inputs.length, 0);
	} finally {
		await cleanup(pool, account, logIds);
		await pool.end();
	}
});

test("analysis: 防抖把连续消息合并为一次分析", { skip }, async () => {
	const pool = createDbPool(loadDbConfig());
	const account = `__test_analysis_debounce_${Date.now()}`;
	const logIds: string[] = [];
	try {
		for (let index = 0; index < 3; index++) {
			const message = await insertMessage(pool, { account, content: `连续消息 ${index}` });
			logIds.push(message.id);
		}

		const fake = makeJudge(() =>
			makeVerdict({ is_risk: false, reason: -1, confidence: 0.9, punishment: "none" }),
		);
		const events: ServerEvent[] = [];
		const service = makeService(pool, fake.judge, events, { debounceMs: 30 });

		service.enqueue(account);
		service.enqueue(account);
		service.enqueue(account);
		await service.waitForIdle(5_000);

		assert.equal(fake.inputs.length, 1, "同一账号连续消息只应触发一次模型调用");
		assert.equal(fake.inputs[0].window.messageCount, 3);
	} finally {
		await cleanup(pool, account, logIds);
		await pool.end();
	}
});
