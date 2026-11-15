import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureContentTree, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, loadCard } from "../../src/pao/cards/cardfile.ts";
import { deliverCard } from "../../src/pao/cards/delivery.ts";
import { bindExecutionContext } from "../../src/pao/cards/execution-context.ts";
import {
	integrateDelivery as actualIntegrateDelivery,
	checkIntegrationToolAuthority,
	type IntegrationRecord,
	integrationResultPath,
} from "../../src/pao/cards/integration.ts";
import * as cardProcess from "../../src/pao/cards/process.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { verifyCard } from "../../src/pao/cards/verifier.ts";
import { killTree } from "../../src/utils/kill-tree.ts";
import { withTestCleanup } from "../with-test-cleanup.ts";

vi.mock("../../src/utils/kill-tree.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/utils/kill-tree.ts")>();
	return { killTree: vi.fn(actual.killTree) };
});
const killTreeMock = vi.mocked(killTree);

const tempDirs: string[] = [];
const pendingIntegrations = new Map<Promise<IntegrationRecord>, AbortController>();

function integrateDelivery(request: Parameters<typeof actualIntegrateDelivery>[0]): Promise<IntegrationRecord> {
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(request.signal?.reason);
	request.signal?.addEventListener("abort", forwardAbort, { once: true });
	if (request.signal?.aborted) forwardAbort();
	const started = Date.now();
	const timing: Record<string, number> = { started };
	const operation = actualIntegrateDelivery({
		...request,
		signal: controller.signal,
		...(request.acquireWriteLock
			? {
					acquireWriteLock: async (input) => {
						timing.lockRequestedMs = Date.now() - started;
						const lock = await request.acquireWriteLock!(input);
						timing.lockAcquiredMs = Date.now() - started;
						return lock;
					},
				}
			: {}),
		beforeTargetWrite: async () => {
			timing.mergeComputedMs = Date.now() - started;
			await request.beforeTargetWrite?.();
		},
	});
	pendingIntegrations.set(operation, controller);
	const settled = () => {
		pendingIntegrations.delete(operation);
		request.signal?.removeEventListener("abort", forwardAbort);
		timing.finishedMs = Date.now() - started;
		if (process.env.PAO_E_EVIDENCE_DIR) {
			mkdirSync(process.env.PAO_E_EVIDENCE_DIR, { recursive: true });
			writeFileSync(
				join(process.env.PAO_E_EVIDENCE_DIR, `timing-${request.requestId}.json`),
				JSON.stringify(timing),
			);
		}
	};
	void operation.then(settled, settled);
	return operation;
}

afterEach(async () => {
	// 测试超时也必须等本用例的整合退出，才能移除它持有的锁目录和恢复替身。
	for (const controller of pendingIntegrations.values()) controller.abort();
	await Promise.allSettled([...pendingIntegrations.keys()]);
	vi.restoreAllMocks();
	killTreeMock.mockReset();
	for (const dir of tempDirs.splice(0)) {
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch (error) {
				if (attempt === 19 || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
				await delay(50 * (attempt + 1));
			}
		}
	}
}, 60000);

function tempDir(prefix = "pao-integration-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function writeLock(): Promise<{ release(): Promise<void> }> {
	return Promise.resolve({ release: async () => {} });
}

/** 独立验收运行可显式保留产品记录与检查日志；普通测试仍只使用夹具临时目录。 */
function preserveEvidence(record: IntegrationRecord): void {
	const evidenceRoot = process.env.PAO_E_EVIDENCE_DIR;
	if (!evidenceRoot) return;
	const dir = join(evidenceRoot, record.requestId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "record.json"), JSON.stringify(record, null, 2));
	for (const [index, check] of record.checks.entries()) {
		writeFileSync(join(dir, `check-${index + 1}.log`), readFileSync(check.outputPath));
	}
}

function repo(): string {
	const root = tempDir("pao-integration-repo-");
	writeFileSync(join(root, "base.txt"), "base\n");
	git(root, ["init"]);
	git(root, ["add", "-A"]);
	git(root, ["commit", "--no-gpg-sign", "-m", "base"]);
	return root;
}

function assertNoTemporaryIndexes(commonGitDir: string): void {
	const names = readdirSync(commonGitDir);
	expect(names.filter((name) => name.startsWith("pao-content-index-"))).toEqual([]);
	expect(names.filter((name) => name.startsWith("pao-integration-index-"))).toEqual([]);
}

async function managedExecution(input: {
	source: string;
	managed: string;
	worktreeId: string;
	branch: string;
	taskCardsDir: string;
	sourceHead?: string;
}): Promise<Awaited<ReturnType<typeof bindExecutionContext>>> {
	const sourceHead = input.sourceHead ?? git(input.source, ["rev-parse", "HEAD"]);
	const inputTree = git(input.source, ["rev-parse", `${sourceHead}^{tree}`]);
	const commonGitDir = git(input.managed, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const taskRoot = join(input.taskCardsDir, "..", "..");
	mkdirSync(input.taskCardsDir, { recursive: true });
	const card = await createCard(input.taskCardsDir, {
		目标: `整合 ${input.worktreeId}`,
		部门: "测试",
		验收: "存在: base.txt",
		创建: "2026-10-20 20:00",
	});
	changeCardStatus(card, { 操作者: "E", to: "in_progress", 时间: "2026-10-20 20:01" });
	return bindExecutionContext(
		{
			key: { cardsDir: input.taskCardsDir, cardNo: card.card_no, attempt: 1 },
			projectRoot: taskRoot,
			repositoryRoot: input.managed,
			executionRoot: input.managed,
			worktree: {
				kind: "managed",
				worktreeId: input.worktreeId,
				taskRoot,
				executionRoot: input.managed,
				commonGitDir,
				branchName: input.branch,
				inputVersion: sourceHead,
				bindingDigest: `host:${input.worktreeId}:${sourceHead}`,
				baseline: {
					sourceRoot: input.source,
					sourceHead,
					treeId: inputTree,
					snapshotRepositoryPath: join(tempDir("pao-integration-snapshot-"), "repo.git"),
					inputVersion: sourceHead,
					capturedAt: "2026-10-20T12:00:00.000Z",
					fileCount: 1,
					byteCount: 5,
					coverage: "complete",
					includedPaths: ["base.txt"],
					excludedPaths: [],
					notes: [],
				},
			},
			snapshotRef: join(tempDir("pao-integration-input-"), "snapshot.json"),
			snapshotDigest: `sha256:${"a".repeat(64)}`,
		},
		{ expectedCurrentAttempt: 1 },
	);
}

async function delivered(
	source: string,
	managed: string,
	worktreeId: string,
	branch: string,
	value: string,
	cardsDir = join(source, ".pao", "卡"),
): Promise<Awaited<ReturnType<typeof bindExecutionContext>>> {
	mkdirSync(cardsDir, { recursive: true });
	const execution = await managedExecution({
		source,
		managed,
		worktreeId,
		branch,
		taskCardsDir: cardsDir,
	});
	await snapshotClaimBaseline(cardsDir, execution.key.cardNo, {
		owner: "E",
		attempt: 1,
		execution,
		验收: loadCard(cardsDir, execution.key.cardNo).frontmatter.acceptance,
	});
	writeFileSync(join(managed, "base.txt"), value);
	const verified = await verifyCard(cardsDir, execution.key.cardNo, {
		operator: "E",
		executionKey: execution.key,
		sandbox_root: join(tempDir("pao-integration-sandbox-"), "sandbox"),
	});
	expect(verified.result.自动交付).toBe(true);
	const delivery = await deliverCard(cardsDir, execution.key.cardNo, { executionKey: execution.key });
	expect(delivery.交卷).toBe(true);
	return execution;
}

/**
 * 为第二次真实整合固定一张新卡的真实受控交付对象。
 *
 * 第一张卡已经完成“验收后交卷”，再改同一 attempt 的内容会被产品正确拒绝。
 * 本夹具只跳过重复验收沙箱，不跳过集成侧校验：仍有 attempt 基线、受控 ref、
 * 以基线 tree 为父 tree 的交付提交，以及当前真实内容 tree。
 */
async function controlledDeliveryChange(
	source: string,
	managed: string,
	worktreeId: string,
	branch: string,
	fileName: string,
	value: string,
	cardsDir: string,
	sourceHead: string,
	expectedBaselineTree?: string,
): Promise<Awaited<ReturnType<typeof bindExecutionContext>>> {
	const execution = await managedExecution({
		source,
		managed,
		worktreeId,
		branch,
		taskCardsDir: cardsDir,
		sourceHead,
	});
	const baseline = await snapshotClaimBaseline(cardsDir, execution.key.cardNo, {
		owner: "E",
		attempt: 1,
		execution,
		验收: loadCard(cardsDir, execution.key.cardNo).frontmatter.acceptance,
	});
	expect(baseline.可用).toBe(true);
	expect(baseline.内容Tree).toMatch(/^[a-f0-9]{40,64}$/);
	if (expectedBaselineTree) expect(baseline.内容Tree).toBe(expectedBaselineTree);

	writeFileSync(join(managed, fileName), value);
	const deliveryTree = (await captureContentTree(managed, undefined, true)).tree;
	const boundaryHead = git(managed, ["rev-parse", "HEAD"]);
	const boundary = git(managed, [
		"commit-tree",
		baseline.内容Tree!,
		"-p",
		boundaryHead,
		"-m",
		`PAO boundary attempt ${execution.key.attempt}`,
	]);
	const delivery = git(managed, ["commit-tree", deliveryTree, "-p", boundary, "-m", "PAO controlled delivery"]);
	git(managed, [
		"update-ref",
		`refs/pao-execution/delivery-baselines/card-${String(execution.key.cardNo).padStart(4, "0")}-attempt-1`,
		boundary,
	]);
	git(managed, [
		"update-ref",
		`refs/pao-execution/deliveries/card-${String(execution.key.cardNo).padStart(4, "0")}-attempt-1`,
		delivery,
	]);
	return execution;
}

describe("受管整合工作树接纳", () => {
	it("工具身份检查拒绝跨项目归属", () => {
		const owned = repo();
		const other = repo();
		expect(() =>
			checkIntegrationToolAuthority({
				sourceExecutionKey: { cardsDir: join(owned, ".pao", "卡"), cardNo: 1, attempt: 1 },
				targetExecutionKey: { cardsDir: join(other, ".pao", "卡"), cardNo: 2, attempt: 1 },
				sourceOwner: "E",
				targetStatus: "in_progress",
				context: { projectRoot: owned, operator: "E" },
			}),
		).toThrow(/跨归属/);
	});

	it("工具身份检查拒绝非源 owner，防止 raw cards_dir 冒领整合", () => {
		const owned = repo();
		expect(() =>
			checkIntegrationToolAuthority({
				sourceExecutionKey: { cardsDir: join(owned, ".pao", "卡"), cardNo: 1, attempt: 1 },
				targetExecutionKey: { cardsDir: join(owned, ".pao", "卡"), cardNo: 2, attempt: 1 },
				sourceOwner: "E",
				targetStatus: "in_progress",
				context: { projectRoot: owned, operator: "someone-else" },
			}),
		).toThrow(/当前 owner/);
	});

	it("同 requestId 只应用一次；缺少独立检查不声称集成通过", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const cardsDir = join(source, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: cardsDir,
		});
		const before = git(managed, ["rev-parse", "HEAD"]);
		const request = {
			requestId: "req-idempotent",
			sourceExecutionKey: sourceExecution.key,
			targetExecutionKey: targetExecution.key,
			expectedTargetHead: before,
			acquireWriteLock: writeLock,
		};

		const first = await integrateDelivery(request);
		const second = await integrateDelivery(request);
		// 新记录及无指纹的旧记录都要核对完整请求，不能只认 requestId。
		for (const legacy of [false, true]) {
			if (legacy) {
				const { requestFingerprint: _fingerprint, requestedChecks: _checks, ...oldRecord } = first;
				writeFileSync(integrationResultPath(cardsDir, request.requestId), JSON.stringify(oldRecord));
			}
			for (const changed of [
				{ sourceExecutionKey: { ...sourceExecution.key, attempt: 2 } },
				{ targetExecutionKey: { ...targetExecution.key, cardNo: 999 } },
				{ expectedTargetHead: "0".repeat(40) },
				{ checks: ["echo changed"] },
			]) {
				await expect(integrateDelivery({ ...request, ...changed })).rejects.toThrow(/不同完整请求参数/);
			}
		}
		await expect(
			integrateDelivery({
				...request,
				checks: ["git ls-files --error-unmatch base.txt"],
			}),
		).rejects.toThrow(/不同完整请求参数/);
		await expect(
			integrateDelivery({
				...request,
				expectedTargetHead: "0".repeat(40),
			}),
		).rejects.toThrow(/不同完整请求参数/);

		expect(first.status).toBe("applied");
		expect(first.integrationPassed).toBe(false);
		expect(second).toEqual(first);
		expect(git(managed, ["rev-list", "--count", "HEAD", `^${before}`])).toBe("1");
		expect(git(managed, ["rev-parse", "HEAD"])).toBe(first.target.resultHead);
	});

	it("第二次整合以目标当前真实内容三方合并，保留前次整合成果", async () => {
		const source = repo();
		const firstSourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", firstSourceManaged, "HEAD"]);
		const firstManaged = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", firstManaged, "HEAD"]);
		const firstSeed = git(firstSourceManaged, ["rev-parse", "HEAD"]);
		const firstSource = await controlledDeliveryChange(
			source,
			firstSourceManaged,
			"source-wt",
			"source-branch",
			"first.txt",
			"first\n",
			join(source, ".pao", "卡"),
			firstSeed,
		);
		const firstSourceTree = git(source, [
			"show",
			"-s",
			"--format=%T",
			"refs/pao-execution/deliveries/card-0001-attempt-1",
		]);
		const first = await integrateDelivery({
			requestId: "req-preserve-first",
			sourceExecutionKey: firstSource.key,
			targetExecutionKey: (
				await managedExecution({
					source,
					managed: firstManaged,
					worktreeId: "integration-target-first",
					branch: "target-branch",
					taskCardsDir: join(source, ".pao", "卡"),
					sourceHead: firstSeed,
				})
			).key,
			expectedTargetHead: git(firstManaged, ["rev-parse", "HEAD"]),
			checks: ["git ls-files --error-unmatch base.txt"],
			acquireWriteLock: writeLock,
		});
		expect(first.integrationPassed).toBe(true);
		const secondSource = await controlledDeliveryChange(
			source,
			firstSourceManaged,
			"source-wt-second",
			"source-branch",
			"second.txt",
			"second\n",
			firstSource.key.cardsDir,
			firstSeed,
			firstSourceTree,
		);
		// 目标也有第一笔整合之后独立提交的内容，第二次三方合并必须同时保留。
		writeFileSync(join(firstManaged, "target-only.txt"), "target-only\n");
		git(firstManaged, ["add", "-A"]);
		git(firstManaged, ["commit", "--no-gpg-sign", "-m", "target second input"]);
		const targetExecution = await managedExecution({
			source,
			managed: firstManaged,
			worktreeId: "integration-target-second",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "cards-target"),
			sourceHead: git(firstManaged, ["rev-parse", "HEAD"]),
		});
		const second = await integrateDelivery({
			requestId: "req-preserve-second",
			sourceExecutionKey: secondSource.key,
			targetExecutionKey: targetExecution.key,
			expectedTargetHead: git(firstManaged, ["rev-parse", "HEAD"]),
			checks: ["git ls-files --error-unmatch base.txt"],
			acquireWriteLock: writeLock,
		});
		expect(second.integrationPassed).toBe(true);
		expect(git(firstManaged, ["show", "HEAD:first.txt"])).toBe("first");
		expect(git(firstManaged, ["show", "HEAD:second.txt"])).toBe("second");
		expect(git(firstManaged, ["show", "HEAD:target-only.txt"])).toBe("target-only");
		preserveEvidence(second);
	}, 60000);

	it("整合目标在请求后外部变化时拒绝覆盖，保留原 HEAD 与现场记录", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "integration-cards"),
		});
		const expected = git(managed, ["rev-parse", "HEAD"]);
		writeFileSync(join(managed, "external.txt"), "external\n");
		git(managed, ["add", "-A"]);
		git(managed, ["commit", "--no-gpg-sign", "-m", "external"]);
		const changed = git(managed, ["rev-parse", "HEAD"]);

		await expect(
			integrateDelivery({
				requestId: "req-external",
				sourceExecutionKey: sourceExecution.key,
				targetExecutionKey: targetExecution.key,
				expectedTargetHead: expected,
				acquireWriteLock: writeLock,
			}),
		).rejects.toThrow(/外部修改/);

		expect(git(managed, ["rev-parse", "HEAD"])).toBe(changed);
		expect(existsSync(join(managed, "external.txt"))).toBe(true);
		const record = JSON.parse(
			readFileSync(integrationResultPath(sourceExecution.key.cardsDir, "req-external"), "utf8"),
		) as {
			status: string;
		};
		expect(record.status).toBe("failed");
	});

	it("目标已有 dirty/untracked 内容时拒绝覆盖且目标文件不变", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});
		writeFileSync(join(managed, "base.txt"), "target-dirty\n");
		writeFileSync(join(managed, "untracked.txt"), "keep\n");
		const before = git(managed, ["rev-parse", "HEAD"]);

		await expect(
			integrateDelivery({
				requestId: "req-dirty-target",
				sourceExecutionKey: sourceExecution.key,
				targetExecutionKey: targetExecution.key,
				expectedTargetHead: before,
				acquireWriteLock: writeLock,
			}),
		).rejects.toThrow(/未提交或未跟踪/);
		expect(readFileSync(join(managed, "base.txt"), "utf8")).toBe("target-dirty\n");
		expect(readFileSync(join(managed, "untracked.txt"), "utf8")).toBe("keep\n");
		expect(git(managed, ["rev-parse", "HEAD"])).toBe(before);
	});

	it("merge 计算后写入窗口出现外部 dirty/untracked 时拒绝覆盖并保留现场", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});
		const before = git(managed, ["rev-parse", "HEAD"]);

		await expect(
			integrateDelivery({
				requestId: "req-write-window-race",
				sourceExecutionKey: sourceExecution.key,
				targetExecutionKey: targetExecution.key,
				expectedTargetHead: before,
				acquireWriteLock: writeLock,
				beforeTargetWrite: () => {
					writeFileSync(join(managed, "base.txt"), "external-dirty\n");
					writeFileSync(join(managed, "external-untracked.txt"), "external-untracked\n");
				},
			}),
		).rejects.toThrow(/未提交或未跟踪内容|写入窗口发生变化/);

		expect(git(managed, ["rev-parse", "HEAD"])).toBe(before);
		expect(readFileSync(join(managed, "base.txt"), "utf8")).toBe("external-dirty\n");
		expect(readFileSync(join(managed, "external-untracked.txt"), "utf8")).toBe("external-untracked\n");
	});

	it.each(["dirty", "untracked"])("写前复核后出现 %s，Git 受保护更新仍拒绝覆盖", async (kind) => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const file = kind === "dirty" ? "base.txt" : "new.txt";
		const sourceExecution = await controlledDeliveryChange(
			source,
			sourceManaged,
			"source-wt",
			"source-branch",
			file,
			"worker\n",
			join(source, ".pao", "卡"),
			git(source, ["rev-parse", "HEAD"]),
		);
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "target-wt",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "target-cards"),
		});
		const head = git(managed, ["rev-parse", "HEAD"]);
		const indexTree = git(managed, ["write-tree"]);
		const actualRun = cardProcess.runCardProcess;
		let injected = false;
		vi.spyOn(cardProcess, "runCardProcess").mockImplementation((cmd, args, ...rest) => {
			if (cmd === "git" && args.includes("read-tree") && args.includes("-m") && args.includes("-u")) {
				injected = true;
				writeFileSync(join(managed, file), "external\n");
			}
			return actualRun(cmd, args, ...rest);
		});
		await expect(
			integrateDelivery({
				requestId: `req-git-window-${kind}`,
				sourceExecutionKey: sourceExecution.key,
				targetExecutionKey: targetExecution.key,
				expectedTargetHead: head,
				acquireWriteLock: writeLock,
			}),
		).rejects.toThrow(/受保护更新整合工作树失败/);
		expect(injected).toBe(true);
		expect(readFileSync(join(managed, file), "utf8")).toBe("external\n");
		expect(git(managed, ["rev-parse", "HEAD"])).toBe(head);
		expect(git(managed, ["write-tree"])).toBe(indexTree);
	});

	it("目标已有真实执行锁和日志时只排除 .pao，内容快照不污染主目录", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});
		const commonGitDir = git(managed, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const sourceCommonGitDir = git(sourceManaged, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const sourceStatusBefore = git(sourceManaged, ["status", "--porcelain=v1", "-uall"]);
		const targetStatusBefore = git(managed, ["status", "--porcelain=v1", "-uall"]);
		assertNoTemporaryIndexes(commonGitDir);
		assertNoTemporaryIndexes(sourceCommonGitDir);

		mkdirSync(join(managed, ".pao", "locks"), { recursive: true });
		mkdirSync(join(managed, ".pao", "logs"), { recursive: true });
		writeFileSync(join(managed, ".pao", "locks", "execution.lock"), "owner=E\n");
		writeFileSync(join(managed, ".pao", "logs", "worker.log"), "worker output\n");
		const before = git(managed, ["rev-parse", "HEAD"]);
		const result = await integrateDelivery({
			requestId: "req-system-state-excluded",
			sourceExecutionKey: sourceExecution.key,
			targetExecutionKey: targetExecution.key,
			expectedTargetHead: before,
			checks: ["git ls-files --error-unmatch base.txt"],
			acquireWriteLock: writeLock,
		});

		expect(result.integrationPassed).toBe(true);
		expect(git(managed, ["ls-tree", "-r", "--name-only", "HEAD"]).split(/\r?\n/)).not.toContain(
			".pao/locks/execution.lock",
		);
		expect(git(managed, ["ls-tree", "-r", "--name-only", "HEAD"]).split(/\r?\n/)).not.toContain(
			".pao/logs/worker.log",
		);
		expect(readFileSync(join(managed, ".pao", "locks", "execution.lock"), "utf8")).toBe("owner=E\n");
		expect(readFileSync(join(managed, ".pao", "logs", "worker.log"), "utf8")).toBe("worker output\n");
		const expectedTargetStatus = [targetStatusBefore, "?? .pao/locks/execution.lock", "?? .pao/logs/worker.log"]
			.filter(Boolean)
			.sort()
			.join("\n");
		expect(git(managed, ["status", "--porcelain=v1", "-uall"]).split(/\r?\n/).filter(Boolean).sort().join("\n")).toBe(
			expectedTargetStatus,
		);
		expect(git(sourceManaged, ["status", "--porcelain=v1", "-uall"])).toBe(sourceStatusBefore);
		assertNoTemporaryIndexes(commonGitDir);
		assertNoTemporaryIndexes(sourceCommonGitDir);
	}, 45000);

	it("文本冲突保留记录和冲突文件，不自动选择 ours/theirs", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "source\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});
		// 目标分支独立修改同一行，制造真实三路文本冲突。
		writeFileSync(join(managed, "base.txt"), "target\n");
		git(managed, ["add", "-A"]);
		git(managed, ["commit", "--no-gpg-sign", "-m", "target"]);
		const head = git(managed, ["rev-parse", "HEAD"]);

		await expect(
			integrateDelivery({
				requestId: "req-conflict",
				sourceExecutionKey: sourceExecution.key,
				targetExecutionKey: targetExecution.key,
				expectedTargetHead: head,
				acquireWriteLock: writeLock,
			}),
		).rejects.toThrow(/冲突/);

		const record = JSON.parse(
			readFileSync(integrationResultPath(sourceExecution.key.cardsDir, "req-conflict"), "utf8"),
		) as {
			status: string;
			conflictFiles: string[];
		};
		expect(record.status).toBe("conflicted");
		expect(record.conflictFiles).toContain("base.txt");
		expect(git(managed, ["show", "HEAD:base.txt"])).toBe("target");
	});

	it("集成检查期间修改代码时，检查结果失效且不通过", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});
		const check =
			process.platform === "win32"
				? "echo changed>base.txt && git -C . ls-files --error-unmatch base.txt >nul"
				: "printf 'changed\\n' > base.txt";

		const result = await integrateDelivery({
			requestId: "req-check-mutated",
			sourceExecutionKey: sourceExecution.key,
			targetExecutionKey: targetExecution.key,
			expectedTargetHead: git(managed, ["rev-parse", "HEAD"]),
			checks: [check],
			acquireWriteLock: writeLock,
		});
		expect(result.status).toBe("check_failed");
		expect(result.integrationPassed).toBe(false);
		expect(result.message).toMatch(/检查后代码内容发生变化/);
		preserveEvidence(result);
	});

	it("独立集成检查失败时状态为 check_failed，不能继承源卡局部 pass", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});

		let releases = 0;
		const result = await integrateDelivery({
			requestId: "req-check-failed",
			sourceExecutionKey: sourceExecution.key,
			targetExecutionKey: targetExecution.key,
			expectedTargetHead: git(managed, ["rev-parse", "HEAD"]),
			checks: [process.platform === "win32" ? "exit /b 7" : "exit 7"],
			acquireWriteLock: async () => ({
				release: async () => {
					releases++;
				},
			}),
		});

		expect(result.status).toBe("check_failed");
		expect(result.integrationPassed).toBe(false);
		expect(result.checks[0]?.passed).toBe(false);
		expect(releases).toBe(1);
		preserveEvidence(result);
	});

	it("集成检查输出超过预览上限时保留完整日志、摘要和截断标记", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		writeFileSync(
			join(managed, "emit-long-output.mjs"),
			"process.stdout.write('x'.repeat(12000)); process.stderr.write('stderr-tail');\n",
		);
		git(managed, ["add", "emit-long-output.mjs"]);
		git(managed, ["commit", "--no-gpg-sign", "-m", "add output check"]);
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});
		const check = "node emit-long-output.mjs";

		const request = {
			requestId: "req-check-full-output",
			sourceExecutionKey: sourceExecution.key,
			targetExecutionKey: targetExecution.key,
			expectedTargetHead: git(managed, ["rev-parse", "HEAD"]),
			checks: [check],
			acquireWriteLock: writeLock,
		};
		const result = await integrateDelivery(request);
		const record = result.checks[0]!;
		expect(record.outputPath).toMatch(/req-check-full-output-checks[\\/]check-001\.log$/);
		expect(record.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		const fullLog = readFileSync(record.outputPath, "utf8");
		expect(fullLog.length).toBeGreaterThan(12000);
		expect(fullLog).toContain("$ ");
		expect(fullLog).toContain("--- stdout ---");
		expect(fullLog).toContain("--- stderr ---");
		expect(fullLog).toContain("x".repeat(12000));
		expect(fullLog).toContain("stderr-tail");
		expect(record.outputTruncated).toBe(fullLog.length > record.stdout.length + record.stderr.length);
		expect(result.integrationPassed).toBe(true);
		preserveEvidence(result);
		const { requestFingerprint: _fingerprint, requestedChecks: _checks, ...legacy } = result;
		writeFileSync(integrationResultPath(sourceExecution.key.cardsDir, request.requestId), JSON.stringify(legacy));
		const replay = await integrateDelivery({ ...request, checks: [`  ${check}  `, "   "] });
		expect(replay.target.resultHead).toBe(result.target.resultHead);
		await expect(integrateDelivery({ ...request, checks: ["echo changed"] })).rejects.toThrow(/不同完整请求参数/);
	});

	it.each([true, false])(
		"输出超限且有真实长活后代：树杀确认=%s，未确认时保锁",
		async (confirmed) => {
			const source = repo();
			const managed = tempDir("pao-integration-target-");
			git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
			const sourceManaged = tempDir("pao-integration-source-");
			git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
			const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
			mkdirSync(join(managed, ".pao"), { recursive: true });
			writeFileSync(
				join(managed, "emit-over-limit.mjs"),
				"import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; " +
					"const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); " +
					"writeFileSync('.pao/overflow-pids.json',JSON.stringify([process.pid,child.pid])); " +
					"process.stdout.write('x'.repeat(17*1024*1024));setInterval(()=>{},1000);\n",
			);
			git(managed, ["add", "emit-over-limit.mjs"]);
			git(managed, ["commit", "--no-gpg-sign", "-m", "add oversized output check"]);
			const targetExecution = await managedExecution({
				source,
				managed,
				worktreeId: "integration-target",
				branch: "target-branch",
				taskCardsDir: join(source, ".pao", "卡"),
			});

			let releases = 0;
			const requestId = `req-check-over-limit-${confirmed ? "confirmed" : "unknown"}`;
			if (!confirmed) killTreeMock.mockRejectedValue(new Error("模拟：超限后整树停止未确认"));
			await withTestCleanup(
				async () => {
					const operation = integrateDelivery({
						requestId,
						sourceExecutionKey: sourceExecution.key,
						targetExecutionKey: targetExecution.key,
						expectedTargetHead: git(managed, ["rev-parse", "HEAD"]),
						checks: ["node emit-over-limit.mjs"],
						acquireWriteLock: async () => ({
							release: async () => {
								releases++;
							},
						}),
					});
					if (!confirmed) {
						await expect(operation).rejects.toBeInstanceOf(cardProcess.CardProcessStopUnconfirmedError);
						expect(releases).toBe(0);
						const pids = JSON.parse(readFileSync(join(managed, ".pao/overflow-pids.json"), "utf8")) as number[];
						expect(() => process.kill(pids[1]!, 0)).not.toThrow();
						const failed = JSON.parse(
							readFileSync(integrationResultPath(sourceExecution.key.cardsDir, requestId), "utf8"),
						) as IntegrationRecord;
						expect(failed.integrationPassed).toBe(false);
						expect(failed.message).toContain("日志不完整");
						expect(failed.message).toContain("停止未确认");
						preserveEvidence(failed);
						return;
					}
					const result = await operation;
					expect(releases).toBe(1);
					const pids = JSON.parse(readFileSync(join(managed, ".pao/overflow-pids.json"), "utf8")) as number[];
					for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
					const record = result.checks[0]!;
					expect(record.outputIncomplete).toBe(true);
					expect(record.outputLimitBytes).toBe(16 * 1024 * 1024);
					expect(record.stderr).toContain("日志不完整");
					expect(readFileSync(record.outputPath, "utf8")).toContain("日志不完整");
					expect(record.reason).toContain("日志不完整");
					expect(result.status).toBe("check_failed");
					expect(result.integrationPassed).toBe(false);
					expect(record.passed).toBe(false);
					preserveEvidence(result);
				},
				async () => {
					const file = join(managed, ".pao/overflow-pids.json");
					if (existsSync(file)) {
						const owned = JSON.parse(readFileSync(file, "utf8")) as number[];
						for (const pid of owned.reverse()) {
							try {
								process.kill(pid);
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
							}
						}
					}
				},
			);
		},
		40000,
	);

	it("检查子进程树杀失败时保留整合锁；普通失败与确认取消释放", async () => {
		const source = repo();
		const managed = tempDir("pao-integration-target-");
		git(source, ["worktree", "add", "-b", "target-branch", managed, "HEAD"]);
		const sourceManaged = tempDir("pao-integration-source-");
		git(source, ["worktree", "add", "-b", "source-branch", sourceManaged, "HEAD"]);
		const sourceExecution = await delivered(source, sourceManaged, "source-wt", "source-branch", "worker\n");
		const targetExecution = await managedExecution({
			source,
			managed,
			worktreeId: "integration-target",
			branch: "target-branch",
			taskCardsDir: join(source, ".pao", "卡"),
		});
		let releases = 0;
		const lock = () =>
			Promise.resolve({
				release: async () => {
					releases++;
				},
			});
		mkdirSync(join(managed, ".pao"), { recursive: true });
		for (const confirmed of [false, true]) {
			const controller = new AbortController();
			const name = confirmed ? "confirmed" : "unknown";
			const ready = join(managed, ".pao", `${name}.pid`);
			const script = `.pao/hang-${name}.mjs`;
			writeFileSync(
				join(managed, script),
				`import {writeFileSync} from 'node:fs'; writeFileSync('.pao/${name}.pid', String(process.pid)); setTimeout(()=>{},3000);\n`,
			);
			expect(existsSync(ready)).toBe(false);
			killTreeMock.mockImplementation(async () => {
				if (!confirmed) throw new Error("模拟：树杀未确认");
				// 本检查只创建一个无后代的 Node 子进程，实际结束后再确认取消。
				const pid = Number(readFileSync(ready, "utf8"));
				process.kill(pid);
				const deadline = Date.now() + 3000;
				for (;;) {
					try {
						process.kill(pid, 0);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
						throw error;
					}
					if (Date.now() > deadline) throw new Error("检查进程未停止");
					await delay(20);
				}
				return "测试：已停止无后代的检查进程";
			});
			const operation = integrateDelivery({
				requestId: `req-check-stop-${confirmed ? "confirmed" : "unknown"}`,
				sourceExecutionKey: sourceExecution.key,
				targetExecutionKey: targetExecution.key,
				expectedTargetHead: git(managed, ["rev-parse", "HEAD"]),
				checks: [`node ${script}`],
				acquireWriteLock: lock,
				signal: controller.signal,
			}).then(
				() => null,
				(error: unknown) => error,
			);
			await withTestCleanup(
				async () => {
					const deadline = Date.now() + 25000;
					while (!existsSync(ready)) {
						if (Date.now() > deadline) throw new Error("检查进程未就绪");
						await delay(25);
					}
					controller.abort();
					const error = await operation;
					expect(error).toMatchObject({ name: "AbortError" });
					if (!confirmed) expect(String(error)).toContain("停止未确认");
					expect(releases).toBe(confirmed ? 1 : 0);
					preserveEvidence(
						JSON.parse(
							readFileSync(
								integrationResultPath(sourceExecution.key.cardsDir, `req-check-stop-${name}`),
								"utf8",
							),
						) as IntegrationRecord,
					);
				},
				async () => {
					controller.abort();
					await operation;
					// 仅结束本用例刚创建且仍存在的检查进程；无派生进程，退出后不再碰 PID。
					if (existsSync(ready)) {
						const pid = Number(readFileSync(ready, "utf8"));
						try {
							process.kill(pid);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
						}
					}
				},
			);
		}
	}, 60000);
});
