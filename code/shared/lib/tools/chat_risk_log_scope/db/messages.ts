/**
 * 实时聊天消息数据访问层。
 *
 * 消息统一写入 chat_risk_logs（无任何标签），判断结果单独写入 chat_risk_judgements，
 * 保持"原始日志 / Agent 判断"分离的既有设计。
 */

import { randomBytes } from "node:crypto";

import type { Pool, RowDataPacket } from "mysql2/promise";

import { formatMysqlDateTime } from "./datetime.ts";

export interface ChatMessageRecord {
	id: string;
	account: string;
	nickname: string;
	areaId: string;
	areaName: string;
	serverId: string;
	contextMessages: string[];
	content: string;
	contextType: string;
	createTime: string | null;
}

export interface InsertMessageInput {
	account: string;
	nickname?: string;
	areaId?: string;
	areaName?: string;
	serverId?: string;
	contextMessages?: string[];
	content: string;
	contextType?: string;
	createTime?: Date;
}

export interface FetchRecentMessagesOptions {
	limit: number;
	/** 只返回该时间之后的消息（分析窗口下界 / 服务启动时间）。 */
	since?: Date;
}

export interface PlayerOverview {
	account: string;
	nickname: string;
	areaName: string;
	serverId: string;
	lastMessageAt: string | null;
	messageCount: number;
}

interface MessageRow extends RowDataPacket {
	id: string;
	account: string;
	nickname: string | null;
	area_id: string | null;
	area_name: string | null;
	server_id: string | null;
	context_messages: unknown;
	current_message: string;
	context_type: string | null;
	create_time: string | null;
}

interface PlayerRow extends RowDataPacket {
	account: string;
	nickname: string | null;
	area_name: string | null;
	server_id: string | null;
	last_message_at: string | null;
	message_count: number | string;
}

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

/** 生成消息 id：msg_20261021_100102_ab12cd34。 */
export function createMessageId(now: Date = new Date()): string {
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `msg_${date}_${time}_${randomBytes(4).toString("hex")}`;
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
			return [value];
		}
	}
	return [];
}

function toChatMessage(row: MessageRow): ChatMessageRecord {
	return {
		id: row.id,
		account: row.account,
		nickname: row.nickname ?? "",
		areaId: row.area_id ?? "",
		areaName: row.area_name ?? "",
		serverId: row.server_id ?? "",
		contextMessages: parseContextMessages(row.context_messages),
		content: row.current_message,
		contextType: row.context_type ?? "",
		createTime: row.create_time,
	};
}

const MESSAGE_COLUMNS = `id, account, nickname, area_id, area_name, server_id,
	context_messages, current_message, context_type, create_time`;

function assertLimit(limit: number, max = 200): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > max) {
		throw new Error(`limit 必须是 1~${max} 之间的整数`);
	}
}

/** 写入一条玩家消息，返回可直接推送给前端的记录。 */
export async function insertMessage(
	pool: Pool,
	input: InsertMessageInput,
): Promise<ChatMessageRecord> {
	const content = input.content;
	if (typeof content !== "string" || content.trim() === "") {
		throw new Error("消息内容不能为空");
	}
	const createTime = input.createTime ?? new Date();
	const record: ChatMessageRecord = {
		id: createMessageId(createTime),
		account: input.account,
		nickname: input.nickname ?? "",
		areaId: input.areaId ?? "",
		areaName: input.areaName ?? "",
		serverId: input.serverId ?? "",
		contextMessages: input.contextMessages ?? [],
		content,
		contextType: input.contextType ?? "chat",
		createTime: formatMysqlDateTime(createTime),
	};

	await pool.query(
		`INSERT INTO chat_risk_logs
			(id, request_id, account, nickname, app_id, area_id, area_name, server_id,
			 context_messages, current_message, context_type, create_time)
		 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			record.id,
			record.account,
			record.nickname || null,
			"app_game_001",
			record.areaId || null,
			record.areaName || null,
			record.serverId || null,
			JSON.stringify(record.contextMessages),
			record.content,
			record.contextType || null,
			record.createTime,
		],
	);
	return record;
}

export async function fetchMessageById(
	pool: Pool,
	id: string,
): Promise<ChatMessageRecord | null> {
	const [rows] = await pool.query<MessageRow[]>(
		`SELECT ${MESSAGE_COLUMNS} FROM chat_risk_logs WHERE id = ?`,
		[id],
	);
	return rows[0] ? toChatMessage(rows[0]) : null;
}

/**
 * 读取账号最近的消息，按时间升序返回。
 *
 * 先按时间倒序取最近 limit 条，再反转为正序，保证截断时丢掉最早的消息。
 */
export async function fetchRecentMessages(
	pool: Pool,
	account: string,
	options: FetchRecentMessagesOptions,
): Promise<ChatMessageRecord[]> {
	assertLimit(options.limit);
	const params: Array<string | number> = [account];
	let where = "account = ?";
	if (options.since) {
		where += " AND create_time >= ?";
		params.push(formatMysqlDateTime(options.since));
	}
	params.push(options.limit);

	const [rows] = await pool.query<MessageRow[]>(
		`SELECT ${MESSAGE_COLUMNS}
		 FROM chat_risk_logs
		 WHERE ${where}
		 ORDER BY create_time DESC, id DESC
		 LIMIT ?`,
		params,
	);
	return rows.reverse().map(toChatMessage);
}

/** 玩家列表：每个账号取最后一条消息的昵称/区服，并按最近活跃排序。 */
export async function listPlayers(pool: Pool, limit = 100): Promise<PlayerOverview[]> {
	assertLimit(limit, 500);
	const [rows] = await pool.query<PlayerRow[]>(
		`SELECT account, nickname, area_name, server_id, last_message_at, message_count
		 FROM (
		   SELECT l.account,
		          l.nickname,
		          l.area_name,
		          l.server_id,
		          l.create_time AS last_message_at,
		          COUNT(*) OVER (PARTITION BY l.account) AS message_count,
		          ROW_NUMBER() OVER (
		            PARTITION BY l.account
		            ORDER BY l.create_time DESC, l.id DESC
		          ) AS rn
		   FROM chat_risk_logs l
		 ) t
		 WHERE rn = 1
		 ORDER BY last_message_at DESC
		 LIMIT ?`,
		[limit],
	);
	return rows.map((row) => ({
		account: row.account,
		nickname: row.nickname ?? "",
		areaName: row.area_name ?? "",
		serverId: row.server_id ?? "",
		lastMessageAt: row.last_message_at ?? null,
		messageCount: Number(row.message_count ?? 0),
	}));
}

/** 统计账号在给定时间之后的 Agent 风险判断数。 */
export async function countRecentRiskJudgements(
	pool: Pool,
	account: string,
	since: Date,
): Promise<number> {
	const [rows] = await pool.query<Array<RowDataPacket & { total: number | string }>>(
		`SELECT COUNT(*) AS total
		 FROM chat_risk_judgements j
		 JOIN chat_risk_logs l ON l.id = j.log_id
		 WHERE l.account = ? AND j.is_risk = 1 AND j.judged_at >= ?`,
		[account, formatMysqlDateTime(since)],
	);
	return Number(rows[0]?.total ?? 0);
}
