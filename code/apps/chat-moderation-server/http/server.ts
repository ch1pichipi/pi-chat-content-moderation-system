/**
 * Node HTTP 服务器：静态页面 + REST API + SSE。
 *
 * 默认只监听 127.0.0.1，本地演示不暴露公网（见计划第 9 节）。
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import type { ServerConfig } from "../config.ts";
import { HttpError, handleApiRequest, type ApiContext } from "./routes.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
});

/** 只允许访问 public 目录下的白名单文件，避免路径穿越。 */
const STATIC_FILES = new Set(["index.html", "app.js", "style.css", "favicon.svg"]);

async function serveStatic(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	config: ServerConfig,
): Promise<void> {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Method Not Allowed");
		return;
	}

	const rawName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
	const fileName = path.basename(rawName);
	if (!STATIC_FILES.has(fileName) || rawName !== fileName) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not Found");
		return;
	}

	let content: Buffer;
	try {
		content = await readFile(path.join(config.publicDir, fileName));
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not Found");
		return;
	}

	res.writeHead(200, {
		"Content-Type": CONTENT_TYPES[path.extname(fileName)] ?? "application/octet-stream",
		"Content-Length": content.length,
		"Cache-Control": "no-cache",
	});
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	res.end(content);
}

export function createChatServer(ctx: ApiContext, config: ServerConfig = ctx.config): Server {
	return createServer((req, res) => {
		const startedAt = Date.now();
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

		res.on("finish", () => {
			ctx.logger?.(`${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
		});

		const handle = async (): Promise<void> => {
			if (url.pathname.startsWith("/api/")) {
				const handled = await handleApiRequest(req, res, url, ctx);
				if (!handled) {
					res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "not_found" }));
				}
				return;
			}
			await serveStatic(req, res, url, config);
		};

		void handle().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			const status = error instanceof HttpError ? error.status : 500;
			const code = error instanceof HttpError ? error.code : "internal_error";
			ctx.logger?.(`请求失败 ${req.method} ${url.pathname}: ${message}`);
			if (res.headersSent) {
				res.end();
				return;
			}
			res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: code, message }));
		});
	});
}
