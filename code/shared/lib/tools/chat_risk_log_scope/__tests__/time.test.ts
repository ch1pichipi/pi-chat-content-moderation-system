import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDateTime, formatFileTimestamp, parseTime } from "../loader/time.ts";

test("时间: 11 种格式均可解析", () => {
	const inputs = [
		"2026-07-23T14:48:53.878123456+08:00",
		"2026-07-23T14:48:53+08:00",
		"2026-07-23 14:48:53.878123456",
		"2026-07-23 14:48:53.878123",
		"2026-07-23 14:48:53.878",
		"2026-07-23 14:48:53",
		"2026-07-23T14:48:53.878123456",
		"2026-07-23T14:48:53.878123",
		"2026-07-23T14:48:53.878",
		"2026-07-23T14:48:53",
		"2026-07-23",
	];
	for (const input of inputs) {
		const parsed = parseTime(input);
		assert.ok(parsed instanceof Date, `应能解析: ${input}`);
		assert.equal(parsed.getFullYear(), 2026, input);
	}
});

test("时间: 毫秒/微秒/纳秒精度截断到毫秒", () => {
	assert.equal(parseTime("2026-07-23 14:48:53.8")?.getMilliseconds(), 800);
	assert.equal(parseTime("2026-07-23 14:48:53.878")?.getMilliseconds(), 878);
	assert.equal(parseTime("2026-07-23 14:48:53.878123")?.getMilliseconds(), 878);
	assert.equal(parseTime("2026-07-23 14:48:53.878123456")?.getMilliseconds(), 878);
});

test("时间: 本地时区语义（无偏移）", () => {
	const parsed = parseTime("2026-07-23 14:48:53.878");
	assert.ok(parsed);
	assert.equal(parsed.getHours(), 14);
	assert.equal(parsed.getMinutes(), 48);
	assert.equal(parsed.getSeconds(), 53);
});

test("时间: RFC3339 带偏移按偏移换算", () => {
	const parsed = parseTime("2026-07-23T14:48:53+08:00");
	assert.ok(parsed);
	assert.equal(parsed.toISOString(), "2026-07-23T06:48:53.000Z");
});

test("时间: 非法时间返回 null", () => {
	for (const input of ["", "not-a-time", "2026-13-01", "2026-02-30", "2026-07-23 25:00:00"]) {
		assert.equal(parseTime(input), null, input);
	}
});

test("时间: 格式化函数", () => {
	const date = new Date(2026, 6, 23, 14, 48, 53, 878);
	assert.equal(formatDateTime(date), "2026-07-23 14:48:53");
	assert.equal(formatFileTimestamp(date), "20260723_144853");
});
