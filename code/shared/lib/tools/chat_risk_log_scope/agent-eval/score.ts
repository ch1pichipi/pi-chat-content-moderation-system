/**
 * Agent 独立判断评测的解析与评分逻辑。
 *
 * 该模块只做纯计算：
 * - 解析 ground truth 与 Agent 输出。
 * - 计算二分类、reason 分类、处置动作、难度分组、置信度校准指标。
 * - 生成 Markdown 报告。
 */

import { DEFAULT_REASON_MAP } from "../risk-map.ts";
import { SUGGESTED_ACTIONS, type SuggestedAction } from "../types.ts";

export type Difficulty = "easy" | "medium" | "hard";

export interface GroundTruthLabel {
	id: string;
	expectedRisk: boolean;
	expectedReason: number;
	expectedLabel: string;
	expectedAction: SuggestedAction;
	difficulty: Difficulty;
	note?: string;
}

export interface GroundTruthFile {
	dataset: string;
	description?: string;
	labels: GroundTruthLabel[];
}

export interface AgentPrediction {
	id: string;
	isRisk: boolean;
	reason: number;
	label: string;
	confidence: number | null;
	action: string;
	evidence: string[];
}

export interface BinaryMetrics {
	total: number;
	matched: number;
	coverage: number;
	accuracy: number;
	precision: number;
	recall: number;
	f1: number;
	tp: number;
	fp: number;
	tn: number;
	fn: number;
	falsePositiveRate: number;
	falseNegativeRate: number;
}

export interface ClassMetric {
	key: string;
	label: string;
	support: number;
	predicted: number;
	correct: number;
	precision: number;
	recall: number;
	f1: number;
}

export interface ClassificationReport {
	accuracy: number;
	macroF1: number;
	classes: ClassMetric[];
	confusion: Record<string, Record<string, number>>;
}

export interface ActionReport {
	accuracy: number;
	classes: ClassMetric[];
}

export interface DifficultyReport {
	difficulty: Difficulty;
	total: number;
	matched: number;
	binaryAccuracy: number;
	reasonAccuracy: number;
	actionAccuracy: number;
}

export interface ConfidenceReport {
	count: number;
	averageConfidence: number;
	brierScore: number;
}

export interface ScoreReport {
	dataset: string;
	totalGroundTruth: number;
	totalPredictions: number;
	matched: number;
	missingIds: string[];
	extraIds: string[];
	binary: BinaryMetrics;
	reason: ClassificationReport;
	action: ActionReport;
	difficulty: DifficultyReport[];
	confidence: ConfidenceReport | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
	}
	return undefined;
}

function toNumber(value: unknown, field: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
		return Number(value);
	}
	throw new Error(`${field} 必须是数字`);
}

function toStringValue(value: unknown, field: string): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	throw new Error(`${field} 必须是字符串`);
}

function toBoolean(value: unknown, field: string): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	if (typeof value === "number") return value !== 0;
	throw new Error(`${field} 必须是布尔值`);
}

function isSuggestedAction(value: string): value is SuggestedAction {
	return (SUGGESTED_ACTIONS as readonly string[]).includes(value);
}

function reasonLabel(reason: number): string {
	return DEFAULT_REASON_MAP[reason] ?? "未知类型";
}

function normalizeGroundTruthLabel(record: unknown, index: number): GroundTruthLabel {
	if (!isRecord(record)) throw new Error(`ground truth 第 ${index + 1} 条不是对象`);
	const id = toStringValue(pick(record, ["id", "entry_id"]), `ground truth 第 ${index + 1} 条 id`);
	const reason = toNumber(
		pick(record, ["expected_reason", "expectedReason", "reason"]),
		`ground truth ${id} expected_reason`,
	);
	const riskRaw = pick(record, ["expected_risk", "expectedRisk", "is_risk", "isRisk"]);
	const expectedRisk = riskRaw === undefined ? reason !== -1 : toBoolean(riskRaw, `ground truth ${id} expected_risk`);
	const labelRaw = pick(record, ["expected_label", "expectedLabel", "label"]);
	const expectedLabel = labelRaw === undefined ? reasonLabel(reason) : toStringValue(labelRaw, `ground truth ${id} expected_label`);
	const actionRaw = toStringValue(
		pick(record, ["expected_action", "expectedAction", "action"]),
		`ground truth ${id} expected_action`,
	);
	if (!isSuggestedAction(actionRaw)) {
		throw new Error(`ground truth ${id} expected_action 非法: ${actionRaw}`);
	}
	const difficultyRaw = pick(record, ["difficulty"]);
	const difficulty = difficultyRaw === undefined ? "medium" : toStringValue(difficultyRaw, `ground truth ${id} difficulty`);
	if (difficulty !== "easy" && difficulty !== "medium" && difficulty !== "hard") {
		throw new Error(`ground truth ${id} difficulty 必须是 easy/medium/hard`);
	}
	const noteRaw = pick(record, ["note"]);
	return {
		id,
		expectedRisk,
		expectedReason: reason,
		expectedLabel,
		expectedAction: actionRaw,
		difficulty,
		note: noteRaw === undefined ? undefined : toStringValue(noteRaw, `ground truth ${id} note`),
	};
}

/** 解析 ground truth JSON（数组或 { labels: [...] }）。 */
export function parseGroundTruth(text: string): { dataset: string; labels: GroundTruthLabel[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`ground truth JSON 解析失败: ${(error as Error).message}`);
	}

	let dataset = "unknown";
	let rawLabels: unknown;
	if (Array.isArray(parsed)) {
		rawLabels = parsed;
	} else if (isRecord(parsed)) {
		dataset = typeof parsed.dataset === "string" ? parsed.dataset : dataset;
		rawLabels = parsed.labels;
	} else {
		throw new Error("ground truth 必须是数组或 { labels: [...] } 对象");
	}
	if (!Array.isArray(rawLabels)) throw new Error("ground truth 缺少 labels 数组");

	const labels = rawLabels.map((item, index) => normalizeGroundTruthLabel(item, index));
	const seen = new Set<string>();
	for (const label of labels) {
		if (seen.has(label.id)) throw new Error(`ground truth 存在重复 id: ${label.id}`);
		seen.add(label.id);
	}
	return { dataset, labels };
}

function normalizePrediction(record: unknown, index: number): AgentPrediction {
	if (!isRecord(record)) throw new Error(`预测结果第 ${index + 1} 条不是对象`);
	const id = toStringValue(pick(record, ["id", "entry_id"]), `预测结果第 ${index + 1} 条 id`);
	const reason = toNumber(pick(record, ["reason", "ai_reason_code"]), `预测 ${id} reason`);
	const riskRaw = pick(record, ["is_risk", "isRisk", "risk"]);
	const isRisk = riskRaw === undefined ? reason !== -1 : toBoolean(riskRaw, `预测 ${id} is_risk`);
	const labelRaw = pick(record, ["label", "ai_label", "aiLabel"]);
	const label = labelRaw === undefined ? reasonLabel(reason) : toStringValue(labelRaw, `预测 ${id} label`);
	const action = toStringValue(
		pick(record, ["action", "suggested_action", "suggestedAction"]),
		`预测 ${id} action`,
	);
	const confidenceRaw = pick(record, ["confidence", "score"]);
	let confidence: number | null = null;
	if (confidenceRaw !== undefined && confidenceRaw !== null) {
		confidence = toNumber(confidenceRaw, `预测 ${id} confidence`);
		if (confidence < 0 || confidence > 1) {
			throw new Error(`预测 ${id} confidence 必须在 0~1 之间`);
		}
	}
	const evidenceRaw = pick(record, ["evidence", "matched_keywords"]);
	let evidence: string[] = [];
	if (Array.isArray(evidenceRaw)) {
		evidence = evidenceRaw.map((item, evidenceIndex) =>
			toStringValue(item, `预测 ${id} evidence[${evidenceIndex}]`),
		);
	} else if (typeof evidenceRaw === "string") {
		evidence = [evidenceRaw];
	}
	return { id, isRisk, reason, label, confidence, action, evidence };
}

function parseJsonLines(text: string): unknown[] {
	const records: unknown[] = [];
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line === "" || line.startsWith("```")) continue;
		try {
			records.push(JSON.parse(line));
		} catch (error) {
			throw new Error(`Agent 输出第 ${index + 1} 行 JSON 解析失败: ${(error as Error).message}`);
		}
	}
	return records;
}

/** 解析 Agent 输出，支持 JSON 数组、{ results: [...] } 或 JSONL。 */
export function parseAgentOutput(text: string): AgentPrediction[] {
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (trimmed === "") throw new Error("Agent 输出为空");

	let rawRecords: unknown[];
	if (trimmed.startsWith("[")) {
		const parsed: unknown = JSON.parse(trimmed);
		if (!Array.isArray(parsed)) throw new Error("Agent 输出不是数组");
		rawRecords = parsed;
	} else if (trimmed.startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// 首字符为 { 但整体不是单个 JSON，可能是 JSONL。
			parsed = undefined;
		}
		if (parsed === undefined) {
			rawRecords = parseJsonLines(trimmed);
		} else if (isRecord(parsed) && Array.isArray(pick(parsed, ["results", "predictions"]))) {
			rawRecords = pick(parsed, ["results", "predictions"]) as unknown[];
		} else if (isRecord(parsed) && pick(parsed, ["id", "entry_id"]) !== undefined) {
			rawRecords = [parsed];
		} else {
			throw new Error("Agent 输出对象缺少 id，且不是 { results: [...] } 格式");
		}
	} else {
		rawRecords = parseJsonLines(trimmed);
	}

	const predictions = rawRecords.map((item, index) => normalizePrediction(item, index));
	const seen = new Set<string>();
	for (const prediction of predictions) {
		if (seen.has(prediction.id)) throw new Error(`Agent 输出存在重复 id: ${prediction.id}`);
		seen.add(prediction.id);
	}
	return predictions;
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function perClassMetrics(
	groundTruth: readonly GroundTruthLabel[],
	predictions: ReadonlyMap<string, AgentPrediction>,
	keyOfExpected: (label: GroundTruthLabel) => string,
	keyOfPredicted: (prediction: AgentPrediction) => string,
	labelOf: (key: string) => string,
): ClassMetric[] {
	const expectedCounts = new Map<string, number>();
	const truePositive = new Map<string, number>();
	const falsePositive = new Map<string, number>();
	const predictedCounts = new Map<string, number>();

	for (const label of groundTruth) {
		const expectedKey = keyOfExpected(label);
		expectedCounts.set(expectedKey, (expectedCounts.get(expectedKey) ?? 0) + 1);

		const prediction = predictions.get(label.id);
		if (!prediction) continue;
		const predictedKey = keyOfPredicted(prediction);
		predictedCounts.set(predictedKey, (predictedCounts.get(predictedKey) ?? 0) + 1);
		if (predictedKey === expectedKey) {
			truePositive.set(expectedKey, (truePositive.get(expectedKey) ?? 0) + 1);
		} else {
			falsePositive.set(predictedKey, (falsePositive.get(predictedKey) ?? 0) + 1);
		}
	}

	const keys = new Set([...expectedCounts.keys(), ...predictedCounts.keys()]);
	return [...keys]
		.sort((a, b) => {
			const supportDiff = (expectedCounts.get(b) ?? 0) - (expectedCounts.get(a) ?? 0);
			return supportDiff !== 0 ? supportDiff : a.localeCompare(b);
		})
		.map((key) => {
			const support = expectedCounts.get(key) ?? 0;
			const tp = truePositive.get(key) ?? 0;
			const fp = falsePositive.get(key) ?? 0;
			const precision = ratio(tp, tp + fp);
			const recall = ratio(tp, support);
			const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
			return {
				key,
				label: labelOf(key),
				support,
				predicted: predictedCounts.get(key) ?? 0,
				correct: tp,
				precision,
				recall,
				f1,
			};
		});
}

function buildConfusion(
	groundTruth: readonly GroundTruthLabel[],
	predictions: ReadonlyMap<string, AgentPrediction>,
	keyOfExpected: (label: GroundTruthLabel) => string,
	keyOfPredicted: (prediction: AgentPrediction) => string,
): Record<string, Record<string, number>> {
	const confusion: Record<string, Record<string, number>> = {};
	for (const label of groundTruth) {
		const expectedKey = keyOfExpected(label);
		const prediction = predictions.get(label.id);
		const predictedKey = prediction ? keyOfPredicted(prediction) : "MISSING";
		const row = (confusion[expectedKey] ??= {});
		row[predictedKey] = (row[predictedKey] ?? 0) + 1;
	}
	return confusion;
}

/** 计算 Agent 输出与 ground truth 的一致性指标。 */
export function scoreAgentJudgements(
	dataset: string,
	groundTruth: readonly GroundTruthLabel[],
	predictions: readonly AgentPrediction[],
): ScoreReport {
	const predictionMap = new Map<string, AgentPrediction>();
	for (const prediction of predictions) predictionMap.set(prediction.id, prediction);

	const groundTruthIds = new Set(groundTruth.map((label) => label.id));
	const missingIds = groundTruth.filter((label) => !predictionMap.has(label.id)).map((label) => label.id);
	const extraIds = predictions.filter((prediction) => !groundTruthIds.has(prediction.id)).map((prediction) => prediction.id);

	let matched = 0;
	let binaryCorrect = 0;
	let reasonCorrect = 0;
	let actionCorrect = 0;
	let tp = 0;
	let fp = 0;
	let tn = 0;
	let fn = 0;
	const difficultyAccumulator = new Map<
		Difficulty,
		{ total: number; matched: number; binaryCorrect: number; reasonCorrect: number; actionCorrect: number }
	>();
	const confidencePairs: Array<{ confidence: number; actual: number }> = [];

	for (const label of groundTruth) {
		const bucket = difficultyAccumulator.get(label.difficulty) ?? {
			total: 0,
			matched: 0,
			binaryCorrect: 0,
			reasonCorrect: 0,
			actionCorrect: 0,
		};
		bucket.total++;
		difficultyAccumulator.set(label.difficulty, bucket);

		const prediction = predictionMap.get(label.id);
		if (!prediction) {
			// 缺失预测在总准确率中按错误计，但不参与二分类混淆矩阵。
			continue;
		}
		matched++;
		bucket.matched++;
		if (prediction.isRisk === label.expectedRisk) {
			binaryCorrect++;
			bucket.binaryCorrect++;
		}
		if (prediction.reason === label.expectedReason) {
			reasonCorrect++;
			bucket.reasonCorrect++;
		}
		if (prediction.action === label.expectedAction) {
			actionCorrect++;
			bucket.actionCorrect++;
		}

		if (label.expectedRisk && prediction.isRisk) tp++;
		else if (!label.expectedRisk && prediction.isRisk) fp++;
		else if (!label.expectedRisk && !prediction.isRisk) tn++;
		else fn++;

		if (prediction.confidence !== null) {
			confidencePairs.push({
				confidence: prediction.confidence,
				actual: label.expectedRisk ? 1 : 0,
			});
		}
	}

	const precision = ratio(tp, tp + fp);
	const recall = ratio(tp, tp + fn);
	const binaryF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
	const binary: BinaryMetrics = {
		total: groundTruth.length,
		matched,
		coverage: ratio(matched, groundTruth.length),
		accuracy: ratio(binaryCorrect, groundTruth.length),
		precision,
		recall,
		f1: binaryF1,
		tp,
		fp,
		tn,
		fn,
		falsePositiveRate: ratio(fp, fp + tn),
		falseNegativeRate: ratio(fn, fn + tp),
	};

	const reasonClasses = perClassMetrics(
		groundTruth,
		predictionMap,
		(label) => String(label.expectedReason),
		(prediction) => String(prediction.reason),
		(key) => (key === "MISSING" ? "缺失" : reasonLabel(Number(key))),
	);
	const reasonMacroF1 = ratio(
		reasonClasses.reduce((sum, item) => sum + item.f1, 0),
		reasonClasses.filter((item) => item.support > 0).length,
	);
	const reason: ClassificationReport = {
		accuracy: ratio(reasonCorrect, groundTruth.length),
		macroF1: reasonMacroF1,
		classes: reasonClasses,
		confusion: buildConfusion(
			groundTruth,
			predictionMap,
			(label) => String(label.expectedReason),
			(prediction) => String(prediction.reason),
		),
	};

	const actionClasses = perClassMetrics(
		groundTruth,
		predictionMap,
		(label) => label.expectedAction,
		(prediction) => prediction.action,
		(key) => (key === "MISSING" ? "缺失" : key),
	);
	const action: ActionReport = {
		accuracy: ratio(actionCorrect, groundTruth.length),
		classes: actionClasses,
	};

	const difficulty: DifficultyReport[] = (["easy", "medium", "hard"] as const).map((key) => {
		const bucket = difficultyAccumulator.get(key) ?? {
			total: 0,
			matched: 0,
			binaryCorrect: 0,
			reasonCorrect: 0,
			actionCorrect: 0,
		};
		return {
			difficulty: key,
			total: bucket.total,
			matched: bucket.matched,
			binaryAccuracy: ratio(bucket.binaryCorrect, bucket.total),
			reasonAccuracy: ratio(bucket.reasonCorrect, bucket.total),
			actionAccuracy: ratio(bucket.actionCorrect, bucket.total),
		};
	});

	const confidence: ConfidenceReport | null =
		confidencePairs.length === 0
			? null
			: {
					count: confidencePairs.length,
					averageConfidence: ratio(
						confidencePairs.reduce((sum, item) => sum + item.confidence, 0),
						confidencePairs.length,
					),
					brierScore: ratio(
						confidencePairs.reduce(
							(sum, item) => sum + (item.confidence - item.actual) ** 2,
							0,
						),
						confidencePairs.length,
					),
				};

	return {
		dataset,
		totalGroundTruth: groundTruth.length,
		totalPredictions: predictions.length,
		matched,
		missingIds,
		extraIds,
		binary,
		reason,
		action,
		difficulty,
		confidence,
	};
}

function percent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** 生成便于人工阅读的 Markdown 评测报告。 */
export function formatScoreReport(report: ScoreReport): string {
	const lines: string[] = [];
	lines.push("# Agent 独立判断评测报告");
	lines.push("");
	lines.push(`- 数据集：${escapeCell(report.dataset)}`);
	lines.push(`- 标准答案数：${report.totalGroundTruth}`);
	lines.push(`- Agent 输出数：${report.totalPredictions}`);
	lines.push(`- 有效匹配数：${report.matched}`);
	lines.push(`- 覆盖率：${percent(report.binary.coverage)}`);
	lines.push("");
	lines.push("## 1. 二分类（是否违规）");
	lines.push("");
	lines.push("| 指标 | 值 |");
	lines.push("| --- | --- |");
	lines.push(`| 准确率 | ${percent(report.binary.accuracy)} |`);
	lines.push(`| Precision | ${percent(report.binary.precision)} |`);
	lines.push(`| Recall | ${percent(report.binary.recall)} |`);
	lines.push(`| F1 | ${percent(report.binary.f1)} |`);
	lines.push(`| TP / FP / TN / FN | ${report.binary.tp} / ${report.binary.fp} / ${report.binary.tn} / ${report.binary.fn} |`);
	lines.push(`| 误报率 FPR | ${percent(report.binary.falsePositiveRate)} |`);
	lines.push(`| 漏报率 FNR | ${percent(report.binary.falseNegativeRate)} |`);
	lines.push("");
	lines.push("## 2. reason 分类");
	lines.push("");
	lines.push(`- 准确率：${percent(report.reason.accuracy)}`);
	lines.push(`- Macro-F1：${percent(report.reason.macroF1)}`);
	lines.push("");
	lines.push("| reason | 标签 | 支持数 | 预测数 | 正确数 | Precision | Recall | F1 |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const item of report.reason.classes) {
		lines.push(
			`| ${escapeCell(item.key)} | ${escapeCell(item.label)} | ${item.support} | ${item.predicted} | ${item.correct} | ${percent(item.precision)} | ${percent(item.recall)} | ${percent(item.f1)} |`,
		);
	}
	lines.push("");
	lines.push("### 混淆矩阵");
	lines.push("");
	const expectedKeys = Object.keys(report.reason.confusion).sort((a, b) => Number(a) - Number(b));
	const predictedKeys = new Set<string>();
	for (const row of Object.values(report.reason.confusion)) {
		for (const key of Object.keys(row)) predictedKeys.add(key);
	}
	const predictedColumns = [...predictedKeys].sort((a, b) => {
		if (a === "MISSING") return 1;
		if (b === "MISSING") return -1;
		return Number(a) - Number(b);
	});
	lines.push(`| 期望 \\ 预测 | ${predictedColumns.map(escapeCell).join(" | ")} |`);
	lines.push(`| --- | ${predictedColumns.map(() => "---").join(" | ")} |`);
	for (const expected of expectedKeys) {
		const row = report.reason.confusion[expected] ?? {};
		lines.push(
			`| ${escapeCell(expected)} | ${predictedColumns.map((key) => row[key] ?? 0).join(" | ")} |`,
		);
	}
	lines.push("");
	lines.push("## 3. 处置动作");
	lines.push("");
	lines.push(`- 准确率：${percent(report.action.accuracy)}`);
	lines.push("");
	lines.push("| 动作 | 支持数 | 预测数 | 正确数 | Precision | Recall | F1 |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- |");
	for (const item of report.action.classes) {
		lines.push(
			`| ${escapeCell(item.label)} | ${item.support} | ${item.predicted} | ${item.correct} | ${percent(item.precision)} | ${percent(item.recall)} | ${percent(item.f1)} |`,
		);
	}
	lines.push("");
	lines.push("## 4. 难度分组");
	lines.push("");
	lines.push("| 难度 | 样本数 | 匹配数 | 二分类准确率 | reason 准确率 | 动作准确率 |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const item of report.difficulty) {
		lines.push(
			`| ${item.difficulty} | ${item.total} | ${item.matched} | ${percent(item.binaryAccuracy)} | ${percent(item.reasonAccuracy)} | ${percent(item.actionAccuracy)} |`,
		);
	}
	lines.push("");
	lines.push("## 5. 置信度");
	lines.push("");
	if (report.confidence) {
		lines.push(`- 提供置信度的条数：${report.confidence.count}`);
		lines.push(`- 平均置信度：${percent(report.confidence.averageConfidence)}`);
		lines.push(`- Brier Score：${report.confidence.brierScore.toFixed(4)}（越低越好）`);
	} else {
		lines.push("_Agent 输出未提供 confidence 字段_");
	}
	lines.push("");
	lines.push("## 6. 数据完整性");
	lines.push("");
	lines.push(`- 缺失预测：${report.missingIds.length} 条${report.missingIds.length ? `（${report.missingIds.slice(0, 20).join(", ")}${report.missingIds.length > 20 ? "..." : ""}）` : ""}`);
	lines.push(`- 多余预测：${report.extraIds.length} 条${report.extraIds.length ? `（${report.extraIds.slice(0, 20).join(", ")}${report.extraIds.length > 20 ? "..." : ""}）` : ""}`);
	lines.push("");
	lines.push("> 本报告只衡量 Agent 输出与 ground truth 的一致性，不代表线上真实效果。");
	lines.push("");
	return lines.join("\n");
}
