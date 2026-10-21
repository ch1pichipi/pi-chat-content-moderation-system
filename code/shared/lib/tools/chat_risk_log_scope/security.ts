/**
 * 路径安全工具。
 *
 * 约束：
 *  - 输入日志必须位于工作区根目录内；
 *  - 拒绝 ".." 逃逸、绝对路径逃逸、符号链接逃逸；
 *  - 报告目录固定为工作区下的 reports/。
 */

import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

function normalizeForCompare(value: string): string {
	const resolved = path.resolve(value);
	// Windows 文件系统大小写不敏感，比较时统一小写。
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isInside(root: string, candidate: string): boolean {
	const rootNorm = normalizeForCompare(root);
	const candidateNorm = normalizeForCompare(candidate);
	if (candidateNorm === rootNorm) return true;
	const rootWithSep = rootNorm.endsWith(path.sep) ? rootNorm : `${rootNorm}${path.sep}`;
	return candidateNorm.startsWith(rootWithSep);
}

async function realRoot(cwd: string): Promise<string> {
	try {
		return await realpath(cwd);
	} catch {
		throw new Error(`工作区目录不存在或不可访问: ${cwd}`);
	}
}

/**
 * 将用户输入的日志路径解析为工作区内的真实路径。
 * 文件必须存在且为普通文件；任何逃逸尝试都会被拒绝。
 */
export async function resolveWorkspaceFile(cwd: string, inputPath: string): Promise<string> {
	if (typeof inputPath !== "string" || inputPath.trim() === "") {
		throw new Error("source.path 不能为空");
	}
	if (inputPath.includes("\0")) {
		throw new Error("source.path 包含非法字符");
	}

	const root = await realRoot(cwd);
	const absolute = path.resolve(root, inputPath);
	if (!isInside(root, absolute)) {
		throw new Error("source.path 必须位于工作区根目录内，已拒绝路径逃逸");
	}

	let actual: string;
	try {
		actual = await realpath(absolute);
	} catch {
		throw new Error(`日志文件不存在: ${inputPath}`);
	}
	if (!isInside(root, actual)) {
		throw new Error("source.path 解析后位于工作区之外，已拒绝符号链接逃逸");
	}

	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(actual);
	} catch {
		throw new Error(`日志文件不存在: ${inputPath}`);
	}
	if (!fileStat.isFile()) {
		throw new Error(`日志路径不是普通文件: ${inputPath}`);
	}
	return actual;
}

/**
 * 将用户输入的写路径（如增量状态文件）解析到工作区内。
 * 目标文件可以尚不存在，但父目录的真实路径必须位于工作区内。
 */
export async function resolveWorkspaceWritePath(cwd: string, inputPath: string): Promise<string> {
	if (typeof inputPath !== "string" || inputPath.trim() === "") {
		throw new Error("写入路径不能为空");
	}
	if (inputPath.includes("\0")) {
		throw new Error("写入路径包含非法字符");
	}

	const root = await realRoot(cwd);
	const absolute = path.resolve(root, inputPath);
	if (!isInside(root, absolute)) {
		throw new Error("写入路径必须位于工作区根目录内，已拒绝路径逃逸");
	}

	// 校验最近的已存在父目录，防止通过符号链接目录逃逸。
	let dir = path.dirname(absolute);
	let existingDir: string | null = null;
	while (true) {
		try {
			existingDir = await realpath(dir);
			break;
		} catch {
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	if (existingDir && !isInside(root, existingDir)) {
		throw new Error("写入路径的父目录解析后位于工作区之外，已拒绝符号链接逃逸");
	}

	return absolute;
}

/** 确保工作区下的 reports/ 目录存在，并校验其真实路径未逃逸出工作区。 */
export async function ensureReportsDir(cwd: string): Promise<string> {
	const root = await realRoot(cwd);
	const reportsDir = path.join(root, "reports");
	await mkdir(reportsDir, { recursive: true });

	const actual = await realpath(reportsDir);
	if (!isInside(root, actual)) {
		throw new Error("reports/ 目录解析后位于工作区之外，已拒绝写入");
	}
	return actual;
}
