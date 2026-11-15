/**
 * T03 验收：单一派发事务链的故障注入与入口准入一致性（离线假 runner,不调用模型）。
 * 故障注入四场景:锁等待期间取消 / 认领后启动失败 / 回执写入失败 / 并发额度耗尽——
 * 失败不留假成功、不留无主锁,资源逆序释放后可再派。
 * 入口一致性(T02 遗留收口):同一张 v2 工作流卡,单卡(pao_dispatch_card)/扇出(pao_fanout)与自动链
 * 用同一 owner 判断——错误会话身份三处同拒,正确会话身份同放。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, SessionShutdownEvent } from "../../src/core/extensions/types.ts";
import { type CardCreateInput, createCard, type ParsedCard, readCard } from "../../src/pao/cards/index.ts";
import { registerFanout } from "../../src/pao/fanout/index.ts";
import { executeDispatch, locateDispatchCard } from "../../src/pao/worker/dispatch-core.ts";
import { PaoWorkerError } from "../../src/pao/worker/errors.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import { dispatchLockLogPath, isProjectLocked } from "../../src/pao/worker/lock.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { addNodeCards, bindMinister, readControl, startControl } from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { listStarterTemplates } from "../../src/pao/workflow/templates.ts";

const dirs: string[] = [];
const runners: WorkerRunner[] = [];
const shutdowns: ((event: SessionShutdownEvent) => unknown)[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	const cleanups: (() => void | Promise<void>)[] = [];
	for (const shutdown of shutdowns.splice(0))
		await shutdown({
			type: "session_shutdown",
			reason: "quit",
			onConfirmedShutdown: (cleanup) => cleanups.push(cleanup),
		});
	for (const cleanup of cleanups) await cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-dispatch-fault-"));
	dirs.push(dir);
	return dir;
}
async function until(cond: () => boolean, description = "条件等待超时"): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (cond()) return;
		await new Promise((done) => setTimeout(done, 10));
	}
	throw new Error(description);
}
async function card(cardsDir: string, extra: Partial<CardCreateInput> = {}): Promise<ParsedCard> {
	mkdirSync(cardsDir, { recursive: true });
	return createCard(
		cardsDir,
		{ 目标: "离线任务", 部门: "测试", 验收: "完成", 创建: "2026-10-06 10:00", ...extra },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}
function receipt(options: WorkerRunOptions): WorkerReceipt {
	return {
		card_no: options.卡号,
		card_path: options.卡路径,
		attempt: options.尝试号 ?? 1,
		status: "success",
		artifact_path: [],
		summary: "离线假回执",
		usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 0, turns: 1 },
		工具调用次数: 0,
		evidence_path: "",
		exitCode: 0,
		command: "mock",
		pid: -1,
		duration_ms: 1,
	};
}
/** 门控 runner:run 挂起等 release(占住名额/写锁),或按模式立即失败/成功。名额与登记逻辑用真基类。 */
class GatedRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	mode: "挂起" | "失败" | "成功";
	#gates = new Map<string, (value: WorkerReceipt) => void>();
	constructor(mode: "挂起" | "失败" | "成功" = "挂起") {
		super();
		this.mode = mode;
	}
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		if (this.mode === "失败") throw new PaoWorkerError("无效参数", "模拟拉起失败");
		if (this.mode === "成功") return receipt(options);
		return new Promise<WorkerReceipt>((resolve) => this.#gates.set(options.卡路径 ?? options.卡号, resolve));
	}
	releaseAll(): void {
		for (const [key, resolve] of [...this.#gates]) {
			this.#gates.delete(key);
			resolve(receipt({ 卡号: key, 卡路径: key, 提示词: "" }));
		}
	}
}
/** 派发链最小选项:普通卡(无工作流标记)的校验回调恒 undefined。 */
type DispatchOptions = Parameters<typeof executeDispatch>[1];
function opts(runner: WorkerRunner, extra: Partial<DispatchOptions> = {}): DispatchOptions {
	return { 运行器: runner, workflowCheck: () => undefined, ...extra };
}
function claim(cardsDir: string, target: ParsedCard): Parameters<typeof executeDispatch>[0] {
	return { cardsDir, card_no: String(target.card_no), operator: "主控", time: "2026-10-06 10:00" };
}
function cardState(cardsDir: string, cardRef: string): string {
	return locateDispatchCard(cardsDir, cardRef).frontmatter.status;
}

describe("T03 故障注入:锁等待期间取消", () => {
	it("执行锁等待中取消:立即终止,不认领不拉起,后续派发照常", async () => {
		const root = temp();
		const cardsDir = join(root, "卡");
		const first = await card(cardsDir);
		const second = await card(cardsDir);
		const runner = new GatedRunner();
		runners.push(runner);
		const firstChain = executeDispatch(claim(cardsDir, first), opts(runner), async () => "ok");
		await until(() => runner.runs.length === 1, "首张卡未进入 run");
		// 第二张同执行根写卡：确认实际进入锁等待后再取消，不能只测认领前早取消。
		const signal = new AbortController();
		const secondChain = executeDispatch(
			claim(cardsDir, second),
			{ ...opts(runner), 等待名额: true, 信号: signal.signal },
			async () => "ok",
		);
		let settled = false;
		const canceled = secondChain.then(
			() => {
				settled = true;
				return undefined;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		try {
			await until(() => {
				const log = dispatchLockLogPath(root);
				return (
					existsSync(log) &&
					readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.some((line) => {
							const event = JSON.parse(line);
							return event.action === "wait" && event.kind === "execution" && event.holder === second.path;
						})
				);
			}, "第二张卡未进入执行锁等待");
			signal.abort();
			await until(() => settled, "执行锁等待期间取消未及时返回");
			expect(await canceled).toMatchObject({ code: "已取消" });
		} finally {
			runner.releaseAll();
			await firstChain;
			await canceled;
		}
		expect(cardState(cardsDir, String(second.card_no))).toBe("unclaimed");
		expect(runner.runs).toHaveLength(1);
		// 取消等待者后，原持有者正常完成，同执行根下一张仍能派发。
		const third = await card(cardsDir);
		const thirdChain = executeDispatch(claim(cardsDir, third), opts(runner), async () => "ok");
		await until(() => runner.runs.length === 2, "第三张未进入 run");
		expect(cardState(cardsDir, String(third.card_no))).toBe("in_progress");
		runner.releaseAll();
		await thirdChain;
	}, 15_000);

	it("并发名额等待中取消(等待名额:true):不认领,放行在途后名额可再用", async () => {
		const rootA = temp();
		const rootB = temp();
		const cardsA = join(rootA, "卡");
		const cardsB = join(rootB, "卡");
		const holder = await card(cardsA);
		const waiter = await card(cardsB);
		const runner = new GatedRunner();
		runners.push(runner);
		const holderChain = executeDispatch(claim(cardsA, holder), opts(runner), async () => "ok");
		await until(() => runner.runs.length === 1, "占位卡未进入 run");
		// 不同项目(不同写队列),同一 runner 名额上限 1 已被占满→在 reserveDispatchSlot 等待
		const signal = new AbortController();
		const waiterChain = executeDispatch(
			claim(cardsB, waiter),
			{ ...opts(runner), 并发上限: 1, 等待名额: true, 信号: signal.signal },
			async () => "ok",
		);
		signal.abort();
		await expect(waiterChain).rejects.toThrow("派发在认领前已取消");
		expect(cardState(cardsB, String(waiter.card_no))).toBe("unclaimed");
		runner.releaseAll();
		await holderChain;
		// 名额已释放:同一张卡再派照常认领拉起
		const retry = executeDispatch(claim(cardsB, waiter), { ...opts(runner), 并发上限: 1 }, async () => "ok");
		await until(() => runner.runs.length === 2, "重试卡未进入 run");
		expect(cardState(cardsB, String(waiter.card_no))).toBe("in_progress");
		runner.releaseAll();
		const retryDone = await retry;
		expect(retryDone.可派).toBe(true);
	});
});

describe("T03 故障注入:认领后启动失败", () => {
	it("run 抛错:错误如实上抛(无假成功),写锁与名额照放,卡留进行中待 owner 落终态", async () => {
		const root = temp();
		const cardsDir = join(root, "卡");
		const target = await card(cardsDir);
		const runner = new GatedRunner("失败");
		runners.push(runner);
		await expect(executeDispatch(claim(cardsDir, target), opts(runner), async () => "ok")).rejects.toThrow(
			"模拟拉起失败",
		);
		runner.mode = "成功";
		expect(cardState(cardsDir, String(target.card_no))).toBe("in_progress");
		expect(readCard(target.path).receipts).toHaveLength(0);
		expect(await isProjectLocked(root)).toBe(false);
		// 名额未泄漏:并发上限 1 下另一张卡立即派发成功
		const other = await card(cardsDir);
		const next = await executeDispatch(claim(cardsDir, other), { ...opts(runner), 并发上限: 1 }, async () => "ok");
		expect(next.可派).toBe(true);
	});
});

describe("T03 故障注入:回执写入失败", () => {
	it("completed 落回执抛错:错误上抛不假成功,写锁与名额照放,卡上无回执", async () => {
		const root = temp();
		const cardsDir = join(root, "卡");
		const target = await card(cardsDir);
		const runner = new GatedRunner("成功");
		runners.push(runner);
		await expect(
			executeDispatch(claim(cardsDir, target), opts(runner), async () => {
				throw new Error("回执落卡失败:模拟");
			}),
		).rejects.toThrow("回执落卡失败:模拟");
		expect(cardState(cardsDir, String(target.card_no))).toBe("in_progress");
		expect(readCard(target.path).receipts).toHaveLength(0);
		expect(await isProjectLocked(root)).toBe(false);
		const other = await card(cardsDir);
		const next = await executeDispatch(claim(cardsDir, other), { ...opts(runner), 并发上限: 1 }, async () => "ok");
		expect(next.可派).toBe(true);
	});
});

describe("T03 故障注入:并发额度耗尽", () => {
	it("共享名额占满且不等待:立即拒派,卡不被认领;名额释放后同一张卡可再派", async () => {
		const rootA = temp();
		const rootB = temp();
		const cardsA = join(rootA, "卡");
		const cardsB = join(rootB, "卡");
		const holder = await card(cardsA);
		const target = await card(cardsB);
		const runner = new GatedRunner();
		runners.push(runner);
		const holderChain = executeDispatch(claim(cardsA, holder), opts(runner), async () => "ok");
		await until(() => runner.runs.length === 1, "占位卡未进入 run");
		await expect(
			executeDispatch(claim(cardsB, target), { ...opts(runner), 并发上限: 1, 等待名额: false }, async () => "ok"),
		).rejects.toThrow("共享并发名额已达上限 1");
		expect(cardState(cardsB, String(target.card_no))).toBe("unclaimed");
		expect(runner.runs).toHaveLength(1);
		runner.releaseAll();
		await holderChain;
		const retry = executeDispatch(
			claim(cardsB, target),
			{ ...opts(runner), 并发上限: 1, 等待名额: false },
			async () => "ok",
		);
		await until(() => runner.runs.length === 2, "重试卡未进入 run");
		expect(cardState(cardsB, String(target.card_no))).toBe("in_progress");
		runner.releaseAll();
		const retryDone = await retry;
		expect(retryDone.可派).toBe(true);
	});
});

// ── 入口准入一致性(T02 遗留收口):单卡/扇出与自动链对同一张工作流卡同判 ──────────

/** v2 工作流夹具:启流→绑部长→落一张带 实例/轮次 身份标记的节点卡(无技能声明,免 PAO_HOME)。 */
async function setupV2() {
	const home = temp();
	const template = listStarterTemplates().find((item) => item.id === "bugfix")!;
	const recipe = parseRecipe(template.content, `${template.name}.md`);
	recipe.节点[0].执行方式 = "拆解";
	recipe.节点[0].档位 = undefined;
	const options = {
		cardsDir: join(home, "任务", "卡"),
		ownerSessionId: "owner",
		counterPath: join(home, "counter"),
	};
	mkdirSync(join(home, "工作流"), { recursive: true });
	await startControl(
		recipe,
		{
			项目: home,
			目标: "修复",
			范围: "a.ts",
			验收: "文件存在",
			执行部门: "开发",
			测试部门: "开发",
			审查部门: "审查",
		},
		options,
	);
	await bindMinister(recipe, options, "开发", "session");
	const flow = readControl(recipe, options);
	const refs = await addNodeCards(recipe, options, { 实例: flow.实例, 节点: "开发", 轮次: 1, 部长会话: "session" }, [
		{ goal: "任务", acceptance: "文件存在" },
	]);
	return { options, cardRef: refs[0]! };
}
/** 工具层假装配:捕获注册的工具与注入处理器(通知缓冲读取用),与守卫测试夹具同款。 */
function harness(runner: WorkerRunner, cardsDir: string) {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers: ((event: unknown) => unknown)[] = [];
	const pi = {
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			if (event === "session_shutdown") shutdowns.push(handler);
			if (event === "before_agent_start") handlers.push(handler);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	const face = registerWorkerTools(pi, {
		runner,
		signals: false,
		resolveCardsDir: () => cardsDir,
		// 按既有契约:无现场环境时 resolvePaoHome 抛错,resolveHome 回落 undefined(不走机器真实 PAO_HOME)
		resolvePaoHome: (): string => {
			throw new Error("测试不提供 PAO_HOME");
		},
	});
	registerFanout(pi, {
		runner,
		resolveCardsDir: () => cardsDir,
		// R8-P3-1:与 worker 侧同款抛错型注入——无现场环境时回落「无 home」(缺省值),
		// 不读机器真实 PAO_HOME;fanout 工具面不得因解析抛错而崩。
		resolvePaoHome: (): string => {
			throw new Error("测试不提供 PAO_HOME");
		},
	});
	const readSections = (): string[] => {
		const sections: Record<string, string> = {};
		for (const handler of handlers)
			(handler as (event: { systemPromptOptions: { sections: Record<string, string> } }) => void)({
				systemPromptOptions: { sections },
			});
		return Object.values(sections);
	};
	return { tools, face, readSections };
}
/** pi 工具上下文的最小形状:只有本测试用到的 sessionManager.getSessionId。 */
function fakeCtx(sessionId: string): unknown {
	return { sessionManager: { getSessionId: () => sessionId } };
}

describe("T03 入口准入一致:工作流卡 owner 三入口同判", () => {
	it("单卡:错误会话身份拒派(通知含 owner 原因,卡不被认领);正确会话身份照常认领拉起", async () => {
		const { options, cardRef } = await setupV2();
		const runner = new GatedRunner("成功");
		runners.push(runner);
		const { tools, face, readSections } = harness(runner, options.cardsDir);
		const dispatch = tools.get("pao_dispatch_card")!;
		await dispatch.execute(
			"t1",
			{ card_ref: cardRef, reason: "准入一致" },
			undefined,
			undefined,
			fakeCtx("someone-else"),
		);
		await face.waitForBackground();
		const notice = readSections().join("\n");
		expect(notice).toContain("[派卡被拒]");
		expect(notice).toContain("owner");
		expect(cardState(options.cardsDir, cardRef)).toBe("unclaimed");
		expect(runner.runs).toHaveLength(0);
		// 正确会话身份:同一张卡再派,与自动链同判放行
		await dispatch.execute("t2", { card_ref: cardRef, reason: "准入一致" }, undefined, undefined, fakeCtx("owner"));
		await face.waitForBackground();
		expect(runner.runs).toHaveLength(1);
		expect(cardState(options.cardsDir, cardRef)).toBe("in_progress");
	});

	it("扇出:错误会话身份未拉起(原因含 owner,卡不被认领);正确会话身份跑完落回执", async () => {
		const { options, cardRef } = await setupV2();
		const runner = new GatedRunner("成功");
		runners.push(runner);
		const { tools } = harness(runner, options.cardsDir);
		const fanout = tools.get("pao_fanout")!;
		const rejected = (await fanout.execute(
			"t1",
			{ card_refs: [cardRef], reason: "准入一致" },
			undefined,
			undefined,
			fakeCtx("someone-else"),
		)) as { details: { 结果: { 终态: string; 未拉起原因?: string }[] } };
		expect(rejected.details.结果[0]?.终态).toBe("未拉起");
		expect(rejected.details.结果[0]?.未拉起原因).toContain("owner");
		expect(cardState(options.cardsDir, cardRef)).toBe("unclaimed");
		expect(runner.runs).toHaveLength(0);
		const accepted = (await fanout.execute(
			"t2",
			{ card_refs: [cardRef], reason: "准入一致" },
			undefined,
			undefined,
			fakeCtx("owner"),
		)) as { details: { 结果: { 终态: string }[]; count: { 成功: number } } };
		expect(accepted.details.结果[0]?.终态).toBe("成功");
		expect(accepted.details.count.成功).toBe(1);
		expect(runner.runs).toHaveLength(1);
		// 扇出链只认领运行与落回执,交付是独立验收环节——卡留进行中
		expect(cardState(options.cardsDir, cardRef)).toBe("in_progress");
	});
});
