/**
 * 记忆工具的取消语义（fork 审查第 1 项，阶段 1）。
 *
 * 反例原文：记忆写入工具正在等待供应商启动时用户取消本轮，取消发生在实际 write 之前，
 * 模拟供应商仍记录 writes:1 且工具返回“已写入记忆库”。
 * 本文件把该反例及同族窗口固化为回归：进入工具前、等待启动期间、启动完成到实际调用之间
 * 三个定点都必须“供应商调用次数为 0”；已完成的外部写入只如实告知，不伪造撤回。
 * 全部使用可数调用的假供应商，不起子进程、不连真实端点。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createVendorRecall, registerMemory } from "../../src/pao/memory/index.ts";
import {
	type MemoryHit,
	type MemoryVendor,
	MemoryVendorManager,
	registerMemoryVendor,
} from "../../src/pao/memory/memory-vendor.ts";
import { sessionMemory } from "../../src/pao/memory/session.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-memory-cancel-"));
	tempDirs.push(dir);
	return dir;
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: { cancelled?: boolean; status?: string };
	isError?: boolean;
}

type ToolLike = { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };

/** 假供应商：只计数，不落任何外部状态 */
function fakeVendor(
	name: string,
	behavior: { 启动?: () => Promise<void>; 写入?: () => Promise<void>; 召回?: () => Promise<MemoryHit[]> } = {},
) {
	const calls = { 启动: 0, 写入: 0, 召回: 0, 关闭: 0 };
	const vendor: MemoryVendor = {
		vendorName: name,
		capabilities: { 语义检索: false, 需嵌入端点: false, 忘却: false },
		start: async () => {
			calls.启动++;
			await behavior.启动?.();
		},
		write: async () => {
			calls.写入++;
			await behavior.写入?.();
		},
		recall: async () => {
			calls.召回++;
			return (await behavior.召回?.()) ?? [];
		},
		close: async () => {
			calls.关闭++;
		},
	};
	return { vendor, calls };
}

/** 走正式注册入口拿三个工具，并给出允许外发的隔离配置 */
function mount(name: string, factory: () => MemoryVendor) {
	registerMemoryVendor(name, factory);
	const dir = tempDir();
	mkdirSync(join(dir, "pao配置"), { recursive: true });
	const configPath = join(dir, "pao配置", "记忆供应商.json");
	writeFileSync(configPath, JSON.stringify({ 供应商: name, 参数: {} }), "utf8");
	const tools = new Map<string, ToolLike>();
	const handlers = new Map<string, () => unknown>();
	const pi = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		on: (event: string, handler: () => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const manager = registerMemory(pi, {
		resolveConfigPath: () => configPath,
		onWarn: () => {},
		outbound: { projects: { [basename(dir)]: { allowed: true, asOf: "2099-12-31" } } },
	});
	const tool = (toolName: string) => tools.get(toolName)!;
	const ctx = { cwd: dir } as never;
	return { manager, tool, ctx, pi, handlers };
}

describe("记忆工具取消（审查第 1 项）", () => {
	it("定点①：进入工具前本轮已取消 → 不触达供应商，写次数 0", async () => {
		const created = fakeVendor("取消-入口前");
		const mounted = mount("取消-入口前", () => created.vendor);
		const controller = new AbortController();
		controller.abort();

		const result = await mounted
			.tool("pao_memory_write")
			.execute("t1", { content: "用户在 Windows 上开发" }, controller.signal, undefined, mounted.ctx);

		expect(created.calls.写入).toBe(0);
		expect(created.calls.启动).toBe(0); // 连供应商都没拉起来
		expect(result.details?.cancelled).toBe(true);
		expect(result.content[0]!.text).toContain("没有产生任何外部写入");
	});

	it("定点②：等待供应商启动期间取消 → 不触达供应商，写次数 0", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const created = fakeVendor("取消-启动中", { 启动: () => gate });
		const mounted = mount("取消-启动中", () => created.vendor);
		const controller = new AbortController();

		const pending = mounted
			.tool("pao_memory_write")
			.execute("t2", { content: "事实" }, controller.signal, undefined, mounted.ctx);
		// 供应商还卡在启动里，此时用户取消本轮
		controller.abort();
		release();
		const result = await pending;

		expect(created.calls.启动).toBe(1);
		expect(created.calls.写入).toBe(0);
		expect(result.details?.cancelled).toBe(true);
	});

	it("定点③：供应商已就绪、取消抢在 acquire 返回之前 → 写次数 0", async () => {
		const created = fakeVendor("取消-就绪");
		const mounted = mount("取消-就绪", () => created.vendor);
		const controller = new AbortController();
		// 先拉起：首个 acquire 在供应商就绪的同一个微任务窗口里触发取消
		const first = mounted
			.tool("pao_memory_write")
			.execute("t0", { content: "预热" }, undefined, undefined, mounted.ctx);
		await first; // 就绪
		expect(created.calls.写入).toBe(1);

		queueMicrotask(() => controller.abort());
		const result = await mounted
			.tool("pao_memory_write")
			.execute("t3", { content: "第二批事实" }, controller.signal, undefined, mounted.ctx);

		expect(created.calls.写入).toBe(1); // 只有预热那一次
		expect(result.details?.cancelled).toBe(true);
	});

	it("写入已提交后才取消 → 如实反馈不能撤回，不返回“已取消”", async () => {
		const controller = new AbortController();
		const created = fakeVendor("取消-写入后", { 写入: async () => controller.abort() });
		const mounted = mount("取消-写入后", () => created.vendor);

		const result = await mounted
			.tool("pao_memory_write")
			.execute("t4", { content: "事实" }, controller.signal, undefined, mounted.ctx);

		expect(created.calls.写入).toBe(1);
		expect(result.details?.cancelled).toBeUndefined();
		expect(result.content[0]!.text).toContain("不能撤回");
	});

	it("召回：会话已切换（代际变化）时旧会话结果不注入新会话", async () => {
		const created = fakeVendor("取消-召回");
		const mounted = mount("取消-召回", () => created.vendor);
		const state = sessionMemory(mounted.pi);
		created.vendor.recall = async () => {
			created.calls.召回++;
			state.reset(); // 召回在途时会话切换/分支树重放
			return [{ 内容: "旧会话的命中" }];
		};

		const result = await mounted
			.tool("pao_memory_recall")
			.execute("t5", { query: "任意" }, undefined, undefined, mounted.ctx);

		expect(result.details?.cancelled).toBe(true);
		expect(state.injected).toHaveLength(0);
	});

	it("忘却：进入前已取消 → 不触达供应商", async () => {
		const created = fakeVendor("取消-忘却");
		const mounted = mount("取消-忘却", () => created.vendor);
		const controller = new AbortController();
		controller.abort();

		const result = await mounted
			.tool("pao_memory_forget")
			.execute("t6", { memory_id: "1", confirm: true }, controller.signal, undefined, mounted.ctx);

		expect(created.calls.写入).toBe(0);
		expect(created.calls.启动).toBe(0);
		expect(result.details?.cancelled).toBe(true);
	});
});

describe("自动查库语义召回取消（审查第 4 项）", () => {
	it("等待管理器启动期间取消 → 立即返回取消原因，迟到启动仍完成并保留共享实例", async () => {
		let releaseStart: () => void = () => {};
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const created = fakeVendor("查库取消-启动中", { 启动: () => startGate });
		const name = "查库取消-启动中";
		registerMemoryVendor(name, () => created.vendor);
		const manager = new MemoryVendorManager({ 供应商: name, 参数: {} }, () => {});
		const controller = new AbortController();
		const recall = createVendorRecall(() => manager);
		const pending = recall("任意", 3, controller.signal);

		controller.abort(new Error("用户取消自动查库"));
		await expect(pending).rejects.toMatchObject({ name: "Error", message: "用户取消自动查库" });
		expect(created.calls.启动).toBe(1);
		expect(created.calls.召回).toBe(0);

		releaseStart();
		await expect.poll(() => manager.status).toBe("已就绪");
		expect(await manager.acquire()).toBe(created.vendor);
		expect(created.calls.启动).toBe(1);
		expect(created.calls.关闭).toBe(0);
	});

	it("取消前已触发召回时，不支持信号的供应商迟到成功被观察且不报未处理拒绝", async () => {
		let releaseRecall: (hits: MemoryHit[]) => void = () => {};
		const recallGate = new Promise<MemoryHit[]>((resolve) => {
			releaseRecall = resolve;
		});
		const created = fakeVendor("查库取消-召回中");
		let entered!: () => void;
		const enteredRecall = new Promise<void>((resolve) => {
			entered = resolve;
		});
		created.vendor.recall = async () => {
			created.calls.召回++;
			entered();
			return recallGate;
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const name = "查库取消-召回中";
			registerMemoryVendor(name, () => created.vendor);
			const manager = new MemoryVendorManager({ 供应商: name, 参数: {} }, () => {});
			const controller = new AbortController();
			const recall = createVendorRecall(() => manager);
			const pending = recall("任意", 3, controller.signal);
			await enteredRecall;

			controller.abort(new Error("用户取消召回"));
			await expect(pending).rejects.toThrow("用户取消召回");
			releaseRecall([{ 内容: "迟到命中" }]);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(unhandled).toEqual([]);
			expect(created.calls.关闭).toBe(0);
			expect(manager.status).toBe("已就绪");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("取消后到达的供应商失败被观察，不报未处理拒绝", async () => {
		let rejectRecall: (error: Error) => void = () => {};
		const recallGate = new Promise<MemoryHit[]>((_resolve, reject) => {
			rejectRecall = reject;
		});
		const created = fakeVendor("查库取消-召回落败");
		let entered!: () => void;
		const enteredRecall = new Promise<void>((resolve) => {
			entered = resolve;
		});
		created.vendor.recall = async () => {
			created.calls.召回++;
			entered();
			return recallGate;
		};
		const name = "查库取消-召回落败";
		registerMemoryVendor(name, () => created.vendor);
		const manager = new MemoryVendorManager({ 供应商: name, 参数: {} }, () => {});
		const controller = new AbortController();
		const recall = createVendorRecall(() => manager);
		const pending = recall("任意", 3, controller.signal);
		await enteredRecall;

		controller.abort("用户取消召回落败");
		await expect(pending).rejects.toBe("用户取消召回落败");
		rejectRecall(new Error("延迟失败"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(created.calls.关闭).toBe(0);
		expect(manager.status).toBe("已就绪");
	});
});
