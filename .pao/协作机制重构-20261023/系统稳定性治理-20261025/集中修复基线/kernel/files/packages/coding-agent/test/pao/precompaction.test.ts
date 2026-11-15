import { describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { PrecompactionCoordinator } from "../../src/pao/context/precompaction.ts";

const entry = (id: string, text = id): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-10-04",
	message: { role: "user", content: text, timestamp: 0 },
});
const identity = (entries = [entry("old"), entry("keep")]) => ({ sessionId: "session-a", model: "model-a", entries });
const summary = (): CompactionResult => ({
	summary: "原生摘要",
	firstKeptEntryId: "keep",
	tokensBefore: 100,
	usage: {
		input: 5,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 7,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	},
});

describe("后台预压缩版本与取消（离线，不调用模型）", () => {
	it("应用已就绪旧摘要时保留原 firstKept 边界、新增用户纠正与工具结果，并移除已单记费用", async () => {
		const coordinator = new PrecompactionCoordinator();
		await coordinator.start(identity(), async () => summary());
		const current = identity([...identity().entries, entry("new", "纠正：只改乙目录")]);
		const result = coordinator.consume(current, 140);
		expect(result).toMatchObject({ firstKeptEntryId: "keep", tokensBefore: 140, summary: "原生摘要" });
		expect(result).not.toHaveProperty("usage");
		expect(current.entries.map((e) => e.id)).toEqual(["old", "keep", "new"]);
		expect(coordinator.consume(current, 140)).toBeUndefined();
	});
	it.each(["会话", "模型", "旧前缀", "压缩", "系统消息", "保留边界缺失"])(
		"%s 改变则丢弃并回原路径",
		async (change) => {
			const coordinator = new PrecompactionCoordinator();
			await coordinator.start(identity(), async () =>
				change === "保留边界缺失" ? { ...summary(), firstKeptEntryId: "absent" } : summary(),
			);
			const current = identity();
			if (change === "会话") current.sessionId = "other";
			if (change === "模型") current.model = "other";
			if (change === "旧前缀") current.entries[0] = entry("old", "修改后的内容");
			if (change === "压缩") current.entries.push({ type: "compaction", id: "new" } as SessionEntry);
			if (change === "系统消息")
				current.entries.push({
					type: "message",
					id: "sys",
					message: { role: "system", content: "新系统约束" },
				} as SessionEntry);
			expect(coordinator.consume(current, 120)).toBeUndefined();
			expect(coordinator.lastOutcome).toBe("已丢弃");
		},
	);
	it("阈值先到时不等待后台摘要，取消后台且迟到结果不能覆盖下次候选", async () => {
		const coordinator = new PrecompactionCoordinator();
		let finish!: (result: CompactionResult) => void;
		let signal!: AbortSignal;
		const pending = coordinator.start(identity(), (value) => {
			signal = value;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		await Promise.resolve();
		expect(coordinator.consume(identity(), 120)).toBeUndefined();
		expect(signal.aborted).toBe(true);
		await coordinator.start({ ...identity(), sessionId: "new" }, async () => ({ ...summary(), summary: "新摘要" }));
		finish(summary());
		await pending;
		expect(coordinator.consume({ ...identity(), sessionId: "new" }, 120)?.summary).toBe("新摘要");
	});
	it("摘要失败、同步异常和重复同一版本均不阻塞原生压缩，也不重复收费调用", async () => {
		const coordinator = new PrecompactionCoordinator();
		const generate = vi.fn(() => {
			throw new Error("模拟失败");
		});
		await coordinator.start(identity(), generate);
		expect(coordinator.lastOutcome).toBe("失败回原路径");
		expect(coordinator.consume(identity(), 120)).toBeUndefined();
		await coordinator.start(identity(), generate);
		expect(generate).toHaveBeenCalledTimes(1);
	});
});
