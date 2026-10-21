import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountQueue } from "../services/account-queue.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("queue: 同账号连续入队只触发一次分析（防抖合并）", async () => {
	let calls = 0;
	const queue = new AccountQueue<void>({
		debounceMs: 25,
		concurrency: 2,
		worker: async () => {
			calls++;
		},
	});

	for (let index = 0; index < 5; index++) {
		queue.enqueue("account_01");
		await sleep(5);
	}
	await queue.waitForIdle(2_000);

	assert.equal(calls, 1);
	assert.equal(queue.pendingCount(), 0);
});

test("queue: 不同账号分别触发，互不干扰", async () => {
	const seen: string[] = [];
	const queue = new AccountQueue<void>({
		debounceMs: 10,
		concurrency: 2,
		worker: async (account) => {
			seen.push(account);
		},
	});

	queue.enqueue("a");
	queue.enqueue("b");
	queue.enqueue("c");
	await queue.waitForIdle(2_000);

	assert.deepEqual(new Set(seen), new Set(["a", "b", "c"]));
});

test("queue: 同一账号运行期间再次入队会补跑一次且不并发", async () => {
	let current = 0;
	let peak = 0;
	let calls = 0;
	const queue = new AccountQueue<void>({
		debounceMs: 0,
		concurrency: 4,
		worker: async () => {
			current++;
			peak = Math.max(peak, current);
			calls++;
			await sleep(30);
			current--;
		},
	});

	queue.enqueue("a");
	await sleep(5); // 让第一次任务先跑起来
	queue.enqueue("a");
	queue.enqueue("a");
	await queue.waitForIdle(2_000);

	assert.equal(peak, 1, "同一账号不允许并发");
	assert.equal(calls, 2, "运行期间的入队应合并为一次补跑");
});

test("queue: 全局并发上限生效", async () => {
	let current = 0;
	let peak = 0;
	const queue = new AccountQueue<void>({
		debounceMs: 0,
		concurrency: 2,
		worker: async () => {
			current++;
			peak = Math.max(peak, current);
			await sleep(20);
			current--;
		},
	});

	for (const account of ["a", "b", "c", "d", "e"]) queue.enqueue(account);
	await queue.waitForIdle(3_000);

	assert.equal(peak, 2);
});

test("queue: runNow 跳过防抖并返回结果", async () => {
	let calls = 0;
	const queue = new AccountQueue<number>({
		debounceMs: 5_000,
		concurrency: 1,
		worker: async () => {
			calls++;
			return calls;
		},
	});

	queue.enqueue("a");
	const result = await queue.runNow("a");
	assert.equal(result, 1);
	assert.equal(calls, 1, "runNow 应清掉防抖定时器，不会再跑一次");
});

test("queue: 账号运行中再次 runNow 返回 null 并合并补跑", async () => {
	let calls = 0;
	const queue = new AccountQueue<number>({
		debounceMs: 0,
		concurrency: 1,
		worker: async () => {
			calls++;
			await sleep(30);
			return calls;
		},
	});

	const first = queue.runNow("a");
	await sleep(5);
	assert.equal(await queue.runNow("a"), null);
	assert.equal(await first, 1);
	await queue.waitForIdle(2_000);
	assert.equal(calls, 2);
});

test("queue: worker 抛错被 onError 捕获，队列继续工作", async () => {
	const errors: string[] = [];
	const queue = new AccountQueue<void>({
		debounceMs: 0,
		concurrency: 1,
		worker: async (account) => {
			if (account === "bad") throw new Error("boom");
		},
		onError: (account) => errors.push(account),
	});

	queue.enqueue("bad");
	queue.enqueue("good");
	await queue.waitForIdle(2_000);

	assert.deepEqual(errors, ["bad"]);
});

test("queue: stop 后不再执行新任务", async () => {
	let calls = 0;
	const queue = new AccountQueue<void>({
		debounceMs: 50,
		concurrency: 1,
		worker: async () => {
			calls++;
		},
	});

	queue.enqueue("a");
	queue.stop();
	await sleep(80);

	assert.equal(calls, 0);
	assert.equal(queue.pendingCount(), 0);
});

test("queue: 非法并发配置抛错", () => {
	assert.throws(
		() => new AccountQueue({ debounceMs: 0, concurrency: 0, worker: async () => {} }),
		/concurrency/,
	);
});
