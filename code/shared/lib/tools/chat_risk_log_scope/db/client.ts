/**
 * MySQL 连接池与配置。
 *
 * 配置优先级（高 -> 低）：
 *   1. 环境变量 CHAT_RISK_DB_*
 *   2. config/database.json
 *   3. 内置默认值
 *
 * 环境变量：
 *   CHAT_RISK_DB_HOST      默认 127.0.0.1
 *   CHAT_RISK_DB_PORT      默认 3306
 *   CHAT_RISK_DB_USER      默认 root
 *   CHAT_RISK_DB_PASSWORD  默认空字符串
 *   CHAT_RISK_DB_NAME      默认 pi_chat_moderation
 *   CHAT_RISK_DB_POOL_SIZE 默认 5
 *   CHAT_RISK_DB_CONFIG    自定义配置文件路径（默认 config/database.json）
 *
 * config/database.json 已被 .gitignore 忽略，禁止提交真实密码。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import mysql, { type Pool } from "mysql2/promise";

import type { DbConfig } from "./types.ts";

export interface LoadDbConfigOptions {
	/** 显式指定配置文件；传 null 表示不读取文件。 */
	configPath?: string | null;
	/** 解析相对配置路径时使用的工作目录，默认 process.cwd()。 */
	cwd?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`数据库配置字段 ${key} 必须是字符串`);
	}
	return value;
}

function readNumberField(
	record: Record<string, unknown>,
	key: string,
): number | string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value === "number" || typeof value === "string") return value;
	throw new Error(`数据库配置字段 ${key} 必须是数字`);
}

interface FileDbConfig {
	host?: string;
	port?: number | string;
	user?: string;
	password?: string;
	database?: string;
	connectionLimit?: number | string;
}

function loadFileConfig(configPath: string): FileDbConfig {
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`读取数据库配置失败: ${configPath}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`数据库配置文件不是合法 JSON: ${configPath}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`数据库配置文件必须是 JSON 对象: ${configPath}`);
	}

	return {
		host: readStringField(parsed, "host"),
		port: readNumberField(parsed, "port"),
		user: readStringField(parsed, "user"),
		password: readStringField(parsed, "password"),
		database: readStringField(parsed, "database"),
		connectionLimit: readNumberField(parsed, "connectionLimit"),
	};
}

function resolveConfigPath(
	env: NodeJS.ProcessEnv,
	options: LoadDbConfigOptions,
): string | null {
	if (options.configPath === null) return null;
	const cwd = options.cwd ?? process.cwd();
	const explicit = options.configPath ?? env.CHAT_RISK_DB_CONFIG;
	if (explicit) return path.resolve(cwd, explicit);
	return path.join(cwd, "config/database.json");
}

export function loadDbConfig(
	env: NodeJS.ProcessEnv = process.env,
	options: LoadDbConfigOptions = {},
): DbConfig {
	const configPath = resolveConfigPath(env, options);
	const file = configPath ? loadFileConfig(configPath) : {};

	const portRaw = env.CHAT_RISK_DB_PORT ?? file.port ?? "3306";
	const port = typeof portRaw === "number" ? portRaw : Number(portRaw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("CHAT_RISK_DB_PORT / config.database.port 必须是 1~65535 之间的整数");
	}

	const poolSizeRaw = env.CHAT_RISK_DB_POOL_SIZE ?? file.connectionLimit ?? 5;
	const poolSize = typeof poolSizeRaw === "number" ? poolSizeRaw : Number(poolSizeRaw);
	const connectionLimit =
		Number.isInteger(poolSize) && poolSize > 0 && poolSize <= 50 ? poolSize : 5;

	const database = env.CHAT_RISK_DB_NAME ?? file.database ?? "pi_chat_moderation";
	if (!/^[A-Za-z0-9_$]+$/.test(database)) {
		throw new Error("CHAT_RISK_DB_NAME / config.database.database 只能包含字母、数字、下划线或 $");
	}

	return {
		host: env.CHAT_RISK_DB_HOST ?? file.host ?? "127.0.0.1",
		port,
		user: env.CHAT_RISK_DB_USER ?? file.user ?? "root",
		password: env.CHAT_RISK_DB_PASSWORD ?? file.password ?? "",
		database,
		connectionLimit,
	};
}

export function createDbPool(config: DbConfig = loadDbConfig()): Pool {
	return mysql.createPool({
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		database: config.database,
		connectionLimit: config.connectionLimit,
		waitForConnections: true,
		queueLimit: 0,
		charset: "utf8mb4",
		dateStrings: true,
		namedPlaceholders: false,
	});
}

let sharedPool: Pool | null = null;

export function getDbPool(): Pool {
	if (!sharedPool) sharedPool = createDbPool();
	return sharedPool;
}

export async function closeDbPool(): Promise<void> {
	if (!sharedPool) return;
	const pool = sharedPool;
	sharedPool = null;
	await pool.end();
}

/** 仅用于日志/错误展示，不包含密码。 */
export function describeDb(config: DbConfig): string {
	return `${config.user}@${config.host}:${config.port}/${config.database}`;
}
