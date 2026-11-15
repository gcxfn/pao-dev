import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getPackageDir, isBunBinary } from "../../config.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import { killTree } from "../../utils/kill-tree.ts";
import { diffAgainstBaseline } from "../cards/baseline.ts";
import type { CardBudget } from "../cards/types.ts";
import { SHELL_GUARD_ENV } from "../patrol/wire.ts";
import { PAO_ROLE_ENV } from "../role.ts";
import { archiveWorkerEvidence } from "../shared/evidence.ts";
import { withFileLock } from "../shared/lock.ts";
import { logWarn } from "../shared/log.ts";
import { pathKey } from "../shared/path-key.ts";
import { utcNow } from "../shared/time.ts";
import { BUDGET_REMINDER_ROUNDS } from "./budget.ts";
import { PaoWorkerError } from "./errors.ts";
import { usageStreamComplete } from "./native-usage.ts";
import { MANAGED_PARENT_ENV } from "./parent-lifecycle.ts";
import {
	absorbEvent,
	buildSummary,
	createEventState,
	isReceiptToolCall,
	parseWorkerFinalResult,
	recoverWorkerFinalReceiptFormat,
	type WorkerEventState,
	type WorkerReceipt,
	type WorkerStatus,
} from "./receipt.ts";
import { ProcessRegistry } from "./registry.ts";
import { createWorkerSessionBridge } from "./session-bridge.ts";
import type { WorkerSupervisionRoute } from "./supervision.ts";

/**
 * headless worker 运行器:拉起一次性子进程、从 stdout JSON 事件流收结构化回执、
 * 统一尝试计数、取消先停后放锁(放锁凭据由本运行器签发)、主会话退出停整棵进程树。
 *
 * stdout/stderr 逐 chunk 写入 live 文件；确认结束后，大文件无损压缩为证据正本。
 * 内存只保留有限尾部；流式写失败时回退尾部，若已截断则明确报告证据不完整。
 *
 * 回执落盘与状态推进不归本模块:run() 返回结构化回执,由调用方(主控接线)转交卡片。
 * 同一卡的重试由运行器统一计数(同一调度轮次 = 一个 WorkerRunner 实例);子进程内部
 * 失败不触发独立重试——run() 只 spawn 一次,没有任何重试路径。
 */

// ── 停止确认凭据(签发逻辑收在本模块内,签发符号不导出,外部无法构造) ──────

/** 单个被停进程的停止记录 */
export interface StoppedProcess {
	pid: number;
	/** 归属卡号(登记表里的);无名辅助进程可缺省 */
	卡号?: string;
	/** 停止方式,如 "taskkill /PID 123 /T /F" 或 "SIGTERM" */
	方式: string;
}

/** 签发符号:模块私有,仅 cancel/stopAll 的签发路径可持有 */
const issueSymbol = Symbol("pao-worker-stop-proof");

/**
 * 停止确认凭据:只能由运行器的 cancel/stopAll 签发。
 * 放项目写锁必须出示本凭据(releaseProjectLock 第二参),使「取消 = 先停并确认真停,才放锁」
 * 在代码结构上可验证(架构 §1 后台运行契约 / 契约修订 R05)。
 */
export class StopProof {
	readonly stoppedProcesses: readonly StoppedProcess[];
	readonly stoppedAt: string;

	constructor(credential: symbol, stoppedProcesses: readonly StoppedProcess[]) {
		if (credential !== issueSymbol) {
			throw new PaoWorkerError("无效凭据", "StopProof 只能由运行器的 cancel/stopAll 签发,不能自行构造");
		}
		this.stoppedProcesses = stoppedProcesses;
		this.stoppedAt = utcNow();
	}
}

/** 模块内部签发口:不导出,模块公开面只有 StopProof 类与实例 */
function issueStopConfirmation(stoppedProcesses: readonly StoppedProcess[]): StopProof {
	return new StopProof(issueSymbol, stoppedProcesses);
}

export interface WorkerRunOptions {
	卡号: string;
	/** 正式派发的执行身份；裸卡号仅供直接调用运行器的兼容入口。 */
	卡路径?: string;
	/** 共享任务根（卡、工作流、会话映射）；正式派发必须显式提供。 */
	taskRoot?: string;
	/** worker 的真实执行根；cwd 必须与之一致。 */
	executionRoot?: string;
	worktreeId?: string;
	snapshotDigest?: string;
	worktreeBindingDigest?: string;
	/** cards/execution-context 对 attempt 关联记录计算的摘要；不是宿主工作树摘要。 */
	executionBindingDigest?: string;
	尝试号?: number;
	预算?: CardBudget;
	要求回执?: boolean;
	附加系统提示词?: string[];
	skills?: string[];
	/** 任务提示词,作为最后一个命令行参数传给子进程 */
	提示词: string;
	/** 子进程工作目录,缺省继承当前进程 */
	cwd?: string;
	/** 覆盖可执行文件;缺省用本仓库入口(见 defaultInvocation) */
	命令?: string;
	/** 覆盖基础参数(测试/非 pi 进程用);缺省 = pi 的 --mode json -p --no-session */
	参数?: string[];
	会话标识?: string;
	会话目录?: string;
	模型?: string;
	思考档?: string;
	/** 工具白名单:以 --tools a,b,c 传给子进程(worker 无再派发入口,白名单由主控定) */
	工具白名单?: string[];
	/**
	 * 派发链对外部声明的收窄告警（S5 包2：技能装载面忽略/配方工具截严）；
	 * 不影响执行，随 WorkerReceipt 送达 owner（派单通知/扇出摘要/自动链记录）。
	 */
	派发告警?: string[];
	产物路径?: string[];
	/**
	 * 证据目录覆盖;显式给定时优先。未给时有卡路径放任务工作区 worker-evidence,
	 * 裸运行器放实际执行 cwd 的 .pao/worker-evidence。两种默认都不使用系统临时目录。
	 */
	证据目录?: string;
	环境变量?: Record<string, string>;
	超时毫秒?: number;
	信号?: AbortSignal;
	/**
	 * 登记表归属部门(派单链路填卡.部门,部门并发上限按它数活进程;缺省登记为 null)。
	 */
	部门?: string | null;
	/** 派单理由留痕(登记表审计用,pao_dispatch_card=单卡理由/pao_fanout=批次理由;缺省登记为 null) */
	派单理由?: string | null;
	/**
	 * 锁定工作区(巡库卡派发时由 buildDispatchRunOptions 设置,需求 §6 预案①):
	 * 有值时子进程 env 注入 PAO_SHELL_GUARD_WORKSPACE,worker 会话的 bash/powershell
	 * 调用全部过 shell 护栏(patrol/wire.ts)。非巡库派发不设,零行为。
	 */
	锁定工作区?: string;
	/**
	 * 认领租约(S5 包3,运行器事实):派发链认领时构建,随 spawn 落登记表条目——
	 * 认领时间/租约到期(监督信号,到期不自动放权)/认领代数(孤儿接管代际)。
	 */
	租约?: { 认领时间: string; 租约到期: string; 认领代数: number };
	/** 派发端解析的直接上级路由；只写登记表，监督计时仍归宿主状态机。 */
	supervisionRoute?: WorkerSupervisionRoute;
	/** 本次尝试认领时建立的基线；回执结算后用现有 Git 差异工具给出候选核对证据。 */
	本次认领基线?: string;
}

export interface WorkerRunnerOptions {
	registry?: ProcessRegistry;
	/** 全局缺省证据目录;run() 未指定时用 */
	证据目录?: string;
	/** 用于离线验证树杀失败；正式运行使用 killTree。 */
	树杀?: typeof killTree;
	/** 跨宿主进程共享并发预约；正式宿主指向隔离 PAO_HOME，缺省按执行根边界。 */
	dispatchStateRoot?: string;
}

const PROCESS_AUDIT_ENTRIES = new WeakMap<ActiveEntry, (event: string, detail?: Record<string, unknown>) => void>();

function inputReason(value: string | null | undefined): string | null {
	if (!value) return null;
	// 理由仍保留可感知的前缀；完整派单理由已在卡/回执正本，日志不复制提示词正文。
	return value.slice(0, 160);
}

interface ActiveEntry {
	createdBefore: number;
	pid: number;
	卡号: string;
	/** 本次活动执行绑定的完整卡路径；精确停止时不得用裸卡号猜回。 */
	card_path?: string;
	/** 启动时冻结的尝试号；停止请求必须与它精确一致。 */
	attempt?: number;
	proc: ChildProcess;
	命令: string;
	取消: boolean;
	执行标识: string;
	taskRoot: string;
	executionRoot: string;
	worktreeId?: string;
	/**
	 * stdout 原始行（run() 内 rawLines 的同一引用）:登记表只挂引用不复制,
	 * 读时切片取尾巴（listActive stdoutTail）,不额外占内存、不动结算路径。
	 */
	stdoutLines?: string[];
	/** 中途实时证据(live 流);B 档中途读 worker 输出用,打开失败时缺省 */
	live?: LiveCapture;
	停止?: Promise<StoppedProcess>;
	/**
	 * 上级终止标记(B 档 pao_terminate_card 专用):与 stopAll/信号取消区分,回执 stopReason 记
	 * 「被上级终止」、摘要首行点名,供卡上回执与上级审查留痕。仅 terminate() 路径置位。
	 */
	上级终止?: boolean;
}

/**
 * CLI 与 SDK/Electron 共用当前安装包的构建入口，不把宿主脚本误当作 CLI。
 * 无当前脚本时内嵌构建入口优先（SDK 内嵌/桌面场景不暗退 PATH 上的全局 pao）；
 * 无构建产物的垫片/编译二进制环境保留既有 pao 命令回退，
 * 桌面宿主（Electron）缺内嵌依赖时明确报错，不暗退到机器上的另一个 pi。
 */
export function defaultInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		if (isBunBinary) return { command: process.execPath, args };
		const cli = path.join(getPackageDir(), "dist", "bundle", "cli.js");
		if (!fs.existsSync(cli)) throw new Error(`PAO CLI 构建不存在，请先完成全仓构建：${cli}`);
		return { command: process.execPath, args: [cli, ...args] };
	}
	const embeddedCli = path.join(getPackageDir(), "dist", "bundle", "cli.js");
	if (fs.existsSync(embeddedCli)) return { command: process.execPath, args: [embeddedCli, ...args] };
	if (process.versions.electron)
		throw new Error(
			`PAO 内嵌内核构建缺失（${embeddedCli}），拒绝回落 PATH 上的全局 pao 命令；请重新安装桌面应用或执行 vendor:kernel。`,
		);
	return { command: "pao", args };
}

export function buildArgs(options: WorkerRunOptions): string[] {
	const args = [...(options.参数 ?? ["--mode", "json", "-p", ...(options.会话标识 ? [] : ["--no-session"])])];
	if (options.会话标识) args.push("--session-id", options.会话标识);
	if (options.会话目录) args.push("--session-dir", options.会话目录);
	if (options.模型) args.push("--model", options.模型);
	if (options.思考档) args.push("--thinking", options.思考档);
	if (options.工具白名单 && options.工具白名单.length > 0) args.push("--tools", options.工具白名单.join(","));
	for (const prompt of options.附加系统提示词 ?? []) args.push("--append-system-prompt", prompt);
	for (const skill of options.skills ?? []) args.push("--skill", skill);
	args.push(options.提示词);
	return args;
}

async function awaitClose(proc: ChildProcess, timeoutMs: number): Promise<void> {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			proc.removeListener("close", done);
			proc.removeListener("error", done);
			resolve();
		};
		const timer = setTimeout(() => {
			proc.removeListener("close", done);
			proc.removeListener("error", done);
			resolve();
		}, timeoutMs);
		proc.once("close", done);
		proc.once("error", done);
	});
	if (proc.exitCode === null && proc.signalCode === null) {
		throw new PaoWorkerError("停止失败", `pid=${proc.pid} 未收到退出确认`);
	}
}

function processAuditForEntry(entry: ActiveEntry, event: string, detail: Record<string, unknown> = {}): void {
	PROCESS_AUDIT_ENTRIES.get(entry)?.(event, detail);
}

function executionKey(ref: string): string {
	const key = /[\\/]/.test(ref) ? path.resolve(ref) : ref;
	return pathKey(key);
}

export class WorkerRunner {
	readonly registry: ProcessRegistry;
	readonly #stopController = new AbortController();
	#attempts = new Map<string, number>();
	#active = new Map<string, ActiveEntry>();
	#blocked = new Set<string>();
	#stoppedAll = false;
	#defaultEvidenceDir?: string;
	#killTree: typeof killTree;
	#slots = new Map<string, string | null>();
	#slotWaiters = new Set<() => void>();
	#dispatchStateRoot?: string;

	constructor(options: WorkerRunnerOptions = {}) {
		this.registry = options.registry ?? new ProcessRegistry();
		this.#defaultEvidenceDir = options.证据目录;
		this.#killTree = options.树杀 ?? killTree;
		this.#dispatchStateRoot = options.dispatchStateRoot ? path.resolve(options.dispatchStateRoot) : undefined;
	}

	/** 同一调度轮次内某卡的已用尝试数(供调用方读) */
	attemptCount(cardNo: string): number {
		return this.#attempts.get(executionKey(cardNo)) ?? 0;
	}

	/** 全部卡的尝试计数快照 */
	attemptTable(): Record<string, number> {
		return Object.fromEntries(this.#attempts);
	}

	isRunning(cardNo: string): boolean {
		return this.#matchingEntries(cardNo).length > 0;
	}

	/** 工作树清理门禁使用真实运行器状态；不能由模型或宿主界面自行声明。 */
	isExecutionActive(executionRoot: string): boolean {
		const target = pathKey(path.resolve(executionRoot));
		return [...this.#active.values()].some((entry) => pathKey(entry.executionRoot) === target);
	}

	/** 本轮是否已经显式全停并封锁再派发；单卡 cancel/terminate 不会置位。 */
	isStopped(): boolean {
		return this.#stoppedAll;
	}

	/**
	 * 本轮显式全停的只读取消信号。只有 stopAll() 会同步触发一次，单卡
	 * cancel/terminate 不改它；其他后台链可据此停止等待，不能自行宣告停止成功。
	 */
	get stopSignal(): AbortSignal {
		return this.#stopController.signal;
	}

	/**
	 * 在途 worker 实时快照（全景聚合/worker 实时页钻取用）:
	 * 每项 stdoutTail(行数=50) 从有限内存尾部切片，完整 stdout 持续写入证据文件。
	 * 不碰结算/回执路径。settle 后条目即从列表消失。
	 */
	listActive(): {
		pid: number;
		卡号: string;
		命令: string;
		执行标识: string;
		/** 中途实时证据(live JSONL,边跑边追加):B 档中途查看的读取口;live 打开失败时缺省 */
		中途输出路径?: string;
		/** 中途实时 stderr(live 追加);live 打开失败时缺省 */
		中途stderr路径?: string;
		stdoutTail: (lineCount?: number) => string;
	}[] {
		return [...this.#active.values()].map((entry) => ({
			pid: entry.pid,
			卡号: entry.卡号,
			命令: entry.命令,
			执行标识: entry.执行标识,
			中途输出路径: entry.live?.stdoutPath,
			中途stderr路径: entry.live?.stderrPath,
			stdoutTail: (lineCount = 50): string => (entry.stdoutLines ?? []).slice(-lineCount).join("\n"),
		}));
	}

	#matchingEntries(ref: string): ActiveEntry[] {
		const direct = this.#active.get(executionKey(ref));
		return direct ? [direct] : [...this.#active.values()].filter((entry) => entry.卡号 === ref);
	}

	#assertDispatchable(key: string): void {
		if (this.#stoppedAll || this.#blocked.has(executionKey(key))) {
			throw new PaoWorkerError(
				"已取消",
				this.#stoppedAll ? "运行器已 stopAll，本轮不再派发；换会话使用新运行器" : "该卡已取消，本轮不再派发",
			);
		}
	}

	/** 派前先占名额，包含还在获取基线/写锁的任务；不同入口共用同一计数。 */
	async reserveDispatchSlot(input: {
		身份: string;
		部门: string | null;
		部门上限: number;
		并发上限: number;
		等待?: boolean;
		信号?: AbortSignal;
	}): Promise<() => void> {
		const key = executionKey(input.身份);
		const reservationId = randomUUID();
		const reservationRoot = this.#dispatchStateRoot ? path.join(this.#dispatchStateRoot, "派发名额") : undefined;
		const reservationPath = reservationRoot ? path.join(reservationRoot, `${reservationId}.json`) : undefined;
		for (;;) {
			this.#assertDispatchable(key);
			if (input.信号?.aborted) throw new PaoWorkerError("已取消", "派发在认领前已取消");
			if (this.#slots.has(key) || this.#active.has(key))
				throw new PaoWorkerError("无效参数", "该卡已经占用派发名额，不双跑");
			const limit = Math.min(8, input.并发上限);
			const localSlots = [...this.#slots.entries()].map(([slotKey, department]) => ({
				key: slotKey,
				department,
			}));
			const externalSlots = this.#externalSlotEntries([], [key, ...localSlots.map((slot) => slot.key)]);
			let result:
				| {
						kind: "reserved";
				  }
				| {
						kind: "wait" | "reject";
						reason: string;
				  };
			if (reservationRoot && reservationPath) {
				await this.#ensureSlotRoot(reservationRoot);
				result = await withFileLock(
					path.join(reservationRoot, "名额事务"),
					async () => {
						const liveReservations = await this.#readSlotReservations(reservationRoot);
						const localSlots = [...this.#slots.entries()].map(([slotKey, department]) => ({
								key: slotKey,
								department,
							})),
							external = this.#externalSlotEntries(liveReservations, [
								key,
								...localSlots.map((slot) => slot.key),
							]);
						if (liveReservations.some((entry) => entry.occupancy === "known" && entry.身份 === key))
							return { kind: "reject" as const, reason: "该卡已经占用派发名额，不双跑" };
						const unknownReservations = liveReservations.filter((entry) => entry.occupancy === "unknown");
						if (unknownReservations.length) {
							return {
								kind: "reject" as const,
								reason: `共享派发名额存在 ${unknownReservations.length} 个未知占位，无法确认部门和卡片身份；保留占位并拒绝新派发`,
							};
						}
						const deptCount =
							localSlots.filter((slot) => slot.department === input.部门).length +
							external.filter((entry) => entry.department === input.部门).length;
						const totalCount = localSlots.length + external.length;
						const deptFull = deptCount >= input.部门上限;
						const full = totalCount >= limit;
						if (deptFull || full) {
							const reason = deptFull
								? `部门「${input.部门 ?? "无部门"}」已达部门并发上限 ${input.部门上限}（$PAO_HOME/pao配置/保温.json；缺省 3）`
								: `共享并发名额已达上限 ${limit}`;
							const externallyBlocked =
								(deptFull &&
									external.filter((entry) => entry.department === input.部门).length >= input.部门上限) ||
								(full && external.length >= limit);
							return input.等待 && !externallyBlocked
								? { kind: "wait" as const, reason }
								: { kind: "reject" as const, reason };
						}
						await writeFile(
							`${reservationPath}.tmp-${reservationId}`,
							`${JSON.stringify({
								type: "pao_dispatch_slot",
								身份: input.身份,
								部门: input.部门,
								pid: process.pid,
								createdAt: utcNow(),
								token: reservationId,
							})}\n`,
							{ encoding: "utf8", flag: "wx" },
						);
						await fs.promises.link(`${reservationPath}.tmp-${reservationId}`, reservationPath);
						await rm(`${reservationPath}.tmp-${reservationId}`, { force: true });
						return { kind: "reserved" as const };
					},
					{ retries: 30, retryDelay: 25 },
				);
			} else {
				const deptCount =
					localSlots.filter((slot) => slot.department === input.部门).length +
					externalSlots.filter((slot) => slot.department === input.部门).length;
				const deptFull = deptCount >= input.部门上限;
				const full = localSlots.length + externalSlots.length >= limit;
				if (!deptFull && !full) result = { kind: "reserved" };
				else {
					const reason = deptFull
						? `部门「${input.部门 ?? "无部门"}」已达部门并发上限 ${input.部门上限}（$PAO_HOME/pao配置/保温.json；缺省 3）`
						: `共享并发名额已达上限 ${limit}`;
					const externallyBlocked =
						(deptFull &&
							externalSlots.filter((slot) => slot.department === input.部门).length >= input.部门上限) ||
						(full && externalSlots.length >= limit);
					result = input.等待 && !externallyBlocked ? { kind: "wait", reason } : { kind: "reject", reason };
				}
			}
			if (result.kind === "reserved") break;
			if (result.kind === "reject") throw new PaoWorkerError("无效参数", result.reason);
			await new Promise<void>((resolve) => {
				const wake = (): void => {
					this.#slotWaiters.delete(wake);
					input.信号?.removeEventListener("abort", wake);
					resolve();
				};
				this.#slotWaiters.add(wake);
				input.信号?.addEventListener("abort", wake, { once: true });
			});
		}
		this.#slots.set(key, input.部门);
		return () => {
			this.#slots.delete(key);
			if (reservationPath) {
				try {
					fs.rmSync(reservationPath, { force: true });
				} catch (error) {
					// 释放失败时文件继续按未知占位处理，绝不因 owner pid 状态自动清理。
					logWarn(
						`[pao] 派发名额预约文件删除失败（名额可能继续占用）:${reservationPath}:${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			for (const wake of [...this.#slotWaiters]) wake();
		};
	}

	async #ensureSlotRoot(root: string): Promise<void> {
		try {
			await fs.promises.mkdir(root, { recursive: true });
		} catch (error) {
			throw new PaoWorkerError("无效参数", `无法创建共享派发名额目录:${root}`, {
				cause: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#externalSlotEntries(
		reservations: readonly { 身份: string; 部门: string | null }[],
		localKeys: readonly string[],
	): { identity: string; department: string | null }[] {
		return this.registry
			.list()
			.filter((entry) => {
				if (!entry.running || entry.pid === process.pid) return false;
				const identity = executionKey(entry.card_path ?? entry.card_no);
				if (localKeys.includes(identity) || this.#slots.has(identity)) return false;
				return !reservations.some((reservation) => reservation.身份 === identity);
			})
			.map((entry) => ({
				identity: executionKey(entry.card_path ?? entry.card_no),
				department: entry.dept,
			}))
			.concat(
				reservations
					.filter((reservation) => !localKeys.includes(reservation.身份))
					.map((reservation) => ({ identity: reservation.身份, department: reservation.部门 })),
			);
	}

	async #readSlotReservations(
		root: string,
	): Promise<{ 身份: string; 部门: string | null; occupancy: "known" | "unknown" }[]> {
		let names: string[];
		try {
			names = await readdir(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const live: { 身份: string; 部门: string | null; occupancy: "known" | "unknown" }[] = [];
		for (const name of names.filter((item) => item.endsWith(".json"))) {
			const file = path.join(root, name);
			try {
				const value = JSON.parse(await readFile(file, "utf8")) as {
					身份?: unknown;
					部门?: unknown;
				};
				if (typeof value.身份 !== "string" || !value.身份.trim()) throw new Error(`预约缺少有效身份:${file}`);
				live.push({
					身份: executionKey(value.身份),
					部门: typeof value.部门 === "string" ? value.部门 : null,
					occupancy: "known",
				});
			} catch (error) {
				if (
					error instanceof SyntaxError ||
					(error instanceof Error && error.message.startsWith("预约缺少有效身份"))
				) {
					live.push({ 身份: `未知占位:${name}`, 部门: null, occupancy: "unknown" });
					continue;
				}
				throw error;
			}
		}
		return live;
	}

	async #stopEntry(entry: ActiveEntry): Promise<StoppedProcess> {
		entry.停止 ??= (async () => {
			const mode = await this.#killTree(entry.pid, 2000, entry.createdBefore);
			await awaitClose(entry.proc, 10_000);
			return { pid: entry.pid, 卡号: entry.卡号, 方式: mode };
		})();
		try {
			return await entry.停止;
		} catch (error) {
			entry.停止 = undefined;
			throw error;
		}
	}

	/** 自然退出也可确认；活动进程仍在时拒绝签发放锁凭据。 */
	confirmStopped(identity: string): StopProof {
		if (this.isRunning(identity)) throw new PaoWorkerError("停止失败", `仍有执行中的进程：${identity}`);
		return issueStopConfirmation([]);
	}

	/**
	 * 拉起一个 worker 子进程并收集回执。同一卡号每调用一次尝试数 +1;
	 * 卡已被取消或运行器已 stopAll 时拒绝(取消契约第一步:阻止新调用)。
	 */
	async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		const cardNo = options.卡号;
		const key = executionKey(options.卡路径 ?? cardNo);
		this.#assertDispatchable(key);
		if (options.信号?.aborted) throw new PaoWorkerError("已取消", "派发在启动前已取消");
		if (this.#active.has(key))
			throw new PaoWorkerError("无效参数", `该卡已在运行，不双跑：${options.卡路径 ?? cardNo}`);
		const cardPath = options.卡路径 ? path.resolve(options.卡路径) : undefined;
		const runKey = cardPath ? executionKey(cardPath) : key;
		if (runKey !== key && this.#active.has(runKey))
			throw new PaoWorkerError("无效参数", `该卡已在运行，不双跑：${cardPath ?? cardNo}`);
		const attempt = options.尝试号 ?? (this.#attempts.get(runKey) ?? 0) + 1;
		this.#attempts.set(runKey, attempt);
		const runId = randomUUID();
		const executionRoot = path.resolve(options.executionRoot ?? options.cwd ?? process.cwd());
		if (options.cwd !== undefined && pathKey(path.resolve(options.cwd)) !== pathKey(executionRoot)) {
			throw new PaoWorkerError("无效参数", "worker cwd 与 executionRoot 不一致，拒绝启动", {
				cwd: path.resolve(options.cwd),
				executionRoot,
			});
		}
		const taskRoot = path.resolve(options.taskRoot ?? process.cwd());

		const bridge =
			options.卡路径 && !options.命令 && !options.参数
				? createWorkerSessionBridge({
						任务根: taskRoot,
						卡路径: options.卡路径,
						尝试: attempt,
						执行标识: runId,
						executionRoot,
						...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
						...(options.snapshotDigest ? { snapshotDigest: options.snapshotDigest } : {}),
						...(options.worktreeBindingDigest ? { worktreeBindingDigest: options.worktreeBindingDigest } : {}),
						...(options.executionBindingDigest ? { executionBindingDigest: options.executionBindingDigest } : {}),
					})
				: undefined;
		// 自定义测试命令没有卡桥接，也保留独立的过程审计；正文、提示词和完整命令行不入日志。
		const processAudit = (event: string, detail: Record<string, unknown> = {}): void => {
			const target = path.join(taskRoot, ".pao", "派发日志.jsonl");
			try {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.appendFileSync(
					target,
					`${JSON.stringify({
						type: "pao_worker_process",
						time: utcNow(),
						event,
						执行标识: runId,
						卡路径: options.卡路径 ? path.resolve(options.卡路径) : undefined,
						尝试: attempt,
						执行根: executionRoot,
						工作树标识: options.worktreeId,
						父进程: process.pid,
						...detail,
					})}\n`,
					"utf8",
				);
			} catch (error) {
				logWarn(
					`[pao] 工具/进程审计日志写入失败（执行继续，审计记录缺失）:${target}:${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		};
		const evidenceDir = resolveEvidenceDir(
			options.证据目录 ?? this.#defaultEvidenceDir,
			options.卡路径,
			executionRoot,
		);
		processAudit("prepare", {
			证据目录: evidenceDir,
			model: options.模型,
			思考档: options.思考档,
		});
		const args = buildArgs(bridge ? { ...options, 会话标识: runId, 会话目录: bridge.会话目录 } : options);
		const invocation = options.命令 ? { command: options.命令, args } : defaultInvocation(args);
		const commandLine = [invocation.command, ...invocation.args].join(" ");
		const start = Date.now();
		processAudit("spawn-request", {
			command: path.basename(invocation.command),
			argCount: invocation.args.length,
		});

		const proc = spawnProcess(invocation.command, invocation.args, {
			cwd: executionRoot,
			shell: false,
			stdio: options.命令 ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
			// 强制 worker 角色:子进程的 pao 扩展据此跳过派发/全库管理类注册(G1-12 角色装载);
			env: {
				...process.env,
				...options.环境变量,
				...(!options.命令 && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				[PAO_ROLE_ENV]: "worker",
				[MANAGED_PARENT_ENV]: options.命令 ? "0" : "1",
				...(options.预算 ? { PAO_WORKER_BUDGET: JSON.stringify(options.预算) } : {}),
				...(options.锁定工作区 ? { [SHELL_GUARD_ENV]: options.锁定工作区 } : {}),
			},
		});
		const pid = proc.pid ?? -1;
		const entry: ActiveEntry = {
			pid,
			卡号: cardNo,
			...(cardPath ? { card_path: cardPath } : {}),
			attempt,
			proc,
			命令: commandLine,
			取消: false,
			执行标识: runId,
			taskRoot,
			executionRoot,
			...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
			createdBefore: Date.now(),
		};
		PROCESS_AUDIT_ENTRIES.set(entry, processAudit);
		processAudit(pid > 0 ? "spawn" : "spawn-failed", {
			pid,
			部门: options.部门 ?? null,
			派单理由: inputReason(options.派单理由),
		});
		if (pid > 0)
			this.registry.register({
				pid,
				card_no: cardNo,
				card_path: cardPath ?? options.卡路径,
				attempt,
				run_id: runId,
				task_root: taskRoot,
				execution_root: executionRoot,
				...(options.worktreeId ? { worktree_id: options.worktreeId } : {}),
				...(options.snapshotDigest ? { snapshot_digest: options.snapshotDigest } : {}),
				...(options.worktreeBindingDigest ? { worktree_binding_digest: options.worktreeBindingDigest } : {}),
				...(options.executionBindingDigest ? { execution_binding_digest: options.executionBindingDigest } : {}),
				command: commandLine,
				dept: options.部门 ?? null,
				dispatch_reason: options.派单理由 ?? null,
				...(options.租约 ?? {}),
				...(options.supervisionRoute
					? {
							supervisor_dept: options.supervisionRoute.department,
							supervisor_context: options.supervisionRoute.context,
							supervisor_session: options.supervisionRoute.sessionId,
							supervision_key: options.supervisionRoute.key,
							supervision_department_key: options.supervisionRoute.departmentKey,
							supervision_label: options.supervisionRoute.label,
							supervision_owner: options.supervisionRoute.ownerSessionId,
							supervision_goal: options.supervisionRoute.goal,
							supervision_target: options.supervisionRoute.target ?? "minister",
							supervision_binding: options.supervisionRoute.binding,
							supervision_role: options.supervisionRoute.binding?.role,
						}
					: {}),
			});
		if (pid > 0) this.#active.set(runKey, entry);
		try {
			bridge?.record(pid > 0 ? "运行中" : "启动失败", { pid });
		} catch (error) {
			if (pid > 0) {
				await this.#stopEntry(entry);
				this.#active.delete(runKey);
				this.registry.markExited(pid, runId);
			}
			throw error;
		}

		// spawn 后即逐 chunk 落盘；失败时保留有限内存尾部，结算明确报告证据是否完整。
		const live = openLiveCapture(evidenceDir, cardNo, attempt, options.卡路径, runId, pid);
		entry.live = live;
		this.registry.markEvidence(pid, runId, [
			...(live.可用 ? [live.stdoutPath, live.stderrPath] : []),
			...(options.supervisionRoute?.evidence ?? []),
		]);

		const state: WorkerEventState = createEventState();
		const rawLines: string[] = [];
		entry.stdoutLines = rawLines;
		let tailChars = 0;
		let tailTruncated = false;
		const rememberLine = (line: string) => {
			const tail = line.slice(-131072);
			tailTruncated ||= tail.length !== line.length;
			rawLines.push(tail);
			tailChars += tail.length;
			while (rawLines.length > 256 || tailChars > 262144) {
				tailChars -= rawLines.shift()!.length;
				tailTruncated = true;
			}
		};
		let stderr = "";
		let buffer = "";
		let stopFailure: (error: unknown) => void = () => {};
		const stoppedFailed = new Promise<never>((_resolve, reject) => {
			stopFailure = reject;
		});
		let budgetReason: string | undefined;
		let lastProgress = "";
		const publishProgress = (): void => {
			const recent = state.最终输出.trim().replace(/\s+/g, " ").slice(-280);
			const progress = recent || lastProgress;
			if (!progress || progress === lastProgress) return;
			lastProgress = progress;
			this.registry.markProgress(pid, runId, progress);
		};
		// 父层预算兜底(审查第 2 项):turns/cost 首次到线时,子会话门禁会放行恰好一轮交最终回执
		// (budget.ts registerSessionBudget 的预算内唯一提醒轮)。父层必须按同一额度放行这一轮,
		// 否则子会话刚获准的回执轮会在同一刻被父层杀掉,任务已做完却结算成预算耗尽。
		// 硬停线因此落在「到线 + BUDGET_REMINDER_ROUNDS 轮」之后:正常路径由子会话自己收口,
		// 父层只兜住子会话没能停止的失控;额度阈值与工具次数口径都不放宽。
		let receiptToolCalls = 0;
		const requestStop = (): void => {
			if (pid > 0) void this.#stopEntry(entry).catch(stopFailure);
		};
		const absorb = (line: string): void => {
			absorbEvent(state, line);
			// 交回执工具不计入工具次数:子会话 tool_call 门禁对回执通道先放行、不计数(同口径)
			if (isReceiptToolCall(line)) receiptToolCalls++;
			const budget = options.预算;
			if (!budget || budgetReason) return;
			if (state.stopReason?.startsWith("budget:")) budgetReason = state.stopReason.slice(7);
			const billedToolCalls = Math.max(0, state.工具调用次数 - receiptToolCalls);
			if (budget.toolCalls !== undefined && billedToolCalls > budget.toolCalls) budgetReason = "toolCalls";
			if (budget.turns !== undefined && state.开始轮次 > budget.turns + BUDGET_REMINDER_ROUNDS)
				budgetReason = "turns";
			if (
				budget.cost !== undefined &&
				state.开始轮次 > state.用量.turns + BUDGET_REMINDER_ROUNDS &&
				(state.缺用量轮次 > 0 || state.用量.cost >= budget.cost)
			)
				budgetReason = "cost";
			if (budgetReason) requestStop();
		};
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", (text: string) => {
			live.appendStdout(text); // 逐 chunk 原样追加:live 与 rawLines 同源同内容
			this.registry.markOutput(pid, runId); // 活性打点:B 档静默检测信号源
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				rememberLine(line);
				absorb(line);
				publishProgress();
			}
		});
		proc.stderr?.on("data", (text: string) => {
			stderr = (stderr + text).slice(-16384);
			live.appendStderr(text);
			this.registry.markOutput(pid, runId);
		});
		proc.on("error", (error: Error) => {
			/* spawn 失败走 close(code=-1),错误文本进 stderr 兜底 */
			const note = `\n[spawn error] ${error.message}`;
			stderr = (stderr + note).slice(-16384);
			live.appendStderr(`${note.trimStart()}\n`);
		});
		const exited = new Promise<number>((resolve) => {
			proc.once("close", (code) => {
				if (this.#active.get(runKey) === entry) this.#active.delete(runKey);
				this.registry.markExited(pid, runId);
				processAudit("exit", { pid, exitCode: code, canceled: entry.取消, signalCode: proc.signalCode });
				resolve(code ?? -1);
			});
			proc.once("error", () => resolve(-1));
		});

		// 超时:到点树杀,回执记失败(stopReason=timeout)
		let timeout = false;
		const timer =
			options.超时毫秒 !== undefined
				? setTimeout(() => {
						timeout = true;
						processAudit("timeout", { pid, timeoutMs: options.超时毫秒 });
						requestStop();
					}, options.超时毫秒)
				: undefined;

		// 外部 AbortSignal:取消语义与 cancel() 相同(停进程树),但不签发放锁凭据
		let signalCancelled = false;
		const onAbort = () => {
			signalCancelled = true;
			entry.取消 = true;
			requestStop();
		};
		if (options.信号) {
			if (options.信号.aborted) onAbort();
			else options.信号.addEventListener("abort", onAbort, { once: true });
		}

		let exitCode: number;
		let stopFailed: string | undefined;
		try {
			exitCode = await Promise.race([exited, stoppedFailed]);
		} catch (error) {
			stopFailed = error instanceof Error ? error.message : String(error);
			exitCode = -1;
		} finally {
			if (timer) clearTimeout(timer);
			options.信号?.removeEventListener("abort", onAbort);
		}
		if (buffer.trim()) {
			rememberLine(buffer);
			absorb(buffer);
			live.appendStdout("\n"); // 原尾行已逐 chunk 落盘，只补换行，避免重复尾行。
		}
		// 正式 PAO 必须有费用收齐标记。硬杀／异常退出可能遗失在途用量，只能报已知下界。
		if (!options.命令 && !usageStreamComplete(state)) {
			const missing = JSON.stringify({
				type: "pao_usage_incomplete",
				reason: "进程退出前未收到原生费用收齐标记，在途及辅助调用可能缺账",
			});
			rememberLine(missing);
			live.appendStdout(`${missing}\n`);
			absorbEvent(state, missing);
		}

		// 结算补尾行后直接引用流式证据，避免再次拼接和写入全部输出。
		const masterPath = `${evidenceBase(evidenceDir, cardNo, attempt, options.卡路径, runId)}.jsonl`;
		const evidenceLastLine = buildEvidenceTrailer(cardNo, options.卡路径, attempt, runId, exitCode, stderr);
		live.settle(evidenceLastLine);
		let evidencePath = live.可用 ? live.stdoutPath : masterPath;
		let liveEvidencePath = live.可用 ? live.stdoutPath : undefined;
		let liveStderrPath = live.可用 ? live.stderrPath : undefined;
		const evidenceWarnings: string[] = [];
		let masterWriteFailed: string | undefined;
		if (!live.可用) {
			try {
				await writeEvidence(masterPath, rawLines, evidenceLastLine);
				if (tailTruncated)
					masterWriteFailed = `流式证据失败（${live.错误 ?? "未知原因"}），回退只保留有限尾部，完整过程证据缺失`;
			} catch (error) {
				masterWriteFailed = error instanceof Error ? error.message : String(error);
			}
		}
		// 停止未确认时仍可能有子进程输出，保留现场；只压缩本次已关闭的完整日志。
		if (live.可用 && stopFailed === undefined) {
			const [stdoutArchive, stderrArchive] = await Promise.all([
				archiveWorkerEvidence(live.stdoutPath),
				archiveWorkerEvidence(live.stderrPath),
			]);
			evidencePath = stdoutArchive.path;
			liveEvidencePath = stdoutArchive.path;
			liveStderrPath = stderrArchive.path;
			for (const result of [stdoutArchive, stderrArchive]) {
				if (result.warning) evidenceWarnings.push(result.warning);
			}
		}

		let status: WorkerStatus =
			entry.取消 || signalCancelled
				? "canceled"
				: stopFailed !== undefined
					? "failed"
					: budgetReason ||
							timeout ||
							exitCode !== 0 ||
							state.stopReason === "error" ||
							state.stopReason === "aborted"
						? exitCode < 0 && state.用量.turns === 0 && !state.stopReason
							? "unknown"
							: "failed"
						: "success";
		let summary = buildSummary(state.最终输出, stderr);
		this.registry.markProgress(
			pid,
			runId,
			budgetReason
				? `预算已耗尽：${budgetReason}；执行已停止`
				: stopFailed !== undefined
					? `停止确认失败：${stopFailed}；进程可能未退出`
					: summary.split("\n")[0],
		);
		this.registry.markEvidence(pid, runId, [
			evidencePath,
			...(liveEvidencePath ? [liveEvidencePath] : []),
			...(liveStderrPath ? [liveStderrPath] : []),
			...(options.supervisionRoute?.evidence ?? []),
		]);
		let artifactPath = options.产物路径 ?? [];
		let failureType: WorkerReceipt["failure_type"];
		let taskState: WorkerReceipt["任务态"];
		let selfVerification: WorkerReceipt["verification"];
		let selfChanges: WorkerReceipt["changes"];
		let receiptFormatRecovery: WorkerReceipt["receipt_format_recovery"];
		if (budgetReason) summary = `预算已耗尽：${budgetReason}；执行已停止`;
		if (stopFailed !== undefined) summary = `停止确认失败：${stopFailed}；进程可能未退出`;
		if (stopFailed !== undefined) processAudit("stop-failed", { pid, error: stopFailed });
		if (entry.上级终止 && status === "canceled") {
			// 上级终止留痕(≤3 行约束不破):摘要首行点名裁决动作,stopReason 同记「被上级终止」
			summary = ["被上级终止(pao_terminate_card):进程已树杀并确认退出", ...summary.split("\n").slice(0, 2)].join(
				"\n",
			);
		}
		if (options.要求回执 && status === "success") {
			try {
				const result = parseWorkerFinalResult(state.最终输出, options.cwd ?? process.cwd());
				status = result.result;
				summary = result.summary;
				artifactPath = result.artifact_path;
				failureType = result.failure_type;
				// F-A7 自报透传（S5 包1）：任务态/verification/changes 随回执落卡，供机械验收消费。
				taskState = result.任务态;
				selfVerification = result.verification;
				selfChanges = result.changes;
			} catch (error) {
				const recovery = recoverWorkerFinalReceiptFormat(state.最终输出, options.cwd ?? process.cwd());
				if (recovery) {
					const result = recovery.parsed;
					status = result.result;
					summary = result.summary;
					artifactPath = result.artifact_path;
					failureType = result.failure_type;
					taskState = result.任务态;
					selfVerification = result.verification;
					selfChanges = result.changes;
					receiptFormatRecovery = { strict_error: recovery.strictError };
				} else {
					status = "failed";
					summary = `无有效回执：${error instanceof Error ? error.message : String(error)}`;
					failureType = "unknown_outcome";
				}
			}
		}
		if (options.本次认领基线 && (status === "success" || status === "failed" || status === "unknown")) {
			try {
				const diff = await diffAgainstBaseline(options.本次认领基线);
				const changed = diff.worker改动.map((entry) => `${entry.状态} ${entry.文件}`).join("、");
				selfVerification = [
					...(selfVerification ?? []),
					{
						条件: `本次尝试 ${attempt} 相对认领基线的程序候选改动`,
						结论: diff.基线可用 && !diff.原因 ? "pass" : "fail",
						证据: diff.基线可用
							? `基线 ${options.本次认领基线}；${changed || "无候选改动"}${diff.原因 ? `；${diff.原因}` : ""}`
							: `基线 ${options.本次认领基线}；${diff.原因 ?? diff.汇总}`,
					},
				];
			} catch (error) {
				selfVerification = [
					...(selfVerification ?? []),
					{
						条件: `本次尝试 ${attempt} 相对认领基线的程序候选改动`,
						结论: "fail",
						证据: `基线 ${options.本次认领基线}；比对失败：${error instanceof Error ? error.message : String(error)}`,
					},
				];
			}
		}
		if (receiptFormatRecovery) {
			const recoveryPath = path.join(
				path.dirname(evidencePath),
				`${path.basename(evidencePath).replace(/\.gz$/, "")}.receipt-format-recovery.json`,
			);
			try {
				await mkdir(path.dirname(recoveryPath), { recursive: true });
				await writeFile(
					recoveryPath,
					`${JSON.stringify(
						{
							type: "pao_worker_receipt_format_recovery",
							time: utcNow(),
							card_no: cardNo,
							attempt,
							run_id: runId,
							strict_error: receiptFormatRecovery.strict_error,
							recognized_by: "严格解析失败后，唯一完整 JSON 围栏",
							original_evidence_path: evidencePath,
						},
						null,
						2,
					)}\n`,
					{ encoding: "utf8", flag: "wx" },
				);
				receiptFormatRecovery = { ...receiptFormatRecovery, evidence_path: recoveryPath };
				this.registry.markEvidence(pid, runId, [
					evidencePath,
					...(liveEvidencePath ? [liveEvidencePath] : []),
					...(liveStderrPath ? [liveStderrPath] : []),
					...(options.supervisionRoute?.evidence ?? []),
					recoveryPath,
				]);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				const strictError = receiptFormatRecovery.strict_error;
				receiptFormatRecovery = undefined;
				status = "failed";
				failureType = "unknown_outcome";
				summary = [
					"回执格式恢复审计写入失败，不能把恢复候选当成已验收结果",
					`原始严格错误：${strictError}；审计写入：${reason}`,
					`原始证据：${evidencePath}`,
				].join("\n");
				processAudit("receipt-format-recovery-audit-failed", {
					pid,
					auditPath: recoveryPath,
					strictError,
					error: reason,
				});
			}
		}
		// 回执化审计补漏:正本落盘失败也是一条终路径,回执形状不许破
		if (!live.可用 && masterWriteFailed === undefined) {
			summary = [
				...summary.split("\n").slice(0, 2),
				`流式证据写入失败，已回退完整输出：${live.错误 ?? "未知原因"}`,
			].join("\n");
		}
		if (masterWriteFailed !== undefined) {
			const note = live.可用
				? `证据正本落盘失败，改引 live 流：${masterWriteFailed}`
				: `证据落盘失败：${masterWriteFailed}`;
			summary = [...summary.split("\n").slice(0, 2), note].join("\n"); // 摘要 ≤3 行约束不破
			if (!live.可用 && status === "success") {
				// 无任何证据可指:成功不可验证,按瞬时故障记失败
				status = "failed";
				failureType ??= "transient";
			}
			if (tailTruncated && !live.可用) failureType = "unknown_outcome";
		}

		let sessionPath: string | undefined;
		try {
			sessionPath = bridge?.sessionPath();
			bridge?.record(stopFailed ? "停止未确认" : status, {
				pid,
				exitCode,
				会话路径: sessionPath,
				证据路径: evidencePath,
			});
		} catch (error) {
			// 进程已结算，映射损坏不能使调用方丢失本次费用和原始证据。
			// 卡回执明确保留错误；映射不谎写成功，成功结果降级为待修复失败。
			const note = `会话映射结算失败：${error instanceof Error ? error.message : String(error)}`;
			summary = [...summary.split("\n").slice(0, 2), note].join("\n");
			if (status === "success") {
				status = "failed";
				failureType = "transient";
			}
		}
		// 回执解析和后续降级可能改写摘要；登记表保存用户最终实际看到的进展，供活动快照在
		// 进程退出后短暂收敛、失败/待裁决仍能带上真实原因。
		this.registry.markProgress(pid, runId, summary.split("\n")[0]);
		return {
			card_no: cardNo,
			attempt,
			status,
			artifact_path: artifactPath,
			summary,
			failure_type: failureType,
			任务态: taskState,
			verification: selfVerification,
			changes: selfChanges,
			...(receiptFormatRecovery ? { receipt_format_recovery: receiptFormatRecovery } : {}),
			派发告警: evidenceWarnings.length ? [...(options.派发告警 ?? []), ...evidenceWarnings] : options.派发告警,
			card_path: cardPath ?? options.卡路径,
			run_id: runId,
			会话路径: sessionPath,
			映射路径: bridge?.映射路径,
			工具调用次数: state.工具调用次数,
			实际模型: state.model,
			usage: state.用量,
			missing_usage_rounds: state.缺用量轮次,
			evidence_path: evidencePath,
			live_evidence_path: liveEvidencePath,
			live_stderr_path: liveStderrPath,
			exitCode,
			stopReason: budgetReason
				? `budget:${budgetReason}`
				: timeout
					? "timeout"
					: stopFailed !== undefined
						? "stop_failed"
						: entry.上级终止
							? "被上级终止"
							: state.stopReason,
			stderrTail: stderr ? stderr.slice(-2000) : undefined,
			command: commandLine,
			pid,
			duration_ms: Date.now() - start,
		};
	}

	/**
	 * 上级终止(B 档 pao_terminate_card 专用取口):先给运行中条目打「被上级终止」标记,再走与 cancel
	 * 完全同一条 树杀→确认退出→StopProof 链(不另建停止机制);回执侧据此区分上级裁决与
	 * stopAll/信号取消。放锁仍须调用方凭签发的 StopProof 调 releaseProjectLock(先停后放锁)。
	 */
	async terminate(identity: string): Promise<StopProof> {
		for (const entry of this.#matchingEntries(identity)) entry.上级终止 = true;
		return this.cancel(identity);
	}

	/**
	 * 输入升版时停止精确的当前尝试。与 cancel() 的“永久封锁该卡”不同：
	 * 本入口只核完整卡路径与 attempt，不写 #blocked，停止成功后同卡可复核并开新 attempt。
	 * 仍复用同一 #stopEntry 链，停止失败不签发凭据，调用方必须保留执行锁、名额与守卫。
	 */
	async stopCurrentAttempt(cardPath: string, attempt: number): Promise<StopProof> {
		if (!/[\\/]/.test(cardPath) || !path.isAbsolute(cardPath)) {
			throw new PaoWorkerError("无效参数", "停止当前尝试必须提供完整卡路径");
		}
		const normalizedCardPath = path.resolve(cardPath);
		if (!Number.isInteger(attempt) || attempt < 1) {
			throw new PaoWorkerError("无效参数", `停止当前尝试的尝试号必须是正整数：${String(attempt)}`);
		}
		const key = executionKey(normalizedCardPath);
		const entry = this.#active.get(key);
		if (!entry) {
			const samePath = [...this.#active.values()].filter(
				(candidate) =>
					candidate.card_path !== undefined &&
					pathKey(path.resolve(candidate.card_path)) === pathKey(normalizedCardPath),
			);
			if (samePath.length === 0) return issueStopConfirmation([]);
			throw new PaoWorkerError("无效参数", "完整卡路径未唯一对应当前活动执行");
		}
		if (entry.card_path === undefined || pathKey(path.resolve(entry.card_path)) !== pathKey(normalizedCardPath)) {
			throw new PaoWorkerError(
				"无效参数",
				`活动条目的完整卡路径与停止请求不一致：请求 ${normalizedCardPath}，活动 ${entry.card_path ?? "缺卡路径"}，当前活动尝试 ${entry.attempt ?? "未知"}`,
			);
		}
		if (entry.attempt === undefined) {
			throw new PaoWorkerError("无效参数", "当前活动条目缺少冻结尝试号，拒绝猜测停止目标");
		}
		if (entry.attempt !== attempt) {
			throw new PaoWorkerError("无效参数", `停止尝试 ${attempt} 与当前活动尝试 ${entry.attempt} 不一致`);
		}
		entry.取消 = true;
		processAuditForEntry(entry, "attempt-stop-start", { pid: entry.pid, attempt });
		let stopped: StoppedProcess;
		try {
			stopped = await this.#stopEntry(entry);
		} catch (error) {
			processAuditForEntry(entry, "stop-failed", {
				pid: entry.pid,
				attempt,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		processAuditForEntry(entry, "attempt-stop-confirmed", { pid: entry.pid, attempt, method: stopped.方式 });
		return issueStopConfirmation([stopped]);
	}

	/**
	 * 取消某卡:①阻止新调用(后续 run 同卡号拒绝) ②树杀执行中进程并等它真退出(reap)
	 * ③签发放锁凭据——放锁动作在调用方,必须凭本凭据调 releaseProjectLock(先停后放锁)。
	 */
	async cancel(cardNo: string): Promise<StopProof> {
		const entries = this.#matchingEntries(cardNo);
		if (entries.length > 1) throw new PaoWorkerError("无效参数", `卡号 ${cardNo} 对应多个项目；取消须传完整卡路径`);
		const entry = entries[0];
		const key = entry ? [...this.#active].find(([, value]) => value === entry)?.[0] : executionKey(cardNo);
		if (key) this.#blocked.add(key);
		if (!/[\\/]/.test(cardNo)) this.#blocked.add(cardNo);
		for (const wake of [...this.#slotWaiters]) wake();
		if (!entry) return issueStopConfirmation([]);
		entry.取消 = true;
		processAuditForEntry(entry, "cancel-start", { pid: entry.pid });
		let stopped: StoppedProcess;
		try {
			stopped = await this.#stopEntry(entry);
		} catch (error) {
			processAuditForEntry(entry, "stop-failed", {
				pid: entry.pid,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		processAuditForEntry(entry, "cancel-confirmed", { pid: entry.pid, method: stopped.方式 });
		return issueStopConfirmation([stopped]);
	}

	/**
	 * 停掉登记在案的全部运行中进程(主会话退出时调)并封锁后续派发。
	 * 只处理本运行器登记的进程,不按进程名全局清理。
	 */
	async stopAll(): Promise<StopProof> {
		this.#stoppedAll = true;
		if (!this.#stopController.signal.aborted) this.#stopController.abort();
		const entries = [...this.#active.values()];
		for (const entry of entries) entry.取消 = true;
		for (const wake of [...this.#slotWaiters]) wake();
		const outcomes = await Promise.allSettled(entries.map((entry) => this.#stopEntry(entry)));
		const failures = outcomes.filter((result) => result.status === "rejected");
		if (failures.length) {
			const message = failures.map((result) => String(result.reason)).join("；");
			for (const entry of entries) {
				processAuditForEntry(entry, "stop-failed", { pid: entry.pid, error: message });
			}
			throw new PaoWorkerError("停止失败", message);
		}
		const stopped = outcomes.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		for (const item of stopped) {
			const entry = entries.find((candidate) => candidate.pid === item.pid);
			if (entry)
				processAuditForEntry(entry, "cancel-confirmed", {
					pid: item.pid,
					method: item.方式,
				});
		}
		return issueStopConfirmation(stopped);
	}
}

/**
 * 证据不能默认落在系统临时目录:有正式卡路径时放任务工作区的 worker-evidence;
 * 裸运行器按实际执行 cwd 放到项目内 .pao/worker-evidence。显式目录始终优先。
 */
function resolveEvidenceDir(dir: string | undefined, cardPath: string | undefined, cwd: string): string {
	if (dir) return path.resolve(dir);
	if (!cardPath) return path.join(path.resolve(cwd), ".pao", "worker-evidence");
	return path.join(path.dirname(path.dirname(path.resolve(cardPath))), "worker-evidence");
}

/** 证据文件公共前缀(正本与 live 同前缀):项目哈希取卡路径,重试按尝试号+执行标识区分 */
function evidenceBase(
	dir: string,
	cardNo: string,
	attempt: number,
	cardPath?: string,
	runId: string = randomUUID(),
): string {
	const project = createHash("sha256")
		.update(cardPath ?? process.cwd())
		.digest("hex")
		.slice(0, 12);
	return path.join(dir, `卡${cardNo}-尝试${attempt}-${project}-${runId}`);
}

/** 结算证据尾行(正本与 live 共用同一行,事后仅凭 live 也能对账) */
function buildEvidenceTrailer(
	cardNo: string,
	cardPath: string | undefined,
	attempt: number,
	runId: string,
	exitCode: number,
	stderr: string,
): string {
	return JSON.stringify({
		type: "pao_worker_evidence",
		卡号: cardNo,
		卡路径: cardPath,
		尝试: attempt,
		执行标识: runId,
		exitCode,
		stderrTail: stderr.slice(-2000),
	});
}

/** 流式写入失败后的有限尾部回退（wx，拒绝覆盖已有证据）。 */
async function writeEvidence(file: string, rawLines: string[], lastLine: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${[...rawLines, lastLine].join("\n")}\n`, { encoding: "utf8", flag: "wx" });
}

/**
 * 中途实时证据(live):stdout/stderr 逐 chunk 追加落盘,进程半路被杀/崩溃 live 里已有钱
 * ——B 档「派卡非阻塞+静默提醒」的地基,静默期上级读的就是这个文件。
 *
 * 取舍:
 * - 与正本同目录同前缀,后缀 `.live.jsonl` / `.live.stderr.log`;stderr 自由文本另立文件,
 *   不混写进 stdout JSONL(后者要保持逐行可解析,中途读者按行 tail);
 * - stdout 逐 chunk 原样追加(字节保真,即收即写,不做批量缓冲——量小,简单正确优先);
 * - 首行 header 标明归属(卡/尝试/执行标识/pid)；结算追加证据尾行后直接作为回执证据正本；
 * - 写入失败回退有限尾部；尾部已截断时结算不能冒充成功，明确报告完整过程证据缺失。
 */
interface LiveCapture {
	stdoutPath: string;
	stderrPath: string;
	/** stdout live 打开成功(判定回执能否引用 live 路径兜底) */
	可用: boolean;
	错误?: string;
	appendStdout(text: string): void;
	appendStderr(text: string): void;
	/** 结算:补证据尾行并关句柄(幂等) */
	settle(lastLine: string): void;
}

function openLiveCapture(
	dir: string,
	cardNo: string,
	attempt: number,
	cardPath: string | undefined,
	runId: string,
	pid: number,
): LiveCapture {
	const base = evidenceBase(dir, cardNo, attempt, cardPath, runId);
	const stdoutPath = `${base}.live.jsonl`;
	const stderrPath = `${base}.live.stderr.log`;
	let stdoutFd: number | undefined;
	let stderrFd: number | undefined;
	let usable = false;
	let readError: string | undefined;
	try {
		fs.mkdirSync(dir, { recursive: true });
		const header = JSON.stringify({
			type: "pao_worker_live",
			卡号: cardNo,
			卡路径: cardPath,
			尝试: attempt,
			执行标识: runId,
			pid,
			开始时间: utcNow(),
		});
		stdoutFd = fs.openSync(stdoutPath, "a");
		fs.writeSync(stdoutFd, `${header}\n`);
		stderrFd = fs.openSync(stderrPath, "a");
		usable = true;
	} catch (error) {
		readError = error instanceof Error ? error.message : String(error);
		if (stdoutFd !== undefined) {
			try {
				fs.closeSync(stdoutFd);
			} catch {
				/* 已关 */
			}
		}
		stdoutFd = undefined;
		stderrFd = undefined;
	}
	const write = (fd: number | undefined, text: string): void => {
		if (fd === undefined || !text) return;
		try {
			fs.writeSync(fd, text);
		} catch (error) {
			usable = false;
			readError = error instanceof Error ? error.message : String(error);
		}
	};
	return {
		stdoutPath,
		stderrPath,
		get 可用() {
			return usable;
		},
		get 错误() {
			return readError;
		},
		appendStdout: (text) => write(stdoutFd, text),
		appendStderr: (text) => write(stderrFd, text),
		settle: (lastLine) => {
			write(stdoutFd, `${lastLine}\n`);
			for (const fd of [stdoutFd, stderrFd]) {
				if (fd !== undefined) {
					try {
						fs.closeSync(fd);
					} catch (error) {
						usable = false;
						readError ??= error instanceof Error ? error.message : String(error);
					}
				}
			}
			stdoutFd = undefined;
			stderrFd = undefined;
		},
	};
}
