import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPackageDir, isBunBinary } from "../../config.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import { killTree } from "../../utils/kill-tree.ts";
import type { CardBudget } from "../cards/types.ts";
import { SHELL_GUARD_ENV } from "../patrol/wire.ts";
import { PAO_ROLE_ENV } from "../role.ts";
import { pathKey } from "../shared/path-key.ts";
import { utcNow } from "../shared/time.ts";
import { PaoWorkerError } from "./errors.ts";
import { usageStreamComplete } from "./native-usage.ts";
import { MANAGED_PARENT_ENV } from "./parent-lifecycle.ts";
import {
	absorbEvent,
	buildSummary,
	createEventState,
	parseWorkerFinalResult,
	type WorkerEventState,
	type WorkerReceipt,
	type WorkerStatus,
} from "./receipt.ts";
import { ProcessRegistry } from "./registry.ts";
import { createWorkerSessionBridge } from "./session-bridge.ts";

/**
 * headless worker 运行器:拉起一次性子进程、从 stdout JSON 事件流收结构化回执、
 * 统一尝试计数、取消先停后放锁(放锁凭据由本运行器签发)、主会话退出停整棵进程树。
 *
 * 证据双轨:stdout/stderr 逐 chunk 追加进 live 文件(边跑边落盘,半路被杀 live 里已有钱,
 * B 档静默期中途读取用);正本证据在结算时一次性落盘(flag wx)。live 保留不删,不做合并。
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
}

export interface WorkerRunnerOptions {
	registry?: ProcessRegistry;
	/** 全局缺省证据目录;run() 未指定时用 */
	证据目录?: string;
	/** 用于离线验证树杀失败；正式运行使用 killTree。 */
	树杀?: typeof killTree;
}

interface ActiveEntry {
	createdBefore: number;
	pid: number;
	卡号: string;
	proc: ChildProcess;
	命令: string;
	取消: boolean;
	执行标识: string;
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

function executionKey(ref: string): string {
	const key = /[\\/]/.test(ref) ? path.resolve(ref) : ref;
	return pathKey(key);
}

export class WorkerRunner {
	readonly registry: ProcessRegistry;
	#attempts = new Map<string, number>();
	#active = new Map<string, ActiveEntry>();
	#blocked = new Set<string>();
	#stoppedAll = false;
	#defaultEvidenceDir?: string;
	#killTree: typeof killTree;
	#slots = new Map<string, string | null>();
	#slotWaiters = new Set<() => void>();

	constructor(options: WorkerRunnerOptions = {}) {
		this.registry = options.registry ?? new ProcessRegistry();
		this.#defaultEvidenceDir = options.证据目录;
		this.#killTree = options.树杀 ?? killTree;
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

	stopped(): boolean {
		return this.#stoppedAll;
	}

	/**
	 * 在途 worker 实时快照（全景聚合/worker 实时页钻取用）:
	 * 每项 stdoutTail(行数=50) 读时切 stdout 末 N 行——原始行本就为证据落盘全程驻留,
	 * 这里只挂同一引用切片读取,零额外内存,不碰结算/回执路径。settle 后条目即从列表消失。
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
		for (;;) {
			this.#assertDispatchable(key);
			if (input.信号?.aborted) throw new PaoWorkerError("已取消", "派发在认领前已取消");
			if (this.#slots.has(key) || this.#active.has(key))
				throw new PaoWorkerError("无效参数", "该卡已经占用派发名额，不双跑");
			const external = this.registry
				.list()
				.filter((entry) => entry.running && !this.#slots.has(executionKey(entry.card_path ?? entry.card_no)));
			const deptExternal = external.filter((entry) => entry.dept === input.部门).length;
			const deptReserved = [...this.#slots.values()].filter((dept) => dept === input.部门).length;
			const deptFull = deptExternal + deptReserved >= input.部门上限;
			const limit = Math.min(8, input.并发上限);
			const full = external.length + this.#slots.size >= limit;
			if (!deptFull && !full) break;
			const reason = deptFull
				? `部门「${input.部门 ?? "无部门"}」已达部门并发上限 ${input.部门上限}（$PAO_HOME/pao配置/保温.json；缺省 3）`
				: `共享并发名额已达上限 ${limit}`;
			if (!input.等待 || (deptFull && deptExternal >= input.部门上限) || (full && external.length >= limit)) {
				throw new PaoWorkerError("无效参数", reason);
			}
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
			for (const wake of [...this.#slotWaiters]) wake();
		};
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
		const attempt = options.尝试号 ?? (this.#attempts.get(key) ?? 0) + 1;
		this.#attempts.set(key, attempt);
		const runId = randomUUID();

		const bridge =
			options.卡路径 && !options.命令 && !options.参数
				? createWorkerSessionBridge({
						项目根: options.cwd ?? process.cwd(),
						卡路径: options.卡路径,
						尝试: attempt,
						执行标识: runId,
					})
				: undefined;
		const args = buildArgs(bridge ? { ...options, 会话标识: runId, 会话目录: bridge.会话目录 } : options);
		const invocation = options.命令 ? { command: options.命令, args } : defaultInvocation(args);
		const commandLine = [invocation.command, ...invocation.args].join(" ");
		const start = Date.now();

		const proc = spawnProcess(invocation.command, invocation.args, {
			cwd: options.cwd ?? process.cwd(),
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
			proc,
			命令: commandLine,
			取消: false,
			执行标识: runId,
			createdBefore: Date.now(),
		};
		if (pid > 0)
			this.registry.register({
				pid,
				card_no: cardNo,
				card_path: options.卡路径,
				attempt,
				run_id: runId,
				command: commandLine,
				dept: options.部门 ?? null,
				dispatch_reason: options.派单理由 ?? null,
				...(options.租约 ?? {}),
			});
		if (pid > 0) this.#active.set(key, entry);
		try {
			bridge?.record(pid > 0 ? "运行中" : "启动失败", { pid });
		} catch (error) {
			if (pid > 0) {
				await this.#stopEntry(entry);
				this.#active.delete(key);
				this.registry.markExited(pid, runId);
			}
			throw error;
		}

		// live 流式落盘:spawn 后即开,逐 chunk 追加(半路被杀 live 里已有钱);打开失败降级纯内存
		const evidenceDir = resolveEvidenceDir(options.证据目录 ?? this.#defaultEvidenceDir);
		const live = openLiveCapture(evidenceDir, cardNo, attempt, options.卡路径, runId, pid);
		entry.live = live;

		const state: WorkerEventState = createEventState();
		const rawLines: string[] = [];
		entry.stdoutLines = rawLines; // listActive 读时切片:同一引用,不复制（证据落盘本就全程驻留）
		let stderr = "";
		let buffer = "";
		let stopFailure: (error: unknown) => void = () => {};
		const stoppedFailed = new Promise<never>((_resolve, reject) => {
			stopFailure = reject;
		});
		let budgetReason: string | undefined;
		const requestStop = (): void => {
			if (pid > 0) void this.#stopEntry(entry).catch(stopFailure);
		};
		const absorb = (line: string): void => {
			absorbEvent(state, line);
			const budget = options.预算;
			if (!budget || budgetReason) return;
			if (state.stopReason?.startsWith("budget:")) budgetReason = state.stopReason.slice(7);
			if (budget.turns !== undefined && state.开始轮次 > budget.turns) budgetReason = "turns";
			if (budget.toolCalls !== undefined && state.工具调用次数 > budget.toolCalls) budgetReason = "toolCalls";
			if (
				budget.cost !== undefined &&
				state.开始轮次 > state.用量.turns &&
				(state.缺用量轮次 > 0 || state.用量.cost >= budget.cost)
			)
				budgetReason = "cost";
			if (budgetReason) requestStop();
		};
		proc.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			live.appendStdout(text); // 逐 chunk 原样追加:live 与 rawLines 同源同内容
			this.registry.markOutput(pid, runId); // 活性打点:B 档静默检测信号源
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				rawLines.push(line);
				absorb(line);
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			live.appendStderr(text);
			this.registry.markOutput(pid, runId);
		});
		proc.on("error", (error: Error) => {
			/* spawn 失败走 close(code=-1),错误文本进 stderr 兜底 */
			const note = `\n[spawn error] ${error.message}`;
			stderr += note;
			live.appendStderr(`${note.trimStart()}\n`);
		});
		const exited = new Promise<number>((resolve) => {
			proc.once("close", (code) => {
				if (this.#active.get(key) === entry) this.#active.delete(key);
				this.registry.markExited(pid, runId);
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
			rawLines.push(buffer);
			absorb(buffer);
			live.appendStdout(`${buffer}\n`); // 尾行无换界:补换行让 live 成完整 JSONL
		}
		// 正式 PAO 必须有费用收齐标记。硬杀／异常退出可能遗失在途用量，只能报已知下界。
		if (!options.命令 && !usageStreamComplete(state)) {
			const missing = JSON.stringify({
				type: "pao_usage_incomplete",
				reason: "进程退出前未收到原生费用收齐标记，在途及辅助调用可能缺账",
			});
			rawLines.push(missing);
			live.appendStdout(`${missing}\n`);
			absorbEvent(state, missing);
		}

		// 结算:live 补证据尾行并关句柄(保留不删,中途查看用);正本照旧一次性落盘(flag wx)
		const masterPath = `${evidenceBase(evidenceDir, cardNo, attempt, options.卡路径, runId)}.jsonl`;
		const evidenceLastLine = buildEvidenceTrailer(cardNo, options.卡路径, attempt, runId, exitCode, stderr);
		live.settle(evidenceLastLine);
		let evidencePath = masterPath;
		let masterWriteFailed: string | undefined;
		try {
			await writeEvidence(masterPath, rawLines, evidenceLastLine);
		} catch (error) {
			masterWriteFailed = error instanceof Error ? error.message : String(error);
			if (live.可用) evidencePath = live.stdoutPath; // 正本写失败:live 是同一份前缀流,回执改引它兜底
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
		let artifactPath = options.产物路径 ?? [];
		let failureType: WorkerReceipt["failure_type"];
		let taskState: WorkerReceipt["任务态"];
		let selfVerification: WorkerReceipt["verification"];
		let selfChanges: WorkerReceipt["changes"];
		if (budgetReason) summary = `预算已耗尽：${budgetReason}；执行已停止`;
		if (stopFailed !== undefined) summary = `停止确认失败：${stopFailed}；进程可能未退出`;
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
				status = "failed";
				summary = `无有效回执：${error instanceof Error ? error.message : String(error)}`;
				failureType = "unknown_outcome";
			}
		}
		// 回执化审计补漏:正本落盘失败也是一条终路径,回执形状不许破
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
			派发告警: options.派发告警,
			card_path: options.卡路径,
			run_id: runId,
			会话路径: sessionPath,
			映射路径: bridge?.映射路径,
			工具调用次数: state.工具调用次数,
			实际模型: state.model,
			usage: state.用量,
			missing_usage_rounds: state.缺用量轮次,
			evidence_path: evidencePath,
			live_evidence_path: live.可用 ? live.stdoutPath : undefined,
			live_stderr_path: live.可用 ? live.stderrPath : undefined,
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
		const stopped = await this.#stopEntry(entry);
		return issueStopConfirmation([stopped]);
	}

	/**
	 * 停掉登记在案的全部运行中进程(主会话退出时调)并封锁后续派发。
	 * 只处理本运行器登记的进程,不按进程名全局清理。
	 */
	async stopAll(): Promise<StopProof> {
		this.#stoppedAll = true;
		const entries = [...this.#active.values()];
		for (const entry of entries) entry.取消 = true;
		for (const wake of [...this.#slotWaiters]) wake();
		const outcomes = await Promise.allSettled(entries.map((entry) => this.#stopEntry(entry)));
		const failures = outcomes.filter((result) => result.status === "rejected");
		if (failures.length) {
			throw new PaoWorkerError("停止失败", failures.map((result) => String(result.reason)).join("；"));
		}
		const stopped = outcomes.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		return issueStopConfirmation(stopped);
	}
}

function resolveEvidenceDir(dir?: string): string {
	return dir ?? path.join(os.tmpdir(), "pao-worker-evidence");
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

/** 正本证据:rawLines + 证据尾行一次性落盘(flag wx,重复结算即报错,不做静默覆盖) */
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
 * - 首行 header 标明归属(卡/尝试/执行标识/pid);结算时补与正本同款的证据尾行,然后保留不删:
 *   正本是 wx 独立正本,live 只是前缀流副本,无合并必要;
 * - 打开失败降级为纯内存(历史行为),live 是旁路,不许影响运行/结算/回执主路。
 */
interface LiveCapture {
	stdoutPath: string;
	stderrPath: string;
	/** stdout live 打开成功(判定回执能否引用 live 路径兜底) */
	可用: boolean;
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
	} catch {
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
		} catch {
			/* 磁盘抖动不致命:live 是旁路,正本在结算时仍会写 */
		}
	};
	return {
		stdoutPath,
		stderrPath,
		可用: stdoutFd !== undefined,
		appendStdout: (text) => write(stdoutFd, text),
		appendStderr: (text) => write(stderrFd, text),
		settle: (lastLine) => {
			write(stdoutFd, `${lastLine}\n`);
			for (const fd of [stdoutFd, stderrFd]) {
				if (fd !== undefined) {
					try {
						fs.closeSync(fd);
					} catch {
						/* 已关 */
					}
				}
			}
			stdoutFd = undefined;
			stderrFd = undefined;
		},
	};
}
