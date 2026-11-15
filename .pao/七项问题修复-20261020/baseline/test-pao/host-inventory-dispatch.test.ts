import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard, readCard } from "../../src/pao/cards/index.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import type { ProcessRegistry } from "../../src/pao/worker/registry.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

/**
 * 宿主接线(定案10/11):pao_inventory 增部长会话行(含全局热会话数>8 只提示不拒),
 * pao_dispatch_card 命中热部长会话时交接页指针附进派卡信封＋配方指纹不一致仅提示不自动杀。
 */

const tempDirs: string[] = [];
const hosts: MinisterHost[] = [];
const shutdowns: (() => unknown)[] = [];

// Windows 下被杀进程的 cwd 句柄释放有延迟,rmSync 可能 EPERM——清理尽力而为,不让收尾失败连累已通过的断言
function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch {
		// 残留目录交给系统临时目录清理,不影响测试结果
	}
}

afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	for (const host of hosts.splice(0)) await host.stopAll("测试清理").catch(() => {});
	for (const dir of tempDirs.splice(0)) cleanupDir(dir);
}, 60_000);

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-host-wiring-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function waitUntil(fn: () => boolean, timeoutMs = 10000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = (): void => {
			if (fn() || Date.now() - start > timeoutMs) resolve(fn());
			else setTimeout(tick, 50);
		};
		tick();
	});
}

const FAKE_IDLE = `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") console.log(JSON.stringify({type:"response",id:cmd.id,command:"get_state",success:true,data:{sessionId:"fake-inventory"}}));
});
setInterval(() => {}, 1000);
`;

function makeHost(home: string, registry?: ProcessRegistry): MinisterHost {
	const host = new MinisterHost({ paoHome: home, ...(registry ? { registry } : {}) });
	hosts.push(host);
	return host;
}

function makeHome(prefix: string, recipe = ""): string {
	const home = tempDir(`${prefix}-home`);
	mkdirSync(join(home, "pao配置"), { recursive: true });
	if (recipe) {
		mkdirSync(join(home, "部门", "前端"), { recursive: true });
		writeFileSync(join(home, "部门", "前端", "配方.md"), recipe, "utf8");
	}
	return home;
}

function writeScript(prefix: string, body: string): string {
	const file = join(tempDir(`${prefix}-bin`), "fake-minister.cjs");
	writeFileSync(file, body, "utf8");
	return file;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

function makeRepo(prefix: string): { repo: string; cardsDir: string } {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	const cardsDir = join(repo, ".pao", "任务A", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return { repo, cardsDir };
}

async function makeCard(cardsDir: string, goal: string, dept: string): Promise<string> {
	const parsed = await createCard(
		cardsDir,
		{ 目标: goal, 部门: dept, 验收: "完成", 创建: "2026-10-03 10:00" },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
	return String(parsed.card_no).padStart(4, "0");
}

class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		this.registry.register({
			pid: 900000 + this.runs.length,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		this.registry.markExited(900000 + this.runs.length);
		return {
			card_no: options.卡号,
			attempt: 1,
			status: "success",
			artifact_path: [],
			summary: "假回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: join(tempDir("证据"), "回执.jsonl"),
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
		execute: (...args: unknown[]) => Promise<{ content: { text?: string }[]; details: unknown }>;
	}[];
}

function capturePi(): Captured & { pi: ExtensionAPI } {
	const captured: Captured = { tools: [] };
	const pi = {
		registerTool: (tool: { name: string }) => captured.tools.push(tool as never),
		on: (event: string, handler: () => unknown) => {
			if (event === "session_shutdown") shutdowns.push(handler);
			return () => {};
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return { ...captured, pi };
}

function textOf(result: { content: { text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

// ── pao_inventory 部长会话行(定案11) ─────────────────────────────────────────

describe("pao_inventory:部长会话行(pid/轮次/调用/指纹/活性)与全局热会话观测", () => {
	async function runInventory(host: MinisterHost): Promise<string> {
		const runner = new FakeRunner();
		// 盘点里的后台进程行读 runner 的登记表;宿主登记同一份(正式接线同款)
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner, signals: false, host });
		const tool = captured.tools.find((t) => t.name === "pao_inventory")!;
		const result = await tool.execute("t", { workspace: tempDir("inv") }, undefined, undefined, {} as never);
		return textOf(result);
	}

	it("无热会话:显式空态;有热会话:登记表带部长行＋盘点行带 pid/轮次/调用/指纹", async () => {
		const home = makeHome("inv");
		expect(await runInventory(makeHost(home))).toContain("部长会话:无热会话");

		const runner = new FakeRunner();
		const host = makeHost(home, runner.registry);
		const script = writeScript("inv", FAKE_IDLE);
		const projectRoot = tempDir("inv-proj");
		mkdirSync(projectRoot, { recursive: true });
		await host.spawn({ 部门: "前端", 项目根: projectRoot, 命令: process.execPath, 参数: [script] });

		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner, signals: false, host });
		const tool = captured.tools.find((t) => t.name === "pao_inventory")!;
		const text = textOf(await tool.execute("t", { workspace: tempDir("inv") }, undefined, undefined, {} as never));
		expect(text).toContain("部长会话 1 个");
		expect(text).toContain("前端@");
		expect(text).toContain(host.inventoryView()[0].项目名);
		expect(text).toContain("轮次 0/调用 0/成本 0");
		expect(text).toContain("指纹 无配方");
		expect(text).toContain("最近事件");
		expect(text).toContain("部长会话〔前端〕运行中");
		expect(text).not.toContain("超过观测口径");
	});

	it("全局热会话数超 8:仅提示不拒", async () => {
		const home = makeHome("inv9");
		const host = makeHost(home);
		const script = writeScript("inv9", FAKE_IDLE);
		for (let i = 0; i < 9; i++) {
			const projectRoot = tempDir(`inv9-${i}`);
			mkdirSync(projectRoot, { recursive: true });
			const spawn = await host.spawn({
				部门: `部门${i}`,
				项目根: projectRoot,
				命令: process.execPath,
				参数: [script],
			});
			expect(spawn.ok).toBe(true);
		}
		expect(await waitUntil(() => host.inventoryView().length === 9)).toBe(true);
		const text = await runInventory(host);
		expect(text).toContain("部长会话 9 个");
		expect(text).toContain("超过观测口径 8");
		expect(text).toContain("仅提示,不拒绝拉起");
	});
});

// ── pao_dispatch_card 交接指针＋指纹核对(定案10/定案9) ───────────────────────────

describe("pao_dispatch_card:命中热部长会话时附交接页指针,指纹不一致仅提示", () => {
	it("热会话＋交接文件在:指针进附加系统提示词(与配方提示拼接不覆盖),输出注明指针已附", async () => {
		const home = makeHome("disp", "# 配方\n- 名字: 前端\n");
		const host = makeHost(home);
		const { repo, cardsDir } = makeRepo("disp-repo");
		const cardNo = await makeCard(cardsDir, "修登录", "前端");
		const script = writeScript("disp", FAKE_IDLE);
		// 先落一轮交接(同 key 恒定一文件),再重开会话——热会话在场且交接文件幸存才是指针的触发面
		await host.spawn({ 部门: "前端", 项目根: repo, 命令: process.execPath, 参数: [script] });
		await host.teardown("前端", repo);
		await host.spawn({ 部门: "前端", 项目根: repo, 命令: process.execPath, 参数: [script] });
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, {
			runner,
			signals: false,
			resolveCardsDir: () => cardsDir,
			resolvePaoHome: () => home,
			host,
		});
		const tool = captured.tools.find((t) => t.name === "pao_dispatch_card")!;

		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "单卡派发" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content[0]?.text).toContain("已把交接页指针附进派卡信封");
		await face.waitForBackground(); // B 档:指针注入发生在后台链的 run 里
		const prompt = runner.runs[0]?.附加系统提示词 ?? [];
		expect(prompt).toHaveLength(3); // 配方＋交接页指针＋黑板指针(M2-03 压轴)
		expect(prompt[0]).toBe(join(home, "部门", "前端", "配方.md")); // 配方提示仍在,不被指针覆盖
		expect(prompt[1]).toContain("背景核对");
		expect(prompt[1]).toContain("不是续跑指令");
		expect(prompt[2]).toContain("任务黑板:");
		expect(readCard(join(cardsDir, `卡${cardNo}-修登录.md`)).frontmatter.status).toBe("in_progress");
	});

	it("指纹不一致:派卡输出提示建议重开,但不杀会话、派单照常", async () => {
		const home = makeHome("disp2", "# 配方\n- 名字: 前端\n");
		const host = makeHost(home);
		const { repo, cardsDir } = makeRepo("disp2-repo");
		const cardNo = await makeCard(cardsDir, "修登录", "前端");
		const script = writeScript("disp2", FAKE_IDLE);
		await host.spawn({ 部门: "前端", 项目根: repo, 命令: process.execPath, 参数: [script] });
		// 派卡前配方被改:机械比对不一致
		writeFileSync(join(home, "部门", "前端", "配方.md"), "# 配方\n- 名字: 前端\n- 工具: read\n", "utf8");
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, {
			runner,
			signals: false,
			resolveCardsDir: () => cardsDir,
			resolvePaoHome: () => home,
			host,
		});
		const tool = captured.tools.find((t) => t.name === "pao_dispatch_card")!;

		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "配方变更后的派发" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content[0]?.text).toContain("配方已变更");
		expect(result.content[0]?.text).toContain("建议重开");
		await face.waitForBackground();
		expect(runner.runs).toHaveLength(1); // 派单照常
		expect(host.hotSession("前端", repo)).toBeDefined(); // 宿主不自动杀
	});

	it("无热会话:不指针不提示,派单行为与原先一致", async () => {
		const home = makeHome("disp3", "# 配方\n- 名字: 前端\n");
		const host = makeHost(home);
		const { cardsDir } = makeRepo("disp3-repo");
		const cardNo = await makeCard(cardsDir, "修登录", "前端");
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, {
			runner,
			signals: false,
			resolveCardsDir: () => cardsDir,
			resolvePaoHome: () => home,
			host,
		});
		const tool = captured.tools.find((t) => t.name === "pao_dispatch_card")!;
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "普通派发" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content[0]?.text).not.toContain("交接页");
		await face.waitForBackground();
		const prompt = runner.runs[0]?.附加系统提示词 ?? [];
		expect(prompt).toHaveLength(2); // 配方＋黑板指针(M2-03);无交接页指针
		expect(prompt[0]).toBe(join(home, "部门", "前端", "配方.md"));
		expect(prompt[1]).toContain("任务黑板:");
		expect(prompt.join("\n")).not.toContain("背景核对");
	});
});
