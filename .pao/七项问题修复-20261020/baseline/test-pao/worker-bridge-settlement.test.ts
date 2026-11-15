import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import * as bridges from "../../src/pao/worker/session-bridge.ts";
import * as processes from "../../src/utils/child-process.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["记录", "会话路径"] as const)("模拟映射%s结算失败仍保留真实子进程回执及用量", async (failure) => {
	const root = mkdtempSync(join(tmpdir(), "pao-bridge-settlement-"));
	dirs.push(root);
	const create = bridges.createWorkerSessionBridge;
	vi.spyOn(bridges, "createWorkerSessionBridge").mockImplementation((input) => {
		const bridge = create(input);
		return {
			...bridge,
			sessionPath: () => {
				if (failure === "会话路径") throw new Error("模拟目录读取失败");
				return undefined;
			},
			record: (state, detail) => {
				if (failure === "记录" && state !== "运行中") throw new Error("模拟磁盘写入失败");
				bridge.record(state, detail);
			},
		};
	});
	const message = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "模拟完成" }],
			usage: { input: 10, output: 5, cost: { total: 0.125 } },
			stopReason: "stop",
		},
	};
	// 真实 Node 子进程，供应商响应为明确标注的离线模拟。
	vi.spyOn(processes, "spawnProcess").mockImplementation(() =>
		spawn(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(message))})`], {
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	const runner = new WorkerRunner({ 证据目录: join(root, "证据") });
	const receipt = await runner.run({
		卡号: "0001",
		卡路径: join(root, ".pao/卡/卡0001.md"),
		cwd: root,
		提示词: "离线模拟",
	});
	expect(receipt.status).toBe("failed");
	expect(receipt.summary).toContain("会话映射结算失败");
	expect(receipt.failure_type).toBe("transient");
	expect(receipt.usage.cost).toBe(0.125);
	expect(receipt.usage.turns).toBe(1);
	expect(readFileSync(receipt.evidence_path, "utf8")).toContain("模拟完成");
	expect(readFileSync(receipt.映射路径!, "utf8")).toContain("运行中");
	expect(runner.listActive()).toHaveLength(0);
	expect(() => runner.confirmStopped(receipt.card_path!)).not.toThrow();
});
