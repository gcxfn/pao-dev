import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { bindExecutionContext } from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus, createCard, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import type { TaskState } from "../../src/pao/cards/types.ts";
import * as atomic from "../../src/pao/shared/atomic.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	type NodeIdentity,
	type PendingResolutionInput,
	readControl,
	recordPending,
	resolvePendingOnce,
	startControl,
} from "../../src/pao/workflow/control.ts";
import type { DriverOptions } from "../../src/pao/workflow/driver.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import {
	createDeviationPending,
	deviationItemRef,
	type PendingDecisionInput,
} from "../../src/pao/workflow/transition.ts";

const ENV_KEYS = ["PAO_HOME", "PAO_RUN_MODE", "PI_OFFLINE", "PI_NO_LOCAL_LLM", "GIT_AUTHOR_DATE"] as const;
const roots: string[] = [];
let isolatedParent = "";
let environmentBackup: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

interface Fixture {
	root: string;
	cardsDir: string;
	options: DriverOptions;
	recipe: ReturnType<typeof parseRecipe>;
	identity: NodeIdentity;
	cardRef: string;
	cardNo: number;
	attempt: number;
	pending: Awaited<ReturnType<typeof recordPending>>;
	input: PendingResolutionInput;
	setNow(value: string): void;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
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

function allCommitCount(cwd: string): number {
	return Number.parseInt(git(cwd, ["rev-list", "--all", "--count"]), 10);
}

async function fixture(
	input: { runMode?: "attended" | "unattended"; taskState?: TaskState; noWorkerChanges?: boolean } = {},
): Promise<Fixture> {
	const root = mkdtempSync(join(isolatedParent, "resolution-"));
	roots.push(root);
	writeFileSync(join(root, "已跟踪.txt"), "baseline\n");
	git(root, ["init", "--quiet"]);
	if (input.noWorkerChanges) writeFileSync(join(root, "产物.txt"), "baseline artifact\n");
	git(root, ["add", "--", "已跟踪.txt"]);
	if (input.noWorkerChanges) git(root, ["add", "--", "产物.txt"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "baseline"]);

	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const recipeName = `待决办理-${root.split(/[\\/]/).at(-1)}`;
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: recipeName,
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "产出文件", 验收: "存在: 产物.txt" }],
		})}---\n`,
		join(root, `${recipeName}.md`),
	);
	let now = "2026-10-30 10:10";
	const runMode = input.runMode ?? "unattended";
	const options: DriverOptions = {
		cardsDir,
		workspaceDir: join(root, ".pao"),
		ownerSessionId: "owner",
		runMode,
		now: () => now,
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
			snapshotRef: "pao://brief/resolution-test",
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
	if (!input.noWorkerChanges) writeFileSync(join(root, "产物.txt"), "worker result\n");
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
		changes: input.noWorkerChanges ? [] : [{ 路径: "产物.txt", 类型: "created", 说明: "真实写入" }],
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
		createdAt: "2026-10-30T02:00:00.000Z",
		deadline: "2026-10-30T02:30:00.000Z",
	});
	await recordPending(recipe, options, pending);
	const decisions: PendingDecisionInput[] = [
		{ item_ref: deviationItemRef(card.card_no, attempt, 0), basis: "复核真实失败命令与退出码，确认影响范围可控" },
		{ item_ref: deviationItemRef(card.card_no, attempt, 1), basis: "复核未运行原因，确认补偿证据足以接受当前成果" },
	];
	return {
		root,
		cardsDir,
		options,
		recipe,
		identity,
		cardRef,
		cardNo: card.card_no,
		attempt,
		pending,
		input: { pending_key: pending.key, decisions },
		setNow(value) {
			now = value;
		},
	};
}

function deliveryRef(f: Fixture): string {
	return `refs/pao-execution/deliveries/card-${String(f.cardNo).padStart(4, "0")}-attempt-${f.attempt}`;
}

function deliveryResultPath(f: Fixture): string {
	return join(
		dirname(f.cardsDir),
		"delivery-results",
		`card-${String(f.cardNo).padStart(4, "0")}-attempt-${f.attempt}.json`,
	);
}

async function expectNoBusinessEffect(
	f: Fixture,
	options: DriverOptions,
	input: PendingResolutionInput,
	error: RegExp,
	expectedAttempt = f.attempt,
	canReadControl = true,
): Promise<void> {
	await expect(resolvePendingOnce(f.recipe, options, input)).rejects.toThrow(error);
	if (canReadControl) expect(readControl(f.recipe, f.options).待决?.key).toBe(f.pending.key);
	else expect(readFileSync(controlPath(f.recipe, f.options), "utf8")).toContain(f.pending.key);
	expect(loadCard(f.cardsDir, f.cardNo).frontmatter).toMatchObject({
		status: "in_progress",
		attempt: expectedAttempt,
	});
	expect(refExists(f.root, deliveryRef(f))).toBe(false);
	expect(existsSync(deliveryResultPath(f))).toBe(false);
}

beforeEach(() => {
	const parent = process.env.PAO_HOME?.trim();
	if (!parent) throw new Error("待决办理测试须先设置显式隔离 PAO_HOME");
	isolatedParent = resolve(parent);
	mkdirSync(isolatedParent, { recursive: true });
	for (const key of ENV_KEYS) environmentBackup[key] = process.env[key];
	process.env.PAO_HOME = isolatedParent;
	process.env.PI_OFFLINE = "1";
	process.env.PI_NO_LOCAL_LLM = "1";
	delete process.env.PAO_RUN_MODE;
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		const previous = environmentBackup[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	environmentBackup = {};
	for (const root of roots.splice(0)) {
		if (!resolve(root).startsWith(`${isolatedParent}\\`) && !resolve(root).startsWith(`${isolatedParent}/`))
			throw new Error(`拒绝清理隔离 PAO_HOME 外路径：${root}`);
		rmSync(root, { recursive: true, force: true });
	}
});

describe("I1-3a 单次裁决程序办理", () => {
	it("两项逐项依据经真实机械验收、卡交付、受控 Git 交卷，清同一待决且完整重放不增提交", async () => {
		const f = await fixture();
		const result = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(result).toMatchObject({
			pending_key: f.pending.key,
			stage: "completed",
			idempotent: false,
			flow_status: expect.stringMatching(/^(running|hold|completed)$/),
		});
		expect(result.submission.交卷).toBe(true);
		expect(result.submission.提交哈希).toMatch(/^[a-f0-9]{40,64}$/);
		const card = loadCard(f.cardsDir, f.cardNo);
		expect(card.frontmatter.status).toBe("delivered");
		expect(card.body).toContain("复核真实失败命令与退出码");
		expect(card.body).toContain("复核未运行原因");
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		expect(readControl(f.recipe, f.options).待决办理?.[0]).toMatchObject({ stage: "completed" });
		expect(refExists(f.root, deliveryRef(f))).toBe(true);
		expect(existsSync(deliveryResultPath(f))).toBe(true);
		const commits = allCommitCount(f.root);

		const replay = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(replay).toMatchObject({ idempotent: true, submission: result.submission });
		expect(allCommitCount(f.root)).toBe(commits);
	}, 90_000);

	it("只读偏差完成机械验收后以无改动事实办结，不创建提交且完整重放仍为 0 次新增", async () => {
		const f = await fixture({ noWorkerChanges: true });
		const commitsBefore = allCommitCount(f.root);
		const result = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(result).toMatchObject({
			pending_key: f.pending.key,
			stage: "completed",
			idempotent: false,
			submission: {
				交卷: false,
				skip: {
					reason: "no_worker_changes",
					attempt: f.attempt,
				},
			},
		});
		expect(result.submission.提交哈希).toBeUndefined();
		const skip = result.submission.skip;
		if (skip?.reason !== "no_worker_changes") throw new Error("本用例必须以真实无改动证明免提交");
		expect(skip.baseline_tree).toMatch(/^[a-f0-9]{40,64}$/);
		expect(skip.current_tree).toBe(skip.baseline_tree);
		expect(allCommitCount(f.root)).toBe(commitsBefore);
		expect(loadCard(f.cardsDir, f.cardNo).frontmatter.status).toBe("delivered");
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		expect(readControl(f.recipe, f.options).待决办理?.[0]).toMatchObject({
			stage: "completed",
			submission: {
				交卷: false,
				skip: {
					reason: "no_worker_changes",
					attempt: f.attempt,
				},
			},
		});

		const replay = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(replay).toMatchObject({ idempotent: true, submission: result.submission });
		expect(allCommitCount(f.root)).toBe(commitsBefore);
	}, 90_000);

	it("缺项、重复、外来项、夹带替换身份与空依据均在办理前整体拒绝", async () => {
		const cases: Array<{ name: string; input: (f: Fixture) => unknown; error: RegExp }> = [
			{
				name: "缺项",
				input: (f) => ({ pending_key: f.pending.key, decisions: [f.input.decisions[0]] }),
				error: /必须恰好覆盖|缺项/,
			},
			{
				name: "重复",
				input: (f) => ({ pending_key: f.pending.key, decisions: [f.input.decisions[0], f.input.decisions[0]] }),
				error: /重复/,
			},
			{
				name: "外来项",
				input: (f) => ({
					pending_key: f.pending.key,
					decisions: [
						...f.input.decisions.slice(0, 1),
						{ item_ref: "card-9999:attempt-1:verification-9", basis: "伪造项" },
					],
				}),
				error: /不属于当前待决/,
			},
			{
				name: "夹带身份",
				input: (f) => ({ ...f.input, attempt: 99 }),
				error: /未允许字段：attempt/,
			},
			{
				name: "空依据",
				input: (f) => ({
					pending_key: f.pending.key,
					decisions: [{ ...f.input.decisions[0], basis: "   " }],
				}),
				error: /basis: 不能为空/,
			},
		];
		for (const item of cases) {
			const f = await fixture();
			await expectNoBusinessEffect(f, f.options, item.input(f) as PendingResolutionInput, item.error);
		}
	}, 120_000);

	it("首次缺项被拒时不冻结输入，补齐逐项依据后仍可完成办理", async () => {
		const f = await fixture();
		const incomplete = {
			pending_key: f.pending.key,
			decisions: [f.input.decisions[0]!],
		};
		await expectNoBusinessEffect(f, f.options, incomplete, /必须恰好覆盖|缺项/);
		expect(readControl(f.recipe, f.options).待决办理).toBeUndefined();

		const result = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(result).toMatchObject({ pending_key: f.pending.key, stage: "completed", idempotent: false });
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
	}, 90_000);

	it("首次重复项被拒时不冻结输入，去重校正后仍可完成办理", async () => {
		const f = await fixture();
		const duplicated = {
			pending_key: f.pending.key,
			decisions: [f.input.decisions[0]!, f.input.decisions[0]!],
		};
		await expectNoBusinessEffect(f, f.options, duplicated, /重复/);
		expect(readControl(f.recipe, f.options).待决办理).toBeUndefined();

		const result = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(result).toMatchObject({ pending_key: f.pending.key, stage: "completed", idempotent: false });
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
	}, 90_000);

	it("旧 attempt、旧轮次、卡面条件变化和到期均拒绝，既有待决不覆盖", async () => {
		const attemptCase = await fixture();
		changeCardStatus(loadCard(attemptCase.cardsDir, attemptCase.cardNo), {
			操作者: "owner",
			to: "failed",
			失败类型: "unknown_outcome",
			依据: "制造下一 attempt",
			时间: "2026-10-30 10:02",
		});
		changeCardStatus(loadCard(attemptCase.cardsDir, attemptCase.cardNo), {
			操作者: "owner",
			to: "unclaimed",
			时间: "2026-10-30 10:03",
		});
		changeCardStatus(loadCard(attemptCase.cardsDir, attemptCase.cardNo), {
			操作者: "owner",
			to: "in_progress",
			时间: "2026-10-30 10:04",
		});
		await expectNoBusinessEffect(
			attemptCase,
			attemptCase.options,
			attemptCase.input,
			/attempt 已过期|身份与当前控制正本不一致/,
			2,
		);

		const roundCase = await fixture();
		const flow = readControl(roundCase.recipe, roundCase.options);
		flow.节点[0]!.轮次 += 1;
		writeFileSync(controlPath(roundCase.recipe, roundCase.options), `---\n${stringify(flow)}---\n`, "utf8");
		await expectNoBusinessEffect(
			roundCase,
			roundCase.options,
			roundCase.input,
			/轮次过期|不属于当前控制节点/,
			roundCase.attempt,
			false,
		);

		const conditionCase = await fixture();
		const card = loadCard(conditionCase.cardsDir, conditionCase.cardNo);
		writeFileSync(card.path, readFileSync(card.path, "utf8").replace("验收条件一", "验收条件已变化"), "utf8");
		await expectNoBusinessEffect(conditionCase, conditionCase.options, conditionCase.input, /回执事实已变化/);
		expect(readControl(conditionCase.recipe, conditionCase.options).待决办理).toBeUndefined();

		const deadlineCase = await fixture();
		deadlineCase.setNow("2026-10-30T02:30:00.000Z");
		await expectNoBusinessEffect(deadlineCase, deadlineCase.options, deadlineCase.input, /已到截止时间/);
		expect(readControl(deadlineCase.recipe, deadlineCase.options).待决办理).toBeUndefined();
	}, 120_000);

	it("未知任务态、执行占位 active/unknown、错误 owner 与有人值守都不能借理由放行", async () => {
		const unknown = await fixture({ taskState: "blocked" });
		await expectNoBusinessEffect(
			unknown,
			unknown.options,
			unknown.input,
			/只允许 completed 或 completed_with_deviations/,
		);

		const active = await fixture();
		writeFileSync(
			join(active.root, ".pao", "执行占位.json"),
			JSON.stringify({ type: "pao_execution_reservation", root: active.root }),
			"utf8",
		);
		await expectNoBusinessEffect(active, active.options, active.input, /占用状态为 active/);

		const damaged = await fixture();
		writeFileSync(join(damaged.root, ".pao", "执行占位.json"), "{broken", "utf8");
		await expectNoBusinessEffect(damaged, damaged.options, damaged.input, /占用状态为 unknown/);

		const wrongOwner = await fixture();
		await expectNoBusinessEffect(
			wrongOwner,
			{ ...wrongOwner.options, ownerSessionId: "another-owner" },
			wrongOwner.input,
			/owner 会话不匹配|owner 已变更|未持有控制权/,
		);

		const attended = await fixture({ runMode: "attended" });
		await expectNoBusinessEffect(attended, attended.options, attended.input, /可信宿主未授权无人值守|不是无人值守/);
	}, 120_000);

	it("机械验收失败记录 review_failed，但不交付、不清待决", async () => {
		const f = await fixture();
		rmSync(join(f.root, "产物.txt"));
		await expectNoBusinessEffect(f, f.options, f.input, /机械验收失败/);
		expect(readControl(f.recipe, f.options).待决办理?.[0]).toMatchObject({
			stage: "review_failed",
			failure: { stage: "review" },
		});
		await expect(
			resolvePendingOnce(f.recipe, f.options, {
				...f.input,
				decisions: f.input.decisions.map((decision, index) =>
					index === 0 ? { ...decision, basis: "验收失败后改写依据" } : decision,
				),
			}),
		).rejects.toThrow(/已绑定不同裁决依据/);
		expect(readControl(f.recipe, f.options).待决办理?.[0]).toMatchObject({ stage: "review_failed" });
	}, 90_000);

	it("预检失败不绑定首次理由，纠正缺项时可采用新的完整依据完成办理", async () => {
		const f = await fixture();
		const missing = {
			pending_key: f.pending.key,
			decisions: [{ ...f.input.decisions[0], basis: "第一次依据" }],
		};
		await expectNoBusinessEffect(f, f.options, missing, /必须恰好覆盖|缺项/);
		expect(readControl(f.recipe, f.options).待决办理).toBeUndefined();
		const corrected = {
			...f.input,
			decisions: [{ ...f.input.decisions[0], basis: "纠正后的依据" }, f.input.decisions[1]!],
		};
		const result = await resolvePendingOnce(f.recipe, f.options, corrected);
		expect(result).toMatchObject({ pending_key: f.pending.key, stage: "completed", idempotent: false });
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
	}, 90_000);

	it("交卷结果固化失败留下 submission_failed；同输入恢复复用同一 Git 对象且不重复提交", async () => {
		const f = await fixture();
		const resultPath = deliveryResultPath(f);
		const original = atomic.writeFileAtomic;
		const failure = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, ...args) => {
			if (path === resultPath) throw new Error("模拟交卷结果固化失败");
			return original(path, ...args);
		});
		await expect(resolvePendingOnce(f.recipe, f.options, f.input)).rejects.toThrow(/交卷失败/);
		failure.mockRestore();

		let flow = readControl(f.recipe, f.options);
		expect(flow.待决办理?.[0]).toMatchObject({ stage: "submission_failed", failure: { stage: "submission" } });
		expect(flow.待决办理?.[0]?.submission?.skip).toBeUndefined();
		expect(loadCard(f.cardsDir, f.cardNo).frontmatter.status).toBe("delivered");
		expect(flow.待决?.key).toBe(f.pending.key);
		expect(existsSync(resultPath)).toBe(false);
		expect(existsSync(`${resultPath}.pending`)).toBe(true);
		const delivery = git(f.root, ["rev-parse", deliveryRef(f)]);
		const commitsAfterFailure = allCommitCount(f.root);

		await expect(
			resolvePendingOnce(f.recipe, f.options, {
				...f.input,
				decisions: f.input.decisions.map((decision, index) =>
					index === 0 ? { ...decision, basis: "交卷失败后改写依据" } : decision,
				),
			}),
		).rejects.toThrow(/已绑定不同裁决依据/);
		expect(readControl(f.recipe, f.options).待决办理?.[0]).toMatchObject({ stage: "submission_failed" });

		const recovered = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(recovered.submission.交卷).toBe(true);
		expect(recovered.submission.提交哈希).toBe(delivery);
		expect(allCommitCount(f.root)).toBe(commitsAfterFailure);
		flow = readControl(f.recipe, f.options);
		expect(flow.待决).toBeUndefined();
		expect(flow.待决办理?.[0]).toMatchObject({
			stage: "completed",
			submission: { 交卷: true, 提交哈希: delivery },
		});
	}, 120_000);

	it("非空差异的真实 Git 提交失败保持 submission_failed，不能落入无改动跳过分支", async () => {
		const f = await fixture();
		const commitsBefore = allCommitCount(f.root);
		process.env.GIT_AUTHOR_DATE = "not-a-valid-git-date";
		try {
			await expect(resolvePendingOnce(f.recipe, f.options, f.input)).rejects.toThrow(/交卷失败/);
		} finally {
			delete process.env.GIT_AUTHOR_DATE;
		}
		const flow = readControl(f.recipe, f.options);
		expect(flow.待决?.key).toBe(f.pending.key);
		expect(flow.待决办理?.[0]).toMatchObject({
			stage: "submission_failed",
			failure: { stage: "submission" },
			submission: { 交卷: false },
		});
		expect(flow.待决办理?.[0]?.submission?.skip).toBeUndefined();
		expect(loadCard(f.cardsDir, f.cardNo).frontmatter.status).toBe("delivered");
		expect(refExists(f.root, deliveryRef(f))).toBe(false);
		expect(existsSync(deliveryResultPath(f))).toBe(false);
		expect(allCommitCount(f.root)).toBe(commitsBefore);
	}, 90_000);

	it("既有 createCard 与有人值守请求裁定入口仍在；程序办理只拒绝 attended 控制正本", async () => {
		const root = mkdtempSync(join(isolatedParent, "legacy-"));
		roots.push(root);
		const cardsDir = join(root, "卡");
		const card = await createCard(cardsDir, {
			目标: "旧人工入口",
			部门: "测试",
			验收: "x",
			创建: "2026-10-30 10:00",
		});
		expect(loadCard(cardsDir, card.card_no).frontmatter.status).toBe("unclaimed");
		const f = await fixture({ runMode: "attended" });
		await expect(resolvePendingOnce(f.recipe, f.options, f.input)).rejects.toThrow(
			/可信宿主未授权无人值守|不是无人值守/,
		);
		expect(readControl(f.recipe, f.options).运行方式).toBe("有人值守");
	}, 90_000);
});
