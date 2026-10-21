/**
 * SSE 推送中心。
 *
 * 使用 `event: <type>` + `data: <json>` 格式，客户端按事件名分别处理。
 * 定时发送注释行做心跳，避免代理/浏览器断开空闲连接。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { EventSink, ServerEvent } from "../events.ts";

export interface SseHubOptions {
	heartbeatMs?: number;
}

export class SseHub implements EventSink {
	private readonly clients = new Set<ServerResponse>();
	private readonly heartbeat: NodeJS.Timeout;

	constructor(options: SseHubOptions = {}) {
		const heartbeatMs = options.heartbeatMs ?? 25_000;
		this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
		this.heartbeat.unref?.();
	}

	get clientCount(): number {
		return this.clients.size;
	}

	/** 接入一个新的 SSE 客户端。 */
	add(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(`retry: 3000\n\n`);
		res.write(`event: hello\ndata: ${JSON.stringify({ type: "hello", at: new Date().toISOString() })}\n\n`);

		this.clients.add(res);
		const cleanup = () => {
			this.clients.delete(res);
		};
		req.on("close", cleanup);
		req.on("error", cleanup);
		res.on("close", cleanup);
		res.on("error", cleanup);
	}

	emit(event: ServerEvent): void {
		const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
		for (const client of this.clients) {
			try {
				client.write(payload);
			} catch {
				this.clients.delete(client);
			}
		}
	}

	private ping(): void {
		for (const client of this.clients) {
			try {
				client.write(`: ping ${Date.now()}\n\n`);
			} catch {
				this.clients.delete(client);
			}
		}
	}

	close(): void {
		clearInterval(this.heartbeat);
		for (const client of this.clients) {
			try {
				client.end();
			} catch {
				// 忽略关闭阶段错误。
			}
		}
		this.clients.clear();
	}
}
