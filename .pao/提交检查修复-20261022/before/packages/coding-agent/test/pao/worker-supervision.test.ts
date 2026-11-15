import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { formatCardNumber } from "../../src/pao/cards/counter.ts";
import {
	appendReceipt,
	changeCardStatus,
	createCard,
	loadCard,
	parseCardRef,
	readCard,
} from "../../src/pao/cards/index.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { executeFanout } from "../../src/pao/fanout/execute.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import { ProcessRegistry } from "../../src/pao/worker/registry.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import {
	buildWorkerSupervisionActivity,
	createWorkerSupervisionRouteResolver,
	resolveWorkerSupervisionRoute,
	workerDepartmentKey,
} from "../../src/pao/worker/supervision.ts";
import {
	addNodeCards,
	bindMinister,
	pauseControl,
	readControl,
	requestRuling,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe, type WorkflowRecipe } from "../../src/pao/workflow/recipe.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function runnerFor(registry: ProcessRegistry): Pick<WorkerRunner, "registry"> {
	return { registry };
}

function cardNoFromRunId(runId: string): string {
	const value = Number(runId.replace(/^r/, ""));
	return String(Number.isFinite(value) ? value : runId);
}

function entry(input: {
	department: string;
	context: string;
	owner: string;
	runId: string;
	key?: string;
	running?: boolean;
	cardPath?: string;
	cardNo?: string;
	taskRoot?: string;
}) {
	const projectRoot = input.taskRoot ?? temp(`pao-supervision-${input.department}-`);
	return {
		pid: input.runId.charCodeAt(0),
		card_no: input.cardNo ?? cardNoFromRunId(input.runId),
		...(input.cardPath ? { card_path: input.cardPath } : {}),
		command: "离线假 worker",
		登记时间: "2026-10-22T00:00:00.000Z",
		running: input.running ?? true,
		dept: input.department,
		dispatch_reason: "监督测试",
		task_root: projectRoot,
		supervisor_dept: input.department,
		supervisor_context: input.context,
		supervisor_session: `session-${input.department}`,
		supervision_owner: input.owner,
		supervision_key: input.key ?? `card:${input.runId}`,
		supervision_department_key: workerDepartmentKey({
			department: input.department,
			projectRoot,
			context: input.context,
			ownerSessionId: input.owner,
		}),
		supervision_goal: `${input.department}目标`,
		supervision_progress: `${input.department}进展`,
		supervision_blocker: `${input.department}阻塞`,
		supervision_evidence: [`${input.department}.jsonl`],
		run_id: input.runId,
	};
}

async function v2Card(department = "开发"): Promise<{
	cardsDir: string;
	card: ParsedCard;
	instance: string;
	context: string;
	owner: string;
	ministerSession: string;
	recipe: WorkflowRecipe;
	options: {
		cardsDir: string;
		workspaceDir: string;
		counterPath: string;
		ownerSessionId: string;
	};
}> {
	const root = temp("pao-supervision-v2-");
	const cardsDir = join(root, ".pao", "卡");
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "监督流",
			参数: [],
			节点: [{ 名字: "实现", 部门: department, 目标: "完成实现", 验收: "文件存在", 工人数量: 1 }],
		})}---\n`,
		join(root, "工作流", "监督流.md"),
	);
	const owner = "main-owner";
	const ministerSession = "minister-session";
	const options = {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		counterPath: join(root, ".pao", "卡号.txt"),
		ownerSessionId: owner,
	};
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "实现", ministerSession);
	const flow = readControl(recipe, options);
	const [ref] = await addNodeCards(
		recipe,
		options,
		{ 实例: flow.实例, 节点: "实现", 轮次: 1, 部长会话: ministerSession },
		[{ goal: "真实卡片目标", acceptance: "文件存在" }],
	);
	return {
		cardsDir,
		card: loadCard(cardsDir, parseCardRef(ref)),
		instance: flow.实例,
		context: flow.脉络,
		owner,
		ministerSession,
		recipe,
		options,
	};
}

describe("worker 监督路由", () => {
	it("普通部长自派本部门卡绑定当前真实部长会话；无会话时不制造本地路由", async () => {
		const cardsDir = join(temp("pao-supervision-local-"), "卡");
		const card = await createCard(cardsDir, {
			目标: "本部门任务",
			部门: "测试",
			验收: "完成",
			创建: "2026-10-22 00:00",
		});
		const route = resolveWorkerSupervisionRoute(card, {
			cardNo: "0001",
			cardsDir,
			operator: "部长",
			ownerSession: "minister-self",
			goal: card.frontmatter.goal,
			role: "部长",
			department: "测试",
		});
		expect(route).toMatchObject({
			department: "测试",
			context: "minister-self",
			sessionId: "minister-self",
			target: "local",
			binding: { source: "runtime", role: "minister", target: "local" },
		});
		expect(
			resolveWorkerSupervisionRoute(card, {
				cardNo: "0001",
				cardsDir,
				operator: "部长",
				goal: card.frontmatter.goal,
				role: "部长",
				department: "测试",
			}),
		).toBeUndefined();
	});

	it("v2 卡从冻结控制正本绑定实例脉络、owner、真实节点部长和轮次", async () => {
		const setup = await v2Card();
		const resolver = createWorkerSupervisionRouteResolver({ role: "主控", department: "其他" });
		const route = resolver({
			cardNo: String(setup.card.card_no).padStart(4, "0"),
			cardsDir: setup.cardsDir,
			operator: "主控",
			ownerSession: setup.owner,
			goal: setup.card.frontmatter.goal,
		});
		expect(route).toMatchObject({
			department: "开发",
			context: setup.context,
			sessionId: setup.ministerSession,
			ownerSessionId: setup.owner,
			label: "监督流/实现/第1轮",
			target: "minister",
			binding: { source: "workflow", role: "main", target: "minister" },
		});
		expect(route?.departmentKey).toContain(setup.instance);
	});

	it("v1 工作流标记保持兼容；损坏的 v2 身份 fail-closed", async () => {
		const cardsDir = join(temp("pao-supervision-v1-"), "卡");
		const v1 = await createCard(
			cardsDir,
			{ 目标: "旧工作流", 部门: "测试", 验收: "完成", 创建: "2026-10-22 00:00" },
			{ 模板正文: "<!-- pao-workflow:流=旧流/节点=旧节点 -->" },
		);
		expect(
			resolveWorkerSupervisionRoute(v1, {
				cardNo: "0001",
				cardsDir,
				operator: "主控",
				goal: v1.frontmatter.goal,
				role: "主控",
			}),
		).toBeUndefined();
		const broken = await createCard(
			cardsDir,
			{ 目标: "坏 v2", 部门: "测试", 验收: "完成", 创建: "2026-10-22 00:00" },
			{ 模板正文: "<!-- pao-workflow:流=监督流/节点=实现 -->\n<!-- pao-workflow-v2:实例=bad -->" },
		);
		expect(() =>
			resolveWorkerSupervisionRoute(broken, {
				cardNo: "0002",
				cardsDir,
				operator: "主控",
				goal: broken.frontmatter.goal,
				role: "主控",
			}),
		).toThrow("工作流 v2 卡身份标记损坏");
	});
});

describe("worker 监督活动投影", () => {
	it("工作流卡经真实扇出派发后，工人登记保留冻结部长的直接上级路由（离线子进程）", async () => {
		const setup = await v2Card("开发");
		const script = join(temp("pao-supervision-fanout-worker-"), "worker.cjs");
		writeFileSync(
			script,
			`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify({result:"success",artifact_path:[],summary:"离线受控工人完成"})}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0},stopReason:"end"}}));`,
		);
		const runner = new WorkerRunner();
		let deliveredAfterReceipt = false;
		try {
			const result = await executeFanout(
				{ 卡号列表: [String(setup.card.card_no)], 并发上限: 1, cardsDir: setup.cardsDir, owner: setup.owner },
				{
					运行器: runner,
					onReceipt: (card, receipt) => {
						deliveredAfterReceipt = readCard(card.path).receipts.some(
							(entry) => entry.attempt === receipt.attempt && entry.result === "success",
						);
					},
					公共参数: { 命令: process.execPath, 参数: [script], 工具白名单: ["read"] },
				},
			);
			expect(result.count.成功).toBe(1);
			expect(deliveredAfterReceipt).toBe(true);
			expect(runner.registry.list()).toHaveLength(1);
			expect(runner.registry.list()[0]).toMatchObject({
				running: false,
				supervisor_dept: "开发",
				supervisor_context: setup.context,
				supervisor_session: setup.ministerSession,
				supervision_owner: setup.owner,
			});
		} finally {
			await runner.stopAll();
		}
	});

	async function liveCard(department = "开发") {
		const cardsDir = join(temp("pao-supervision-live-"), "卡");
		const card = await createCard(cardsDir, {
			目标: "仍然运行",
			部门: department,
			验收: "完成",
			创建: "2026-10-22 00:00",
		});
		const claimed = changeCardStatus(card, {
			操作者: "主控",
			to: "in_progress",
			时间: "2026-10-22 00:01",
		});
		return { cardsDir, card: claimed };
	}

	it("主控投影 worker 与独立部门对象；同 context/owner 的两个部门不碰撞", async () => {
		const registry = new ProcessRegistry();
		const dev = await liveCard("开发");
		const review = await liveCard("审查");
		registry.register(
			entry({
				department: "开发",
				context: "same-context",
				owner: "same-owner",
				runId: "r1",
				cardPath: dev.card.path,
			}),
		);
		registry.register(
			entry({
				department: "审查",
				context: "same-context",
				owner: "same-owner",
				runId: "r2",
				cardPath: review.card.path,
			}),
		);
		const activity = buildWorkerSupervisionActivity(runnerFor(registry), { role: "main", context: "same-owner" });
		const workers = activity.filter((item) => item.kind === "worker");
		const departments = activity.filter((item) => item.kind === "department");
		expect(workers).toHaveLength(2);
		expect(departments).toHaveLength(2);
		expect(new Set(departments.map((item) => item.key)).size).toBe(2);
		expect(departments.map((item) => item.department).sort()).toEqual(["审查", "开发"]);
		for (const department of departments) {
			expect(department.key).toMatch(/^department:[A-Za-z0-9_-]+$/);
			expect(department.key).not.toContain("\u0000");
		}
		for (const worker of workers) expect(worker).not.toHaveProperty("binding");
	});

	it("部门提醒正文可直接复制确认 key，且两个部门不会被覆盖", async () => {
		let now = 0;
		const registry = new ProcessRegistry();
		const dev = await liveCard("开发");
		const review = await liveCard("审查");
		registry.register(
			entry({
				department: "开发",
				context: "same-context",
				owner: "same-owner",
				runId: "r1",
				cardPath: dev.card.path,
			}),
		);
		registry.register(
			entry({
				department: "审查",
				context: "same-context",
				owner: "same-owner",
				runId: "r2",
				cardPath: review.card.path,
			}),
		);
		const notices: string[] = [];
		const host = new MinisterHost({
			时钟: () => new Date(now),
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			活动: () => buildWorkerSupervisionActivity(runnerFor(registry), { role: "main", context: "same-owner" }),
			通知: (body) => notices.push(body),
		});
		now = 30 * 60_000;
		await host.flushSupervision();
		for (const notice of notices) expect(notice).not.toContain("\u0000");
		const departmentNotices = notices.filter((notice) => notice.includes("【部门】"));
		expect(departmentNotices).toHaveLength(1);
		expect(departmentNotices[0]).toContain("【部门】department:");
		expect(departmentNotices[0]).toContain("部门 开发");
		expect(departmentNotices[0]).toContain("部门 审查");
		const keys = [...departmentNotices[0]!.matchAll(/【部门】(department:[^\s\u0000]+)/g)].map((match) => match[1]!);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
	});

	it("部长只投影直接 worker；运行退出后不进入活动快照，但最终进展/证据仍保留", async () => {
		const registry = new ProcessRegistry();
		const live = await liveCard();
		const running = entry({
			department: "开发",
			context: "minister",
			owner: "main",
			runId: "r1",
			cardPath: live.card.path,
		});
		const exited = entry({ department: "开发", context: "minister", owner: "main", runId: "r2", running: false });
		registry.register(running);
		registry.register(exited);
		registry.markProgress(exited.pid, "r2", "失败：测试未通过");
		registry.markEvidence(exited.pid, "r2", ["最终.jsonl"]);

		const activity = buildWorkerSupervisionActivity(runnerFor(registry), { role: "minister", context: "minister" });
		expect(activity).toHaveLength(1);
		expect(activity[0]).toMatchObject({
			kind: "worker",
			key: "card:r1",
			department: "开发",
			context: "minister",
			running: true,
			progress: {
				goal: "开发目标",
				recentProgress: "开发进展",
				blocker: "开发阻塞",
				evidence: ["开发.jsonl"],
			},
		});
		expect(registry.list().find((item) => item.run_id === "r2")).toMatchObject({
			running: false,
			supervision_progress: "失败：测试未通过",
			supervision_evidence: ["最终.jsonl"],
		});
	});

	it("每次投影动态核对卡与 v2 控制正本：暂停或待裁定退出，运行中且无新输出仍保留", async () => {
		const setup = await v2Card("开发");
		changeCardStatus(setup.card, {
			操作者: setup.owner,
			to: "in_progress",
			时间: "2026-10-22 00:01",
		});
		const registry = new ProcessRegistry();
		registry.register(
			entry({
				department: "开发",
				context: setup.context,
				owner: setup.owner,
				runId: "r1",
				cardPath: setup.card.path,
				cardNo: formatCardNumber(setup.card.card_no),
				taskRoot: setup.options.workspaceDir,
			}),
		);
		const first = buildWorkerSupervisionActivity(runnerFor(registry), {
			role: "main",
			context: setup.owner,
		});
		expect(first.map((item) => item.kind)).toEqual(["worker", "department"]);

		await pauseControl(setup.recipe, setup.options, "动态暂停核查");
		expect(
			buildWorkerSupervisionActivity(runnerFor(registry), {
				role: "main",
				context: setup.owner,
			}),
		).toEqual([]);
		expect(registry.list()[0]?.最近输出时间).toBeUndefined();
	});

	it("同节点一张卡已交回执，不会排除另一张仍在运行的工人", async () => {
		const setup = await v2Card("开发");
		const [secondRef] = await addNodeCards(
			setup.recipe,
			setup.options,
			{
				实例: setup.instance,
				节点: "实现",
				轮次: 1,
				部长会话: setup.ministerSession,
			},
			[{ goal: "另一项仍在执行", acceptance: "文件存在" }],
		);
		const first = changeCardStatus(setup.card, { 操作者: setup.owner, to: "in_progress", 时间: "2026-10-22 00:01" });
		const second = changeCardStatus(loadCard(setup.cardsDir, parseCardRef(secondRef)), {
			操作者: setup.owner,
			to: "in_progress",
			时间: "2026-10-22 00:01",
		});
		appendReceipt(first, {
			尝试号: first.frontmatter.attempt,
			时间: "2026-10-22 00:02",
			结果: "success",
			摘要: "离线测试回执，第一项已结束",
		});
		const registry = new ProcessRegistry();
		for (const [index, card] of [first, second].entries())
			registry.register(
				entry({
					department: "开发",
					context: setup.context,
					owner: setup.owner,
					runId: `r${index + 1}`,
					cardPath: card.path,
					cardNo: formatCardNumber(card.card_no),
					taskRoot: setup.options.workspaceDir,
				}),
			);
		const active = buildWorkerSupervisionActivity(runnerFor(registry), { role: "main", context: setup.owner });
		expect(active.filter((item) => item.kind === "worker").map((item) => item.key)).toEqual(["card:r2"]);
		expect(active.filter((item) => item.kind === "department")).toHaveLength(1);
	});

	it("在途卡请求人工裁定后退出周期监督，卡仍保持 in_progress", async () => {
		const setup = await v2Card("开发");
		changeCardStatus(setup.card, {
			操作者: setup.owner,
			to: "in_progress",
			时间: "2026-10-22 00:01",
		});
		const registry = new ProcessRegistry();
		registry.register(
			entry({
				department: "开发",
				context: setup.context,
				owner: setup.owner,
				runId: "r1",
				cardPath: setup.card.path,
				cardNo: formatCardNumber(setup.card.card_no),
				taskRoot: setup.options.workspaceDir,
			}),
		);
		const flow = readControl(setup.recipe, setup.options);
		expect(
			buildWorkerSupervisionActivity(runnerFor(registry), {
				role: "main",
				context: setup.owner,
			}),
		).toHaveLength(2);
		await requestRuling(
			setup.recipe,
			setup.options,
			{
				实例: flow.实例,
				节点: "实现",
				轮次: 1,
				部长会话: setup.ministerSession,
			},
			"等待人工选择",
			false,
		);
		expect(
			buildWorkerSupervisionActivity(runnerFor(registry), {
				role: "main",
				context: setup.owner,
			}),
		).toEqual([]);
		expect(readCard(setup.card.path).frontmatter.status).toBe("in_progress");
		expect(registry.list()[0]?.最近输出时间).toBeUndefined();
	});
});
