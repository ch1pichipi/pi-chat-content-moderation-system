/**
 * 增量处理状态（游标式）。
 *
 * - 持久化 last_time：上次处理的最大 create_time。
 * - report_seq 每次进程启动从 0 开始，不持久化（与 Go 版本一致）。
 * - 采用"写临时文件 → rename"的原子写入方式。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseTime } from "../loader/time.ts";

interface StateFileShape {
	last_time?: string;
	lastTime?: string;
	updated_at?: string;
	updatedAt?: string;
}

export class IncrementalState {
	lastTime: Date | null = null;
	updatedAt: Date | null = null;

	constructor(public readonly filePath: string) {}

	/** 读取状态文件；文件不存在返回空状态（首次运行）。 */
	static async load(filePath: string): Promise<IncrementalState> {
		const state = new IncrementalState(filePath);
		let text: string;
		try {
			text = await readFile(filePath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return state;
			throw new Error(`读取状态文件失败: ${(error as Error).message}`);
		}

		let raw: StateFileShape;
		try {
			raw = JSON.parse(text) as StateFileShape;
		} catch (error) {
			throw new Error(`解析状态文件失败（文件可能已损坏）: ${(error as Error).message}`);
		}
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("解析状态文件失败（文件可能已损坏）: 顶层结构必须是对象");
		}

		const lastTimeRaw = raw.last_time ?? raw.lastTime ?? "";
		if (typeof lastTimeRaw === "string" && lastTimeRaw.trim() !== "") {
			const parsed = parseTime(lastTimeRaw);
			if (!parsed) {
				throw new Error(`解析状态文件失败: last_time 格式无法解析: ${lastTimeRaw}`);
			}
			state.lastTime = parsed;
		}

		const updatedRaw = raw.updated_at ?? raw.updatedAt ?? "";
		if (typeof updatedRaw === "string" && updatedRaw.trim() !== "") {
			state.updatedAt = parseTime(updatedRaw);
		}

		return state;
	}

	/** 仅当新时间更大时更新游标。 */
	updateLastTime(time: Date | null): void {
		if (!time) return;
		if (!this.lastTime || time.getTime() > this.lastTime.getTime()) {
			this.lastTime = time;
		}
	}

	/** 原子写入状态文件。 */
	async save(): Promise<void> {
		const updatedAt = new Date();
		const payload = {
			last_time: this.lastTime ? this.lastTime.toISOString() : null,
			updated_at: updatedAt.toISOString(),
		};
		const dir = path.dirname(this.filePath);
		await mkdir(dir, { recursive: true });
		const tmpPath = `${this.filePath}.tmp`;
		try {
			await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
			await rename(tmpPath, this.filePath);
		} catch (error) {
			await rm(tmpPath, { force: true }).catch(() => undefined);
			throw new Error(`保存状态文件失败: ${(error as Error).message}`);
		}
		this.updatedAt = updatedAt;
	}
}

let processReportSeq = 0;

/** 报告序号递增并返回新序号（每个进程从 1 开始）。 */
export function nextReportSeq(): number {
	processReportSeq += 1;
	return processReportSeq;
}

/** 重置报告序号，仅用于测试或显式重新开始计数。 */
export function resetReportSeq(): void {
	processReportSeq = 0;
}
