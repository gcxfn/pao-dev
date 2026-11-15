import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { killTree } from "../../utils/kill-tree.ts";
import { recipeFingerprint, renderRecipeSnapshot } from "../dept/render.ts";
import { PAO_ROLE_ENV } from "../role.ts";
import { backupTimestamp } from "../routing/config.ts";
import { logError } from "../shared/log.ts";
import { usageStreamComplete } from "../worker/native-usage.ts";
import { MANAGED_PARENT_ENV } from "../worker/parent-lifecycle.ts";
import { ProcessRegistry } from "../worker/registry.ts";
import { defaultInvocation } from "../worker/runner.ts";
import { readWarmConfig, WARM_DEFAULTS, type WarmConfig } from "./config.ts";
import { absorbMinisterEvent, createMinisterEventState, type EventDelta, type MinisterEventState } from "./events.ts";
import {
	assessLiveness,
	bindingKeyValue,
	type MinisterHandle,
	type MinisterInventoryLine,
	PAO_DEPT_ENV,
	projectName,
	renderSupervisionSnapshot,
} from "./handle.ts";
import { richHandoffPointerText, writeHandoffPage } from "./handoff.ts";
import {
	buildMinisterLedgerLine,
	ministerLedgerPath,
	type SupervisionAuditRecord,
	supervisionAuditPath,
	writeMinisterLedger,
	writeSupervisionAudit,
} from "./ledger.ts";

/**
 * 部长会话在线宿主(M2-01 设计包 §2/§4,S2)。
 *
 * 载体＝pi RPC 常驻子进程(已批 §9.1):拉起时强制注入 PAO_ROLE=部长＋PAO_DEPT=<部门>
 * (同 runner 对 worker 的纪律),并渲染配方快照进人设(--append-system-prompt,
 * 复用 dept/render.renderRecipeSnapshot——dept 注册面不动,宿主只做启动时快照)。
 *
 * 保温纪律:零定时器零轮询零文件监听。输入事件仅三类(新卡/回执验收/主控用户插话,
 * 都经 注入() 抵达),子进程事件流是另一类边界;保险丝/提示线/监督唤醒全部挂在这些
 * 事件边界上,不承诺完全无事件时准点熔断。
 *
 * 保险丝(2026-10-02 深夜终定):只有「空闲分钟」(缺省 30)熔断——先落短交接→树杀→
 * 登记表摘除;轮次/工具调用是提示线(缺省 200/2000),一次性通知＋盘点常驻标记,不杀;
 * 灾难线已删,事件型僵尸由监督唤醒的上级识别。缺保温.json＝不保温(功能全关,只有
 * 手动散场与主会话关闭全停);部门并发上限护栏在派单侧照常生效(缺省 3)。
 *
 * worker 监督(工人监督轮次)的可达性按 R05 如实声明:一次性 CLI worker 无中途输入
 * 通道,其事件被 WorkerRunner 内部吸收、宿主不可见(部长子进程内的 worker 更在另一
 * 进程)——记录被监督用量() 是按「计数→向热部长会话注入或落待办标记」预留的可达
 * 注入面,当前仓库没有生产者接线,不冒充已接入。
 */

export interface MinisterHostOptions {
	/** 进程登记表(树杀面全覆盖);缺省新建 */
	registry?: ProcessRegistry;
	/** PAO_HOME;缺省每次读环境变量 PAO_HOME(测试可注入固定值) */
	paoHome?: string;
	/** 树杀实现;正式运行用 killTree,测试可注入 */
	树杀?: typeof killTree;
	/** 一次性通知面:提示线达标与监督快照对主控的投递(§4 复用提示线同款通知面);
	 * 缺省写 stderr(接线层后续换成主控可见面) */
	通知?: (text: string) => void;
	/** 测试注入钟;缺省系统时钟 */
	时钟?: () => Date;
	/** 测试注入保温配置;缺省 readWarmConfig(paoHome) */
	保温?: () => WarmConfig;
	/** 启动握手超时毫秒；未取得真实会话身份时启动失败并停止子进程。 */
	握手超时毫秒?: number;
	/** 注入等待子进程回执的超时毫秒(超时即如实报未受理,不当成功)。 */
	注入超时毫秒?: number;
}

export interface SpawnOptions {
	脉络?: string;
	部门: string;
	项目根: string;
	/** 卡目录(散场交接盘点用);缺省 <项目根>/.pao/卡 */
	卡目录?: string;
	/** 覆盖可执行文件(测试打假进程);缺省 defaultInvocation(["--mode","rpc"]) */
	命令?: string;
	/** 覆盖参数(测试);缺省 ["--mode","rpc"] */
	参数?: string[];
	环境变量?: Record<string, string>;
	/** 追加系统提示词(配方快照之外;测试可注入) */
	附加系统提示词?: string[];
}

export type SpawnResult =
	| { ok: true; handle: MinisterHandle /** 同 key 已有热会话时 true(不双开,返回既有句柄) */; 已有热会话: boolean }
	| { ok: false; 原因: string };

export interface TeardownRecord {
	费用说明?: string;
	pid: number;
	部门: string;
	项目根: string;
	原因: string;
	/** 交接页路径(落盘成功时);失败/缺 PAO_HOME 时 undefined */
	交接路径?: string;
	/** 交接落盘失败原因(交接失败不阻断树杀,但如实通知) */
	交接失败?: string;
	/** 树杀方式描述 */
	方式: string;
}

interface HostEntry {
	createdBefore: number;
	需要费用收齐?: boolean;
	费用缺口已记?: boolean;
	/** 散场路径已在树杀前留证：close 不再重复落「进程退出」盖掉真实死因 */
	散场留证?: boolean;
	任务?: { id: string; started: boolean; failure?: Error; finish: (error?: Error) => void };
	停止?: Promise<TeardownRecord>;
	handle: MinisterHandle;
	proc: ChildProcess;
	state: MinisterEventState;
	key: string;
	/** 散场交接盘点的卡目录(拉起时定;缺省 <项目根>/.pao/卡) */
	卡目录: string;
	stderrTail?: string;
	解决握手?: (error?: Error) => void;
	握手请求?: string;
	就绪?: Promise<void>;
	/** 在途注入(审查第 7 项):按请求 id 等子进程回执,不收成功就算成功 */
	注入待决?: Map<string, { 模式: MinisterInjectMode; resolve: (result: MinisterInjectResult) => void }>;
}

/**
 * 注入投递模式:部长正在处理任务时,普通 RPC prompt 会被子会话拒收
 * (「Agent is already processing. Specify streamingBehavior…」)。
 * steer＝即时干预(插到当前轮,用于当前任务/确认门的紧急补充);
 * followUp＝排队(等本轮结束后新开一轮,用于普通新增任务)。
 */
export type MinisterInjectMode = "steer" | "followUp";

export interface MinisterInjectResult {
	ok: boolean;
	原因?: string;
	/** 实际投递模式(界面/工具按真实模式说明,不猜) */
	模式?: MinisterInjectMode;
	/** 子进程回执的处置(started/queued/handled):受理语义以此为准 */
	处置?: string;
}

/** 部门名同时是 部门/<名>/ 目录名(交接页/配方都在其下):带路径成分一律拒,防越出 PAO_HOME */
function deptNameOutOfRange(dept: string): boolean {
	return /[\\/:]/.test(dept) || dept.includes("..");
}

export class MinisterHost {
	readonly registry: ProcessRegistry;
	#options: MinisterHostOptions;
	#entries = new Map<string, HostEntry>();
	#worker监督游标 = new Map<string, number>();
	#待办标记 = new Map<string, string[]>();
	#默认脉络?: string;
	setDefaultContext(context: string): void {
		this.#默认脉络 = context;
	}

	constructor(options: MinisterHostOptions = {}) {
		this.#options = options;
		this.registry = options.registry ?? new ProcessRegistry();
	}

	/**
	 * 接管通知面(接线层用):把缺省的 stderr 落地换成主控可见面(系统提示 section 等)。
	 * 提示线与监督快照都走它;接管后原 stderr 行为消失(同一通知不双发)。
	 */
	receiveNotice(sink: (text: string) => void): void {
		this.#options.通知 = sink;
	}

	#时钟(): Date {
		return this.#options.时钟?.() ?? new Date();
	}

	#paoHome(): string | undefined {
		return this.#options.paoHome ?? (process.env.PAO_HOME?.trim() || undefined);
	}

	#保温(): WarmConfig {
		return this.#options.保温?.() ?? readWarmConfig(this.#paoHome());
	}

	#通知(text: string): void {
		const notify = this.#options.通知 ?? ((t: string) => process.stderr.write(`PAO 宿主:${t}\n`));
		notify(text);
	}

	/** 监督动作审计留痕(时间戳/动作/目标/原因);缺 PAO_HOME 不落,落盘失败记 stderr 不打断动作 */
	#审计(action: string, goal: string, reason: string): void {
		const paoHome = this.#paoHome();
		if (!paoHome) return;
		const record: SupervisionAuditRecord = {
			时间: this.#时钟().toISOString(),
			动作: action,
			目标: goal,
			原因: reason,
		};
		try {
			writeSupervisionAudit(supervisionAuditPath(paoHome), record);
		} catch (error) {
			process.stderr.write(`PAO 宿主:监督审计落盘失败:${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	#会话目标(handle: MinisterHandle): string {
		return `部长会话〔${handle.部门}@${projectName(handle.项目根)}〕(pid ${handle.pid},会话 ${handle.会话标识})`;
	}

	/**
	 * 部长进程死亡留证：stderr 尾部落 <项目根>/.pao/部长留证/。文件名 部门-pid<pid>-<类别:散场|退出>-<时间戳>.md
	 * （时间戳与档位配置备份同款口径 backupTimestamp，到毫秒）；类别段防同一进程的散场/退出两路同毫秒互盖。
	 * 落盘量级（轮转口径）：「退出」类（进程崩/自然死亡，散场标记未置）无条件落——「进程死了但零
	 * stderr」本身是排查信息；「散场」类只在 stderr 尾非空时落——常规散场（任务边界/空闲熔断/显式/全停）
	 * 是预期生命周期事件，工作流每节点每轮切换都散场一次，无条件落盘会让活跃项目无上限累积。
	 * 已知缺口：置位后、树杀完成前进程自死且 stderr 尾为空 → 该次零留证（亚秒窗口），散场原因仍在审计日志与 TeardownRecord。
	 * 落盘 best-effort：失败如实写 stderr，绝不上抛打断主流程。
	 */
	#留证(entry: HostEntry, 原因: string, 类别: string): void {
		const handle = entry.handle;
		const file = join(
			handle.项目根,
			".pao",
			"部长留证",
			`${handle.部门}-pid${handle.pid}-${类别}-${backupTimestamp(this.#时钟())}.md`,
		);
		const body = [
			`- 部门:${handle.部门}`,
			`- pid:${handle.pid}`,
			`- 会话标识:${handle.会话标识}`,
			`- 启动时间:${handle.启动时间}`,
			`- 留证原因:${原因}`,
			`- stderr尾部:${entry.stderrTail?.trim() || "（无 stderr 输出）"}`,
			"",
		].join("\n");
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, body, "utf8");
		} catch (error) {
			logError(`PAO 宿主:部长留证落盘失败(${file}):${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** 全部热会话句柄快照(副本) */
	list(): MinisterHandle[] {
		return [...this.#entries.values()].map((entry) => ({
			...entry.handle,
			累计: { ...entry.handle.累计 },
			待办标记: [...entry.handle.待办标记],
		}));
	}

	/** 查某绑定 key 的热会话句柄(无则 undefined) */
	hotSession(dept: string, projectRoot: string, context?: string): MinisterHandle | undefined {
		return this.#entries.get(bindingKeyValue({ 部门: dept, 项目根: projectRoot, 脉络: context ?? this.#默认脉络 }))
			?.handle;
	}

	// ── 拉起 ────────────────────────────────────────────────────────────

	/**
	 * 拉起(或命中)一个部长会话。同 key 同时最多一个热会话:已有热会话直接返回既有
	 * 句柄(不双开)。载体＝pi RPC 常驻子进程,env 强制 PAO_ROLE=部长＋PAO_DEPT。
	 */
	async spawn(options: SpawnOptions): Promise<SpawnResult> {
		const dept = options.部门?.trim() ?? "";
		if (!dept) return { ok: false, 原因: "部门 必填(部长会话绑定 key 的一半,同时是 PAO_DEPT 注入值)" };
		if (deptNameOutOfRange(dept)) {
			return { ok: false, 原因: `部门 非法(须是 部门/<名>/ 目录名,不得含路径分隔符或 ..):${dept}` };
		}
		const rootInput = options.项目根?.trim() ?? "";
		if (!rootInput) return { ok: false, 原因: "项目根 必填(归一化绝对路径,部长会话绑定 key 的另一半)" };
		const projectRoot = resolve(rootInput);
		const key = bindingKeyValue({ 部门: dept, 项目根: projectRoot, 脉络: options.脉络 ?? this.#默认脉络 });
		const existing = this.#entries.get(key);
		if (existing) {
			try {
				await existing.就绪;
				if (this.#entries.get(key) !== existing) throw new Error("部长会话已退出");
				return { ok: true, handle: { ...existing.handle }, 已有热会话: true };
			} catch (error) {
				return { ok: false, 原因: String(error) };
			}
		}

		const paoHome = this.#paoHome();
		const fingerprint = paoHome ? recipeFingerprint(dept, paoHome) : null;
		const cardDir = options.卡目录 ?? join(projectRoot, ".pao", "卡");

		// 配方快照进人设(§1:部长会话启动时渲染,带「截至」;dept 注册面不动,宿主启动时注入)
		const prompts: string[] = [];
		const snapshot = paoHome ? renderRecipeSnapshot(dept, paoHome) : null;
		if (snapshot) prompts.push(snapshot);
		for (const extra of options.附加系统提示词 ?? []) prompts.push(extra);

		const args = [...(options.参数 ?? ["--mode", "rpc"])];
		for (const prompt of prompts) args.push("--append-system-prompt", prompt);
		const invocation = options.命令 ? { command: options.命令, args } : defaultInvocation(args);
		const commandLine = [invocation.command, ...invocation.args].join(" ");

		const proc = spawn(invocation.command, invocation.args, {
			cwd: projectRoot,
			shell: false,
			stdio: options.命令 ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "ipc"],
			// 强制部长角色与部门身份:与 runner 强制 worker 角色同款纪律,调用方 env 不能越过
			env: {
				...process.env,
				...options.环境变量,
				...(!options.命令 && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				[PAO_ROLE_ENV]: "部长",
				[PAO_DEPT_ENV]: dept,
				[MANAGED_PARENT_ENV]: options.命令 ? "0" : "1",
			},
		});
		// spawn 失败(命令不存在/非法 cwd)异步 error 无人消费会崩主控:如实通知不崩(仿 runner 同款监听)
		proc.on("error", (error: Error) => {
			this.#通知(`部长会话子进程 spawn error(命令 ${invocation.command}):${error.message}`);
		});
		const pid = proc.pid ?? -1;
		if (pid <= 0) return { ok: false, 原因: `部长会话子进程拉起失败(命令 ${invocation.command})` };
		const now = this.#时钟();
		const handle: MinisterHandle = {
			脉络: options.脉络 ?? this.#默认脉络,
			pid,
			会话标识: `rpc-${pid}`,
			部门: dept,
			项目根: projectRoot,
			配方指纹: fingerprint,
			启动时间: now.toISOString(),
			最近事件时间: now.toISOString(),
			累计: { 轮次: 0, 工具调用: 0, 成本: 0 },
			轮次提示已发: false,
			调用提示已发: false,
			上次监督轮次: 0,
			待办标记: [],
		};
		// 登记表:部长会话复用部门位、理由留空,卡号无对应卡为空,标签=部长(定案7)
		this.registry.register({ pid, card_no: "", command: commandLine, dept, dispatch_reason: null, tags: "部长" });
		const entry: HostEntry = {
			createdBefore: Date.now(),
			handle,
			proc,
			state: createMinisterEventState(),
			key,
			卡目录: cardDir,
			需要费用收齐: !options.命令,
		};
		this.#entries.set(key, entry);
		this.#attachPump(entry);
		proc.once("close", () => {
			// 摘除登记前先留证：stderr 尾部只存内存，进程退出即丢（含握手失败场景，close 时 entry 可能仍在登记）；
			// 走过散场（标记已置）的退出是预期收尾，close 不再落「进程退出」——此路只兜真异常死亡
			if (!entry.散场留证) this.#留证(entry, "进程退出", "退出");
			this.#记录费用缺口(entry);
			entry.任务?.finish(new Error("部长进程退出，任务未完成"));
			this.#结算注入(entry, "部长进程退出，注入未获受理");
			entry.解决握手?.(new Error("部长会话在握手完成前退出"));
			// 崩溃散场:钩子没跑,不落交接(交接文件是旧货,恢复读取核时效属 S3 口径)
			if (this.#entries.get(key) === entry) {
				this.registry.markExited(pid);
				this.#entries.delete(key);
			}
		});
		entry.就绪 = this.#握手(entry);
		try {
			await entry.就绪;
			if (this.#entries.get(key) !== entry) throw new Error("部长会话已退出");
			return { ok: true, handle: { ...handle }, 已有热会话: false };
		} catch (error) {
			// 失败原因带上 stderr 尾摘要：模型名错/配置缺这类死因直接出现在启动失败消息里
			const stderrTail = entry.stderrTail?.slice(-400);
			const reason = `${String(error)}${stderrTail ? `｜stderr尾:${stderrTail}` : ""}`;
			try {
				await (this.#options.树杀 ?? killTree)(pid, 2000, entry.createdBefore);
				this.registry.markExited(pid);
				if (this.#entries.get(key) === entry) this.#entries.delete(key);
			} catch (stopError) {
				return { ok: false, 原因: `${reason}；停止失败，保留登记待处理：${String(stopError)}` };
			}
			return { ok: false, 原因: reason };
		}
	}

	#记录费用缺口(entry: HostEntry): string | undefined {
		if (!entry.需要费用收齐 || usageStreamComplete(entry.state)) return;
		const note = "未收到原生费用收齐标记；硬杀或异常退出的在途费用未知，已记录成本仅为下界";
		if (!entry.费用缺口已记) {
			entry.费用缺口已记 = true;
			entry.state.缺用量轮次++;
			this.#审计("费用缺口", this.#会话目标(entry.handle), note);
			this.#通知(note);
		}
		return note;
	}

	/** 只接受对应 get_state 请求的成功响应，进程存在不等于 RPC 可用。 */
	#握手(entry: HostEntry): Promise<void> {
		const timeoutMs = this.#options.握手超时毫秒 ?? 5000;
		const id = randomUUID();
		entry.握手请求 = id;
		return new Promise<void>((resolveReady, reject) => {
			const timer = setTimeout(() => entry.解决握手?.(new Error("部长 RPC 握手超时")), timeoutMs);
			entry.解决握手 = (error) => {
				clearTimeout(timer);
				entry.解决握手 = undefined;
				entry.握手请求 = undefined;
				if (error) reject(error);
				else resolveReady();
			};
			this.#写命令(entry, { type: "get_state", id });
		});
	}

	#写命令(entry: HostEntry, command: object): void {
		if (!entry.proc.stdin?.writable) throw new Error(`部长 pid=${entry.handle.pid} RPC 输入已关闭`);
		entry.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	#attachPump(entry: HostEntry): void {
		let buffer = "";
		entry.proc.stdout?.setEncoding("utf8");
		entry.proc.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) this.#吃事件行(entry, line);
		});
		entry.proc.stderr?.setEncoding("utf8");
		entry.proc.stderr?.on("data", (chunk: string) => {
			// 子进程 stderr 只截尾留证(排查用,不进盘点面)
			entry.stderrTail = ((entry.stderrTail ?? "") + chunk).slice(-2000);
		});
	}

	#吃事件行(entry: HostEntry, line: string): void {
		const delta = absorbMinisterEvent(entry.state, line);
		if (!delta.可解析) return;
		if (entry.任务) {
			const event = JSON.parse(line) as {
				type?: string;
				id?: string;
				command?: string;
				success?: boolean;
				error?: string;
				message?: { role?: string; stopReason?: string; errorMessage?: string };
			};
			if (event.type === "agent_start") entry.任务.started = true;
			if (
				event.type === "message_end" &&
				event.message?.role === "assistant" &&
				(event.message.stopReason === "error" || event.message.stopReason === "aborted")
			) {
				entry.任务.failure = new Error(
					`部长模型请求${event.message.stopReason === "aborted" ? "已取消" : "失败"}:${event.message.errorMessage ?? event.message.stopReason}`,
				);
			}
			if (event.type === "response" && event.id === entry.任务.id && event.success === false)
				entry.任务.finish(new Error(`部长 RPC 失败:${event.error ?? event.command}`));
			else if (event.type === "agent_settled" && entry.任务.started) entry.任务.finish(entry.任务.failure);
		}
		if (entry.注入待决 && entry.注入待决.size > 0) {
			const response = JSON.parse(line) as {
				type?: string;
				id?: string;
				command?: string;
				success?: boolean;
				error?: string;
				data?: { disposition?: unknown };
			};
			const pending = response.type === "response" && response.id ? entry.注入待决.get(response.id) : undefined;
			if (pending) {
				// 只结算这条 id 自己的回执:旧请求的响应不得算作新注入的结果
				entry.注入待决.delete(response.id!);
				const 处置 = typeof response.data?.disposition === "string" ? response.data.disposition : undefined;
				pending.resolve(
					response.success === true
						? { ok: true, 模式: pending.模式, ...(处置 ? { 处置 } : {}) }
						: {
								ok: false,
								模式: pending.模式,
								原因: `部长会话拒收本次注入:${response.error ?? response.command ?? "未知原因"}`,
							},
				);
			}
		}
		if (entry.握手请求) {
			const response = JSON.parse(line) as {
				type?: string;
				id?: string;
				command?: string;
				success?: boolean;
				data?: { sessionId?: unknown };
			};
			if (response.type === "response" && response.id === entry.握手请求 && response.command === "get_state") {
				if (response.success === true && typeof response.data?.sessionId === "string" && response.data.sessionId) {
					entry.handle.会话标识 = response.data.sessionId;
					entry.解决握手?.();
				} else entry.解决握手?.(new Error("部长 RPC 握手返回失败或缺少会话标识"));
			}
		}
		if (entry.state.会话标识 && entry.handle.会话标识 !== entry.state.会话标识) {
			entry.handle.会话标识 = entry.state.会话标识;
		}
		if (!delta.边界) {
			// 流式 delta 也是事件:刷最近事件时间即可,不重复做边界核对
			entry.handle.最近事件时间 = this.#时钟().toISOString();
			return;
		}
		this.#事件边界(entry, delta);
	}

	/** 事件边界:刷句柄累计→落账→提示线/监督唤醒→保险丝核对(全机械,挂边界不挂时钟) */
	#事件边界(entry: HostEntry, delta: Pick<EventDelta, "轮完成" | "辅助成本">): void {
		const handle = entry.handle;
		handle.最近事件时间 = this.#时钟().toISOString();
		handle.累计.轮次 = entry.state.轮次;
		handle.累计.工具调用 = entry.state.工具调用次数;
		handle.累计.成本 = entry.state.用量.cost;
		if (delta.轮完成?.含用量) this.#落账(entry, delta.轮完成.用量.cost);
		if (delta.辅助成本 !== undefined) this.#落账(entry, delta.辅助成本);
		const warmth = this.#保温();
		if (warmth.存在) {
			this.#核对提示线(handle, warmth);
			this.#核对监督唤醒(entry, warmth);
		}
		this.checkFuse().catch((error) => {
			// 保险丝核对失败(如树杀异常)不在事件边界炸进程:如实记 stderr,下个边界再核对
			process.stderr.write(`PAO 宿主:保险丝核对失败:${error instanceof Error ? error.message : String(error)}\n`);
		});
	}

	#落账(entry: HostEntry, roundCost: number): void {
		try {
			const now = this.#时钟();
			const line = buildMinisterLedgerLine({
				部门: entry.handle.部门,
				项目根: entry.handle.项目根,
				轮次: entry.state.轮次,
				该轮成本: roundCost,
				会话秒: (now.getTime() - Date.parse(entry.handle.启动时间)) / 1000,
			});
			writeMinisterLedger(ministerLedgerPath(entry.handle.项目根), line);
		} catch (error) {
			// 落账失败不阻断会话(对账面缺一行优于业务面断),如实写 stderr
			process.stderr.write(`PAO 宿主:部长用量落账失败:${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	/** 提示线(一次性通知,不杀):轮次/工具调用达标各发一次,盘点常驻标记由「到顶」判据承载 */
	#核对提示线(handle: MinisterHandle, warmth: WarmConfig): void {
		const roundLine = warmth.轮次提示 ?? WARM_DEFAULTS.轮次提示;
		const callLine = warmth.调用提示 ?? WARM_DEFAULTS.调用提示;
		if (!handle.轮次提示已发 && handle.累计.轮次 >= roundLine) {
			handle.轮次提示已发 = true;
			this.#通知(
				`[提示线] 部长会话〔${handle.部门}@${projectName(handle.项目根)}〕(pid ${handle.pid}) 累计轮次达 ${roundLine}(提示不杀;正当长活可继续)`,
			);
			this.#审计("提示线", this.#会话目标(handle), `累计轮次达 ${roundLine}(提示不杀)`);
		}
		if (!handle.调用提示已发 && handle.累计.工具调用 >= callLine) {
			handle.调用提示已发 = true;
			this.#通知(
				`[提示线] 部长会话〔${handle.部门}@${projectName(handle.项目根)}〕(pid ${handle.pid}) 累计工具调用达 ${callLine}(提示不杀;正当长活可继续)`,
			);
			this.#审计("提示线", this.#会话目标(handle), `累计工具调用达 ${callLine}(提示不杀)`);
		}
	}

	/** 部门级监督唤醒(§4):部长会话每累计 N 轮向直接上级(主控)注入机械摘要;被监督者不暂停 */
	#核对监督唤醒(entry: HostEntry, warmth: WarmConfig): void {
		const interval = warmth.部门监督轮次 ?? 0;
		const handle = entry.handle;
		if (!(interval > 0) || handle.累计.轮次 - handle.上次监督轮次 < interval) return;
		handle.上次监督轮次 = handle.累计.轮次;
		this.#审计("监督唤醒", this.#会话目标(handle), `累计轮次 ${handle.累计.轮次} 达间隔 ${interval}`);
		this.#通知(
			renderSupervisionSnapshot({
				被监督者: `部长会话〔${handle.部门}@${projectName(handle.项目根)}〕(pid ${handle.pid})`,
				轮次: handle.累计.轮次,
				工具调用: handle.累计.工具调用,
				成本: handle.累计.成本,
				活性: this.#活性(handle, entry.state, warmth),
				最近输出: entry.state.最终输出 || undefined,
				缺用量轮次: entry.state.缺用量轮次,
			}),
		);
	}

	#活性(handle: MinisterHandle, state: MinisterEventState, warmth: WarmConfig): string[] {
		const now = this.#时钟();
		return assessLiveness({
			运行中: state.运行中,
			最近事件毫秒: Date.parse(handle.最近事件时间),
			当前毫秒: now.getTime(),
			停滞阈值分钟: warmth.停滞阈值分钟 ?? WARM_DEFAULTS.停滞阈值分钟,
			最近工具签名: state.最近工具签名,
			循环K: warmth.循环K ?? WARM_DEFAULTS.循环K,
			累计轮次: handle.累计.轮次,
			累计工具调用: handle.累计.工具调用,
			轮次提示: warmth.轮次提示 ?? WARM_DEFAULTS.轮次提示,
			调用提示: warmth.调用提示 ?? WARM_DEFAULTS.调用提示,
		});
	}

	// ── 输入投递(新卡/回执验收/主控插话共用一条 RPC prompt 通道) ────────────

	/** 等待真实 RPC 一次任务结束；失败响应、退出和取消均不当作成功。 */
	async executeTask(input: {
		部门: string;
		项目根: string;
		脉络: string;
		会话标识: string;
		文本: string;
		signal?: AbortSignal;
		超时毫秒?: number;
	}): Promise<string> {
		const entry = this.#entries.get(bindingKeyValue(input));
		if (!entry || entry.handle.会话标识 !== input.会话标识 || entry.停止)
			throw new Error("部长会话不存在、身份失配或正在停止");
		if (entry.任务 || entry.state.运行中) throw new Error("部长会话已有在途任务，不能重入");
		input.signal?.throwIfAborted();
		return new Promise<string>((resolveTask, reject) => {
			const id = randomUUID();
			let stopping = false;
			const stop = () => {
				if (stopping) return;
				stopping = true;
				void this.#散场Entry(entry, input.signal?.aborted ? "工作流取消" : "任务等待超时").catch((error) =>
					entry.任务?.finish(new Error(`停止失败，登记保留:${String(error)}`)),
				);
			};
			const timer = setTimeout(stop, input.超时毫秒 ?? 600000);
			entry.任务 = {
				id,
				started: false,
				finish: (error) => {
					clearTimeout(timer);
					input.signal?.removeEventListener("abort", stop);
					entry.任务 = undefined;
					if (error || stopping) reject(error ?? new Error("部长任务已取消或超时"));
					else resolveTask(entry.state.最终输出);
				},
			};
			input.signal?.addEventListener("abort", stop, { once: true });
			entry.state.最终输出 = "";
			try {
				this.#写命令(entry, { type: "prompt", id, message: input.文本 });
			} catch (error) {
				entry.任务.finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/**
	 * 向热部长会话注入一条输入(主控用户插话/监督快照/新卡通知)。
	 * 注入即输入事件:刷新最近事件时间并走一遍边界核对。无热会话/通道不可写时拒绝,
	 * 不静默丢消息。
	 *
	 * 审查第 7 项:部长正在处理任务时,子会话会拒收没有 streamingBehavior 的 prompt,
	 * 旧实现发完就报 ok——拒收被当成已注入。现在按模式投递(steer 即时干预/followUp 排队),
	 * 并等这条请求自己的回执:只有 success 才算受理,失败/超时/会话关闭一律如实报不 ok。
	 */
	async inject(
		dept: string,
		projectRoot: string,
		text: string,
		context?: string,
		mode: MinisterInjectMode = "steer",
	): Promise<MinisterInjectResult> {
		const entry = this.#entries.get(
			bindingKeyValue({ 部门: dept, 项目根: projectRoot, 脉络: context ?? this.#默认脉络 }),
		);
		if (!entry) return { ok: false, 原因: `无热部长会话(部门「${dept}」项目 ${projectRoot});拉起是主控专有动作` };
		if (!entry.proc.stdin?.writable) return { ok: false, 原因: `pid=${entry.handle.pid} 的标准输入不可写,无法注入` };
		this.#事件边界(entry, { 轮完成: undefined });
		const id = randomUUID();
		const 待决 = entry.注入待决 ?? new Map();
		entry.注入待决 = 待决;
		const timeoutMs = this.#options.注入超时毫秒 ?? 30_000;
		return await new Promise<MinisterInjectResult>((resolve) => {
			const timer = setTimeout(() => {
				待决.delete(id);
				resolve({ ok: false, 模式: mode, 原因: `部长 pid=${entry.handle.pid} 未在 ${timeoutMs}ms 内回执本次注入` });
			}, timeoutMs);
			const settle = (result: MinisterInjectResult): void => {
				clearTimeout(timer);
				待决.delete(id);
				resolve(result);
			};
			待决.set(id, { 模式: mode, resolve: settle });
			try {
				this.#写命令(entry, { type: "prompt", message: text, id, streamingBehavior: mode });
			} catch (error) {
				settle({
					ok: false,
					模式: mode,
					原因: `注入写入失败:${error instanceof Error ? error.message : String(error)}`,
				});
			}
		});
	}

	/** 结束该会话所有在途注入(进程退出/散场):不留下永远不会结算的等待 */
	#结算注入(entry: HostEntry, 原因: string): void {
		const 待决 = entry.注入待决;
		if (!待决) return;
		entry.注入待决 = undefined;
		for (const pending of 待决.values()) pending.resolve({ ok: false, 模式: pending.模式, 原因 });
	}

	// ── 保险丝与散场 ────────────────────────────────────────────────────

	/**
	 * 空闲熔断核对(挂事件边界;主控侧工具边界也可显式调用)。只有空闲分钟是熔断线:
	 * 超线者先落短交接→树杀→登记表摘除。缺保温.json=不保温,本函数直接返回。
	 */
	async checkFuse(): Promise<TeardownRecord[]> {
		const warmth = this.#保温();
		if (!warmth.存在) return [];
		const idleMinutes = warmth.空闲分钟 ?? WARM_DEFAULTS.空闲分钟;
		const now = this.#时钟().getTime();
		const fuse: TeardownRecord[] = [];
		for (const entry of [...this.#entries.values()]) {
			const idleMs = now - Date.parse(entry.handle.最近事件时间);
			if (idleMs < idleMinutes * 60_000) continue;
			fuse.push(await this.#散场Entry(entry, `空闲熔断(超过 ${idleMinutes} 分钟无事件)`));
		}
		return fuse;
	}

	/** 显式散场(主控干涉/手动):同保险丝的散场语义,但不要求空闲 */
	async teardown(
		dept: string,
		projectRoot: string,
		reason = "主控显式散场",
		context?: string,
	): Promise<TeardownRecord | undefined> {
		const entry = this.#entries.get(
			bindingKeyValue({ 部门: dept, 项目根: projectRoot, 脉络: context ?? this.#默认脉络 }),
		);
		if (!entry) return undefined;
		return this.#散场Entry(entry, reason);
	}

	async #散场Entry(entry: HostEntry, reason: string): Promise<TeardownRecord> {
		if (entry.停止) return entry.停止;
		entry.停止 = this.#执行散场(entry, reason);
		try {
			return await entry.停止;
		} finally {
			entry.停止 = undefined;
		}
	}
	async #执行散场(entry: HostEntry, reason: string): Promise<TeardownRecord> {
		const handle = entry.handle;
		// 停止期间保留登记；失败时仍能再次取消，不能失去受管进程。
		const record: TeardownRecord = {
			pid: handle.pid,
			部门: handle.部门,
			项目根: handle.项目根,
			原因: reason,
			方式: "未执行",
		};
		// 留证轮转：常规散场只在 stderr 尾非空时落盘（有排查线索才值得落）；干净散场不落。
		// 异常退出（close 路：进程崩/自然死亡，散场标记未置）保持无条件落盘（见 #留证 注释）。
		// 粘性标记无论是否落盘都置位——close 不补写，「散场根本没走到」的兜底判定不受影响；
		// 置位必须早于交接落盘（原注释时序理由不变：进程恰在交接写入期间死亡时不落两份互盖）。
		if (entry.stderrTail?.trim()) this.#留证(entry, reason, "散场");
		entry.散场留证 = true;
		const paoHome = this.#paoHome();
		if (paoHome) {
			try {
				record.交接路径 = await writeHandoffPage({
					paoHome,
					部门: handle.部门,
					项目根: handle.项目根,
					卡目录: entry.卡目录,
					脉络: handle.脉络,
				});
			} catch (error) {
				record.交接失败 = error instanceof Error ? error.message : String(error);
				this.#通知(`散场交接落盘失败(pid ${handle.pid}):${record.交接失败}(继续树杀,交接文件为旧货)`);
			}
		}
		const kill = this.#options.树杀 ?? killTree;
		record.方式 = await kill(handle.pid, 2000, entry.createdBefore);
		record.费用说明 = this.#记录费用缺口(entry);
		entry.任务?.finish(new Error(`部长会话已停止:${reason}`));
		this.#结算注入(entry, `部长会话已停止:${reason}`);
		this.registry.markExited(handle.pid);
		if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
		this.#审计(
			"散场",
			this.#会话目标(handle),
			`${reason};方式:${record.方式}${record.交接失败 ? `;交接失败:${record.交接失败}` : ""}`,
		);
		return record;
	}

	/** 主会话关闭全停(架构 §1):逐会话散场(落交接＋树杀＋摘除)。不封锁再拉起——
	 * 主控 reload/new 后同一进程内扩展重新注册,宿主须可再拉起(与 WorkerRunner 封锁语义不同) */
	async stopAll(reason = "主会话关闭全停"): Promise<TeardownRecord[]> {
		const record: TeardownRecord[] = [];
		for (const entry of [...this.#entries.values()]) {
			try {
				record.push(await this.#散场Entry(entry, reason));
			} catch (error) {
				// 单会话停止失败不上抛阻断其他会话:如实通知,句柄保留(进程未确认死亡)
				this.#entries.set(entry.key, entry);
				this.#通知(
					`部长会话停止失败(pid ${entry.handle.pid}):${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return record;
	}

	// ── 指纹核对与派卡指针 ──────────────────────────────────────────────

	/**
	 * 配方指纹核对(§1.3):主控派卡命中热会话时机械比对启动指纹与当前配方。
	 * 不一致仅给提示(建议重开),是否重开主控裁决,宿主不自动杀。无热会话视为一致。
	 */
	verifyRecipeFingerprint(dept: string, projectRoot: string): { 一致: boolean; 提示?: string } {
		const entry = this.#entries.get(bindingKeyValue({ 部门: dept, 项目根: projectRoot, 脉络: this.#默认脉络 }));
		if (!entry) return { 一致: true };
		const paoHome = this.#paoHome();
		const current = paoHome ? recipeFingerprint(dept, paoHome) : null;
		if (current === entry.handle.配方指纹) return { 一致: true };
		const short = (f: string | null): string => (f ? f.slice(0, 8) : "无配方");
		return {
			一致: false,
			提示: `部门「${dept}」配方已变更(会话启动指纹 ${short(entry.handle.配方指纹)} → 当前 ${short(current)}),建议重开部长会话;是否重开由主控裁决,宿主不自动杀`,
		};
	}

	/**
	 * 派卡投递的交接页指针(定案10＋S3 恢复门):pao_dispatch_card 派到同部门＋同项目且登记表有热部长会话时,
	 * 把交接页指针附进派卡信封。交接文件不存在(本会话从未散场过)时不指针;文件在则带时效判定
	 * (超窗/指纹不符等降级为「仅历史参考,不授权续跑」,判定规则见 handoff.ts 判定交接时效)。
	 */
	dispatchHandoffPointer(dept: string, projectRoot: string): string | undefined {
		const entry = this.#entries.get(bindingKeyValue({ 部门: dept, 项目根: projectRoot, 脉络: this.#默认脉络 }));
		if (!entry) return undefined;
		const paoHome = this.#paoHome();
		if (!paoHome) return undefined;
		return richHandoffPointerText(paoHome, entry.handle.部门, entry.handle.项目根, { 脉络: entry.handle.脉络 })?.文本;
	}

	// ── worker 监督注入面(R05 如实声明:当前无生产者接线) ─────────────────

	/**
	 * 记录一个被监督 worker 的累计用量并按「工人监督轮次」核对周期唤醒(§4)。
	 * 触发时:有热部长会话(worker 的直接上级)→ 注入机械摘要;没有 → 落待办标记(盘点可见)。
	 * **当前仓库没有生产者调用本方法**:一次性 CLI worker 的中途用量宿主结构上不可见
	 * (事件被 WorkerRunner 内部吸收、无增量出口),部长子进程内的 worker 更在另一进程;
	 * 本面是可达注入面的预留,接线待后续步,不冒充已接入。
	 */
	async recordSupervisedUsage(input: {
		身份: string;
		部门: string;
		项目根: string;
		累计轮次: number;
		累计工具调用?: number;
		成本?: number;
		最近回执标题?: string;
	}): Promise<{ 唤醒?: string; 待办?: string }> {
		const warmth = this.#保温();
		const interval = warmth.存在 ? (warmth.工人监督轮次 ?? 0) : 0;
		if (!(interval > 0)) return {};
		const previous = this.#worker监督游标.get(input.身份) ?? 0;
		if (input.累计轮次 - previous < interval) return {};
		this.#worker监督游标.set(input.身份, input.累计轮次);
		const snapshot = renderSupervisionSnapshot({
			被监督者: `worker ${input.身份}`,
			轮次: input.累计轮次,
			工具调用: input.累计工具调用 ?? 0,
			成本: input.成本 ?? 0,
			活性: [],
			最近输出: input.最近回执标题,
		});
		// 监督快照是通知性质,不是紧急补充:排队(followUp),等部长把当前轮做完再看
		const injectionResult = await this.inject(
			input.部门,
			input.项目根,
			`${snapshot}\n(上级监督唤醒:看一眼,可不动或走干涉)`,
			undefined,
			"followUp",
		);
		if (injectionResult.ok) {
			this.#审计(
				"worker监督唤醒",
				`worker ${input.身份}`,
				`累计轮次 ${input.累计轮次} 达间隔 ${interval};已注入热部长会话`,
			);
			return { 唤醒: snapshot };
		}
		const todo = `worker ${input.身份} 监督快照待投递(无热部长会话可注入):轮次 ${input.累计轮次}/调用 ${input.累计工具调用 ?? 0}`;
		const key = bindingKeyValue({ 部门: input.部门, 项目根: input.项目根, 脉络: this.#默认脉络 });
		const markList = this.#待办标记.get(key) ?? [];
		markList.push(todo);
		this.#待办标记.set(key, markList);
		this.#审计(
			"worker监督待办",
			`worker ${input.身份}`,
			`累计轮次 ${input.累计轮次} 达间隔 ${interval};无热部长会话可注入,落待办标记`,
		);
		return { 待办: todo };
	}

	/** 无热部长会话可注入时落的待办标记(盘点可见;热会话对同 key 出现后仍在此列,由人清) */
	todoView(): { 部门: string; 项目名: string; 标记: string[] }[] {
		return [...this.#待办标记.entries()].map(([key, mark]) => {
			const [dept, projectRoot] = key.split("\u0000");
			return { 部门: dept ?? "", 项目名: projectName(projectRoot ?? ""), 标记: [...mark] };
		});
	}

	// ── 盘点视图(定案11:pao_inventory 部长会话行的数据源) ─────────────────────

	inventoryView(): MinisterInventoryLine[] {
		const warmth = this.#保温();
		return [...this.#entries.values()].map((entry) => ({
			pid: entry.handle.pid,
			会话标识: entry.handle.会话标识,
			部门: entry.handle.部门,
			项目名: projectName(entry.handle.项目根),
			轮次: entry.handle.累计.轮次,
			工具调用: entry.handle.累计.工具调用,
			成本: Math.round(entry.handle.累计.成本 * 1e6) / 1e6,
			配方指纹: entry.handle.配方指纹,
			最近事件时间: entry.handle.最近事件时间,
			活性: warmth.存在 ? this.#活性(entry.handle, entry.state, warmth) : [],
			待办标记: [...entry.handle.待办标记, ...(entry.state.缺用量轮次 ? ["费用含未知项，累计仅为已知下界"] : [])],
		}));
	}
}
