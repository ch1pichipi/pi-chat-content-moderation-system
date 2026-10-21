import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createDbPool, loadDbConfig } from "../db/client.ts";
import { saveJudgements, fetchJudgementsByLogIds } from "../db/judgements.ts";
import { fetchLogs, upsertLogs } from "../db/logs.ts";
import type { BlindLogRecord } from "../db/types.ts";

test("db: 配置默认值与环境变量覆盖", () => {
	const defaults = loadDbConfig({}, { configPath: null });
	assert.equal(defaults.host, "127.0.0.1");
	assert.equal(defaults.port, 3306);
	assert.equal(defaults.user, "root");
	assert.equal(defaults.database, "pi_chat_moderation");
	assert.equal(defaults.password, "");

	const custom = loadDbConfig({
		CHAT_RISK_DB_HOST: "db.local",
		CHAT_RISK_DB_PORT: "3307",
		CHAT_RISK_DB_USER: "moderator",
		CHAT_RISK_DB_PASSWORD: "secret",
		CHAT_RISK_DB_NAME: "custom_db",
		CHAT_RISK_DB_POOL_SIZE: "10",
	}, { configPath: null });
	assert.deepEqual(custom, {
		host: "db.local",
		port: 3307,
		user: "moderator",
		password: "secret",
		database: "custom_db",
		connectionLimit: 10,
	});

	assert.throws(
		() => loadDbConfig({ CHAT_RISK_DB_PORT: "abc" }, { configPath: null }),
		/CHAT_RISK_DB_PORT/,
	);
	assert.throws(
		() => loadDbConfig({ CHAT_RISK_DB_NAME: "bad-name" }, { configPath: null }),
		/CHAT_RISK_DB_NAME/,
	);
});

test("db: 从 config/database.json 读取连接信息，环境变量优先", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-db-config-"));
	const configPath = path.join(dir, "database.json");
	await writeFile(
		configPath,
		JSON.stringify({
			host: "file-host",
			port: 3307,
			user: "file-user",
			password: "file-pass",
			database: "file_db",
			connectionLimit: 7,
		}),
		"utf8",
	);

	const fromFile = loadDbConfig({}, { configPath });
	assert.deepEqual(fromFile, {
		host: "file-host",
		port: 3307,
		user: "file-user",
		password: "file-pass",
		database: "file_db",
		connectionLimit: 7,
	});

	const overridden = loadDbConfig(
		{
			CHAT_RISK_DB_HOST: "env-host",
			CHAT_RISK_DB_PASSWORD: "env-pass",
		},
		{ configPath },
	);
	assert.equal(overridden.host, "env-host");
	assert.equal(overridden.password, "env-pass");
	assert.equal(overridden.port, 3307);
	assert.equal(overridden.user, "file-user");
});

const dbTestEnabled = process.env.CHAT_RISK_DB_TEST === "1";

test(
	"db: 日志导入、未判断读取、判断写入与清理",
	{ skip: dbTestEnabled ? false : "设置 CHAT_RISK_DB_TEST=1 后运行" },
	async () => {
		const pool = createDbPool(loadDbConfig());
		const id = `__test_log_${Date.now()}`;
		const log: BlindLogRecord = {
			id,
			request_id: "",
			account: "account_test",
			nickname: "测试账号",
			app_id: "app_test",
			area_id: "area_test",
			area_name: "测试区",
			server_id: "server_test",
			context_messages: ["玩家A：测试上下文"],
			current_message: "这是一条数据库集成测试消息",
			context_type: "chat",
			create_time: "2026-10-21 10:00:00.000",
		};

		try {
			await upsertLogs(pool, [log]);

			const pending = await fetchLogs(pool, { limit: 1000, includeJudged: false });
			assert.ok(pending.some((item) => item.id === id));
			const fetched = pending.find((item) => item.id === id)!;
			assert.deepEqual(fetched.context_messages, ["玩家A：测试上下文"]);
			assert.equal(fetched.current_message, log.current_message);

			await saveJudgements(pool, [
				{
					log_id: id,
					is_risk: false,
					reason: -1,
					label: "正常",
					confidence: 0.91,
					action: "放行",
					evidence: [],
					agent_model: "unit-test",
				},
			]);

			const judged = await fetchJudgementsByLogIds(pool, [id]);
			assert.equal(judged.length, 1);
			assert.equal(judged[0].log_id, id);
			assert.equal(judged[0].is_risk, false);
			assert.equal(judged[0].action, "放行");
			assert.equal(judged[0].confidence, 0.91);

			const afterJudge = await fetchLogs(pool, { limit: 1000, includeJudged: false });
			assert.equal(afterJudge.some((item) => item.id === id), false);
		} finally {
			await pool.query("DELETE FROM chat_risk_judgements WHERE log_id = ?", [id]);
			await pool.query("DELETE FROM chat_risk_logs WHERE id = ?", [id]);
			await pool.end();
		}
	},
);
