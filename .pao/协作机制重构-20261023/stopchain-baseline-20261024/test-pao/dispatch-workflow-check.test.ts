/**
 * T02 验收：工作流卡派发的实例校验不可绕过（fail-closed）。
 * - 直接 executeDispatch 派 v2 工作流卡也必须过 实例/轮次/owner/暂停/冻结版本 校验;
 * - 暂停/实例·轮次·owner 不匹配拒绝启动,且卡不被认领（不留已写状态）;
 * - v1 卡缺 PAO_HOME 沿旧 fail-open 放行（T05 定案：保留现状,v1 卡面自足无实例校验可跳过）;
 * - 仅编辑最新配方不使合法旧实例失效（旧实例仍用冻结快照的技能）;
 * - 普通卡行为不变;缺校验回调一律拒派。
 * 全离线：runner 为桩,不调用模型。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { serializeCard } from "../../src/pao/cards/cardfile.ts";
import { createCard, loadCard, parseCardRef, readCard } from "../../src/pao/cards/index.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { addNodeCards, bindMinister, pauseControl, readControl, startControl } from "../../src/pao/workflow/control.ts";
import { resolveWorkflowDispatch, type WorkflowDispatchContext } from "../../src/pao/workflow/dispatch-context.ts";
import { emitRecipeMarkdown } from "../../src/pao/workflow/distill.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { listStarterTemplates } from "../../src/pao/workflow/templates.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-dispatch-workflow-check-"));
	dirs.push(dir);
	return dir;
}

/** 离线桩 runner:只记录 run 参数,直接回成功回执 */
class StubRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		return {
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: [],
			summary: "离线假回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: join(options.卡路径 ?? "", "..", "证据.jsonl"),
			command: "stub",
			pid: 0,
			duration_ms: 0,
			exitCode: 0,
		};
	}
}

/** v2 工作流夹具:启流→绑部长→落一张带 实例/轮次 身份标记的开发卡 */
async function setupV2() {
	const home = temp();
	const template = listStarterTemplates().find((item) => item.id === "bugfix")!;
	const recipe = parseRecipe(template.content, `${template.name}.md`);
	recipe.节点[0].技能 = ["original"];
	recipe.节点[0].档位 = undefined;
	const options = {
		cardsDir: join(home, "任务", "卡"),
		ownerSessionId: "owner",
		counterPath: join(home, "counter"),
	};
	mkdirSync(join(home, "pao配置", "skills", "original"), { recursive: true });
	// S5 包2:仓内工作流声明的技能（original）须经本地允许清单确认才挂载（fail-closed）
	writeFileSync(join(home, "pao配置", "skills", "允许清单.json"), '["original"]\n', "utf8");
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
	const card = loadCard(options.cardsDir, parseCardRef(refs[0]));
	const check = (candidate: Parameters<typeof resolveWorkflowDispatch>[0]) =>
		resolveWorkflowDispatch(candidate, {
			cardsDir: options.cardsDir,
			paoHome: home,
			owner: options.ownerSessionId,
		});
	return { home, recipe, options, card, check };
}

function dispatch(
	cardsDir: string,
	cardNo: string,
	runner: StubRunner,
	check: (card: ParsedCard) => WorkflowDispatchContext | undefined,
	paoHome?: string,
) {
	return executeDispatch(
		{ cardsDir, card_no: cardNo, operator: "主控", time: "2026-10-05 10:00" },
		{ 运行器: runner, workflowCheck: check, ...(paoHome ? { paoHome } : {}) },
		async () => "ok",
	);
}

describe("T02 工作流卡派发实例校验（fail-closed,锁后重核）", () => {
	it("合法 v2 卡正常派发,技能来自冻结快照;仅编辑最新配方不使旧实例失效", async () => {
		const { home, recipe, options, card, check } = await setupV2();
		// 编辑最新安装配方（改技能声明）:旧实例仍按冻结快照解析,照常派发
		recipe.节点[0].技能 = ["missing-new-skill"];
		writeFileSync(join(home, "工作流", `${recipe.名字}.md`), emitRecipeMarkdown(recipe));
		const runner = new StubRunner();
		const dispatched = await dispatch(options.cardsDir, String(card.card_no), runner, check, home);
		expect(dispatched.可派).toBe(true);
		expect(runner.runs).toHaveLength(1);
		expect(runner.runs[0]?.skills).toEqual([join(home, "pao配置", "skills", "original")]);
		expect(readCard(card.path).frontmatter.status).toBe("in_progress");
	});

	it("暂停后拒绝启动,卡不被认领", async () => {
		const { recipe, options, card, check } = await setupV2();
		await pauseControl(recipe, options, "暂停核查");
		const runner = new StubRunner();
		await expect(dispatch(options.cardsDir, String(card.card_no), runner, check)).rejects.toThrow("当前实例/轮次");
		expect(runner.runs).toHaveLength(0);
		expect(readCard(card.path).frontmatter.status).toBe("unclaimed");
	});

	it("旧轮次身份标记拒绝启动", async () => {
		const { options, card, check } = await setupV2();
		card.body = card.body.replace("轮次=1", "轮次=0");
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const runner = new StubRunner();
		await expect(dispatch(options.cardsDir, String(card.card_no), runner, check)).rejects.toThrow("当前实例/轮次");
		expect(runner.runs).toHaveLength(0);
	});

	it("实例身份不匹配拒绝启动", async () => {
		const { options, card, check } = await setupV2();
		card.body = card.body.replace(/<!-- pao-workflow-v2:实例=[^/\s]+/, "<!-- pao-workflow-v2:实例=别处实例");
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const runner = new StubRunner();
		await expect(dispatch(options.cardsDir, String(card.card_no), runner, check)).rejects.toThrow("当前实例/轮次");
		expect(runner.runs).toHaveLength(0);
	});

	it("错误 owner 拒绝启动（owner 核对经注入回调生效）", async () => {
		const { options, card } = await setupV2();
		const runner = new StubRunner();
		const wrongOwner = (candidate: Parameters<typeof resolveWorkflowDispatch>[0]) =>
			resolveWorkflowDispatch(candidate, {
				cardsDir: options.cardsDir,
				owner: "other-session",
			});
		await expect(dispatch(options.cardsDir, String(card.card_no), runner, wrongOwner)).rejects.toThrow(/owner/);
		expect(runner.runs).toHaveLength(0);
	});

	it("缺校验回调一律拒派（fail-closed,不默认放行）", async () => {
		const { options, card } = await setupV2();
		const runner = new StubRunner();
		await expect(
			executeDispatch(
				{ cardsDir: options.cardsDir, card_no: String(card.card_no), operator: "主控", time: "2026-10-05 10:00" },
				{ 运行器: runner } as never,
				async () => "ok",
			),
		).rejects.toThrow(/缺工作流派发校验回调/);
		expect(runner.runs).toHaveLength(0);
	});

	it("普通卡（无工作流标记）行为不变:校验回调返回 undefined,照常认领拉起", async () => {
		const root = temp();
		const cardsDir = join(root, "卡");
		mkdirSync(cardsDir, { recursive: true });
		const card = await createCard(
			cardsDir,
			{ 目标: "普通任务", 部门: "测试", 验收: "完成", 创建: "2026-10-05 10:00" },
			{ counterPath: join(root, "卡号.txt") },
		);
		const runner = new StubRunner();
		const dispatched = await dispatch(cardsDir, String(card.card_no), runner, () => undefined);
		expect(dispatched.可派).toBe(true);
		expect(runner.runs).toHaveLength(1);
		expect(runner.runs[0]?.skills).toBeUndefined();
	});

	it("v1 卡缺 PAO_HOME 不拒派:沿旧 fail-open 整体跳过校验（T05 定案保留现状）", async () => {
		const { options, card } = await setupV2();
		// 去掉 v2 身份标记即成 v1 控制路径的工作流卡;缺 PAO_HOME 时现状是返回 undefined 放行
		card.body = card.body.replace(/<!-- pao-workflow-v2:[^>]* -->\n?/, "");
		expect(resolveWorkflowDispatch(card, { cardsDir: options.cardsDir })).toBeUndefined();
	});
});
