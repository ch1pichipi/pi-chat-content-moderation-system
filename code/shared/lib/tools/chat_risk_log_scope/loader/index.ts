/**
 * 日志加载入口：按扩展名/显式格式分发到 CSV 或 JSON 解析器。
 * 文件大小与行数均有上限，避免 Agent 因超大文件卡死。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { LogEntry } from "../types.ts";
import { loadCsv } from "./csv.ts";
import { loadJson } from "./json.ts";

export type LogFormat = "csv" | "json";

/** 单文件大小上限：20MB。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 单文件行数上限：100,000 行。 */
export const MAX_FILE_LINES = 100_000;

export interface LoadResult {
	entries: LogEntry[];
	/** 每条日志的 warnings 展开后的汇总，便于工具层一次性返回。 */
	warnings: string[];
	format: LogFormat;
	lineCount: number;
}

export function detectFormat(pathOrName: string): LogFormat {
	const ext = path.extname(pathOrName).toLowerCase();
	if (ext === ".csv") return "csv";
	if (ext === ".json") return "json";
	throw new Error(`不支持的文件格式 ${JSON.stringify(ext)}，仅支持 .csv 或 .json`);
}

function checkLineLimit(text: string): number {
	const lineCount = text === "" ? 0 : text.split(/\r\n|\n|\r/).length;
	if (lineCount > MAX_FILE_LINES) {
		throw new Error(
			`日志行数 ${lineCount} 超过上限 ${MAX_FILE_LINES}，请先拆分文件或使用增量模式`,
		);
	}
	return lineCount;
}

/** 解析文本内容（内联 CSV/JSON）。 */
export function loadFromText(content: string, format: LogFormat): LoadResult {
	const lineCount = checkLineLimit(content);
	const result = format === "csv" ? loadCsv(content) : loadJson(content);
	return {
		entries: result.entries,
		warnings: result.warnings,
		format,
		lineCount,
	};
}

/** 读取并解析日志文件。会先校验大小（20MB）与行数（100,000）限制。 */
export async function loadFromFile(filePath: string): Promise<LoadResult> {
	const format = detectFormat(filePath);

	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(filePath);
	} catch {
		throw new Error(`打开日志文件失败: ${filePath}`);
	}
	if (!fileStat.isFile()) {
		throw new Error(`日志路径不是普通文件: ${filePath}`);
	}
	if (fileStat.size > MAX_FILE_BYTES) {
		throw new Error(
			`日志文件大小 ${fileStat.size} 字节超过上限 ${MAX_FILE_BYTES} 字节（20MB），请先拆分文件`,
		);
	}

	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		throw new Error(`读取日志文件失败: ${(error as Error).message}`);
	}

	return loadFromText(content, format);
}

export { parseCsvRows } from "./csv.ts";
export { parseTime } from "./time.ts";
