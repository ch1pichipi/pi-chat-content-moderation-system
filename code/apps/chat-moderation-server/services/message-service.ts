/**
 * 发消息领域服务：封禁校验、内容校验、玩家资料继承。
 */

import type { Pool } from "mysql2/promise";

import {
	fetchRecentMessages,
	insertMessage,
	type ChatMessageRecord,
} from "../../../shared/lib/tools/chat_risk_log_scope/db/messages.ts";
import type { BanView } from "../events.ts";
import { getActiveBanView } from "./ban-service.ts";

/** 封禁中尝试发消息时抛出，路由层转成 HTTP 423。 */
export class PlayerBannedError extends Error {
	readonly code = "player_banned";

	constructor(readonly ban: BanView) {
		super(`玩家处于封禁中（${ban.punishment}）`);
		this.name = "PlayerBannedError";
	}
}

const ACCOUNT_MAX_LENGTH = 128;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/** 校验并归一化账号；非法账号抛错。 */
export function normalizeAccount(value: string): string {
	const account = value.trim();
	if (account === "") throw new Error("账号不能为空");
	if (account.length > ACCOUNT_MAX_LENGTH) {
		throw new Error(`账号长度不能超过 ${ACCOUNT_MAX_LENGTH}`);
	}
	if (CONTROL_CHAR_RE.test(account)) throw new Error("账号包含非法控制字符");
	return account;
}

export interface SendMessageOptions {
	account: string;
	content: string;
	maxLength: number;
	now?: Date;
}

/**
 * 发送消息：封禁校验 -> 写入 chat_risk_logs。
 *
 * 不在这里触发分析，由路由层调用 analysis.enqueue，返回 202 后异步分析。
 */
export async function sendMessage(
	pool: Pool,
	options: SendMessageOptions,
): Promise<ChatMessageRecord> {
	const now = options.now ?? new Date();
	const account = normalizeAccount(options.account);

	const ban = await getActiveBanView(pool, account, now);
	if (ban) throw new PlayerBannedError(ban);

	const content = options.content;
	if (typeof content !== "string" || content.trim() === "") {
		throw new Error("消息内容不能为空");
	}
	const charLength = [...content].length;
	if (charLength > options.maxLength) {
		throw new Error(`消息长度不能超过 ${options.maxLength} 个字符`);
	}

	// 继承该账号最近的昵称/区服，前端只需要传内容。
	const recent = await fetchRecentMessages(pool, account, { limit: 1 });
	const profile = recent[recent.length - 1];

	return insertMessage(pool, {
		account,
		nickname: profile?.nickname ?? account,
		areaId: profile?.areaId ?? "",
		areaName: profile?.areaName ?? "",
		serverId: profile?.serverId ?? "",
		content,
		contextType: profile?.contextType || "chat",
		createTime: now,
	});
}
