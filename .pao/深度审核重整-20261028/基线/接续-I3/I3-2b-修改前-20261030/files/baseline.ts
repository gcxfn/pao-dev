import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { pathKey } from "../shared/path-key.ts";
import type { ExecutionBinding } from "./execution-context.ts";
import { runCardProcess } from "./process.ts";

/**
 * 认领基线快照（架构 §14 交叉核对、R14 2026-10-02 K3 批）：
 * - 认领（待认领→进行中）时把当刻 `git status --porcelain -z` 快照落一份入任务工作区
 *   （<卡目录>/../基线/卡NNNN-基线.txt）——这是后续比对的基线，不是可选装饰；
 * - 交回执比对时取当前 status 减基线：用户既有未提交改动不算 worker 的账，
 *   防「用户脏工作树被冒领为 worker 产物」淹没真信号；
 * - 用 -z（NUL 分隔）取原始路径：含空格的路径 porcelain 会加 C 风格引号
 *   （core.quotepath=off 也不例外），-z 才拿到未转义真名——中文/空格路径（G1-14）由此保真；
 * - PAO 编排区（.pao/）排除在差分检测面外：卡/回执/基线快照/证据是 pao 自己的状态文件，
 *   永远会出现在 status 里，不排除则全是误报；落在编排区的 worker 产物由回执产物清单核对，
 *   这是边界，如实标注不算已检测；
 * - 未跟踪目录展开到文件级（-uall，2026-10-05 修）：全新目录场景 git 只报目录级条目
 *   （`?? 产出/`），回执声明的是文件级路径，目录级比对会把真实产物误判成「虚报+越界」；
 * - 派发链自写系统文件豁免（2026-10-05 修，集中清单见 SYSTEM_FILE_BASENAMES）：基线快照/
 *   黑板/四指标账/用量账是派发链自己写的状态文件，不算 worker 越界、不卷进交卷提交
 *   （自定布局下工作区不在 .pao/ 内，按文件名豁免）；
 * - git 不可见路径（.gitignore 覆盖区）同样不在检测面，由 worker 工具层路径约束兜底；
 * - 快照失败（非 git 仓库/git 不可用）不阻断认领，返回 可用:false + 原因，比对时如实报不可用；
 * - checkBoundaryWrite（§14 越界写检测，2026-10-02 定案）：diffAgainstBaseline 的 git 真值
 *   比对回执声明的产物清单，虚报/越界/干净三态结构化亮出——纯函数，交卷/验收/扇出同源调用。
 */

/** 差分检测面排除的编排区路径（相对项目根，git pathspec 级整区排除） */
const EXCLUDED_ORCH_PATHS = [".pao"];

/** 卡片与工作流共用的 Git 检测范围，按调用时的项目目录解析。 */
export const PROJECT_CONTENT_PATHSPECS = [".", ...EXCLUDED_ORCH_PATHS.map((p) => `:(exclude)${p}`)];

/**
 * 派发链自写系统文件豁免（§14 检测面，集中一处清单）：认领基线快照（基线/卡NNNN-基线.txt）、
 * 任务黑板（黑板.md）、结卡四指标账（四指标账.txt）、跨会话用量账（用量账.jsonl）都是派发链
 * 自己写的状态文件，不是 worker 的产物——不算 worker 越界，也不卷进交卷提交。标准布局下
 * 它们都在 .pao/ 编排区内（EXCLUDED_ORCH_PATHS 的 pathspec 级排除已覆盖）；自定布局
 * （卡目录不在 .pao 下）时豁免——但收窄到真实落点：黑板/账只在任务工作区根层
 * （路径不含斜杠），基线快照只在 基线/ 直接子级。worker 产物里的同名文件
 * （产出/黑板.md、产出/卡1-基线.txt）不享受豁免，不会被静默丢出交卷 commit
 * （2026-10-05 修：被误算 worker 越界；同日对抗性验收收窄层级）。
 */
const SYSTEM_FILE_BASENAMES = new Set(["黑板.md", "四指标账.txt", "用量账.jsonl"]);
const SYSTEM_FILE_PATTERN = /^卡\d+-基线\.txt$/;

/** 是否派发链自写的系统文件：根层 basename 命中，或 基线/ 直接子级的快照文件名命中。 */
export function isDispatchSystemPath(p: string): boolean {
	const segments = p.split("/");
	const name = segments.at(-1) ?? "";
	const atRoot = segments.length === 1;
	const inBaselineDir = segments.at(-2) === "基线";
	return (atRoot && SYSTEM_FILE_BASENAMES.has(name)) || (inBaselineDir && SYSTEM_FILE_PATTERN.test(name));
}

export interface StatusEntry {
	状态: string;
	文件: string;
}

export interface ClaimBaseline {
	可用: boolean;
	/** 快照文件路径（可用时才有） */
	快照路径?: string;
	/** 认领当刻工作树已有的改动条数（用户既有脏文件数） */
	既有条目数: number;
	/** 项目根（git 仓库顶层；不可用时缺省） */
	项目根?: string;
	/** 不可用原因（非 git 仓库/git 不可用） */
	原因?: string;
	/** 以下内容证据只在 Git 内容基线成功固定时出现。 */
	尝试?: number;
	执行根?: string;
	仓库根?: string;
	HEAD?: string;
	内容Tree?: string;
	内容Ref?: string;
	内容摘要?: string;
	/** 认领时的代码内容摘要；即使调用方未建立 execution-context，也由真实 Git tree 固定。 */
	内容指纹?: string;
}

export interface BaselineDiff {
	基线可用: boolean;
	/** 基线之外的新增改动 = worker 产物候选（文件级精度，架构 §14 边界） */
	worker改动: StatusEntry[];
	/** 基线里已有的既有改动条数（不算 worker 的账） */
	既有条目数: number;
	汇总: string;
	/** 项目根（可用时带回，供越界核查把绝对路径声明归一为相对路径） */
	项目根?: string;
	/**
	 * 认领时验收声明的内容哈希（S5 包2 声明文件内容变化使原许可失效）：
	 * 快照里记了才有；机械验收自动交付前与当前验收字段比对，不一致即原审失效须重审。
	 */
	验收哈希?: string;
	原因?: string;
	/** 认领时的真实内容树；缺省表示读取的是旧版仅状态快照。 */
	基线Tree?: string;
	当前Tree?: string;
	基线HEAD?: string;
	当前HEAD?: string;
	/** true 表示路径集合未变，但至少一个文件的内容已经变化。 */
	内容变化?: boolean;
	/** 捕获内容树前后一致；false 时基线不可用，禁止放行。 */
	捕获稳定?: boolean;
	内容摘要?: string;
	/** 本次实际读取内容树的工作根，供受管验收证明没有从卡目录推算执行根。 */
	当前ContentRoot?: string;
}

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await runCardProcess("git", ["-c", "core.quotepath=off", ...args], cwd, Infinity, undefined, signal);
	if (result.code !== 0) throw new Error(result.stderr || `git exited with code ${result.code}`);
	return result.stdout;
}

/**
 * git status --porcelain -z 解析：NUL 分隔，路径原样（无 C 风格引号）。
 * 条目格式 "XY 路径\0"；重命名/拷贝条目后跟第二个 NUL 字段（原路径）。
 */
export async function gitStatusEntries(projectRoot: string, signal?: AbortSignal): Promise<StatusEntry[]> {
	const pathspecs = [
		"status",
		"--porcelain",
		"-z",
		// 未跟踪目录展开到文件级：全新目录场景（目录里无已跟踪文件）git 只报目录级
		// `?? 产出/`，与回执的文件级声明比对不上（2026-10-05 修）
		"-uall",
		"--",
		...PROJECT_CONTENT_PATHSPECS,
	];
	const out = await runGit(pathspecs, projectRoot, signal);
	const fields = out.split("\0");
	const entries: StatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field) continue;
		const xy = field.slice(0, 2);
		const file = field.slice(3);
		// X 或 Y 带 R/C 时下一字段是原路径，消费掉（显示为 新 -> 旧）
		if (/[RC]/.test(xy)) {
			const originalPath = fields[++i] ?? "";
			entries.push({ 状态: xy.trim(), 文件: `${file} -> ${originalPath}` });
		} else {
			entries.push({ 状态: xy.trim() || "??", 文件: file });
		}
	}
	// 派发链自写系统文件（基线快照/黑板/账）不算 worker 改动（集中豁免清单，见模块头注）
	return entries.filter((e) => !e.文件.split(" -> ").some(isDispatchSystemPath));
}

/**
 * 认领基线快照文件路径（与 snapshotClaimBaseline 的落盘位置同源，核查/交卷侧按它找基线）。
 * 快照目录 = 卡目录上级的 基线/（任务工作区内，不进项目源码区）。
 */
export function baselineSnapshotPath(cardDir: string, cardNo: number | string, attempt?: number): string {
	const seq = String(cardNo).padStart(4, "0");
	return path.join(
		path.resolve(cardDir),
		"..",
		"基线",
		attempt === undefined ? `卡${seq}-基线.txt` : `卡${seq}-尝试${attempt}-基线.json`,
	);
}

export interface CapturedContentTree {
	executionRoot: string;
	repositoryRoot: string;
	head: string;
	tree: string;
	status: StatusEntry[];
	untracked: string[];
	untrackedSet: Set<string>;
	firstTree: string;
}

function temporaryIndexPath(commonGitDir: string): string {
	return path.join(
		commonGitDir,
		`pao-content-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
}

/**
 * 以临时 index 捕获真实内容 tree。
 *
 * 临时 index 放在仓库的共同 Git 管理目录，避免在用户工作根制造未跟踪文件；
 * `writeContentTree` 只 add `PROJECT_CONTENT_PATHSPECS`，因此 .pao、执行锁和日志
 * 与 status 差分使用同一个内容边界。
 */
export async function captureContentTree(
	executionRoot: string,
	signal?: AbortSignal,
	requireRepositoryRoot = false,
	verifyStable = true,
): Promise<CapturedContentTree> {
	signal?.throwIfAborted();
	const cwd = path.resolve(executionRoot);
	const repositoryRoot = (await runGit(["rev-parse", "--show-toplevel"], cwd, signal)).trim();
	if (!repositoryRoot) throw new Error("git rev-parse --show-toplevel 未返回仓库顶层");
	if (requireRepositoryRoot && !sameExecutionPath(repositoryRoot, cwd)) {
		throw new Error("执行根不是仓库根，拒绝从子目录建立不完整内容基线");
	}
	const head = (await runGit(["rev-parse", "HEAD"], repositoryRoot, signal)).trim();
	if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error(`无效 HEAD：${head || "(空)"}`);
	const commonGitDir = (
		await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryRoot, signal)
	).trim();
	if (!commonGitDir) throw new Error("git rev-parse --git-common-dir 未返回共同 Git 目录");
	const index = temporaryIndexPath(commonGitDir);
	try {
		const env = { ...process.env, GIT_INDEX_FILE: index };
		const firstTree = await writeContentTree(repositoryRoot, env, signal);
		const firstStatus = await gitStatusEntries(repositoryRoot, signal);
		if (verifyStable) {
			const secondTree = await writeContentTree(repositoryRoot, env, signal);
			const secondStatus = await gitStatusEntries(repositoryRoot, signal);
			if (firstTree !== secondTree || JSON.stringify(firstStatus) !== JSON.stringify(secondStatus)) {
				throw new Error("工作树内容在内容树捕获期间发生变化");
			}
		}
		const tree = firstTree;
		if (!/^[a-f0-9]{40,64}$/i.test(tree)) throw new Error(`无效内容 tree：${tree || "(空)"}`);
		const untrackedText = await runGit(
			["ls-files", "--others", "--exclude-standard", "-z", "--", ...PROJECT_CONTENT_PATHSPECS],
			repositoryRoot,
			signal,
		);
		const untracked = untrackedText.split("\0").filter(Boolean);
		return {
			executionRoot: repositoryRoot,
			repositoryRoot,
			head,
			tree,
			status: firstStatus,
			untracked,
			untrackedSet: new Set(untracked),
			firstTree: tree,
		};
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	} finally {
		try {
			await import("node:fs/promises").then(({ rm }) => rm(index, { force: true }));
		} catch {
			// 临时索引清理失败不掩盖已取得的主结果；错误在调用处仍需真实暴露。
		}
	}
}

async function writeContentTree(repositoryRoot: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
	await runGitWithEnv(["read-tree", "HEAD"], repositoryRoot, env, signal);
	await runGitWithEnv(["add", "-A", "--", ...PROJECT_CONTENT_PATHSPECS], repositoryRoot, env, signal);
	return (await runGitWithEnv(["write-tree"], repositoryRoot, env, signal)).trim();
}

async function runGitWithEnv(
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<string> {
	const result = await runCardProcess(
		"git",
		["-c", "core.quotepath=off", "-c", "core.autocrlf=false", ...args],
		cwd,
		Infinity,
		env,
		signal,
	);
	if (result.code !== 0) throw new Error(result.stderr || `git exited with code ${result.code}`);
	return result.stdout;
}

function parseHeader(text: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^# ${escaped}: (.*)$`, "m").exec(text)?.[1]?.trim();
}

function sameExecutionPath(left: string | undefined, right: string): boolean {
	if (!left) return false;
	return (
		pathKey(path.resolve(left).replace(/\\/g, "/")).replace(/\/+$/, "") ===
		pathKey(path.resolve(right).replace(/\\/g, "/")).replace(/\/+$/, "")
	);
}

/**
 * 认领时落基线快照。项目根用 `git rev-parse --show-toplevel` 从卡目录向上找，
 * 兼容平铺布局（<项目>/.pao/卡）与任务工作区布局（<项目>/.pao/<任务名>/卡）。
 */
export async function snapshotClaimBaseline(
	cardDir: string,
	cardNo: number | string,
	options: {
		owner?: string;
		时间?: string;
		验收?: string;
		attempt?: number;
		execution?: ExecutionBinding;
		signal?: AbortSignal;
	} = {},
): Promise<ClaimBaseline> {
	const unavailable = (reason: string): ClaimBaseline => ({ 可用: false, 既有条目数: 0, 原因: reason });
	try {
		if (options.execution) {
			if (!sameExecutionPath(options.execution.key.cardsDir, cardDir)) {
				return unavailable("execution-context 的 cardsDir 与本次基线不一致");
			}
			if (options.execution.key.cardNo !== Number(cardNo)) {
				return unavailable("execution-context 的 cardNo 与本次基线不一致");
			}
			if (options.attempt !== undefined && options.attempt !== options.execution.key.attempt) {
				return unavailable("基线 attempt 与 execution-context 不一致");
			}
		}
		const attempt = options.attempt ?? options.execution?.key.attempt;
		const snapshotPath = baselineSnapshotPath(cardDir, cardNo, attempt);
		if (attempt !== undefined) {
			// 已固定的历史基线绝不重写；同 attempt 再调用只回读原证据。
			try {
				const existingText = await readFile(snapshotPath, "utf8");
				if (existingText.trimStart().startsWith("{")) {
					const existing = JSON.parse(existingText);
					if (
						existing.cardNo !== Number(cardNo) ||
						existing.attempt !== attempt ||
						(options.execution &&
							(existing.bindingDigest !== options.execution.bindingDigest ||
								existing.snapshotDigest !== options.execution.snapshotDigest ||
								!sameExecutionPath(existing.executionRoot, options.execution.executionRoot)))
					) {
						return unavailable("既有尝试基线与当前执行绑定不符；保留原件，拒绝重用或覆盖");
					}
					return {
						可用: true,
						快照路径: snapshotPath,
						既有条目数: existing.statusEntries?.length ?? 0,
						项目根: existing.projectRoot,
						尝试: attempt,
						执行根: existing.executionRoot,
						仓库根: existing.repositoryRoot,
						HEAD: existing.head,
						内容Tree: existing.tree,
						内容Ref: existing.ref,
						内容摘要: existing.contentDigest,
					};
				}
				if (options.execution) return unavailable("受管执行不能复用无绑定的旧式基线");
				const existingEntries = parseSnapshot(existingText);
				return {
					可用: true,
					快照路径: snapshotPath,
					既有条目数: Number(parseHeader(existingText, "既有条目数") ?? existingEntries.length),
					项目根: parseHeader(existingText, "项目根"),
					尝试: attempt,
					执行根: parseHeader(existingText, "执行根"),
					仓库根: parseHeader(existingText, "仓库根"),
					HEAD: parseHeader(existingText, "HEAD"),
					内容Tree: parseHeader(existingText, "内容Tree"),
					内容Ref: parseHeader(existingText, "内容Ref"),
					内容摘要: parseHeader(existingText, "内容摘要"),
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const requestedRoot = options.execution?.executionRoot ?? cardDir;
		const first = await captureContentTree(requestedRoot, options.signal, options.execution !== undefined, false);
		const second = await captureContentTree(first.executionRoot, options.signal, options.execution !== undefined);
		if (first.tree !== second.tree || first.head !== second.head) {
			return unavailable("工作树内容在基线捕获期间发生变化，已拒绝建立基线，须重新认领");
		}
		const projectRoot = options.execution?.projectRoot ?? first.repositoryRoot;
		const ref =
			attempt !== undefined
				? `refs/pao-execution/baselines/card-${String(Number(cardNo)).padStart(4, "0")}-attempt-${attempt}`
				: `refs/pao-execution/baselines/legacy-card-${String(Number(cardNo)).padStart(4, "0")}-${Date.now()}`;
		await runGit(["update-ref", ref, first.tree], first.repositoryRoot, options.signal);
		const contentDigest = `sha256:${createHash("sha256").update(`${first.head}:${first.tree}`).digest("hex")}`;
		const header = [
			`# 卡${String(cardNo).padStart(4, "0")} 认领基线（R14：认领时快照，交回执比对时当前 status 减本快照）`,
			`# 时间: ${options.时间 ?? new Date().toISOString()}`,
			`# owner: ${options.owner ?? "(未记)"}`,
			...(attempt !== undefined ? [`# 尝试: ${attempt}`] : []),
			`# 项目根: ${projectRoot}`,
			`# 执行根: ${first.executionRoot}`,
			`# 仓库根: ${first.repositoryRoot}`,
			`# HEAD: ${first.head}`,
			`# 内容Tree: ${first.tree}`,
			`# 内容Ref: ${ref}`,
			`# 内容摘要: ${contentDigest}`,
			`# 捕获前后一致: true`,
			`# 排除: ${EXCLUDED_ORCH_PATHS.join("、")}(编排区)＋派发链自写文件(基线快照/黑板/账,产物由回执清单核对)`,
			`# 既有条目数: ${first.status.length}`,
			// S5 包2 声明哈希记账：验收字段是外部声明的可执行内容，认领先记内容哈希，
			// 机械验收自动交付前比对——内容一变即原审失效（防 worker 改卡验收自我放行后悄悄过验收）。
			...(options.验收 !== undefined
				? [`# 验收哈希: ${createHash("sha256").update(options.验收, "utf8").digest("hex")}`]
				: []),
		].join("\n");
		const body = first.status.map((e) => `${e.状态}\t${e.文件}`).join("\n");
		if (attempt !== undefined) {
			const evidence = {
				schemaVersion: 1,
				cardNo: Number(cardNo),
				attempt,
				owner: options.owner,
				time: options.时间 ?? new Date().toISOString(),
				projectRoot,
				executionRoot: first.executionRoot,
				repositoryRoot: first.repositoryRoot,
				head: first.head,
				tree: first.tree,
				ref,
				contentDigest,
				contentFingerprint: contentDigest,
				captureStable: true,
				bindingDigest: options.execution?.bindingDigest,
				snapshotDigest: options.execution?.snapshotDigest,
				statusEntries: first.status,
				untracked: first.untracked,
				acceptanceHash:
					options.验收 !== undefined ? createHash("sha256").update(options.验收, "utf8").digest("hex") : undefined,
			};
			writeFileAtomic(snapshotPath, `${JSON.stringify(evidence, null, 2)}\n`);
		} else {
			writeFileAtomic(snapshotPath, `${header}\n${first.status.length > 0 ? `${body}\n` : ""}`);
		}
		return {
			可用: true,
			快照路径: snapshotPath,
			既有条目数: first.status.length,
			项目根: projectRoot,
			尝试: attempt,
			执行根: first.executionRoot,
			仓库根: first.repositoryRoot,
			HEAD: first.head,
			内容Tree: first.tree,
			内容Ref: ref,
			内容摘要: contentDigest,
			内容指纹: contentDigest,
		};
	} catch (error) {
		options.signal?.throwIfAborted();
		return unavailable(String((error as Error).message).slice(0, 300));
	}
}

/** 解析快照文件：条目行 = "XY\t路径"（跳过 # 注释头）。 */
export function parseSnapshot(text: string): StatusEntry[] {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0 && !line.startsWith("#"))
		.map((line) => {
			const tab = line.indexOf("\t");
			if (tab === -1) return { 状态: line.slice(0, 2).trim(), 文件: line.slice(3) };
			return { 状态: line.slice(0, tab).trim(), 文件: line.slice(tab + 1) };
		});
}

/**
 * 交回执比对（架构 §14：比对时机 = 交回执时，主控侧执行）：
 * 当前 git status 减认领基线 = worker 改动候选。文件级精度：worker 修改了
 * 基线里已脏的文件时，无论暂存状态是否变化，都不算 worker 新改动（边界如实标注，
 * 由交卷差异核对与审查卡兜文件内质量）。
 */
export async function diffAgainstBaseline(snapshotPath: string, signal?: AbortSignal): Promise<BaselineDiff> {
	signal?.throwIfAborted();
	let baseline: StatusEntry[];
	let projectRoot: string | undefined;
	let acceptanceHash: string | undefined;
	let executionRoot: string | undefined;
	let baselineTree: string | undefined;
	let baselineHead: string | undefined;
	let contentTreeBaseline = false;
	try {
		const text = await readFile(snapshotPath, "utf8");
		if (text.trimStart().startsWith("{")) {
			contentTreeBaseline = true;
			const raw = JSON.parse(text) as Record<string, unknown>;
			baseline = Array.isArray(raw.statusEntries) ? (raw.statusEntries as StatusEntry[]) : [];
			projectRoot = typeof raw.projectRoot === "string" ? raw.projectRoot : undefined;
			executionRoot = typeof raw.executionRoot === "string" ? raw.executionRoot : undefined;
			baselineTree = typeof raw.tree === "string" ? raw.tree : undefined;
			baselineHead = typeof raw.head === "string" ? raw.head : undefined;
			acceptanceHash = typeof raw.acceptanceHash === "string" ? raw.acceptanceHash : undefined;
		} else {
			baseline = parseSnapshot(text);
			projectRoot = parseHeader(text, "项目根");
			acceptanceHash = /^# 验收哈希: ([0-9a-f]{64})$/m.exec(text)?.[1];
			executionRoot = parseHeader(text, "执行根");
			baselineTree = parseHeader(text, "内容Tree");
			baselineHead = parseHeader(text, "HEAD");
		}
	} catch (error) {
		signal?.throwIfAborted();
		return {
			基线可用: false,
			worker改动: [],
			既有条目数: 0,
			汇总: "基线快照不可读，比对无法进行",
			原因: String((error as Error).message).slice(0, 300),
		};
	}
	if (!projectRoot || !executionRoot) {
		return { 基线可用: false, worker改动: [], 既有条目数: baseline.length, 汇总: "快照缺项目根，比对无法进行" };
	}
	if (!contentTreeBaseline) {
		let current: StatusEntry[];
		try {
			current = await gitStatusEntries(projectRoot, signal);
		} catch (error) {
			signal?.throwIfAborted();
			return {
				基线可用: false,
				worker改动: [],
				既有条目数: baseline.length,
				汇总: "git 状态不可用，比对无法进行",
				原因: String((error as Error).message).slice(0, 300),
			};
		}
		// 文件级基线：既有脏文件后来被暂存或再次改动，也不能冒认成本卡的新产物。
		const base = new Set(baseline.flatMap((e) => e.文件.split(" -> ")));
		const workerChanges = current.filter((e) => e.文件.split(" -> ").every((p) => !base.has(p)));
		const totals =
			workerChanges.length === 0
				? `无基线外改动（既有 ${baseline.length} 条不计 worker 的账）`
				: `基线外改动 ${workerChanges.length} 个文件:${workerChanges.map((c) => `${c.状态} ${c.文件}`).join("、")}`;
		return {
			基线可用: true,
			worker改动: workerChanges,
			既有条目数: baseline.length,
			项目根: projectRoot,
			...(acceptanceHash !== undefined ? { 验收哈希: acceptanceHash } : {}),
			捕获稳定: true,
			汇总: totals,
		};
	}
	let currentCapture: CapturedContentTree;
	try {
		currentCapture = await captureContentTree(executionRoot, signal);
		const after = await captureContentTree(executionRoot, signal);
		if (currentCapture.tree !== after.tree || currentCapture.head !== after.head) {
			return {
				基线可用: false,
				worker改动: [],
				既有条目数: baseline.length,
				项目根: projectRoot,
				汇总: "当前代码内容在核对期间发生变化，拒绝对旧检查结果放行",
				原因: "CAPTURE_UNSTABLE",
				捕获稳定: false,
			};
		}
	} catch (error) {
		signal?.throwIfAborted();
		const reason = String((error as Error).message).slice(0, 300);
		return {
			基线可用: false,
			worker改动: [],
			既有条目数: baseline.length,
			汇总: /index|bad signature|fatal/i.test(reason)
				? "git 状态不可用，比对无法进行"
				: "当前代码内容不可用，比对无法进行",
			原因: reason,
		};
	}
	if (contentTreeBaseline && baselineTree) {
		let changed: StatusEntry[];
		try {
			changed = await diffTrees(executionRoot, baselineTree, currentCapture.tree, signal);
		} catch (error) {
			signal?.throwIfAborted();
			return {
				基线可用: false,
				worker改动: [],
				既有条目数: baseline.length,
				项目根: projectRoot,
				基线Tree: baselineTree,
				当前Tree: currentCapture.tree,
				汇总: "内容树差异不可读，比对无法进行",
				原因: String((error as Error).message).slice(0, 300),
			};
		}
		const workerChanges = changed.map((entry) =>
			entry.状态 === "A" && currentCapture.untrackedSet.has(entry.文件) ? { ...entry, 状态: "??" } : entry,
		);
		const contentChanged = changed.length > 0;
		const headChanged = baselineHead !== undefined && baselineHead !== currentCapture.head;
		const totals =
			changed.length === 0
				? `无基线外改动（与认领基线 tree 一致；既有 ${baseline.length} 条不计 worker 的账）${
						headChanged ? "；但 HEAD 已变化，动作前须复核" : ""
					}`
				: `基线外改动 ${changed.length} 个文件:${workerChanges.map((c) => `${c.状态} ${c.文件}`).join("、")}${
						headChanged ? `；HEAD 已从 ${baselineHead} 漂移到 ${currentCapture.head}` : ""
					}`;
		return {
			// 内容基线仍可用于比对本尝试；HEAD 漂移单独作为原因交给动作侧拒绝。
			// 若这里把基线与 HEAD 混成不可用，worker 在认领后改文件时会跳过越界核查。
			基线可用: true,
			worker改动: workerChanges,
			既有条目数: baseline.length,
			项目根: projectRoot,
			...(acceptanceHash !== undefined ? { 验收哈希: acceptanceHash } : {}),
			基线Tree: baselineTree,
			当前Tree: currentCapture.tree,
			基线HEAD: baselineHead,
			当前HEAD: currentCapture.head,
			内容变化: contentChanged,
			捕获稳定: true,
			内容摘要: `sha256:${createHash("sha256").update(`${currentCapture.head}:${currentCapture.tree}`).digest("hex")}`,
			当前ContentRoot: currentCapture.executionRoot,
			汇总: totals,
			...(headChanged ? { 原因: "HEAD 在认领基线后发生变化，须重新核对整合目标" } : {}),
		};
	}
	return {
		基线可用: false,
		worker改动: [],
		既有条目数: baseline.length,
		项目根: projectRoot,
		汇总: "attempt 基线缺少内容 tree，拒绝仅按路径放行",
		原因: "CONTENT_TREE_MISSING",
	};
}

async function diffTrees(
	repoRoot: string,
	beforeTree: string,
	afterTree: string,
	signal?: AbortSignal,
): Promise<StatusEntry[]> {
	if (beforeTree === afterTree) return [];
	const out = await runGit(
		[
			"diff",
			"--name-status",
			"-z",
			"--no-ext-diff",
			"--no-textconv",
			beforeTree,
			afterTree,
			"--",
			...PROJECT_CONTENT_PATHSPECS,
		],
		repoRoot,
		signal,
	);
	const fields = out.split("\0");
	const entries: StatusEntry[] = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index++]?.trim();
		if (!status) continue;
		const firstPath = fields[index++];
		if (!firstPath) continue;
		if (status.startsWith("R") || status.startsWith("C")) {
			const secondPath = fields[index++];
			entries.push({
				状态: status[0] ?? status,
				文件: `${secondPath ?? firstPath} -> ${firstPath}`,
			});
		} else {
			entries.push({ 状态: status[0] ?? status, 文件: firstPath });
		}
	}
	return entries
		.filter((entry) => !entry.文件.split(" -> ").some(isDispatchSystemPath))
		.sort((left, right) => left.文件.localeCompare(right.文件));
}

// ============================================================================
// §14 越界写检测：git 真值（基线外改动）比对回执声明的产物清单，纯函数供交卷/验收/扇出调用
// ============================================================================

export interface BoundaryWriteCheck {
	/** 干净 / 虚报 / 虚报+越界 / 越界 / 无法核对（基线不可用等，如实标注不猜） */
	结论: "干净" | "虚报" | "虚报+越界" | "越界" | "无法核对";
	/** 虚报：回执声明了但 git 真值没有的产物（说了没做）；检测面外声明不在此列 */
	虚报: string[];
	/** 越界：git 真值有但回执没声明的改动（做了没说），带状态码 */
	越界: string[];
	/** 相符：声明与真值对得上的改动（精确匹配或目录声明覆盖） */
	相符: string[];
	/** 不可核验：声明落在编排区（.pao）等工作区外 git 检测面——git 无法核验，如实亮出不算虚报 */
	不可核验: string[];
	汇总: string;
	/** 无法核对时的原因（基线不可读 / git 不可用等） */
	原因?: string;
}

export interface ReviewEvidenceVersion {
	sourceTree: string;
	copyTree: string;
	boundary: BoundaryWriteCheck;
}

/** 路径归一：反斜杠→正斜杠、去 ./ 前缀与首尾斜杠、项目根内的绝对路径折成相对路径 */
function normalizePath(p: string, projectRoot?: string): string {
	let out = p.trim().replace(/\\/g, "/");
	if (projectRoot) {
		const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
		// 根前缀判定的大小写折叠走 pathKey 正本（win32 不敏感，posix 精确）
		if (pathKey(out) === pathKey(root)) return "";
		if (pathKey(out).startsWith(`${pathKey(root)}/`)) out = out.slice(root.length + 1);
	}
	while (out.startsWith("./")) out = out.slice(2);
	return out.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** 真值比对同异：Windows 路径大小写不敏感（shared/path-key 唯一实现），其余平台精确匹配 */
function samePath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

/** 声明是否覆盖某真值路径：精确相等，或声明为目录（前缀）盖住其下文件 */
function declarationOverride(declarationPath: string, truthPath: string): boolean {
	if (samePath(declarationPath, truthPath)) return true;
	const prefix = `${declarationPath}/`;
	return truthPath.startsWith(prefix) || pathKey(truthPath).startsWith(pathKey(prefix));
}

/** 落在 git 检测面外：编排区（.pao）、派发链自写系统文件或工作区外的绝对路径（git 真值永远看不到） */
function isOutsideDetectionSurface(p: string): boolean {
	if (EXCLUDED_ORCH_PATHS.some((ex) => p === ex || p.startsWith(`${ex}/`))) return true;
	if (isDispatchSystemPath(p)) return true;
	return /^(?:[a-zA-Z]:\/|\/)/.test(p);
}

/**
 * §14 越界写检测（2026-10-02 定案）：以 git 为真值机械比对 worker 实际改动与回执声明，
 * 虚报（说了没做）与越界（做了没说）都结构化亮出，全自动不靠信任。文件级精度（边界如实）；
 * 写了又删回原样 git 不可见 = 无害豁免；比对基线 = 认领快照减出的 BaselineDiff。
 * 纯函数无 IO，交卷（§13）/机械验收（§12）/扇出交回执侧都可调。
 */
export function checkBoundaryWrite(
	diff: BaselineDiff,
	declarationArtifacts: readonly string[],
	options: { 项目根?: string } = {},
): BoundaryWriteCheck {
	if (!diff.基线可用) {
		return {
			结论: "无法核对",
			虚报: [],
			越界: [],
			相符: [],
			不可核验: [],
			汇总: `越界比对无法进行——${diff.汇总}`,
			...(diff.原因 ? { 原因: diff.原因 } : {}),
		};
	}
	const projectRoot = options.项目根 ?? diff.项目根;
	const declaration = declarationArtifacts.map((p) => normalizePath(p, projectRoot)).filter((p) => p.length > 0);
	// 重命名条目（"新 -> 旧"）按新路径参与比对，报告保留完整行
	const truth = diff.worker改动.map((e) => ({
		状态: e.状态,
		文件: e.文件,
		路径: normalizePath(e.文件.split(" -> ")[0], projectRoot),
	}));
	const claimed = new Set<StatusEntry>();
	const matches: string[] = [];
	const falseReport: string[] = [];
	const unverifiable: string[] = [];
	for (const d of declaration) {
		if (isOutsideDetectionSurface(d)) {
			unverifiable.push(d);
			continue;
		}
		const hit = truth.filter((t) => !claimed.has(t) && declarationOverride(d, t.路径));
		if (hit.length === 0) {
			falseReport.push(d);
		} else {
			for (const t of hit) {
				claimed.add(t);
				matches.push(`${t.状态} ${t.文件}`);
			}
		}
	}
	const outOfScope = truth.filter((t) => !claimed.has(t)).map((t) => `${t.状态} ${t.文件}`);
	const diffSection: string[] = [];
	if (falseReport.length > 0) diffSection.push(`虚报 ${falseReport.length} 项(声明未写):${falseReport.join("、")}`);
	if (outOfScope.length > 0) diffSection.push(`越界 ${outOfScope.length} 处(写未声明):${outOfScope.join("、")}`);
	const footerNote: string[] = [];
	if (matches.length > 0) footerNote.push(`相符 ${matches.length} 项`);
	if (unverifiable.length > 0) footerNote.push(`检测面外声明 ${unverifiable.length} 项不经 git 核验`);
	const verdict =
		falseReport.length > 0 && outOfScope.length > 0
			? "虚报+越界"
			: falseReport.length > 0
				? "虚报"
				: outOfScope.length > 0
					? "越界"
					: "干净";
	const totals =
		verdict === "干净"
			? `比对干净${matches.length > 0 ? `:${matches.length} 项声明与 git 真值相符` : "(无声明、无基线外改动)"}`
			: diffSection.join(";");
	return {
		结论: verdict,
		虚报: falseReport,
		越界: outOfScope,
		相符: matches,
		不可核验: unverifiable,
		汇总: footerNote.length > 0 ? `${totals};${footerNote.join(";")}` : totals,
	};
}

/**
 * 独立审核的证据版本边界：原成果 tree 与审核副本 tree 必须分开。
 *
 * 副本只能相对同一 attempt 基线新增声明证据，且检查后的副本 tree 必须与验收记录一致；
 * 原项目当前内容也必须仍等于该基线。这里复用 Git 差异和越界核查，不另存审核状态。
 */
export async function verifyReviewEvidenceVersion(input: {
	diff: BaselineDiff;
	declarations: readonly string[];
	expectedCopyTree: string;
	expectedCopyRoot?: string;
	expectedSourceTree?: string;
	projectRoot: string;
	signal?: AbortSignal;
}): Promise<ReviewEvidenceVersion> {
	const { diff, expectedCopyTree, projectRoot, signal } = input;
	if (!diff.基线可用 || !diff.基线Tree || !diff.当前Tree || diff.捕获稳定 === false) {
		throw new Error(`审核副本基线不可用：${diff.汇总}${diff.原因 ? `（${diff.原因}）` : ""}`);
	}
	if (!diff.当前ContentRoot || pathKey(path.resolve(diff.当前ContentRoot)) === pathKey(path.resolve(projectRoot))) {
		throw new Error("审核副本必须从独立受管执行根读取，不能把原项目当作审核副本");
	}
	if (
		input.expectedCopyRoot !== undefined &&
		pathKey(path.resolve(diff.当前ContentRoot)) !== pathKey(path.resolve(input.expectedCopyRoot))
	) {
		throw new Error("审核副本实际读取根与 execution-context 不一致");
	}
	if (diff.当前Tree !== expectedCopyTree) {
		throw new Error("审核副本检查后 tree 已变化，须重新独立验证");
	}
	const nonAddition = diff.worker改动.find((entry) => !["A", "??"].includes(entry.状态.trim()));
	if (nonAddition) {
		throw new Error(`审核副本只能新增证据，不能修改、删除或重命名原有文件：${nonAddition.状态} ${nonAddition.文件}`);
	}
	const boundary = checkBoundaryWrite(diff, input.declarations, { 项目根: diff.项目根 ?? projectRoot });
	if (boundary.结论 !== "干净") {
		throw new Error(`审核证据声明与副本真实新增不符：${boundary.汇总}`);
	}
	const currentSource = await captureContentTree(projectRoot, signal);
	if (currentSource.tree !== diff.基线Tree) {
		throw new Error("原项目成果已变化，与审核副本所依据的 attempt 基线不一致");
	}
	if (input.expectedSourceTree !== undefined && input.expectedSourceTree !== diff.基线Tree) {
		throw new Error("审核卡绑定的原成果版本与 attempt 基线不一致");
	}
	return { sourceTree: diff.基线Tree, copyTree: diff.当前Tree, boundary };
}
