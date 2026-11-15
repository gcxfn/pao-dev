/**
 * 扇出回执投递与任务根共享锁的边界。
 *
 * 测试使用真实临时文件、真实卡、真实派发路径和真实任务根共享锁；FakeRunner
 * 只替换 WorkerRunner.run，不初始化 Git、不启动模型或工人进程。证明 onReceipt
 * 在 executeDispatch 释放锁后才执行，并且投递失败仍保留已落卡回执、结果说明和告警。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCard, readCard } from "../../src/pao/cards/index.ts";
import { executeFanout, type FanoutCardResult } from "../../src/pao/fanout/execute.ts";
import { acquireSharedLock, releaseSharedLock } from "../../src/pao/worker/lock.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

function fixture(): { root: string; cardsDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pao-fanout-receipt-lock-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	writeFileSync(join(root, "README.md"), "锁边界测试\n");
	return { root, cardsDir };
}

class CompletedRunner extends WorkerRunner {
	private runs = 0;

	override async run(options: WorkerRunOptions) {
		const pid = 920000 + this.runs++;
		this.registry.register({
			pid,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			command: "offline-completed-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		this.registry.markExited(pid);
		return {
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: "success" as const,
			artifact_path: [],
			summary: "离线回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			工具调用次数: 0,
			evidence_path: "",
			exitCode: 0,
			command: "offline-completed-runner",
			pid,
			duration_ms: 1,
		};
	}
}

async function makeCard(cardsDir: string): Promise<void> {
	await createCard(
		cardsDir,
		{ 目标: "回执锁边界", 部门: "测试", 验收: "完成", 创建: "2026-10-26 22:00" },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}

function onlyResult(results: FanoutCardResult[]): FanoutCardResult {
	const result = results[0];
	if (!result) throw new Error("扇出结果缺失");
	return result;
}

describe("扇出回执投递锁边界", () => {
	it("onReceipt 在 executeDispatch 返回后调用，可立即取得同一任务根共享锁", async () => {
		const { root, cardsDir } = fixture();
		await makeCard(cardsDir);
		let acquired = false;

		const summary = await executeFanout(
			{ 卡号列表: ["1"], 并发上限: 1, cardsDir },
			{
				运行器: new CompletedRunner(),
				async onReceipt() {
					const lock = await acquireSharedLock({ root, holder: "onReceipt", retries: 0 });
					acquired = true;
					await releaseSharedLock(lock);
				},
			},
		);

		expect(acquired).toBe(true);
		expect(onlyResult(summary.结果)).toMatchObject({ 终态: "成功", 回执落卡: "已记录" });
	});

	it("直接上级投递失败仍保留已落卡回执、结果说明和告警", async () => {
		const { cardsDir } = fixture();
		await makeCard(cardsDir);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const summary = await executeFanout(
			{ 卡号列表: ["1"], 并发上限: 1, cardsDir },
			{
				运行器: new CompletedRunner(),
				onReceipt() {
					throw new Error("部长 RPC 不可用");
				},
			},
		);

		const result = onlyResult(summary.结果);
		expect(result).toMatchObject({
			终态: "成功",
			回执落卡: "已记录",
			落卡说明: "回执已落卡，但直接上级投递失败:部长 RPC 不可用",
		});
		expect(readCard(join(cardsDir, "卡0001-回执锁边界.md")).receipts).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith("[pao] 卡0001回执已落卡，但直接上级投递失败:部长 RPC 不可用");
	});
});
