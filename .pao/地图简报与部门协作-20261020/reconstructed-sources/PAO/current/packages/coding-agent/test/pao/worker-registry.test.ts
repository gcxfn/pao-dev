import { describe, expect, test } from "vitest";

import { ProcessRegistry } from "../../src/pao/worker/registry.ts";

/**
 * 登记表 pid 索引（P2 清账）:markOutput 是每个 stdout/stderr chunk 的热路径,原实现线性扫
 * 全表;收口为 pid 桶索引后行为必须等价——同 pid 多条目(pid 复用)按 run_id 分流、
 * markExited(pid) 不带 run_id 时全标、未知 pid 静默。
 */

describe("ProcessRegistry pid 桶索引", () => {
	test("markOutput 按 pid+run_id 精确打点:同 pid 其他 run_id 与其他 pid 不受牵连", () => {
		const registry = new ProcessRegistry();
		registry.register({ pid: 100, card_no: "卡0001", command: "cmd", run_id: "r1" });
		registry.register({ pid: 100, card_no: "卡0001", command: "cmd", run_id: "r2" }); // pid 复用
		registry.register({ pid: 200, card_no: "卡0002", command: "cmd", run_id: "r1" });

		registry.markOutput(100, "r1");

		const listed = registry.list();
		expect(listed.find((e) => e.pid === 100 && e.run_id === "r1")?.最近输出时间).toBeDefined();
		expect(listed.find((e) => e.pid === 100 && e.run_id === "r2")?.最近输出时间).toBeUndefined();
		expect(listed.find((e) => e.pid === 200)?.最近输出时间).toBeUndefined();
	});

	test("markExited(pid) 不带 run_id 时把同 pid 全部条目标退出(与全表扫描旧行为一致)", () => {
		const registry = new ProcessRegistry();
		registry.register({ pid: 100, card_no: "卡0001", command: "cmd", run_id: "r1" });
		registry.register({ pid: 100, card_no: "卡0001", command: "cmd", run_id: "r2" });
		registry.register({ pid: 200, card_no: "卡0002", command: "cmd", run_id: "r1" });

		registry.markExited(100);

		const listed = registry.list();
		expect(listed.filter((e) => e.pid === 100).every((e) => e.running)).toBe(false);
		expect(listed.find((e) => e.pid === 200)?.running).toBe(true);
	});

	test("markOutput 只动运行中条目;markExited 带 run_id 只摘对应条目", () => {
		const registry = new ProcessRegistry();
		registry.register({ pid: 300, card_no: "卡0003", command: "cmd", run_id: "r1" });
		registry.register({ pid: 300, card_no: "卡0003", command: "cmd", run_id: "r2" });

		registry.markExited(300, "r1");
		registry.markOutput(300); // 不带 run_id:只打还运行着的 r2

		const listed = registry.list();
		expect(listed.find((e) => e.run_id === "r1")?.最近输出时间).toBeUndefined();
		expect(listed.find((e) => e.run_id === "r2")?.最近输出时间).toBeDefined();
	});

	test("未知 pid 打点静默不抛;clear 后索引与表一并清空", () => {
		const registry = new ProcessRegistry();
		expect(() => registry.markOutput(99999)).not.toThrow();
		expect(() => registry.markExited(99999)).not.toThrow();

		registry.register({ pid: 400, card_no: "卡0004", command: "cmd", run_id: "r1" });
		registry.clear();
		expect(registry.list()).toHaveLength(0);
		expect(() => registry.markOutput(400, "r1")).not.toThrow();
		expect(registry.list().find((e) => e.pid === 400)?.最近输出时间).toBeUndefined();
	});

	test("list() 返回副本:改副本不污染登记表内部", () => {
		const registry = new ProcessRegistry();
		registry.register({ pid: 500, card_no: "卡0005", command: "cmd", run_id: "r1" });
		const copy = registry.list();
		copy[0].running = false;
		copy[0].最近输出时间 = "篡改";
		expect(registry.list()[0].running).toBe(true);
		expect(registry.list()[0].最近输出时间).toBeUndefined();
	});
});
