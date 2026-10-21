import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { SUGGESTED_ACTIONS, type SuggestedAction } from "../types.ts";
import { formatMysqlDateTime, normalizeMysqlDateTime } from "./datetime.ts";
import type { AgentJudgementInput } from "./types.ts";

interface JudgementRow extends RowDataPacket {
	id: number | string;
	log_id: string;
	is_risk: number | boolean;
	reason: number;
	label: string;
	confidence: string | number;
	action: string;
	evidence: unknown;
	punishment_requested: string | null;
	punishment_applied: string | null;
	ban_seconds: number | string | null;
	policy_adjusted: number | boolean | null;
	policy_note: string | null;
	agent_model: string | null;
	judged_at: string;
}

export interface SavedJudgementRecord {
	id: number;
	log_id: string;
	is_risk: boolean;
	reason: number;
	label: string;
	confidence: number;
	action: SuggestedAction;
	evidence: string[];
	punishment_requested: string | null;
	punishment_applied: string | null;
	ban_seconds: number | null;
	policy_adjusted: boolean;
	policy_note: string | null;
	agent_model: string;
	judged_at: string;
}

const POLICY_NOTE_MAX_LENGTH = 255;

function isSuggestedAction(value: string): value is SuggestedAction {
	return (SUGGESTED_ACTIONS as readonly string[]).includes(value);
}

function validateJudgement(item: AgentJudgementInput, index: number): void {
	const prefix = `judgements[${index}]`;
	if (typeof item.log_id !== "string" || item.log_id.trim() === "") {
		throw new Error(`${prefix}.log_id 必须是非空字符串`);
	}
	if (typeof item.is_risk !== "boolean") {
		throw new Error(`${prefix}.is_risk 必须是布尔值`);
	}
	if (!Number.isInteger(item.reason)) {
		throw new Error(`${prefix}.reason 必须是整数`);
	}
	if (typeof item.label !== "string" || item.label.trim() === "") {
		throw new Error(`${prefix}.label 必须是非空字符串`);
	}
	if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
		throw new Error(`${prefix}.confidence 必须在 0~1 之间`);
	}
	if (typeof item.action !== "string" || !isSuggestedAction(item.action)) {
		throw new Error(
			`${prefix}.action 必须是 ${SUGGESTED_ACTIONS.join(" / ")} 之一`,
		);
	}
	if (item.evidence !== undefined) {
		if (!Array.isArray(item.evidence) || item.evidence.some((text) => typeof text !== "string")) {
			throw new Error(`${prefix}.evidence 必须是字符串数组`);
		}
	}
	if (item.ban_seconds !== undefined && item.ban_seconds !== null) {
		if (!Number.isInteger(item.ban_seconds) || item.ban_seconds < 0) {
			throw new Error(`${prefix}.ban_seconds 必须是非负整数或 null`);
		}
	}
	if (
		item.punishment_requested !== undefined &&
		item.punishment_requested !== null &&
		(typeof item.punishment_requested !== "string" || item.punishment_requested === "")
	) {
		throw new Error(`${prefix}.punishment_requested 必须是非空字符串或 null`);
	}
	if (
		item.punishment_applied !== undefined &&
		item.punishment_applied !== null &&
		(typeof item.punishment_applied !== "string" || item.punishment_applied === "")
	) {
		throw new Error(`${prefix}.punishment_applied 必须是非空字符串或 null`);
	}
}

function parseEvidence(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string" && value.trim() !== "") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed)) {
				return parsed.filter((item): item is string => typeof item === "string");
			}
		} catch {
			return [];
		}
	}
	return [];
}

function normalizePolicyNote(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	return trimmed.length > POLICY_NOTE_MAX_LENGTH
		? trimmed.slice(0, POLICY_NOTE_MAX_LENGTH)
		: trimmed;
}

function toSavedRecord(row: JudgementRow): SavedJudgementRecord {
	return {
		id: Number(row.id),
		log_id: row.log_id,
		is_risk: row.is_risk === true || Number(row.is_risk) === 1,
		reason: Number(row.reason),
		label: row.label,
		confidence: Number(row.confidence),
		action: row.action as SuggestedAction,
		evidence: parseEvidence(row.evidence),
		punishment_requested: row.punishment_requested ?? null,
		punishment_applied: row.punishment_applied ?? null,
		ban_seconds: row.ban_seconds === null ? null : Number(row.ban_seconds),
		policy_adjusted: row.policy_adjusted === true || Number(row.policy_adjusted) === 1,
		policy_note: row.policy_note ?? null,
		agent_model: row.agent_model ?? "",
		judged_at: row.judged_at,
	};
}

function toInsertRow(item: AgentJudgementInput): unknown[] {
	return [
		item.log_id,
		item.is_risk ? 1 : 0,
		item.reason,
		item.label,
		item.confidence,
		item.action,
		JSON.stringify(item.evidence ?? []),
		item.punishment_requested ?? null,
		item.punishment_applied ?? null,
		item.ban_seconds ?? null,
		item.policy_adjusted === true ? 1 : 0,
		normalizePolicyNote(item.policy_note),
		item.agent_model ?? null,
		normalizeMysqlDateTime(item.judged_at, "judged_at"),
	];
}

const INSERT_COLUMNS = `(log_id, is_risk, reason, label, confidence, action, evidence,
	punishment_requested, punishment_applied, ban_seconds, policy_adjusted, policy_note,
	agent_model, judged_at)`;

const UPSERT_UPDATE = `ON DUPLICATE KEY UPDATE
	is_risk = VALUES(is_risk),
	reason = VALUES(reason),
	label = VALUES(label),
	confidence = VALUES(confidence),
	action = VALUES(action),
	evidence = VALUES(evidence),
	punishment_requested = VALUES(punishment_requested),
	punishment_applied = VALUES(punishment_applied),
	ban_seconds = VALUES(ban_seconds),
	policy_adjusted = VALUES(policy_adjusted),
	policy_note = VALUES(policy_note),
	agent_model = VALUES(agent_model),
	judged_at = VALUES(judged_at),
	updated_at = CURRENT_TIMESTAMP(3)`;

/** 批量写入/更新 Agent 判断结果；同一 log_id 只保留一条。 */
export async function saveJudgements(
	pool: Pool,
	judgements: readonly AgentJudgementInput[],
): Promise<{ saved: number; affectedRows: number }> {
	if (judgements.length === 0) return { saved: 0, affectedRows: 0 };
	if (judgements.length > 1000) throw new Error("单次最多保存 1000 条判断结果");

	for (let index = 0; index < judgements.length; index++) {
		validateJudgement(judgements[index], index);
	}

	const rows = judgements.map(toInsertRow);
	const [result] = await pool.query<ResultSetHeader>(
		`INSERT INTO chat_risk_judgements ${INSERT_COLUMNS}
		 VALUES ?
		 ${UPSERT_UPDATE}`,
		[rows],
	);
	return { saved: judgements.length, affectedRows: result.affectedRows };
}

/**
 * 写入单条判断结果并返回数据库自增 id。
 * 实时封禁服务需要 judgement_id 关联 chat_player_bans。
 */
export async function saveJudgementReturningId(
	pool: Pool,
	judgement: AgentJudgementInput,
): Promise<number> {
	validateJudgement(judgement, 0);

	const [result] = await pool.query<ResultSetHeader>(
		`INSERT INTO chat_risk_judgements ${INSERT_COLUMNS}
		 VALUES (?) ${UPSERT_UPDATE}`,
		[toInsertRow(judgement)],
	);
	if (result.insertId) return Number(result.insertId);

	const [rows] = await pool.query<Array<RowDataPacket & { id: number | string }>>(
		"SELECT id FROM chat_risk_judgements WHERE log_id = ?",
		[judgement.log_id],
	);
	const id = rows[0]?.id;
	if (id === undefined) {
		throw new Error(`写入判断结果后无法读取 id: ${judgement.log_id}`);
	}
	return Number(id);
}

export async function countJudgements(pool: Pool): Promise<number> {
	const [rows] = await pool.query<Array<RowDataPacket & { total: number | string }>>(
		"SELECT COUNT(*) AS total FROM chat_risk_judgements",
	);
	return Number(rows[0]?.total ?? 0);
}

/** 按 log_id 查询判断结果，主要用于验证写入与测试。 */
export async function fetchJudgementsByLogIds(
	pool: Pool,
	logIds: readonly string[],
): Promise<SavedJudgementRecord[]> {
	if (logIds.length === 0) return [];
	const placeholders = logIds.map(() => "?").join(", ");
	const [rows] = await pool.query<JudgementRow[]>(
		`SELECT id, log_id, is_risk, reason, label, confidence, action, evidence,
		        punishment_requested, punishment_applied, ban_seconds, policy_adjusted,
		        policy_note, agent_model, judged_at
		 FROM chat_risk_judgements
		 WHERE log_id IN (${placeholders})
		 ORDER BY log_id ASC`,
		[...logIds],
	);
	return rows.map(toSavedRecord);
}

/** 当前时间对应的 MySQL DATETIME(3)，供服务层构造时间参数。 */
export function mysqlNow(date: Date = new Date()): string {
	return formatMysqlDateTime(date);
}
