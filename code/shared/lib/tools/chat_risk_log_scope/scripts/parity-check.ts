/**
 * Go / TypeScript 对拍脚本。
 *
 * 依赖参考项目 D:\projects\chat_risk_log_scope（可用 CHAT_RISK_GO_DIR 覆盖）。
 * 若参考项目或 go 不存在，脚本会打印跳过信息并以 0 退出。
 *
 * 用法：npm run parity:chat-risk
 */

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { analyzeFile } from "../analyze.ts";

const execFileAsync = promisify(execFile);

const GO_DIR = process.env.CHAT_RISK_GO_DIR ?? "D:/projects/chat_risk_log_scope";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "../__fixtures__");

interface Snapshot {
	summary: Record<string, number>;
	riskDistribution: Array<{ reason: number; count: number; label: string }>;
	accounts: Array<{
		account: string;
		nickname: string;
		count: number;
		mainReason: string;
		highRiskCount: number;
		suspectedRepeat: string;
		action: string;
	}>;
	samples: Array<{ purpose: string; reasonLabel: string; message: string }>;
	falsePositiveIds: string[];
	actionCounts: Record<string, number>;
	judgements: { total: number; falsePositive: number; degraded: number };
}

function section(markdown: string, index: number): string {
	const marker = `## ${index}. `;
	const start = markdown.indexOf(marker);
	if (start < 0) return "";
	const next = markdown.indexOf("\n## ", start + marker.length);
	return markdown.slice(start, next < 0 ? undefined : next);
}

function parseSummary(markdown: string): Snapshot["summary"] {
	const summary: Record<string, number> = {};
	const metrics = [
		"总日志数",
		"风险日志数",
		"正常日志数",
		"高置信度风险",
		"低置信度疑似误杀",
		"涉及账号数",
		"涉及区服数",
	];
	for (const metric of metrics) {
		const match = new RegExp(`\\| ${metric} \\| (\\d+) \\|`).exec(markdown);
		if (match) summary[metric] = Number(match[1]);
	}
	for (const [key, label] of [
		["总判断数", "AI判断总数"],
		["疑似误杀标记", "AI疑似误杀标记"],
		["降级（规则判断）", "AI降级数"],
	] as const) {
		const match = new RegExp(`- ${key}: (\\d+)`).exec(markdown);
		if (match) summary[label] = Number(match[1]);
	}
	return summary;
}

function parseRiskDistribution(markdown: string): Snapshot["riskDistribution"] {
	const rows: Snapshot["riskDistribution"] = [];
	const body = section(markdown, 2);
	for (const line of body.split("\n")) {
		const match = /^\| (-?\d+) \| (.+?) \| (\d+) \|/.exec(line.trim());
		if (match) {
			rows.push({ reason: Number(match[1]), label: match[2], count: Number(match[3]) });
		}
	}
	return rows.sort((a, b) => b.count - a.count || a.reason - b.reason);
}

function parseAccounts(markdown: string): Snapshot["accounts"] {
	const accounts: Snapshot["accounts"] = [];
	const body = section(markdown, 3);
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|") || trimmed.includes("---") || trimmed.includes("账号 |")) {
			continue;
		}
		const cells = trimmed
			.slice(1, -1)
			.split("|")
			.map((cell) => cell.trim());
		if (cells.length !== 7) continue;
		accounts.push({
			account: cells[0],
			nickname: cells[1],
			count: Number(cells[2]),
			mainReason: cells[3],
			highRiskCount: Number(cells[4]),
			suspectedRepeat: cells[5],
			action: cells[6],
		});
	}
	return accounts;
}

function parseSamples(markdown: string): Snapshot["samples"] {
	const samples: Snapshot["samples"] = [];
	const body = section(markdown, 4);
	const blocks = body.split(/\n### /).slice(1);
	for (const block of blocks) {
		const [heading, ...rest] = block.split("\n");
		const sep = heading.indexOf(" - ");
		const purpose = sep < 0 ? heading : heading.slice(0, sep);
		const reasonLabel = sep < 0 ? "" : heading.slice(sep + 3);
		const messageLine = rest.find((line) => line.trim().startsWith("- **当前消息**:"));
		const message = messageLine ? messageLine.replace("- **当前消息**:", "").trim() : "";
		samples.push({ purpose, reasonLabel, message });
	}
	return samples;
}

function parseFalsePositiveIds(markdown: string): string[] {
	const ids: string[] = [];
	const body = section(markdown, 5);
	for (const line of body.split("\n")) {
		const match = /^### 条目 (\S+) - /.exec(line.trim());
		if (match) ids.push(match[1]);
	}
	return ids.sort();
}

function parseActionCounts(markdown: string): Record<string, number> {
	const counts: Record<string, number> = {};
	const body = section(markdown, 6);
	for (const line of body.split("\n")) {
		const match = /^\| (放行|观察|人工复核|禁言|封禁|加入黑名单) \| (\d+) \|/.exec(line.trim());
		if (match) counts[match[1]] = Number(match[2]);
	}
	return counts;
}

function parseGoReport(markdown: string): Snapshot {
	const summary = parseSummary(markdown);
	return {
		summary: {
			总日志数: summary["总日志数"],
			风险日志数: summary["风险日志数"],
			正常日志数: summary["正常日志数"],
			高置信度风险: summary["高置信度风险"],
			低置信度疑似误杀: summary["低置信度疑似误杀"],
			涉及账号数: summary["涉及账号数"],
			涉及区服数: summary["涉及区服数"],
		},
		riskDistribution: parseRiskDistribution(markdown),
		accounts: parseAccounts(markdown),
		samples: parseSamples(markdown),
		falsePositiveIds: parseFalsePositiveIds(markdown),
		actionCounts: parseActionCounts(markdown),
		judgements: {
			total: summary["AI判断总数"] ?? 0,
			falsePositive: summary["AI疑似误杀标记"] ?? 0,
			degraded: summary["AI降级数"] ?? 0,
		},
	};
}

async function tsSnapshot(): Promise<Snapshot> {
	const result = await analyzeFile({
		source: {
			kind: "file",
			path: path.relative(
				REPO_ROOT,
				path.join(FIXTURE_DIR, "sample_logs.csv"),
			).replaceAll("\\", "/"),
		},
		options: { noMask: true },
		cwd: REPO_ROOT,
	});
	return {
		summary: {
			总日志数: result.summary.totalCount,
			风险日志数: result.summary.riskCount,
			正常日志数: result.summary.normalCount,
			高置信度风险: result.summary.highConfidenceRisk,
			低置信度疑似误杀: result.summary.lowConfidenceSuspect,
			涉及账号数: result.summary.accountCount,
			涉及区服数: result.summary.areaServerCount,
		},
		riskDistribution: result.riskDistribution.map((row) => ({
			reason: row.reason,
			label: row.label,
			count: row.count,
		})),
		accounts: result.accounts.map((account) => ({
			account: account.account,
			nickname: account.nickname,
			count: account.count,
			mainReason: account.mainReasonLabel,
			highRiskCount: account.highRiskCount,
			suspectedRepeat: account.suspectedRepeat ? "是" : "否",
			action: account.recommendedAction,
		})),
		samples: result.samples.map((sample) => ({
			purpose: sample.purpose,
			reasonLabel: sample.reasonLabel,
			message: sample.currentMessage,
		})),
		falsePositiveIds: result.falsePositives.map((item) => item.entryId).sort(),
		actionCounts: Object.fromEntries(
			Object.entries(result.judgementsSummary.actionCounts).filter(
				(entry): entry is [string, number] => typeof entry[1] === "number",
			),
		),
		judgements: {
			total: result.judgementsSummary.total,
			falsePositive: result.judgementsSummary.falsePositiveCount,
			degraded: result.judgementsSummary.degradedCount,
		},
	};
}

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

async function run(): Promise<void> {
	if (!(await exists(GO_DIR))) {
		console.log(`跳过 Go/TS 对拍：参考项目不存在 (${GO_DIR})`);
		return;
	}

	const tmpDir = await mkdtemp(path.join(os.tmpdir(), "chat-risk-parity-"));
	const goReportPath = path.join(tmpDir, "go_report.md");
	try {
		await execFileAsync(
			"go",
			[
				"run",
				"./cmd/chatrisk",
				"analyze",
				"--input",
				"testdata/sample_logs.csv",
				"--mock",
				"--no-mask",
				"--out",
				goReportPath,
			],
			{ cwd: GO_DIR, timeout: 180_000 },
		);
	} catch (error) {
		console.log(`跳过 Go/TS 对拍：Go 参考版本运行失败 (${(error as Error).message})`);
		return;
	}

	const goSnapshot = parseGoReport(await readFile(goReportPath, "utf8"));
	const ts = await tsSnapshot();

	const keys: Array<keyof Snapshot> = [
		"summary",
		"riskDistribution",
		"accounts",
		"samples",
		"falsePositiveIds",
		"actionCounts",
		"judgements",
	];

	let failed = false;
	for (const key of keys) {
		const goJson = JSON.stringify(goSnapshot[key]);
		const tsJson = JSON.stringify(ts[key]);
		if (goJson !== tsJson) {
			failed = true;
			console.error(`✖ 不一致: ${key}`);
			console.error(`  Go: ${goJson}`);
			console.error(`  TS: ${tsJson}`);
		} else {
			console.log(`✔ 一致: ${key}`);
		}
	}

	if (failed) {
		throw new Error("Go/TS 对拍存在差异");
	}
	console.log("Go/TS 对拍全部通过");
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
