import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { baselineSnapshotPath, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, loadCard, readCard } from "../../src/pao/cards/cardfile.ts";
import {
	bindExecutionContext,
	type ExecutionBinding,
	executionContextPath,
} from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { readWorkerChangeFacts } from "../../src/pao/worker/change-facts.ts";

/**
 * 所有 Git 与 PAO 状态夹具都在显式任务父目录，不使用系统临时目录。
 * 这里的写入是测试自身制造的真实工作树改动；事实读取代码本身保持只读。
 */
const FIXTURE_PARENT = "D:\\AI\\workspace\\临时文件夹\\深度审核重整-20261028\\i3-change-facts";
const PAO_HOME = join(FIXTURE_PARENT, "PAO_HOME");
const FIXTURE_ROOT = join(PAO_HOME, ".pao", "tasks", "i3-change-facts");
const cases: string[] = [];

afterEach(() => {
	for (const dir of cases.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterAll(() => rmSync(FIXTURE_PARENT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.quotepath=off", "-c", "user.email=test@example.invalid", "-c", "user.name=test", ...args],
		{
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
}

function caseRoot(): string {
	mkdirSync(FIXTURE_ROOT, { recursive: true });
	const root = mkdtempSync(join(FIXTURE_ROOT, "case-"));
	cases.push(root);
	return root;
}

function commit(root: string, message: string): void {
	git(root, ["add", "-A"]);
	git(root, ["commit", "--no-gpg-sign", "-m", message]);
}

function writeEvidence(input: {
	path: string;
	cardPath: string;
	cardNo: number;
	attempt: number;
	runId?: string;
	modelChanges?: Array<{ 路径: string; 类型: string; 说明: string }>;
}): void {
	const runId = input.runId ?? "run-current";
	const number = String(input.cardNo).padStart(4, "0");
	const lines = [
		JSON.stringify({
			type: "pao_worker_live",
			卡号: number,
			卡路径: input.cardPath,
			尝试: input.attempt,
			执行标识: runId,
			pid: 1234,
			开始时间: "2026-10-30T00:00:00.000Z",
		}),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							result: "success",
							artifact_path: [],
							summary: "模型自报",
							changes: input.modelChanges ?? [],
						}),
					},
				],
				usage: { input: 1, output: 1, cost: 0 },
				stopReason: "end",
			},
		}),
		JSON.stringify({
			type: "pao_worker_evidence",
			卡号: number,
			卡路径: input.cardPath,
			尝试: input.attempt,
			执行标识: runId,
			exitCode: 0,
			stderrTail: "",
		}),
	];
	mkdirSync(join(input.path, ".."), { recursive: true });
	writeFileSync(input.path, `${lines.join("\n")}\n`, "utf8");
}

interface PrimaryFixture {
	root: string;
	taskRoot: string;
	executionRoot: string;
	cardsDir: string;
	cardPath: string;
	cardNo: number;
	attempt: number;
	binding: ExecutionBinding;
	baselinePath: string;
	evidencePath: string;
}

async function primaryFixture(): Promise<PrimaryFixture> {
	const root = caseRoot();
	const taskRoot = join(root, "task");
	const executionRoot = join(root, "execution");
	mkdirSync(taskRoot, { recursive: true });
	mkdirSync(executionRoot, { recursive: true });
	writeFileSync(join(executionRoot, "modified.txt"), "v1\n", "utf8");
	writeFileSync(join(executionRoot, "deleted.txt"), "remove me\n", "utf8");
	writeFileSync(join(executionRoot, "preexisting-dirty.txt"), "committed v1\n", "utf8");
	git(executionRoot, ["init"]);
	commit(executionRoot, "base");

	const cardsDir = join(taskRoot, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const created = await createCard(
		cardsDir,
		{ 目标: "读取当前 attempt 文件改动", 部门: "测试", 验收: "真实 Git", 创建: "2026-10-30 09:00" },
		{ counterPath: join(taskRoot, ".pao", "卡号.txt") },
	);
	changeCardStatus(created, { 操作者: "主控", to: "in_progress", 时间: "2026-10-30 09:01" });
	const card = readCard(created.path);
	const head = git(executionRoot, ["rev-parse", "HEAD"]);
	const binding = await bindExecutionContext(
		{
			key: { cardsDir, cardNo: card.card_no, attempt: card.frontmatter.attempt },
			projectRoot: taskRoot,
			repositoryRoot: executionRoot,
			executionRoot,
			worktree: {
				kind: "primary",
				taskRoot,
				executionRoot,
				commonGitDir: git(executionRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
				inputVersion: head,
				bindingDigest: `sha256:${createHash("sha256").update("primary-fixture").digest("hex")}`,
			},
			snapshotRef: "pao://brief/i3-change-facts",
			snapshotDigest: `sha256:${"a".repeat(64)}`,
		},
		{ expectedCurrentAttempt: card.frontmatter.attempt },
	);

	// 这些发生在认领基线之前，后面的 helper 必须把它们留在基线里。
	writeFileSync(join(executionRoot, "preexisting-dirty.txt"), "dirty before claim\n", "utf8");
	writeFileSync(join(executionRoot, "preexisting-untracked.txt"), "untracked before claim\n", "utf8");
	const snapshot = await snapshotClaimBaseline(cardsDir, card.card_no, {
		owner: "主控",
		时间: "2026-10-30 09:02",
		attempt: card.frontmatter.attempt,
		execution: binding,
	});
	expect(snapshot.可用, snapshot.原因).toBe(true);
	const baselinePath = baselineSnapshotPath(cardsDir, card.card_no, card.frontmatter.attempt);
	const evidencePath = join(taskRoot, ".pao", "任务", "证据", "run.live.jsonl");
	writeEvidence({
		path: evidencePath,
		cardPath: card.path,
		cardNo: card.card_no,
		attempt: card.frontmatter.attempt,
		modelChanges: [
			{ 路径: "preexisting-dirty.txt", 类型: "modified", 说明: "模型声称" },
			{ 路径: "ghost.txt", 类型: "created", 说明: "模型声称" },
		],
	});
	return {
		root,
		taskRoot,
		executionRoot,
		cardsDir,
		cardPath: card.path,
		cardNo: card.card_no,
		attempt: card.frontmatter.attempt,
		binding,
		baselinePath,
		evidencePath,
	};
}

function expectUnknown(facts: Awaited<ReturnType<typeof readWorkerChangeFacts>>, pattern: RegExp): void {
	expect(facts.available).toBe(false);
	expect(facts.created).toEqual([]);
	expect(facts.modified).toEqual([]);
	expect(facts.deleted).toEqual([]);
	expect(facts.reason).toMatch(pattern);
}

describe("worker 当前 attempt 文件改动事实", () => {
	it("真实隔离 Git 排除认领前 dirty/untracked，并准确区分本次 created/modified/deleted；忽略模型 changes", async () => {
		const f = await primaryFixture();
		writeFileSync(join(f.executionRoot, "modified.txt"), "v2 worker\n", "utf8");
		unlinkSync(join(f.executionRoot, "deleted.txt"));
		mkdirSync(join(f.executionRoot, "created"), { recursive: true });
		writeFileSync(join(f.executionRoot, "created", "new.txt"), "worker new\n", "utf8");

		const facts = await readWorkerChangeFacts({
			binding: f.binding,
			baselinePath: f.baselinePath,
			evidencePath: f.evidencePath,
			cardPath: f.cardPath,
			runId: "run-current",
		});

		expect(facts).toEqual({
			available: true,
			created: ["created/new.txt"],
			modified: ["modified.txt"],
			deleted: ["deleted.txt"],
		});
		expect(JSON.stringify(facts)).not.toContain("preexisting-dirty.txt");
		expect(JSON.stringify(facts)).not.toContain("preexisting-untracked.txt");
		expect(JSON.stringify(facts)).not.toContain("ghost.txt");
		// 当前 Git HEAD 差异会包含认领前 dirty，本 helper 只读认领 tree，故现场仍保持 dirty 也不影响断言。
		expect(git(f.executionRoot, ["status", "--porcelain"]).split(/\r?\n/)).toEqual(
			expect.arrayContaining([" M preexisting-dirty.txt", "?? preexisting-untracked.txt"]),
		);
	});

	it("managed 执行根与任务根同名文件隔离，只读取绑定执行根", async () => {
		const root = caseRoot();
		const taskRoot = join(root, "task");
		const executionRoot = join(root, "managed");
		mkdirSync(taskRoot, { recursive: true });
		writeFileSync(join(taskRoot, "same-name.txt"), "source v1\n", "utf8");
		git(taskRoot, ["init"]);
		commit(taskRoot, "source base");
		const sourceHead = git(taskRoot, ["rev-parse", "HEAD"]);
		const sourceTree = git(taskRoot, ["rev-parse", "HEAD^{tree}"]);
		git(taskRoot, ["worktree", "add", "-b", "pao/i3-change-facts", executionRoot]);
		const commonGitDir = git(taskRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const cardsDir = join(taskRoot, ".pao", "卡");
		const createdCard = await createCard(
			cardsDir,
			{ 目标: "managed 根隔离", 部门: "测试", 验收: "同名不串根", 创建: "2026-10-30 10:00" },
			{ counterPath: join(taskRoot, ".pao", "卡号.txt") },
		);
		changeCardStatus(createdCard, { 操作者: "主控", to: "in_progress", 时间: "2026-10-30 10:01" });
		const card = readCard(createdCard.path);
		const binding = await bindExecutionContext(
			{
				key: { cardsDir, cardNo: card.card_no, attempt: card.frontmatter.attempt },
				projectRoot: taskRoot,
				repositoryRoot: executionRoot,
				executionRoot,
				worktree: {
					kind: "managed",
					worktreeId: "i3-change-facts",
					taskRoot,
					executionRoot,
					commonGitDir,
					branchName: "pao/i3-change-facts",
					inputVersion: sourceTree,
					bindingDigest: `sha256:${createHash("sha256").update("managed-fixture").digest("hex")}`,
					baseline: {
						sourceRoot: taskRoot,
						sourceHead,
						treeId: sourceTree,
						snapshotRepositoryPath: join(taskRoot, ".pao", "snapshots.git"),
						inputVersion: sourceTree,
						capturedAt: "2026-10-30T01:00:00.000Z",
						fileCount: 1,
						byteCount: 10,
						coverage: "complete",
						includedPaths: ["same-name.txt"],
						excludedPaths: [],
						notes: [],
					},
				},
				snapshotRef: "pao://brief/i3-managed-change-facts",
				snapshotDigest: `sha256:${"b".repeat(64)}`,
			},
			{ expectedCurrentAttempt: card.frontmatter.attempt },
		);
		const snapshot = await snapshotClaimBaseline(cardsDir, card.card_no, {
			owner: "主控",
			时间: "2026-10-30 10:02",
			attempt: card.frontmatter.attempt,
			execution: binding,
		});
		expect(snapshot.可用, snapshot.原因).toBe(true);
		const baselinePath = baselineSnapshotPath(cardsDir, card.card_no, card.frontmatter.attempt);
		const evidencePath = join(taskRoot, ".pao", "证据", "managed.live.jsonl");
		writeEvidence({
			path: evidencePath,
			cardPath: card.path,
			cardNo: card.card_no,
			attempt: card.frontmatter.attempt,
		});

		writeFileSync(join(taskRoot, "same-name.txt"), "task root changed\n", "utf8");
		const taskOnly = await readWorkerChangeFacts({
			binding,
			baselinePath,
			evidencePath,
			cardPath: card.path,
		});
		expect(taskOnly).toEqual({ available: true, created: [], modified: [], deleted: [] });

		writeFileSync(join(executionRoot, "same-name.txt"), "managed changed\n", "utf8");
		const managedOnly = await readWorkerChangeFacts({
			binding,
			baselinePath,
			evidencePath,
			cardPath: card.path,
		});
		expect(managedOnly).toEqual({
			available: true,
			created: [],
			modified: ["same-name.txt"],
			deleted: [],
		});
	});

	it("旧 attempt 明确未知，不拿旧基线配新卡面", async () => {
		const f = await primaryFixture();
		let card = loadCard(f.cardsDir, f.cardNo);
		card = changeCardStatus(card, {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-30 11:00",
		});
		card = changeCardStatus(card, { 操作者: "主控", to: "unclaimed", 时间: "2026-10-30 11:01" });
		card = changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-30 11:02" });
		expect(card.frontmatter.attempt).toBe(2);

		const facts = await readWorkerChangeFacts({
			binding: f.binding,
			baselinePath: f.baselinePath,
			evidencePath: f.evidencePath,
			cardPath: f.cardPath,
		});
		expectUnknown(facts, /当前 attempt|历史 attempt|attempt 1.*当前 attempt 2/);
	});

	it.each(["缺失", "损坏"] as const)("基线%s时明确未知，不返回空改动冒充可用", async (failure) => {
		const f = await primaryFixture();
		if (failure === "缺失") unlinkSync(f.baselinePath);
		else writeFileSync(f.baselinePath, "{ broken", "utf8");
		const facts = await readWorkerChangeFacts({
			binding: f.binding,
			baselinePath: f.baselinePath,
			evidencePath: f.evidencePath,
			cardPath: f.cardPath,
		});
		expectUnknown(facts, /基线不可读|不是 JSON/);
	});

	it("持久执行绑定损坏时明确未知，任务根同名文件也不能兜底", async () => {
		const f = await primaryFixture();
		writeFileSync(join(f.taskRoot, "modified.txt"), "task root same name must be ignored\n", "utf8");
		const contextPath = executionContextPath(f.binding.key);
		const saved = JSON.parse(readFileSync(contextPath, "utf8")) as Record<string, unknown>;
		saved.executionRoot = f.taskRoot;
		writeFileSync(contextPath, `${JSON.stringify(saved)}\n`, "utf8");

		const facts = await readWorkerChangeFacts({
			binding: f.binding,
			baselinePath: f.baselinePath,
			evidencePath: f.evidencePath,
			cardPath: f.cardPath,
		});
		expectUnknown(facts, /执行绑定不可用|摘要校验失败|执行根/);
	});

	it("证据卡或 attempt 身份错配时明确未知", async () => {
		const f = await primaryFixture();
		writeEvidence({
			path: f.evidencePath,
			cardPath: f.cardPath,
			cardNo: f.cardNo,
			attempt: f.attempt + 1,
		});
		const facts = await readWorkerChangeFacts({
			binding: f.binding,
			baselinePath: f.baselinePath,
			evidencePath: f.evidencePath,
			cardPath: f.cardPath,
		});
		expectUnknown(facts, /证据.*attempt.*不匹配|尝试号身份不匹配/);
	});
});
