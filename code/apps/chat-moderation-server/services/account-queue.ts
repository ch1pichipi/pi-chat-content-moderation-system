/**
 * 按账号串行 + 全局并发的任务队列。
 *
 * 语义：
 *   - 同一账号同一时间只允许一个任务（worker）在跑；
 *   - 账号在 debounceMs 内连续入队只触发一次，消息突发不会每条都调用模型；
 *   - 任务运行期间再次入队，会在当前任务结束后补跑一次（合并为一次）；
 *   - 全局并发由 concurrency 限制。
 *
 * 与数据库无关，便于单元测试防抖与并发行为。
 */

export interface AccountQueueOptions<T> {
	/** 防抖时间（毫秒）；0 表示不防抖。 */
	debounceMs: number;
	/** 全局并发上限。 */
	concurrency: number;
	worker: (account: string) => Promise<T>;
	onError?: (account: string, error: unknown, phase: "enqueue" | "runNow") => void;
}

export class AccountQueue<T = void> {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly running = new Set<string>();
	private readonly rerun = new Set<string>();
	private readonly slotWaiters: Array<() => void> = [];
	private idleResolvers: Array<() => void> = [];
	private activeRuns = 0;
	private stopped = false;

	constructor(private readonly options: AccountQueueOptions<T>) {
		if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
			throw new Error("concurrency 必须是 >= 1 的整数");
		}
		if (!Number.isFinite(options.debounceMs) || options.debounceMs < 0) {
			throw new Error("debounceMs 必须是非负数字");
		}
	}

	/** 入队（防抖）；同一账号的连续调用只保留最后一次调度。 */
	enqueue(account: string): void {
		if (this.stopped) return;
		this.schedule(account, this.options.debounceMs);
	}

	/** 跳过防抖立即执行；若该账号已在运行则合并并返回 null。 */
	async runNow(account: string): Promise<T | null> {
		const timer = this.timers.get(account);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(account);
		}
		return this.run(account, "runNow");
	}

	async waitForIdle(timeoutMs = 30_000): Promise<void> {
		if (this.isIdle()) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.idleResolvers = this.idleResolvers.filter((item) => item !== onIdle);
				reject(new Error("等待队列空闲超时"));
			}, timeoutMs);
			timer.unref?.();
			const onIdle = () => {
				clearTimeout(timer);
				resolve();
			};
			this.idleResolvers.push(onIdle);
		});
	}

	pendingCount(): number {
		return this.timers.size + this.running.size;
	}

	stop(): void {
		this.stopped = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.rerun.clear();
		for (const wake of this.slotWaiters.splice(0)) wake();
		this.checkIdle();
	}

	private isIdle(): boolean {
		return (
			this.timers.size === 0 &&
			this.running.size === 0 &&
			this.rerun.size === 0 &&
			this.activeRuns === 0 &&
			this.slotWaiters.length === 0
		);
	}

	private checkIdle(): void {
		if (!this.isIdle()) return;
		for (const resolve of this.idleResolvers.splice(0)) resolve();
	}

	private schedule(account: string, delayMs: number): void {
		const existing = this.timers.get(account);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.timers.delete(account);
			void this.run(account, "enqueue");
		}, delayMs);
		timer.unref?.();
		this.timers.set(account, timer);
	}

	private async acquireSlot(): Promise<void> {
		while (!this.stopped && this.activeRuns >= this.options.concurrency) {
			await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
		}
		this.activeRuns++;
	}

	private releaseSlot(): void {
		this.activeRuns = Math.max(0, this.activeRuns - 1);
		this.slotWaiters.shift()?.();
	}

	private async run(account: string, phase: "enqueue" | "runNow"): Promise<T | null> {
		if (this.stopped) return null;
		if (this.running.has(account)) {
			// 同一账号正在跑：当前任务结束后补跑一次，避免并发调用模型。
			this.rerun.add(account);
			return null;
		}

		this.running.add(account);
		let result: T | null = null;
		try {
			await this.acquireSlot();
			if (this.stopped) return null;
			result = await this.options.worker(account);
			return result;
		} catch (error) {
			this.options.onError?.(account, error, phase);
			return null;
		} finally {
			this.running.delete(account);
			this.releaseSlot();
			if (this.rerun.delete(account) && !this.stopped) {
				this.schedule(account, this.options.debounceMs);
			}
			this.checkIdle();
		}
	}
}
