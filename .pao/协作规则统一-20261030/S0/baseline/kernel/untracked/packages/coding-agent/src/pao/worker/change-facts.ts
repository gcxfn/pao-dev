import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { baselineSnapshotPath, diffAgainstBaseline, type StatusEntry } from "../cards/baseline.ts";
import { loadCard } from "../cards/cardfile.ts";
import { type ExecutionBinding, resolveExecutionContext } from "../cards/execution-context.ts";
import { pathKey } from "../shared/path-key.ts";
import { readWorkerExecutionFacts } from "./evidence-facts.ts";

export interface WorkerChangeFactsInput {
	/** 当前动作使用的执行绑定；helper 会回读持久记录并核对实时 Git 身份。 */
	readonly binding: ExecutionBinding;
	/** 当前 attempt 的认领基线 JSON。 */
	readonly baselinePath: string;
	/** runner 为该次执行留存的 live 证据路径，支持普通文件与 .gz。 */
	readonly evidencePath: string;
	/** 当前卡的完整路径，用于核对证据头尾身份。 */
	readonly cardPath: string;
	/** 调用方已知当前执行标识时传入；否则只核对卡路径与 attempt。 */
	readonly runId?: string;
	readonly signal?: AbortSignal;
}

export interface WorkerChangeFacts {
	readonly available: boolean;
	readonly created: readonly string[];
	readonly modified: readonly string[];
	readonly deleted: readonly string[];
	/** available=false 时给出具体原因；不使用空数组冒充“没有改动”。 */
	readonly reason?: string;
}

interface AttemptBaseline {
	readonly schemaVersion: 1;
	readonly cardNo: number;
	readonly attempt: number;
	readonly projectRoot: string;
	readonly executionRoot: string;
	readonly repositoryRoot: string;
	readonly head: string;
	readonly tree: string;
	readonly ref: string;
	readonly contentDigest: string;
	readonly bindingDigest: string;
	readonly snapshotDigest: string;
	readonly captureStable: true;
}

type BaselineRead =
	| { readonly ok: true; readonly baseline: AttemptBaseline }
	| { readonly ok: false; readonly reason: string };

function samePath(left: string, right: string): boolean {
	return (
		pathKey(resolve(left).replace(/\\/g, "/")).replace(/\/+$/, "") ===
		pathKey(resolve(right).replace(/\\/g, "/")).replace(/\/+$/, "")
	);
}

function unknown(reason: string): WorkerChangeFacts {
	return { available: false, created: [], modified: [], deleted: [], reason };
}

function bindingMismatch(input: ExecutionBinding, live: ExecutionBinding): string | undefined {
	if (input.bindingDigest !== live.bindingDigest) return "调用方执行绑定摘要与持久绑定不一致";
	if (
		input.key.cardNo !== live.key.cardNo ||
		input.key.attempt !== live.key.attempt ||
		!samePath(input.key.cardsDir, live.key.cardsDir)
	) {
		return "调用方执行绑定 key 与持久绑定不一致";
	}
	if (!samePath(input.projectRoot, live.projectRoot)) return "调用方执行绑定任务根与持久绑定不一致";
	if (!samePath(input.executionRoot, live.executionRoot)) return "调用方执行绑定执行根与持久绑定不一致";
	if (!samePath(input.repositoryRoot, live.repositoryRoot)) return "调用方执行绑定仓库根与持久绑定不一致";
	if (input.snapshotDigest !== live.snapshotDigest) return "调用方输入摘要与持久绑定不一致";
	if (input.worktree.bindingDigest !== live.worktree.bindingDigest) {
		return "调用方宿主工作树摘要与持久绑定不一致";
	}
	return undefined;
}

function stringField(raw: Record<string, unknown>, field: string): string {
	return typeof raw[field] === "string" ? raw[field].trim() : "";
}

async function readAttemptBaseline(
	baselinePath: string,
	binding: ExecutionBinding,
	signal?: AbortSignal,
): Promise<BaselineRead> {
	signal?.throwIfAborted();
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(baselinePath, "utf8"));
	} catch (error) {
		return {
			ok: false,
			reason: `当前 attempt 基线不可读或不是 JSON：${error instanceof Error ? error.message : String(error)}`,
		};
	}
	signal?.throwIfAborted();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "当前 attempt 基线不是对象" };
	}
	const value = raw as Record<string, unknown>;
	const baseline: AttemptBaseline = {
		schemaVersion: value.schemaVersion as 1,
		cardNo: Number(value.cardNo),
		attempt: Number(value.attempt),
		projectRoot: stringField(value, "projectRoot"),
		executionRoot: stringField(value, "executionRoot"),
		repositoryRoot: stringField(value, "repositoryRoot"),
		head: stringField(value, "head"),
		tree: stringField(value, "tree"),
		ref: stringField(value, "ref"),
		contentDigest: stringField(value, "contentDigest"),
		bindingDigest: stringField(value, "bindingDigest"),
		snapshotDigest: stringField(value, "snapshotDigest"),
		captureStable: value.captureStable as true,
	};
	const expectedRef = `refs/pao-execution/baselines/card-${String(binding.key.cardNo).padStart(4, "0")}-attempt-${binding.key.attempt}`;
	const expectedDigest = `sha256:${createHash("sha256").update(`${baseline.head}:${baseline.tree}`).digest("hex")}`;
	if (
		baseline.schemaVersion !== 1 ||
		baseline.cardNo !== binding.key.cardNo ||
		baseline.attempt !== binding.key.attempt
	) {
		return { ok: false, reason: "基线的 schema、卡号或 attempt 与当前执行绑定不一致" };
	}
	if (
		!samePath(baseline.projectRoot, binding.projectRoot) ||
		!samePath(baseline.executionRoot, binding.executionRoot) ||
		!samePath(baseline.repositoryRoot, binding.repositoryRoot)
	) {
		return { ok: false, reason: "基线的任务根、执行根或仓库根与当前执行绑定不一致" };
	}
	if (baseline.bindingDigest !== binding.bindingDigest || baseline.snapshotDigest !== binding.snapshotDigest) {
		return { ok: false, reason: "基线的执行绑定或输入摘要与当前执行绑定不一致" };
	}
	if (
		!/^[a-f0-9]{40,64}$/i.test(baseline.head) ||
		!/^[a-f0-9]{40,64}$/i.test(baseline.tree) ||
		baseline.ref !== expectedRef ||
		baseline.contentDigest !== expectedDigest
	) {
		return { ok: false, reason: "基线的 HEAD、内容树、引用或内容摘要不自洽" };
	}
	if (baseline.captureStable !== true) {
		return { ok: false, reason: "基线没有证明捕获前后内容一致" };
	}
	return { ok: true, baseline };
}

function classifyChanges(
	entries: readonly StatusEntry[],
): Pick<WorkerChangeFacts, "created" | "modified" | "deleted"> | { readonly error: string } {
	const created = new Set<string>();
	const modified = new Set<string>();
	const deleted = new Set<string>();
	for (const entry of entries) {
		const status = entry.状态.trim();
		const paths = status === "R" || status === "C" ? entry.文件.split(" -> ") : [entry.文件];
		const target = paths[0]?.replace(/\\/g, "/");
		if (!target) return { error: `内容树差异缺少路径：${entry.状态} ${entry.文件}` };
		if (status === "A" || status === "??") {
			created.add(target);
		} else if (status === "M" || status === "T") {
			modified.add(target);
		} else if (status === "D") {
			deleted.add(target);
		} else if (status === "R") {
			const original = paths[1]?.replace(/\\/g, "/");
			if (!original) return { error: `重命名差异缺少原路径：${entry.文件}` };
			created.add(target);
			deleted.add(original);
		} else if (status === "C") {
			created.add(target);
		} else {
			return { error: `无法归类内容树差异状态 ${status}：${entry.文件}` };
		}
	}
	return {
		created: [...created].sort((left, right) => left.localeCompare(right)),
		modified: [...modified].sort((left, right) => left.localeCompare(right)),
		deleted: [...deleted].sort((left, right) => left.localeCompare(right)),
	};
}

/**
 * 只读读取当前 attempt 的程序文件改动事实。
 *
 * 事实来源固定为“认领内容 tree → 当前执行根内容 tree”；模型回执 changes、当前
 * Git HEAD 差异以及任务主目录的同名文件都不参与。绑定、基线、证据身份任一不
 * 自洽或执行根不可用时返回 available=false，不退回其他目录猜测。
 */
export async function readWorkerChangeFacts(input: WorkerChangeFactsInput): Promise<WorkerChangeFacts> {
	input.signal?.throwIfAborted();
	let live: ExecutionBinding;
	try {
		live = await resolveExecutionContext(input.binding.key, {
			expectedCurrentAttempt: input.binding.key.attempt,
			requireLiveExecutionRoot: true,
		});
	} catch (error) {
		return unknown(`当前执行绑定不可用：${error instanceof Error ? error.message : String(error)}`);
	}
	const mismatch = bindingMismatch(input.binding, live);
	if (mismatch) return unknown(mismatch);

	let card: ReturnType<typeof loadCard>;
	try {
		card = loadCard(input.binding.key.cardsDir, input.binding.key.cardNo);
	} catch (error) {
		return unknown(`当前卡不可读：${error instanceof Error ? error.message : String(error)}`);
	}
	if (card.frontmatter.attempt !== input.binding.key.attempt) {
		return unknown(`执行绑定 attempt ${input.binding.key.attempt} 不是卡面当前 attempt ${card.frontmatter.attempt}`);
	}
	if (!samePath(card.path, input.cardPath)) {
		return unknown("输入的卡路径不是当前绑定卡路径");
	}
	const expectedBaselinePath = baselineSnapshotPath(
		input.binding.key.cardsDir,
		input.binding.key.cardNo,
		input.binding.key.attempt,
	);
	if (!samePath(input.baselinePath, expectedBaselinePath)) {
		return unknown("基线路径不是当前 attempt 的标准基线路径");
	}

	const evidence = await readWorkerExecutionFacts(input.evidencePath, {
		cardPath: card.path,
		attempt: input.binding.key.attempt,
		...(input.runId !== undefined ? { runId: input.runId } : {}),
	});
	if (!evidence.complete) {
		return unknown(`worker 证据不完整：${evidence.issues.join("；") || "未给出原因"}`);
	}

	const parsedBaseline = await readAttemptBaseline(input.baselinePath, live, input.signal);
	if (!parsedBaseline.ok) return unknown(parsedBaseline.reason);
	const diff = await diffAgainstBaseline(input.baselinePath, input.signal);
	if (!diff.基线可用) {
		return unknown(`内容树差异不可用：${diff.原因 ?? diff.汇总}`);
	}
	if (!diff.当前ContentRoot || !samePath(diff.当前ContentRoot, input.binding.executionRoot)) {
		return unknown("内容树差异读取根与当前执行绑定不一致，拒绝回退任务主目录");
	}
	if (!diff.基线Tree || !diff.当前Tree || diff.基线Tree !== parsedBaseline.baseline.tree) {
		return unknown("内容树差异没有返回与当前 attempt 基线一致的前后 tree");
	}
	const classified = classifyChanges(diff.worker改动);
	if ("error" in classified) return unknown(classified.error);
	return { available: true, ...classified };
}
