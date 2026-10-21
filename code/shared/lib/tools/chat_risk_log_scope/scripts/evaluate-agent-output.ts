/**
 * Agent 独立判断评测 CLI。
 *
 * 用法：
 *   npm run eval:chat-risk-agent -- <agent-output.jsonl>
 *
 * 可选参数：
 *   --ground-truth <path>  指定 ground truth JSON
 *   --out <path>           指定 Markdown 报告输出路径
 *   --json <path>          额外输出 JSON 指标
 *   --fail-under <0~1>     二分类/reason/动作准确率低于该值时返回非 0
 *
 * 默认报告目录：reports/agent_eval/
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	formatScoreReport,
	parseAgentOutput,
	parseGroundTruth,
	scoreAgentJudgements,
} from "../agent-eval/score.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");
const DEFAULT_GROUND_TRUTH = path.join(
	REPO_ROOT,
	"code/shared/lib/tools/chat_risk_log_scope/__fixtures__/agent-eval/ground-truth/agent_eval_20261020_100.labels.json",
);

interface CliOptions {
	predictionPath?: string;
	groundTruthPath: string;
	outPath?: string;
	jsonPath?: string;
	failUnder?: number;
}

function usage(): string {
	return [
		"用法: npm run eval:chat-risk-agent -- <agent-output.jsonl> [选项]",
		"",
		"选项:",
		"  --ground-truth <path>  ground truth JSON 路径",
		"  --out <path>           Markdown 报告输出路径",
		"  --json <path>          额外输出 JSON 指标",
		"  --fail-under <0~1>     准确率阈值",
	].join("\n");
}

function parseArgs(argv: readonly string[]): CliOptions {
	const options: CliOptions = { groundTruthPath: DEFAULT_GROUND_TRUTH };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			console.log(usage());
			process.exit(0);
		}
		if (!arg.startsWith("--")) {
			if (options.predictionPath) throw new Error(`多余的位置参数: ${arg}`);
			options.predictionPath = arg;
			continue;
		}

		const [key, inlineValue] = arg.slice(2).split("=", 2);
		const next = argv[index + 1];
		const value = inlineValue ?? (next && !next.startsWith("--") ? argv[++index] : undefined);
		if (value === undefined) throw new Error(`参数 --${key} 缺少值`);

		switch (key) {
			case "ground-truth":
				options.groundTruthPath = value;
				break;
			case "out":
				options.outPath = value;
				break;
			case "json":
				options.jsonPath = value;
				break;
			case "fail-under":
				options.failUnder = Number(value);
				if (!Number.isFinite(options.failUnder) || options.failUnder < 0 || options.failUnder > 1) {
					throw new Error("--fail-under 必须在 0~1 之间");
				}
				break;
			default:
				throw new Error(`未知参数: --${key}`);
		}
	}
	if (!options.predictionPath) throw new Error("缺少 Agent 输出文件路径");
	return options;
}

function timestamp(): string {
	const date = new Date();
	const pad = (value: number, length = 2) => String(value).padStart(length, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"_",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const predictionPath = path.resolve(process.cwd(), options.predictionPath!);
	const groundTruthPath = path.resolve(process.cwd(), options.groundTruthPath);

	const [predictionText, groundTruthText] = await Promise.all([
		readFile(predictionPath, "utf8"),
		readFile(groundTruthPath, "utf8"),
	]);
	const groundTruth = parseGroundTruth(groundTruthText);
	const predictions = parseAgentOutput(predictionText);
	const report = scoreAgentJudgements(groundTruth.dataset, groundTruth.labels, predictions);
	const markdown = formatScoreReport(report);

	const outPath = options.outPath
		? path.resolve(process.cwd(), options.outPath)
		: path.join(process.cwd(), "reports/agent_eval", `agent_eval_${timestamp()}.md`);
	await mkdir(path.dirname(outPath), { recursive: true });
	await writeFile(outPath, markdown, "utf8");

	if (options.jsonPath) {
		const jsonPath = path.resolve(process.cwd(), options.jsonPath);
		await mkdir(path.dirname(jsonPath), { recursive: true });
		await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	}

	console.log(markdown);
	console.log(`报告已写入: ${path.relative(process.cwd(), outPath)}`);

	let failed = false;
	if (report.missingIds.length > 0 || report.extraIds.length > 0) {
		console.error(
			`数据不完整：缺失 ${report.missingIds.length} 条，多余 ${report.extraIds.length} 条`,
		);
		failed = true;
	}
	if (options.failUnder !== undefined) {
		const below = [
			["二分类", report.binary.accuracy],
			["reason", report.reason.accuracy],
			["动作", report.action.accuracy],
		].filter(([, value]) => (value as number) < options.failUnder!);
		if (below.length > 0) {
			console.error(
				`低于阈值 ${options.failUnder}: ${below
					.map(([name, value]) => `${name}=${((value as number) * 100).toFixed(2)}%`)
					.join(", ")}`,
			);
			failed = true;
		}
	}
	if (failed) process.exitCode = 1;
}

main().catch((error) => {
	console.error(`评测失败: ${(error as Error).message}`);
	console.error(usage());
	process.exitCode = 1;
});
