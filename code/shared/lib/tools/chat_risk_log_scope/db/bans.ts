/**
 * chat_player_bans 数据访问层。
 *
 * 约定：
 *   - end_at IS NULL 表示永久封禁；
 *   - 同一账号同一时刻最多一条 active；
 *   - 过期由查询时顺带更新为 expired，不依赖定时任务；
 *   - 提前解封只置为 lifted，保留历史用于重复违规统计。
 */

import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { formatMysqlDateTime, parseMysqlDateTime } from "./datetime.ts";

/** 可持久化的处罚枚举（"none" 不落库）。 */
export const BAN_PUNISHMENTS = ["ban_1m", "ban_1h", "ban_1d", "ban_3d", "permanent"] as const;
export type BanPunishment = (typeof BAN_PUNISHMENTS)[number];

/** 处罚枚举 -> 时长（秒）；永久为 null。 */
export const BAN_PUNISHMENT_SECONDS: Readonly<Record<BanPunishment, number | null>> = Object.freeze({
	ban_1m: 60,
	ban_1h: 3_600,
	ban_1d: 86_400,
	ban_3d: 259_200,
	permanent: null,
});

export const BAN_STATUSES = ["active", "expired", "lifted"] as const;
export type BanState = (typeof BAN_STATUSES)[number];

export interface ChatPlayerBanRecord {
	id: number;
	account: string;
	log_id: string | null;
	judgement_id: number | null;
	reason: number;
	label: string;
	punishment: BanPunishment;
	duration_seconds: number | null;
	start_at: string;
	end_at: string | null;
	status: BanState;
	lifted_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateBanInput {
	account: string;
	log_id?: string | null;
	judgement_id?: number | null;
	reason: number;
	label: string;
	punishment: BanPunishment;
	/** 开始时间，默认当前时间；结束时间由处罚枚举推导。 */
	startAt?: Date;
}

interface BanRow extends RowDataPacket {
	id: number | string;
	account: string;
	log_id: string | null;
	judgement_id: number | string | null;
	reason: number;
	label: string;
	punishment: string;
	duration_seconds: number | string | null;
	start_at: string;
	end_at: string | null;
	status: string;
	lifted_at: string | null;
	created_at: string;
	updated_at: string;
}

export function isBanPunishment(value: unknown): value is BanPunishment {
	return typeof value === "string" && (BAN_PUNISHMENTS as readonly string[]).includes(value);
}

function toBanRecord(row: BanRow): ChatPlayerBanRecord {
	return {
		id: Number(row.id),
		account: row.account,
		log_id: row.log_id ?? null,
		judgement_id: row.judgement_id === null ? null : Number(row.judgement_id),
		reason: Number(row.reason),
		label: row.label,
		punishment: row.punishment as BanPunishment,
		duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
		start_at: row.start_at,
		end_at: row.end_at ?? null,
		status: row.status as BanState,
		lifted_at: row.lifted_at ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

const BAN_COLUMNS = `id, account, log_id, judgement_id, reason, label, punishment,
	duration_seconds, start_at, end_at, status, lifted_at, created_at, updated_at`;

/** 封禁剩余秒数；永久封禁返回 null，已过期返回 0。 */
export function banRemainingSeconds(ban: ChatPlayerBanRecord, now: Date = new Date()): number | null {
	if (ban.end_at === null) return null;
	const endAt = parseMysqlDateTime(ban.end_at);
	if (!endAt) return null;
	return Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 1000));
}

/** 判断封禁记录在给定时刻是否仍然生效。 */
export function isBanActive(ban: ChatPlayerBanRecord, now: Date = new Date()): boolean {
	if (ban.status !== "active") return false;
	if (ban.end_at === null) return true;
	const endAt = parseMysqlDateTime(ban.end_at);
	return endAt !== null && endAt.getTime() > now.getTime();
}

/** 把已经到期的 active 封禁标记为 expired。 */
export async function expireStaleBans(pool: Pool, now: Date = new Date()): Promise<number> {
	const [result] = await pool.query<ResultSetHeader>(
		`UPDATE chat_player_bans
		 SET status = 'expired'
		 WHERE status = 'active'
		   AND end_at IS NOT NULL
		   AND end_at <= ?`,
		[formatMysqlDateTime(now)],
	);
	return result.affectedRows;
}

/** 查询账号当前生效的封禁；同时顺手把过期记录置为 expired。 */
export async function fetchActiveBan(
	pool: Pool,
	account: string,
	now: Date = new Date(),
): Promise<ChatPlayerBanRecord | null> {
	const nowText = formatMysqlDateTime(now);
	await pool.query<ResultSetHeader>(
		`UPDATE chat_player_bans
		 SET status = 'expired'
		 WHERE account = ? AND status = 'active' AND end_at IS NOT NULL AND end_at <= ?`,
		[account, nowText],
	);
	const [rows] = await pool.query<BanRow[]>(
		`SELECT ${BAN_COLUMNS}
		 FROM chat_player_bans
		 WHERE account = ? AND status = 'active'
		 ORDER BY id DESC
		 LIMIT 1`,
		[account],
	);
	return rows[0] ? toBanRecord(rows[0]) : null;
}

/** 一次性查出所有生效封禁，避免玩家列表出现 N+1 查询。 */
export async function fetchActiveBans(
	pool: Pool,
	now: Date = new Date(),
): Promise<Map<string, ChatPlayerBanRecord>> {
	await expireStaleBans(pool, now);
	const [rows] = await pool.query<BanRow[]>(
		`SELECT ${BAN_COLUMNS}
		 FROM chat_player_bans
		 WHERE status = 'active'
		 ORDER BY id DESC`,
	);
	const map = new Map<string, ChatPlayerBanRecord>();
	for (const row of rows) {
		const record = toBanRecord(row);
		if (!map.has(record.account)) map.set(record.account, record);
	}
	return map;
}

/**
 * 创建一条封禁。
 *
 * 若账号已有 active 封禁，先把旧记录置为 lifted（被新封禁取代），
 * 保证"同一账号最多一条 active"的约束。
 */
export async function createBan(
	pool: Pool,
	input: CreateBanInput,
): Promise<ChatPlayerBanRecord> {
	const startAt = input.startAt ?? new Date();
	const durationSeconds = BAN_PUNISHMENT_SECONDS[input.punishment];
	const endAt =
		durationSeconds === null
			? null
			: formatMysqlDateTime(new Date(startAt.getTime() + durationSeconds * 1000));

	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		await connection.query<ResultSetHeader>(
			`UPDATE chat_player_bans
			 SET status = 'lifted', lifted_at = ?
			 WHERE account = ? AND status = 'active'`,
			[formatMysqlDateTime(startAt), input.account],
		);
		const [result] = await connection.query<ResultSetHeader>(
			`INSERT INTO chat_player_bans
				(account, log_id, judgement_id, reason, label, punishment,
				 duration_seconds, start_at, end_at, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
			[
				input.account,
				input.log_id ?? null,
				input.judgement_id ?? null,
				input.reason,
				input.label,
				input.punishment,
				durationSeconds,
				formatMysqlDateTime(startAt),
				endAt,
			],
		);
		const [rows] = await connection.query<BanRow[]>(
			`SELECT ${BAN_COLUMNS} FROM chat_player_bans WHERE id = ?`,
			[result.insertId],
		);
		await connection.commit();
		const row = rows[0];
		if (!row) throw new Error(`创建封禁后无法读取记录: ${input.account}`);
		return toBanRecord(row);
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

/** 提前解除账号当前 active 封禁；没有生效封禁时返回 null。 */
export async function liftActiveBan(
	pool: Pool,
	account: string,
	now: Date = new Date(),
): Promise<ChatPlayerBanRecord | null> {
	const active = await fetchActiveBan(pool, account, now);
	if (!active) return null;
	await pool.query<ResultSetHeader>(
		`UPDATE chat_player_bans
		 SET status = 'lifted', lifted_at = ?
		 WHERE id = ? AND status = 'active'`,
		[formatMysqlDateTime(now), active.id],
	);
	const [rows] = await pool.query<BanRow[]>(
		`SELECT ${BAN_COLUMNS} FROM chat_player_bans WHERE id = ?`,
		[active.id],
	);
	return rows[0] ? toBanRecord(rows[0]) : null;
}

/** 统计账号在给定时间之后创建的历史封禁数（含已过期/已解封）。 */
export async function countBansSince(
	pool: Pool,
	account: string,
	since: Date,
): Promise<number> {
	const [rows] = await pool.query<Array<RowDataPacket & { total: number | string }>>(
		`SELECT COUNT(*) AS total
		 FROM chat_player_bans
		 WHERE account = ? AND created_at >= ?`,
		[account, formatMysqlDateTime(since)],
	);
	return Number(rows[0]?.total ?? 0);
}

/** 账号最近一条封禁记录（任意状态），用于历史摘要。 */
export async function fetchLastBan(
	pool: Pool,
	account: string,
): Promise<ChatPlayerBanRecord | null> {
	const [rows] = await pool.query<BanRow[]>(
		`SELECT ${BAN_COLUMNS}
		 FROM chat_player_bans
		 WHERE account = ?
		 ORDER BY id DESC
		 LIMIT 1`,
		[account],
	);
	return rows[0] ? toBanRecord(rows[0]) : null;
}

/** 账号全部封禁历史，前端/排查用。 */
export async function fetchBansForAccount(
	pool: Pool,
	account: string,
	limit = 20,
): Promise<ChatPlayerBanRecord[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
		throw new Error("limit 必须是 1~200 之间的整数");
	}
	const [rows] = await pool.query<BanRow[]>(
		`SELECT ${BAN_COLUMNS}
		 FROM chat_player_bans
		 WHERE account = ?
		 ORDER BY id DESC
		 LIMIT ${limit}`,
		[account],
	);
	return rows.map(toBanRecord);
}
