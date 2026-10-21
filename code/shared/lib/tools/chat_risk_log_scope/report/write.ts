/**
 * 报告落盘。
 *
 * 报告目录固定为工作区下的 reports/，文件名自动追加时间戳：
 *   reports/chat_risk_report_YYYYMMDD_HHmmss.md
 * 增量模式追加 _seqN；同名文件已存在时追加 _1、_2 ... 避免覆盖。
 */

import { access, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatFileTimestamp } from "../loader/time.ts";
import { ensureReportsDir } from "../security.ts";

export interface ReportFileOptions {
	cwd: string;
	generatedAt?: Date;
	/** 增量模式报告序号；>0 时文件名追加 _seqN。 */
	reportSeq?: number;
}

export interface WrittenReport {
	/** 相对工作区的路径，使用 / 分隔，便于跨平台展示。 */
	relativePath: string;
	absolutePath: string;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function buildReportFileName(generatedAt: Date, reportSeq = 0): string {
	const base = `chat_risk_report_${formatFileTimestamp(generatedAt)}`;
	return reportSeq > 0 ? `${base}_seq${reportSeq}.md` : `${base}.md`;
}

export async function writeMarkdownReport(
	markdown: string,
	options: ReportFileOptions,
): Promise<WrittenReport> {
	const generatedAt = options.generatedAt ?? new Date();
	const reportsDir = await ensureReportsDir(options.cwd);
	const baseName = buildReportFileName(generatedAt, options.reportSeq ?? 0).replace(/\.md$/, "");

	let fileName = `${baseName}.md`;
	let suffix = 0;
	while (await exists(path.join(reportsDir, fileName))) {
		suffix += 1;
		fileName = `${baseName}_${suffix}.md`;
	}

	const absolutePath = path.join(reportsDir, fileName);
	await writeFile(absolutePath, markdown, { encoding: "utf8", mode: 0o644 });

	return {
		absolutePath,
		relativePath: path.posix.join("reports", fileName),
	};
}
