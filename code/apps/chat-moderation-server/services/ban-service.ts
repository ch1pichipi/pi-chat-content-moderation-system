/**
 * 封禁领域服务：把数据库记录转换成 API 视图，并提供历史摘要。
 */

import type { Pool } from "mysql2/promise";

import {
	banRemainingSeconds,
	fetchActiveBan,
	fetchActiveBans,
	fetchLastBan,
	countBansSince,
	liftActiveBan,
	type ChatPlayerBanRecord,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/bans.ts";
import {
	countRecentRiskJudgements,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/messages.ts";
import type { AnalysisHistorySummary } from "../agent/types.ts";
import type { BanView } from "../events.ts";

/** 数据库封禁记录 -> 前端视图。 */
export function toBanView(ban: ChatPlayerBanRecord, now: Date = new Date()): BanView {
	return {
		id: ban.id,
		account: ban.account,
		punishment: ban.punishment,
		reason: ban.reason,
		label: ban.label,
		startAt: ban.start_at,
		endAt: ban.end_at,
		remainingSeconds: banRemainingSeconds(ban, now),
		permanent: ban.end_at === null,
		status: ban.status,
	};
}

/** 账号当前生效封禁；没有则返回 null。 */
export async function getActiveBanView(
	pool: Pool,
	account: string,
	now: Date = new Date(),
): Promise<BanView | null> {
	const ban = await fetchActiveBan(pool, account, now);
	return ban ? toBanView(ban, now) : null;
}

/** 所有生效封禁，玩家列表一次查询完成。 */
export async function getActiveBanMap(
	pool: Pool,
	now: Date = new Date(),
): Promise<Map<string, BanView>> {
	const bans = await fetchActiveBans(pool, now);
	const map = new Map<string, BanView>();
	for (const [account, ban] of bans) map.set(account, toBanView(ban, now));
	return map;
}

/** 提前解封；返回解封前的封禁视图。 */
export async function liftBan(
	pool: Pool,
	account: string,
	now: Date = new Date(),
): Promise<BanView | null> {
	const lifted = await liftActiveBan(pool, account, now);
	return lifted ? toBanView(lifted, now) : null;
}

/** 统计最近 N 小时的历史封禁数（含已过期/已解封）。 */
export async function countPriorBans(
	pool: Pool,
	account: string,
	windowHours: number,
	now: Date = new Date(),
): Promise<number> {
	return countBansSince(pool, account, new Date(now.getTime() - windowHours * 3_600_000));
}

/** 构造传给 Agent 的历史摘要：只给统计数字，不给全部历史原文。 */
export async function buildHistorySummary(
	pool: Pool,
	account: string,
	lookbackHours: number,
	now: Date = new Date(),
): Promise<AnalysisHistorySummary> {
	const since = new Date(now.getTime() - lookbackHours * 3_600_000);
	const [riskCount, banCount, lastBan] = await Promise.all([
		countRecentRiskJudgements(pool, account, since),
		countBansSince(pool, account, since),
		fetchLastBan(pool, account),
	]);
	return {
		last24hRiskCount: riskCount,
		last24hBanCount: banCount,
		lastBan: lastBan
			? {
					reason: lastBan.reason,
					punishment: lastBan.punishment,
					startedAt: lastBan.start_at,
				}
			: null,
	};
}
