/**
 * 报告与控制台输出使用的脱敏与截断工具。
 * 所有长度计算均以 Unicode code point 为单位，避免把 emoji 截断成半个字符。
 */

/**
 * 对账号做掩码：保留首尾各 1 个字符，中间替换为 "*"。
 * 长度 <= 2 时整体替换为 "*"；noMask=true 或空字符串时原样返回。
 */
export function maskAccount(account: string, noMask = false): string {
	if (noMask || account === "") return account;
	const chars = Array.from(account);
	if (chars.length <= 2) {
		return "*".repeat(chars.length);
	}
	return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/** 按 code point 截断文本，超出 maxLen 时追加 "…"；maxLen <= 0 表示不截断。 */
export function truncate(text: string, maxLen: number): string {
	if (maxLen <= 0) return text;
	const chars = Array.from(text);
	if (chars.length <= maxLen) return text;
	return `${chars.slice(0, maxLen).join("")}…`;
}
