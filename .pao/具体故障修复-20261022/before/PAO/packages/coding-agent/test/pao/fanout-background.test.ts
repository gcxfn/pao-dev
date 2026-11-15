/**
 * §20 后台扇出单测：后台:true＝派完就走——受理摘要立即返回（不等 worker）、
 * 完成摘要下一轮 before_agent_start 注入 pao-fanout-done section（消费式清空、R25 运行态标注）、
 * 缺省 false 同步行为不变（阻塞到聚合摘要）。
 * 真子进程假 worker（同 fanout-run.test.ts 惯例），不依赖模型端点。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// §23 toast 接线随后台 settle 触发:测试环境关弹(PAO_TOAST_OFF 环境级总闸,非业务开关)
beforeAll(() => {
	process.env.PAO_TOAST_OFF = "1";
});

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard } from "../../src/pao/cards/index.ts";
import { FANOUT_BACKGROUND_SECTION, registerFanout } from "../../src/pao/fanout/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
const runners: WorkerRunner[] = [];

afterEach(async () => {
	await Promise.all(runners.splice(0).map((runner) => runner.stopAll()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-fanout-bg-"));
	tempDirs.push(dir);
	return dir;
}

/** 假 worker:睡 PAO_FANOUT_SLEEP 毫秒后交成功回执退出（同 fanout-run 惯例的精简版） */
const SLEEP_SCRIPT = `
const card = process.env.PAO_FANOUT_CARD;
setTimeout(() => {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({result:"success",artifact_path:[],summary:"done " + card}) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
}, Number(process.env.PAO_FANOUT_SLEEP || "0"));
`;

type AnyHandler = (event: never, ctx: unknown) => unknown;

function capturePi() {
	const sent: unknown[] = [];
	const tools = new Map<string, { name: string; execute: (id: string, params: any) => Promise<any> }>();
	const handlers = new Map<string, AnyHandler[]>();
	const pi = {
		registerTool: (tool: { name: string; execute: (id: string, params: any) => Promise<any> }) =>
			tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: (message: unknown) => {
			sent.push(message);
		},
		on: (event: string, handler: AnyHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { tools, handlers, pi, sent };
}

async function fireTurn(captured: ReturnType<typeof capturePi>): Promise<Record<string, string>> {
	const sections: Record<string, string> = {};
	for (const handler of captured.handlers.get("before_agent_start") ?? []) {
		await handler({ systemPromptOptions: { sections } } as never, {});
	}
	return sections;
}

async function makeCards(cardsDir: string, count: number): Promise<void> {
	mkdirSync(cardsDir, { recursive: true });
	const counterPath = join(cardsDir, "..", "卡号.txt");
	for (let i = 1; i <= count; i++) {
		await createCard(
			cardsDir,
			{ 目标: `任务${i}`, 部门: "测试", 验收: "完成", 创建: "2026-10-03 12:00" },
			{ counterPath },
		);
	}
}

async function runTool(captured: ReturnType<typeof capturePi>, params: Record<string, unknown>): Promise<string> {
	const tool = captured.tools.get("pao_fanout");
	if (!tool) throw new Error("pao_fanout 未注册");
	const result = await tool.execute("test-call", params);
	return result.content.map((part: { text: string }) => part.text).join("\n");
}

/** 轮询等后台完成摘要进注入面（真子进程完成有时延,观察面轮询而非读一次） */
async function waitForSection(captured: ReturnType<typeof capturePi>, deadlineMs = 15_000): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		const sections = await fireTurn(captured);
		const text = sections[FANOUT_BACKGROUND_SECTION];
		if (text !== undefined) return text;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("后台完成摘要超时未注入");
}

describe("§21 后台区计数（registerFanout 返回 后台计数 快照）", () => {
	it("受理即在途+1；settle 后在途归零、完成未读=1；注入后完成未读归零", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 1);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		const { backgroundCount } = registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script], 环境变量: { PAO_FANOUT_SLEEP: "600" } }),
		});
		expect(backgroundCount()).toEqual({ in_flight: 0, completed_unread: 0 });

		await runTool(captured, { card_refs: ["1"], reason: "测试计数", background: true });
		// 受理瞬间:在飞中(worker 睡 600ms,此时一定未 settle)
		expect(backgroundCount()).toEqual({ in_flight: 1, completed_unread: 0 });

		await waitForSection(captured);
		// 注入成功＝已 settle:在途归零;注入即消费,完成未读也归零
		expect(backgroundCount()).toEqual({ in_flight: 0, completed_unread: 0 });
	}, 30_000);

	it("settle 后未注入前：在途 0、完成未读 1（计数与注入面独立——不 fireTurn 也可见）", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 1);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		const { backgroundCount } = registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script], 环境变量: { PAO_FANOUT_SLEEP: "0" } }),
		});
		await runTool(captured, { card_refs: ["1"], reason: "测试未读", background: true });
		// 轮询计数等 settle（不 fireTurn——注入面不动,计数先亮）
		const start = Date.now();
		while (backgroundCount().completed_unread === 0 && Date.now() - start < 15_000) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(backgroundCount()).toEqual({ in_flight: 0, completed_unread: 1 });
	}, 30_000);

	it("零行为回归：同步扇出（不传 后台）不进计数", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 1);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		const { backgroundCount } = registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script], 环境变量: { PAO_FANOUT_SLEEP: "0" } }),
		});
		const text = await runTool(captured, { card_refs: ["1"], reason: "同步不计数" });
		expect(text).toContain("扇出完成:1 张卡");
		expect(backgroundCount()).toEqual({ in_flight: 0, completed_unread: 0 });
	}, 30_000);
});

describe("§20 后台扇出（派完就走）", () => {
	it("后台:true 受理即返回（不等 worker），完成摘要下一轮注入且带 R25 运行态标注", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 2);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script], 环境变量: { PAO_FANOUT_SLEEP: "600" } }),
		});

		const startedAt = Date.now();
		const text = await runTool(captured, { card_refs: ["1", "2"], reason: "测试后台受理", background: true });
		const elapsed = Date.now() - startedAt;
		// 受理即返回：不等 600ms 睡眠的 worker（留足余量防慢机假失败——断言不晚于 worker 睡眠的一半）
		expect(elapsed).toBeLessThan(300);
		expect(text).toContain("后台扇出已受理:2 张卡");
		// 受理摘要照实报收敛后的并发上限(planFanout: min(缺省3, 卡数2)=2)
		expect(text).toContain("并发上限 2");
		expect(text).toContain("pao_inventory");
		expect(text).toContain("主会话关闭全停");
		expect(text).not.toContain("扇出完成");

		const section = await waitForSection(captured);
		expect(section).toContain("[pao 后台扇出完成摘要]");
		expect(section).toContain("扇出完成:2 张卡");
		expect(section).toContain("成功 2");
		expect(section).toContain("卡文件状态与回执是真相");
	}, 30_000);

	it("消费式：完成摘要注入一轮即清空，第二轮不再注入", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 1);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script], 环境变量: { PAO_FANOUT_SLEEP: "0" } }),
		});
		await runTool(captured, { card_refs: ["1"], reason: "测试消费式", background: true });
		const first = await waitForSection(captured);
		expect(first).toContain("扇出完成:1 张卡");
		const second = await fireTurn(captured);
		expect(second[FANOUT_BACKGROUND_SECTION]).toBeUndefined();
	}, 30_000);

	it("零行为回归：不传 后台 参数＝同步阻塞到聚合摘要（行为不变）", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 1);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script], 环境变量: { PAO_FANOUT_SLEEP: "100" } }),
		});
		const text = await runTool(captured, { card_refs: ["1"], reason: "测试同步回归" });
		expect(text).toContain("扇出完成:1 张卡");
		expect(text).toContain("成功 1");
		// 同步路径不进后台摘要缓冲
		const sections = await fireTurn(captured);
		expect(sections[FANOUT_BACKGROUND_SECTION]).toBeUndefined();
	}, 30_000);

	it("后台真实子进程结束主动唤醒，续轮动态上下文包含完整结果且只消费一次", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 1);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		const background = registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script] }),
		});
		await runTool(captured, { card_refs: ["1"], reason: "验证主动投递", background: true });
		const deadline = Date.now() + 15_000;
		while (background.backgroundCount().in_flight > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(background.backgroundCount().in_flight).toBe(0);
		expect(captured.sent).toHaveLength(1);
		const sections: Record<string, string> = {};
		for (const handler of captured.handlers.get("context_with_system") ?? []) {
			const result = (await handler({ messages: [] } as never, {})) as
				| {
						messages?: Array<{ sections?: Record<string, string> }>;
				  }
				| undefined;
			for (const message of result?.messages ?? []) Object.assign(sections, message.sections);
		}
		expect(sections[FANOUT_BACKGROUND_SECTION]).toContain("扇出完成:1 张卡");
		expect((await fireTurn(captured))[FANOUT_BACKGROUND_SECTION]).toBeUndefined();
	}, 30_000);

	it("显式全停后取消真实后台子进程，不再投递唤醒或注入完成摘要", async () => {
		const dir = tempDir();
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 1);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-sleep.js");
		writeFileSync(script, SLEEP_SCRIPT, "utf8");
		const captured = capturePi();
		const background = registerFanout(captured.pi, {
			resolveCardsDir: () => cardsDir,
			runner,
			公共参数: { 命令: process.execPath, 证据目录: join(dir, "证据") },
			每卡参数: () => ({ 参数: [script], 环境变量: { PAO_FANOUT_SLEEP: "10000" } }),
		});
		await runTool(captured, { card_refs: ["1"], reason: "验证停止后不再唤醒", background: true });
		const deadline = Date.now() + 15_000;
		while (runner.listActive().length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(runner.listActive()).toHaveLength(1);
		await runner.stopAll();
		while (background.backgroundCount().in_flight > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(background.backgroundCount().in_flight).toBe(0);
		expect(runner.listActive()).toHaveLength(0);
		expect(captured.sent).toHaveLength(0);
		expect((await fireTurn(captured))[FANOUT_BACKGROUND_SECTION]).toBeUndefined();
	}, 30_000);
});
