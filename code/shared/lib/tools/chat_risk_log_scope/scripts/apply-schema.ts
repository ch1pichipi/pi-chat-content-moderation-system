/**
 * 执行数据库初始化/迁移 SQL。
 *
 * 依次执行 db/migrations 下的 *.sql（按文件名排序）：
 *   001_init.sql             基础表（chat_risk_logs / chat_risk_judgements）
 *   002_player_bans.sql      玩家封禁表
 *   003_judgement_policy.sql 判断结果的处罚审计字段
 *
 * 迁移脚本本身按"可重复执行"设计：
 *   - CREATE TABLE IF NOT EXISTS 天然幂等；
 *   - 003 的 ALTER 语句重复执行会报 ER_DUP_FIELDNAME，这里捕获后跳过。
 *
 * 连接信息来自 db/client.ts（环境变量优先，其次 config/database.json）：
 *   CHAT_RISK_DB_HOST、CHAT_RISK_DB_PORT、CHAT_RISK_DB_USER、
 *   CHAT_RISK_DB_PASSWORD、CHAT_RISK_DB_NAME
 *
 * 运行：
 *   npm run db:init:chat-risk
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import mysql from "mysql2/promise";

import { describeDb, loadDbConfig } from "../db/client.ts";

interface MigrationResult {
	file: string;
	applied: boolean;
	skippedReason?: string;
}

function isDuplicateFieldError(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	return code === "ER_DUP_FIELDNAME";
}

async function main(): Promise<void> {
	const config = loadDbConfig();
	const migrationsDir = path.join(import.meta.dirname, "../db/migrations");
	const files = (await readdir(migrationsDir))
		.filter((file) => file.endsWith(".sql"))
		.sort((a, b) => a.localeCompare(b));

	const connection = await mysql.createConnection({
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		database: config.database,
		multipleStatements: true,
		charset: "utf8mb4",
	});

	const results: MigrationResult[] = [];
	try {
		for (const file of files) {
			const sql = await readFile(path.join(migrationsDir, file), "utf8");
			try {
				await connection.query(sql);
				results.push({ file, applied: true });
			} catch (error) {
				if (!isDuplicateFieldError(error)) throw error;
				results.push({
					file,
					applied: false,
					skippedReason: (error as Error).message,
				});
			}
		}
	} finally {
		await connection.end();
	}

	console.log(`数据库: ${describeDb(config)}`);
	for (const result of results) {
		console.log(
			result.applied
				? `✅ ${result.file}`
				: `⏭  ${result.file}（已应用，跳过：${result.skippedReason}）`,
		);
	}
	console.log("迁移完成：chat_risk_logs / chat_risk_judgements / chat_player_bans");
}

main().catch((error) => {
	console.error(`数据库初始化失败: ${(error as Error).message}`);
	process.exitCode = 1;
});
