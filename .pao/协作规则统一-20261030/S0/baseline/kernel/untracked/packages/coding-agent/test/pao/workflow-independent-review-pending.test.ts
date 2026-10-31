/** 模拟审核回执；真实受管 Git 副本、机械验收和待决办理，不调用模型。 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { captureContentTree, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { bindExecutionContext } from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { verifyCard } from "../../src/pao/cards/verifier.ts";
import {
	addNodeCards,
	bindMinister,
	readControl,
	recordPending,
	resolvePendingOnce,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { createDeviationPending } from "../../src/pao/workflow/transition.ts";
import { createLocalPaoWorktreeHost } from "../../src/pao/worktrees/local-host/index.ts";

const roots: string[] = [];
function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
}
afterEach(() => {
	const parent = resolve(process.env.PAO_HOME!);
	for (const root of roots.splice(0)) {
		if (!resolve(root).startsWith(parent + sep)) throw new Error("拒绝清理隔离目录外路径");
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

async function fixture() {
	if (!process.env.PAO_HOME) throw new Error("请显式设置隔离 PAO_HOME");
	mkdirSync(process.env.PAO_HOME, { recursive: true });
	const root = mkdtempSync(join(process.env.PAO_HOME, "review-pending-"));
	roots.push(root);
	const project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(project, "source.txt"), "original\n");
	git(project, "init", "--quiet");
	git(project, "add", "source.txt");
	git(project, "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline");
	const originalHead = git(project, "rev-parse", "HEAD");
	const originalTree = (await captureContentTree(project)).tree;
	const host = createLocalPaoWorktreeHost({ stateRoot: join(root, "state"), projectRoot: project });
	const worktree = await host.create({ requestId: "review-evidence", projectRoot: project, displayName: "审核副本" });
	if (worktree.kind !== "managed") throw new Error("测试要求真实受管副本");
	const cardsDir = join(project, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "独立审核待决",
			参数: [],
			节点: [
				{
					名字: "审核",
					部门: "审核",
					目标: "独立复核",
					验收: "存在: source.txt\n存在: audit-proof.txt",
					只读: true,
					审核: true,
					部门标准: "独立证据，不合并副本",
				},
			],
		})}---\n`,
		join(root, "独立审核待决.md"),
	);
	const options = {
		cardsDir,
		workspaceDir: join(project, ".pao"),
		ownerSessionId: "owner",
		runMode: "unattended" as const,
		now: () => "2026-10-30 10:10",
	};
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "审核", "minister-review");
	const flow = readControl(recipe, options);
	const identity = { 实例: flow.实例, 节点: "审核", 轮次: 1, 部长会话: "minister-review" };
	const [ref] = await addNodeCards(recipe, options, identity, [
		{ goal: "独立验证", acceptance: "存在: source.txt\n存在: audit-proof.txt" },
	]);
	const cardNo = parseCardRef(ref!);
	changeCardStatus(loadCard(cardsDir, cardNo), { 操作者: "owner", to: "in_progress", 时间: "2026-10-30 10:00" });
	const card = loadCard(cardsDir, cardNo);
	const key = { cardsDir, cardNo, attempt: card.frontmatter.attempt };
	const binding = await bindExecutionContext(
		{
			key,
			projectRoot: project,
			repositoryRoot: worktree.executionRoot,
			executionRoot: worktree.executionRoot,
			worktree,
			snapshotRef: "pao://review/input",
			snapshotDigest: `sha256:${"2".repeat(64)}`,
		},
		{ expectedCurrentAttempt: key.attempt },
	);
	const baseline = await snapshotClaimBaseline(cardsDir, cardNo, {
		owner: "owner",
		时间: "2026-10-30 10:00",
		attempt: key.attempt,
		验收: card.frontmatter.acceptance,
		execution: binding,
	});
	expect(baseline.可用, baseline.原因).toBe(true);
	writeFileSync(join(worktree.executionRoot, "audit-proof.txt"), "independent evidence\n");
	appendReceipt(loadCard(cardsDir, cardNo), {
		尝试号: key.attempt,
		时间: "2026-10-30 10:01",
		结果: "success",
		任务态: "completed",
		摘要: "模拟审核回执；已完成验证，但一个观察探针未运行断言",
		产物路径: ["audit-proof.txt"],
		verification: [{ 条件: "观察探针未作为断言", 结论: "not_run", 证据: "只观察，没有宣称通过" }],
		changes: [{ 路径: "audit-proof.txt", 类型: "created", 说明: "独立审核证据" }],
	});
	const verified = await verifyCard(cardsDir, cardNo, { operator: "owner", executionKey: key });
	expect(verified.result.结论).toBe("全过停人工审");
	const pending = createDeviationPending({
		instance: identity.实例,
		node: "审核",
		round: 1,
		cardRef: ref!,
		cardNo,
		attempt: key.attempt,
		reason: "独立审核探针未断言",
		items: [{ verification_index: 0, 条件: "观察探针未作为断言", 自报结论: "not_run" }],
		createdAt: new Date(Date.parse(options.now()) - 10 * 60_000).toISOString(),
		deadline: new Date(Date.parse(options.now()) + 20 * 60_000).toISOString(),
	});
	await recordPending(recipe, options, pending);
	const input = {
		pending_key: pending.key,
		decisions: [
			{ item_ref: pending.items[0]!.item_ref, basis: "明确接受该未运行观察项；不宣称已验证，不替代部长质量判定" },
		],
	};
	return { root, project, recipe, options, cardNo, worktree, input, pending, originalHead, originalTree };
}

describe("独立审核待决不合并业务", { timeout: 120_000 }, () => {
	it("完成态带 not_run 可一次办理且幂等，审核证据留在副本，节点仍待专业判定", async () => {
		const f = await fixture();
		const copyHead = git(f.worktree.executionRoot, "rev-parse", "HEAD");
		const result = await resolvePendingOnce(f.recipe, f.options, f.input);
		expect(result.submission).toMatchObject({
			交卷: false,
			skip: { reason: "independent_review_evidence", attempt: 1 },
		});
		expect(result.submission.提交哈希).toBeUndefined();
		expect(git(f.project, "rev-parse", "HEAD")).toBe(f.originalHead);
		expect((await captureContentTree(f.project)).tree).toBe(f.originalTree);
		expect(git(f.worktree.executionRoot, "rev-parse", "HEAD")).toBe(copyHead);
		expect(readFileSync(join(f.project, "source.txt"), "utf8")).toBe("original\n");
		expect(existsSync(join(f.project, "audit-proof.txt"))).toBe(false);
		expect(readFileSync(join(f.worktree.executionRoot, "audit-proof.txt"), "utf8")).toBe("independent evidence\n");
		expect(loadCard(f.options.cardsDir, f.cardNo).frontmatter.status).toBe("delivered");
		expect(readControl(f.recipe, f.options).待决).toBeUndefined();
		expect(readControl(f.recipe, f.options).节点[0]!.判定).toBeUndefined();
		expect((await resolvePendingOnce(f.recipe, f.options, f.input)).idempotent).toBe(true);
		expect(git(f.project, "rev-parse", "HEAD")).toBe(f.originalHead);
	});
	it("原业务根改版后拒绝办理，不合并审核证据或清除待决", async () => {
		const f = await fixture();
		writeFileSync(join(f.project, "source.txt"), "changed externally\n");
		await expect(resolvePendingOnce(f.recipe, f.options, f.input)).rejects.toThrow(/独立审核|成果版本/);
		expect(readControl(f.recipe, f.options).待决?.key).toBe(f.pending.key);
		expect(loadCard(f.options.cardsDir, f.cardNo).frontmatter.status).toBe("in_progress");
		expect(git(f.project, "rev-parse", "HEAD")).toBe(f.originalHead);
		expect(readFileSync(join(f.project, "source.txt"), "utf8")).toBe("changed externally\n");
		expect(existsSync(join(f.project, "audit-proof.txt"))).toBe(false);
	});
});
