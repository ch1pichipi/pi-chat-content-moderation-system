/**
 * Markdown 报告渲染（README 功能 5）。
 *
 * 保持 Go 版本的 7 段结构：
 *  1. 本次日志概览
 *  2. 风险类型分布
 *  3. 重点账号列表
 *  4. 典型样本
 *  5. 疑似误杀样本
 *  6. 处置建议
 *  7. 后续优化建议
 */

import { maskAccount, truncate } from "../mask.ts";
import { formatDateTime } from "../loader/time.ts";
import type {
	AccountSummary,
	FalsePositiveItem,
	JudgementsSummary,
	RiskDistributionRow,
	Sample,
	Summary,
	SuggestedAction,
} from "../types.ts";
import { SUGGESTED_ACTIONS } from "../types.ts";

export interface ReportData {
	summary: Summary;
	riskDistribution: RiskDistributionRow[];
	accounts: AccountSummary[];
	samples: Sample[];
	falsePositives: FalsePositiveItem[];
	judgementsSummary: JudgementsSummary;
}

export interface ReportConfig {
	title: string;
	generatedAt: Date;
	inputFile: string;
	logCount: number;
	/** true 时对账号脱敏。 */
	masked: boolean;
	messageMaxLength: number;
	/** 增量模式报告序号；0 表示不显示。 */
	reportSeq?: number;
}

function maskIfNeeded(account: string, masked: boolean): string {
	return maskAccount(account, !masked);
}

function yesNo(value: boolean): string {
	return value ? "是" : "否";
}

/** 表格单元格转义：避免昵称/消息中的 | 或换行破坏 Markdown 表格。 */
function tableCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderReport(cfg: ReportConfig, data: ReportData): string {
	const seq = cfg.reportSeq && cfg.reportSeq > 0 ? cfg.reportSeq : 0;
	const lines: string[] = [];

	lines.push(`# ${cfg.title}${seq > 0 ? ` <${seq}>` : ""}`);
	lines.push("");
	lines.push(`**生成时间**: ${formatDateTime(cfg.generatedAt)}`);
	lines.push(`**输入文件**: ${cfg.inputFile}`);
	lines.push(`**日志总数**: ${cfg.logCount}`);
	if (seq > 0) lines.push(`**报告序号**: ${seq}`);
	lines.push("");
	lines.push("---");
	lines.push("");

	// 1. 本次日志概览
	const s = data.summary;
	const j = data.judgementsSummary;
	lines.push("## 1. 本次日志概览");
	lines.push("");
	lines.push("| 指标 | 数值 |");
	lines.push("|------|------|");
	lines.push(`| 总日志数 | ${s.totalCount} |`);
	lines.push(`| 风险日志数 | ${s.riskCount} |`);
	lines.push(`| 正常日志数 | ${s.normalCount} |`);
	lines.push(`| 高置信度风险 | ${s.highConfidenceRisk} |`);
	lines.push(`| 低置信度疑似误杀 | ${s.lowConfidenceSuspect} |`);
	lines.push(`| 涉及账号数 | ${s.accountCount} |`);
	lines.push(`| 涉及区服数 | ${s.areaServerCount} |`);
	lines.push("");
	lines.push("**AI 判断概览**:");
	lines.push(`- 总判断数: ${j.total}`);
	lines.push(`- 疑似误杀标记: ${j.falsePositiveCount}`);
	lines.push(`- 降级（规则判断）: ${j.degradedCount}`);
	lines.push("");
	lines.push("---");
	lines.push("");

	// 2. 风险类型分布
	lines.push("## 2. 风险类型分布");
	lines.push("");
	if (data.riskDistribution.length > 0) {
		lines.push("| reason | 风险类型 | 数量 | 占比 |");
		lines.push("|--------|---------|------|------|");
		for (const row of data.riskDistribution) {
			lines.push(
				`| ${row.reason} | ${tableCell(row.label)} | ${row.count} | ${(row.ratio * 100).toFixed(2)}% |`,
			);
		}
	} else {
		lines.push("_无风险日志_");
	}
	lines.push("");
	lines.push("---");
	lines.push("");

	// 3. 重点账号列表
	lines.push("## 3. 重点账号列表");
	lines.push("");
	if (data.accounts.length > 0) {
		lines.push(
			"| 账号 | 昵称 | 出现次数 | 主要风险类型 | 高风险消息数 | 疑似重复违规 | 推荐处理动作 |",
		);
		lines.push(
			"|------|------|---------|-------------|-------------|-------------|-------------|",
		);
		for (const account of data.accounts) {
			lines.push(
				`| ${tableCell(maskIfNeeded(account.account, cfg.masked))} | ${tableCell(account.nickname)} | ${account.count} | ${tableCell(account.mainReasonLabel)} | ${account.highRiskCount} | ${yesNo(account.suspectedRepeat)} | ${account.recommendedAction} |`,
			);
		}
	} else {
		lines.push("_无重点账号_");
	}
	lines.push("");
	lines.push("---");
	lines.push("");

	// 4. 典型样本
	lines.push("## 4. 典型样本");
	lines.push("");
	if (data.samples.length > 0) {
		for (const sample of data.samples) {
			lines.push(`### ${sample.purpose} - ${sample.reasonLabel}`);
			lines.push("");
			lines.push(`- **当前消息**: ${truncate(sample.currentMessage, cfg.messageMaxLength)}`);
			lines.push(`- **上下文摘要**: ${truncate(sample.contextSummary, cfg.messageMaxLength)}`);
			lines.push(`- **AI 判断理由**: ${sample.aiReason}`);
			lines.push("");
		}
	} else {
		lines.push("_无典型样本_");
	}
	lines.push("---");
	lines.push("");

	// 5. 疑似误杀样本
	lines.push("## 5. 疑似误杀样本");
	lines.push("");
	if (data.falsePositives.length > 0) {
		for (const item of data.falsePositives) {
			lines.push(
				`### 条目 ${item.entryId} - ${maskIfNeeded(item.account, cfg.masked)}`,
			);
			lines.push("");
			lines.push(`- **消息**: ${truncate(item.message, cfg.messageMaxLength)}`);
			lines.push(`- **原判定**: ${item.originalLabel} (置信度: ${item.confidence.toFixed(2)})`);
			lines.push(`- **AI 判断**: ${item.aiLabel}`);
			lines.push(`- **AI 理由**: ${item.aiReason}`);
			lines.push(`- **命中规则**: ${item.hits.join("; ")}`);
			lines.push("");
		}
	} else {
		lines.push("_无疑似误杀样本_");
	}
	lines.push("---");
	lines.push("");

	// 6. 处置建议
	lines.push("## 6. 处置建议");
	lines.push("");
	lines.push("基于 AI 判断结果的建议动作分布：");
	lines.push("");
	const actionRows = orderedActionCounts(j.actionCounts);
	if (actionRows.length > 0) {
		lines.push("| 建议动作 | 数量 |");
		lines.push("|---------|------|");
		for (const [action, count] of actionRows) {
			lines.push(`| ${action} | ${count} |`);
		}
	} else {
		lines.push("_无处置建议_");
	}
	lines.push("");
	lines.push("**执行建议**:");
	lines.push('1. 优先处理"加入黑名单"与"封禁"类账号（高风险）。');
	lines.push('2. 对"人工复核"类样本进行二次确认，补充训练数据或调整规则。');
	lines.push("3. 对疑似误杀样本进行人工抽查，优化模型判定阈值。");
	lines.push("");
	lines.push("---");
	lines.push("");

	// 7. 后续优化建议
	lines.push("## 7. 后续优化建议");
	lines.push("");
	lines.push("1. **规则优化**: 针对低置信度频繁出现的 reason 类型，补充关键词或上下文规则。");
	lines.push(`2. **模型训练**: 使用"模型训练样本"类别中的高置信度样本，增强训练集。`);
	lines.push(
		"3. **相似消息聚类**: 若发现批量广告或刷屏行为，可考虑后续版本启用相似消息聚类。",
	);
	lines.push(
		"4. **时间窗口调优**: 若重复违规误报较多，可调整 `options.repeatWindowMinutes` 阈值。",
	);
	lines.push("5. **判定策略迭代**: 根据本次误杀样本与人工复核结果，调整规则与关键词表。");
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push("**报告结束**");
	lines.push("");

	return lines.join("\n");
}

function orderedActionCounts(
	counts: Partial<Record<SuggestedAction, number>>,
): Array<[SuggestedAction, number]> {
	const rows: Array<[SuggestedAction, number]> = [];
	for (const action of SUGGESTED_ACTIONS) {
		const count = counts[action];
		if (count && count > 0) rows.push([action, count]);
	}
	// 数量降序；同数量时保持 SUGGESTED_ACTIONS 的固定顺序，保证可复现。
	rows.sort((a, b) => b[1] - a[1]);
	return rows;
}
