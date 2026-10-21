/**
 * Mock Agent：完全离线、确定性的关键词判断。
 *
 * 用途：单元测试、前端联调、真实模型不可用时的降级。
 * 安全约束：置信度上限 0.75，确保降级路径不会被护栏放行到 1 天以上封禁。
 */

import { inferRiskFromKeywords } from "../../../shared/lib/tools/chat_risk_log_scope/ai/mock-keywords.ts";
import { DEFAULT_REASON_MAP } from "../../../shared/lib/tools/chat_risk_log_scope/risk-map.ts";
import type { Judge, JudgeResult } from "./judge.ts";
import type { AnalysisInput } from "./types.ts";

export const MOCK_MODEL_NAME = "mock-keywords";
export const MOCK_MAX_CONFIDENCE = 0.75;

export class MockAgentJudge implements Judge {
	async judge(input: AnalysisInput): Promise<JudgeResult> {
		const matches = input.recentMessages.map((message) => ({
			message,
			match: inferRiskFromKeywords(message.content),
		}));
		const risky = matches.filter((item) => item.match.reason !== -1);

		if (risky.length === 0) {
			return {
				verdict: {
					is_risk: false,
					reason: -1,
					label: DEFAULT_REASON_MAP[-1] ?? "正常",
					confidence: 0.7,
					punishment: "none",
					duration_seconds: null,
					evidence: [],
					summary: "窗口内未命中违规关键词，Mock 判断为正常。",
				},
				model: MOCK_MODEL_NAME,
				degraded: true,
			};
		}

		// 取总命中次数最高的 reason；同分时取更严重的 reason。
		const scores = new Map<number, { hits: number; confidence: number; contents: string[] }>();
		for (const item of risky) {
			const entry = scores.get(item.match.reason) ?? {
				hits: 0,
				confidence: 0,
				contents: [],
			};
			entry.hits += item.match.hitCount;
			entry.confidence = Math.max(entry.confidence, item.match.confidence);
			entry.contents.push(item.message.content);
			scores.set(item.match.reason, entry);
		}
		const [reason] = [...scores.entries()].sort((a, b) => {
			if (b[1].hits !== a[1].hits) return b[1].hits - a[1].hits;
			return b[0] - a[0];
		})[0];

		const detail = scores.get(reason)!;
		const confidence = Math.min(MOCK_MAX_CONFIDENCE, detail.confidence);

		return {
			verdict: {
				is_risk: true,
				reason,
				label: DEFAULT_REASON_MAP[reason] ?? "未知类型",
				confidence,
				punishment: "ban_1h",
				duration_seconds: 3_600,
				evidence: detail.contents.slice(0, 5),
				summary: `Mock 关键词判断命中 ${reason} 类风险（${detail.hits} 次），建议封禁 1 小时。`,
			},
			model: MOCK_MODEL_NAME,
			degraded: true,
		};
	}
}
