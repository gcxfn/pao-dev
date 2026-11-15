/** 离线模拟供应商；不代表正式 gbrain 验收。 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { listPaoSubcommands } from "../../src/pao/command-router.ts";
import type { MemoryVendor } from "../../src/pao/memory/memory-vendor.ts";
import {
	AUTO_RECALL_HIT_LIMIT,
	correctMemory,
	registerMemoryCommand,
	SessionMemory,
	sessionMemory,
} from "../../src/pao/memory/session.ts";

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
	it("同一批同正文换 ID 不重复；跨调用是否仍需要由当前上下文重新判断", () => {
		const state = new SessionMemory();
		expect(
			state.record(
				[
					{ 内容: "稳定事实", 记忆ID: "old-id" },
					{ 内容: "稳定事实", 记忆ID: "new-id" },
				],
				"甲库",
			),
		).toHaveLength(1);
		expect(state.record([{ 内容: "另一事实", 记忆ID: "old-id" }], "乙库")).toHaveLength(1);
		const restored = new SessionMemory();
		state.exclude(state.injected[1]);
		restored.restore(JSON.parse(JSON.stringify(state.snapshot())));
		expect(restored.record([{ 内容: "另一事实", 记忆ID: "old-id" }], "乙库")).toEqual([]);
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
	it("按供应商＋记忆 ID 识别内容身份；不同供应商的同 ID 不误删", () => {
		const state = new SessionMemory();
		const hit = { 内容: "同一事实", 记忆ID: "shared" };
		const first = state.selectForContext([hit, { ...hit }], "甲库", []);
		expect(first.hits).toHaveLength(1);
		expect(first.truncated.因当前上下文已有).toBe(1);
		const context = [
			{
				role: "custom",
				customType: "pao-auto-recall",
				content: "同一事实",
				details: { hits: [hit], vendor: "甲库" },
			},
		];
		expect(state.selectForContext([hit], "甲库", context).hits).toEqual([]);
		expect(state.selectForContext([hit], "乙库", context).hits).toHaveLength(1);
	});
	it("普通文本只按正文去重；ID 短、长或他供应商同 ID 在场都不能掩盖必要事实", () => {
		const state = new SessionMemory();
		const hit = { 内容: "部署端口是 8123", 记忆ID: "端口配置" };
		expect(
			state.selectForContext([hit], "模拟", [{ role: "user", content: "请查记忆ID 端口配置" }]).hits,
		).toHaveLength(1);
		expect(
			state.selectForContext([hit], "模拟", [{ role: "user", content: "无关正文，仅出现记忆ID x" }]).hits,
		).toHaveLength(1);
		expect(
			state.selectForContext([hit], "模拟", [
				{
					role: "custom",
					customType: "pao-auto-recall",
					content: "其他事实",
					details: { hits: [{ 内容: "其他事实", 记忆ID: "端口配置" }], vendor: "其他库" },
				},
			]).hits,
		).toHaveLength(1);
	});
	it("按当前消息正文和常驻索引去重；不在内存里留永久已见", () => {
		const state = new SessionMemory();
		const hit = { 内容: "用户偏好简洁汇报" };
		const inMessage = [{ role: "user", content: [{ type: "text", text: `既有：${hit.内容}` }] }];
		expect(state.selectForContext([hit], "模拟", inMessage).hits).toEqual([]);
		expect(state.selectForContext([hit], "模拟", [], "- 用户偏好简洁汇报").hits).toEqual([]);
		expect(state.selectForContext([hit], "模拟", []).hits).toHaveLength(1);
		expect(state.selectForContext([hit], "模拟", inMessage).truncated.因当前上下文已有).toBe(1);
	});
	it("单条 800、最终上下文累计 2000 码点，按 Unicode 码点计数并显式标注", () => {
		const state = new SessionMemory();
		const one = state.selectForContext([{ 内容: "😀".repeat(AUTO_RECALL_HIT_LIMIT + 1), 记忆ID: "one" }], "模拟", []);
		expect(one.hits[0]!.内容).toContain("😀".repeat(AUTO_RECALL_HIT_LIMIT));
		expect(one.hits[0]!.内容).toContain(`保留 ${AUTO_RECALL_HIT_LIMIT} 码点；单条上限 800 码点`);
		expect(one.truncated.hit).toMatchObject({
			记忆ID: "one",
			原正文码点: AUTO_RECALL_HIT_LIMIT + 1,
			保留正文码点: AUTO_RECALL_HIT_LIMIT,
		});
		const total = state.selectForContext(
			[
				{ 内容: "甲".repeat(790), 记忆ID: "a" },
				{ 内容: "乙".repeat(790), 记忆ID: "b" },
				{ 内容: "丙".repeat(790), 记忆ID: "c" },
				{ 内容: "丁", 记忆ID: "d" },
			],
			"模拟",
			[],
		);
		expect(total.hits).toHaveLength(3);
		expect(total.truncated.hit).toMatchObject({ 记忆ID: "c", 保留正文码点: 420 });
		expect(total.hits[2]!.内容).toContain("累计正文上限 2000 码点");
		expect(total.truncated.因正文预算省略).toBe(1);
		const prior = {
			role: "custom",
			customType: "pao-auto-recall",
			content: "甲".repeat(1900),
			details: { hits: [{ 内容: "甲".repeat(1900), 记忆ID: "prior" }], vendor: "模拟" },
		};
		const acrossTurns = state.selectForContext([{ 内容: "乙".repeat(200), 记忆ID: "next" }], "模拟", [prior]);
		expect(acrossTurns.hits[0]!.内容).toContain("累计正文上限 2000 码点");
		expect(acrossTurns.truncated.hit).toMatchObject({ 记忆ID: "next", 保留正文码点: 100 });

		const manual = {
			role: "toolResult",
			toolCallId: "manual-budget",
			toolName: "pao_memory_recall",
			content: [{ type: "text", text: "手动召回正文" }],
			details: { memories: [{ 内容: "手".repeat(1900), 记忆ID: "manual" }], provider: "模拟" },
		};
		const automatic = {
			role: "custom",
			customType: "pao-auto-recall",
			content: "旧".repeat(1900),
			details: { hits: [{ 内容: "旧".repeat(1900), 记忆ID: "corrected" }], vendor: "模拟" },
		};
		state.record([{ 内容: "旧".repeat(1900), 记忆ID: "corrected" }], "模拟");
		state.exclude(state.injected[0]);
		const onlyVisibleAutomatic = state.selectForContext([{ 内容: "新".repeat(200), 记忆ID: "fresh" }], "模拟", [
			manual,
			automatic,
		]);
		expect(onlyVisibleAutomatic.hits[0]!.内容).toHaveLength(200);
		expect(onlyVisibleAutomatic.truncated.hit).toBeUndefined();
	});
	it("多个仍可见自动召回块累计占用 2000 码点", () => {
		const state = new SessionMemory();
		const prior = (index: number, char: string) => ({
			role: "custom",
			customType: "pao-auto-recall",
			content: char.repeat(900),
			details: { hits: [{ 内容: char.repeat(900), 记忆ID: `prior-${index}` }], vendor: "模拟" },
		});
		const selection = state.selectForContext([{ 内容: "丙".repeat(300), 记忆ID: "third" }], "模拟", [
			prior(1, "甲"),
			prior(2, "乙"),
		]);
		expect(selection.truncated.hit).toMatchObject({ 记忆ID: "third", 保留正文码点: 200 });
	});
	it("无 ID 超长正文连续召回不重复，纠正恢复后仍不复活", () => {
		const state = new SessionMemory();
		const original = `${"长".repeat(AUTO_RECALL_HIT_LIMIT)}尾部正文`;
		const first = state.selectForContext([{ 内容: original }], "模拟", []);
		expect(first.hits).toHaveLength(1);
		expect(first.hits[0]!.内容).not.toBe(original);
		expect(first.truncated.hit).toMatchObject({
			原正文码点: Array.from(original).length,
			保留正文码点: AUTO_RECALL_HIT_LIMIT,
		});
		const injected = state.record(first.hits, "模拟");
		expect(injected).toHaveLength(1);
		const automatic = {
			role: "custom",
			customType: "pao-auto-recall",
			content: injected[0]!.内容,
			details: { hits: injected, vendor: "模拟" },
		};
		const second = state.selectForContext([{ 内容: original }], "模拟", [automatic]);
		expect(second.hits).toEqual([]);
		expect(second.truncated.因当前上下文已有).toBe(1);

		state.exclude(state.injected[0], "新事实");
		const restored = new SessionMemory();
		restored.restore(JSON.parse(JSON.stringify(state.snapshot())));
		const afterCorrection = restored.selectForContext([{ 内容: original }], "模拟", [automatic]);
		expect(afterCorrection.hits).toEqual([]);
		expect(afterCorrection.truncated.因纠正排除).toBe(1);
	});
	it("纠正后只从模型可见副本去重旧事实，原始消息不变；手动结果保留 toolCallId", () => {
		const state = new SessionMemory();
		const old = { 内容: "旧目录是甲", 记忆ID: "old" };
		const current = { 内容: "目录是乙", 记忆ID: "new" };
		state.record([old, current], "模拟");
		state.exclude(state.injected[0], "目录是乙");
		const automatic = {
			role: "custom",
			customType: "pao-auto-recall",
			content: `[pao 自动召回]\n1. ${old.内容}\n2. ${current.内容}`,
			details: { hits: [old, current], vendor: "模拟" },
		};
		const manual = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "pao_memory_recall",
			content: [{ type: "text", text: `1. ${old.内容}\n2. ${current.内容}` }],
			details: { memories: [old, current], provider: "模拟" },
		};
		const filtered = state.filterVisibleMessages([automatic, manual]) as Array<Record<string, unknown>>;
		expect(filtered).toHaveLength(2);
		expect(filtered[0]!.content).not.toContain(old.内容);
		expect(filtered[0]!.content).toContain(current.内容);
		expect(filtered[1]!.content).not.toContain(old.内容);
		expect(filtered[1]!.toolCallId).toBe("call-1");
		expect(automatic.content).toContain(old.内容);
		expect(manual.content[0]!.text).toContain(old.内容);
		expect(state.selectForContext([old, current], "模拟", filtered).truncated.因纠正排除).toBe(1);
	});
	it("恢复排除身份后旧事实不复活；无 ID 内容身份按规范化正文计算", () => {
		const original = new SessionMemory();
		const hit = { 内容: "旧  事实" };
		original.record([hit], "模拟");
		original.exclude(original.injected[0]);
		const restored = new SessionMemory();
		restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
		expect(restored.selectForContext([{ 内容: " 旧 事实 " }], "模拟", []).hits).toEqual([]);
		expect(
			restored.filterVisibleMessages([
				{
					role: "custom",
					customType: "pao-auto-recall",
					content: "旧 事实",
					details: { hits: [hit], vendor: "模拟" },
				},
			]),
		).toEqual([]);
	});
});
