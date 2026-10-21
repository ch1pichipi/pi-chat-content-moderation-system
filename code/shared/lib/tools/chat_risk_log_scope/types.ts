/**
 * 聊天风险日志分析工具的核心数据结构。
 *
 * 输入侧字段名保持与 Go 版本（及业务日志）一致：CSV/JSON 使用 snake_case，
 * 内存中使用 camelCase；loader 负责两者之间的容错转换。
 */

/** 建议动作，取值与 Go 版本 README 规定的六类完全一致。 */
export const SUGGESTED_ACTIONS = ["放行", "观察", "人工复核", "禁言", "封禁", "加入黑名单"] as const;
export type SuggestedAction = (typeof SUGGESTED_ACTIONS)[number];

/** 单条聊天风险日志。 */
export interface LogEntry {
	id: string;
	requestId: string;
	account: string;
	appId: string;
	areaId: string;
	areaName: string;
	serverId: string;
	nickname: string;
	contextMessages: string[];
	currentMessage: string;
	judgeResult: string;
	contextType: string;
	reason: number;
	confidence: number;
	level: string;
	label: string;
	prediction: string;
	reviewedAt: string;
	forbidConsidered: boolean;
	forbidDeduped: boolean;

	/** 由 reviewedAt 解析得到；解析失败为 null，不影响主流程。 */
	reviewedTime: Date | null;
	/** 消息创建时间（通常为毫秒精度），增量读取使用。 */
	createTime: Date | null;
	/** create_time 的原始字符串。 */
	createTimeStr: string;

	/** 解析阶段的容错告警，不中断流程，仅用于审计与排查。 */
	warnings: string[];
}

/** reason !== -1 视为风险日志，与 Go 版本 model.LogEntry.IsRisk 一致。 */
export function isRisk(entry: Pick<LogEntry, "reason">): boolean {
	return entry.reason !== -1;
}

/** Mock / AI 针对一条日志的判断结果。 */
export interface AIJudgement {
	entryId: string;
	aiLabel: string;
	aiReason: string;
	isFalsePositive: boolean;
	suggestedAction: SuggestedAction;
	/** true 表示由降级（规则/Mock）产生，而非真实大模型调用。 */
	degraded: boolean;
	/** 命中的疑似误杀规则说明。 */
	falsePositiveHits?: string[];
	/** 单条消息关键词判断命中的关键词。 */
	matchedKeywords?: string[];
	/** 单条消息关键词判断推断出的 reason。 */
	inferredReason?: number;
	/** 单条消息关键词判断推断出的置信度。 */
	inferredConfidence?: number;
}

/** 汇总统计（对应 README 功能 1）。 */
export interface Summary {
	totalCount: number;
	riskCount: number;
	normalCount: number;
	reasonCounts: Record<number, number>;
	reasonRatios: Record<number, number>;
	highConfidenceRisk: number;
	lowConfidenceSuspect: number;
	accountCount: number;
	areaServerCount: number;
}

/** 按账号聚合后的重点账号统计。 */
export interface AccountSummary {
	account: string;
	nickname: string;
	count: number;
	mainReason: number;
	mainReasonLabel: string;
	highRiskCount: number;
	suspectedRepeat: boolean;
	recommendedAction: SuggestedAction;
}

/** 从风险日志中挑选出的典型样本。 */
export interface Sample {
	reasonLabel: string;
	currentMessage: string;
	contextSummary: string;
	aiReason: string;
	/** 推荐用途：模型训练样本/误杀排查样本/规则优化样本/人工复核样本/运营处置样本。 */
	purpose: string;
}

/** 疑似误杀样本的结构化表示。 */
export interface FalsePositiveItem {
	entryId: string;
	account: string;
	message: string;
	originalLabel: string;
	confidence: number;
	aiLabel: string;
	aiReason: string;
	hits: string[];
}

/** AI 判断结果汇总。 */
export interface JudgementsSummary {
	total: number;
	degradedCount: number;
	falsePositiveCount: number;
	actionCounts: Partial<Record<SuggestedAction, number>>;
}

/** 报告使用的风险分布行。 */
export interface RiskDistributionRow {
	reason: number;
	label: string;
	count: number;
	ratio: number;
}

/** analyzeFile 的结构化返回值。 */
export interface AnalysisResult {
	summary: Summary;
	riskDistribution: RiskDistributionRow[];
	accounts: AccountSummary[];
	samples: Sample[];
	falsePositives: FalsePositiveItem[];
	judgementsSummary: JudgementsSummary;
	warnings: string[];
	meta: {
		source: string;
		totalEntries: number;
		processedEntries: number;
		masked: boolean;
		judgeMode: "mock";
		reportPath?: string;
		elapsedMs: number;
		reportMarkdown: string;
		incremental?: {
			enabled: true;
			lastTimeBefore: string | null;
			lastTimeAfter: string | null;
			limit: number;
			hasMore: boolean;
		};
	};
}

/** 单条消息判断（judgeMessage）的返回值。 */
export interface JudgeMessageResult {
	judgement: AIJudgement;
	original: {
		reason: number | null;
		confidence: number | null;
		level: string;
		reasonLabel: string;
	};
	warnings: string[];
	meta: {
		judgeMode: "mock";
		masked: boolean;
		elapsedMs: number;
	};
}
