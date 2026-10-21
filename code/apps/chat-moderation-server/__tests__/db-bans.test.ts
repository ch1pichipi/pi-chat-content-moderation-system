import assert from "node:assert/strict";
import { test } from "node:test";

import type { Pool } from "mysql2/promise";

import { createDbPool, loadDbConfig } from "../../../shared/lib/tools/chat_risk_log_scope/db/client.ts";
import {
	BAN_PUNISHMENT_SECONDS,
	banRemainingSeconds,
	countBansSince,
	createBan,
	fetchActiveBan,
	fetchBansForAccount,
	liftActiveBan,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/bans.ts";
import { fetchJudgementsByLogIds } from "../../../shared/lib/tools/chat_risk_log_scope/db/judgements.ts";
import { insertMessage } from "../../../shared/lib/tools/chat_risk_log_scope/db/messages.ts";
import { PlayerBannedError, sendMessage } from "../services/message-service.ts";

const dbTestEnabled = process.env.CHAT_RISK_DB_TEST === "1";

async function cleanup(pool: Pool, account: string, logIds: string[]): Promise<void> {
	await pool.query("DELETE FROM chat_player_bans WHERE account = ?", [account]);
	if (logIds.length > 0) {
		const placeholders = logIds.map(() => "?").join(", ");
		await pool.query(
			`DELETE FROM chat_risk_judgements WHERE log_id IN (${placeholders})`,
			logIds,
		);
		await pool.query(`DELETE FROM chat_risk_logs WHERE id IN (${placeholders})`, logIds);
	}
}

test(
	"db: 封禁创建、生效、拒绝发送、提前解封",
	{ skip: dbTestEnabled ? false : "设置 CHAT_RISK_DB_TEST=1 后运行" },
	async () => {
		const pool = createDbPool(loadDbConfig());
		const account = `__test_ban_${Date.now()}`;
		const logIds: string[] = [];
		try {
			// 1. 未封禁时可以发送消息
			const message = await sendMessage(pool, {
				account,
				content: "加我微信详聊",
				maxLength: 2000,
			});
			logIds.push(message.id);
			assert.equal(message.account, account);

			assert.equal(await fetchActiveBan(pool, account), null);

			// 2. 创建 1 小时封禁
			const ban = await createBan(pool, {
				account,
				log_id: message.id,
				reason: 5,
				label: "广告诈骗",
				punishment: "ban_1h",
			});
			assert.equal(ban.punishment, "ban_1h");
			assert.equal(ban.duration_seconds, BAN_PUNISHMENT_SECONDS.ban_1h);
			assert.equal(ban.status, "active");
			assert.ok(ban.end_at);
			const remaining = banRemainingSeconds(ban);
			assert.ok(remaining !== null && remaining > 3_500 && remaining <= 3_600);

			// 3. 生效封禁可查到，且发送被拒绝
			const active = await fetchActiveBan(pool, account);
			assert.ok(active);
			assert.equal(active.id, ban.id);

			await assert.rejects(
				() => sendMessage(pool, { account, content: "再说一句", maxLength: 2000 }),
				(error: unknown) => {
					assert.ok(error instanceof PlayerBannedError);
					assert.equal(error.ban.punishment, "ban_1h");
					assert.equal(error.ban.label, "广告诈骗");
					return true;
				},
			);

			// 4. 24h 历史封禁计数包含当前封禁
			assert.equal(await countBansSince(pool, account, new Date(Date.now() - 86_400_000)), 1);

			// 5. 提前解封后可以继续发送
			const lifted = await liftActiveBan(pool, account);
			assert.equal(lifted?.status, "lifted");
			assert.ok(lifted?.lifted_at);
			assert.equal(await fetchActiveBan(pool, account), null);

			const afterLift = await sendMessage(pool, {
				account,
				content: "解封后继续聊天",
				maxLength: 2000,
			});
			logIds.push(afterLift.id);
			assert.equal(afterLift.account, account);

			// 历史记录保留，且计数仍为 1
			const history = await fetchBansForAccount(pool, account);
			assert.equal(history.length, 1);
			assert.equal(history[0].status, "lifted");
			assert.equal(await countBansSince(pool, account, new Date(Date.now() - 86_400_000)), 1);
		} finally {
			await cleanup(pool, account, logIds);
			await pool.end();
		}
	},
);

test(
	"db: 短封禁到期自动过期，永久封禁无结束时间",
	{ skip: dbTestEnabled ? false : "设置 CHAT_RISK_DB_TEST=1 后运行" },
	async () => {
		const pool = createDbPool(loadDbConfig());
		const account = `__test_ban_expire_${Date.now()}`;
		const logIds: string[] = [];
		try {
			const message = await insertMessage(pool, { account, content: "测试消息" });
			logIds.push(message.id);

			// 1 分钟封禁，开始时间设为 2 分钟前 -> 已过期
			const expired = await createBan(pool, {
				account,
				log_id: message.id,
				reason: 3,
				label: "侮辱谩骂",
				punishment: "ban_1m",
				startAt: new Date(Date.now() - 120_000),
			});
			assert.equal(expired.status, "active");
			assert.equal(await fetchActiveBan(pool, account), null);
			const history = await fetchBansForAccount(pool, account);
			assert.equal(history[0].status, "expired");
			assert.equal(banRemainingSeconds(history[0]), 0);

			// 永久封禁：end_at 为 NULL，剩余时间为 null
			const permanent = await createBan(pool, {
				account,
				log_id: message.id,
				reason: 4,
				label: "暴恐犯罪",
				punishment: "permanent",
			});
			assert.equal(permanent.end_at, null);
			assert.equal(permanent.duration_seconds, null);
			assert.equal(banRemainingSeconds(permanent), null);
			const active = await fetchActiveBan(pool, account);
			assert.equal(active?.punishment, "permanent");

			// 新封禁会取代旧 active，保证只有一条 active
			await createBan(pool, {
				account,
				log_id: message.id,
				reason: 5,
				label: "广告诈骗",
				punishment: "ban_1d",
			});
			const all = await fetchBansForAccount(pool, account);
			const activeBans = all.filter((item) => item.status === "active");
			assert.equal(activeBans.length, 1);
			assert.equal(activeBans[0].punishment, "ban_1d");
		} finally {
			await cleanup(pool, account, logIds);
			await pool.end();
		}
	},
);

test(
	"db: 判断结果的处罚审计字段可读写",
	{ skip: dbTestEnabled ? false : "设置 CHAT_RISK_DB_TEST=1 后运行" },
	async () => {
		const { saveJudgementReturningId } = await import(
			"../../../shared/lib/tools/chat_risk_log_scope/db/judgements.ts"
		);
		const pool = createDbPool(loadDbConfig());
		const account = `__test_judgement_${Date.now()}`;
		const logIds: string[] = [];
		try {
			const message = await insertMessage(pool, { account, content: "加群 返利" });
			logIds.push(message.id);

			const id = await saveJudgementReturningId(pool, {
				log_id: message.id,
				is_risk: true,
				reason: 5,
				label: "广告诈骗",
				confidence: 0.92,
				action: "封禁",
				evidence: ["加群 返利"],
				punishment_requested: "permanent",
				punishment_applied: "ban_3d",
				ban_seconds: 259_200,
				policy_adjusted: true,
				policy_note: "无前科，永久降级为 3 天",
				agent_model: "unit-test",
			});
			assert.ok(id > 0);

			// 重复写入同一 log_id 走更新分支，id 不变
			const again = await saveJudgementReturningId(pool, {
				log_id: message.id,
				is_risk: true,
				reason: 5,
				label: "广告诈骗",
				confidence: 0.92,
				action: "封禁",
				evidence: ["加群 返利"],
				punishment_requested: "permanent",
				punishment_applied: "ban_3d",
				ban_seconds: 259_200,
				policy_adjusted: true,
				policy_note: "无前科，永久降级为 3 天",
				agent_model: "unit-test",
			});
			assert.equal(again, id);

			const [saved] = await fetchJudgementsByLogIds(pool, [message.id]);
			assert.equal(saved.punishment_requested, "permanent");
			assert.equal(saved.punishment_applied, "ban_3d");
			assert.equal(saved.ban_seconds, 259_200);
			assert.equal(saved.policy_adjusted, true);
			assert.equal(saved.policy_note, "无前科，永久降级为 3 天");
		} finally {
			await cleanup(pool, account, logIds);
			await pool.end();
		}
	},
);
