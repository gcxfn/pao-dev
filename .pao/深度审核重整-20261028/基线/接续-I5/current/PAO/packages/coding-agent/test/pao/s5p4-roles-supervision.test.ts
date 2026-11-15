import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard, readCard } from "../../src/pao/cards/index.ts";
import type { FanoutCardResult, FanoutSummary } from "../../src/pao/fanout/execute.ts";
import { formatFanoutSummary } from "../../src/pao/fanout/execute.ts";
import {
	buildWorkerPrompt,
	OWNER_DISPATCH_DISCIPLINES,
	RECIPE_METHOD_HEADING,
	resolveDispatchParameters,
	taskStateRoutingLine,
} from "../../src/pao/worker/dispatch-core.ts";
import { DISPATCH_NOTIFY_SECTION, registerWorkerTools } from "../../src/pao/worker/index.ts";
import type { WorkerReceipt, WorkerStatus } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { fireSessionShutdownHandlers } from "./fixtures/session-shutdown.ts";

/**
 * S5 包4（角色与监督）四写法：
 * ① 配方双层——概要常驻注入、详细干法按需读取（配方加厚不增加常驻 token）；
 * ② 回执标签路由——任务态标签→处理动作对照，办完即停不忙等（派单通知/扇出摘要同源单源）；
 * ③ 只许/禁止清单白纸黑字写进角色提示词（worker 提示词＋pao_dispatch_card 描述＝主控/部长面）；
 * ④ 派完即停＋主控监督由消息唤醒（不建模型轮询；机械计时≠监督员轮询，钉子）。
 * 全离线：runner 为桩，不调用模型。
 */

const tempDirs: string[] = [];
const shutdowns: (() => unknown)[] = [];
const envKeys = ["PAO_ROLE", "PAO_DEPT", "PAO_HOME"] as const;
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
	const dir = mkdtempSync(join(tmpdir(), `pao-s5p4-${prefix}-`));
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

/** 假运行器:不 spawn,登记进真实注册表后返回假回执 */
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
		description?: string;
		parameters?: { properties?: Record<string, unknown> };
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

async function settle(face: { waitForBackground: () => Promise<void> }, captured: Captured): Promise<string> {
	await face.waitForBackground();
	const sections: Record<string, string> = {};
	captured.handlers.get("before_agent_start")?.({ systemPromptOptions: { sections } });
	return sections[DISPATCH_NOTIFY_SECTION] ?? "";
}

// ── ① 配方双层：概要常驻 / 干法按需 ─────────────────────────────────────────

describe("配方双层（概要常驻/干法按需）", () => {
	test("worker 保留旧常量导出,并与其他配方读取面共用同一标记值", () => {
		expect(RECIPE_METHOD_HEADING).toBe("## 干法");
	});

	async function recipeFixture(recipe: string): Promise<{ home: string; cardsDir: string; 卡号: number }> {
		const home = tempDir("recipe");
		const cardsDir = join(home, ".pao", "任务", "卡");
		mkdirSync(cardsDir, { recursive: true });
		mkdirSync(join(home, "部门", "核心机制"), { recursive: true });
		writeFileSync(join(home, "部门", "核心机制", "配方.md"), recipe, "utf8");
		const card = await createCard(cardsDir, {
			目标: "双层配方卡",
			部门: "核心机制",
			验收: "可判",
			创建: "2026-10-07 10:00",
		});
		return { home, cardsDir, 卡号: card.card_no };
	}

	test("带「## 干法」段的配方：只注入概要＋按需指针，干法正文不常驻", async () => {
		const recipe = [
			"# 配方:核心机制",
			"",
			"- 名字:核心机制",
			"- 人设:概要人设行",
			"",
			"## 干法",
			"",
			"详细干法正文特征串-不应常驻:第一步如何如何,第二步如何如何(数十行)",
			"",
		].join("\n");
		const { home, cardsDir, 卡号 } = await recipeFixture(recipe);
		const card = readCard(join(cardsDir, `卡${String(卡号).padStart(4, "0")}-双层配方卡.md`));
		const resolved = resolveDispatchParameters(card, cardsDir, home);
		expect(resolved.附加系统提示词).toHaveLength(1);
		const injected = resolved.附加系统提示词?.[0] ?? "";
		expect(injected).toContain("- 人设:概要人设行");
		expect(injected).toContain("按需读取");
		expect(injected).toContain(join(home, "部门", "核心机制", "配方.md"));
		expect(injected).not.toContain("详细干法正文特征串");
	});

	test("钉子：无干法段的配方整文件路径注入（旧配方零行为变化）", async () => {
		const { home, cardsDir, 卡号 } = await recipeFixture("# 配方:核心机制\n\n- 名字:核心机制\n- 人设:旧式整份\n");
		const card = readCard(join(cardsDir, `卡${String(卡号).padStart(4, "0")}-双层配方卡.md`));
		const resolved = resolveDispatchParameters(card, cardsDir, home);
		expect(resolved.附加系统提示词).toEqual([join(home, "部门", "核心机制", "配方.md")]);
	});
});

// ── ② 回执标签路由：任务态→处理动作，办完即停 ────────────────────────────────

describe("回执标签路由（taskStateRoutingLine 单源）", () => {
	test("四标签各有处理动作，均不含忙等/轮询语义", () => {
		expect(taskStateRoutingLine("completed")).toContain("机械验收");
		expect(taskStateRoutingLine("completed")).toContain("办完即停");
		expect(taskStateRoutingLine("completed_with_deviations")).toContain("审");
		expect(taskStateRoutingLine("blocked")).toContain("用户输入");
		expect(taskStateRoutingLine("checkpoint")).toContain("指引");
	});

	test("派单完成通知带任务态路由行（标签到达再进，不忙等）", async () => {
		const dir = tempDir("notify-route");
		const cardsDir = join(dir, "卡");
		mkdirSync(cardsDir, { recursive: true });
		const card = await createCard(
			cardsDir,
			{ 目标: "路由通知卡", 部门: "测试", 验收: "完成", 创建: "2026-10-07 10:00" },
			{ counterPath: join(cardsDir, "..", "卡号.txt") },
		);
		const cardNo = String(card.card_no).padStart(4, "0");
		const runner = new FakeRunner();
		runner.receipts.set(cardNo, { ...fakeReceipt(cardNo), 任务态: "completed_with_deviations" });
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
		const tool = captured.tools.find((t) => t.name === "pao_dispatch_card");
		if (!tool) throw new Error("未注册 pao_dispatch_card");
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "路由测试" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		const notice = await settle(face, captured);
		expect(notice).toContain("任务态 completed_with_deviations");
		expect(notice).toContain(taskStateRoutingLine("completed_with_deviations"));
	});

	test("扇出摘要每卡带任务态路由行", () => {
		const row: FanoutCardResult = {
			卡号: "0001",
			终态: "成功",
			attempt: 1,
			摘要: "扇出卡",
			任务态: "checkpoint",
		};
		const summary: FanoutSummary = {
			plan: { 并发上限: 2, 重复剔除: [], 拉起顺序: ["0001"], 波次: [["0001"]] },
			结果: [row],
			count: { 成功: 1, 失败: 0, 结果未知: 0, 取消: 0, 未拉起: 0 },
			已停止: false,
			全部完成: true,
		};
		const text = formatFanoutSummary(summary);
		expect(text).toContain("任务态 checkpoint");
		expect(text).toContain(taskStateRoutingLine("checkpoint"));
	});
});

// ── ③ 只许/禁止清单写进角色提示词 ───────────────────────────────────────────

describe("只许/禁止清单（白纸黑字进提示词）", () => {
	test("worker 提示词：只许行＋禁止清单（不得再派发/不得谎报）", () => {
		const prompt = buildWorkerPrompt(
			{
				card_no: 17,
				path: "D:/x/卡0017-y.md",
				filename: "卡0017-y.md",
				frontmatter: {
					goal: "测试",
					dept: "测试",
					acceptance: "测试",
					attempt: 1,
					created: "2026-10-07 10:00",
					status: "unclaimed",
				},
				body: "",
				receipts: [],
			},
			1,
		);
		expect(prompt).toContain("只许");
		expect(prompt).toContain("禁止");
		expect(prompt).toContain("不得再派发子任务");
		expect(prompt).toContain("只写任务工作区与目标项目");
		expect(prompt).toContain("不得谎报");
	});

	test("主控/部长面保留单写者，按需取证与消息唤醒，不要求人工转述正常交接", () => {
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner: new FakeRunner(), signals: false });
		const tool = captured.tools.find((t) => t.name === "pao_dispatch_card");
		if (!tool) throw new Error("未注册 pao_dispatch_card");
		const description = tool.description ?? "";
		expect(description).toContain(OWNER_DISPATCH_DISCIPLINES);
		expect(description).toContain("单写者");
		expect(description).toContain("按需读取产物和证据");
		expect(description).toContain("正常交接由程序推进");
		expect(description).toContain("派完即停");
	});
});

// ── ④ 派完即停＋监督消息唤醒（钉子） ────────────────────────────────────────

describe("派完即停与监督唤醒（钉子）", () => {
	test("派单工具即时回执声明不等 worker、回执经通知唤醒（既有行为钉住）", async () => {
		const dir = tempDir("stop-after-dispatch");
		const cardsDir = join(dir, "卡");
		mkdirSync(cardsDir, { recursive: true });
		const card = await createCard(
			cardsDir,
			{ 目标: "即停卡", 部门: "测试", 验收: "完成", 创建: "2026-10-07 10:00" },
			{ counterPath: join(cardsDir, "..", "卡号.txt") },
		);
		const cardNo = String(card.card_no).padStart(4, "0");
		const runner = new FakeRunner();
		const captured = capturePi();
		const face = registerWorkerTools(captured.pi, { runner, signals: false, resolveCardsDir: () => cardsDir });
		const tool = captured.tools.find((t) => t.name === "pao_dispatch_card");
		if (!tool) throw new Error("未注册 pao_dispatch_card");
		const result = await tool.execute(
			"t",
			{ card_ref: cardNo, reason: "即停钉子" },
			undefined,
			undefined,
			{} as never,
		);
		// 受理即返回：文本声明不等 worker、期间可继续干别的（派完即停的既有写法）
		const text = textOf(result);
		expect(text).toContain("不等 worker");
		expect(text).toContain("期间可继续干别的");
		// 通知经 before_agent_start 注入送达（消息唤醒面；机械静默计时≠监督员模型轮询）
		const notice = await settle(face, captured);
		expect(notice).toContain("派卡完成");
	});
});
