import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	IncrementalState,
	nextReportSeq,
	resetReportSeq,
} from "../incremental/state.ts";
import { buildReportFileName, writeMarkdownReport } from "../report/write.ts";

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "chat-risk-state-"));
}

test("incremental: 状态文件不存在时返回空状态", async () => {
	const dir = await tempDir();
	const state = await IncrementalState.load(path.join(dir, "nope.json"));
	assert.equal(state.lastTime, null);
});

test("incremental: 保存/读取往返与原子写入", async () => {
	const dir = await tempDir();
	const file = path.join(dir, "nested", "state.json");
	const state = new IncrementalState(file);
	const cursor = new Date("2026-07-23T06:48:53.878Z");
	state.updateLastTime(cursor);
	await state.save();

	const loaded = await IncrementalState.load(file);
	assert.equal(loaded.lastTime?.toISOString(), cursor.toISOString());
	const files = await readdir(path.dirname(file));
	assert.deepEqual(files, ["state.json"]);

	const raw = JSON.parse(await readFile(file, "utf8"));
	assert.equal(raw.last_time, cursor.toISOString());
	assert.ok(typeof raw.updated_at === "string");
});

test("incremental: updateLastTime 只前进不后退", () => {
	const state = new IncrementalState("unused.json");
	state.updateLastTime(new Date("2026-07-23T10:00:00Z"));
	state.updateLastTime(new Date("2026-07-23T09:00:00Z"));
	assert.equal(state.lastTime?.toISOString(), "2026-07-23T10:00:00.000Z");
	state.updateLastTime(new Date("2026-07-23T11:00:00Z"));
	assert.equal(state.lastTime?.toISOString(), "2026-07-23T11:00:00.000Z");
});

test("incremental: 状态文件损坏时明确报错", async () => {
	const dir = await tempDir();
	const file = path.join(dir, "bad.json");
	await writeFile(file, "{not json", "utf8");
	await assert.rejects(() => IncrementalState.load(file), /解析状态文件失败/);

	await writeFile(file, JSON.stringify({ last_time: "not-a-time" }), "utf8");
	await assert.rejects(() => IncrementalState.load(file), /last_time 格式无法解析/);
});

test("incremental: 兼容 lastTime 驼峰字段", async () => {
	const dir = await tempDir();
	const file = path.join(dir, "state.json");
	await writeFile(file, JSON.stringify({ lastTime: "2026-07-23T10:00:00Z" }), "utf8");
	const state = await IncrementalState.load(file);
	assert.equal(state.lastTime?.toISOString(), "2026-07-23T10:00:00.000Z");
});

test("incremental: report seq 每次递增，可重置", () => {
	resetReportSeq();
	assert.equal(nextReportSeq(), 1);
	assert.equal(nextReportSeq(), 2);
	resetReportSeq();
	assert.equal(nextReportSeq(), 1);
});

test("report 落盘: 固定 reports/ 目录、时间戳命名、同名追加后缀", async () => {
	const dir = await tempDir();
	const generatedAt = new Date(2026, 6, 23, 14, 48, 53);
	const first = await writeMarkdownReport("# one\n", { cwd: dir, generatedAt });
	const second = await writeMarkdownReport("# two\n", { cwd: dir, generatedAt });
	const third = await writeMarkdownReport("# three\n", { cwd: dir, generatedAt, reportSeq: 2 });

	assert.equal(first.relativePath, "reports/chat_risk_report_20260723_144853.md");
	assert.equal(second.relativePath, "reports/chat_risk_report_20260723_144853_1.md");
	assert.equal(third.relativePath, "reports/chat_risk_report_20260723_144853_seq2.md");
	assert.equal(await readFile(first.absolutePath, "utf8"), "# one\n");
	assert.equal(buildReportFileName(generatedAt, 0), "chat_risk_report_20260723_144853.md");
	assert.equal(buildReportFileName(generatedAt, 3), "chat_risk_report_20260723_144853_seq3.md");
});
