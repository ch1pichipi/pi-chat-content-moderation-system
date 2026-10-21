/**
 * REST API 路由。
 *
 * 路由表（见变更计划第 6 节）：
 *   GET  /api/players
 *   GET  /api/players/:account/messages?limit=50
 *   POST /api/players/:account/messages   封禁中返回 423
 *   GET  /api/players/:account/status
 *   POST /api/players/:account/unban
 *   GET  /api/events                      SSE
 *   GET  /api/health
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "mysql2/promise";

import { describeDb, loadDbConfig } from "../../../shared/lib/tools/chat_risk_log_scope/db/client.ts";
import type { ServerConfig } from "../config.ts";
import type { AnalysisService } from "../services/analysis-service.ts";
import { liftBan } from "../services/ban-service.ts";
import {
	PlayerBannedError,
	normalizeAccount,
	sendMessage,
} from "../services/message-service.ts";
import { getPlayerMessages, getPlayerStatus, listPlayerViews } from "../services/player-service.ts";
import type { SseHub } from "./sse.ts";

export interface ApiContext {
	pool: Pool;
	analysis: AnalysisService;
	sse: SseHub;
	config: ServerConfig;
	/** 仅用于健康检查展示，不包含密码。 */
	dbLabel: string;
	startedAt: Date;
	logger?: (message: string) => void;
}

const MAX_BODY_BYTES = 64 * 1024;

/** 可映射为 HTTP 状态码的请求错误。 */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function errorBody(error: string, message: string, extra: Record<string, unknown> = {}) {
	return { error, message, ...extra };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			throw new HttpError(413, "payload_too_large", "请求体过大（上限 64KB）");
		}
		chunks.push(buffer);
	}
	if (size === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
	}
}

function parseIntParam(raw: string | null, fallback: number, min: number, max: number): number {
	if (raw === null || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new HttpError(400, "invalid_query", `参数必须是 ${min}~${max} 之间的整数`);
	}
	return value;
}

function decodeAccount(segment: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		throw new HttpError(400, "invalid_account", "账号编码非法");
	}
	try {
		return normalizeAccount(decoded);
	} catch (error) {
		throw new HttpError(400, "invalid_account", (error as Error).message);
	}
}

async function handlePlayersList(
	res: ServerResponse,
	url: URL,
	ctx: ApiContext,
): Promise<void> {
	const limit = parseIntParam(url.searchParams.get("limit"), 100, 1, 500);
	const players = await listPlayerViews(ctx.pool, limit);
	sendJson(res, 200, { players, serverTime: new Date().toISOString() });
}

async function handleMessages(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	ctx: ApiContext,
	accountSegment: string,
): Promise<void> {
	const account = decodeAccount(accountSegment);

	if (req.method === "GET") {
		const limit = parseIntParam(url.searchParams.get("limit"), 50, 1, 200);
		const messages = await getPlayerMessages(ctx.pool, account, limit);
		const status = await getPlayerStatus(ctx.pool, account);
		sendJson(res, 200, {
			account,
			messages,
			ban: status.ban,
			serverTime: new Date().toISOString(),
		});
		return;
	}

	if (req.method !== "POST") {
		sendJson(res, 405, errorBody("method_not_allowed", "只支持 GET / POST"));
		return;
	}

	const body = await readJsonBody(req);
	const content =
		typeof body === "object" && body !== null && "content" in body
			? (body as { content?: unknown }).content
			: undefined;
	if (typeof content !== "string") {
		sendJson(res, 400, errorBody("invalid_content", "请求体必须包含字符串字段 content"));
		return;
	}
	const contentLength = [...content].length;
	if (content.trim() === "") {
		sendJson(res, 400, errorBody("invalid_content", "消息内容不能为空"));
		return;
	}
	if (contentLength > ctx.config.analysis.maxMessageLength) {
		sendJson(
			res,
			400,
			errorBody(
				"content_too_long",
				`消息长度不能超过 ${ctx.config.analysis.maxMessageLength} 个字符`,
			),
		);
		return;
	}

	try {
		const message = await sendMessage(ctx.pool, {
			account,
			content,
			maxLength: ctx.config.analysis.maxMessageLength,
		});
		ctx.sse.emit({ type: "message_created", account, message });
		// 返回 202 后异步分析，不阻塞发送请求。
		ctx.analysis.enqueue(account);
		sendJson(res, 202, {
			messageId: message.id,
			status: "accepted",
			analysisStatus: "pending",
			message,
		});
	} catch (error) {
		if (error instanceof PlayerBannedError) {
			sendJson(
				res,
				423,
				errorBody("player_banned", "玩家处于封禁中，无法发送消息", { ban: error.ban }),
			);
			return;
		}
		throw error;
	}
}

async function handleStatus(
	res: ServerResponse,
	ctx: ApiContext,
	accountSegment: string,
): Promise<void> {
	const account = decodeAccount(accountSegment);
	const status = await getPlayerStatus(ctx.pool, account);
	sendJson(res, 200, { ...status, serverTime: new Date().toISOString() });
}

async function handleUnban(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: ApiContext,
	accountSegment: string,
): Promise<void> {
	if (req.method !== "POST") {
		sendJson(res, 405, errorBody("method_not_allowed", "只支持 POST"));
		return;
	}
	const account = decodeAccount(accountSegment);
	const ban = await liftBan(ctx.pool, account);
	if (!ban) {
		sendJson(res, 200, { account, unbanned: false, message: "当前没有生效封禁" });
		return;
	}
	ctx.sse.emit({ type: "ban_lifted", account });
	ctx.logger?.(`提前解封 ${account}（${ban.punishment}）`);
	sendJson(res, 200, { account, unbanned: true, ban });
}

/** 处理 /api/* 请求；返回 false 表示未匹配任何路由。 */
export async function handleApiRequest(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	ctx: ApiContext,
): Promise<boolean> {
	const pathname = url.pathname;

	if (pathname === "/api/health" && req.method === "GET") {
		sendJson(res, 200, {
			ok: true,
			db: ctx.dbLabel,
			agentMode: ctx.config.agentMode,
			agentModel: ctx.config.agentModel ?? "default",
			analysis: {
				windowMinutes: ctx.config.analysis.windowMinutes,
				maxMessages: ctx.config.analysis.maxMessages,
				lookbackHours: ctx.config.analysis.lookbackHours,
				debounceMs: ctx.config.analysis.debounceMs,
				concurrency: ctx.config.analysis.agentConcurrency,
			},
			pendingAnalyses: ctx.analysis.pendingCount(),
			sseClients: ctx.sse.clientCount,
			uptimeSeconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
		});
		return true;
	}

	if (pathname === "/api/events" && req.method === "GET") {
		ctx.sse.add(req, res);
		return true;
	}

	if (pathname === "/api/players" && req.method === "GET") {
		await handlePlayersList(res, url, ctx);
		return true;
	}

	const messagesMatch = /^\/api\/players\/([^/]+)\/messages$/.exec(pathname);
	if (messagesMatch) {
		await handleMessages(req, res, url, ctx, messagesMatch[1]);
		return true;
	}

	const statusMatch = /^\/api\/players\/([^/]+)\/status$/.exec(pathname);
	if (statusMatch && req.method === "GET") {
		await handleStatus(res, ctx, statusMatch[1]);
		return true;
	}

	const unbanMatch = /^\/api\/players\/([^/]+)\/unban$/.exec(pathname);
	if (unbanMatch) {
		await handleUnban(req, res, ctx, unbanMatch[1]);
		return true;
	}

	if (pathname.startsWith("/api/")) {
		sendJson(res, 404, errorBody("not_found", `未知接口: ${req.method} ${pathname}`));
		return true;
	}
	return false;
}

/** 便捷函数：创建 API 上下文，供 index.ts 与测试复用。 */
export function createApiContext(options: {
	pool: Pool;
	analysis: AnalysisService;
	sse: SseHub;
	config: ServerConfig;
	logger?: (message: string) => void;
}): ApiContext {
	return {
		...options,
		dbLabel: describeDb(loadDbConfig()),
		startedAt: new Date(),
	};
}
