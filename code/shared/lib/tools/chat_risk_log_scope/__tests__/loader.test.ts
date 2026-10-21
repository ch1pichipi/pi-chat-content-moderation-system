import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { loadCsv, parseCsvRows } from "../loader/csv.ts";
import { loadFromText, MAX_FILE_LINES } from "../loader/index.ts";
import { loadJson } from "../loader/json.ts";

const fixture = (name: string) =>
	new URL(`../__fixtures__/${name}`, import.meta.url);

test("CSV: 解析引号、逗号、换行与双引号转义", () => {
	const rows = parseCsvRows(
		'id,msg\n1,"a,b"\n2,"line1\nline2"\n3,"he said ""hi"""\n',
	);
	assert.deepEqual(rows, [
		["id", "msg"],
		["1", "a,b"],
		["2", "line1\nline2"],
		["3", 'he said "hi"'],
	]);
});

test("CSV: 表头乱序、大小写与缺失列容错", () => {
	const { entries, warnings } = loadCsv(
		"ACCOUNT,ID,Reason,confidence,current_message\nacc1, log_1 ,5,0.9,加微信\n",
	);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].account, "acc1");
	assert.equal(entries[0].id, "log_1");
	assert.equal(entries[0].reason, 5);
	assert.equal(entries[0].confidence, 0.9);
	assert.equal(entries[0].currentMessage, "加微信");
	assert.equal(entries[0].judgeResult, "");
	assert.equal(warnings.length, 0);
});

test("CSV: 非法 reason/confidence 与缺字段记录 warning", () => {
	const { entries } = loadCsv(
		"id,account,reason,confidence,context_messages\n, ,,x,a|b\n",
	);
	const entry = entries[0];
	assert.equal(entry.reason, -1);
	assert.equal(entry.confidence, 0);
	assert.deepEqual(entry.contextMessages, ["a", "b"]);
	assert.ok(entry.warnings.some((w) => w.includes("缺失 id")));
	assert.ok(entry.warnings.some((w) => w.includes("缺失 account")));
	assert.ok(entry.warnings.some((w) => w.includes("reason")));
	assert.ok(entry.warnings.some((w) => w.includes("confidence")));
});

test("CSV: 空文件与仅表头报错", () => {
	assert.throws(() => loadCsv(""), /CSV 日志文件为空/);
	assert.throws(() => loadCsv("id,account\n"), /不含任何数据行/);
});

test("CSV: 坏行跳过不中断", () => {
	const { entries } = loadCsv('id,account\n1,a\n\n2,"unclosed\n');
	assert.ok(entries.length >= 2);
	assert.equal(entries[0].id, "1");
});

test("JSON: 数组解析、数字字符串混用、context 数组/字符串", () => {
	const { entries, warnings } = loadJson(
		JSON.stringify([
			{
				id: 1,
				account: "acc",
				reason: "5",
				confidence: "0.8",
				context_messages: ["a", "b"],
				create_time: "2026-07-23 14:48:53.878",
			},
			{
				id: "2",
				account: "acc2",
				reason: 3,
				confidence: 0.6,
				context_messages: "x|y",
				forbid_considered: "true",
				forbid_deduped: 1,
			},
		]),
	);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].id, "1");
	assert.equal(entries[0].reason, 5);
	assert.equal(entries[0].confidence, 0.8);
	assert.deepEqual(entries[0].contextMessages, ["a", "b"]);
	assert.ok(entries[0].createTime instanceof Date);
	assert.deepEqual(entries[1].contextMessages, ["x", "y"]);
	assert.equal(entries[1].forbidConsidered, true);
	assert.equal(entries[1].forbidDeduped, true);
	assert.equal(warnings.length, 0);
});

test("JSON: 非法字段降级并记录 warning", () => {
	const { entries } = loadJson(
		JSON.stringify([{ id: "", account: "", reason: "abc", confidence: "x" }]),
	);
	assert.equal(entries[0].reason, -1);
	assert.equal(entries[0].confidence, 0);
	assert.ok(entries[0].warnings.some((w) => w.includes("reason")));
	assert.ok(entries[0].warnings.some((w) => w.includes("confidence")));
});

test("JSON: 空内容、非法 JSON、非数组、空数组报错", () => {
	assert.throws(() => loadJson("   "), /JSON 日志文件为空/);
	assert.throws(() => loadJson("{bad"), /解析 JSON 日志失败/);
	assert.throws(() => loadJson("{}"), /顶层结构必须是数组/);
	assert.throws(() => loadJson("[]"), /不含任何数据行/);
});

test("Fixture: CSV 与 JSON 读取条目数一致", async () => {
	const csv = await readFile(fixture("sample_logs.csv"), "utf8");
	const json = await readFile(fixture("sample_logs.json"), "utf8");
	const csvResult = loadFromText(csv, "csv");
	const jsonResult = loadFromText(json, "json");
	assert.equal(csvResult.entries.length, 10);
	assert.equal(jsonResult.entries.length, 10);
	assert.equal(csvResult.warnings.length, 0);
	assert.equal(jsonResult.warnings.length, 0);
});

test("Loader: 行数超过上限报错", () => {
	const content = `id,account\n${Array.from({ length: MAX_FILE_LINES + 1 }, (_, i) => `${i},acc`).join("\n")}`;
	assert.throws(() => loadFromText(content, "csv"), /超过上限/);
});
