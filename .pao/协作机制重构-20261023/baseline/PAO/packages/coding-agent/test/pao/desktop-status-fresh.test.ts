/**
 * 阻塞 4 端到端验收：同一份真实 Git 内容树让桌面、状态和计划读面给出一致结论。
 *
 * 这里的开发、审核、验证卡都走真实控制正本、状态机和临时计划布局；只有审核意见是
 * 确定性测试事实。没有调用模型、没有修改正式 PAO_HOME，也不冒充 Electron 界面验收。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { changeCardStatus, loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import { readDesktopDeptDetail } from "../../src/pao/desktop/dept.ts";
import { checkDesktopRecipeDelete, checkDesktopRecipeEdit, recipeRevision } from "../../src/pao/desktop/editor.ts";
import { registerDesktopOwner } from "../../src/pao/desktop/owners.ts";
import { readDesktopPlansFresh } from "../../src/pao/desktop/plans.ts";
import { readDesktopPendingFresh, readDesktopProjectFresh } from "../../src/pao/desktop/read-model.ts";
import { readDesktopFlows, readDesktopFlowsFresh } from "../../src/pao/desktop/workflow.ts";
import { readRecallSnapshot } from "../../src/pao/status/context-recovery.ts";
import { buildFirstRunList } from "../../src/pao/status/firstrun.ts";
import { collectPendingFresh } from "../../src/pao/status/pending.ts";
import { collectInstanceResults } from "../../src/pao/status/results.ts";
import { scanInstanceSignalsFresh, scanWorkflowInstancesFresh } from "../../src/pao/status/workflow-instances.ts";
import {
	addNodeCards,
	bindMinister,
	decideNode,
	endDecomposition,
	readControl,
	readControlReport,
} from "../../src/pao/workflow/control.ts";
import { emitRecipeMarkdown } from "../../src/pao/workflow/distill.ts";
import { startWorkflow } from "../../src/pao/workflow/driver.ts";
import {
	createTemporaryPlan,
	readPlanInstanceIdentity,
	recordPlanStart,
	resolvePlanExecution,
} from "../../src/pao/workflow/plan.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const roots: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pao-desktop-status-fresh-"));
	roots.push(root);
	return root;
}

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: "pipe",
	});
}

function writeProjectList(home: string, project: string): void {
	writeFileSync(
		join(home, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| 一致性项目 | ${project} | 2026-10-23 10:00 | 2026-10-23 10:00 |\n`,
		"utf8",
	);
}

function registerOwner(project: string, sessionId: string): void {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
	const pi = {
		on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const context = {
		cwd: project,
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => true,
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
	registerDesktopOwner(pi);
	handlers.get("session_start")!({}, context);
	cleanups.push(() => handlers.get("session_shutdown")!({}, context));
}

function deliver(cardRef: string, cardsDir: string, owner: string): void {
	changeCardStatus(loadCard(cardsDir, parseCardRef(cardRef)), {
		操作者: owner,
		to: "in_progress",
		时间: "2026-10-23 10:05",
	});
	const card = loadCard(cardsDir, parseCardRef(cardRef));
	writeFileSync(
		card.path,
		serializeCard(
			{ ...card.frontmatter, attempt: 1 },
			`${card.body}\n## 机械验收 2026-10-23 10:10\n- 尝试: 1\n- 结论: 全过自动交付\n`,
		),
		"utf8",
	);
	changeCardStatus(loadCard(cardsDir, parseCardRef(cardRef)), {
		操作者: owner,
		to: "delivered",
		时间: "2026-10-23 10:11",
	});
}

async function completeRealPlan(project: string) {
	writeFileSync(join(project, "source.txt"), "v1\n", "utf8");
	git(project, "init");
	git(project, "add", "source.txt");
	git(project, "commit", "-qm", "baseline");
	const created = await createTemporaryPlan({
		项目根: project,
		显示名: "真实版本一致性",
		来源会话: "owner-1",
		请求ID: "create-1",
		已注册部门: ["开发部", "审核部"],
		步骤: [
			{ 标题: "开发", 部门: "开发部", 要求: "修改 source.txt", 预期成果: "source.txt" },
			{
				标题: "审核",
				部门: "审核部",
				要求: "独立审核当前成果",
				依赖: ["s1"],
				审核: true,
				部门标准: "审核部标准",
				只读: true,
			},
		],
		当刻: "2026-10-23 10:00",
	});
	const execution = resolvePlanExecution({
		项目根: project,
		来源会话: "owner-1",
		计划ID: created.计划ID,
		启动请求ID: "start-1",
		定义版本: 1,
	});
	const options = {
		cardsDir: execution.卡目录,
		workspaceDir: execution.工作区,
		ownerSessionId: "owner-1",
	};
	await startWorkflow(execution.配方, {}, options);
	const flow = readControl(execution.配方, options);
	const identity = (node: string, minister: string) => ({
		实例: flow.实例,
		节点: node,
		轮次: 1,
		部长会话: minister,
	});
	await bindMinister(execution.配方, options, "s1", "minister-dev");
	const [dev] = await addNodeCards(execution.配方, options, identity("s1", "minister-dev"), [
		{ goal: "修改成果", acceptance: "source.txt 存在" },
	]);
	deliver(dev!, execution.卡目录, "minister-dev");
	await endDecomposition(execution.配方, options, identity("s1", "minister-dev"));

	await bindMinister(execution.配方, options, "s2", "minister-review");
	const [verification] = await addNodeCards(execution.配方, options, identity("s2", "minister-review"), [
		{ goal: "运行独立验证", acceptance: "source.txt 存在" },
	]);
	deliver(verification!, execution.卡目录, "minister-review");
	await endDecomposition(execution.配方, options, identity("s2", "minister-review"));
	await decideNode(execution.配方, options, identity("s2", "minister-review"), {
		结果: "pass",
		理由: "未验证运行；确定性测试在此绑定真实 Git 内容树",
		引用: ["source.txt:1"],
	});
	const before = await readControlReport(readControl(execution.配方, options), options);
	expect(before.status).toBe("completed");
	writeFileSync(join(project, "source.txt"), "v3\n", "utf8");
	const after = await readControlReport(readControl(execution.配方, options), options);
	expect(after.status).toBe("running");
	expect(after.nodes.find((node) => node.name === "s2")?.hold).toContain("成果内容已变化");

	const planIdentity = readPlanInstanceIdentity(execution.工作区, execution.配方名)!;
	recordPlanStart(execution.关联路径, {
		计划ID: created.计划ID,
		定义版本: 1,
		启动请求ID: "start-1",
		实例: planIdentity.实例,
		配方名: execution.配方名,
		工作区: execution.工作区,
		卡目录: execution.卡目录,
		控制清单: execution.控制清单,
		owner会话: "owner-1",
		受理时刻: "2026-10-23 10:00",
	});
	return { created, execution, report: after, flow };
}

async function writeRecipeHome(home: string, recipeName: string): Promise<string> {
	mkdirSync(join(home, "工作流"), { recursive: true });
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(
		join(home, "pao配置", "档位.json"),
		`${JSON.stringify(
			{
				provider: "pao",
				档位: [{ 名: "主力", provider: "p", model: "m", thinkingLevel: "high" }],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await createDept({ paoHome: home, 名字: "开发部", 标签: [] });
	await createDept({ paoHome: home, 名字: "审核部", 标签: [] });
	const content = emitRecipeMarkdown({
		版本: 2,
		名字: recipeName,
		说明: "确定性阻塞 4 验收工作流；只验证共享当前内容树读取，不调用模型。",
		自动执行: false,
		参数: [],
		节点: [{ 名字: "审核", 部门: "审核部", 目标: "审核", 验收: "完成", depends_on: [], 人工确认: false }],
	});
	const path = join(home, "工作流", `${recipeName}.md`);
	writeFileSync(path, content, "utf8");
	return content;
}

describe("阻塞 4：桌面与 status 共用当前 Git 内容树", () => {
	it("源码变化后旧的审核 pass 不再完成，并从所有真实读面暴露同一挂起事实", async () => {
		const home = tempRoot();
		const project = join(home, "项目");
		mkdirSync(project, { recursive: true });
		writeProjectList(home, project);
		registerOwner(project, "owner-1");
		const { created, execution } = await completeRealPlan(project);
		await writeRecipeHome(home, execution.配方名);
		const savedRecipePath = join(home, "工作流", `${execution.配方名}.md`);
		const savedRecipeContent = readFileSync(savedRecipePath, "utf8");
		const savedRecipe = parseRecipe(savedRecipeContent, savedRecipePath);
		const currentRecipeRevision = recipeRevision(savedRecipeContent);

		const flows = await readDesktopFlowsFresh(project);
		expect(flows.问题).toEqual([]);
		const desktopFlow = flows.工作流.find((flow) => flow.控制.实例 === planIdentity(execution))!;
		expect(desktopFlow.进度.状态).toBe("运行中");
		expect(desktopFlow.进度.节点.find((node) => node.名字 === "s2")?.挂起).toContain("成果内容已变化");
		expect(desktopFlow.持久状态).toBe("已完成");

		const legacy = readDesktopFlows(project);
		const legacyFlow = legacy.工作流.find((flow) => flow.控制.实例 === planIdentity(execution))!;
		expect(legacyFlow.持久状态).toBe("已完成");
		expect(legacyFlow.进度.状态).not.toBe("已完成");
		expect(legacyFlow.进度.节点.find((node) => node.名字 === "s2")?.挂起).toContain("审核判定未核对");

		const projectView = await readDesktopProjectFresh(project, "owner-1");
		expect(projectView.workflow.find((flow) => flow.控制.实例 === planIdentity(execution))?.进度.状态).toBe("运行中");
		const pendingProject = await readDesktopPendingFresh(home, project);
		expect(pendingProject.projects.find((item) => item.projectRoot === project)?.workflow[0]?.进度.状态).toBe(
			"运行中",
		);

		const plans = await readDesktopPlansFresh(project);
		expect(plans.问题).toEqual([]);
		const start = plans.计划.find((plan) => plan.计划ID === created.计划ID)!.启动[0]!;
		expect(start.状态).toBe("运行中");
		expect(start.进度.find((step) => step.步骤ID === "s2")?.状态).toBe("in_progress");

		const { readDesktopCanvasFresh } = await import("../../src/pao/desktop/canvas.ts");
		const canvas = await readDesktopCanvasFresh(home);
		expect(canvas.异常).toEqual([]);
		expect(
			canvas.实例.some(
				(item) =>
					item.状态 === "运行中" && item.节点.find((node) => node.名字 === "s2")?.挂起?.includes("成果内容已变化"),
			),
		).toBe(true);
		const scan = await scanWorkflowInstancesFresh(home);
		expect(scan.异常).toEqual([]);
		expect(scan.挂起).toEqual([]);
		const signals = await scanInstanceSignalsFresh(home);
		expect(signals.异常).toEqual([]);
		expect(signals.实例[0]?.状态).toBe("运行中");
		expect(signals.实例[0]?.nodeHolds[0]?.hold).toContain("成果内容已变化");

		const pending = await collectPendingFresh(home);
		expect(pending.some((item) => item.类型 === "节点挂起待处理" && item.为什么停.includes("成果内容已变化"))).toBe(
			true,
		);
		const firstRun = await buildFirstRunList(home);
		expect(firstRun).toContain("节点挂起待处理");

		const recall = await readRecallSnapshot({ paoHome: home, 项目根: project });
		expect(recall.问题).toEqual([]);
		expect(recall.待办.some((item) => item.原因.includes("成果内容已变化"))).toBe(true);

		const results = await collectInstanceResults(home);
		expect(results.exception).toEqual([]);
		const result = results.line.find((line) => line.实例 === planIdentity(execution))!;
		expect(result.状态).toBe("运行中");
		expect(result.恢复.已中断).toBe(true);
		expect(result.恢复.行.some((line) => line.文案.includes("成果内容已变化"))).toBe(true);

		const dept = await readDesktopDeptDetail("owner-1", project, "审核部", { paoHome: home });
		expect(dept.负载.挂起节点数).toBeGreaterThanOrEqual(1);

		await expect(checkDesktopRecipeEdit(home, project, savedRecipe, currentRecipeRevision)).rejects.toThrow(
			"运行中的冻结实例",
		);
		await expect(checkDesktopRecipeDelete(home, project, execution.配方名, null)).rejects.toThrow("运行中的冻结实例");
	}, 120_000);
});

function planIdentity(execution: ReturnType<typeof resolvePlanExecution>): string {
	return readPlanInstanceIdentity(execution.工作区, execution.配方名)!.实例;
}
