/**
 * 实时聊天审核与封禁服务入口。
 *
 * 运行：
 *   npm run db:init:chat-risk   # 首次或升级后执行迁移
 *   npm run server
 *   浏览器打开 http://127.0.0.1:3000
 *
 * 常用环境变量：
 *   CHAT_SERVER_PORT / CHAT_SERVER_HOST
 *   CHAT_AGENT_MODE=pi|mock            # mock 仅用于测试与降级
 *   CHAT_AGENT_MODEL=provider/model    # 留空使用 Pi 当前默认模型
 *   CHAT_AGENT_TIMEOUT_MS / CHAT_AGENT_CONCURRENCY / CHAT_AGENT_FALLBACK_MOCK
 *   CHAT_ANALYSIS_WINDOW_MINUTES / CHAT_ANALYSIS_MAX_MESSAGES
 *   CHAT_ANALYSIS_LOOKBACK_HOURS / CHAT_ANALYSIS_DEBOUNCE_MS
 */

import { closeDbPool, describeDb, getDbPool, loadDbConfig } from "../../shared/lib/tools/chat_risk_log_scope/db/client.ts";
import { MockAgentJudge } from "./agent/mock.ts";
import { PiAgentJudge, type Judge } from "./agent/judge.ts";
import { loadModerationPolicy } from "./agent/policy.ts";
import { loadServerConfig } from "./config.ts";
import { createApiContext } from "./http/routes.ts";
import { createChatServer } from "./http/server.ts";
import { SseHub } from "./http/sse.ts";
import { AnalysisService } from "./services/analysis-service.ts";

function log(message: string): void {
	process.stderr.write(`[chat-moderation] ${message}\n`);
}

function warn(message: string): void {
	process.stderr.write(`[chat-moderation] ⚠ ${message}\n`);
}

async function main(): Promise<void> {
	const config = loadServerConfig();
	const policy = loadModerationPolicy(config.policyPath, warn);
	const dbConfig = loadDbConfig();
	const pool = getDbPool();

	// 启动前确认数据库可连接、迁移已应用，避免运行时才暴露问题。
	await pool.query("SELECT 1");
	try {
		await pool.query("SELECT 1 FROM chat_player_bans LIMIT 1");
	} catch {
		warn("chat_player_bans 表不存在，请先执行: npm run db:init:chat-risk");
	}

	const sse = new SseHub();
	const judge: Judge =
		config.agentMode === "mock"
			? new MockAgentJudge()
			: new PiAgentJudge({
					model: config.agentModel,
					timeoutMs: config.analysis.agentTimeoutMs,
					cwd: process.cwd(),
				});
	const fallbackJudge =
		config.agentMode === "pi" && config.agentFallbackToMock ? new MockAgentJudge() : undefined;

	const analysis = new AnalysisService({
		pool,
		judge,
		fallbackJudge,
		policy,
		events: sse,
		windowMinutes: config.analysis.windowMinutes,
		maxMessages: config.analysis.maxMessages,
		lookbackHours: config.analysis.lookbackHours,
		debounceMs: config.analysis.debounceMs,
		concurrency: config.analysis.agentConcurrency,
		serviceStartedAt: config.analysis.serviceStartedAt,
		logger: (level, message) => {
			const prefix = level === "error" ? "✖" : level === "warn" ? "⚠" : "•";
			log(`${prefix} ${message}`);
		},
	});

	const ctx = createApiContext({
		pool,
		analysis,
		sse,
		config,
		logger: log,
	});
	const server = createChatServer(ctx, config);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => resolve());
	});

	log(`已启动 http://${config.host}:${config.port}`);
	log(`数据库 ${describeDb(dbConfig)} | Agent 模式 ${config.agentMode} | 模型 ${config.agentModel ?? "默认"}`);
	log(
		`分析窗口 ${config.analysis.windowMinutes} 分钟 / 最多 ${config.analysis.maxMessages} 条 | ` +
			`并发 ${config.analysis.agentConcurrency} | 超时 ${config.analysis.agentTimeoutMs}ms`,
	);

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		log(`收到 ${signal}，正在关闭…`);
		analysis.stop();
		sse.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await closeDbPool();
		log("已退出");
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			void shutdown(signal);
		});
	}
}

main().catch((error) => {
	process.stderr.write(`[chat-moderation] 启动失败: ${(error as Error).stack ?? error}\n`);
	process.exitCode = 1;
});
