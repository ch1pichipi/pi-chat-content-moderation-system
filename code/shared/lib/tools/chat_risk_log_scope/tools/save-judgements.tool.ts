/**
 * Agent 工具：chat_risk_log_scope_save_judgements
 * 将 Agent 独立判断结果写入 MySQL；同一 log_id 重复写入时更新。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";

import { getDbPool } from "../db/client.ts";
import { saveJudgements } from "../db/judgements.ts";
import type { AgentJudgementInput } from "../db/types.ts";
import { saveJudgementsParameters } from "./schema.ts";

export interface SaveJudgementsToolDetails {
	saved: number;
	affectedRows: number;
	savedLogIds: string[];
	error?: string;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const saveJudgementsTool = defineTool<
	typeof saveJudgementsParameters,
	SaveJudgementsToolDetails
>({
	name: "chat_risk_log_scope_save_judgements",
	label: "保存 Agent 判断结果",
	description:
		"把 Agent 对聊天日志的独立判断结果写入数据库。每个 log_id 只保留一条结果，重复提交会覆盖旧结果。写入前会校验动作、reason、置信度与 log_id。",
	promptSnippet: "将 Agent 自己的聊天风险判断结果写回数据库",
	promptGuidelines: [
		"只写入你自己做出的判断，不要复述已有标签或 Mock 规则输出。",
		"每条结果必须包含 log_id、is_risk、reason、label、confidence、action。",
		"confidence 必须在 0~1 之间；证据不足时应降低置信度并选择人工复核。",
	],
	parameters: saveJudgementsParameters,
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		try {
			if (signal?.aborted) throw new Error("操作已取消");
			const pool = getDbPool();
			const judgements: AgentJudgementInput[] = params.judgements.map((item) => ({
				log_id: item.log_id,
				is_risk: item.is_risk,
				reason: item.reason,
				label: item.label,
				confidence: item.confidence,
				action: item.action,
				evidence: item.evidence,
				agent_model: item.agent_model,
				judged_at: item.judged_at,
			}));
			const result = await saveJudgements(pool, judgements);
			const details: SaveJudgementsToolDetails = {
				saved: result.saved,
				affectedRows: result.affectedRows,
				savedLogIds: judgements.map((item) => item.log_id),
			};
			return {
				content: [
					{
						type: "text" as const,
						text: `已保存 ${details.saved} 条判断结果（数据库影响行数 ${details.affectedRows}）。`,
					},
				],
				details,
			};
		} catch (error) {
			const message = toErrorMessage(error);
			return {
				content: [{ type: "text" as const, text: `保存判断结果失败: ${message}` }],
				details: { saved: 0, affectedRows: 0, savedLogIds: [], error: message },
				isError: true,
			};
		}
	},
});
