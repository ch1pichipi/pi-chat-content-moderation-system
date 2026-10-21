/**
 * JSON 读取与宽松解析。
 *
 * 支持数组格式；数值字段允许字符串/数字混用，context_messages 允许数组或分隔字符串。
 * 字段缺失或格式异常时使用默认值并记录 warning，不中断整体流程。
 */

import type { LogEntry } from "../types.ts";
import { splitContextString } from "./csv.ts";
import { parseTime } from "./time.ts";

export interface JsonLoadResult {
	entries: LogEntry[];
	warnings: string[];
}

type JsonRecord = Record<string, unknown>;

function normalizeRecord(record: JsonRecord): Map<string, unknown> {
	const map = new Map<string, unknown>();
	for (const [key, value] of Object.entries(record)) {
		map.set(key.trim().toLowerCase(), value);
	}
	return map;
}

function pickString(rec: Map<string, unknown>, key: string): string {
	const value = rec.get(key);
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function pickRaw(rec: Map<string, unknown>, key: string): unknown {
	return rec.get(key);
}

function parseJsonInt(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isInteger(value) ? value : null;
	}
	if (typeof value === "string") {
		const s = value.trim();
		if (s === "" || !/^[+-]?\d+$/.test(s)) return null;
		const n = Number(s);
		return Number.isSafeInteger(n) ? n : null;
	}
	return null;
}

function parseJsonFloat(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const s = value.trim();
		if (s === "") return null;
		const n = Number(s);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function parseJsonBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const s = value.trim().toLowerCase();
		return s === "true" || s === "1";
	}
	if (typeof value === "number") return value !== 0;
	return false;
}

function parseContextMessages(
	value: unknown,
	warn: (message: string) => void,
	id: string,
): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) {
		return value
			.filter((item) => item !== null && item !== undefined)
			.map((item) => String(item));
	}
	if (typeof value === "string") return splitContextString(value);
	warn(`记录 ${id} 的 context_messages 字段格式无法解析`);
	return [];
}

function recordToEntry(record: unknown, index: number): LogEntry {
	const warnings: string[] = [];
	const warn = (message: string) => warnings.push(message);

	const rec = normalizeRecord(
		record !== null && typeof record === "object" && !Array.isArray(record)
			? (record as JsonRecord)
			: {},
	);

	const entry: LogEntry = {
		id: pickString(rec, "id"),
		requestId: pickString(rec, "request_id"),
		account: pickString(rec, "account"),
		appId: pickString(rec, "app_id"),
		areaId: pickString(rec, "area_id"),
		areaName: pickString(rec, "area_name"),
		serverId: pickString(rec, "server_id"),
		nickname: pickString(rec, "nickname"),
		contextMessages: [],
		currentMessage: pickString(rec, "current_message"),
		judgeResult: pickString(rec, "judge_result"),
		contextType: pickString(rec, "context_type"),
		reason: -1,
		confidence: 0,
		level: pickString(rec, "level"),
		label: pickString(rec, "label"),
		prediction: pickString(rec, "prediction"),
		reviewedAt: pickString(rec, "reviewed_at"),
		forbidConsidered: false,
		forbidDeduped: false,
		reviewedTime: null,
		createTime: null,
		createTimeStr: "",
		warnings: [],
	};

	if (entry.id === "") warn(`第 ${index} 条记录缺失 id 字段`);
	if (entry.account === "") warn(`记录 ${entry.id} 缺失 account 字段`);

	entry.contextMessages = parseContextMessages(pickRaw(rec, "context_messages"), warn, entry.id);

	const reason = parseJsonInt(pickRaw(rec, "reason"));
	if (reason === null) {
		warn(`记录 ${entry.id} 的 reason 字段缺失或非法，默认视为 -1（正常）`);
		entry.reason = -1;
	} else {
		entry.reason = reason;
	}

	const confidence = parseJsonFloat(pickRaw(rec, "confidence"));
	if (confidence === null) {
		warn(`记录 ${entry.id} 的 confidence 字段缺失或非法，默认置为 0`);
	} else {
		entry.confidence = confidence;
	}

	entry.forbidConsidered = parseJsonBool(pickRaw(rec, "forbid_considered"));
	entry.forbidDeduped = parseJsonBool(pickRaw(rec, "forbid_deduped"));

	if (entry.reviewedAt !== "") {
		const t = parseTime(entry.reviewedAt);
		if (t) {
			entry.reviewedTime = t;
		} else {
			warn(`记录 ${entry.id} 的 reviewed_at 时间格式无法解析: ${entry.reviewedAt}`);
		}
	}

	entry.createTimeStr = pickString(rec, "create_time");
	if (entry.createTimeStr !== "") {
		const t = parseTime(entry.createTimeStr);
		if (t) {
			entry.createTime = t;
		} else {
			warn(`记录 ${entry.id} 的 create_time 时间格式无法解析: ${entry.createTimeStr}`);
		}
	}

	entry.warnings = warnings;
	return entry;
}

/** 解析 JSON 数组文本为 LogEntry 列表。 */
export function loadJson(text: string): JsonLoadResult {
	if (text.trim() === "") {
		throw new Error("JSON 日志文件为空");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`解析 JSON 日志失败: ${(error as Error).message}`);
	}

	if (!Array.isArray(parsed)) {
		throw new Error("解析 JSON 日志失败: 顶层结构必须是数组");
	}
	if (parsed.length === 0) {
		throw new Error("JSON 日志文件不含任何数据行");
	}

	const entries: LogEntry[] = [];
	const warnings: string[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const entry = recordToEntry(parsed[i], i);
		entries.push(entry);
		warnings.push(...entry.warnings);
	}
	return { entries, warnings };
}
