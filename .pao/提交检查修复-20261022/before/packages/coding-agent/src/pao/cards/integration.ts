import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { pathKey } from "../shared/path-key.ts";
import { type BaselineDiff, baselineSnapshotPath, captureContentTree, diffAgainstBaseline } from "./baseline.ts";
import { loadCard, projectRootForCards } from "./cardfile.ts";
import { formatCardNumber } from "./counter.ts";
import { PaoCardError } from "./errors.ts";
import { type ExecutionKey, type ResolvedExecutionContext, resolveExecutionContext } from "./execution-context.ts";
import { CardProcessStopUnconfirmedError, runCardProcess } from "./process.ts";
import type { ParsedCard } from "./types.ts";

/**
 * 受管整合工作树的最小接纳入口。
 *
 * 规则只消费统一的 attempt 关联和受控交付对象：
 * - 源代码范围是「认领基线 tree → 交付 tree」，不是调用者任意给出的提交；
 * - 目标在动作前后必须是同一个 HEAD/tree，否则视为外部变化并拒绝覆盖；
 * - 先把结果做成 Git tree object，再在受管整合工作树逐项更新 index 并提交；
 * - 文本冲突保留整合工作树与冲突文件，不自动选择 ours/theirs；
 * - 集成检查独立执行，源卡局部通过只作为前置，不能直接变成集成通过。
 */

export interface IntegrationCheck {
	readonly command: string;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly passed: boolean;
	/** 记录中只保留首尾预览；true 表示该命令输出有截断。 */
	readonly outputTruncated: boolean;
	/** 完整输出落盘路径；输出未超过预览上限时也保留可追溯文件。 */
	readonly outputPath: string;
	/** 完整 stdout+stderr 的 sha256 摘要，供身份回查与完整性核对。 */
	readonly outputDigest: string;
	/** 采集器是否因 16 MiB 上限丢失输出；true 时 outputPath 只含已采集部分，不是完整日志。 */
	readonly outputIncomplete?: boolean;
	readonly outputLimitBytes?: number;
	readonly reason?: string;
}

/** 宿主注入的真实执行根写锁；cards 不自行创建锁文件。 */
export interface IntegrationWriteLock {
	release(): Promise<void>;
}

export type AcquireIntegrationWriteLock = (input: {
	readonly executionRoot: string;
	readonly holder: string;
	readonly signal?: AbortSignal;
}) => Promise<IntegrationWriteLock>;

export interface IntegrationRequest {
	readonly requestId: string;
	readonly sourceExecutionKey: ExecutionKey;
	/** 已绑定 Pauli WorktreeBinding 的真实受管整合工作树 attempt。 */
	readonly targetExecutionKey: ExecutionKey;
	/** 显式目标现有提交；必须等于工作树当前 HEAD。 */
	readonly expectedTargetHead: string;
	/** 可选集成检查命令，在工作树成功后独立执行。 */
	readonly checks?: readonly string[];
	/** 由 Dirac/宿主提供的同一把执行写锁。 */
	readonly acquireWriteLock?: AcquireIntegrationWriteLock;
	/** 测试/宿主故障注入：在计算 merge 后、受保护写树前调用；返回后入口必须重新核对真实内容。 */
	readonly beforeTargetWrite?: () => void | Promise<void>;
	readonly signal?: AbortSignal;
}

export interface IntegrationRecord {
	readonly schemaVersion: 1;
	readonly requestId: string;
	/** 完整请求身份（源/目标 key、目标 HEAD、规范化检查命令）；同 ID 必须逐项相同才可回查。 */
	readonly requestFingerprint?: string;
	readonly source: {
		readonly cardsDir: string;
		readonly cardNo: number;
		readonly attempt: number;
		readonly bindingDigest: string;
		readonly snapshotDigest: string;
		readonly baselineTree: string;
		readonly deliveryTree: string;
		readonly deliveryCommit: string;
	};
	readonly target: {
		readonly cardsDir: string;
		readonly cardNo: number;
		readonly attempt: number;
		readonly projectRoot: string;
		readonly executionRoot: string;
		readonly repositoryRoot: string;
		readonly bindingDigest: string;
		readonly worktreeBindingDigest: string;
		readonly baseHead: string;
		readonly baseTree: string;
		readonly beforeContentTree: string;
		readonly beforeContentDigest: string;
		readonly resultHead?: string;
		readonly resultTree?: string;
		readonly resultContentTree?: string;
	};
	readonly status: "integrating" | "conflicted" | "applied" | "check_failed" | "failed";
	readonly conflictFiles: readonly string[];
	/** 调用时请求的原始检查命令；checks 是执行后带输出预览的结果，不能替代请求身份。 */
	readonly requestedChecks?: readonly string[];
	readonly checks: readonly IntegrationCheck[];
	readonly checksContentTree?: string;
	readonly checksContentDigest?: string;
	readonly externalChanges: readonly string[];
	readonly integrationPassed: boolean;
	readonly message: string;
	readonly startedAt: string;
	readonly finishedAt?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/i;
const REF_PREFIX = "refs/pao-execution/integrations";
const DELIVERY_REF_PREFIX = "refs/pao-execution/deliveries";
const CHECK_OUTPUT_HEAD = 5000;
const CHECK_OUTPUT_TAIL = 3000;

function samePath(left: string, right: string): boolean {
	return (
		pathKey(left.replace(/\\/g, "/")).replace(/\/+$/, "") === pathKey(right.replace(/\\/g, "/")).replace(/\/+$/, "")
	);
}

function absolutePath(value: string, field: string): string {
	if (!value.trim() || !isAbsolute(value)) {
		throw new PaoCardError("INVALID_CARD", `${field} 必须是绝对路径`, { [field]: value });
	}
	return normalize(resolve(value));
}

function gitResult(args: string[], cwd: string, signal?: AbortSignal) {
	return runCardProcess(
		"git",
		[
			"-c",
			"core.quotepath=off",
			"-c",
			"core.autocrlf=false",
			"-c",
			"user.name=pao",
			"-c",
			"user.email=pao@local",
			...args,
		],
		cwd,
		60000,
		undefined,
		signal,
	);
}

async function git(args: string[], cwd: string, signal?: AbortSignal, label = "Git 操作"): Promise<string> {
	const result = await gitResult(args, cwd, signal);
	if (result.code !== 0) {
		throw new PaoCardError("INVALID_CARD", `${label}失败：${result.stderr.slice(0, 500)}`, {
			exitCode: result.code,
			stderr: result.stderr.slice(0, 500),
			args,
		});
	}
	return result.stdout.trim();
}

export function integrationResultPath(cardsDir: string, requestId: string): string {
	if (!REQUEST_ID_PATTERN.test(requestId)) {
		throw new PaoCardError("INVALID_CARD", "整合 requestId 格式无效", { requestId });
	}
	return join(dirname(absolutePath(cardsDir, "cardsDir")), "integration-results", `${requestId}.json`);
}

export function integrationRef(requestId: string): string {
	if (!REQUEST_ID_PATTERN.test(requestId)) {
		throw new PaoCardError("INVALID_CARD", "整合 requestId 格式无效", { requestId });
	}
	return `${REF_PREFIX}/${requestId}`;
}

function validateRecord(raw: unknown): IntegrationRecord {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new PaoCardError("INVALID_CARD", "整合结果不是对象");
	}
	const record = raw as IntegrationRecord;
	if (record.schemaVersion !== 1 || !REQUEST_ID_PATTERN.test(record.requestId)) {
		throw new PaoCardError("INVALID_CARD", "整合结果身份无效", { record });
	}
	if (!["integrating", "conflicted", "applied", "check_failed", "failed"].includes(record.status)) {
		throw new PaoCardError("INVALID_CARD", "整合结果状态无效", { status: record.status });
	}
	return record;
}

function readRecord(path: string): IntegrationRecord | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return validateRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if (error instanceof PaoCardError) throw error;
		throw new PaoCardError("INVALID_CARD", "整合结果文件不是合法 JSON", {
			path,
			cause: error instanceof Error ? error.message : String(error),
		});
	}
}

function sourceIdentity(execution: ResolvedExecutionContext) {
	return {
		cardsDir: execution.key.cardsDir,
		cardNo: execution.key.cardNo,
		attempt: execution.key.attempt,
		bindingDigest: execution.bindingDigest,
		snapshotDigest: execution.snapshotDigest,
	};
}

function targetIdentity(execution: ResolvedExecutionContext, baseHead: string, baseTree: string) {
	return {
		cardsDir: execution.key.cardsDir,
		cardNo: execution.key.cardNo,
		attempt: execution.key.attempt,
		projectRoot: execution.projectRoot,
		executionRoot: execution.canonicalExecutionRoot,
		repositoryRoot: execution.repositoryRoot,
		bindingDigest: execution.bindingDigest,
		worktreeBindingDigest: execution.worktree.bindingDigest,
		baseHead,
		baseTree,
	};
}

function sameSource(left: IntegrationRecord["source"], right: IntegrationRecord["source"]): boolean {
	return (
		samePath(left.cardsDir, right.cardsDir) &&
		left.cardNo === right.cardNo &&
		left.attempt === right.attempt &&
		left.bindingDigest === right.bindingDigest &&
		left.snapshotDigest === right.snapshotDigest
	);
}

function sameTarget(left: IntegrationRecord["target"], right: IntegrationRecord["target"]): boolean {
	return (
		samePath(left.projectRoot, right.projectRoot) &&
		samePath(left.executionRoot, right.executionRoot) &&
		samePath(left.repositoryRoot, right.repositoryRoot) &&
		left.bindingDigest === right.bindingDigest &&
		left.worktreeBindingDigest === right.worktreeBindingDigest &&
		left.baseHead === right.baseHead &&
		left.baseTree === right.baseTree
	);
}

function normalizedChecks(checks: readonly string[] | undefined): string[] {
	return (checks ?? []).map((command) => command.trim()).filter(Boolean);
}

function requestFingerprint(request: IntegrationRequest): string {
	return digest(
		JSON.stringify({
			sourceExecutionKey: {
				cardsDir: pathKey(request.sourceExecutionKey.cardsDir.replace(/\\/g, "/")).replace(/\/+$/, ""),
				cardNo: request.sourceExecutionKey.cardNo,
				attempt: request.sourceExecutionKey.attempt,
			},
			targetExecutionKey: {
				cardsDir: pathKey(request.targetExecutionKey.cardsDir.replace(/\\/g, "/")).replace(/\/+$/, ""),
				cardNo: request.targetExecutionKey.cardNo,
				attempt: request.targetExecutionKey.attempt,
			},
			expectedTargetHead: request.expectedTargetHead.trim(),
			checks: normalizedChecks(request.checks),
		}),
	);
}

/** 旧版/中断记录没有指纹时，按已持久化的同一组身份字段补算，便于升级后回查。 */
function persistedRequestFingerprint(record: IntegrationRecord): string {
	return requestFingerprint({
		requestId: record.requestId,
		sourceExecutionKey: {
			cardsDir: record.source.cardsDir,
			cardNo: record.source.cardNo,
			attempt: record.source.attempt,
		},
		targetExecutionKey: {
			cardsDir: record.target.cardsDir,
			cardNo: record.target.cardNo,
			attempt: record.target.attempt,
		},
		expectedTargetHead: record.target.baseHead,
		checks: record.requestedChecks ?? record.checks.map((check) => check.command),
	});
}

interface ContentSnapshot {
	readonly head: string;
	readonly headTree: string;
	readonly contentTree: string;
	readonly contentDigest: string;
	readonly status: readonly { readonly 状态: string; readonly 文件: string }[];
}

/** 读取提交和真实内容 tree；内容范围、临时 index 位置与基线共用 baseline 实现。 */
async function captureContentSnapshot(root: string, signal?: AbortSignal): Promise<ContentSnapshot> {
	const [headRefs, initialCaptured] = await Promise.all([
		git(["rev-parse", "HEAD", "HEAD^{tree}"], root, signal, "读取整合目标 HEAD/tree"),
		captureContentTree(root, signal, true, false),
	]);
	const [head, headTree] = headRefs.split(/\r?\n/);
	const captured = await captureContentTree(root, signal, true, false);
	if (
		head !== captured.head ||
		captured.head !== initialCaptured.head ||
		captured.tree !== initialCaptured.tree ||
		JSON.stringify(captured.status) !== JSON.stringify(initialCaptured.status)
	) {
		throw new PaoCardError("INVALID_CARD", "整合目标内容在快照期间发生变化，拒绝使用不稳定证据");
	}
	const contentTree = captured.tree;
	const status = captured.status;
	if (!OBJECT_ID_PATTERN.test(head) || !OBJECT_ID_PATTERN.test(headTree) || !OBJECT_ID_PATTERN.test(contentTree)) {
		throw new PaoCardError("INVALID_CARD", "整合目标 HEAD/tree 不是 Git 对象", { head, headTree, contentTree });
	}
	return {
		head,
		headTree,
		contentTree,
		contentDigest: digest(JSON.stringify({ head, headTree, contentTree, status: captured.status })),
		status: captured.status,
	};
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function assertCleanTarget(status: ContentSnapshot["status"]): void {
	if (status.length === 0) return;
	throw new PaoCardError("INVALID_CARD", "整合目标存在未提交或未跟踪内容，拒绝覆盖", {
		externalChanges: status.map((entry) => `${entry.状态} ${entry.文件}`),
	});
}

function deliveryCommitFromBaselineDiff(diff: BaselineDiff): string {
	if (!diff.基线可用 || !diff.基线Tree || !diff.当前Tree) {
		throw new PaoCardError("INVALID_CARD", `源卡缺少可核对的内容交付证据：${diff.汇总}`);
	}
	return diff.当前Tree;
}

async function assertDeliveryObject(
	execution: ResolvedExecutionContext,
	baselineTree: string,
	deliveryTree: string,
	signal?: AbortSignal,
): Promise<string> {
	const ref = `${DELIVERY_REF_PREFIX}/card-${String(execution.key.cardNo).padStart(4, "0")}-attempt-${execution.key.attempt}`;
	const commit = await git(
		["rev-parse", "--verify", `${ref}^{commit}`],
		execution.repositoryRoot,
		signal,
		"读取受控交付对象",
	);
	const tree = await git(["show", "-s", "--format=%T", commit], execution.repositoryRoot, signal, "读取受控交付 tree");
	const parent = await git(
		["show", "-s", "--format=%P", commit],
		execution.repositoryRoot,
		signal,
		"读取受控交付父对象",
	);
	if (tree !== deliveryTree) {
		throw new PaoCardError("INVALID_CARD", "受控交付对象 tree 与当前验收内容不一致", {
			expected: deliveryTree,
			actual: tree,
		});
	}
	if (!parent) throw new PaoCardError("INVALID_CARD", "受控交付对象缺少输入边界父对象");
	const parentTree = await git(
		["show", "-s", "--format=%T", parent.split(/\s+/)[0]!],
		execution.repositoryRoot,
		signal,
		"读取交付边界 tree",
	);
	if (parentTree !== baselineTree) {
		throw new PaoCardError("INVALID_CARD", "受控交付对象的输入边界与认领基线不一致", {
			baselineTree,
			boundaryTree: parentTree,
		});
	}
	return commit;
}

async function applyDeliveryToTarget(
	request: IntegrationRequest,
	baselineTree: string,
	deliveryTree: string,
	target: ResolvedExecutionContext,
	before: ContentSnapshot,
	signal?: AbortSignal,
): Promise<{ head: string; tree: string; snapshot: ContentSnapshot; conflictFiles: readonly string[] }> {
	const root = target.canonicalExecutionRoot;
	assertCleanTarget(before.status);
	if (before.head !== request.expectedTargetHead) {
		throw new PaoCardError("INVALID_CARD", "整合目标 HEAD 已被外部修改，拒绝覆盖", {
			expected: request.expectedTargetHead,
			actual: before.head,
		});
	}
	// before 是取得执行写锁后立即捕获的稳定快照；计算完 merge 后仍会再次复核。
	for (const tree of [baselineTree, deliveryTree, before.contentTree]) {
		const object = await gitResult(["cat-file", "-e", `${tree}^{tree}`], root, signal);
		if (object.code !== 0) {
			throw new PaoCardError("INVALID_CARD", "整合仓库中找不到三方合并所需 tree", { tree });
		}
	}
	const mergeTree = await gitResult(
		[
			"merge-tree",
			"--write-tree",
			"--name-only",
			"--no-messages",
			"--allow-unrelated-histories",
			`--merge-base=${baselineTree}`,
			before.contentTree,
			deliveryTree,
		],
		root,
		signal,
	);
	const mergeOutput = mergeTree.stdout.trim().split(/\r?\n/).filter(Boolean);
	if (mergeTree.code === 1) {
		const conflicts = mergeOutput.filter((line) => !OBJECT_ID_PATTERN.test(line));
		throw new PaoCardError(
			"INVALID_CARD",
			`源交付与整合目标产生文本冲突，目标现场未变，冲突路径：${conflicts.join("、") || "Git 未返回文件清单"}`,
			{ conflictFiles: conflicts },
		);
	}
	if (mergeTree.code !== 0) {
		throw new PaoCardError("INVALID_CARD", `计算整合 tree 失败：${mergeTree.stderr.slice(0, 300)}`);
	}
	const resultTree = mergeOutput.find((line) => OBJECT_ID_PATTERN.test(line)) ?? "";
	if (!OBJECT_ID_PATTERN.test(resultTree)) {
		throw new PaoCardError("INVALID_CARD", "merge 未返回有效 tree", { stdout: mergeTree.stdout });
	}
	const resultCommit = await git(
		["commit-tree", resultTree, "-p", before.head, "-m", `PAO integration ${request.requestId}`],
		root,
		signal,
		"创建整合提交",
	);
	// 只更新受管整合工作树的分支，不写调用者主目录。
	const branch = target.worktree.kind === "managed" ? target.worktree.branchName : "";
	if (!branch) throw new PaoCardError("INVALID_CARD", "整合目标必须是受管工作树");
	await request.beforeTargetWrite?.();
	const writeBefore = await captureContentSnapshot(root, signal);
	assertCleanTarget(writeBefore.status);
	if (writeBefore.head !== before.head || writeBefore.contentDigest !== before.contentDigest) {
		throw new PaoCardError("INVALID_CARD", "整合目标在写入窗口发生变化，拒绝覆盖", {
			expectedHead: before.head,
			actualHead: writeBefore.head,
			expectedDigest: before.contentDigest,
			actualDigest: writeBefore.contentDigest,
		});
	}
	// 双 tree 更新让 Git 在持有 index 锁时再次拒绝会被覆盖的外部编辑或未跟踪文件。
	await git(["read-tree", "-m", "-u", before.headTree, resultTree], root, signal, "受保护更新整合工作树");
	const stagedTree = await git(["write-tree"], root, signal, "核对整合工作树 index");
	if (stagedTree !== resultTree) {
		throw new PaoCardError("INVALID_CARD", "整合工作树 index 未与结果 tree 对齐，拒绝移动分支", {
			expectedTree: resultTree,
			actualTree: stagedTree,
		});
	}
	await git(["update-ref", `refs/heads/${branch}`, resultCommit, before.head], root, signal, "更新整合工作树分支");
	const after = await captureContentSnapshot(root, signal);
	if (after.head !== resultCommit || after.headTree !== resultTree || after.contentTree !== resultTree) {
		throw new PaoCardError("INVALID_CARD", "整合工作树提交后未能与记录 tree 对齐", {
			expectedHead: resultCommit,
			expectedTree: resultTree,
			actual: after,
		});
	}
	return { head: resultCommit, tree: resultTree, snapshot: after, conflictFiles: [] };
}

async function runChecks(
	root: string,
	checks: readonly string[],
	outputDir: string,
	signal?: AbortSignal,
): Promise<IntegrationCheck[]> {
	const results: IntegrationCheck[] = [];
	for (const [index, command] of checks.entries()) {
		const trimmed = command.trim();
		if (!trimmed) continue;
		const result = await runCardProcess(
			process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
			process.platform === "win32" ? ["/d", "/s", "/c", trimmed] : ["-c", trimmed],
			root,
			120000,
			undefined,
			signal,
		);
		const stdout = previewOutput(result.stdout);
		const stderr = previewOutput(result.stderr);
		const output = [
			`$ ${trimmed}`,
			`exitCode: ${result.code ?? "(null)"}`,
			...(result.outputTruncated ? ["日志不完整：输出超过采集上限，不能作为通过证据"] : []),
			"--- stdout ---",
			result.stdout,
			"--- stderr ---",
			result.stderr,
			"",
		].join("\n");
		const outputPath = join(outputDir, `check-${String(index + 1).padStart(3, "0")}.log`);
		mkdirSync(outputDir, { recursive: true });
		writeFileAtomic(outputPath, output);
		results.push({
			command: trimmed,
			exitCode: result.code,
			stdout: stdout.value,
			stderr: stderr.value,
			passed: result.code === 0 && !result.outputTruncated,
			outputTruncated: stdout.truncated || stderr.truncated,
			outputPath,
			outputDigest: digest(output),
			...(result.outputTruncated
				? {
						outputIncomplete: true,
						outputLimitBytes: result.outputLimitBytes,
						reason: "输出超过采集上限，日志不完整",
					}
				: {}),
		});
		if (result.code !== 0) break;
	}
	return results;
}

function previewOutput(value: string): { value: string; truncated: boolean } {
	if (value.length <= CHECK_OUTPUT_HEAD + CHECK_OUTPUT_TAIL) return { value, truncated: false };
	return {
		value: `${value.slice(0, CHECK_OUTPUT_HEAD)}\n…（已截断 ${value.length - CHECK_OUTPUT_HEAD - CHECK_OUTPUT_TAIL} 字符）…\n${value.slice(-CHECK_OUTPUT_TAIL)}`,
		truncated: true,
	};
}

export async function integrateDelivery(request: IntegrationRequest): Promise<IntegrationRecord> {
	request.signal?.throwIfAborted();
	if (!REQUEST_ID_PATTERN.test(request.requestId)) {
		throw new PaoCardError("INVALID_CARD", "整合 requestId 格式无效", { requestId: request.requestId });
	}
	const source = request.sourceExecutionKey;
	const targetKey = request.targetExecutionKey;
	const fingerprint = requestFingerprint(request);
	const resultPath = integrationResultPath(source.cardsDir, request.requestId);
	const outputDir = join(dirname(resultPath), `${basename(resultPath, ".json")}-checks`);
	mkdirSync(dirname(resultPath), { recursive: true });
	return withFileLock(resultPath, async () => {
		const record = readRecord(resultPath);
		if (record) {
			const recordedFingerprint = record.requestFingerprint ?? persistedRequestFingerprint(record);
			if (recordedFingerprint !== fingerprint) {
				throw new PaoCardError("INVALID_CARD", "同一 requestId 已绑定不同完整请求参数", {
					expected: recordedFingerprint,
					actual: fingerprint,
				});
			}
			if (
				!samePath(record.source.cardsDir, source.cardsDir) ||
				record.source.cardNo !== source.cardNo ||
				record.source.attempt !== source.attempt
			) {
				throw new PaoCardError("INVALID_CARD", "同一 requestId 已绑定不同源 attempt");
			}
			const target = await resolveExecutionContext(targetKey);
			const targetMatches =
				samePath(record.target.projectRoot, target.projectRoot) &&
				samePath(record.target.executionRoot, target.canonicalExecutionRoot) &&
				samePath(record.target.repositoryRoot, target.repositoryRoot) &&
				record.target.bindingDigest === target.bindingDigest &&
				record.target.worktreeBindingDigest === target.worktree.bindingDigest;
			if (!targetMatches) {
				throw new PaoCardError("INVALID_CARD", "同一 requestId 已绑定不同整合目标");
			}
			return record;
		}

		const sourceExecution = await resolveExecutionContext(source, {
			expectedCurrentAttempt: source.attempt,
			requireLiveExecutionRoot: true,
		});
		const target = await resolveExecutionContext(targetKey, {
			expectedCurrentAttempt: targetKey.attempt,
			requireLiveExecutionRoot: true,
		});
		if (
			!samePath(sourceExecution.projectRoot, target.projectRoot) &&
			sourceExecution.projectRoot !== target.projectRoot
		) {
			throw new PaoCardError("INVALID_CARD", "源 attempt 与整合目标不属于同一任务根");
		}
		const sourceCard = loadCard(source.cardsDir, source.cardNo);
		const diff = await diffAgainstBaseline(baselineSnapshotPath(source.cardsDir, source.cardNo, source.attempt));
		deliveryCommitFromBaselineDiff(diff);
		const deliveryCommit = await assertDeliveryObject(
			sourceExecution,
			diff.基线Tree!,
			diff.当前Tree!,
			request.signal,
		);
		const before = await captureContentSnapshot(target.canonicalExecutionRoot, request.signal);
		const initial: IntegrationRecord = {
			schemaVersion: 1,
			requestId: request.requestId,
			requestFingerprint: fingerprint,
			source: {
				...sourceIdentity(sourceExecution),
				cardsDir: source.cardsDir,
				cardNo: source.cardNo,
				attempt: source.attempt,
				baselineTree: diff.基线Tree!,
				deliveryTree: diff.当前Tree!,
				deliveryCommit,
			},
			target: {
				...targetIdentity(target, before.head, before.headTree),
				beforeContentTree: before.contentTree,
				beforeContentDigest: before.contentDigest,
			},
			status: "integrating",
			conflictFiles: [],
			requestedChecks: normalizedChecks(request.checks),
			checks: [],
			externalChanges: [],
			integrationPassed: false,
			message: `正在整合 ${formatCardNumber(sourceCard.card_no)} attempt ${source.attempt}`,
			startedAt: new Date().toISOString(),
		};
		writeFileAtomic(resultPath, `${JSON.stringify(initial, null, 2)}\n`);
		let targetLock: IntegrationWriteLock | undefined;
		let retainTargetLock = false;
		try {
			if (before.head !== request.expectedTargetHead) {
				throw new PaoCardError("INVALID_CARD", "整合目标 HEAD 已被外部修改，拒绝覆盖", {
					expected: request.expectedTargetHead,
					actual: before.head,
				});
			}
			if (!request.acquireWriteLock) {
				throw new PaoCardError("INVALID_CARD", "整合入口缺少宿主执行根写锁，拒绝无锁写入");
			}
			targetLock = await request.acquireWriteLock({
				executionRoot: target.canonicalExecutionRoot,
				holder: `integration:${request.requestId}`,
				...(request.signal ? { signal: request.signal } : {}),
			});
			const lockedBefore = await captureContentSnapshot(target.canonicalExecutionRoot, request.signal);
			if (
				lockedBefore.head !== initial.target.baseHead ||
				lockedBefore.contentDigest !== initial.target.beforeContentDigest
			) {
				throw new PaoCardError("INVALID_CARD", "整合目标内容在取得写锁前发生变化，拒绝覆盖");
			}
			const applied = await applyDeliveryToTarget(
				request,
				diff.基线Tree!,
				diff.当前Tree!,
				target,
				lockedBefore,
				request.signal,
			);
			const checks = await runChecks(target.canonicalExecutionRoot, request.checks ?? [], outputDir, request.signal);
			const checksSnapshot =
				checks.length === 0
					? applied.snapshot
					: await captureContentSnapshot(target.canonicalExecutionRoot, request.signal);
			const contentChanged = checksSnapshot.contentDigest !== applied.snapshot.contentDigest;
			const allChecksPassed = checks.length > 0 && checks.every((check) => check.passed);
			const finalStatus = contentChanged || (checks.length > 0 && !allChecksPassed) ? "check_failed" : "applied";
			const final: IntegrationRecord = {
				...initial,
				target: {
					...initial.target,
					resultHead: applied.head,
					resultTree: applied.tree,
					resultContentTree: checksSnapshot.contentTree,
				},
				status: finalStatus,
				checks,
				checksContentTree: checksSnapshot.contentTree,
				checksContentDigest: checksSnapshot.contentDigest,
				integrationPassed: allChecksPassed && !contentChanged,
				message: contentChanged
					? "集成检查后代码内容发生变化，检查结果失效"
					: checks.length === 0
						? "整合 tree 已生成，但未运行独立集成检查，不能算整合通过"
						: allChecksPassed
							? `整合完成并通过 ${checks.length} 项独立检查`
							: `整合 tree 已生成，但独立集成检查未通过（${checks.find((check) => !check.passed)?.command ?? "无命令"}）`,
				finishedAt: new Date().toISOString(),
			};
			writeFileAtomic(resultPath, `${JSON.stringify(final, null, 2)}\n`);
			return final;
		} catch (error) {
			if (error instanceof CardProcessStopUnconfirmedError) {
				retainTargetLock = true;
			}
			const latest = readRecord(resultPath) ?? initial;
			const conflictFiles =
				error instanceof PaoCardError && Array.isArray(error.details.conflictFiles)
					? (error.details.conflictFiles as string[])
					: [];
			const externalChanges =
				error instanceof PaoCardError && Array.isArray(error.details.externalChanges)
					? (error.details.externalChanges as string[])
					: [];
			const failed: IntegrationRecord = {
				...latest,
				status: /冲突/.test(String((error as Error).message)) ? "conflicted" : "failed",
				conflictFiles,
				externalChanges,
				integrationPassed: false,
				message: String((error as Error).message),
				finishedAt: new Date().toISOString(),
			};
			writeFileAtomic(resultPath, `${JSON.stringify(failed, null, 2)}\n`);
			throw error;
		} finally {
			if (targetLock && !retainTargetLock) await targetLock.release();
		}
	});
}

const integrationParams = Type.Object({
	request_id: Type.String({ minLength: 1, description: "稳定的整合请求标识；重复调用按它查回，不重复应用。" }),
	cards_dir: Type.String({ description: "源卡目录绝对路径" }),
	card_ref: Type.Union([Type.Number(), Type.String()], { description: "源卡号" }),
	attempt: Type.Number({ minimum: 1, description: "源卡实际执行 attempt" }),
	target_cards_dir: Type.String({ description: "整合工作树对应的卡目录绝对路径" }),
	target_card_ref: Type.Union([Type.Number(), Type.String()], { description: "整合工作树卡号" }),
	target_attempt: Type.Number({ minimum: 1, description: "整合工作树当前 attempt" }),
	expected_target_head: Type.String({ minLength: 1, description: "整合目标预期的当前 HEAD" }),
	checks: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "独立集成检查命令" })),
});

export interface IntegrationToolsOptions {
	resolveCardsDir?: () => string;
	/** 当前会话可写的项目根；用于阻止 raw cards_dir 跨归属写。 */
	resolveProjectRoot?: () => string;
	/** 由宿主注入的同一把执行根写锁。 */
	acquireWriteLock?: AcquireIntegrationWriteLock;
	/** 当前 owner 名，必须等于源卡 owner，防止任意会话冒领整合结果。 */
	resolveOperator?: () => string | undefined;
}

export interface IntegrationToolName {
	readonly name: "pao_integrate_delivery";
}

/** 注册前后可调的身份检查；返回 false 时工具直接拒绝跨归属调用。 */
export interface IntegrationToolContext {
	readonly projectRoot: string;
	readonly operator?: string;
}

export function checkIntegrationToolAuthority(input: {
	readonly sourceExecutionKey: ExecutionKey;
	readonly targetExecutionKey: ExecutionKey;
	readonly sourceOwner?: string;
	readonly targetStatus: string;
	readonly context: IntegrationToolContext;
}): void {
	if (
		!samePath(projectRootForCards(input.sourceExecutionKey.cardsDir), input.context.projectRoot) ||
		!samePath(projectRootForCards(input.targetExecutionKey.cardsDir), input.context.projectRoot)
	) {
		throw new PaoCardError("INVALID_CARD", "源卡和整合卡不属于当前会话项目，拒绝跨归属整合");
	}
	if (!input.context.operator?.trim() || input.sourceOwner !== input.context.operator) {
		throw new PaoCardError("INVALID_CARD", "整合工具调用者不是源卡当前 owner", {
			operator: input.context.operator,
			owner: input.sourceOwner,
		});
	}
	if (input.targetStatus !== "in_progress") {
		throw new PaoCardError("INVALID_CARD", "整合目标卡必须是进行中的受管工作树");
	}
}

export function integrationToolNames(): readonly IntegrationToolName[] {
	return [{ name: "pao_integrate_delivery" }];
}

export function registerIntegrationTools(pi: ExtensionAPI, options: IntegrationToolsOptions = {}): void {
	pi.registerTool({
		name: "pao_integrate_delivery",
		label: "整合交付",
		description:
			"在已绑定的受管整合工作树中接纳一张卡的受控交付；使用稳定 request_id 幂等回查，目标 HEAD/tree 外部变化时拒绝覆盖，文本冲突保留现场，集成检查独立执行。",
		parameters: integrationParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: Static<typeof integrationParams>, signal, _onUpdate, ctx) {
			const cardsDir = params.cards_dir || options.resolveCardsDir?.();
			const targetCardsDir = params.target_cards_dir || options.resolveCardsDir?.();
			if (!cardsDir || !targetCardsDir) throw new Error("缺少源卡目录或整合工作树卡目录。");
			const sourceKey: ExecutionKey = {
				cardsDir: absolutePath(cardsDir, "cardsDir"),
				cardNo: Number(params.card_ref),
				attempt: params.attempt,
			};
			const targetKey: ExecutionKey = {
				cardsDir: absolutePath(targetCardsDir, "targetCardsDir"),
				cardNo: Number(params.target_card_ref),
				attempt: params.target_attempt,
			};
			const expectedRoot = absolutePath(options.resolveProjectRoot?.() ?? ctx.cwd, "当前会话项目根");
			const sourceCard = loadCard(sourceKey.cardsDir, sourceKey.cardNo);
			const targetCard = loadCard(targetKey.cardsDir, targetKey.cardNo);
			const operator = options.resolveOperator?.();
			checkIntegrationToolAuthority({
				sourceExecutionKey: sourceKey,
				targetExecutionKey: targetKey,
				sourceOwner: sourceCard.frontmatter.owner,
				targetStatus: targetCard.frontmatter.status,
				context: { projectRoot: expectedRoot, operator },
			});
			const result = await integrateDelivery({
				requestId: params.request_id,
				sourceExecutionKey: sourceKey,
				targetExecutionKey: targetKey,
				expectedTargetHead: params.expected_target_head,
				checks: params.checks,
				...(options.acquireWriteLock ? { acquireWriteLock: options.acquireWriteLock } : {}),
				signal,
			});
			return {
				content: [{ type: "text", text: `${result.status}: ${result.message}` }],
				details: result,
			};
		},
	});
}
