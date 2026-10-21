import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";

import { createDbPool, loadDbConfig } from "../../../shared/lib/tools/chat_risk_log_scope/db/client.ts";
import type { Judge } from "../agent/judge.ts";
import { DEFAULT_MODERATION_POLICY } from "../agent/policy.ts";
import type { AgentVerdict } from "../agent/types.ts";
import { loadServerConfig } from "../config.ts";
import { createApiContext } from "../http/routes.ts";
import { createChatServer } from "../http/server.ts";
import { SseHub } from "../http/sse.ts";
import { AnalysisService } from "../services/analysis-service.ts";

const dbTestEnabled = process.env.CHAT_RISK_DB_TEST === "1";
const skip = dbTestEnabled ? false : "设置 CHAT_RISK_DB_TEST=1 后运行";

const RISKY_VERDICT: AgentVerdict = {
	is_risk: true,
	reason: 5,
	label: "广告诈骗",
	confidence: 0.92,
	punishment: "permanent",
	duration_seconds: null,
	evidence: ["加我微信详聊"],
	summary: "测试用风险判断。",
};

test("api: 发消息 -> 分析封禁 -> 423 -> 解封恢复", { skip }, async () => {
	const cwd = path.resolve(import.meta.dirname, "../../../..");
	const config = loadServerConfig({}, { cwd });
	const pool = createDbPool(loadDbConfig());
	const account = `__test_api_${Date.now()}`;
	const logIds: string[] = [];

	const judge: Judge = {
		async judge() {
			return { verdict: RISKY_VERDICT, model: "fake-model", degraded: false };
		},
	};
	const sse = new SseHub({ heartbeatMs: 60_000 });
	const analysis = new AnalysisService({
		pool,
		judge,
		policy: DEFAULT_MODERATION_POLICY,
		events: sse,
		windowMinutes: 10,
		maxMessages: 50,
		lookbackHours: 24,
		debounceMs: 10,
		concurrency: 2,
		serviceStartedAt: new Date(Date.now() - 60_000),
	});
	const ctx = createApiContext({ pool, analysis, sse, config });
	const server = createChatServer(ctx, config);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${port}`;

	const send = (content: string) =>
		fetch(`${base}/api/players/${encodeURIComponent(account)}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		});

	try {
		// 健康检查
		const health = (await fetch(`${base}/api/health`).then((res) => res.json())) as {
			ok: boolean;
			analysis: { windowMinutes: number };
		};
		assert.equal(health.ok, true);
		assert.equal(health.analysis.windowMinutes, 10);

		// 玩家列表可访问
		const playersResponse = await fetch(`${base}/api/players?limit=10`);
		assert.equal(playersResponse.status, 200);
		const playersBody = (await playersResponse.json()) as { players: unknown[] };
		assert.ok(Array.isArray(playersBody.players));

		// 首页静态文件
		const index = await fetch(`${base}/`);
		assert.equal(index.status, 200);
		assert.match(await index.text(), /审核控制台/);

		// 1. 发送消息 -> 202
		const first = await send("加我微信详聊，低价出售");
		assert.equal(first.status, 202);
		const firstBody = (await first.json()) as {
			messageId: string;
			status: string;
			analysisStatus: string;
			message: { id: string };
		};
		assert.equal(firstBody.status, "accepted");
		assert.equal(firstBody.analysisStatus, "pending");
		logIds.push(firstBody.messageId);
		assert.equal(firstBody.message.id, firstBody.messageId);

		// 2. 触发分析（实际服务由 debounce 自动触发，这里显式调用以稳定断言）
		await analysis.analyzeNow(account);

		// 3. 状态接口返回封禁信息
		const status = (await fetch(`${base}/api/players/${account}/status`).then((res) =>
			res.json(),
		)) as {
			banned: boolean;
			ban: { punishment: string; label: string; remainingSeconds: number | null };
		};
		assert.equal(status.banned, true);
		assert.equal(status.ban.punishment, "ban_3d");
		assert.equal(status.ban.label, "广告诈骗");
		assert.ok(status.ban.remainingSeconds !== null && status.ban.remainingSeconds > 0);

		// 4. 封禁中再次发送 -> 423
		const blocked = await send("再来一条");
		assert.equal(blocked.status, 423);
		const blockedBody = (await blocked.json()) as {
			error: string;
			ban: { punishment: string; remainingSeconds: number };
		};
		assert.equal(blockedBody.error, "player_banned");
		assert.equal(blockedBody.ban.punishment, "ban_3d");

		// 5. 提前解封 -> 200
		const unban = await fetch(`${base}/api/players/${account}/unban`, { method: "POST" });
		assert.equal(unban.status, 200);
		const unbanBody = (await unban.json()) as { unbanned: boolean };
		assert.equal(unbanBody.unbanned, true);

		// 6. 解封后可以继续发送
		const afterUnban = await send("解封后的消息");
		assert.equal(afterUnban.status, 202);
		const afterBody = (await afterUnban.json()) as { messageId: string };
		logIds.push(afterBody.messageId);

		// 7. 消息列表可读取
		const messages = (await fetch(
			`${base}/api/players/${account}/messages?limit=50`,
		).then((res) => res.json())) as {
			messages: Array<{ content: string }>;
			ban: unknown;
		};
		assert.equal(messages.messages.length, 2);
		assert.deepEqual(
			messages.messages.map((item) => item.content),
			["加我微信详聊，低价出售", "解封后的消息"],
		);
		assert.equal(messages.ban, null);

		// 8. 参数/内容校验返回 400
		const emptyContent = await send("   ");
		assert.equal(emptyContent.status, 400);
		const tooLong = await send("x".repeat(2001));
		assert.equal(tooLong.status, 400);
		const badLimit = await fetch(`${base}/api/players/${account}/messages?limit=abc`);
		assert.equal(badLimit.status, 400);
		const badJson = await fetch(
			`${base}/api/players/${encodeURIComponent(account)}/messages`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{oops",
			},
		);
		assert.equal(badJson.status, 400);

		// 9. 未知接口 404
		const notFound = await fetch(`${base}/api/nope`);
		assert.equal(notFound.status, 404);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		analysis.stop();
		sse.close();
		await pool.query("DELETE FROM chat_player_bans WHERE account = ?", [account]);
		if (logIds.length > 0) {
			const placeholders = logIds.map(() => "?").join(", ");
			await pool.query(
				`DELETE FROM chat_risk_judgements WHERE log_id IN (${placeholders})`,
				logIds,
			);
			await pool.query(`DELETE FROM chat_risk_logs WHERE id IN (${placeholders})`, logIds);
		}
		await pool.end();
	}
});
