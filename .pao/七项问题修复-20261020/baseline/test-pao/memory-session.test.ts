/** 离线模拟供应商；不代表正式 gbrain 验收。 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { listPaoSubcommands } from "../../src/pao/command-router.ts";
import type { MemoryVendor } from "../../src/pao/memory/memory-vendor.ts";
import { correctMemory, registerMemoryCommand, SessionMemory, sessionMemory } from "../../src/pao/memory/session.ts";

function vendor(): MemoryVendor {
	return {
		vendorName: "模拟",
		capabilities: { 忘却: true, 语义检索: false, 需嵌入端点: false },
		start: async () => {},
		close: async () => {},
		recall: async () => [],
		write: vi.fn(async () => ({ 记忆ID: "new", 状态: "inserted" })),
		forget: vi.fn(async () => 1),
	};
}

describe("会话记忆和两步纠正", () => {
	it("同一会话恢复保留排除和纠正，损坏记录拒绝恢复", () => {
		const original = new SessionMemory();
		original.record([{ 内容: "旧事实", 记忆ID: "old" }], "模拟");
		original.exclude(original.injected[0], "新事实");
		const restored = new SessionMemory();
		restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
		expect(restored.record([{ 内容: "旧事实", 记忆ID: "old" }], "模拟")).toEqual([]);
		expect(restored.corrections[0]).toContain("新事实");
		expect(() => restored.restore({ version: 1, injected: [] })).toThrow("损坏");
	});
	it("终端取消确认不获取供应商、不写共享库", async () => {
		const pi = {} as ExtensionAPI;
		const getManager = vi.fn();
		registerMemoryCommand(pi, getManager, () => "unused");
		sessionMemory(pi).record([{ 内容: "旧事实", 记忆ID: "old" }], "模拟");
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "test" },
			ui: { confirm: vi.fn(async () => false), notify: vi.fn() },
		};
		await listPaoSubcommands(pi)
			.find((item) => item.name === "memory")
			?.run(pi, "correct 1 新事实", ctx);
		expect(getManager).not.toHaveBeenCalled();
		expect(ctx.ui.confirm.mock.calls[0]).toBeDefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith("已取消，未修改共享记忆。", "info");
	});
	it("确认期间切会话使旧确认失效", async () => {
		const pi = {} as ExtensionAPI;
		const getManager = vi.fn();
		registerMemoryCommand(pi, getManager, () => "unused");
		const state = sessionMemory(pi);
		state.record([{ 内容: "旧事实", 记忆ID: "old" }], "模拟");
		const ctx = {
			hasUI: true,
			sessionManager: { getSessionId: () => "test" },
			ui: {
				confirm: async () => {
					state.reset();
					return true;
				},
				notify: vi.fn(),
			},
		};
		await listPaoSubcommands(pi)
			.find((item) => item.name === "memory")
			?.run(pi, "forget 1", ctx);
		expect(getManager).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("会话已切换，旧确认失效；未修改共享记忆。", "warning");
	});
	it("无 ID 也能本会话排除，保留已注入记录，新会话不继承排除", () => {
		const state = new SessionMemory();
		const hit = { 内容: "旧事实" };
		state.record([hit], "模拟");
		state.exclude(state.injected[0], "新事实");
		expect(state.record([hit], "模拟")).toEqual([]);
		expect(state.view()).toContain("已发送不能撤回");
		expect(state.view()).toContain("置信度：未知");
		expect(state.corrections[0]).toContain("新事实");
		state.reset();
		expect(state.record([hit], "模拟")).toHaveLength(1);
		expect(state.corrections).toEqual([]);
	});
	it("不同供应商相同 ID 不互相排除", () => {
		const state = new SessionMemory();
		state.record([{ 内容: "甲", 记忆ID: "1" }], "甲库");
		state.exclude(state.injected[0]);
		expect(state.record([{ 内容: "乙", 记忆ID: "1" }], "乙库")).toHaveLength(1);
	});
	it("忘旧失败仍返回新 ID 与部分成功", async () => {
		const fake = vendor();
		fake.forget = vi.fn(async () => {
			throw new Error("断链");
		});
		const result = await correctMemory(fake, "old", "新事实");
		expect(result.状态).toBe("部分成功");
		expect(result.新记忆?.记忆ID).toBe("new");
		expect(result.说明).toContain("断链");
	});
	it("写入期间切会话保留新 ID，但不继续忘旧", async () => {
		const fake = vendor();
		let active = true;
		fake.write = async () => {
			active = false;
			return { 记忆ID: "new", 状态: "inserted" };
		};
		const result = await correctMemory(fake, "old", "新事实", () => active);
		expect(result.状态).toBe("部分成功");
		expect(result.新记忆?.记忆ID).toBe("new");
		expect(fake.forget).not.toHaveBeenCalled();
	});
	it("写新失败不能忘旧", async () => {
		const fake = vendor();
		fake.write = vi.fn(async () => {
			throw new Error("拒写");
		});
		await expect(correctMemory(fake, "old", "新事实")).rejects.toThrow("拒写");
		expect(fake.forget).not.toHaveBeenCalled();
	});
	it("写入没有 ID 时保留旧条", async () => {
		const fake = vendor();
		fake.write = vi.fn(async () => {});
		expect((await correctMemory(fake, "old", "新事实")).状态).toBe("部分成功");
		expect(fake.forget).not.toHaveBeenCalled();
	});
	it("同 ID 去重返回不能删掉唯一事实", async () => {
		const fake = vendor();
		fake.write = vi.fn(async () => ({ 记忆ID: "old", 状态: "duplicate" }));
		expect((await correctMemory(fake, "old", "新事实")).状态).toBe("部分成功");
		expect(fake.forget).not.toHaveBeenCalled();
	});
	it("缺 ID、不支持忘却都不写新", async () => {
		const fake = vendor();
		await expect(correctMemory(fake, "", "新事实")).rejects.toThrow("准确 ID");
		fake.capabilities.忘却 = false;
		await expect(correctMemory(fake, "old", "新事实")).rejects.toThrow("不支持忘却");
		expect(fake.write).not.toHaveBeenCalled();
	});
	it("完整两步顺序及回执", async () => {
		const fake = vendor();
		const calls: string[] = [];
		fake.write = async () => {
			calls.push("写");
			return { 记忆ID: "new", 状态: "inserted" };
		};
		fake.forget = async () => {
			calls.push("忘");
			return 1;
		};
		expect((await correctMemory(fake, "old", "新事实")).状态).toBe("完成");
		expect(calls).toEqual(["写", "忘"]);
	});
});
