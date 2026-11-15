import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { pathKey } from "../shared/path-key.ts";
import type { TodoItem } from "../todo/summary.ts";
import { scanTodoState } from "../todo/summary.ts";
import { type BaselineDiff, baselineSnapshotPath, diffAgainstBaseline, isDispatchSystemPath } from "./baseline.ts";
import { listCards, loadCard } from "./cardfile.ts";
import { formatCardNumber, parseCardRef } from "./counter.ts";
import { PaoCardError } from "./errors.ts";
import {
	type ExecutionBinding,
	ExecutionContextError,
	type ExecutionKey,
	type ResolvedExecutionContext,
	readExecutionBinding,
	resolveExecutionContext,
} from "./execution-context.ts";
import { runCardProcess } from "./process.ts";
import type { ParsedCard, ReceiptChange } from "./types.ts";
import { readLatestVerdict } from "./verifier.ts";

/**
 * 交卷自动化（架构 §13，2026-10-02 定案）：
 * - `pao_deliver_card`：对卡所在项目 stage＋commit，提交信息机械生成（模板＝卡号＋卡标题＋验收结果，
 *   如「卡0005 巡库卡 · 已交付 · 机械验收通过」）。
 * - stage 范围＝§14 比对出的本卡差异清单（认领基线快照减当前 status 的 worker 改动），逐路径 add，
 *   禁 `git add -A`；清单外改动不碰、不催——不裹挟用户无关 WIP 与其他任务残留（R15）。
 * - 产物提交只含 worker 真实产出：派发链自写系统文件（基线快照/黑板/四指标账/用量账）按
 *   baseline 的集中豁免清单（isDispatchSystemPath）排除，不卷进交卷 commit（2026-10-05 修）。
 * - 双入口：§11 驱动器在机械验收通过后自动调 deliverCard（全自动闭环：验收过→交卷→解锁下游）；
 *   手动会话里主控或用户可调 pao_deliver_card（单卡或批量）——工具与驱动器同一函数入口。
 * - 只 commit 不 push：推送由用户或主控手动执行；返回文本带「未推送」提示。
 * - worker 永不跑 git：交卷只发生在 owner/驱动器侧（本模块），边界不动。
 * - 验收衔接（§12 输出）：卡上最近一次 `## 机械验收` 结论为 未过 → 拒绝交卷并输出结构化原因
 *   （自动流本不该到此，手动触发也须先复核验收）；状态非已交付 → 拒绝（回执≠终态，交付先经
 *   pao_verify_card 自动落或 pao_change_status 人工落）。
 * - git 忙（index.lock）等待重试；基线不可用（无法机械定 stage 范围）不猜、不退化为 add -A。
 */

// ============================================================================
// git 基础（只 commit 不 push；无任何 push 调用）
// ============================================================================

function runGit(
	args: string[],
	cwd: string,
	timeoutMs = 60000,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return runCardProcess(
		"git",
		["-c", "core.quotepath=off", "--literal-pathspecs", ...args],
		cwd,
		timeoutMs,
		undefined,
		signal,
	);
}

/** git 忙重试：index.lock 冲突等待后重试（§13 实现细节），其余错误立即返回。 */
async function runGitWithRetry(
	args: string[],
	cwd: string,
	attempts = 3,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	let last = { code: 1, stdout: "", stderr: "" };
	for (let i = 0; i < attempts; i++) {
		signal?.throwIfAborted();
		last = await runGit(args, cwd, 60000, signal);
		if (last.code === 0 || !/index\.lock|Unable to create/i.test(last.stderr)) return last;
		await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
	}
	return last;
}

// ============================================================================
// 提交信息机械生成
// ============================================================================

/** 卡上验收记录 → 提交信息验收结果槽位（§13 模板第三段）。 */
export function verdictLabel(verdict: string | undefined): string {
	switch (verdict) {
		case "全过自动交付":
			return "机械验收通过";
		case "全过停人工审":
			return "机械部分通过·人工审定";
		case "未过":
			return "机械验收未过";
		case "无法机械判":
			return "人工验收";
		default:
			return "未机械验收";
	}
}

/** 提交信息模板（§13 冻结口径）：卡NNNN <目标> · <状态> · <验收结果> */
export function buildCommitMessage(card: ParsedCard): string {
	const verdict = readLatestVerdict(card.body);
	return `${formatCardNumber(card.card_no)} ${card.frontmatter.goal} · ${card.frontmatter.status} · ${verdictLabel(verdict?.结论)}`;
}

// ============================================================================
// 交卷
// ============================================================================

export interface SubmissionResult {
	card_no: number;
	交卷: boolean;
	提交哈希?: string;
	提交信息?: string;
	暂存文件: string[];
	消息: string;
	原因?: string;
	/** 受管交卷绑定的统一 attempt 关联与输入摘要。 */
	执行上下文?: {
		cardsDir: string;
		attempt: number;
		projectRoot: string;
		executionRoot: string;
		repositoryRoot: string;
		bindingDigest: string;
		worktreeBindingDigest: string;
		snapshotDigest: string;
		briefRef?: string;
	};
	/** 本次交付内容范围为「认领基线 tree → 当前 tree」，不是整文件工作树状态。 */
	内容证据?: {
		基线Tree: string;
		交付Tree: string;
		交付Commit?: string;
		交付对象?: string;
	};
}

export interface DeliverOptions {
	signal?: AbortSignal;
	/** commit 作者身份（-c user.name/-c user.email 注入，不要求仓库全局配置） */
	作者?: { 名: string; 邮箱: string };
	/**
	 * 会话分支（S8-内核2 回执对账数据源）：提供时回执按 scanTodoState 权威清单附「未完成待办对账」段。
	 * 不提供则回执不变（§11 驱动器路径不传，链步骤注记不膨胀）。
	 */
	会话分支?: readonly SessionEntry[];
	/** 显式指定统一 attempt 关联；省略时按当前 attempt 的持久执行证据自动选择。 */
	executionKey?: ExecutionKey;
}

interface ControlledDeliveryResult extends SubmissionResult {
	提交Tree: string;
	提交对象: string;
}

interface PersistedDeliveryResult {
	schemaVersion: 1;
	key: ExecutionKey;
	bindingDigest: string;
	snapshotDigest: string;
	baselineTree: string;
	deliveryTree: string;
	deliveryCommit: string;
	deliveryRef: string;
	capturedAt: string;
}

interface AttemptBaselineEvidence {
	cardNo: number;
	attempt: number;
	projectRoot: string;
	executionRoot: string;
	repositoryRoot: string;
	head: string;
	tree: string;
	ref: string;
	contentDigest: string;
	bindingDigest: string;
	snapshotDigest: string;
	statusEntries: { 状态: string; 文件: string }[];
}

interface CumulativeDeliveryEvidence {
	baselineTree: string;
	deliveryTree: string;
	paths: string[];
	references: string[];
}

function samePath(left: string, right: string): boolean {
	return (
		pathKey(left.replace(/\\/g, "/")).replace(/\/+$/, "") === pathKey(right.replace(/\\/g, "/")).replace(/\/+$/, "")
	);
}

function cumulativeFailure(card: ParsedCard, detail: string): { 原因: string; 消息: string } {
	return {
		原因: "累计成果归属不足",
		消息: `${formatCardNumber(card.card_no)} 拒绝交卷：累计成果归属不足——${detail}。保留原基线与回执，不猜中间改动属于本卡。`,
	};
}

function repoPath(value: string, projectRoot: string): string {
	let out = value.trim().replace(/\\/g, "/");
	const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	if (out === root) return "";
	if (out.startsWith(`${root}/`)) out = out.slice(root.length + 1);
	while (out.startsWith("./")) out = out.slice(2);
	return out.replace(/^\/+/, "").replace(/\/+$/, "");
}

function entryPaths(entry: { 状态: string; 文件: string }): string[] {
	const parts = entry.文件.split(" -> ");
	return /[RC]/.test(entry.状态) ? parts.slice(0, 2) : [parts[0] ?? ""];
}

function declarationMatches(
	declaration: ReceiptChange,
	entry: { 状态: string; 文件: string },
	projectRoot: string,
): boolean {
	const declared = repoPath(declaration.路径, projectRoot);
	const paths = entryPaths(entry).map((item) => repoPath(item, projectRoot));
	const kind =
		entry.状态 === "D"
			? "deleted"
			: entry.状态 === "R"
				? "moved"
				: entry.状态 === "A" || entry.状态 === "??"
					? "created"
					: entry.状态 === "M" || entry.状态 === "T"
						? "modified"
						: undefined;
	return kind === declaration.类型 && paths.includes(declared);
}

function pathClaimedByChange(change: ReceiptChange, path: string, projectRoot: string): boolean {
	if (change.类型 === "untouched") return false;
	const declared = repoPath(change.路径, projectRoot);
	const target = repoPath(path, projectRoot);
	return target === declared || target.startsWith(`${declared}/`);
}

function readAttemptBaseline(
	snapshotPath: string,
	key: ExecutionKey,
	binding: ExecutionBinding,
): { ok: true; evidence: AttemptBaselineEvidence } | { ok: false; reason: string } {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
	} catch {
		return { ok: false, reason: `尝试 ${key.attempt} 缺少可读的 JSON 基线` };
	}
	const text = (field: string): string => (typeof raw[field] === "string" ? raw[field].trim() : "");
	const evidence: AttemptBaselineEvidence = {
		cardNo: Number(raw.cardNo),
		attempt: Number(raw.attempt),
		projectRoot: text("projectRoot"),
		executionRoot: text("executionRoot"),
		repositoryRoot: text("repositoryRoot"),
		head: text("head"),
		tree: text("tree"),
		ref: text("ref"),
		contentDigest: text("contentDigest"),
		bindingDigest: text("bindingDigest"),
		snapshotDigest: text("snapshotDigest"),
		statusEntries: Array.isArray(raw.statusEntries)
			? raw.statusEntries
					.filter(
						(entry): entry is { 状态: string; 文件: string } =>
							entry !== null &&
							typeof entry === "object" &&
							typeof (entry as Record<string, unknown>).状态 === "string" &&
							typeof (entry as Record<string, unknown>).文件 === "string",
					)
					.map((entry) => ({ 状态: entry.状态, 文件: entry.文件 }))
			: [],
	};
	const expectedRef = `refs/pao-execution/baselines/card-${String(key.cardNo).padStart(4, "0")}-attempt-${key.attempt}`;
	const expectedDigest = `sha256:${createHash("sha256").update(`${evidence.head}:${evidence.tree}`).digest("hex")}`;
	if (
		raw.schemaVersion !== 1 ||
		evidence.cardNo !== key.cardNo ||
		evidence.attempt !== key.attempt ||
		!samePath(evidence.projectRoot, binding.projectRoot) ||
		!samePath(evidence.executionRoot, binding.executionRoot) ||
		!samePath(evidence.repositoryRoot, binding.repositoryRoot) ||
		evidence.bindingDigest !== binding.bindingDigest ||
		evidence.snapshotDigest !== binding.snapshotDigest
	)
		return { ok: false, reason: `尝试 ${key.attempt} 的基线或执行绑定已变化` };
	if (
		!/^[0-9a-f]{40,64}$/i.test(evidence.head) ||
		!/^[0-9a-f]{40,64}$/i.test(evidence.tree) ||
		evidence.ref !== expectedRef ||
		evidence.contentDigest !== expectedDigest
	)
		return { ok: false, reason: `尝试 ${key.attempt} 的基线内容摘要或引用不自洽` };
	return { ok: true, evidence };
}

async function gitCommonDir(root: string, signal?: AbortSignal): Promise<string> {
	const result = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], root, 60000, signal);
	return result.code === 0 ? result.stdout.trim() : "";
}

async function bindingBelongsToRepository(
	binding: ExecutionBinding,
	currentCommonDir: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!binding.worktree.commonGitDir || !samePath(binding.worktree.commonGitDir, currentCommonDir)) return false;
	// 历史 worktree 可以已清理；持久绑定中的共同 Git 目录仍可证明仓库身份。
	if (!existsSync(binding.executionRoot)) return true;
	const liveCommonDir = await gitCommonDir(binding.repositoryRoot, signal);
	return Boolean(liveCommonDir) && samePath(liveCommonDir, currentCommonDir);
}

async function treeChanges(
	repoRoot: string,
	beforeTree: string,
	afterTree: string,
	signal?: AbortSignal,
): Promise<{ 状态: string; 文件: string }[]> {
	if (beforeTree === afterTree) return [];
	const result = await runGit(
		["diff", "--name-status", "-z", "--no-ext-diff", "--no-textconv", beforeTree, afterTree, "--", "."],
		repoRoot,
		60000,
		signal,
	);
	if (result.code !== 0) throw new Error(result.stderr.slice(0, 240) || "读取尝试 tree 差失败");
	const fields = result.stdout.split("\0");
	const entries: { 状态: string; 文件: string }[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index++]?.trim();
		if (!status) continue;
		const firstPath = fields[index++];
		if (!firstPath) continue;
		if (status.startsWith("R") || status.startsWith("C")) {
			const secondPath = fields[index++] ?? firstPath;
			entries.push({ 状态: status[0] ?? status, 文件: `${firstPath} -> ${secondPath}` });
		} else {
			entries.push({ 状态: status[0] ?? status, 文件: firstPath });
		}
	}
	return entries.filter((entry) => !entryPaths(entry).some(isDispatchSystemPath));
}

async function validateBaselineObjects(
	repoRoot: string,
	evidence: AttemptBaselineEvidence,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const tree = await runGit(["rev-parse", `${evidence.tree}^{tree}`], repoRoot, 60000, signal);
	if (tree.code !== 0 || tree.stdout.trim() !== evidence.tree) return "基线 tree 在共同 Git 仓库中不可读";
	const ref = await runGit(["rev-parse", `${evidence.ref}^{tree}`], repoRoot, 60000, signal);
	if (ref.code !== 0 || ref.stdout.trim() !== evidence.tree) return "基线引用已变化或不可读";
	return undefined;
}

function latestAttemptReceipt(card: ParsedCard, attempt: number) {
	return [...card.receipts]
		.reverse()
		.find((receipt) => receipt.attempt === attempt && receipt.archive_flag === undefined);
}

async function inspectCumulativeDelivery(
	card: ParsedCard,
	cardsDir: string,
	diff: BaselineDiff,
	execution: ResolvedExecutionContext | undefined,
	signal?: AbortSignal,
): Promise<{ ok: true; evidence: CumulativeDeliveryEvidence } | { ok: false; 原因: string; 消息: string }> {
	const currentAttempt = card.frontmatter.attempt;
	if (currentAttempt <= 1) {
		return { ok: false, 原因: "内部状态错误", 消息: "累计交付只用于重试卡" };
	}
	const repoRoot = execution?.repositoryRoot ?? diff.当前ContentRoot ?? diff.项目根;
	const currentTree = diff.当前Tree;
	if (!repoRoot || !currentTree) {
		return { ok: false, ...cumulativeFailure(card, "当前尝试缺少真实内容 tree 或仓库根") };
	}
	const currentCommonDir = await gitCommonDir(repoRoot, signal);
	if (!currentCommonDir) return { ok: false, ...cumulativeFailure(card, "当前仓库缺少共同 Git 目录证据") };

	const baselines: AttemptBaselineEvidence[] = [];
	for (let attempt = 1; attempt <= currentAttempt; attempt++) {
		const key = { cardsDir, cardNo: card.card_no, attempt };
		let binding: ExecutionBinding;
		try {
			binding = execution && attempt === currentAttempt ? execution : readExecutionBinding(key);
		} catch {
			return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt} 缺少真实执行绑定`) };
		}
		if (
			binding.key.cardNo !== card.card_no ||
			binding.key.attempt !== attempt ||
			!samePath(binding.projectRoot, binding.worktree.taskRoot) ||
			!(await bindingBelongsToRepository(binding, currentCommonDir, signal))
		) {
			return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt} 的执行绑定不属于当前共同 Git 仓库`) };
		}
		const parsed = readAttemptBaseline(baselineSnapshotPath(cardsDir, card.card_no, attempt), key, binding);
		if (!parsed.ok) return { ok: false, ...cumulativeFailure(card, parsed.reason) };
		const objectFailure = await validateBaselineObjects(repoRoot, parsed.evidence, signal);
		if (objectFailure) return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt}：${objectFailure}`) };
		const boundaryKey = { cardsDir, cardNo: card.card_no, attempt };
		let boundary: ExecutionBinding;
		try {
			boundary = readExecutionBinding(boundaryKey);
		} catch {
			return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt} 的执行绑定在核验期间不可读`) };
		}
		const stored = readAttemptBaseline(baselineSnapshotPath(cardsDir, card.card_no, attempt), boundaryKey, boundary);
		if (
			!stored.ok ||
			stored.evidence.tree !== parsed.evidence.tree ||
			stored.evidence.bindingDigest !== parsed.evidence.bindingDigest ||
			stored.evidence.snapshotDigest !== parsed.evidence.snapshotDigest
		) {
			return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt} 的基线在核验期间发生变化`) };
		}
		baselines.push(parsed.evidence);
	}

	const paths = new Set<string>();
	for (let attempt = 1; attempt <= currentAttempt; attempt++) {
		const baseline = baselines[attempt - 1]!;
		const nextTree = attempt < currentAttempt ? baselines[attempt]!.tree : currentTree;
		let truth: { 状态: string; 文件: string }[];
		try {
			truth = await treeChanges(repoRoot, baseline.tree, nextTree, signal);
		} catch (error) {
			return {
				ok: false,
				...cumulativeFailure(
					card,
					`尝试 ${attempt} 到后续基线的 tree 差不可读（${error instanceof Error ? error.message : String(error)}）`,
				),
			};
		}
		const receipt = latestAttemptReceipt(card, attempt);
		if (!receipt) return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt} 缺少历史回执`) };
		const changes = receipt.changes ?? [];
		const meaningful = changes.filter((change) => change.类型 !== "untouched");
		if (attempt < currentAttempt && meaningful.length === 0) {
			return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt} 的历史回执没有可归属改动`) };
		}
		if (
			attempt === currentAttempt &&
			meaningful.length === 0 &&
			!receipt.verification?.some((item) => item.结论 === "pass" && item.证据?.trim())
		) {
			return {
				ok: false,
				...cumulativeFailure(card, `尝试 ${attempt} 的只读复验缺少带证据的 pass 结论`),
			};
		}
		for (const change of meaningful) {
			const declared = repoPath(change.路径, baseline.projectRoot);
			const dirty = baseline.statusEntries.find((entry) =>
				entryPaths(entry).some((dirtyPath) => {
					const normalizedDirty = repoPath(dirtyPath, baseline.projectRoot);
					return (
						pathKey(normalizedDirty) === pathKey(declared) ||
						pathKey(normalizedDirty).startsWith(`${pathKey(declared)}/`) ||
						pathKey(declared).startsWith(`${pathKey(normalizedDirty)}/`)
					);
				}),
			);
			if (dirty) {
				return {
					ok: false,
					...cumulativeFailure(
						card,
						`路径 ${declared} 在尝试 ${attempt} 认领前已脏（${dirty.状态} ${dirty.文件}），无法区分用户混合编辑与本卡成果`,
					),
				};
			}
		}
		const receiptClaims = new Set<string>();
		if (
			meaningful.length !== truth.length ||
			truth.some((entry) => {
				const matches = meaningful.filter((change) => declarationMatches(change, entry, baseline.projectRoot));
				if (matches.length === 0) return true;
				receiptClaims.add(matches[0]!.路径);
				return false;
			}) ||
			meaningful.some((change) => !receiptClaims.has(change.路径))
		) {
			return {
				ok: false,
				...cumulativeFailure(card, `尝试 ${attempt} 的回执声明与相邻基线 tree 差不能逐项对应`),
			};
		}
		const claimedTruth = new Set(
			truth.flatMap((entry) => entryPaths(entry).map((path) => repoPath(path, baseline.projectRoot))),
		);
		if (
			meaningful.some((change) =>
				[...claimedTruth].every((path) => !pathClaimedByChange(change, path, baseline.projectRoot)),
			)
		) {
			return { ok: false, ...cumulativeFailure(card, `尝试 ${attempt} 的改动声明越过真实 tree 差`) };
		}
		for (const path of claimedTruth) {
			paths.add(path);
		}
	}

	const otherClaims = new Map<string, string>();
	for (const other of listCards(cardsDir)) {
		if (other.card_no === card.card_no) continue;
		const otherAttempt = other.frontmatter.attempt;
		const otherBaseline = otherAttempt > 0 ? baselineSnapshotPath(cardsDir, other.card_no, otherAttempt) : undefined;
		let otherProjectRoot: string | undefined;
		let otherRepositoryRoot: string | undefined;
		if (otherBaseline && existsSync(otherBaseline)) {
			try {
				const raw = JSON.parse(readFileSync(otherBaseline, "utf8")) as Record<string, unknown>;
				otherProjectRoot = typeof raw.projectRoot === "string" ? raw.projectRoot : undefined;
				otherRepositoryRoot = typeof raw.repositoryRoot === "string" ? raw.repositoryRoot : undefined;
			} catch {
				// 其他卡的损坏基线不提供归属证据；本卡仍按自己的证据链决定是否交付。
			}
		}
		if (otherProjectRoot && !samePath(otherProjectRoot, repoRoot)) {
			let sameRepository = otherRepositoryRoot !== undefined && samePath(otherRepositoryRoot, repoRoot);
			if (!sameRepository && otherRepositoryRoot) {
				const otherCommonDir = await gitCommonDir(otherRepositoryRoot, signal);
				sameRepository = Boolean(otherCommonDir) && samePath(otherCommonDir, currentCommonDir);
			}
			if (!sameRepository && otherAttempt > 0) {
				try {
					const otherBinding = readExecutionBinding({ cardsDir, cardNo: other.card_no, attempt: otherAttempt });
					sameRepository = await bindingBelongsToRepository(otherBinding, currentCommonDir, signal);
				} catch {
					// 持久绑定不可读时沿用其他卡基线的仓库根证据。
				}
			}
			if (!sameRepository) continue;
		}
		for (const receipt of other.receipts) {
			if (receipt.archive_flag !== undefined) continue;
			for (const change of receipt.changes ?? []) {
				if (change.类型 === "untouched") continue;
				const changedPath = repoPath(change.路径, repoRoot);
				if (!changedPath) continue;
				otherClaims.set(changedPath, `${formatCardNumber(other.card_no)} 尝试${receipt.attempt}`);
			}
		}
	}
	for (const path of paths) {
		const owner = [...otherClaims].find(
			([claimed]) => pathKey(path) === pathKey(claimed) || pathKey(path).startsWith(`${pathKey(claimed)}/`),
		);
		if (owner) {
			return {
				ok: false,
				...cumulativeFailure(card, `路径 ${path} 已被其他卡 ${owner[1]} 声明，拒绝混入同一交付`),
			};
		}
	}
	const earliest = baselines[0]!;
	return {
		ok: true,
		evidence: {
			baselineTree: earliest.tree,
			deliveryTree: currentTree,
			paths: [...paths].sort(),
			references: baselines.map((item) => `尝试${item.attempt}:${item.bindingDigest}@${item.tree}`),
		},
	};
}

async function runGitWithEnv(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return runCardProcess(
		"git",
		["-c", "core.quotepath=off", "-c", "core.autocrlf=false", "--literal-pathspecs", ...args],
		cwd,
		60000,
		env,
		signal,
	);
}

async function treeForPaths(
	repoRoot: string,
	baselineTree: string,
	currentTree: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<string> {
	const tempDir = mkdtempSync(join(tmpdir(), "pao-delivery-index-"));
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(tempDir, "index") };
		const read = await runGitWithEnv(["read-tree", baselineTree], repoRoot, env, signal);
		if (read.code !== 0) throw new Error(`读取交付基线 tree 失败：${read.stderr.slice(0, 200)}`);
		for (const path of paths) {
			if (
				!path ||
				path.startsWith("/") ||
				/^[a-zA-Z]:\//.test(path) ||
				path.split("/").includes("..") ||
				path.includes("\0") ||
				path.includes("\n")
			)
				throw new Error(`交付路径不安全：${path}`);
			const entry = await runGitWithEnv(["ls-tree", "-z", currentTree, "--", path], repoRoot, env, signal);
			if (entry.code !== 0) throw new Error(`读取当前交付对象失败：${entry.stderr.slice(0, 200)}`);
			const record = entry.stdout.split("\0").find(Boolean);
			if (record) {
				const tab = record.indexOf("\t");
				const [mode, type, object] = record.slice(0, tab).split(/\s+/);
				if (!mode || !type || !object || (type !== "blob" && type !== "commit"))
					throw new Error(`当前交付对象类型不支持：${path}`);
				const update = await runGitWithEnv(
					["update-index", "--add", "--cacheinfo", `${mode},${object},${path}`],
					repoRoot,
					env,
					signal,
				);
				if (update.code !== 0) throw new Error(`写入受控交付索引失败：${update.stderr.slice(0, 200)}`);
			} else {
				const remove = await runGitWithEnv(["update-index", "--force-remove", "--", path], repoRoot, env, signal);
				if (remove.code !== 0) throw new Error(`写入受控删除失败：${remove.stderr.slice(0, 200)}`);
			}
		}
		const write = await runGitWithEnv(["write-tree"], repoRoot, env, signal);
		if (write.code !== 0 || !write.stdout.trim())
			throw new Error(`生成受控交付 tree 失败：${write.stderr.slice(0, 200)}`);
		return write.stdout.trim();
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function pathsAlreadyCommitted(
	repoRoot: string,
	head: string,
	currentTree: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<boolean> {
	if (paths.length === 0) return false;
	const result = await runGit(["diff", "--quiet", head, currentTree, "--", ...paths], repoRoot, 60000, signal);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new Error(result.stderr.slice(0, 240) || "核对交付是否已存在失败");
}

function executionEvidence(execution: ResolvedExecutionContext): NonNullable<SubmissionResult["执行上下文"]> {
	return {
		cardsDir: execution.key.cardsDir,
		attempt: execution.key.attempt,
		projectRoot: execution.projectRoot,
		executionRoot: execution.canonicalExecutionRoot,
		repositoryRoot: execution.repositoryRoot,
		bindingDigest: execution.bindingDigest,
		worktreeBindingDigest: execution.worktree.bindingDigest,
		snapshotDigest: execution.snapshotDigest,
		...(execution.briefRef !== undefined ? { briefRef: execution.briefRef } : {}),
	};
}

function controlledDeliveryRef(key: ExecutionKey): string {
	return `refs/pao-execution/deliveries/card-${String(key.cardNo).padStart(4, "0")}-attempt-${key.attempt}`;
}

function controlledBaselineRef(key: ExecutionKey): string {
	return `refs/pao-execution/delivery-baselines/card-${String(key.cardNo).padStart(4, "0")}-attempt-${key.attempt}`;
}

function deliveryResultPath(key: ExecutionKey): string {
	return join(
		dirname(key.cardsDir),
		"delivery-results",
		`card-${String(key.cardNo).padStart(4, "0")}-attempt-${key.attempt}.json`,
	);
}

function parseLatestExecutionVerdict(card: ParsedCard):
	| {
			attempt: string;
			bindingDigest: string;
			worktreeDigest: string;
			snapshotDigest: string;
			beforeTree: string;
			afterTree: string;
			verdict: string;
	  }
	| undefined {
	const record = readLatestVerdict(card.body);
	if (!record) return undefined;
	const field = (name: string): string | undefined =>
		new RegExp(`^-\\s*${name}:\\s*(.+)$`, "m").exec(record.原文)?.[1]?.trim();
	return {
		attempt: field("尝试") ?? "",
		bindingDigest: field("关联摘要") ?? "",
		worktreeDigest: field("工作树摘要") ?? "",
		snapshotDigest: field("输入快照") ?? "",
		beforeTree: field("检查前 tree") ?? "",
		afterTree: field("检查后 tree") ?? "",
		verdict: record.结论,
	};
}

async function assertDeliveryContentMatchesVerification(
	card: ParsedCard,
	cardsDir: string,
	execution: ResolvedExecutionContext,
	currentTree: string,
	_currentHead: string,
): Promise<{ 原因: string; 消息: string } | undefined> {
	const verdict = parseLatestExecutionVerdict(card);
	if (!verdict) {
		return {
			原因: "验收证据缺失",
			消息: `${formatCardNumber(card.card_no)} 拒绝交卷：找不到当前受管验收记录。`,
		};
	}
	if (
		verdict.verdict === "未过" ||
		verdict.verdict === "无法机械判" ||
		verdict.attempt !== String(execution.key.attempt) ||
		verdict.bindingDigest !== execution.bindingDigest ||
		verdict.worktreeDigest !== execution.worktree.bindingDigest ||
		verdict.snapshotDigest !== execution.snapshotDigest
	) {
		return {
			原因: "验收证据不匹配",
			消息: `${formatCardNumber(card.card_no)} 拒绝交卷：最近验收的 attempt/输入/工作树关联与本次 execution-context 不一致。`,
		};
	}
	if (!verdict.beforeTree || verdict.beforeTree !== verdict.afterTree || verdict.afterTree !== currentTree) {
		return {
			原因: "测试后内容变化",
			消息: `${formatCardNumber(card.card_no)} 拒绝交卷：验收前后 tree 或当前代码 tree 不一致（${verdict.beforeTree || "(缺)"} → ${verdict.afterTree || "(缺)"}；当前 ${currentTree}）。`,
		};
	}
	const diff = await diffAgainstBaseline(baselineSnapshotPath(cardsDir, card.card_no, execution.key.attempt));
	if (diff.验收哈希) {
		const currentHash = createHash("sha256").update(card.frontmatter.acceptance, "utf8").digest("hex");
		if (currentHash !== diff.验收哈希) {
			return {
				原因: "验收声明已变化",
				消息: `${formatCardNumber(card.card_no)} 拒绝交卷：验收声明在认领后发生变化，须重新验收。`,
			};
		}
	}
	return undefined;
}

async function gitObject(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return runCardProcess(
		"git",
		["-c", "core.quotepath=off", "-c", "user.email=pao@local", "-c", "user.name=pao", ...args],
		cwd,
		60000,
		undefined,
		signal,
	);
}

async function createControlledDeliveryCommit(
	card: ParsedCard,
	execution: ResolvedExecutionContext,
	deliveryEvidence: CumulativeDeliveryEvidence,
	options: DeliverOptions | undefined,
): Promise<ControlledDeliveryResult> {
	const { baselineTree, deliveryTree: currentTree, paths, references } = deliveryEvidence;
	const author = options?.作者 ?? { 名: "pao", 邮箱: "pao@pao.local" };
	const seq = formatCardNumber(card.card_no);
	const key = execution.key;
	const ref = controlledDeliveryRef(key);
	const resultPath = deliveryResultPath(key);
	if (existsSync(resultPath)) {
		const persisted = JSON.parse(readFileSync(resultPath, "utf8")) as PersistedDeliveryResult;
		if (
			!samePath(persisted.key.cardsDir, key.cardsDir) ||
			persisted.key.cardNo !== key.cardNo ||
			persisted.key.attempt !== key.attempt ||
			persisted.bindingDigest !== execution.bindingDigest ||
			persisted.snapshotDigest !== execution.snapshotDigest
		) {
			throw new PaoCardError("INVALID_CARD", "同一交卷请求已绑定不同输入", { path: resultPath });
		}
		if (persisted.baselineTree !== baselineTree) {
			throw new PaoCardError("INVALID_CARD", "同一交卷请求的基线 tree 已变化", { path: resultPath });
		}
		const recordedTree = await gitObject(
			["rev-parse", `${persisted.deliveryCommit}^{tree}`],
			execution.repositoryRoot,
		);
		if (recordedTree.code !== 0 || recordedTree.stdout.trim() !== persisted.deliveryTree) {
			throw new PaoCardError("INVALID_CARD", "已保存的受控交付对象不可读或 tree 不自洽", { path: resultPath });
		}
		const recordedObject = await gitObject(["rev-parse", `${ref}^{commit}`], execution.repositoryRoot);
		if (recordedObject.code !== 0 || recordedObject.stdout.trim() !== persisted.deliveryCommit) {
			throw new PaoCardError("INVALID_CARD", "已保存的受控交付引用不可读或对象不一致", { path: resultPath });
		}
		const sameContent = await pathsAlreadyCommitted(
			execution.repositoryRoot,
			persisted.deliveryCommit,
			currentTree,
			paths,
			options?.signal,
		);
		return {
			card_no: card.card_no,
			交卷: sameContent,
			提交哈希: persisted.deliveryCommit,
			提交信息: buildCommitMessage(card),
			暂存文件: [],
			...(sameContent ? {} : { 原因: "测试后内容变化" }),
			消息: sameContent
				? `${seq} 幂等：交卷对象 ${persisted.deliveryCommit}（${ref}）已存在，未重复提交。`
				: `${seq} 拒绝重复交卷：交卷对象创建后代码内容又变化，保留原对象并要求重新验收。`,
			提交Tree: persisted.deliveryTree,
			提交对象: ref,
		};
	}

	const baselineRef = controlledBaselineRef(key);
	const existingBaseline = await gitObject(
		["rev-parse", "--verify", `${baselineRef}^{commit}`],
		execution.repositoryRoot,
	);
	let boundaryCommit: string;
	if (existingBaseline.code === 0) {
		boundaryCommit = existingBaseline.stdout.trim();
		const existingTree = await gitObject(["show", "-s", "--format=%T", boundaryCommit], execution.repositoryRoot);
		if (existingTree.code !== 0 || existingTree.stdout.trim() !== baselineTree) {
			throw new PaoCardError("INVALID_CARD", "已有交付基线提交的 tree 与本次内容基线不一致", {
				ref: baselineRef,
			});
		}
	} else {
		const baselineHead = await gitObject(["rev-parse", "HEAD"], execution.repositoryRoot);
		if (baselineHead.code !== 0) throw new PaoCardError("INVALID_CARD", "读取交付基线 HEAD 失败");
		const boundary = await gitObject(
			[
				"-c",
				`user.name=${author.名}`,
				"-c",
				`user.email=${author.邮箱}`,
				"commit-tree",
				baselineTree,
				"-p",
				baselineHead.stdout.trim(),
				"-m",
				`PAO ${seq} attempt ${key.attempt} input boundary`,
			],
			execution.repositoryRoot,
			options?.signal,
		);
		if (boundary.code !== 0) throw new PaoCardError("INVALID_CARD", `创建交付基线对象失败：${boundary.stderr}`);
		boundaryCommit = boundary.stdout.trim();
		const updateBoundary = await gitObject(["update-ref", baselineRef, boundaryCommit], execution.repositoryRoot);
		if (updateBoundary.code !== 0) {
			throw new PaoCardError("INVALID_CARD", `保存交付基线对象失败：${updateBoundary.stderr}`);
		}
	}

	const message = buildCommitMessage(card);
	const deliveryTree = await treeForPaths(execution.repositoryRoot, baselineTree, currentTree, paths, options?.signal);
	const delivery = await gitObject(
		[
			"-c",
			`user.name=${author.名}`,
			"-c",
			`user.email=${author.邮箱}`,
			"commit-tree",
			deliveryTree,
			"-p",
			boundaryCommit,
			"-m",
			message,
		],
		execution.repositoryRoot,
		options?.signal,
	);
	if (delivery.code !== 0) throw new PaoCardError("INVALID_CARD", `创建受控交付对象失败：${delivery.stderr}`);
	const deliveryCommit = delivery.stdout.trim();
	const update = await gitObject(["update-ref", ref, deliveryCommit], execution.repositoryRoot);
	if (update.code !== 0) throw new PaoCardError("INVALID_CARD", `保存受控交付引用失败：${update.stderr}`);
	const persisted: PersistedDeliveryResult = {
		schemaVersion: 1,
		key,
		bindingDigest: execution.bindingDigest,
		snapshotDigest: execution.snapshotDigest,
		baselineTree,
		deliveryTree,
		deliveryCommit,
		deliveryRef: ref,
		capturedAt: new Date().toISOString(),
	};
	mkdirSync(dirname(resultPath), { recursive: true });
	writeFileAtomic(resultPath, `${JSON.stringify(persisted, null, 2)}\n`);
	return {
		card_no: card.card_no,
		交卷: true,
		提交哈希: deliveryCommit,
		提交信息: message,
		暂存文件: [],
		消息: `${seq} 已生成受控交付对象 ${deliveryCommit}（${ref}）；从最早保留基线 tree=${baselineTree} 起，仅写入 ${paths.length} 个经历史回执核实的累计路径；当前引用 ${references.join("、")}；未改动任何宿主 index，未 push。`,
		提交Tree: deliveryTree,
		提交对象: ref,
	};
}

/**
 * 回执未完成待办对账段（S8-内核2）：pending/in_progress 分列为未完成项，cancelled 单列标注语义
 * （已放弃，不计未完成）。仅对账呈现——todo 全勾≠卡验收通过，验收衔接门不读本段；
 * 无未完成项（全勾/空清单/仅剩取消/无 todo 历史）返回 undefined，回执不添段。
 */
function formatTodoReconciliation(todos: readonly TodoItem[]): string | undefined {
	const pending = todos.filter((t) => t.status === "pending");
	const active = todos.filter((t) => t.status === "in_progress");
	const cancelled = todos.filter((t) => t.status === "cancelled");
	if (pending.length === 0 && active.length === 0) return undefined;
	const lines = [
		`——未完成待办对账（会话待办尚有 ${pending.length + active.length} 项未完成；信息面，不参与验收判定）：`,
	];
	if (pending.length > 0) lines.push(`未开始 ${pending.length} 项：`, ...pending.map((t) => `○ ${t.content}`));
	if (active.length > 0) lines.push(`进行中 ${active.length} 项：`, ...active.map((t) => `◐ ${t.content}`));
	if (cancelled.length > 0)
		lines.push(
			`已取消 ${cancelled.length} 项（cancelled＝已放弃，不计未完成）：`,
			...cancelled.map((t) => `⊘ ${t.content}`),
		);
	return lines.join("\n");
}

/**
 * 单卡交卷：验收衔接门 → 状态门 → §14 基线差异定 stage 范围 → 逐路径 add → commit。
 * 幂等：无基线外改动（已提交过或 worker 无产物）不创建空提交，如实返回。
 * 只 commit 不 push。组装回执时按 会话分支 附未完成待办对账段（S8-内核2，仅对账不门验收）。
 */
export async function deliverCard(
	cardsDir: string,
	cardNo: number,
	options?: DeliverOptions,
): Promise<SubmissionResult> {
	const result = await deliverCardOnce(cardsDir, cardNo, options);
	if (!options?.会话分支) return result;
	const section = formatTodoReconciliation(scanTodoState(options.会话分支).todos);
	return section ? { ...result, 消息: `${result.消息}\n${section}` } : result;
}

async function deliverCardOnce(cardsDir: string, cardNo: number, options?: DeliverOptions): Promise<SubmissionResult> {
	options?.signal?.throwIfAborted();
	const card = loadCard(cardsDir, cardNo);
	const seq = formatCardNumber(card.card_no);
	const base = { card_no: card.card_no, 交卷: false, 暂存文件: [] as string[] };

	// 验收衔接（§12 输出）：机械验收未过不交卷
	const verdict = readLatestVerdict(card.body);
	if (verdict?.结论 === "未过") {
		return {
			...base,
			原因: "机械验收未过",
			消息: `${seq} 拒绝交卷：最近一次机械验收结论「未过」（${verdict.时间}）。先复核验收结果（修卡重派或 pao_verify_card 重验），验收过再交卷。`,
		};
	}
	// 状态门：交卷只发生在交付之后（回执≠终态；自动闭环里 pao_verify_card 已落已交付）
	if (card.frontmatter.status !== "delivered") {
		return {
			...base,
			原因: "状态非已交付",
			消息: `${seq} 拒绝交卷：当前状态 ${card.frontmatter.status}。交卷在交付之后——机械全过走 pao_verify_card 自动落已交付；人工口径经 pao_change_status 落已交付后再交卷。`,
		};
	}

	// stage 范围＝§14 比对差异清单（认领基线快照）；基线不可用不猜、禁 add -A（R15）
	const currentExecutionKey: ExecutionKey = {
		cardsDir,
		cardNo: card.card_no,
		attempt: card.frontmatter.attempt,
	};
	const attemptSnapshot = baselineSnapshotPath(cardsDir, card.card_no, card.frontmatter.attempt);
	// 显式 key 保持调用方指定的受控路径。省略时，只要当前尝试有持久绑定，就解析真实的
	// execution-context 参与验收；绑定不存在且没有本尝试基线时，才按旧卡兼容。
	let executionKey = options?.executionKey;
	if (!executionKey) {
		try {
			readExecutionBinding(currentExecutionKey);
			executionKey = currentExecutionKey;
		} catch (error) {
			if (!(error instanceof ExecutionContextError) || error.code !== "EXECUTION_CONTEXT_NOT_FOUND") throw error;
			if (existsSync(attemptSnapshot)) {
				return {
					...base,
					原因: "执行上下文缺失",
					消息: `${seq} 拒绝交卷：当前尝试已有基线，但缺少真实 execution-context；不使用旧卡路径猜测交付范围。`,
				};
			}
		}
	}
	const execution = executionKey
		? await resolveExecutionContext(executionKey, {
				expectedCurrentAttempt: card.frontmatter.attempt,
				requireLiveExecutionRoot: true,
			})
		: undefined;
	const useControlledDelivery =
		Boolean(options?.executionKey) ||
		execution?.worktree.kind === "managed" ||
		Boolean(execution && !samePath(execution.projectRoot, execution.canonicalExecutionRoot));
	if (execution && execution.key.cardNo !== card.card_no) {
		return {
			...base,
			原因: "执行上下文卡号不一致",
			消息: `${seq} 拒绝交卷：execution-context 的卡号 ${execution.key.cardNo} 与当前卡 ${card.card_no} 不一致。`,
		};
	}
	const snapshot = execution
		? baselineSnapshotPath(cardsDir, card.card_no, execution.key.attempt)
		: baselineSnapshotPath(cardsDir, card.card_no);
	const diff = await diffAgainstBaseline(snapshot, options?.signal);
	options?.signal?.throwIfAborted();
	if (!diff.基线可用) {
		return {
			...base,
			原因: "基线不可用",
			消息: `${seq} 拒绝交卷：认领基线快照不可用（${diff.汇总}），无法机械定 stage 范围；禁 git add -A，不裹挟清单外改动（R15）。请人工核对后手动提交。`,
		};
	}
	// context 只负责验收与内容边界；路由仍由显式和宿主 worktree 类型决定。
	if (execution) {
		if (!diff.基线Tree || !diff.当前Tree || !diff.当前HEAD || !diff.当前ContentRoot) {
			return {
				...base,
				原因: "基线不可用",
				消息: `${seq} 拒绝交卷：受管执行缺少内容 tree/实际执行根证据，不能用整文件路径交付。`,
			};
		}
		if (!samePath(diff.当前ContentRoot, execution.canonicalExecutionRoot)) {
			return {
				...base,
				原因: "执行根不一致",
				消息: `${seq} 拒绝交卷：内容差读取根 ${diff.当前ContentRoot} 与 execution-context ${execution.canonicalExecutionRoot} 不一致。`,
			};
		}
		if (!samePath(execution.canonicalExecutionRoot, execution.repositoryRoot)) {
			return {
				...base,
				原因: "执行根不一致",
				消息: `${seq} 拒绝交卷：执行上下文要求执行根就是仓库根。`,
			};
		}
		const guarded = await assertDeliveryContentMatchesVerification(
			card,
			cardsDir,
			execution,
			diff.当前Tree,
			diff.当前HEAD,
		);
		if (guarded) return { ...base, ...guarded };
	}
	const cumulative =
		card.frontmatter.attempt > 1
			? await inspectCumulativeDelivery(card, cardsDir, diff, execution, options?.signal)
			: undefined;
	if (cumulative && !cumulative.ok) return { ...base, ...cumulative };
	if (execution && useControlledDelivery) {
		const evidence: CumulativeDeliveryEvidence = cumulative?.ok
			? cumulative.evidence
			: {
					baselineTree: diff.基线Tree!,
					deliveryTree: diff.当前Tree!,
					paths: [...new Set(diff.worker改动.flatMap(entryPaths))].sort(),
					references: [`尝试${execution.key.attempt}:${execution.bindingDigest}@${diff.基线Tree}`],
				};
		if (evidence.paths.length === 0) {
			return {
				...base,
				...cumulativeFailure(card, "当前受管尝试没有可交付改动"),
			};
		}
		const controlled = await createControlledDeliveryCommit(card, execution, evidence, options);
		return {
			...base,
			...controlled,
			...(execution ? { 执行上下文: executionEvidence(execution) } : {}),
			内容证据: {
				基线Tree: evidence.baselineTree,
				交付Tree: controlled.提交Tree,
				...(controlled.提交哈希 ? { 交付Commit: controlled.提交哈希 } : {}),
				交付对象: controlled.提交对象,
			},
		};
	}
	if (diff.worker改动.length === 0 && !cumulative?.ok) {
		return {
			...base,
			交卷: false,
			暂存文件: [],
			消息: `${seq} 幂等：无基线外改动（既有 ${diff.既有条目数} 条不计 worker 的账），未创建提交。`,
		};
	}

	// 逐路径 add；已暂存的重命名旧路径不再存在于 index，但提交必须包含旧、新路径。
	// 派发链自写系统文件（基线快照/黑板/账）不进产物提交：diff 层已按集中豁免清单排除，
	// 这里再兜一道底（同一清单 baseline.isDispatchSystemPath），产物只含 worker 真实产出。
	const pathList = cumulative?.ok
		? cumulative.evidence.paths
		: [...new Set(diff.worker改动.flatMap(entryPaths))].sort();
	const stash: string[] = [];
	const addPaths = cumulative?.ok
		? new Set(cumulative.evidence.paths)
		: new Set(diff.worker改动.map((entry) => entry.文件.split(" -> ")[0] ?? ""));
	for (const p of addPaths) {
		const add = await runGitWithRetry(["add", "--", p], diff.项目根 ?? cardsDir, 3, options?.signal);
		if (add.code !== 0) {
			return {
				...base,
				原因: "git add 失败",
				暂存文件: stash,
				消息: `${seq} 交卷中断：git add ${p} 失败——${add.stderr.slice(0, 200)}`,
			};
		}
		stash.push(p);
	}

	const projectRoot = diff.项目根 ?? cardsDir;
	const author = options?.作者 ?? { 名: "pao", 邮箱: "pao@pao.local" };
	const message = buildCommitMessage(card);
	const commit = await runGitWithRetry(
		[
			"-c",
			`user.name=${author.名}`,
			"-c",
			`user.email=${author.邮箱}`,
			"commit",
			"--no-gpg-sign",
			"--only",
			"-m",
			message,
			"--",
			...pathList,
		],
		projectRoot,
		3,
		options?.signal,
	);
	if (commit.code !== 0) {
		return {
			...base,
			原因: "git commit 失败",
			暂存文件: stash,
			消息: `${seq} 交卷失败：git commit 失败——${commit.stderr.slice(0, 200)}（暂存已保留，可人工接手）`,
		};
	}
	const head = await runGit(["rev-parse", "--short", "HEAD"], projectRoot);
	if (head.code !== 0 || !head.stdout.trim()) {
		return {
			card_no: card.card_no,
			交卷: true,
			提交信息: message,
			暂存文件: stash,
			原因: "提交哈希读取失败",
			消息: `${seq} git commit 已成功，但读取提交哈希失败：${head.stderr.slice(0, 200) || "git 未返回 HEAD"}；未 push，请人工核查提交记录。`,
		};
	}
	const hash = head.stdout.trim();
	return {
		card_no: card.card_no,
		交卷: true,
		提交哈希: hash,
		提交信息: message,
		暂存文件: stash,
		消息: `${seq} 已交卷：${hash} ${message}（${stash.length} 个路径，逐路径 add；只 commit 未 push，推送请手动执行）`,
	};
}

/** 批量交卷：串行逐卡（§13 并行安全口径：驱动器串行、手动串行），单卡失败不中断其余。 */
export async function deliverCards(
	cardsDir: string,
	cardNoList: number[],
	options?: DeliverOptions,
): Promise<SubmissionResult[]> {
	const results: SubmissionResult[] = [];
	for (const cardNo of cardNoList) {
		options?.signal?.throwIfAborted();
		try {
			results.push(await deliverCard(cardsDir, cardNo, options));
		} catch (error) {
			options?.signal?.throwIfAborted();
			results.push({
				card_no: cardNo,
				交卷: false,
				暂存文件: [],
				原因: "异常",
				消息: `${formatCardNumber(cardNo)} 交卷异常：${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return results;
}

// ============================================================================
// 工具注册（pao_deliver_card）
// ============================================================================

const cardNoItem = Type.Union([Type.Number(), Type.String()], { description: "卡号（数字或 卡#N）" });

const deliveryParams = Type.Object({
	cards_dir: Type.Optional(
		Type.String({ description: "卡目录（任务工作区的 卡/ 目录，绝对路径）；已配置默认卡目录时可省略" }),
	),
	card_ref: Type.Union([cardNoItem, Type.Array(cardNoItem)], { description: "单卡或批量：卡号（数字/卡#N）或其数组" }),
	author_name: Type.Optional(Type.String({ description: "commit 作者名，缺省 pao" })),
	author_email: Type.Optional(Type.String({ description: "commit 作者邮箱，缺省 pao@pao.local" })),
});

async function executeDelivery(
	params: Static<typeof deliveryParams>,
	options?: DeliveryToolsOptions,
	signal?: AbortSignal,
	会话分支?: readonly SessionEntry[],
): Promise<string> {
	try {
		const cardsDir = params.cards_dir ?? options?.resolveCardsDir?.();
		if (!cardsDir) throw new PaoCardError("INVALID_CARD", "缺少 cards_dir 参数，且未配置默认卡目录", {});
		const list = (Array.isArray(params.card_ref) ? params.card_ref : [params.card_ref]).map((c) =>
			parseCardRef(String(c)),
		);
		if (list.length === 0) throw new PaoCardError("INVALID_CARD", "卡号为空", {});
		const results = await deliverCards(cardsDir, list, {
			signal,
			会话分支,
			作者:
				params.author_name || params.author_email
					? { 名: params.author_name ?? "pao", 邮箱: params.author_email ?? "pao@pao.local" }
					: undefined,
		});
		const lines = results.map((r) => r.消息);
		const submitCount = results.filter((r) => r.交卷).length;
		lines.push(
			`——共 ${results.length} 卡：交卷 ${submitCount}，未交 ${results.length - submitCount}；提交均未推送（push 由用户/主控手动执行）。`,
		);
		return lines.join("\n");
	} catch (error) {
		if (error instanceof PaoCardError) throw new Error(`[${error.code}] ${error.message}`);
		throw error;
	}
}

export interface DeliveryToolsOptions {
	/** 返回默认卡目录（任务工作区的 卡/ 目录）的解析函数。 */
	resolveCardsDir?: () => string;
}

/** 注册交卷工具（pi 扩展入口）：pao_deliver_card。owner/驱动器侧专用；worker 永不跑 git。 */
export function registerDeliveryTools(pi: ExtensionAPI, options?: DeliveryToolsOptions): void {
	pi.registerTool({
		name: "pao_deliver_card",
		label: "交卷",
		description:
			"交卷自动化（§13，owner/驱动器侧专用，worker 永不跑 git）：对已交付卡机械生成提交信息（卡NNNN 目标 · 状态 · 验收结果）并提交。stage 范围＝认领基线比对本卡差异清单，逐路径 add、禁 git add -A，清单外改动不碰。机械验收未过或状态非已交付会拒绝交卷；无改动则幂等跳过。只 commit 不 push，推送由用户手动。支持单卡或卡号数组批量，串行执行。",
		parameters: deliveryParams,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const branch = ctx?.sessionManager.getBranch();
			const text = await executeDelivery(params, options, signal, branch);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}

/*
 * 配合点说明（不改他人文件的接线项）：
 * 1. §11 驱动器：pao_verify_card 结论=全过自动交付 后自动调 deliverCard(cardsDir, 卡号)——全自动闭环
 *    的交卷入口即本模块函数，工具只是壳；收尾报告的「N 个提交未推送」由驱动器聚合 results 得出。
 * 2. src/pao/cards/index.ts：追加 export * from "./delivery.ts"（并行代理同文件在改，留给接线批）。
 * 3. worker 侧无本工具：worker 工具装载清单不含 pao_deliver_card/pao_verify_card（纪律由装载层保证，本模块不重复设防）。
 */
