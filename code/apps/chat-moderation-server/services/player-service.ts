/**
 * 玩家领域服务：玩家列表、聊天记录、封禁状态。
 */

import type { Pool } from "mysql2/promise";

import {
	fetchRecentMessages,
	listPlayers,
	type ChatMessageRecord,
	type PlayerOverview,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/messages.ts";
import type { BanView } from "../events.ts";
import { getActiveBanMap, getActiveBanView } from "./ban-service.ts";

export interface PlayerView extends PlayerOverview {
	ban: BanView | null;
}

export interface PlayerStatusView {
	account: string;
	banned: boolean;
	ban: BanView | null;
}

/** 玩家列表 + 当前封禁状态。 */
export async function listPlayerViews(
	pool: Pool,
	limit = 100,
	now: Date = new Date(),
): Promise<PlayerView[]> {
	const [players, bans] = await Promise.all([
		listPlayers(pool, limit),
		getActiveBanMap(pool, now),
	]);
	return players.map((player) => ({
		...player,
		ban: bans.get(player.account) ?? null,
	}));
}

/** 单个玩家的封禁状态；账号不存在也不报错。 */
export async function getPlayerStatus(
	pool: Pool,
	account: string,
	now: Date = new Date(),
): Promise<PlayerStatusView> {
	const ban = await getActiveBanView(pool, account, now);
	return { account, banned: ban !== null, ban };
}

/** 某玩家最近聊天记录（按时间升序，便于前端直接渲染）。 */
export async function getPlayerMessages(
	pool: Pool,
	account: string,
	limit = 50,
): Promise<ChatMessageRecord[]> {
	return fetchRecentMessages(pool, account, { limit });
}
