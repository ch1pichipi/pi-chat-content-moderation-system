/**
 * MySQL DATETIME(3) 与 JS Date 之间的转换。
 *
 * 连接池使用 dateStrings: true，数据库返回 "YYYY-MM-DD HH:mm:ss.SSS" 字符串。
 * 统一在这里转换，避免各调用方各自实现导致时区/精度不一致。
 */

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

/** 把 Date 格式化为 MySQL DATETIME(3) 字符串（本地时区）。 */
export function formatMysqlDateTime(date: Date): string {
	return [
		date.getFullYear(),
		"-",
		pad(date.getMonth() + 1),
		"-",
		pad(date.getDate()),
		" ",
		pad(date.getHours()),
		":",
		pad(date.getMinutes()),
		":",
		pad(date.getSeconds()),
		".",
		pad(date.getMilliseconds(), 3),
	].join("");
}

const MYSQL_DATETIME_RE =
	/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/** 解析 MySQL DATETIME 字符串；无法解析时返回 null。 */
export function parseMysqlDateTime(value: string | null | undefined): Date | null {
	if (!value) return null;
	const match = MYSQL_DATETIME_RE.exec(value.trim());
	if (!match) {
		const fallback = new Date(value);
		return Number.isNaN(fallback.getTime()) ? null : fallback;
	}
	const [, year, month, day, hour, minute, second, fraction] = match;
	const ms = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;
	return new Date(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
		ms,
	);
}

/** 归一化外部传入的时间字符串为 MySQL DATETIME(3)；非法值抛错。 */
export function normalizeMysqlDateTime(value: string | undefined, field: string): string {
	if (!value) return formatMysqlDateTime(new Date());
	const parsed = parseMysqlDateTime(value);
	if (!parsed) throw new Error(`${field} 不是合法时间: ${value}`);
	return formatMysqlDateTime(parsed);
}
