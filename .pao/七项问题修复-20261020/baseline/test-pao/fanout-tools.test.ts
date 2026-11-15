import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard } from "../../src/pao/cards/index.ts";
import { registerFanout } from "../../src/pao/fanout/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-fanout-tools-"));
	tempDirs.push(dir);
	return dir;
}

/** 假 worker:发一条成功事件即退 */
const OK_SCRIPT = `
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({result:"success",artifact_path:[],summary:"完成"}) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
`;

interface Captured {
	tools: {
		name: string;
		execute: (...args: unknown[]) => Promise<{ content: { text?: string }[]; details: unknown; isError?: boolean }>;
	}[];
	pi: ExtensionAPI;
}

function capturePi(): Captured {
	const captured: Captured = { tools: [], pi: undefined as unknown as ExtensionAPI };
	captured.pi = {
		registerTool: (tool: { name: string }) => captured.tools.push(tool as never),
		on: () => () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return captured;
}

describe("registerFanout:pao_fanout 工具", () => {
	it("注册 pao_fanout,执行后返回聚合摘要(中文文本 + details);卡逐张认领并落回执", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(cardsDir, { recursive: true });
		// 计数器显式放本任务临时目录:缺省会落到 Temp 根,跨测试共用会串号
		const counterOptions = { counterPath: join(dir, "卡号.txt") };
		await createCard(
			cardsDir,
			{ 目标: "任务一", 部门: "测试", 验收: "完成", 创建: "2026-10-02 10:00" },
			counterOptions,
		);
		await createCard(
			cardsDir,
			{ 目标: "任务二", 部门: "测试", 验收: "完成", 创建: "2026-10-02 10:00" },
			counterOptions,
		);
		const script = join(dir, "fake-ok.js");
		writeFileSync(script, OK_SCRIPT, "utf8");
		const runner = new WorkerRunner();
		const captured = capturePi();
		registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 命令: process.execPath, 参数: [script], 证据目录: join(dir, "证据") },
		});

		expect(captured.tools.map((t) => t.name)).toEqual(["pao_fanout"]);
		const tool = captured.tools[0];
		const result = await tool.execute(
			"t1",
			{ card_refs: ["卡#1", "卡0002"], max_concurrency: 2, reason: "回归:双卡扇出基础链路" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		expect(String(result.content[0]?.text)).toContain("扇出完成:2 张卡(并发上限 2)");
		expect(String(result.content[0]?.text)).toContain("成功 2");
		const summary = result.details as { count: { 成功: number } };
		expect(summary.count.成功).toBe(2);
	}, 30_000);

	it("缺卡目录:未传 卡目录 且未配置 resolver 时报错不执行", async () => {
		const captured = capturePi();
		registerFanout(captured.pi, {});
		const tool = captured.tools[0];
		const result = await tool.execute("t2", { card_refs: ["1"] }, undefined, undefined, {} as never);
		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("缺少 cards_dir");
	});

	it("坏卡引用:整批不执行,报扇出未执行(发号前拦截,不产生半残批次)", async () => {
		const captured = capturePi();
		registerFanout(captured.pi, { resolveCardsDir: () => tempDir() });
		const tool = captured.tools[0];
		const result = await tool.execute("t3", { card_refs: ["abc"] }, undefined, undefined, {} as never);
		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain("扇出未执行");
	});
});
