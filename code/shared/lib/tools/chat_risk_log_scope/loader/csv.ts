/**
 * CSV 读取与容错解析（RFC4180 容忍版）。
 *
 * - 首行为表头，列名大小写不敏感、顺序任意，缺失列使用空值。
 * - 单行字段数不一致不中断，多余字段忽略。
 * - 坏行（无法解析）跳过并记录 warning。
 */

import type { LogEntry } from "../types.ts";
import { parseTime } from "./time.ts";

export interface CsvLoadResult {
	entries: LogEntry[];
	warnings: string[];
	skippedRows: number;
}

/**
 * 解析 CSV 文本为二维数组。支持引号包裹、字段内逗号/换行、`""` 转义与 CRLF。
 */
export function parseCsvRows(text: string): string[][] {
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let hasField = false;
	let lineHasContent = false;

	const pushField = () => {
		row.push(field);
		field = "";
		hasField = false;
	};
	const pushRow = () => {
		if (row.length > 0 || hasField) {
			rows.push(row);
		}
		row = [];
		hasField = false;
		lineHasContent = false;
	};

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];

		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
				if (ch === "\n" || ch === "\r") lineHasContent = true;
			}
			continue;
		}

		if (ch === '"' && field === "") {
			inQuotes = true;
			hasField = true;
			lineHasContent = true;
			continue;
		}

		if (ch === ",") {
			pushField();
			lineHasContent = true;
			continue;
		}

		if (ch === "\r" || ch === "\n") {
			// CRLF 视为一个换行。
			if (ch === "\r" && src[i + 1] === "\n") i++;
			pushField();
			if (lineHasContent || row.length > 1 || row[0] !== "") {
				pushRow();
			} else {
				row = [];
				hasField = false;
				lineHasContent = false;
			}
			continue;
		}

		field += ch;
		hasField = true;
		lineHasContent = true;
	}

	// 处理末行（无换行结尾）。
	if (inQuotes) {
		// 容忍未闭合引号：把剩余内容作为字段值。
		pushField();
		pushRow();
	} else if (lineHasContent || hasField || row.length > 0) {
		pushField();
		pushRow();
	}

	return rows;
}

function parseCsvBool(value: string): boolean {
	const s = value.toLowerCase();
	return s === "true" || s === "1";
}

/** 解析 CSV 文本为 LogEntry 列表。 */
export function loadCsv(text: string): CsvLoadResult {
	const rows = parseCsvRows(text);
	if (rows.length === 0) {
		throw new Error("CSV 日志文件为空");
	}

	const header = rows[0];
	const colIndex = new Map<string, number>();
	for (let i = 0; i < header.length; i++) {
		colIndex.set(header[i].trim().toLowerCase(), i);
	}

	const get = (row: readonly string[], col: string): string => {
		const idx = colIndex.get(col);
		if (idx === undefined || idx >= row.length) return "";
		return row[idx].trim();
	};

	const entries: LogEntry[] = [];
	const warnings: string[] = [];
	let skippedRows = 0;

	for (let r = 1; r < rows.length; r++) {
		const row = rows[r];
		if (row.length === 1 && row[0].trim() === "") {
			continue;
		}
		const rowNum = r + 1;
		const entryWarnings: string[] = [];
		const warn = (message: string) => entryWarnings.push(message);

		const entry: LogEntry = {
			id: get(row, "id"),
			requestId: get(row, "request_id"),
			account: get(row, "account"),
			appId: get(row, "app_id"),
			areaId: get(row, "area_id"),
			areaName: get(row, "area_name"),
			serverId: get(row, "server_id"),
			nickname: get(row, "nickname"),
			contextMessages: [],
			currentMessage: get(row, "current_message"),
			judgeResult: get(row, "judge_result"),
			contextType: get(row, "context_type"),
			reason: -1,
			confidence: 0,
			level: get(row, "level"),
			label: get(row, "label"),
			prediction: get(row, "prediction"),
			reviewedAt: get(row, "reviewed_at"),
			forbidConsidered: false,
			forbidDeduped: false,
			reviewedTime: null,
			createTime: null,
			createTimeStr: "",
			warnings: [],
		};

		if (entry.id === "") warn(`第 ${rowNum} 行缺失 id 字段`);
		if (entry.account === "") warn(`记录 ${entry.id} 缺失 account 字段`);

		entry.contextMessages = splitContextString(get(row, "context_messages"));

		const reasonStr = get(row, "reason");
		if (reasonStr === "") {
			warn(`记录 ${entry.id} 的 reason 字段缺失，默认视为 -1（正常）`);
			entry.reason = -1;
		} else {
			const parsed = Number(reasonStr);
			if (Number.isInteger(parsed)) {
				entry.reason = parsed;
			} else {
				warn(`记录 ${entry.id} 的 reason 字段 ${JSON.stringify(reasonStr)} 非法，默认视为 -1（正常）`);
				entry.reason = -1;
			}
		}

		const confStr = get(row, "confidence");
		if (confStr !== "") {
			const parsed = Number(confStr);
			if (Number.isFinite(parsed)) {
				entry.confidence = parsed;
			} else {
				warn(`记录 ${entry.id} 的 confidence 字段 ${JSON.stringify(confStr)} 非法，默认置为 0`);
			}
		}

		entry.forbidConsidered = parseCsvBool(get(row, "forbid_considered"));
		entry.forbidDeduped = parseCsvBool(get(row, "forbid_deduped"));

		if (entry.reviewedAt !== "") {
			const t = parseTime(entry.reviewedAt);
			if (t) {
				entry.reviewedTime = t;
			} else {
				warn(`记录 ${entry.id} 的 reviewed_at 时间格式无法解析: ${entry.reviewedAt}`);
			}
		}

		entry.createTimeStr = get(row, "create_time");
		if (entry.createTimeStr !== "") {
			const t = parseTime(entry.createTimeStr);
			if (t) {
				entry.createTime = t;
			} else {
				warn(`记录 ${entry.id} 的 create_time 时间格式无法解析: ${entry.createTimeStr}`);
			}
		}

		entry.warnings = entryWarnings;
		warnings.push(...entryWarnings);
		entries.push(entry);
	}

	if (entries.length === 0) {
		throw new Error("CSV 日志文件不含任何数据行");
	}

	return { entries, warnings, skippedRows };
}

/** 支持 "|" 或 "\n" 分隔的上下文消息字符串。 */
export function splitContextString(value: string): string[] {
	const s = value.trim();
	if (s === "") return [];
	const sep = s.includes("\n") ? "\n" : "|";
	return s
		.split(sep)
		.map((part) => part.trim())
		.filter((part) => part !== "");
}
