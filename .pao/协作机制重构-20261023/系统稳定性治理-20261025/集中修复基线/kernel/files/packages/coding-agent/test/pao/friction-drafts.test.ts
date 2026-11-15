import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createCard, listCards, readCard } from "../../src/pao/cards/cardfile.ts";
import type { PaoCardError } from "../../src/pao/cards/errors.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { registerCollab } from "../../src/pao/collab/index.ts";
import { type DeptRegistryRow, formatRegistry } from "../../src/pao/dept/index.ts";
import { executeFanout } from "../../src/pao/fanout/execute.ts";
import {
	appendFrictionDraft,
	drainFrictionDraftWrites,
	frictionLogPath,
	recordFrictionDraft,
} from "../../src/pao/friction/drafts.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** 摩擦日志里的草稿行（只取机器格式行，便于断言） */
function draftLines(logPath: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("- [草稿]"));
}

/** 固定时间源（周清/去重断言用） */
function at(y: number, m: number, d: number, hh = 12, mm = 0): () => Date {
	return () => new Date(y, m - 1, d, hh, mm);
}

describe("appendFrictionDraft 追加与骨架", () => {
	it("文件不存在时只建「# 摩擦日志＋## 草稿区」两级骨架，再追加草稿行", async () => {
		const home = tempDir("pao-friction-");
		const logPath = frictionLogPath(home);
		expect(existsSync(logPath)).toBe(false);

		await appendFrictionDraft(
			home,
			{ 场景: "打回", 卡号: "卡0001", 事实: "机械校验拒绝：部门「X」不在注册表" },
			{ 时间: at(2026, 10, 2, 14, 30) },
		);

		const content = readFileSync(logPath, "utf8");
		expect(content).toContain("# 摩擦日志");
		expect(content).toContain("## 草稿区");
		expect(content).toContain("机械校验拒绝");
		// 骨架除两级标题外不带正文本体
		expect(draftLines(logPath)).toEqual([
			"- [草稿] 2026-10-02 14:30 | 打回 | 卡0001 | ×1 | 机械校验拒绝：部门「X」不在注册表",
		]);
	});

	it("草稿区标题缺失时在文件尾补标题，不破坏既有正文", async () => {
		const home = tempDir("pao-friction-");
		const logPath = frictionLogPath(home);
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, "# 摩擦日志\n\n## 正式区\n\n| 日期 | 现象 |\n|---|---|\n", "utf8");

		await appendFrictionDraft(home, { 场景: "升级人", 卡号: "无", 事实: "待主控裁决" }, { 时间: at(2026, 10, 2) });

		const content = readFileSync(logPath, "utf8");
		expect(content).toContain("## 正式区");
		expect(content).toContain("## 草稿区");
		expect(content.indexOf("## 正式区")).toBeLessThan(content.indexOf("## 草稿区"));
		expect(draftLines(logPath)).toHaveLength(1);
	});

	it("多行事实压成单行（一行一事不被破坏）", async () => {
		const home = tempDir("pao-friction-");
		await appendFrictionDraft(
			home,
			{ 场景: "扇出取消", 卡号: "卡0002", 事实: "第一行\n第二行" },
			{ 时间: at(2026, 10, 2) },
		);
		expect(draftLines(frictionLogPath(home))[0]).toBe(
			"- [草稿] 2026-10-02 12:00 | 扇出取消 | 卡0002 | ×1 | 第一行 第二行",
		);
	});
});

describe("appendFrictionDraft 去重与周清", () => {
	it("两个项目同号卡各留一行，重复事件只累加所属项目", async () => {
		const home = tempDir("pao-friction-");
		const first = join(home, "项目甲", ".pao", "卡");
		const second = join(home, "项目乙", ".pao", "卡");
		const event = { 场景: "打回" as const, 卡号: "卡0001", 事实: "实际校验失败" };
		await appendFrictionDraft(home, { ...event, 卡目录: first }, { 时间: at(2026, 10, 2) });
		await appendFrictionDraft(home, { ...event, 卡目录: second }, { 时间: at(2026, 10, 2) });
		await appendFrictionDraft(home, { ...event, 卡目录: first }, { 时间: at(2026, 10, 2) });
		const lines = draftLines(frictionLogPath(home));
		expect(lines).toHaveLength(2);
		expect(lines.find((line) => line.includes("项目甲"))).toContain("×2");
		expect(lines.find((line) => line.includes("项目乙"))).toContain("×1");
		expect(existsSync(join(home, "摩擦日志.md"))).toBe(false);
	});
	it("同卡同场景去重：次数 +1、时间戳刷新、事实保留首次记录，不新增行", async () => {
		const home = tempDir("pao-friction-");
		const logPath = frictionLogPath(home);
		await appendFrictionDraft(
			home,
			{ 场景: "重试到顶", 卡号: "卡0003", 事实: "首次事实" },
			{ 时间: at(2026, 10, 1, 9, 0) },
		);
		await appendFrictionDraft(
			home,
			{ 场景: "重试到顶", 卡号: "卡0003", 事实: "第二次的事实应被忽略" },
			{ 时间: at(2026, 10, 2, 10, 5) },
		);

		const lines = draftLines(logPath);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe("- [草稿] 2026-10-02 10:05 | 重试到顶 | 卡0003 | ×2 | 首次事实");
	});

	it("不同场景或不同卡号不去重，各占一行", async () => {
		const home = tempDir("pao-friction-");
		await appendFrictionDraft(home, { 场景: "打回", 卡号: "卡0001", 事实: "a" }, { 时间: at(2026, 10, 1) });
		await appendFrictionDraft(home, { 场景: "升级人", 卡号: "卡0001", 事实: "b" }, { 时间: at(2026, 10, 1) });
		await appendFrictionDraft(home, { 场景: "打回", 卡号: "卡0002", 事实: "c" }, { 时间: at(2026, 10, 1) });
		expect(draftLines(frictionLogPath(home))).toHaveLength(3);
	});

	it("周清：最后更新超 7 天的草稿行在下次追加时被清掉，7 天内保留", async () => {
		const home = tempDir("pao-friction-");
		await appendFrictionDraft(home, { 场景: "打回", 卡号: "卡0001", 事实: "该清" }, { 时间: at(2026, 9, 19) });
		await appendFrictionDraft(home, { 场景: "打回", 卡号: "卡0002", 事实: "该留" }, { 时间: at(2026, 9, 26) });

		// 9-27 追加：卡0001 那行最后更新 9-19（超 7 天）被清，卡0002（9-26）保留
		await appendFrictionDraft(
			home,
			{ 场景: "升级人", 卡号: "无", 事实: "触发周清" },
			{ 时间: at(2026, 9, 27, 8, 0) },
		);

		const lines = draftLines(frictionLogPath(home));
		expect(lines).toHaveLength(2);
		expect(lines.some((l) => l.includes("卡0001"))).toBe(false);
		expect(lines.some((l) => l.includes("卡0002"))).toBe(true);
		expect(lines.some((l) => l.includes("触发周清"))).toBe(true);
	});

	it("并发安全：多次并发追加经锁内读改写全部落盘，无行丢失", async () => {
		const home = tempDir("pao-friction-");
		await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				appendFrictionDraft(home, { 场景: "打回", 卡号: "卡0001", 事实: `并发${i}` }, { 时间: at(2026, 10, 2) }),
			),
		);
		// 同键去重：6 次并发追加合并为一行 ×6，次数与并发追加次数一致
		const lines = draftLines(frictionLogPath(home));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("×6");
	});
});

describe("recordFrictionDraft 挂钩入口", () => {
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.PAO_HOME;
	});
	afterEach(() => {
		if (originalHome === undefined) delete process.env.PAO_HOME;
		else process.env.PAO_HOME = originalHome;
	});

	it("PAO_HOME 未配置＝机制未启用，静默跳过不落盘", async () => {
		delete process.env.PAO_HOME;
		await expect(recordFrictionDraft("打回", "卡0001", "x")).resolves.toBeUndefined();
	});

	it("PAO_HOME 配置后写入草稿区；任何失败只警告不抛（草稿记不上不影响主流程）", async () => {
		const home = tempDir("pao-friction-");
		process.env.PAO_HOME = home;
		await expect(recordFrictionDraft("打回", "卡0001", "来自挂钩")).resolves.toBeUndefined();
		await drainFrictionDraftWrites();
		expect(draftLines(frictionLogPath(home))).toHaveLength(1);

		// home 指向一个已存在的文件 → 路径非法，写入必失败，但调用本身不抛
		const occupied = join(tempDir("pao-friction-"), "占用.txt");
		writeFileSync(occupied, "not a dir", "utf8");
		process.env.PAO_HOME = occupied;
		await expect(recordFrictionDraft("打回", "卡0001", "y")).resolves.toBeUndefined();
	});
});

// ============================================================================
// 四事件挂钩点测试
// ============================================================================

/** 临时任务工作区（与 collab-tools 测试同构：pao/task-…/卡/ 三层布局） */
function tempWorkspace(): { root: string; cardsDir: string; registryPath: string } {
	const root = tempDir("pao-friction-hook-");
	const cardsDir = join(root, "pao", "task-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const registryPath = join(root, "pao", "部门", "注册表.md");
	mkdirSync(join(root, "pao", "部门"), { recursive: true });
	const rows: DeptRegistryRow[] = [{ 名字: "后端", 标签: ["api"], 库路径: "部门/后端/知识库" }];
	writeFileSync(registryPath, formatRegistry(rows), "utf8");
	return { root, cardsDir, registryPath };
}

function capturePi() {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	return { tools, pi };
}

async function runCollabTool(cardsDir: string, registryPath: string, params: Record<string, unknown>): Promise<string> {
	const captured = capturePi();
	registerCollab(captured.pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });
	const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;
	const result = await tool.execute("t1", params as never, undefined, undefined, {} as never);
	return (result.content[0] as { type: string; text: string }).text;
}

describe("挂钩点：pao_collab_relay（打回／升级人）", () => {
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.PAO_HOME;
	});
	afterEach(() => {
		if (originalHome === undefined) delete process.env.PAO_HOME;
		else process.env.PAO_HOME = originalHome;
	});

	it("打回：协作卡被机械校验拒绝 → 草稿区记「打回」行（原因入事实）", async () => {
		const { root, cardsDir, registryPath } = tempWorkspace();
		process.env.PAO_HOME = root;
		await createCard(cardsDir, { 目标: "父卡", 部门: "后端", 验收: "可判", 创建: "2026-10-02 09:00" });

		// 部门不在注册表 → 拒绝（打回）
		const text = await runCollabTool(cardsDir, registryPath, {
			goal: "帮忙压测",
			dept: "不存在的部门",
			acceptance: "可判",
			parent: "卡#1",
		});
		expect(text).toContain("已拒绝");

		const lines = draftLines(frictionLogPath(root));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^- \[草稿\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| 打回 \| 无 \| ×1 \| 协作卡递交被机械校验拒绝：\[部门不存在\]/,
		);
	});

	it("升级人：机械校验全过但带裁决标记转主控裁决 → 草稿区记「升级人」行（卡号取 parent）", async () => {
		const { root, cardsDir, registryPath } = tempWorkspace();
		process.env.PAO_HOME = root;
		await createCard(cardsDir, { 目标: "父卡", 部门: "后端", 验收: "可判", 创建: "2026-10-02 09:00" });

		const text = await runCollabTool(cardsDir, registryPath, {
			goal: "帮忙压测",
			dept: "后端",
			acceptance: "可判",
			parent: "卡#1",
			jump_queue: "线上故障，需要优先处理",
		});
		expect(text).toContain("待主控裁决");

		const lines = draftLines(frictionLogPath(root));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(" | 升级人 | 卡0001 | ×1 | 协作卡带裁决标记转主控裁决：插队：线上故障");
	});
});

describe("挂钩点：changeCardStatus（重试到顶）", () => {
	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.PAO_HOME;
	});
	afterEach(async () => {
		// statemachine 挂钩是 void 尾随写入，等写队列排空再恢复环境
		await drainFrictionDraftWrites();
		if (originalHome === undefined) delete process.env.PAO_HOME;
		else process.env.PAO_HOME = originalHome;
	});

	it("重试到顶：失败→待认领尝试达上限被拒（ATTEMPT_EXCEEDED）→ 草稿区记「重试到顶」行", async () => {
		const root = tempDir("pao-friction-sm-");
		process.env.PAO_HOME = root;
		const cardsDir = join(root, ".pao", "任务-20261002", "卡");
		mkdirSync(cardsDir, { recursive: true });
		const card = await createCard(cardsDir, {
			目标: "重试到顶流程卡",
			部门: "核心机制",
			验收: "可判条件",
			创建: "2026-10-02 21:00",
		});

		// 两轮「认领→失败」后尝试=2，第三次重开被重试门拒绝
		let current = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		current = changeCardStatus(current, {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-02 21:20",
		});
		current = changeCardStatus(current, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:25" });
		current = changeCardStatus(current, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:30" });
		current = changeCardStatus(current, {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-02 21:40",
		});
		try {
			changeCardStatus(current, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:45" });
			expect.unreachable("应当抛 ATTEMPT_EXCEEDED");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("ATTEMPT_EXCEEDED");
		}

		await drainFrictionDraftWrites();
		const lines = draftLines(frictionLogPath(root));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(" | 重试到顶 | 卡0001 | ×1 | ");
		expect(lines[0]).toContain("自动重试通道关闭");
	});
});

describe("挂钩点：executeFanout 停止收尾（扇出取消）", () => {
	const HANG_ENV = { PAO_FANOUT_HANG: "1", PAO_FANOUT_SLEEP: "0" };
	const TIMED_SCRIPT = `
const fs = require("node:fs");
const log = process.env.PAO_FANOUT_LOG;
const card = process.env.PAO_FANOUT_CARD;
fs.appendFileSync(log, "start " + Date.now() + " " + card + "\\n");
setTimeout(() => {
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
	setInterval(() => {}, 1000);
}, 0);
`;

	let originalHome: string | undefined;

	beforeEach(() => {
		originalHome = process.env.PAO_HOME;
	});
	afterEach(() => {
		if (originalHome === undefined) delete process.env.PAO_HOME;
		else process.env.PAO_HOME = originalHome;
	});

	function waitUntil(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const tick = (): void => {
				if (fn()) resolve();
				else if (Date.now() - start > timeoutMs) reject(new Error("等待超时"));
				else setTimeout(tick, 50);
			};
			tick();
		});
	}

	it("扇出被中途停止：在跑被杀＋排队未拉起的卡逐张记「扇出取消」草稿行", async () => {
		const dir = tempDir("pao-friction-fanout-");
		process.env.PAO_HOME = dir;
		const cardsDir = join(dir, "卡");
		mkdirSync(cardsDir, { recursive: true });
		const counterPath = join(cardsDir, "..", "卡号.txt");
		for (let i = 1; i <= 4; i++) {
			await createCard(
				cardsDir,
				{ 目标: `任务${i}`, 部门: "测试", 验收: "完成", 创建: "2026-10-02 10:00" },
				{ counterPath },
			);
		}
		const runner = new WorkerRunner();
		const script = join(dir, "fake-hang.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");
		const controller = new AbortController();
		const summaryPromise = executeFanout(
			{ 卡号列表: ["1", "2", "3", "4"], 并发上限: 2, cardsDir },
			{
				运行器: runner,
				公共参数: { 命令: process.execPath, 参数: [script], 证据目录: join(dir, "证据") },
				每卡参数: (card) => ({
					环境变量: {
						PAO_FANOUT_LOG: join(dir, "进程日志.txt"),
						PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"),
						...HANG_ENV,
					},
				}),
				信号: controller.signal,
			},
		);
		try {
			const log = join(dir, "进程日志.txt");
			await waitUntil(() => runner.registry.list().filter((entry) => entry.running).length === 1 && existsSync(log));
			// 同项目写任务串行：只有第一张已认领，其他卡仍排队，未制造执行尝试。
			expect(listCards(cardsDir).map((card) => card.frontmatter.attempt)).toEqual([1, 0, 0, 0]);
			controller.abort();
			const summary = await summaryPromise;

			expect(summary.已停止).toBe(true);
			expect(summary.count.取消).toBe(4);
			expect(runner.registry.list()).toHaveLength(1);
			expect(runner.registry.list()[0].running).toBe(false);
			for (const result of summary.结果.slice(1)) {
				expect(result.attempt).toBeUndefined();
				expect(result.错误 ?? result.未拉起原因).toBeDefined();
			}

			const lines = draftLines(frictionLogPath(dir));
			expect(lines).toHaveLength(4);
			for (const n of ["卡0001", "卡0002", "卡0003", "卡0004"]) {
				const line = lines.find((l) => l.includes(` | ${n} |`));
				expect(line).toBeDefined();
				expect(line).toContain(" | 扇出取消 | ");
				expect(line).toContain("扇出被中途停止");
			}
			// 在跑和未拉起的卡都落取消终态，未拉起的卡仍保持尝试 0。
			const cancelled = listCards(cardsDir);
			for (const card of cancelled) expect(readCard(card.path).frontmatter.status).toBe("canceled");
			expect(cancelled.map((card) => card.frontmatter.attempt)).toEqual([1, 0, 0, 0]);
		} finally {
			controller.abort();
			await runner.stopAll();
			await summaryPromise;
		}
	}, 30_000);
});
