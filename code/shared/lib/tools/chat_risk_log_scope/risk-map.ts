/**
 * reason 风险类型编码到中文标签的映射，以及"从严处置"动作规则。
 *
 * 默认映射与 Go 版本 internal/riskmap 完全一致，可通过 reasonMap 覆盖/扩展。
 */

import type { SuggestedAction } from "./types.ts";

/** README 规定的默认 reason -> 风险类型标签映射（11 种）。 */
export const DEFAULT_REASON_MAP: Readonly<Record<number, string>> = Object.freeze({
	[-1]: "正常",
	0: "其他违禁",
	1: "政治宗教",
	2: "色情低俗",
	3: "侮辱谩骂",
	4: "暴恐犯罪",
	5: "广告诈骗",
	6: "运营规避",
	7: "特殊字符",
	127: "渠道禁止",
	[-128]: "访问屏蔽",
});

/** 运行期映射表，默认等于 DEFAULT_REASON_MAP，可被 overrides 覆盖/扩展。 */
export class RiskMap {
	private readonly table: Map<number, string>;

	constructor(overrides: Readonly<Record<string, string>> | Readonly<Record<number, string>> = {}) {
		this.table = new Map<number, string>();
		for (const [key, value] of Object.entries(DEFAULT_REASON_MAP)) {
			this.table.set(Number(key), value);
		}
		for (const [key, value] of Object.entries(overrides)) {
			const reason = Number(key);
			if (!Number.isInteger(reason) || typeof value !== "string") continue;
			this.table.set(reason, value);
		}
	}

	/** 返回 reason 对应标签；未知 reason 返回 "未知类型"（与 Go 版本一致）。 */
	label(reason: number): string {
		return this.table.get(reason) ?? "未知类型";
	}

	/** 返回当前生效映射表的只读快照。 */
	all(): Record<number, string> {
		return Object.fromEntries(this.table);
	}
}

/**
 * 根据风险类型给出"从严处置"场景下的建议动作。
 * 高置信度日志判断与重点账号推荐动作共用该规则。
 */
export function severeAction(reason: number): SuggestedAction {
	switch (reason) {
		case 4: // 暴恐犯罪
		case 5: // 广告诈骗
			return "加入黑名单";
		case 1: // 政治宗教
		case 2: // 色情低俗
		case 127: // 渠道禁止
		case -128: // 访问屏蔽
			return "封禁";
		case 3: // 侮辱谩骂
		case 6: // 运营规避
		case 7: // 特殊字符
			return "禁言";
		default:
			return "人工复核";
	}
}
