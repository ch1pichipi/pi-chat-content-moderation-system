import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { loadServerConfig } from "../config.ts";

const FIXED_NOW = new Date("2026-10-21T10:00:00.000Z");

test("config: 默认值符合变更计划", () => {
	const config = loadServerConfig({}, { cwd: "/tmp/project", now: FIXED_NOW });

	assert.equal(config.host, "127.0.0.1");
	assert.equal(config.port, 3000);
	assert.equal(config.agentMode, "pi");
	assert.equal(config.agentModel, undefined);
	assert.equal(config.agentFallbackToMock, true);
	assert.equal(config.policyPath, path.resolve("/tmp/project", "config/moderation-policy.json"));
	assert.equal(path.basename(config.publicDir), "public");

	assert.equal(config.analysis.windowMinutes, 10);
	assert.equal(config.analysis.maxMessages, 50);
	assert.equal(config.analysis.lookbackHours, 24);
	assert.equal(config.analysis.debounceMs, 1500);
	assert.equal(config.analysis.agentConcurrency, 2);
	assert.equal(config.analysis.agentTimeoutMs, 20000);
	assert.equal(config.analysis.maxMessageLength, 2000);
	assert.equal(config.analysis.serviceStartedAt, FIXED_NOW);
});

test("config: 环境变量覆盖", () => {
	const config = loadServerConfig(
		{
			CHAT_SERVER_HOST: "0.0.0.0",
			CHAT_SERVER_PORT: "3100",
			CHAT_AGENT_MODE: "mock",
			CHAT_AGENT_MODEL: "deepseek/deepseek-chat",
			CHAT_AGENT_FALLBACK_MOCK: "0",
			CHAT_ANALYSIS_WINDOW_MINUTES: "30",
			CHAT_ANALYSIS_MAX_MESSAGES: "100",
			CHAT_ANALYSIS_LOOKBACK_HOURS: "48",
			CHAT_ANALYSIS_DEBOUNCE_MS: "800",
			CHAT_AGENT_CONCURRENCY: "4",
			CHAT_AGENT_TIMEOUT_MS: "15000",
			CHAT_MESSAGE_MAX_LENGTH: "500",
			CHAT_POLICY_PATH: "custom/policy.json",
		},
		{ cwd: "/tmp/project", now: FIXED_NOW },
	);

	assert.equal(config.host, "0.0.0.0");
	assert.equal(config.port, 3100);
	assert.equal(config.agentMode, "mock");
	assert.equal(config.agentModel, "deepseek/deepseek-chat");
	assert.equal(config.agentFallbackToMock, false);
	assert.equal(config.analysis.windowMinutes, 30);
	assert.equal(config.analysis.maxMessages, 100);
	assert.equal(config.analysis.lookbackHours, 48);
	assert.equal(config.analysis.debounceMs, 800);
	assert.equal(config.analysis.agentConcurrency, 4);
	assert.equal(config.analysis.agentTimeoutMs, 15000);
	assert.equal(config.analysis.maxMessageLength, 500);
	assert.equal(config.policyPath, path.resolve("/tmp/project", "custom/policy.json"));
});

test("config: 非法数值与模式直接抛错", () => {
	const cases: Array<Record<string, string>> = [
		{ CHAT_SERVER_PORT: "abc" },
		{ CHAT_SERVER_PORT: "70000" },
		{ CHAT_ANALYSIS_WINDOW_MINUTES: "0" },
		{ CHAT_ANALYSIS_MAX_MESSAGES: "500" },
		{ CHAT_AGENT_CONCURRENCY: "0" },
		{ CHAT_AGENT_TIMEOUT_MS: "10" },
		{ CHAT_AGENT_MODE: "gpt" },
		{ CHAT_AGENT_FALLBACK_MOCK: "maybe" },
	];

	for (const env of cases) {
		assert.throws(
			() => loadServerConfig(env, { cwd: "/tmp/project", now: FIXED_NOW }),
			Error,
			JSON.stringify(env),
		);
	}
});

test("config: auto 与空 CHAT_AGENT_MODEL 归一化", () => {
	const config = loadServerConfig(
		{ CHAT_AGENT_MODE: "auto", CHAT_AGENT_MODEL: "  " },
		{ cwd: "/tmp/project", now: FIXED_NOW },
	);
	assert.equal(config.agentMode, "pi");
	assert.equal(config.agentModel, undefined);
});
