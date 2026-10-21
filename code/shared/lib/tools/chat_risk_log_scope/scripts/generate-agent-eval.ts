/**
 * 从已标注的 100 条回归数据生成 Agent 盲测集与 ground truth。
 *
 * 盲测集只保留聊天内容与上下文，不包含 reason / confidence / label / prediction
 * 等任何判定字段，避免 Agent 直接复述标签。
 *
 * 运行：
 *   npm run generate:chat-risk-agent-eval
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { severeAction } from "../risk-map.ts";
import type { SuggestedAction } from "../types.ts";

type Difficulty = "easy" | "medium" | "hard";

interface LabeledEntry {
	id: string;
	account: string;
	nickname: string;
	area_id: string;
	area_name: string;
	server_id: string;
	context_messages: string[] | null;
	current_message: string;
	context_type: string;
	reason: number;
	confidence: number;
	create_time: string;
}

interface BlindEntry {
	id: string;
	account: string;
	nickname: string;
	area_id: string;
	area_name: string;
	server_id: string;
	context_messages: string[];
	current_message: string;
	context_type: string;
	create_time: string;
}

interface GroundTruthLabel {
	id: string;
	expected_risk: boolean;
	expected_reason: number;
	expected_label: string;
	expected_action: SuggestedAction;
	difficulty: Difficulty;
	note: string;
}

const LABELS: Record<number, string> = {
	[-1]: "正常",
	0: "其他违禁",
	1: "政治宗教",
	2: "色情低俗",
	3: "侮辱谩骂",
	4: "暴恐犯罪",
	5: "广告诈骗",
	6: "运营规避",
	7: "特殊字符",
	127: "渠道禁止",
	[-128]: "访问屏蔽",
};

function labelOf(reason: number): string {
	return LABELS[reason] ?? "未知类型";
}

function difficultyOf(reason: number, confidence: number): Difficulty {
	if (reason === -1) return "easy";
	if (confidence < 0.5) return "hard";
	if (confidence < 0.8) return "medium";
	return "easy";
}

function expectedActionOf(reason: number, confidence: number): SuggestedAction {
	if (reason === -1) return "放行";
	if (confidence < 0.5) return "人工复核";
	if (confidence >= 0.8) return severeAction(reason);
	return "观察";
}

function noteOf(reason: number, confidence: number, hasContext: boolean): string {
	const contextNote = hasContext ? "，含上下文" : "";
	if (reason === -1) return `正常对话${contextNote}`;
	const label = labelOf(reason);
	if (confidence < 0.5) return `${label}，低置信度，适合考察误杀判断${contextNote}`;
	if (confidence < 0.8) return `${label}，中置信度，需要结合上下文判断${contextNote}`;
	return `${label}，高置信度，适合考察明确风险识别${contextNote}`;
}

function toBlindEntry(entry: LabeledEntry, accountAlias: string): BlindEntry {
	return {
		id: entry.id,
		account: accountAlias,
		nickname: entry.nickname,
		area_id: entry.area_id,
		area_name: entry.area_name,
		server_id: entry.server_id,
		context_messages: entry.context_messages ?? [],
		current_message: entry.current_message,
		context_type: entry.context_type,
		create_time: entry.create_time,
	};
}

function toGroundTruth(entry: LabeledEntry): GroundTruthLabel {
	const expectedRisk = entry.reason !== -1;
	return {
		id: entry.id,
		expected_risk: expectedRisk,
		expected_reason: entry.reason,
		expected_label: labelOf(entry.reason),
		expected_action: expectedActionOf(entry.reason, entry.confidence),
		difficulty: difficultyOf(entry.reason, entry.confidence),
		note: noteOf(entry.reason, entry.confidence, (entry.context_messages?.length ?? 0) > 0),
	};
}

async function main(): Promise<void> {
	const root = process.cwd();
	const fixtureRoot = path.join(
		root,
		"code/shared/lib/tools/chat_risk_log_scope/__fixtures__",
	);
	const sourcePath = path.join(
		fixtureRoot,
		"logs/real/chat_risk_real_20261020_100.json",
	);
	const evalRoot = path.join(fixtureRoot, "agent-eval");
	const blindDir = path.join(evalRoot, "blind");
	const groundTruthDir = path.join(evalRoot, "ground-truth");
	await mkdir(blindDir, { recursive: true });
	await mkdir(groundTruthDir, { recursive: true });

	const labeled = JSON.parse(await readFile(sourcePath, "utf8")) as LabeledEntry[];
	if (labeled.length !== 100) {
		throw new Error(`源数据应为 100 条，实际为 ${labeled.length} 条`);
	}

	// 使用稳定的账号别名，避免脱敏后不同账号碰撞，同时保证同一账号可聚合分析。
	const accountAliases = new Map<string, string>();
	for (const entry of labeled) {
		if (!accountAliases.has(entry.account)) {
			accountAliases.set(entry.account, `account_${String(accountAliases.size + 1).padStart(2, "0")}`);
		}
	}

	const blind = labeled.map((entry) => toBlindEntry(entry, accountAliases.get(entry.account)!));
	const labels = labeled.map(toGroundTruth);

	const dataset = "agent_eval_20261020_100";
	const blindPath = path.join(blindDir, `${dataset}.jsonl`);
	const groundTruthPath = path.join(groundTruthDir, `${dataset}.labels.json`);

	await writeFile(
		blindPath,
		`${blind.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
	await writeFile(
		groundTruthPath,
		`${JSON.stringify(
			{
				dataset,
				description:
					"盲测日志的 ground truth，仅用于评分；运行 Agent 时不得提供此文件或所在目录。",
				labels,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const accountCount = new Set(blind.map((entry) => entry.account)).size;
	console.log(`已生成盲测集：${blind.length} 条，账号数 ${accountCount}`);
	console.log(`盲测输入：${path.relative(root, blindPath)}`);
	console.log(`标准答案：${path.relative(root, groundTruthPath)}`);
}

await main();
