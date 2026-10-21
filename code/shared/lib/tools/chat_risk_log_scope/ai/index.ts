/**
 * AI 辅助判断统一接口（v2 扩展点）。
 *
 * v1 只提供 MockJudge（规则判断），不发起任何网络请求；
 * v2 接入 Claude 等真实模型时实现同一接口即可。
 */

import type { AIJudgement, LogEntry } from "../types.ts";

export interface Judge {
	/** 对一批日志条目生成判断结果，顺序与输入一致。 */
	judgeBatch(entries: readonly LogEntry[], signal?: AbortSignal): Promise<AIJudgement[]>;
}

export type JudgeMode = "mock";
