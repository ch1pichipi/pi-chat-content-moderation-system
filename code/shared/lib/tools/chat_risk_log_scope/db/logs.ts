import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type { BlindLogRecord, FetchLogsOptions } from "./types.ts";

interface LogRow extends RowDataPacket {
	id: string;
	request_id: string | null;
	account: string;
	nickname: string | null;
	app_id: string | null;
	area_id: string | null;
	area_name: string | null;
	server_id: string | null;
	context_messages: unknown;
	current_message: string;
	context_type: string | null;
	create_time: string | null;
}

function parseContextMessages(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string" && value.trim() !== "") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed)) {
				return parsed.filter((item): item is string => typeof item === "string");
			}
		} catch {
			// 非 JSON 字符串时按单条上下文处理。
			return [value];
		}
	}
	return [];
}

function toBlindLog(row: LogRow): BlindLogRecord {
	return {
		id: row.id,
		request_id: row.request_id ?? "",
		account: row.account,
		nickname: row.nickname ?? "",
		app_id: row.app_id ?? "",
		area_id: row.area_id ?? "",
		area_name: row.area_name ?? "",
		server_id: row.server_id ?? "",
		context_messages: parseContextMessages(row.context_messages),
		current_message: row.current_message,
		context_type: row.context_type ?? "",
		create_time: row.create_time,
	};
}

function assertLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("limit 必须是 1~1000 之间的整数");
	}
}

/** 读取盲测日志；默认只返回还没有 Agent 判断结果的记录。 */
export async function fetchLogs(pool: Pool, options: FetchLogsOptions): Promise<BlindLogRecord[]> {
	assertLimit(options.limit);
	const where: string[] = [];
	const params: Array<string | number> = [];

	if (!options.includeJudged) where.push("j.id IS NULL");
	if (options.createTimeFrom) {
		where.push("l.create_time >= ?");
		params.push(options.createTimeFrom);
	}
	if (options.createTimeTo) {
		where.push("l.create_time <= ?");
		params.push(options.createTimeTo);
	}

	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const sql = `
		SELECT l.id, l.request_id, l.account, l.nickname, l.app_id,
		       l.area_id, l.area_name, l.server_id, l.context_messages,
		       l.current_message, l.context_type, l.create_time
		FROM chat_risk_logs l
		LEFT JOIN chat_risk_judgements j ON j.log_id = l.id
		${whereSql}
		ORDER BY l.create_time ASC, l.id ASC
		LIMIT ${options.limit}
	`;

	const [rows] = await pool.query<LogRow[]>(sql, params);
	return rows.map(toBlindLog);
}

export async function countLogs(pool: Pool): Promise<number> {
	const [rows] = await pool.query<Array<RowDataPacket & { total: number | string }>>(
		"SELECT COUNT(*) AS total FROM chat_risk_logs",
	);
	return Number(rows[0]?.total ?? 0);
}

export async function countUnjudgedLogs(pool: Pool): Promise<number> {
	const [rows] = await pool.query<Array<RowDataPacket & { total: number | string }>>(
		`SELECT COUNT(*) AS total
		 FROM chat_risk_logs l
		 LEFT JOIN chat_risk_judgements j ON j.log_id = l.id
		 WHERE j.id IS NULL`,
	);
	return Number(rows[0]?.total ?? 0);
}

/** 批量导入日志；按 id 幂等更新，已有判断结果不受影响。 */
export async function upsertLogs(pool: Pool, logs: readonly BlindLogRecord[]): Promise<number> {
	if (logs.length === 0) return 0;
	if (logs.length > 1000) throw new Error("单次最多导入 1000 条日志");

	const rows = logs.map((log) => [
		log.id,
		log.request_id || null,
		log.account,
		log.nickname || null,
		log.app_id || null,
		log.area_id || null,
		log.area_name || null,
		log.server_id || null,
		JSON.stringify(log.context_messages ?? []),
		log.current_message,
		log.context_type || null,
		log.create_time,
	]);

	const [result] = await pool.query<ResultSetHeader>(
		`INSERT INTO chat_risk_logs
			(id, request_id, account, nickname, app_id, area_id, area_name, server_id,
			 context_messages, current_message, context_type, create_time)
		 VALUES ?
		 ON DUPLICATE KEY UPDATE
			request_id = VALUES(request_id),
			account = VALUES(account),
			nickname = VALUES(nickname),
			app_id = VALUES(app_id),
			area_id = VALUES(area_id),
			area_name = VALUES(area_name),
			server_id = VALUES(server_id),
			context_messages = VALUES(context_messages),
			current_message = VALUES(current_message),
			context_type = VALUES(context_type),
			create_time = VALUES(create_time)`,
		[rows],
	);
	return result.affectedRows;
}
