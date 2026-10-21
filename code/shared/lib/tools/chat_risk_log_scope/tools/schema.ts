/**
 * 两个 Agent 工具的 TypeBox 参数 Schema。
 */

import { Type, type Static } from "typebox";

const reasonMapSchema = Type.Optional(
	Type.Record(Type.String(), Type.String(), {
		description: "自定义 reason -> 风险类型标签映射，键为整数字符串",
	}),
);

export const analyzeFileParameters = Type.Object({
	source: Type.Object({
		kind: Type.Union([Type.Literal("file"), Type.Literal("inline")], {
			description: "file: 读取工作区内日志文件；inline: 直接分析传入内容",
		}),
		path: Type.Optional(
			Type.String({ description: "kind=file 时必填，必须位于工作区根目录内" }),
		),
		content: Type.Optional(
			Type.String({ description: "kind=inline 时必填，CSV 或 JSON 文本内容" }),
		),
		format: Type.Optional(
			Type.Union([Type.Literal("csv"), Type.Literal("json")], {
				description: "kind=inline 时必填；kind=file 时按文件扩展名推断",
			}),
		),
	}),
	options: Type.Optional(
		Type.Object({
			highConfidence: Type.Optional(
				Type.Number({ description: "高置信度阈值，默认 0.8" }),
			),
			lowConfidence: Type.Optional(
				Type.Number({ description: "低置信度阈值，默认 0.5" }),
			),
			repeatWindowMinutes: Type.Optional(
				Type.Number({ description: "重复违规时间窗口（分钟），默认 60" }),
			),
			topN: Type.Optional(
				Type.Integer({ description: "每类典型样本数量，默认 5" }),
			),
			noMask: Type.Optional(
				Type.Boolean({ description: "关闭账号脱敏，默认 false（仅本地演示用）" }),
			),
			messageMaxLength: Type.Optional(
				Type.Integer({ description: "报告中消息最大展示长度，默认 200；0 表示不截断" }),
			),
			reasonMap: reasonMapSchema,
		}),
	),
	incremental: Type.Optional(
		Type.Object({
			enabled: Type.Optional(
				Type.Boolean({ description: "启用游标式增量处理，默认 false" }),
			),
			stateFile: Type.Optional(
				Type.String({
					description: "状态文件路径（工作区内），默认 .cache/chat_risk_scope_state.json",
				}),
			),
			limit: Type.Optional(
				Type.Integer({ description: "本批最多处理条数，默认 100" }),
			),
		}),
	),
	output: Type.Optional(
		Type.Object({
			format: Type.Optional(
				Type.Union([Type.Literal("json"), Type.Literal("markdown")], {
					description: "返回给模型的 content 格式，默认 markdown",
				}),
			),
			writeReport: Type.Optional(
				Type.Boolean({
					description: "是否将报告写入工作区 reports/，默认 false",
				}),
			),
		}),
	),
});

export type AnalyzeFileToolParams = Static<typeof analyzeFileParameters>;

export const judgeMessageParameters = Type.Object({
	message: Type.String({ description: "需要判断的单条消息原文" }),
	reason: Type.Optional(
		Type.Integer({ description: "可选的原有判定 reason；与 confidence 同时提供时走原判定分支" }),
	),
	confidence: Type.Optional(
		Type.Number({ description: "可选的原有判定置信度（0~1）" }),
	),
	level: Type.Optional(Type.String({ description: "可选的原有判定等级" })),
	contextMessages: Type.Optional(
		Type.Array(Type.String(), { description: "可选的上下文消息" }),
	),
	account: Type.Optional(Type.String({ description: "可选账号，仅用于审计" })),
	nickname: Type.Optional(Type.String({ description: "可选昵称，仅用于审计" })),
	options: Type.Optional(
		Type.Object({
			highConfidence: Type.Optional(Type.Number({ description: "高置信度阈值，默认 0.8" })),
			lowConfidence: Type.Optional(Type.Number({ description: "低置信度阈值，默认 0.5" })),
			noMask: Type.Optional(
				Type.Boolean({ description: "关闭账号脱敏，默认 false（仅本地演示用）" }),
			),
			messageMaxLength: Type.Optional(
				Type.Integer({ description: "消息最大展示长度，默认 200；0 表示不截断" }),
			),
			reasonMap: reasonMapSchema,
		}),
	),
});

export type JudgeMessageToolParams = Static<typeof judgeMessageParameters>;

const suggestedActionSchema = Type.Union([
	Type.Literal("放行"),
	Type.Literal("观察"),
	Type.Literal("人工复核"),
	Type.Literal("禁言"),
	Type.Literal("封禁"),
	Type.Literal("加入黑名单"),
]);

export const fetchLogsParameters = Type.Object({
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 1000,
			description: "本次最多读取多少条日志，默认 50",
		}),
	),
	includeJudged: Type.Optional(
		Type.Boolean({
			description: "是否包含已有判断结果的日志，默认 false（只读未判断日志）",
		}),
	),
	createTimeFrom: Type.Optional(
		Type.String({ description: "可选：起始 create_time，格式 YYYY-MM-DD HH:mm:ss.SSS" }),
	),
	createTimeTo: Type.Optional(
		Type.String({ description: "可选：结束 create_time，格式 YYYY-MM-DD HH:mm:ss.SSS" }),
	),
});

export type FetchLogsToolParams = Static<typeof fetchLogsParameters>;

export const saveJudgementsParameters = Type.Object({
	judgements: Type.Array(
		Type.Object({
			log_id: Type.String({ description: "对应 chat_risk_logs.id" }),
			is_risk: Type.Boolean({ description: "是否判定为违规" }),
			reason: Type.Integer({ description: "风险类型编码，正常为 -1" }),
			label: Type.String({ description: "风险类型中文标签" }),
			confidence: Type.Number({
				minimum: 0,
				maximum: 1,
				description: "Agent 置信度 0~1",
			}),
			action: suggestedActionSchema,
			evidence: Type.Optional(
				Type.Array(Type.String(), { description: "支撑判断的原文片段" }),
			),
			agent_model: Type.Optional(
				Type.String({ description: "Agent 模型标识，例如 deepseek-v4.1-flash" }),
			),
			judged_at: Type.Optional(
				Type.String({ description: "判断时间；省略时使用当前时间" }),
			),
		}),
		{
			minItems: 1,
			maxItems: 1000,
			description: "Agent 对日志的独立判断结果",
		},
	),
});

export type SaveJudgementsToolParams = Static<typeof saveJudgementsParameters>;
