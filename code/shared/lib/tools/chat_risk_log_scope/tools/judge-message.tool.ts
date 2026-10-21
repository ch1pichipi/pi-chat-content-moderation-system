/**
 * Agent 工具：chat_risk_log_scope_judge_message
 * 只判断调用方输入的单条消息，不读取日志文件。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";

import { formatJudgeMessageContent, judgeMessage } from "../judge-message.ts";
import type { JudgeMessageResult } from "../types.ts";
import { judgeMessageParameters } from "./schema.ts";

export type JudgeMessageToolDetails = JudgeMessageResult | { error: string };

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const judgeMessageTool = defineTool<typeof judgeMessageParameters, JudgeMessageToolDetails>({
	name: "chat_risk_log_scope_judge_message",
	label: "聊天消息风险判断",
	description:
		"判断单条聊天消息是否存在风险。若调用方已有原系统判定信息（reason + confidence），走与原判定一致的分支；否则使用 Mock 关键词启发式推断风险类型、置信度与建议动作。不读日志、不写文件、不联网。",
	promptSnippet: "判断单条聊天消息的风险类型、置信度和建议处置动作",
	promptGuidelines: [
		"已有原系统 reason/confidence 时请一并传入，优先复用原判定分支，保证与整份日志分析一致。",
		"纯文本判断为关键词启发式（mock），结果只作辅助参考；低置信度或疑似场景应建议人工复核。",
		"不要在参数中传入与判断无关的 PII；工具不会把消息原文写入磁盘。",
	],
	parameters: judgeMessageParameters,
	annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
	executionMode: "parallel",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		try {
			const result = await judgeMessage({
				message: params.message,
				reason: params.reason,
				confidence: params.confidence,
				level: params.level,
				contextMessages: params.contextMessages,
				account: params.account,
				nickname: params.nickname,
				options: params.options,
				signal,
			});
			return {
				content: [{ type: "text" as const, text: formatJudgeMessageContent(result) }],
				details: result,
			};
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: `判断失败: ${toErrorMessage(error)}` }],
				details: { error: toErrorMessage(error) },
				isError: true,
			};
		}
	},
});
