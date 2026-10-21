/**
 * 将 100 条盲测日志导入 chat_risk_logs。
 *
 * 只导入原始聊天内容，不导入 ground truth，也不写入 chat_risk_judgements。
 *
 * 凭据只从环境变量读取：
 *   CHAT_RISK_DB_HOST、CHAT_RISK_DB_PORT、CHAT_RISK_DB_USER、
 *   CHAT_RISK_DB_PASSWORD、CHAT_RISK_DB_NAME
 *
 * 运行：
 *   npm run db:seed:chat-risk
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { closeDbPool, getDbPool, loadDbConfig, describeDb } from "../db/client.ts";
import { countLogs, upsertLogs } from "../db/logs.ts";
import type { BlindLogRecord } from "../db/types.ts";

interface BlindFixture {
	id: string;
	account: string;
	nickname: string;
	area_id: string;
	area_name: string;
	server_id: string;
	context_messages: string[];
	current_message: string;
	context_type: string;
	create_time: string;
}

async function main(): Promise<void> {
	const fixturePath = path.join(
		import.meta.dirname,
		"../__fixtures__/agent-eval/blind/agent_eval_20261020_100.jsonl",
	);
	const text = await readFile(fixturePath, "utf8");
	const logs: BlindLogRecord[] = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => {
			const item = JSON.parse(line) as BlindFixture;
			return {
				id: item.id,
				request_id: "",
				account: item.account,
				nickname: item.nickname,
				app_id: "app_game_001",
				area_id: item.area_id,
				area_name: item.area_name,
				server_id: item.server_id,
				context_messages: item.context_messages ?? [],
				current_message: item.current_message,
				context_type: item.context_type,
				create_time: item.create_time,
			};
		});

	const config = loadDbConfig();
	const pool = getDbPool();
	try {
		const affected = await upsertLogs(pool, logs);
		const total = await countLogs(pool);
		console.log(`数据库: ${describeDb(config)}`);
		console.log(`本次导入/更新: ${affected} 条；chat_risk_logs 当前总数: ${total}`);
		console.log("未写入 chat_risk_judgements，保留给 Agent 独立判断。");
	} finally {
		await closeDbPool();
	}
}

main().catch((error) => {
	console.error(`导入日志失败: ${(error as Error).message}`);
	process.exitCode = 1;
});
