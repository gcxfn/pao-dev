/**
 * 记忆供应商插拔接口单测（M2-05）：配置三级语义 / 注册表 / 管理器生命周期(惰性·降级·随会话关闭)。
 * 不起子进程——真起进程的验收在 mnemosyne-lifecycle.test.ts(假 MCP stdio 服务器)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerMemory } from "../../src/pao/memory/index.ts";
import {
	getMemoryVendorFactory,
	listMemoryVendors,
	loadMemoryVendorConfig,
	MEMORY_CONFIG_RELATIVE_PATH,
	type MemoryVendor,
	MemoryVendorManager,
	registerMemoryVendor,
	resolveMemoryConfigPath,
} from "../../src/pao/memory/memory-vendor.ts";
import "../../src/pao/memory/index.ts"; // 触发内置 mnemosyne 工厂登记

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-memory-vendor-"));
	tempDirs.push(dir);
	return dir;
}

function writeConfig(body: string): string {
	const dir = tempDir();
	mkdirSync(join(dir, "pao配置"), { recursive: true });
	const file = join(dir, "pao配置", "记忆供应商.json");
	writeFileSync(file, body, "utf8");
	return file;
}

describe("记忆供应商配置:缺文件=静默不启用,坏配置=结构化报错", () => {
	it("配置文件不存在 → undefined,不抛错(不启用记忆,静默)", () => {
		expect(loadMemoryVendorConfig(join(tempDir(), "pao配置", "记忆供应商.json"))).toBeUndefined();
	});

	it("坏 JSON → 报错指明出处", () => {
		const file = writeConfig("{ 供应商: ");
		expect(() => loadMemoryVendorConfig(file)).toThrow(/不是合法 JSON/);
	});

	it("顶层不是对象 / 缺「供应商」/「参数」非对象 → 各自报错指明缺什么", () => {
		const file1 = writeConfig(JSON.stringify(["mnemosyne"]));
		expect(() => loadMemoryVendorConfig(file1)).toThrow(/顶层应为 JSON 对象/);
		const file2 = writeConfig(JSON.stringify({ 参数: {} }));
		expect(() => loadMemoryVendorConfig(file2)).toThrow(/缺少字段「供应商」/);
		const file3 = writeConfig(JSON.stringify({ 供应商: "mnemosyne", 参数: "不对" }));
		expect(() => loadMemoryVendorConfig(file3)).toThrow(/「参数」应为对象/);
	});

	it("合法配置 → 供应商名去空白,参数缺省为空对象", () => {
		const file = writeConfig(JSON.stringify({ 供应商: " mnemosyne ", 参数: { command: "mnemosyne" } }));
		expect(loadMemoryVendorConfig(file)).toEqual({ 供应商: "mnemosyne", 参数: { command: "mnemosyne" } });
		const file2 = writeConfig(JSON.stringify({ 供应商: "mnemosyne" }));
		expect(loadMemoryVendorConfig(file2)).toEqual({ 供应商: "mnemosyne", 参数: {} });
	});

	it("路径拼装:$PAO_HOME/pao配置/记忆供应商.json", () => {
		expect(resolveMemoryConfigPath("H:/现场")).toBe(join("H:", "现场", MEMORY_CONFIG_RELATIVE_PATH));
		expect(MEMORY_CONFIG_RELATIVE_PATH).toContain("pao配置");
	});
});

describe("供应商注册表:名字→工厂", () => {
	it("mnemosyne 已随模块加载登记;查无此厂返回 undefined", () => {
		expect(getMemoryVendorFactory("mnemosyne")).toBeTypeOf("function");
		expect(getMemoryVendorFactory("查无此厂")).toBeUndefined();
		expect(listMemoryVendors()).toContain("mnemosyne");
	});

	it("重复登记以最后一次为准;不影响其他名字", () => {
		const name = "计数供应商";
		const first = (_params: unknown): MemoryVendor => fakeVendor().vendor;
		registerMemoryVendor(name, first);
		expect(getMemoryVendorFactory(name)).toBe(first);
		const second = (_params: unknown): MemoryVendor => fakeVendor().vendor;
		registerMemoryVendor(name, second);
		expect(getMemoryVendorFactory(name)).toBe(second);
		expect(getMemoryVendorFactory("mnemosyne")).toBeTypeOf("function");
	});
});

/** 可数调用的假供应商(不起进程) */
function fakeVendor(behavior: { 启动?: () => Promise<void>; 写入?: () => Promise<void> } = {}) {
	const calls = { 启动: 0, 写入: 0, 关闭: 0 };
	const vendor: MemoryVendor = {
		vendorName: "假供应商",
		capabilities: { 语义检索: false, 需嵌入端点: false, 忘却: false },
		start: async () => {
			calls.启动++;
			await behavior.启动?.();
		},
		write: async () => {
			calls.写入++;
			await behavior.写入?.();
		},
		recall: async () => [],
		close: async () => {
			calls.关闭++;
		},
	};
	return { vendor, calls };
}

describe("MemoryVendorManager:惰性启动 / 失败降级 / 随会话关闭复位", () => {
	it("就绪路径:首次获取才构造＋启动;复用实例;关闭后状态复位,下会话再构造", async () => {
		let constructions = 0;
		const { vendor, calls } = fakeVendor();
		registerMemoryVendor("计数就绪", (params: unknown) => {
			constructions++;
			expect(params).toEqual({ command: "x" });
			return vendor;
		});
		const warnings: string[] = [];
		const manager = new MemoryVendorManager({ 供应商: "计数就绪", 参数: { command: "x" } }, (m) => warnings.push(m));

		expect(manager.status).toBe("待启动");
		const got = await manager.acquire();
		expect(got).toBe(vendor);
		expect(manager.status).toBe("已就绪");
		expect(constructions).toBe(1);
		expect(calls.启动).toBe(1);
		expect(await manager.acquire()).toBe(vendor); // 复用,不再构造
		expect(constructions).toBe(1);

		await manager.close();
		expect(calls.关闭).toBe(1);
		expect(manager.status).toBe("待启动"); // 会话边界复位(reload/new 后可再拉起)
		expect(await manager.acquire()).toBe(vendor);
		expect(constructions).toBe(2);
		expect(warnings).toEqual([]);
	});

	it("启动失败:警告＋降级;本会话内不再重试;关闭后复位可再试", async () => {
		let constructions = 0;
		const attempts: ReturnType<typeof fakeVendor>[] = [];
		registerMemoryVendor("计数失败", () => {
			constructions++;
			const created = fakeVendor({
				启动: async () => {
					throw new Error("命令不存在(ENOENT)");
				},
			});
			attempts.push(created);
			return created.vendor;
		});
		const warnings: string[] = [];
		const manager = new MemoryVendorManager({ 供应商: "计数失败", 参数: {} }, (m) => warnings.push(m));

		await expect(manager.acquire()).resolves.toBeUndefined();
		expect(manager.status).toBe("已降级");
		expect(manager.degradeReason).toContain("启动失败");
		expect(manager.degradeReason).toContain("ENOENT");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("[pao]");
		expect(constructions).toBe(1);
		expect(attempts[0]!.calls.关闭).toBe(1); // 半开连接被收尾

		await expect(manager.acquire()).resolves.toBeUndefined(); // 已降级,直接短路
		expect(constructions).toBe(1); // 不反复 spawn(Windows 冷启动贵)
		expect(warnings).toHaveLength(1); // 也不重复警告

		await manager.close();
		expect(manager.status).toBe("待启动"); // 会话边界复位
		await expect(manager.acquire()).resolves.toBeUndefined(); // 再试一次,仍失败
		expect(constructions).toBe(2);
		expect(warnings).toHaveLength(2);
	});

	it("配置指向未注册供应商 → 按坏配置同款降级并警告", async () => {
		const warnings: string[] = [];
		const manager = new MemoryVendorManager({ 供应商: "查无此厂", 参数: {} }, (m) => warnings.push(m));
		await expect(manager.acquire()).resolves.toBeUndefined();
		expect(manager.status).toBe("已降级");
		expect(warnings[0]).toContain("没有已注册的工厂");
	});
});

describe("registerMemory:session_shutdown 关闭失败不悬挂 Promise", () => {
	it("供应商关闭拒绝 → 记警告,不产生 unhandled rejection", async () => {
		const name = "关闭即炸供应商";
		registerMemoryVendor(name, () => ({
			vendorName: name,
			capabilities: { 语义检索: false, 需嵌入端点: false, 忘却: false },
			start: async () => {},
			write: async () => {},
			recall: async () => [],
			close: async () => {
				throw new Error("杀树失败(EPERM)");
			},
		}));
		const dir = tempDir();
		mkdirSync(join(dir, "pao配置"), { recursive: true });
		const configPath = join(dir, "pao配置", "记忆供应商.json");
		writeFileSync(configPath, JSON.stringify({ 供应商: name, 参数: {} }), "utf8");

		const warnings: string[] = [];
		const handlers = new Map<string, () => unknown>();
		const manager = registerMemory(
			{
				registerTool() {},
				on(event: string, handler: () => unknown) {
					handlers.set(event, handler);
				},
			} as never,
			{ resolveConfigPath: () => configPath, onWarn: (m) => warnings.push(m) },
		);
		expect(manager).toBeDefined();
		expect(handlers.has("session_shutdown")).toBe(true);

		// 先拉起供应商,再触发散场钩子(关闭必拒绝)
		await manager!.acquire();
		handlers.get("session_shutdown")!(); // 不 await:修复前这里产生悬挂 Promise
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(warnings.some((w) => w.includes("关闭供应商子进程树失败") && w.includes("杀树失败"))).toBe(true);
	});
});

/**
 * fork 审查第 12 项回归：并发获取共用一次启动；启动途中会话散场时迟到实例不得复活成
 * “已就绪”，也不得把已经取消掉的会话标成“已降级”去买单。
 */
describe("MemoryVendorManager:并发启动与关闭竞态(审查第 12 项)", () => {
	it("并发 acquire 只构造/启动一次,三个调用拿到同一实例", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let constructions = 0;
		let created: ReturnType<typeof fakeVendor> | undefined;
		registerMemoryVendor("并发启动", () => {
			constructions++;
			created = fakeVendor({ 启动: () => gate });
			return created.vendor;
		});
		const manager = new MemoryVendorManager({ 供应商: "并发启动", 参数: {} }, () => {});

		const first = manager.acquire();
		const second = manager.acquire();
		const third = manager.acquire();
		expect(constructions).toBe(1); // 同步窗口内就复用同一份启动,不重复 spawn
		release();
		const [a, b, c] = await Promise.all([first, second, third]);
		expect(a).toBe(created!.vendor);
		expect(b).toBe(created!.vendor);
		expect(c).toBe(created!.vendor);
		expect(constructions).toBe(1);
		expect(created!.calls.启动).toBe(1);
		expect(manager.status).toBe("已就绪");
	});

	it("启动途中 close:迟到实例当场关闭、状态不回弹为已就绪,下个会话可重新拉起", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const attempts: ReturnType<typeof fakeVendor>[] = [];
		registerMemoryVendor("启动途中散场", () => {
			const created = fakeVendor({ 启动: () => gate });
			attempts.push(created);
			return created.vendor;
		});
		const manager = new MemoryVendorManager({ 供应商: "启动途中散场", 参数: {} }, () => {});

		const pending = manager.acquire();
		const closing = manager.close(); // 启动还没完成就散场
		release();
		await expect(pending).resolves.toBeUndefined();
		await closing;

		expect(attempts).toHaveLength(1);
		expect(attempts[0]!.calls.关闭).toBe(1); // 迟到实例被当场收尾,不泄漏
		expect(manager.status).toBe("待启动"); // 不因迟到启动回弹为「已就绪」
		const revived = await manager.acquire(); // 新会话重新拉起(此时启动闸门已放行)
		expect(revived).toBe(attempts[1]!.vendor);
		expect(attempts).toHaveLength(2);
	});

	it("启动途中 close 之后才失败的启动:不把新会话标成已降级、不告警", async () => {
		let reject: (err: Error) => void = () => {};
		const gate = new Promise<void>((_resolve, rej) => {
			reject = rej;
		});
		const created = fakeVendor({ 启动: () => gate });
		registerMemoryVendor("散场后才失败", () => created.vendor);
		const warnings: string[] = [];
		const manager = new MemoryVendorManager({ 供应商: "散场后才失败", 参数: {} }, (m) => warnings.push(m));

		const pending = manager.acquire();
		const closing = manager.close();
		reject(new Error("启动失败(散场后)"));
		await expect(pending).resolves.toBeUndefined();
		await closing;

		expect(manager.status).toBe("待启动"); // 失败属于已散场的旧会话,不污染新会话
		expect(manager.degradeReason).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	it("close 幂等:连续两次关闭只关供应商一次,不抛错", async () => {
		const created = fakeVendor();
		registerMemoryVendor("幂等关闭", () => created.vendor);
		const manager = new MemoryVendorManager({ 供应商: "幂等关闭", 参数: {} }, () => {});

		await manager.acquire();
		await manager.close();
		await manager.close();
		expect(created.calls.关闭).toBe(1);
	});
});
