import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard, readCard } from "../../src/pao/cards/index.ts";
import { registerFanout } from "../../src/pao/fanout/index.ts";
import { DISPATCH_NOTIFY_SECTION, registerWorkerTools } from "../../src/pao/worker/index.ts";
import type { WorkerReceipt, WorkerStatus } from "../../src/pao/worker/receipt.ts";
import { ProcessRegistry } from "../../src/pao/worker/registry.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

/**
 * pao_dispatch_card(单卡派发)＋扇出理由字段＋登记表扩展(部门/派单理由)。
 * 子进程一律不真实拉起:FakeRunner 覆写 run(),只登记进注册表并返回假回执。
 */

const tempDirs: string[] = [];
const shutdowns: (() => unknown)[] = [];
const envKeys = ["PAO_ROLE", "PAO_DEPT", "PAO_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of envKeys) savedEnv[key] = process.env[key];
});

afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
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

function fakeReceipt(cardNo: string, status: WorkerStatus = "success"): WorkerReceipt {
	return {
		card_no: cardNo,
		attempt: 1,
		status: status,
		artifact_path: [],
		summary: "假回执:做完了",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: join(tempDir("证据"), `卡${cardNo}.jsonl`),
		exitCode: 0,
		command: "fake-runner",
		pid: -1,
		duration_ms: 1,
	};
}

/** 假运行器:不 spawn,登记进真实注册表(带部门/派单理由)后返回假回执 */
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	receipts = new Map<string, WorkerReceipt>();

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
		return this.receipts.get(options.卡号) ?? fakeReceipt(options.卡号);
	}
}

interface Captured {
	tools: {
		name: string;
		execute: (...args: unknown[]) => Promise<{ content: { text?: string }[]; details: unknown; isError?: boolean }>;
	}[];
	handlers: Map<string, (event: unknown) => unknown>;
	pi: ExtensionAPI;
}

function capturePi(): Captured {
	const captured: Captured = { tools: [], handlers: new Map(), pi: undefined as unknown as ExtensionAPI };
	captured.pi = {
		registerTool: (tool: { name: string }) => captured.tools.push(tool as never),
		on: (event: string, handler: (event: unknown) => unknown) => {
			captured.handlers.set(event, handler);
			if (event === "session_shutdown") shutdowns.push(handler as never);
			return () => {};
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	return captured;
}

function textOf(result: { content: { text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

async function makeCard(cardsDir: string, goal: string, dept: string): Promise<string> {
	mkdirSync(cardsDir, { recursive: true });
	const parsed = await createCard(
		cardsDir,
		{ 目标: goal, 部门: dept, 验收: "完成", 创建: "2026-10-02 10:00" },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
	return String(parsed.card_no).padStart(4, "0");
}

function dispatchTool(captured: Captured): Captured["tools"][number] {
	const tool = captured.tools.find((t) => t.name === "pao_dispatch_card");
	if (!tool) throw new Error(`未注册 pao_dispatch_card,实际:${captured.tools.map((t) => t.name).join("、")}`);
	return tool;
}

/**
 * B 档非阻塞契约:waitForBackground 派卡链收敛,再消费式读一轮「pao 派卡通知」——
 * 认领/回执/被拒/完成都以后台通知送达,工具回执只含「已派出」与同步快校验(定位/权限)。
 */
async function settle(face: { waitForBackground: () => Promise<void> }, captured: Captured): Promise<string> {
	await face.waitForBackground();
	const sections: Record<string, string> = {};
	captured.handlers.get("before_agent_start")?.({ systemPromptOptions: { sections } });
	return sections[DISPATCH_NOTIFY_SECTION] ?? "";
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** git 仓库 fixture:仓库根即任务工作区上级,提交干净基线供认领快照 */
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

// ── 理由必填 ─────────────────────────────────────────────────────────────

describe("pao_dispatch_card:理由必填(派前自省,留痕供审查)", () => {
	it("缺参/空串/纯空格一律拒,卡不动、不拉起", async () => {
		const dir = tempDir("dispatch");
		const cardsDir = join(dir, "卡");
		const cardNo = await makeCard(cardsDir, "任务一", "测试");
		const runner = new FakeRunner();
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
		const tool = dispatchTool(captured);

		for (const rationale of [undefined, "", "   "] as const) {
			const result = await tool.execute(
				"t",
				rationale === undefined ? { 卡号: cardNo } : { card_ref: cardNo, reason: rationale },
				undefined,
				undefined,
				{} as never,
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("reason 必填");
			expect(textOf(result)).toContain("派前自省");
		}
		expect(runner.runs).toHaveLength(0);
		expect(readCard(join(cardsDir, `卡${cardNo}-任务一.md`)).frontmatter.status).toBe("unclaimed");
	});

	it("注册面:registerWorkerTools 装出 pao_dispatch_card(主控/部长共面,worker 角色整模块跳过)", () => {
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner: new FakeRunner(), signals: false });
		expect(captured.tools.map((t) => t.name)).toContain("pao_dispatch_card");
	});
});

// ── 权限矩阵(fail-closed) ────────────────────────────────────────────────

describe("pao_dispatch_card:权限矩阵(部长只派本部门卡,缺 PAO_DEPT 拒)", () => {
	async function setup(cardDept: string): Promise<{
		tool: Captured["tools"][number];
		face: ReturnType<typeof registerWorkerTools>;
		captured: Captured;
		runner: FakeRunner;
		cardsDir: string;
		cardNo: string;
	}> {
		const dir = tempDir("dispatch-perm");
		const cardsDir = join(dir, "卡");
		const cardNo = await makeCard(cardsDir, "任务", cardDept);
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
		return { tool: dispatchTool(captured), face, captured, runner, cardsDir, cardNo: cardNo };
	}

	it("主控:任意部门卡 OK,owner 置为「主控」", async () => {
		delete process.env.PAO_ROLE;
		delete process.env.PAO_DEPT;
		const { tool, face, captured, runner, cardsDir, cardNo } = await setup("前端");
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "主控加派人手" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("已派出");
		const notice = await settle(face, captured);
		const card = readCard(join(cardsDir, `卡${cardNo}-任务.md`));
		expect(card.frontmatter.status).toBe("in_progress");
		expect(card.frontmatter.owner).toBe("主控");
		expect(runner.runs[0]?.卡号).toBe(cardNo);
		expect(notice).toContain("owner:主控");
	});

	it("部长+PAO_DEPT 匹配:OK,owner 置为 PAO_DEPT 值", async () => {
		process.env.PAO_ROLE = "部长";
		process.env.PAO_DEPT = "前端";
		const { tool, face, captured, runner, cardsDir, cardNo } = await setup("前端");
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "本部门积压,加派" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		const notice = await settle(face, captured);
		const card = readCard(join(cardsDir, `卡${cardNo}-任务.md`));
		expect(card.frontmatter.owner).toBe("前端");
		expect(runner.runs[0]?.卡号).toBe(cardNo);
		expect(notice).toContain("owner:前端");
	});

	it("部长+不匹配部门:拒派,卡保持待认领、不拉起", async () => {
		process.env.PAO_ROLE = "部长";
		process.env.PAO_DEPT = "后端";
		const { tool, runner, cardsDir, cardNo } = await setup("前端");
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "想跨部门派" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("不一致");
		expect(textOf(result)).toContain("前端");
		expect(runner.runs).toHaveLength(0);
		expect(readCard(join(cardsDir, `卡${cardNo}-任务.md`)).frontmatter.status).toBe("unclaimed");
	});

	it("部长+无 PAO_DEPT:拒派且报错写明 PAO_DEPT(fail-closed)", async () => {
		process.env.PAO_ROLE = "部长";
		delete process.env.PAO_DEPT;
		const { tool, runner, cardNo } = await setup("前端");
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "没设部门也想派" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("PAO_DEPT");
		expect(runner.runs).toHaveLength(0);
	});

	it("worker 角色:显式拒派(纵深防御,不留「非部长即主控」暗门)", async () => {
		process.env.PAO_ROLE = "worker";
		delete process.env.PAO_DEPT;
		const { tool, runner, cardsDir, cardNo } = await setup("前端");
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "worker 也想派" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("worker 角色不得派单");
		expect(runner.runs).toHaveLength(0);
		expect(readCard(join(cardsDir, `卡${cardNo}-任务.md`)).frontmatter.status).toBe("unclaimed");
	});
});

// ── 部门并发上限(配额护栏:文件/键缺失时缺省 3 照样生效) ────────────────────

describe("pao_dispatch_card:部门并发上限(同部门活进程数,达上限拒派)", () => {
	function seedAlive(runner: FakeRunner, dept: string | null, count: number): void {
		for (let i = 0; i < count; i++) {
			runner.registry.register({
				pid: 800000 + i,
				card_no: `9${String(i).padStart(3, "0")}`,
				command: "占位",
				dept: dept,
				dispatch_reason: "占位",
			});
		}
	}

	async function setup(
		cardsDir: string,
		cardDept: string,
	): Promise<{
		tool: Captured["tools"][number];
		face: ReturnType<typeof registerWorkerTools>;
		captured: Captured;
		runner: FakeRunner;
		cardNo: string;
	}> {
		const cardNo = await makeCard(cardsDir, "任务", cardDept);
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
		return { tool: dispatchTool(captured), face, captured, runner, cardNo: cardNo };
	}

	it("无 PAO_HOME:部门上限 3 与跨部门共享名额同时生效", async () => {
		delete process.env.PAO_HOME;
		const dir = tempDir("dispatch-cap");
		const cardsDir = join(dir, "卡");
		const { tool, face, captured, runner, cardNo } = await setup(cardsDir, "测试");
		seedAlive(runner, "测试", 3);

		// B 档:名额护栏在后台链里 fail-closed,受理不报错、拒绝走派卡通知
		const rejected = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "超限了吗" },
			undefined,
			undefined,
			{} as never,
		);
		expect(rejected.isError).toBeUndefined();
		const rejectFirst = await settle(face, captured);
		expect(rejectFirst).toContain("[派卡被拒]");
		expect(rejectFirst).toContain("并发上限 3");
		expect(rejectFirst).toContain("保温.json");
		expect(runner.runs).toHaveLength(0);

		const otherDept = await makeCard(cardsDir, "另一部门任务", "前端");
		const allowed = await tool.execute(
			"t",
			{ card_ref: otherDept, reason: "别的部门没超" },
			undefined,
			undefined,
			{} as never,
		);
		expect(allowed.isError).toBeUndefined();
		const rejectSecond = await settle(face, captured);
		expect(rejectSecond).toContain("[派卡被拒]");
		expect(rejectSecond).toContain("共享并发名额");
		for (let i = 0; i < 3; i++) runner.registry.markExited(800000 + i);
		const afterExit = await tool.execute(
			"t",
			{ card_ref: otherDept, reason: "共享名额已腾出" },
			undefined,
			undefined,
			{} as never,
		);
		expect(afterExit.isError).toBeUndefined();
		const succeeded = await settle(face, captured);
		expect(succeeded).toContain("[派卡完成]");
	});

	it("设了 PAO_HOME 但无保温文件:照样按缺省 3 拒(护栏不因配置缺失而失效)", async () => {
		const home = tempDir("pao-home");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		process.env.PAO_HOME = home;
		const dir = tempDir("dispatch-cap2");
		const cardsDir = join(dir, "卡");
		const { tool, face, captured, runner, cardNo } = await setup(cardsDir, "测试");
		seedAlive(runner, "测试", 3);

		const rejected = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "配置空着也想派" },
			undefined,
			undefined,
			{} as never,
		);
		expect(rejected.isError).toBeUndefined();
		const notice = await settle(face, captured);
		expect(notice).toContain("[派卡被拒]");
		expect(notice).toContain("缺省 3");
	});

	it("保温.json 写「部门并发上限」:1 → 按 1 拒;清零后可派", async () => {
		const home = tempDir("pao-home-cap");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify({ 部门并发上限: 1 }), "utf8");
		process.env.PAO_HOME = home;
		const dir = tempDir("dispatch-cap3");
		const cardsDir = join(dir, "卡");
		const { tool, face, captured, runner, cardNo } = await setup(cardsDir, "测试");
		seedAlive(runner, "测试", 1);

		const rejected = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "上限1也想塞" },
			undefined,
			undefined,
			{} as never,
		);
		expect(rejected.isError).toBeUndefined();
		const reject = await settle(face, captured);
		expect(reject).toContain("[派卡被拒]");
		expect(reject).toContain("并发上限 1");
		expect(runner.runs).toHaveLength(0);

		runner.registry.markExited(800000);
		const allowed = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "腾出一个坑位了" },
			undefined,
			undefined,
			{} as never,
		);
		expect(allowed.isError).toBeUndefined();
		const ok = await settle(face, captured);
		expect(ok).toContain("[派卡完成]");
	});
});

// ── 认领与基线走既有链路 ─────────────────────────────────────────────────

describe("pao_dispatch_card:认领(待认领→进行中)＋基线快照＋登记,与扇出同链路", () => {
	it("真 git 仓库:认领改状态+owner,基线快照文件出现,回执落卡,登记表带部门+派单理由", async () => {
		const { cardsDir } = makeRepo("dispatch-claim");
		const cardNo = await makeCard(cardsDir, "修登录", "前端");
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
		const tool = dispatchTool(captured);

		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "单卡加急,派一个" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		const notice = await settle(face, captured); // B 档:认领/基线/回执都在后台链里

		// 认领走状态机:待认领→进行中,尝试 +1,无主卡 owner=派单者(主控)
		const cardPath = join(cardsDir, `卡${cardNo}-修登录.md`);
		const card = readCard(cardPath);
		expect(card.frontmatter.status, notice).toBe("in_progress");
		expect(card.frontmatter.attempt).toBe(1);
		expect(card.frontmatter.owner).toBe("主控");

		// 认领基线快照文件出现(R14 链路)
		const snapshotPath = join(cardsDir, "..", "基线", `卡${cardNo}-基线.txt`);
		expect(existsSync(snapshotPath)).toBe(true);
		expect(notice).toContain("认领基线:快照已落");

		// 回执落卡(共享 appendDispatchReceipt)
		expect(readCard(cardPath).receipts).toHaveLength(1);
		expect(notice).toContain("派单理由:单卡加急,派一个");

		// 登记表:部门=卡.部门,派单理由=工具理由
		expect(runner.registry.list()).toHaveLength(1);
		const entry = runner.registry.list()[0];
		expect(entry.dept).toBe("前端");
		expect(entry.dispatch_reason).toBe("单卡加急,派一个");
		expect(entry.running).toBe(false);

		// runOptions:卡号四位、提示词只给卡文件指针
		expect(runner.runs[0]?.卡号).toBe(cardNo);
		expect(runner.runs[0]?.提示词).toContain(cardPath);
	});

	it("进行中卡不双跑(与扇出同一把关),派单即时回执直接给拒派原因(2026-10-05 修)", async () => {
		const dir = tempDir("dispatch-claim2");
		const cardsDir = join(dir, "卡");
		const cardNo = await makeCard(cardsDir, "任务", "测试");
		const { changeCardStatus } = await import("../../src/pao/cards/index.ts");
		changeCardStatus(readCard(join(cardsDir, `卡${cardNo}-任务.md`)), {
			操作者: "主控",
			to: "in_progress",
			时间: "2026-10-02 10:01",
		});
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
		const tool = dispatchTool(captured);

		const result = await tool.execute("t", { card_ref: cardNo, reason: "想双跑" }, undefined, undefined, {} as never);
		// 同步拒派:即时回执直接带原因,不再「已派出」后等派卡通知
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("派单未执行");
		expect(result.content[0]?.text).toContain("不双跑");
		const notice = await settle(face, captured);
		expect(notice).not.toContain("[派卡被拒]"); // 同步已拒,后台无链、无重复通知
		expect(runner.runs).toHaveLength(0);
		expect(readCard(join(cardsDir, `卡${cardNo}-任务.md`)).frontmatter.attempt).toBe(1);
	});
});

// ── 登记表扩展 ───────────────────────────────────────────────────────────

describe("登记表扩展:部门/派单理由 可空字段", () => {
	it("register 不带新字段:归一为 null(不是 undefined)", () => {
		const registry = new ProcessRegistry();
		registry.register({ pid: 1, card_no: "0001", command: "x" });
		const entry = registry.list()[0];
		expect(entry.dept).toBeNull();
		expect(entry.dispatch_reason).toBeNull();
	});

	it("register 显式带新字段:原样保留", () => {
		const registry = new ProcessRegistry();
		registry.register({ pid: 2, card_no: "0002", command: "x", dept: "前端", dispatch_reason: "积压加派" });
		const entry = registry.list()[0];
		expect(entry.dept).toBe("前端");
		expect(entry.dispatch_reason).toBe("积压加派");
	});

	it("pao_inventory worker 行显示部门+派单理由,理由截断到一行合理长度", async () => {
		const dir = tempDir("dispatch-inv");
		const workspace = join(dir, "任务A");
		mkdirSync(join(workspace, "卡"), { recursive: true });
		writeFileSync(
			join(workspace, "卡", "卡0001-任务.md"),
			"---\n目标: 做事\n尝试: 1\n状态: 进行中\n---\n\n做事中\n",
			"utf8",
		);
		const runner = new FakeRunner();
		runner.registry.register({
			pid: 111,
			card_no: "0001",
			command: "x",
			dept: "前端",
			dispatch_reason:
				"这是为了修登录页的紧急缺陷而加派的 worker,理由写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长,应当被截断",
		});
		runner.registry.register({ pid: 222, card_no: "0002", command: "x" });
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner, signals: false });
		const tool = captured.tools.find((t) => t.name === "pao_inventory")!;

		const result = await tool.execute("t", { workspace: workspace }, undefined, undefined, {} as never);
		const text = textOf(result);
		expect(text).toContain("后台进程 2 个");
		expect(text).toContain("pid=111 卡0001〔前端〕运行中");
		expect(text).toContain("…"); // 长理由被截断
		expect(text).not.toContain("应当被截断"); // 截断后不整行照搬
		expect(text).toContain("pid=222 卡0002〔无部门〕运行中:理由 -");
	});
});

// ── pao_fanout:批量理由 ────────────────────────────────────────────────────

describe("pao_fanout:批量理由必填并留痕", () => {
	it("无理由/空串拒,整批不执行", async () => {
		const dir = tempDir("dispatch-fanout");
		const cardsDir = join(dir, "卡");
		await makeCard(cardsDir, "任务一", "测试");
		const captured = capturePi();
		registerFanout(captured.pi, { resolveCardsDir: () => cardsDir, runner: new FakeRunner() });
		const tool = captured.tools[0];

		for (const rationale of [undefined, "", "  "] as const) {
			const params = rationale === undefined ? { card_refs: ["1"] } : { card_refs: ["1"], reason: rationale };
			const result = await tool.execute("t", params, undefined, undefined, {} as never);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("reason 必填");
		}
	});

	it("带理由:登记表逐条带派单理由,聚合摘要带理由", async () => {
		const dir = tempDir("dispatch-fanout2");
		const cardsDir = join(dir, "卡");
		const card1 = await makeCard(cardsDir, "任务一", "测试");
		const card2 = await makeCard(cardsDir, "任务二", "测试");
		const runner = new FakeRunner();
		const captured = capturePi();
		registerFanout(captured.pi, { resolveCardsDir: () => cardsDir, runner });
		const tool = captured.tools[0];

		const result = await tool.execute(
			"t",
			{ card_refs: [card1, card2], reason: "整批评审前赶工" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		const text = textOf(result);
		expect(text).toContain("扇出完成:2 张卡");
		expect(text).toContain("派单理由:整批评审前赶工");

		const summary = result.details as { 理由?: string; count: { 成功: number } };
		expect(summary.理由).toBe("整批评审前赶工");
		expect(summary.count.成功).toBe(2);

		// 登记表逐条带理由;每条都填卡.部门
		const entries = runner.registry.list();
		expect(entries).toHaveLength(2);
		for (const entry of entries) {
			expect(entry.dispatch_reason).toBe("整批评审前赶工");
			expect(entry.dept).toBe("测试");
		}
		// 每张卡都落了回执(缺省落卡走共享 appendDispatchReceipt)
		for (const [cardNo, goal] of [
			[card1, "任务一"],
			[card2, "任务二"],
		] as const) {
			expect(readCard(join(cardsDir, `卡${cardNo}-${goal}.md`)).receipts).toHaveLength(1);
		}
	});
});
