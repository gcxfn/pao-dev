import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { bindExecutionContext } from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import type { TaskState } from "../../src/pao/cards/types.ts";
import { withFileLock } from "../../src/pao/shared/lock.ts";
import type { DispatchNotifyEvent, DispatchNotifySurface } from "../../src/pao/worker/notify.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import type { AutoChainReport } from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	type NodeIdentity,
	readControl,
	readControlReport,
	recordPending,
	requestRuling,
	startControl,
} from "../../src/pao/workflow/control.ts";
import type { DriverOptions } from "../../src/pao/workflow/driver.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { registerWorkflowTools, type WorkflowToolsOptions } from "../../src/pao/workflow/tools.ts";
import {
	createDeviationPending,
	deviationItemRef,
	type PendingDecisionInput,
} from "../../src/pao/workflow/transition.ts";

const ENV_KEYS = ["PAO_HOME", "PAO_RUN_MODE", "PI_OFFLINE", "PI_NO_LOCAL_LLM"] as const;
const roots: string[] = [];
const testNow = new Date("2026-10-30 10:10").getTime();
let isolatedParent = "";
let environmentBackup: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

interface RegisteredTool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		update?: unknown,
		ctx?: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface Fixture {
	root: string;
	cardsDir: string;
	recipe: ReturnType<typeof parseRecipe>;
	options: DriverOptions;
	pendingKey: string;
	decisions: PendingDecisionInput[];
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function allCommitCount(cwd: string): number {
	return Number.parseInt(git(cwd, ["rev-list", "--all", "--count"]), 10);
}

function refExists(cwd: string, ref: string): boolean {
	return (
		spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).status === 0
	);
}

function notifySurfaceSpy(): { surface: DispatchNotifySurface; notify: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	return {
		notify,
		surface: {
			notify,
			inject: vi.fn((_event: DispatchNotifyEvent) => undefined),
			markHandled: vi.fn(() => true),
			subscribe: vi.fn(() => () => undefined),
			shutdown: vi.fn(),
			unreadCount: vi.fn(() => 0),
			retainedCount: vi.fn(() => 0),
		},
	};
}

function setupTools(options: WorkflowToolsOptions): {
	tools: Map<string, RegisteredTool>;
	background: ReturnType<typeof registerWorkflowTools>;
	run(tool: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
} {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		sendMessage: vi.fn(),
		on: vi.fn(),
	} as unknown as ExtensionAPI;
	const background = registerWorkflowTools(pi, options);
	return {
		tools,
		background,
		async run(name, params, signal) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`工具未注册：${name}`);
			const result = await tool.execute("resolve-tool-test", params, signal, undefined, {
				hasUI: false,
				ui: { confirm: async () => false },
			});
			return result.content.map((part) => part.text).join("\n");
		},
	};
}

async function workflowFixture(
	input: { runMode?: "attended" | "unattended"; taskState?: TaskState } = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(isolatedParent, "resolve-tool-"));
	roots.push(root);
	writeFileSync(join(root, "已跟踪.txt"), "baseline\n");
	git(root, ["init", "--quiet"]);
	git(root, ["add", "--", "已跟踪.txt"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "baseline"]);

	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const recipeName = `工具待决-${root.split(/[\\/]/).at(-1)}`;
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: recipeName,
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "产出文件", 验收: "存在: 产物.txt" }],
		})}---\n`,
		join(root, `${recipeName}.md`),
	);
	const options: DriverOptions = {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		ownerSessionId: "owner",
		runMode: input.runMode ?? "unattended",
		now: () => "2026-10-30 10:10",
	};
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "开发", "minister-开发");
	const flow = readControl(recipe, options);
	const identity: NodeIdentity = {
		实例: flow.实例,
		节点: "开发",
		轮次: flow.节点[0]!.轮次,
		部长会话: "minister-开发",
	};
	const [cardRef] = await addNodeCards(recipe, options, identity, [{ goal: "产出", acceptance: "存在: 产物.txt" }]);
	changeCardStatus(loadCard(cardsDir, parseCardRef(cardRef)), {
		操作者: "owner",
		to: "in_progress",
		时间: "2026-10-30 10:00",
	});
	let card = loadCard(cardsDir, parseCardRef(cardRef));
	const attempt = card.frontmatter.attempt;
	const commonGitDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const execution = await bindExecutionContext(
		{
			key: { cardsDir, cardNo: card.card_no, attempt },
			projectRoot: root,
			repositoryRoot: root,
			executionRoot: root,
			worktree: {
				kind: "primary",
				taskRoot: root,
				executionRoot: root,
				commonGitDir,
				inputVersion: git(root, ["rev-parse", "HEAD"]),
				bindingDigest: `sha256:${"1".repeat(64)}`,
			},
			snapshotRef: "pao://brief/resolve-tool-test",
			snapshotDigest: `sha256:${"2".repeat(64)}`,
		},
		{ expectedCurrentAttempt: attempt },
	);
	const baseline = await snapshotClaimBaseline(cardsDir, card.card_no, {
		owner: "owner",
		时间: "2026-10-30 10:00",
		验收: card.frontmatter.acceptance,
		attempt,
		execution,
	});
	expect(baseline.可用, baseline.原因).toBe(true);
	writeFileSync(join(root, "产物.txt"), "worker result\n");
	card = loadCard(cardsDir, card.card_no);
	appendReceipt(card, {
		尝试号: attempt,
		时间: "2026-10-30 10:01",
		结果: "success",
		摘要: "机械产物已交，两项需要逐项裁决",
		任务态: input.taskState ?? "completed_with_deviations",
		verification: [
			{ 条件: "验收条件一", 结论: "fail", 证据: "自报运行失败" },
			{ 条件: "验收条件二", 结论: "not_run", 证据: "自报未运行" },
		],
		changes: [{ 路径: "产物.txt", 类型: "created", 说明: "真实写入" }],
	});
	const pending = createDeviationPending({
		instance: identity.实例,
		node: identity.节点,
		round: identity.轮次,
		cardRef,
		cardNo: card.card_no,
		attempt,
		reason: "两项普通偏差须主控逐项裁决",
		items: [
			{ verification_index: 0, 条件: "验收条件一", 自报结论: "fail" },
			{ verification_index: 1, 条件: "验收条件二", 自报结论: "not_run" },
		],
		createdAt: new Date(testNow - 10 * 60_000).toISOString(),
		deadline: new Date(testNow + 20 * 60_000).toISOString(),
	});
	await recordPending(recipe, options, pending);
	return {
		root,
		cardsDir,
		recipe,
		options,
		pendingKey: pending.key,
		decisions: [
			{
				item_ref: deviationItemRef(card.card_no, attempt, 0),
				basis: "复核真实失败命令与退出码，确认影响范围可控",
			},
			{
				item_ref: deviationItemRef(card.card_no, attempt, 1),
				basis: "复核未运行原因，确认补偿证据足以接受当前成果",
			},
		],
	};
}

async function manualGateFixture(): Promise<{
	root: string;
	recipe: ReturnType<typeof parseRecipe>;
	options: DriverOptions;
}> {
	const root = mkdtempSync(join(isolatedParent, "resolve-tool-manual-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const recipeName = `人工门-${root.split(/[\\/]/).at(-1)}`;
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: recipeName,
			参数: [],
			节点: [{ 名字: "确认", 部门: "开发", 目标: "等待确认", 验收: "人工确认", 人工确认: true }],
		})}---\n`,
		join(root, `${recipeName}.md`),
	);
	const options: DriverOptions = {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		ownerSessionId: "owner",
		runMode: "attended",
		now: () => "2026-10-30 10:00",
	};
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "确认", "minister-确认");
	const flow = readControl(recipe, options);
	await requestRuling(
		recipe,
		options,
		{ 实例: flow.实例, 节点: "确认", 轮次: 1, 部长会话: "minister-确认" },
		"须用户确认",
		true,
	);
	return { root, recipe, options };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(testNow);
	const parent = process.env.PAO_HOME?.trim();
	if (!parent) throw new Error("待决工具测试须先设置显式隔离 PAO_HOME");
	isolatedParent = resolve(parent);
	mkdirSync(isolatedParent, { recursive: true });
	for (const key of ENV_KEYS) environmentBackup[key] = process.env[key];
	process.env.PAO_HOME = isolatedParent;
	process.env.PI_OFFLINE = "1";
	process.env.PI_NO_LOCAL_LLM = "1";
	delete process.env.PAO_RUN_MODE;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		const previous = environmentBackup[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	environmentBackup = {};
	for (const root of roots.splice(0)) {
		const normalized = resolve(root);
		if (!normalized.startsWith(`${isolatedParent}\\`) && !normalized.startsWith(`${isolatedParent}/`))
			throw new Error(`拒绝清理隔离 PAO_HOME 外路径：${root}`);
		rmSync(root, { recursive: true, force: true });
	}
});

describe("I1-3b-1 pao_control_node resolve_pending 工具接线", () => {
	it("真实工具办理成功后仅推进一次，相同参数重放不增提交、后台推进或通知", async () => {
		const f = await workflowFixture();
		const { notify, surface } = notifySurfaceSpy();
		const driveDepartments = vi.fn(
			async (recipe, options): Promise<AutoChainReport> => ({
				report: await readControlReport(readControl(recipe, options), options),
				steps: [],
			}),
		);
		const toolsByName = new Map<string, RegisteredTool>();
		const face = registerWorkflowTools(
			{
				registerTool: (tool: RegisteredTool) => {
					toolsByName.set(tool.name, tool);
				},
				registerCommand: vi.fn(),
				sendMessage: vi.fn(),
				on: vi.fn(),
			} as unknown as ExtensionAPI,
			{
				resolvePaoHome: () => isolatedParent,
				resolveOwnerSessionId: () => "owner",
				resolveRunMode: () => "unattended",
				runner: new WorkerRunner(),
				notifySurface: surface,
				driveDepartments,
			},
		);
		const tool = toolsByName.get("pao_control_node");
		if (!tool) throw new Error("pao_control_node 未注册");
		const params = {
			name: f.recipe.名字,
			cards_dir: f.cardsDir,
			action: "resolve_pending",
			pending_key: f.pendingKey,
			decisions: f.decisions,
		};
		const run = async (): Promise<string> =>
			(await tool.execute("resolve-call", params, undefined, undefined, { hasUI: false })).content
				.map((part) => part.text)
				.join("\n");

		const commitsBefore = allCommitCount(f.root);
		const first = await run();
		await face.waitForAutoChain();
		expect(first).toContain("本次办理完成");
		expect(first).toContain("自动推进受理成功");
		expect(first).toContain("交卷：已提交");
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		expect(allCommitCount(f.root)).toBeGreaterThan(commitsBefore);
		expect(driveDepartments).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		const cardNo = parseCardRef(readControl(f.recipe, f.options).节点[0]!.卡[0]!);
		const attempt = loadCard(f.cardsDir, cardNo).frontmatter.attempt;
		expect(
			refExists(f.root, `refs/pao-execution/deliveries/card-${String(cardNo).padStart(4, "0")}-attempt-${attempt}`),
		).toBe(true);

		const commitsAfterFirst = allCommitCount(f.root);
		const replay = await run();
		await face.waitForAutoChain();
		expect(replay).toContain("相同输入重放");
		expect(allCommitCount(f.root)).toBe(commitsAfterFirst);
		expect(driveDepartments).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
	}, 120_000);

	it("办理成功后推进抛错可恢复，第二次只恢复受理且第三次不重复提交、推进或唤醒", async () => {
		const f = await workflowFixture();
		const { notify, surface } = notifySurfaceSpy();
		const driveDepartments = vi.fn(
			async (recipe, options): Promise<AutoChainReport> => ({
				report: await readControlReport(readControl(recipe, options), options),
				steps: [],
			}),
		);
		const controlFile = controlPath(f.recipe, f.options);
		let originalControl: string | undefined;
		const toolsByName = new Map<string, RegisteredTool>();
		const face = registerWorkflowTools(
			{
				registerTool: (tool: RegisteredTool) => toolsByName.set(tool.name, tool),
				registerCommand: vi.fn(),
				sendMessage: vi.fn(),
				on: vi.fn(),
			} as unknown as ExtensionAPI,
			{
				resolvePaoHome: () => isolatedParent,
				resolveOwnerSessionId: () => "owner",
				resolveRunMode: () => {
					if (originalControl === undefined) {
						const flow = readControl(f.recipe, f.options);
						if (flow.待决办理?.[0]?.stage === "completed") {
							originalControl = readFileSync(controlFile, "utf8");
							writeFileSync(controlFile, "{broken", "utf8");
						}
					}
					return "unattended";
				},
				runner: new WorkerRunner(),
				notifySurface: surface,
				driveDepartments,
			},
		);
		const tool = toolsByName.get("pao_control_node");
		if (!tool) throw new Error("pao_control_node 未注册");
		const params = {
			name: f.recipe.名字,
			cards_dir: f.cardsDir,
			action: "resolve_pending",
			pending_key: f.pendingKey,
			decisions: f.decisions,
		};
		const run = async (): Promise<string> =>
			(await tool.execute("resolve-recovery", params, undefined, undefined, { hasUI: false })).content
				.map((part) => part.text)
				.join("\n");

		const commitsBefore = allCommitCount(f.root);
		await expect(run()).rejects.toThrow();
		expect(originalControl).toBeDefined();
		writeFileSync(controlFile, originalControl!, "utf8");
		let flow = readControl(f.recipe, f.options);
		expect(flow.待决).toBeUndefined();
		expect(flow.待决办理?.[0]).toMatchObject({ stage: "completed" });
		expect(flow.待决办理?.[0]?.advance).toBeUndefined();
		expect(allCommitCount(f.root)).toBeGreaterThan(commitsBefore);
		expect(driveDepartments).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();

		const commitsAfterResolution = allCommitCount(f.root);
		const recovered = await run();
		await face.waitForAutoChain();
		expect(recovered).toContain("自动推进受理成功");
		expect(allCommitCount(f.root)).toBe(commitsAfterResolution);
		expect(driveDepartments).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		flow = readControl(f.recipe, f.options);
		expect(flow.待决办理?.[0]?.advance).toMatchObject({ status: "accepted" });

		const replay = await run();
		await face.waitForAutoChain();
		expect(replay).toContain("自动推进已受理，本次不重复推进或唤醒");
		expect(allCommitCount(f.root)).toBe(commitsAfterResolution);
		expect(driveDepartments).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
	}, 120_000);

	it("真实在途链去重时按实际回执报告已有推进，不伪称本次新受理", async () => {
		const f = await workflowFixture();
		let releaseDrive!: () => void;
		const driveGate = new Promise<void>((resolveDrive) => {
			releaseDrive = resolveDrive;
		});
		const driveDepartments = vi.fn(async (recipe, options): Promise<AutoChainReport> => {
			await driveGate;
			return {
				report: await readControlReport(readControl(recipe, options), options),
				steps: [],
			};
		});
		const { run, background } = setupTools({
			resolvePaoHome: () => isolatedParent,
			resolveOwnerSessionId: () => "owner",
			resolveRunMode: () => "unattended",
			runner: new WorkerRunner(),
			driveDepartments,
		});

		await run("pao_push_flow", {
			name: f.recipe.名字,
			cards_dir: f.cardsDir,
		});
		expect(background.backgroundCount().inFlight).toBe(1);
		try {
			const resolved = await run("pao_control_node", {
				name: f.recipe.名字,
				cards_dir: f.cardsDir,
				action: "resolve_pending",
				pending_key: f.pendingKey,
				decisions: f.decisions,
			});
			expect(resolved).toContain("现有后台推进已覆盖本次待决，本次不重复受理或唤醒");
			expect(resolved).not.toContain("自动推进受理成功");
			expect(readControl(f.recipe, f.options).待决办理?.[0]?.advance).toMatchObject({
				status: "accepted",
			});
			expect(driveDepartments).toHaveBeenCalledTimes(1);
		} finally {
			releaseDrive();
		}
		await background.waitForAutoChain();
		expect(driveDepartments).toHaveBeenCalledTimes(1);
	}, 120_000);

	it("首次缺项由真实工具拒绝且不推进，补齐同待决后可完成", async () => {
		const f = await workflowFixture();
		const driveDepartments = vi.fn(
			async (recipe, options): Promise<AutoChainReport> => ({
				report: await readControlReport(readControl(recipe, options), options),
				steps: [],
			}),
		);
		const { run } = setupTools({
			resolvePaoHome: () => isolatedParent,
			resolveOwnerSessionId: () => "owner",
			resolveRunMode: () => "unattended",
			runner: new WorkerRunner(),
			driveDepartments,
		});
		const params = {
			name: f.recipe.名字,
			cards_dir: f.cardsDir,
			action: "resolve_pending",
			pending_key: f.pendingKey,
			decisions: f.decisions,
		};
		await expect(run("pao_control_node", { ...params, decisions: [f.decisions[0]] })).rejects.toThrow(
			/必须恰好覆盖|缺项/,
		);
		expect(readControl(f.recipe, f.options).待决?.key).toBe(f.pendingKey);
		expect(readControl(f.recipe, f.options).待决办理).toBeUndefined();
		expect(driveDepartments).not.toHaveBeenCalled();

		const completed = await run("pao_control_node", params);
		expect(completed).toContain("本次办理完成");
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		expect(driveDepartments).toHaveBeenCalledTimes(1);
	}, 120_000);

	it("有人值守、人工门和错误 owner 均不能经工具办理，模型夹带身份字段也会拒绝", async () => {
		const f = await workflowFixture();
		const attended = setupTools({
			resolvePaoHome: () => isolatedParent,
			resolveOwnerSessionId: () => "owner",
			resolveRunMode: () => "attended",
			runner: new WorkerRunner(),
		});
		const base = {
			name: f.recipe.名字,
			cards_dir: f.cardsDir,
			action: "resolve_pending",
			pending_key: f.pendingKey,
			decisions: f.decisions,
		};
		await expect(attended.run("pao_control_node", base)).rejects.toThrow(/可信宿主未授权无人值守/);

		const wrongOwner = setupTools({
			resolvePaoHome: () => isolatedParent,
			resolveOwnerSessionId: () => "another-owner",
			resolveRunMode: () => "unattended",
			runner: new WorkerRunner(),
		});
		await expect(wrongOwner.run("pao_control_node", base)).rejects.toThrow(/owner 会话不匹配/);

		const unattended = setupTools({
			resolvePaoHome: () => isolatedParent,
			resolveOwnerSessionId: () => "owner",
			resolveRunMode: () => "unattended",
			runner: new WorkerRunner(),
		});
		await expect(unattended.run("pao_control_node", { ...base, instance: "forged", attempt: 99 })).rejects.toThrow(
			/不接受身份或未允许字段：instance、attempt/,
		);
		expect(readControl(f.recipe, f.options).待决?.key).toBe(f.pendingKey);

		const manual = await manualGateFixture();
		const manualTools = setupTools({
			resolvePaoHome: () => isolatedParent,
			resolveOwnerSessionId: () => "owner",
			resolveRunMode: () => "unattended",
			runner: new WorkerRunner(),
		});
		const flow = readControl(manual.recipe, manual.options);
		await expect(
			manualTools.run("pao_control_node", {
				name: manual.recipe.名字,
				cards_dir: manual.options.cardsDir,
				action: "resolve_pending",
				pending_key: flow.待决!.key,
				decisions: [],
			}),
		).rejects.toThrow(/当前实例不是无人值守运行方式/);
	}, 120_000);

	it("真实 AbortSignal 在等待控制锁后取消，不产生待决办理记录", async () => {
		const f = await workflowFixture();
		const { run } = setupTools({
			resolvePaoHome: () => isolatedParent,
			resolveOwnerSessionId: () => "owner",
			resolveRunMode: () => "unattended",
			runner: new WorkerRunner(),
		});
		let lockAcquired!: () => void;
		let releaseLock!: () => void;
		const acquired = new Promise<void>((resolveAcquired) => {
			lockAcquired = resolveAcquired;
		});
		const held = new Promise<void>((resolveHeld) => {
			releaseLock = resolveHeld;
		});
		const holding = withFileLock(controlPath(f.recipe, f.options), async () => {
			lockAcquired();
			await held;
		});
		await acquired;
		const controller = new AbortController();
		const call = run(
			"pao_control_node",
			{
				name: f.recipe.名字,
				cards_dir: f.cardsDir,
				action: "resolve_pending",
				pending_key: f.pendingKey,
				decisions: f.decisions,
			},
			controller.signal,
		);
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		controller.abort(new Error("工具调用已取消"));
		releaseLock();
		await holding;
		await expect(call).rejects.toThrow("工具调用已取消");
		expect(readControl(f.recipe, f.options).待决?.key).toBe(f.pendingKey);
		expect(readControl(f.recipe, f.options).待决办理).toBeUndefined();
		expect(existsSync(join(f.root, "产物.txt"))).toBe(true);
	});
});
