/**
 * 单条消息的 Mock 关键词规则。
 *
 * 说明：关键词启发式不具备语义理解能力，结果一律标记 mock/degraded，
 * 低置信度场景应建议人工复核，不能作为自动处罚的唯一依据。
 */

const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const SEPARATOR_RE = /[\s\p{P}\p{S}_]+/gu;

/** 文本归一化：NFKC、全角转半角、小写、去除零宽字符、折叠重复分隔符。 */
export function normalizeText(text: string): string {
	return text
		.normalize("NFKC")
		.replace(ZERO_WIDTH_RE, "")
		.toLowerCase()
		.replace(SEPARATOR_RE, " ")
		.trim();
}

/** 压缩文本：在归一化基础上去除空白/标点/符号，用于识别简单规避写法。 */
export function compressText(text: string): string {
	return normalizeText(text).replace(/[\s\p{P}\p{S}_]+/gu, "");
}

/** 默认关键词表，按 reason 分组。1/2/4/7 默认不内置高危敏感词，保留扩展位。 */
export const DEFAULT_KEYWORDS: Readonly<Record<number, readonly string[]>> = Object.freeze({
	1: [],
	2: [],
	3: [
		"傻逼",
		"傻b",
		"煞笔",
		"智障",
		"脑残",
		"废物",
		"去死",
		"滚蛋",
		"你妈的",
		"草泥马",
		"傻狗",
		"蠢货",
		"垃圾东西",
	],
	4: [],
	5: [
		"代练",
		"外挂",
		"私服",
		"加群",
		"加微信",
		"加qq",
		"返利",
		"低价出售",
		"收号",
		"卖号",
		"刷单",
		"兼职",
		"脚本",
		"辅助",
	],
	6: ["私聊", "加我", "联系方式", "vx", "威信", "扣扣"],
	7: [],
});

export interface KeywordMatch {
	/** 推断出的 reason；无命中为 -1。 */
	reason: number;
	/** 推断置信度；无命中为 0。 */
	confidence: number;
	/** 命中的关键词（去重，按首次命中顺序）。 */
	matchedKeywords: string[];
	/** 选中 reason 的命中次数（同 reason 下各关键词出现次数之和）。 */
	hitCount: number;
	/** 各 reason 的得分，便于调试与后续扩展。 */
	scores: Record<number, number>;
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * 按 reason 分组匹配关键词，取命中次数最高的 reason。
 * 命中次数相同取 reason 数值较小者，保证结果可复现。
 * confidence = min(0.95, 0.5 + 0.1 × 命中次数)。
 */
export function inferRiskFromKeywords(
	message: string,
	keywordOverrides?: Readonly<Record<number, readonly string[]>>,
): KeywordMatch {
	const source = message.slice(0, 10_000);
	const normalized = normalizeText(source);
	const compressed = compressText(source);
	const table: Readonly<Record<number, readonly string[]>> = keywordOverrides
		? { ...DEFAULT_KEYWORDS, ...keywordOverrides }
		: DEFAULT_KEYWORDS;

	const scores: Record<number, number> = {};
	const matchedByReason = new Map<number, string[]>();
	let hitCount = 0;

	const reasons = Object.keys(table)
		.map(Number)
		.filter((reason) => Number.isInteger(reason))
		.sort((a, b) => a - b);

	for (const reason of reasons) {
		const keywords = table[reason] ?? [];
		for (const keyword of keywords) {
			const normalizedKeyword = normalizeText(keyword);
			const compressedKeyword = compressText(keyword);
			if (normalizedKeyword === "" && compressedKeyword === "") continue;

			// 优先在压缩文本上匹配，可覆盖 "加 微 信"、"加*微*信" 等简单规避写法；
			// 当关键词自身包含分隔符时，再在归一化文本上匹配一次。
			const hits =
				countOccurrences(compressed, compressedKeyword) +
				(normalizedKeyword !== compressedKeyword
					? countOccurrences(normalized, normalizedKeyword)
					: 0);
			if (hits === 0) continue;

			scores[reason] = (scores[reason] ?? 0) + hits;
			hitCount += hits;
			const matched = matchedByReason.get(reason) ?? [];
			if (!matched.includes(keyword)) matched.push(keyword);
			matchedByReason.set(reason, matched);
		}
	}

	if (hitCount === 0) {
		return { reason: -1, confidence: 0, matchedKeywords: [], hitCount: 0, scores };
	}

	let bestReason = -1;
	let bestScore = 0;
	for (const reason of reasons) {
		const score = scores[reason] ?? 0;
		if (score > bestScore) {
			bestScore = score;
			bestReason = reason;
		}
	}

	return {
		reason: bestReason,
		confidence: Math.min(0.95, 0.5 + 0.1 * bestScore),
		matchedKeywords: matchedByReason.get(bestReason) ?? [],
		hitCount: bestScore,
		scores,
	};
}
