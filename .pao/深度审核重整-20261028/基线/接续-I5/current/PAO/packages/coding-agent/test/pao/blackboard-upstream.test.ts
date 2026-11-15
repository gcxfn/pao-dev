/**
 * M2-03 尾巴两件单测：任务黑板（首建幂等＋派发链指针注入）＋共享上游并发上限
 * （保温.json 可选键「上游并发上限」→ reserveDispatchSlot 名额参数；键缺失行为不变）。
 * 派发链走 pao_dispatch_card 全链（FakeRunner 覆写 run 与 reserveDispatchSlot,不 spawn）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { BLACKBOARD_TEMPLATE, blackboardPath, createCard, ensureBlackboard } from "../../src/pao/cards/index.ts";
import { readUpstreamConcurrencyCap } from "../../src/pao/worker/dispatch-core.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { fireSessionShutdownHandlers } from "./fixtures/session-shutdown.ts";

const tempDirs: string[] = [];
const shutdowns: (() => unknown)[] = [];
const envKeys = ["PAO_ROLE", "PAO_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of envKeys) savedEnv[key] = process.env[key];
});

afterEach(async () => {
	await fireSessionShutdownHandlers(shutdowns.splice(0));
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

// ============================================================================
// 纯函数：黑板首建/幂等/路径
// ============================================================================

describe("任务黑板·纯函数", () => {
	it("blackboardPath 住卡目录父级＝工作区根", () => {
		expect(blackboardPath(join("r", ".pao", "卡")).replaceAll("\\", "/")).toBe("r/.pao/黑板.md");
	});

	it("ensureBlackboard 缺失首建模板,存在幂等不动", () => {
		const cardsDir = join(tempDir("bb"), "卡");
		mkdirSync(cardsDir, { recursive: true });
		expect(ensureBlackboard(cardsDir)).toBe("已建");
		expect(readFileSync(blackboardPath(cardsDir), "utf8")).toBe(BLACKBOARD_TEMPLATE);
		expect(ensureBlackboard(cardsDir)).toBe("已存在");
		writeFileSync(blackboardPath(cardsDir), "# 同伴改过\n", "utf8");
		expect(ensureBlackboard(cardsDir)).toBe("已存在");
		expect(readFileSync(blackboardPath(cardsDir), "utf8")).toBe("# 同伴改过\n"); // worker 写入不被模板覆盖
	});

	it("模板含纪律引导:先挂链接/归档冻结/谁在写看 /pao queue", () => {
		expect(BLACKBOARD_TEMPLATE).toContain("先挂链接");
		expect(BLACKBOARD_TEMPLATE).toContain("归档即冻结");
		expect(BLACKBOARD_TEMPLATE).toContain("/pao queue");
	});
});

// ============================================================================
// readUpstreamConcurrencyCap：保温.json 可选键
// ============================================================================

describe("readUpstreamConcurrencyCap", () => {
	function homeWith(warmth?: unknown): string {
		const home = tempDir("warm");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		if (warmth !== undefined) writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify(warmth), "utf8");
		return home;
	}

	it("键缺失/文件缺失＝undefined(不启用配置层,行为不变)", () => {
		expect(readUpstreamConcurrencyCap(homeWith())).toBeUndefined();
		expect(readUpstreamConcurrencyCap(homeWith({ 部门并发上限: 3 }))).toBeUndefined();
	});

	it("合法正整数生效;2.5 收敛取整", () => {
		expect(readUpstreamConcurrencyCap(homeWith({ 上游并发上限: 5 }))).toBe(5);
		expect(readUpstreamConcurrencyCap(homeWith({ 上游并发上限: 2.5 }))).toBe(2);
	});

	it("非法值(0/负数/非数字/坏 JSON)＝undefined,不猜", () => {
		expect(readUpstreamConcurrencyCap(homeWith({ 上游并发上限: 0 }))).toBeUndefined();
		expect(readUpstreamConcurrencyCap(homeWith({ 上游并发上限: -3 }))).toBeUndefined();
		expect(readUpstreamConcurrencyCap(homeWith({ 上游并发上限: "3" }))).toBeUndefined();
		const bad = tempDir("warm-bad");
		mkdirSync(join(bad, "pao配置"), { recursive: true });
		writeFileSync(join(bad, "pao配置", "保温.json"), "{oops", "utf8");
		expect(readUpstreamConcurrencyCap(bad)).toBeUndefined();
	});
});

// ============================================================================
// 派发链集成：黑板首建＋指针注入＋上限参数（FakeRunner 全链走 pao_dispatch_card）
// ============================================================================

class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	slotInputs: { 部门上限: number; 并发上限: number }[] = [];

	override async reserveDispatchSlot(input: { 部门上限: number; 并发上限: number }): Promise<() => void> {
		this.slotInputs.push({ 部门上限: input.部门上限, 并发上限: input.并发上限 });
		return () => {};
	}

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		this.registry.register({
			pid: 900000 + this.runs.length,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: "test",
		});
		this.registry.markExited(900000 + this.runs.length);
		return {
			card_no: options.卡号,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: [],
			summary: "假回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: join(tempDir("证据"), `卡${options.卡号}.jsonl`),
			exitCode: 0,
			command: "fake-runner",
			pid: -1,
			duration_ms: 1,
		};
	}
}

interface Captured {
	tools: {
		name: string;
		execute: (...args: unknown[]) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
	}[];
	pi: ExtensionAPI;
}

function capturePi(): Captured {
	const captured: Captured = { tools: [], pi: undefined as unknown as ExtensionAPI };
	captured.pi = {
		registerTool: (tool: { name: string }) => captured.tools.push(tool as never),
		on: (event: string, handler: () => unknown) => {
			if (event === "session_shutdown") shutdowns.push(handler);
			return () => {};
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return captured;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** git 仓库 fixture＋一张卡＋pao_dispatch_card 工具就绪（PAO_HOME 可选落保温.json）;face 供 waitForBackground 收敛 */
async function setup(warmth?: unknown): Promise<{
	repo: string;
	cardsDir: string;
	runner: FakeRunner;
	dispatch: Captured["tools"][number];
	face: ReturnType<typeof registerWorkerTools>;
}> {
	const repo = tempDir("repo");
	git(repo, ["init", "-q"]);
	writeFileSync(join(repo, "基线.txt"), "v1\n", "utf8");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "基线"]);
	const cardsDir = join(repo, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	await createCard(
		cardsDir,
		{ 目标: "做点事", 部门: "测试部", 验收: "完成", 创建: "2026-10-03 12:00" },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
	const paoHome = tempDir("home");
	mkdirSync(join(paoHome, "pao配置"), { recursive: true });
	if (warmth !== undefined) writeFileSync(join(paoHome, "pao配置", "保温.json"), JSON.stringify(warmth), "utf8");
	process.env.PAO_HOME = paoHome;
	process.env.PAO_ROLE = "主控";
	const runner = new FakeRunner();
	const captured = capturePi();
	const face = registerWorkerTools(captured.pi, {
		runner,
		resolveCardsDir: () => cardsDir,
		resolvePaoHome: () => paoHome,
	});
	const dispatch = captured.tools.find((t) => t.name === "pao_dispatch_card");
	if (!dispatch) throw new Error("未注册 pao_dispatch_card");
	return { repo, cardsDir, runner, dispatch, face };
}

describe("派发链·黑板与上游上限", () => {
	it("派单后黑板已首建＋worker 附加系统提示词含黑板指针(相对项目根)", async () => {
		const { cardsDir, runner, dispatch, face } = await setup();
		const result = await dispatch.execute("t1", { card_ref: "卡0001", reason: "测试黑板" }, undefined);
		expect(result.isError).toBeFalsy();
		await face.waitForBackground(); // B 档:受理即返回,黑板首建/指针注入在后台链里
		expect(existsSync(blackboardPath(cardsDir))).toBe(true);
		const prompts = runner.runs[0]?.附加系统提示词 ?? [];
		const pointer = prompts.find((p) => p.includes("任务黑板:"));
		expect(pointer).toContain(".pao/黑板.md(相对项目根)");
		expect(pointer).toContain("先挂链接");
	});

	it("已有黑板不覆盖:同伴写入保留,只补指针", async () => {
		const { cardsDir, dispatch, face } = await setup();
		writeFileSync(blackboardPath(cardsDir), "# 同伴的中间结论\n- [发现A](产物/a.md)\n", "utf8");
		await dispatch.execute("t2", { card_ref: "卡0001", reason: "测试幂等" }, undefined);
		await face.waitForBackground();
		expect(readFileSync(blackboardPath(cardsDir), "utf8")).toBe("# 同伴的中间结论\n- [发现A](产物/a.md)\n");
	});

	it("保温.json「上游并发上限」与派发意愿取小;键缺失＝缺省 2 不变", async () => {
		const a = await setup({ 上游并发上限: 1 });
		await a.dispatch.execute("t3", { card_ref: "卡0001", reason: "上限1" }, undefined);
		await a.face.waitForBackground();
		expect(a.runner.slotInputs[0]).toEqual({ 部门上限: 3, 并发上限: 1 });

		const b = await setup({ 上游并发上限: 9 });
		await b.dispatch.execute("t4", { card_ref: "卡0001", reason: "上限9取小缺省2" }, undefined);
		await b.face.waitForBackground();
		expect(b.runner.slotInputs[0].并发上限).toBe(2); // 派单意愿缺省 2,配置 9 取小＝2

		const c = await setup({ 部门并发上限: 4 });
		await c.dispatch.execute("t5", { card_ref: "卡0001", reason: "无上游键" }, undefined);
		await c.face.waitForBackground();
		expect(c.runner.slotInputs[0]).toEqual({ 部门上限: 4, 并发上限: 2 }); // 行为不变
	});
});
