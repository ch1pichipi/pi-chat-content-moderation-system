/**
 * 时间解析。
 *
 * 支持与 Go 版本 loader 一致的 11 种格式，语义为本地时区（带时区偏移的 RFC3339 除外）：
 *  1. RFC3339Nano / 2. RFC3339
 *  3. 2006-01-02 15:04:05.999999999 （纳秒）
 *  4. 2006-01-02 15:04:05.999999    （微秒）
 *  5. 2006-01-02 15:04:05.999       （毫秒）
 *  6. 2006-01-02 15:04:05           （秒）
 *  7. 2006-01-02T15:04:05.999999999
 *  8. 2006-01-02T15:04:05.999999
 *  9. 2006-01-02T15:04:05.999
 * 10. 2006-01-02T15:04:05
 * 11. 2006-01-02
 */

interface DateParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	ms: number;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const OFFSET_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function fractionToMs(fraction: string | undefined): number {
	if (!fraction) return 0;
	// 只保留毫秒精度；纳秒/微秒部分按 Go 版本落入 Date 时被截断。
	return Number(fraction.slice(0, 3).padEnd(3, "0"));
}

function validParts(parts: DateParts): boolean {
	const { year, month, day, hour, minute, second, ms } = parts;
	if (month < 1 || month > 12) return false;
	if (day < 1 || day > 31) return false;
	if (hour > 23 || minute > 59 || second > 59) return false;
	if (ms > 999) return false;
	// 通过 UTC 构造校验日期真实存在（如 2 月 30 日）。
	const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
	return (
		probe.getUTCFullYear() === year &&
		probe.getUTCMonth() === month - 1 &&
		probe.getUTCDate() === day
	);
}

/**
 * 解析时间字符串，返回本地时间 Date；无法解析返回 null（调用方记录 warning）。
 */
export function parseTime(input: string): Date | null {
	const s = input.trim();
	if (s === "") return null;

	const dateOnly = DATE_ONLY_RE.exec(s);
	if (dateOnly) {
		const parts: DateParts = {
			year: Number(dateOnly[1]),
			month: Number(dateOnly[2]),
			day: Number(dateOnly[3]),
			hour: 0,
			minute: 0,
			second: 0,
			ms: 0,
		};
		if (!validParts(parts)) return null;
		return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
	}

	const offset = OFFSET_RE.exec(s);
	if (offset) {
		const parts: DateParts = {
			year: Number(offset[1]),
			month: Number(offset[2]),
			day: Number(offset[3]),
			hour: Number(offset[4]),
			minute: Number(offset[5]),
			second: Number(offset[6]),
			ms: fractionToMs(offset[7]),
		};
		if (!validParts(parts)) return null;
		const utcMs = Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
			parts.ms,
		);
		const zone = offset[8];
		if (zone === "Z") return new Date(utcMs);
		const sign = zone[0] === "-" ? -1 : 1;
		const offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
		return new Date(utcMs - offsetMinutes * 60_000);
	}

	const local = LOCAL_RE.exec(s);
	if (local) {
		const parts: DateParts = {
			year: Number(local[1]),
			month: Number(local[2]),
			day: Number(local[3]),
			hour: Number(local[4]),
			minute: Number(local[5]),
			second: Number(local[6]),
			ms: fractionToMs(local[7]),
		};
		if (!validParts(parts)) return null;
		return new Date(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
			parts.ms,
		);
	}

	return null;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function pad3(n: number): string {
	return String(n).padStart(3, "0");
}

/** 格式化为 `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
export function formatDateTime(date: Date): string {
	return (
		`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
		`${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
	);
}

/** 格式化为 `YYYY-MM-DD HH:mm:ss.SSS`（本地时区），用于增量游标日志。 */
export function formatDateTimeMs(date: Date): string {
	return `${formatDateTime(date)}.${pad3(date.getMilliseconds())}`;
}

/** 格式化为报告文件名时间戳 `YYYYMMDD_HHmmss`（本地时区）。 */
export function formatFileTimestamp(date: Date): string {
	return (
		`${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_` +
		`${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
	);
}
