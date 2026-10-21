/**
 * Agent 工具：chat_risk_log_scope_fetch_logs
 * 从 MySQL 读取未判断的聊天日志，返回盲测格式，不包含任何判定字段。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";

import { describeDb, getDbPool, loadDbConfig } from "../db/client.ts";
import { countUnjudgedLogs, fetchLogs } from "../db/logs.ts";
import type { BlindLogRecord } from "../db/types.ts";
import { fetchLogsParameters } from "./schema.ts";

export interface FetchLogsToolDetails {
	logs: BlindLogRecord[];
	count: number;
	unjudgedCount: number;
	db: string;
	error?: string;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const fetchLogsTool = defineTool<typeof fetchLogsParameters, FetchLogsToolDetails>({
	name: "chat_risk_log_scope_fetch_logs",
	label: "读取待判断聊天日志",
	description:
		"从数据库读取待 Agent 独立判断的聊天日志。默认只返回尚未写入判断结果的记录；返回内容不包含 reason、confidence、label、prediction 等任何标签字段。",
	promptSnippet: "从数据库读取待判断的聊天日志（无标签）",
	promptGuidelines: [
		"需要从数据库获取真实聊天日志时使用本工具，而不是读取文件。",
		"返回结果只有聊天内容和上下文；必须由你独立判断，不要假设已有标签。",
		"判断完成后使用 chat_risk_log_scope_save_judgements 写回数据库。",
	],
	parameters: fetchLogsParameters,
	annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		try {
			if (signal?.aborted) throw new Error("操作已取消");
			const config = loadDbConfig();
			const pool = getDbPool();
			const limit = params.limit ?? 50;
			const logs = await fetchLogs(pool, {
				limit,
				includeJudged: params.includeJudged === true,
				createTimeFrom: params.createTimeFrom,
				createTimeTo: params.createTimeTo,
			});
			const unjudgedCount = await countUnjudgedLogs(pool);
			const details: FetchLogsToolDetails = {
				logs,
				count: logs.length,
				unjudgedCount,
				db: describeDb(config),
			};
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								count: details.count,
								unjudgedCount: details.unjudgedCount,
								logs: details.logs,
							},
							null,
							2,
						),
					},
				],
				details,
			};
		} catch (error) {
			const message = toErrorMessage(error);
			return {
				content: [{ type: "text" as const, text: `读取日志失败: ${message}` }],
				details: {
					logs: [],
					count: 0,
					unjudgedCount: 0,
					db: "",
					error: message,
				},
				isError: true,
			};
		}
	},
});
