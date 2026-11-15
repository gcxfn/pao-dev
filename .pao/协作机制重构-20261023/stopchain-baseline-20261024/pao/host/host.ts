import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { killTree } from "../../utils/kill-tree.ts";
import { recipeFingerprint, renderRecipeSnapshot } from "../dept/render.ts";
import { PAO_ROLE_ENV } from "../role.ts";
import { backupTimestamp } from "../routing/config.ts";
import { logError, logWarn } from "../shared/log.ts";
import {
	renderSupervisionWork,
	type SupervisionKind,
	type SupervisionOutcome,
	type SupervisionProgress,
	type SupervisionRoute,
	SupervisionState,
	type SupervisionWake,
	type SupervisionWorkInput,
} from "../supervision/index.ts";
import { usageStreamComplete } from "../worker/native-usage.ts";
import type { DispatchNotifyCategory } from "../worker/notify.ts";
import { MANAGED_PARENT_ENV } from "../worker/parent-lifecycle.ts";
import { ProcessRegistry } from "../worker/registry.ts";
import { defaultInvocation } from "../worker/runner.ts";
import {
	readDepartmentSupervisionMinutes,
	readWarmConfig,
	readWorkerSupervisionMinutes,
	WARM_DEFAULTS,
	type WarmConfig,
} from "./config.ts";
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
 * 监督纪律:分钟监督由宿主计时,工人默认 15 分钟、部门默认 30 分钟;显式 0 才关闭,
 * 不受保温.json 是否存在影响。定时器只读取活动快照并在到期时投递提醒,不唤醒模型;
 * RPC 后台计数只用于保活与监督对象生成。旧轮次监督仍仅在保温文件显式给正数时启用。
 *
 * 输入事件包括新卡/回执验收/主控插话以及子进程机械事件。空闲熔断只认「空闲分钟」
 * (缺省 30):先落短交接→树杀→登记表摘除。部长模型 idle 但仍有本人运行任务或子后台
 * 时继续保活;轮次/工具调用提示线只通知,不杀。缺保温.json 只关闭空闲熔断、提示线和
 * 旧轮次监督,分钟监督与手动散场/关闭全停照常工作。
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
	/** 惰性 PAO_HOME 解析;显式 paoHome 优先。注册构造阶段不会调用。 */
	resolvePaoHome?: () => string | undefined;
	/** 树杀实现;正式运行用 killTree,测试可注入 */
	树杀?: typeof killTree;
	/** 一次性通知面:提示线达标与监督快照对主控的投递(§4 复用提示线同款通知面);
	 * 缺省写 stderr(接线层后续换成主控可见面) */
	通知?: (text: string, category: DispatchNotifyCategory) => void;
	/** 测试注入钟;缺省系统时钟 */
	时钟?: () => Date;
	/** 测试注入保温配置;缺省 readWarmConfig(paoHome) */
	保温?: () => WarmConfig;
	/** 启动握手超时毫秒；未取得真实会话身份时启动失败并停止子进程。 */
	握手超时毫秒?: number;
	/** 注入等待子进程回执的超时毫秒(超时即如实报未受理,不当成功)。 */
	注入超时毫秒?: number;
	/**
	 * 部门“仍有工作”的外部活动快照。主控传入 WorkerRunner 快照后,部长即使 idle,
	 * 只要该部门仍有活工人且没有停审/待人工,部门仍在工作。
	 */
	活动?: () => readonly HostActivity[];
	/** 宿主派生状态变化:后台数量、部长完成/退出、监督到期。仅通知宿主,不唤醒模型。 */
	后台变化?: () => void;
	/** 分钟监督读取(测试注入);缺省按 readWorkerSupervisionMinutes/readDepartmentSupervisionMinutes。 */
	监督分钟?: () => { 工人: number; 部门: number };
	/** 测试注入监督短计时器;缺省 20 秒。计时结论仍由注入时钟判断。 */
	监督检查毫秒?: number;
	/**
	 * 当前普通部长进程自己的直达路由。工人提醒和工人结果投到本会话通知面,
	 * 不经 host.inject 找另一个“热部长”;workflow 仍使用远端会话/RPC 路由。
	 */
	本地上级?: {
		department: string;
		projectRoot: string;
		context?: string;
		sessionId?: string;
	};
	/** 本地部长接收监督/结果正文;接线通常传 notifySurface.notify。 */
	本地通知?: (body: string, category: DispatchNotifyCategory) => void;
}

export interface SpawnOptions {
	/** 调用方自己汇集并上报最终结果时为 true;部长 RPC episode 不再向主控共享通知面投最终输出。 */
	结果由调用方汇总?: boolean;
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
	/** 后台计数:当前 RPC 任务或注入正文已受理,但尚未等到对应的 agent_settled。 */
	后台任务: number;
	/** 当前后台任务的稳定键,用于同键待投递去重。 */
	后台键: Set<string>;
	/** agent_start 后,由同一会话的 agent_settled 统一结算的已受理轮次。 */
	后台运行键: Set<string>;
	/** 注入按 RPC 实际处置记录是否立即启动,供 agent_start 对号入座。 */
	注入待运行: Map<string, boolean>;
	/** 当前真实任务 episode;settled 后只结算一次,与注入/后台事件分开。 */
	当前任务?: MinisterEpisode;
	/** 普通部长任务完成后是否投主控;workflow 由 bridge 传 true 抑制轮级重复报告。 */
	结果由调用方汇总?: boolean;
}

interface PendingResultDelivery {
	key: string;
	route: SupervisionRoute;
	target: "minister" | "main";
	category: Exclude<DispatchNotifyCategory, "progress" | "supervision">;
	text: string;
	works?: readonly SupervisionWorkInput[];
}

/** 一次真实 RPC prompt 的结算范围;只在该 episode 的 agent_settled 时投递最终结果。 */
interface MinisterEpisode {
	id: string;
	settled: boolean;
	supervised: boolean;
	failure?: string;
	aborted: boolean;
}

interface SupervisionDeliveryTask extends Promise<boolean> {}

export interface HostToolEndEvent {
	type: "tool_execution_end";
	department: string;
	projectRoot: string;
	context?: string;
	sessionId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export interface HostActivity {
	department: string;
	projectRoot: string;
	context?: string;
	key: string;
	kind: SupervisionKind;
	sessionId?: string;
	ownerSessionId?: string;
	progress?: SupervisionProgress;
	running?: boolean;
	waitingForHuman?: boolean;
	readonly?: boolean;
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

/** 部门监督对象使用可打印稳定键;活动源与真实部长记录用 digest 合并。 */
function departmentSupervisionKey(input: { department: string; projectRoot: string; context?: string }): string {
	const digest = createHash("sha256")
		.update(`${resolve(input.projectRoot)}\u0000${input.department}\u0000${input.context ?? ""}`)
		.digest("base64url")
		.slice(0, 24);
	return `department:${input.department}:${digest}`;
}

export class MinisterHost {
	readonly registry: ProcessRegistry;
	#options: MinisterHostOptions;
	#entries = new Map<string, HostEntry>();
	#worker监督游标 = new Map<string, number>();
	#待办标记 = new Map<string, string[]>();
	#默认脉络?: string;
	#部长后台监听 = new Set<() => void>();
	#定时器?: ReturnType<typeof setInterval>;
	#活动取消订阅?: () => void;
	#活动源 = new Map<symbol, () => readonly HostActivity[]>();
	#活动监督键 = new Set<string>();
	#stopping = false;
	#监督: SupervisionState;
	#后台任务 = new Map<string, number>();
	#后台键 = new Map<string, Set<string>>();
	#后台运行键 = new Map<string, Set<string>>();
	#监督投递中 = new Set<string>();
	#监督任务 = new Map<string, SupervisionDeliveryTask>();
	#结果待投递 = new Map<string, PendingResultDelivery>();
	#结果任务 = new Map<string, Promise<boolean>>();
	/** 已取消但仍可能处于异步投递中的结果对象;晚到回执不得重新结算或唤醒。 */
	#结果投递已取消 = new Set<PendingResultDelivery>();
	#工具结束监听 = new Set<(event: HostToolEndEvent) => void>();
	setDefaultContext(context: string): void {
		this.#默认脉络 = context;
	}

	constructor(options: MinisterHostOptions = {}) {
		this.#options = options;
		this.registry = options.registry ?? new ProcessRegistry();
		this.#监督 = new SupervisionState({
			clock: () => this.#时钟().getTime(),
			workerMinutes: () =>
				options.监督分钟 ? options.监督分钟().工人 : readWorkerSupervisionMinutes(this.#paoHome()),
			departmentMinutes: () =>
				options.监督分钟 ? options.监督分钟().部门 : readDepartmentSupervisionMinutes(this.#paoHome()),
		});
		this.#活动取消订阅 = this.registry.subscribe(() => this.#重新同步全部活动());
		this.#重新同步全部活动();
		this.#启动监督时钟();
	}

	/**
	 * 接管通知面(接线层用):把缺省的 stderr 落地换成主控可见面(系统提示 section 等)。
	 * 提示线与监督快照都走它;接管后原 stderr 行为消失(同一通知不双发)。
	 */
	receiveNotice(sink: (text: string, category: DispatchNotifyCategory) => void): void {
		this.#options.通知 = sink;
	}

	/**
	 * 把当前普通部长会话登记为自己的监督上级。适用于部长进程内的 host.list 为空、
	 * 却需要审阅本部门工人提醒/结果的场景;不授予拉起或散场其他部长的能力。
	 */
	registerLocalSupervisor(input: {
		department: string;
		projectRoot: string;
		context: string;
		sessionId?: string;
		notify: (body: string, category: DispatchNotifyCategory) => void;
	}): void {
		this.#options.本地上级 = {
			department: input.department,
			projectRoot: input.projectRoot,
			context: input.context,
			...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		};
		this.#options.本地通知 = input.notify;
		this.#重新同步全部活动();
		this.#启动监督时钟();
	}

	#时钟(): Date {
		return this.#options.时钟?.() ?? new Date();
	}

	#paoHome(): string | undefined {
		return (
			this.#options.paoHome ??
			this.#options.resolvePaoHome?.()?.trim() ??
			(process.env.PAO_HOME?.trim() || undefined)
		);
	}

	#保温(): WarmConfig {
		return this.#options.保温?.() ?? readWarmConfig(this.#paoHome());
	}

	#通知(text: string, category: DispatchNotifyCategory = "result"): void {
		const notify =
			this.#options.通知 ??
			((t: string) =>
				process.stderr.write(`PAO 宿主:${t}
`));
		notify(text, category);
	}

	#后台通知(): void {
		try {
			this.#options.后台变化?.();
		} catch (error) {
			logError(`PAO 宿主:后台变化回调失败:${error instanceof Error ? error.message : String(error)}`);
		}
		for (const listener of [...this.#部长后台监听]) {
			try {
				listener();
			} catch (error) {
				logError(`PAO 宿主:后台订阅失败:${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** 宿主内部消费部长 RPC 工具结束事件;不注册模型工具,也不主动唤醒模型。 */
	#工具结束(event: Omit<HostToolEndEvent, "type">): void {
		for (const listener of [...this.#工具结束监听]) {
			try {
				listener({ type: "tool_execution_end", ...event });
			} catch (error) {
				logWarn(`PAO 宿主:工具结束事件处理失败:${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** 监听真实的部长工具结束事件;仅供宿主接线消费受控确认回执。 */
	subscribeToolEnd(listener: (event: HostToolEndEvent) => void): () => void {
		this.#工具结束监听.add(listener);
		return () => this.#工具结束监听.delete(listener);
	}

	/** 当前在途部长任务数:本人 RPC 受理/运行数加真实子后台 running/unread;空闲热会话不计。 */
	backgroundCount(): { inFlight: number } {
		const own = [...this.#后台任务.values()].reduce((sum, count) => sum + count, 0);
		const child = [...this.#entries.values()].reduce(
			(sum, entry) => (entry.停止 ? sum : sum + entry.state.子后台运行中 + entry.state.子后台未读),
			0,
		);
		return { inFlight: own + child };
	}

	/** 按真实部长路由读取本人受理/运行/子后台数;会话不匹配或热会话不存在返回 0。 */
	backgroundCountFor(input: { department: string; projectRoot: string; context?: string; sessionId?: string }): {
		inFlight: number;
	} {
		const entry = this.#entries.get(
			bindingKeyValue({
				部门: input.department,
				项目根: input.projectRoot,
				脉络: input.context ?? this.#默认脉络,
			}),
		);
		if (!entry || entry.停止) return { inFlight: 0 };
		if (input.sessionId !== undefined && entry.handle.会话标识 !== input.sessionId) return { inFlight: 0 };
		const own = this.#后台任务.get(entry.key) ?? 0;
		// unread 在通知正文被下游读入并回发清零前仍代表真实后台工作,不能提前判定空闲。
		return { inFlight: own + entry.state.子后台运行中 + entry.state.子后台未读 };
	}

	/** 监听部长后台和部长会话状态变化。返回幂等取消函数;不会唤醒模型、发送通知。 */
	subscribeBackground(listener: () => void): () => void {
		this.#部长后台监听.add(listener);
		return () => this.#部长后台监听.delete(listener);
	}

	#后台清空(entry: HostEntry): void {
		this.#后台键.delete(entry.key);
		this.#后台运行键.delete(entry.key);
		entry.后台键.clear();
		entry.后台运行键.clear();
		entry.注入待运行.clear();
		entry.当前任务 = undefined;
		if (this.#后台任务.delete(entry.key)) this.#后台通知();
	}

	#需要监督(): boolean {
		if (this.#监督.size() > 0 || this.#结果待投递.size > 0) return true;
		try {
			if (this.#活动().length === 0 && ![...this.#entries.values()].some((entry) => this.#部门仍工作(entry)))
				return false;
			const minutes = this.#options.监督分钟?.() ?? {
				工人: readWorkerSupervisionMinutes(this.#paoHome()),
				部门: readDepartmentSupervisionMinutes(this.#paoHome()),
			};
			return minutes.工人 > 0 || minutes.部门 > 0;
		} catch (error) {
			logWarn(`PAO 宿主:读取活动快照失败:${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	#活动(): HostActivity[] {
		const merged = new Map<string, HostActivity>();
		const sources = [...(this.#options.活动 ? [this.#options.活动] : []), ...this.#活动源.values()];
		for (const source of sources) {
			for (const item of source()) merged.set(item.key, item);
		}
		return [...merged.values()];
	}

	/**
	 * 登记外部活动源。宿主按自己的监督时钟读取 source。返回值取消本来源并清理
	 * 相应监督记录,构造参数提供的活动源和手动 trackSupervision 记录不受影响。
	 * 调用方负责在会话关闭时取消,并在新会话按新的 runner/owner 重新订阅。
	 */
	observeActivity(source: () => readonly HostActivity[]): () => void {
		const id = Symbol("activity");
		this.#活动源.set(id, source);
		this.#重新同步全部活动();
		this.#启动监督时钟();
		return () => {
			if (!this.#活动源.delete(id)) return;
			this.#重新同步全部活动();
			this.#停止空闲监督时钟();
		};
	}

	/** 外部运行态变更后主动刷新;不唤醒模型。 */
	refreshActivity(): void {
		this.#重新同步全部活动();
		this.#启动监督时钟();
	}

	/** 部长本人仍有在途任务,或它持有的真实子后台仍未清零。 */
	#部门仍工作(entry: HostEntry): boolean {
		if (entry.停止) return false;
		return (
			(this.#后台任务.get(entry.key) ?? 0) > 0 ||
			entry.state.运行中 ||
			entry.state.子后台运行中 > 0 ||
			entry.state.子后台未读 > 0
		);
	}

	#启动监督时钟(): void {
		if (this.#定时器 || this.#stopping || !this.#需要监督()) return;
		const timer = setInterval(() => this.#tickSupervision(), this.#options.监督检查毫秒 ?? 20_000);
		timer.unref?.();
		this.#定时器 = timer;
	}

	#停止空闲监督时钟(): void {
		if (!this.#定时器 || this.#监督.size() > 0 || this.#结果待投递.size > 0 || this.#监督投递中.size > 0) return;
		clearInterval(this.#定时器);
		this.#定时器 = undefined;
	}

	#tickSupervision(): void {
		if (this.#stopping) return;
		this.#同步部门活动();
		for (const wake of this.#监督.due()) {
			if (this.#监督投递中.has(wake.noticeKey)) continue;
			const task = this.#投递监督(wake)
				.then(() => true)
				.catch((error) => {
					logWarn(`PAO 宿主:监督投递失败:${error instanceof Error ? error.message : String(error)}`);
					return false;
				})
				.finally(() => this.#监督任务.delete(wake.noticeKey));
			this.#监督任务.set(wake.noticeKey, task);
		}
		this.#停止空闲监督时钟();
	}

	/** 用 registry 与可选外部活动快照重建“仍在工作”集合。权限只读不排除;停审/待人工/无活才排除。 */
	#重新同步全部活动(): void {
		if (this.#stopping) return;
		this.#同步部门活动();
	}

	#同步部门活动(): void {
		if (this.#stopping) return;
		const active = this.#活动();
		const nowKeys = new Set<string>();
		const departmentKeys = new Set<string>();
		const departments = new Map<string, Parameters<SupervisionState["track"]>[0]>();
		const addDepartment = (
			department: string,
			projectRoot: string,
			context: string | undefined,
			progress: SupervisionProgress | undefined,
		): void => {
			const key = departmentSupervisionKey({ department, projectRoot, context });
			departmentKeys.add(key);
			if (!departments.has(key))
				departments.set(key, {
					key,
					kind: "department",
					department,
					projectRoot,
					...(context !== undefined ? { context } : {}),
					...(progress !== undefined ? { progress } : {}),
				});
		};
		for (const item of active) {
			if (item.running === false || item.waitingForHuman === true) continue;
			if (item.kind === "department") {
				addDepartment(item.department, item.projectRoot, item.context, item.progress);
				nowKeys.add(departmentSupervisionKey(item));
				continue;
			}
			nowKeys.add(item.key);
			this.#监督.track({
				key: item.key,
				kind: item.kind,
				department: item.department,
				projectRoot: item.projectRoot,
				...(item.context !== undefined ? { context: item.context } : {}),
				...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
				...(item.ownerSessionId !== undefined ? { ownerSessionId: item.ownerSessionId } : {}),
				...(item.progress !== undefined ? { progress: item.progress } : {}),
			});
		}
		for (const entry of this.#entries.values()) {
			if (!this.#部门仍工作(entry)) continue;
			const context = entry.handle.脉络 ?? entry.state.会话标识;
			addDepartment(entry.handle.部门, entry.handle.项目根, context, {
				recentProgress:
					entry.state.子后台运行中 > 0
						? `真实子后台运行中 ${entry.state.子后台运行中}${entry.state.子后台未读 ? `，未读 ${entry.state.子后台未读}` : ""}`
						: "部长当前存在已受理任务",
				evidence: [`宿主部长会话 ${entry.handle.会话标识}`],
			});
		}
		for (const entry of this.registry.list()) {
			if (!entry.running || entry.tags === "部长") continue;
			const dept = entry.supervisor_dept ?? entry.dept;
			if (!dept || !entry.task_root) continue;
			const key = entry.supervision_key ?? entry.card_path ?? `worker:${entry.run_id ?? entry.pid}`;
			if (nowKeys.has(key)) continue;
			nowKeys.add(key);
			this.#监督.track({
				key,
				kind: "worker",
				department: dept,
				projectRoot: entry.task_root,
				...(entry.supervisor_context !== undefined ? { context: entry.supervisor_context } : {}),
				...(entry.supervision_owner !== undefined ? { ownerSessionId: entry.supervision_owner } : {}),
				progress: {
					...(entry.supervision_goal ? { goal: entry.supervision_goal } : {}),
					...(entry.supervision_progress ? { recentProgress: entry.supervision_progress } : {}),
					...(entry.supervision_blocker ? { blocker: entry.supervision_blocker } : {}),
					...(entry.supervision_evidence ? { evidence: entry.supervision_evidence } : {}),
				},
			});
		}
		for (const work of departments.values()) this.#监督.track(work);
		for (const key of this.#活动监督键) {
			if (!nowKeys.has(key) && !departmentKeys.has(key)) this.#监督.finish(key);
		}
		this.#活动监督键 = new Set([...nowKeys, ...departmentKeys]);
		for (const delivery of [...this.#结果待投递.values()]) {
			if (this.#结果任务.has(delivery.key)) continue;
			const task = this.#投递结果(delivery)
				.catch((error) => {
					logWarn(
						`PAO 宿主:待投递上级结果失败(${delivery.key}):${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				})
				.finally(() => {
					this.#结果任务.delete(delivery.key);
					this.#结果投递已取消.delete(delivery);
				});
			this.#结果任务.set(delivery.key, task);
		}
		if (this.#活动监督键.size > 0) this.#启动监督时钟();
		else this.#停止空闲监督时钟();
	}

	async #投递结果(delivery: PendingResultDelivery): Promise<boolean> {
		try {
			if (this.#stopping || this.#结果投递已取消.has(delivery)) return false;
			if (delivery.target === "main") {
				if (this.#stopping || this.#结果投递已取消.has(delivery)) return false;
				this.#通知(delivery.text, delivery.category);
			} else if (this.#是本地部长(delivery.route)) {
				if (!this.#options.本地通知) return false;
				if (this.#stopping || this.#结果投递已取消.has(delivery)) return false;
				this.#options.本地通知(delivery.text, delivery.category);
			} else {
				const result = await this.inject(
					delivery.route.department,
					delivery.route.projectRoot,
					delivery.text,
					delivery.route.context,
					"followUp",
				);
				if (!result.ok) return false;
				// 取消/全停可能发生在等待 RPC 回执期间;回执晚到时也不能再把对象重新唤醒或退出重试。
				if (this.#stopping || this.#结果投递已取消.has(delivery)) return false;
			}
			this.#结果待投递.delete(delivery.key);
			this.#结果投递已取消.delete(delivery);
			for (const work of delivery.works ?? []) this.#监督.finish(work.key);
			this.#后台通知();
			this.#停止空闲监督时钟();
			return true;
		} catch (error) {
			logWarn(
				`PAO 宿主:上级结果投递失败(${delivery.key}):${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	/**
	 * 取消对象时清掉它的延迟投递,并让正在等待 RPC 的投递在回执晚到后不再结算为成功。
	 * 返回是否找到监督记录或待投递结果。
	 */
	#取消监督投递(key: string): boolean {
		let found = false;
		for (const [deliveryKey, delivery] of [...this.#结果待投递]) {
			if (delivery.key !== key && !(delivery.works ?? []).some((work) => work.key === key)) continue;
			this.#结果待投递.delete(deliveryKey);
			this.#结果投递已取消.add(delivery);
			found = true;
		}
		return found;
	}

	#是本地部长(route: SupervisionRoute): boolean {
		const local = this.#options.本地上级;
		return (
			local !== undefined &&
			local.department === route.department &&
			local.projectRoot === route.projectRoot &&
			(local.context ?? "") === (route.context ?? "")
		);
	}

	async #投递监督(wake: SupervisionWake): Promise<void> {
		if (this.#监督投递中.has(wake.noticeKey)) return;
		this.#监督投递中.add(wake.noticeKey);
		try {
			// 部门检查按主控 owner 合并,不能把第一个部门的会话坐标当成唯一投递目标。
			const perTarget = new Map<string, { route: SupervisionRoute; keys: string[]; text: string[] }>();
			for (const work of wake.works) {
				const route =
					wake.kind === "department" ? { department: work.department, projectRoot: work.projectRoot } : wake.route;
				const targetKey = `${work.department}\u0000${work.projectRoot}\u0000${work.context ?? wake.route.context ?? ""}`;
				const target = perTarget.get(targetKey) ?? {
					route: {
						department: route.department,
						projectRoot: route.projectRoot,
						...((work.context ?? wake.route.context) ? { context: work.context ?? wake.route.context } : {}),
					},
					keys: [],
					text: [],
				};
				target.keys.push(work.key);
				target.text.push(renderSupervisionWork(work));
				perTarget.set(targetKey, target);
			}
			const failures: string[] = [];
			if (wake.target === "main") {
				// 主控通过共享 notifySurface 接收正文;多部门仍由 owner 合并为一条。
				this.#通知(wake.text, "supervision");
				for (const work of wake.works) this.#监督.noticeInjected(work.key, wake.noticeKey);
			} else {
				for (const target of perTarget.values()) {
					const text = [
						`[监督检查] 工人检查间隔 ${wake.intervalMinutes} 分钟`,
						...target.text,
						"请判断偏航、重复劳动、范围扩张和阻塞;普通监督不暂停下级。",
						...target.keys.map(
							(key) =>
								`逐个使用 pao_ack_supervision(key="${key}")确认已实际检查后再调用;未确认的提醒不会重复唤醒。`,
						),
					].join("\n\n");
					const isLocal = this.#是本地部长(target.route);
					let delivered = false;
					let failure = "未知原因";
					if (isLocal) {
						if (this.#options.本地通知) {
							this.#options.本地通知(text, "supervision");
							delivered = true;
						} else failure = "本地部长通知回调未配置";
					} else {
						const result = await this.inject(
							target.route.department,
							target.route.projectRoot,
							text,
							target.route.context,
							"followUp",
						);
						delivered = result.ok;
						failure = result.原因 ?? failure;
					}
					if (delivered) {
						for (const key of target.keys) this.#监督.noticeInjected(key, wake.noticeKey);
					} else {
						for (const key of target.keys) this.#监督.noticeRejected(key);
						failures.push(failure);
					}
				}
			}
			if (failures.length > 0) {
				this.#通知(`${wake.text}\n监督提醒投递失败:${failures.join("；")};未当作已检查`, "failure");
				return;
			}
		} catch (error) {
			for (const key of wake.key.split("\n")) this.#监督.noticeRejected(key);
			this.#通知(
				`${wake.text}\n监督提醒投递异常:${error instanceof Error ? error.message : String(error)};未当作已检查`,
				"failure",
			);
		} finally {
			this.#监督投递中.delete(wake.noticeKey);
		}
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
			process.stderr.write(`PAO 宿主:监督审计落盘失败:${error instanceof Error ? error.message : String(error)}
`);
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
			this.#通知(`部长会话子进程 spawn error(命令 ${invocation.command}):${error.message}`, "failure");
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
			后台任务: 0,
			后台键: new Set(),
			后台运行键: new Set(),
			注入待运行: new Map(),
			结果由调用方汇总: options.结果由调用方汇总 === true,
		};
		this.#entries.set(key, entry);
		this.#attachPump(entry);
		proc.once("close", () => {
			// 摘除登记前先留证：stderr 尾部只存内存，进程退出即丢（含握手失败场景，close 时 entry 可能仍在登记）；
			// 走过散场（标记已置）的退出是预期收尾，close 不再落「进程退出」——此路只兜真异常死亡
			if (!entry.散场留证) this.#留证(entry, "进程退出", "退出");
			this.#记录费用缺口(entry);
			entry.任务?.finish(new Error("部长进程退出，任务未完成"));
			this.#后台清空(entry);
			this.#结算注入(entry, "部长进程退出，注入未获受理");
			entry.解决握手?.(new Error("部长会话在握手完成前退出"));
			// 崩溃散场:钩子没跑,不落交接(交接文件是旧货,恢复读取核时效属 S3 口径)
			if (this.#entries.get(key) === entry) {
				this.registry.markExited(pid);
				this.#entries.delete(key);
			}
			this.#后台通知();
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
			this.#通知(note, "failure");
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

	#记录任务受理(entry: HostEntry, id: string): void {
		if (!entry.后台键.has(`minister:${id}`)) {
			entry.后台键.add(`minister:${id}`);
			this.#后台任务.set(entry.key, (this.#后台任务.get(entry.key) ?? 0) + 1);
			this.#重新同步全部活动();
			this.#启动监督时钟();
			this.#后台通知();
		}
	}

	#后台转入运行(entry: HostEntry, id: string): void {
		const key = `minister:${id}`;
		if (entry.后台运行键.has(key)) return;
		if (!entry.后台键.delete(key)) {
			// 任务回执可能早于 agent_start 到达;此时任务已在运行键里,不能丢计数。
			entry.后台运行键.add(key);
			this.#后台通知();
			return;
		}
		entry.后台运行键.add(key);
		this.#后台通知();
	}

	/**
	 * RPC 已受理但 agent_start 尚未到达时也继续占用后台计数。
	 * 注入回执与任务回执共用同一个判据;只有 agent_settled/退出/拒收才从计数移除。
	 */
	#开始待启动窗口(entry: HostEntry, id: string): void {
		this.#记录任务受理(entry, id);
	}

	/** 记录一个任务 episode 的结算;真正投递只在本人模型 idle 且子后台收敛时发生。 */
	#记录任务结算(entry: HostEntry, id: string, failure?: Error): void {
		const episode = entry.当前任务;
		if (!episode || episode.id !== id || episode.settled) return;
		episode.settled = true;
		if (failure) episode.failure = failure.message;
		this.#尝试投递任务结果(entry);
	}

	/** 取走一个 episode 的最终输出;前置条件全部成立后才标记,空闲旧输出不会重报。 */
	#尝试投递任务结果(entry: HostEntry): void {
		if (this.#stopping || entry.停止) return;
		const episode = entry.当前任务;
		if (!episode || !episode.settled || episode.supervised) return;
		if (entry.结果由调用方汇总 || entry.state.运行中) return;
		if (entry.state.子后台运行中 > 0 || entry.state.子后台未读 > 0) return;
		episode.supervised = true;
		const output = entry.state.最终输出.trim().replace(/\s+/g, " ");
		const summary = output.length > 320 ? `${output.slice(0, 320)}…` : output;
		const target = [`部门 ${entry.handle.部门}`, `会话 ${entry.handle.会话标识}`, `项目 ${entry.handle.项目根}`].join(
			"｜",
		);
		const text = episode.failure
			? `[部长失败] ${target}\n原因:${episode.failure}\n完整会话仍可按会话标识查询`
			: `[部长完成] ${target}\n摘要:${summary || "(部长未返回正文)"}\n完整会话仍可按会话标识查询`;

		if (!episode.aborted) this.#通知(text, episode.failure ? "failure" : "result");
	}

	#完成任务(entry: HostEntry, id: string, reason?: string): void {
		entry.注入待运行.delete(id);
		const key = `minister:${id}`;
		const queued = entry.后台键.delete(key);
		const running = entry.后台运行键.delete(key);
		if (!queued && !running) return;
		const next = Math.max(0, (this.#后台任务.get(entry.key) ?? 1) - 1);
		if (next === 0) this.#后台任务.delete(entry.key);
		else this.#后台任务.set(entry.key, next);
		this.#后台通知();
		if (reason) this.#通知(reason, "failure");
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
		if (this.#stopping || entry.停止) return;
		const delta = absorbMinisterEvent(entry.state, line);
		if (!delta.可解析) return;
		const parsedEvent =
			delta.lifecycle === "agent_start" || delta.lifecycle === "agent_settled"
				? (JSON.parse(line) as {
						type?: string;
						id?: string;
						command?: string;
						success?: boolean;
						error?: string;
						data?: { disposition?: unknown };
					})
				: undefined;
		if (parsedEvent?.type === "agent_start" && !entry.任务 && entry.注入待运行.size > 0) {
			const pendingInjection = [...entry.注入待运行].find(([, started]) => started) ?? [...entry.注入待运行][0];
			if (pendingInjection) {
				entry.注入待运行.delete(pendingInjection[0]);
				this.#后台转入运行(entry, pendingInjection[0]);
			}
		}
		if (delta.toolEnd) {
			this.#工具结束({
				department: entry.handle.部门,
				projectRoot: entry.handle.项目根,
				...(entry.handle.脉络 !== undefined ? { context: entry.handle.脉络 } : {}),
				sessionId: entry.handle.会话标识,
				...delta.toolEnd,
			});
		}
		if (entry.当前任务 || entry.任务) {
			const event = JSON.parse(line) as {
				type?: string;
				message?: { role?: string; stopReason?: string; errorMessage?: string };
			};
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const aborted = event.message.stopReason === "aborted";
				const failure =
					event.message.stopReason === "error" || aborted
						? new Error(
								`部长模型请求${aborted ? "已取消" : "失败"}:${event.message.errorMessage ?? event.message.stopReason}`,
							)
						: undefined;
				// 同一模型运行可自动重试；以最后一个 assistant 结果为准，成功会清除旧错误。
				if (entry.任务) entry.任务.failure = failure;
				if (entry.当前任务 && (!entry.任务 || entry.当前任务.id === entry.任务.id)) {
					entry.当前任务.aborted = aborted;
					entry.当前任务.failure = failure?.message;
				}
			}
		}
		if (entry.任务) {
			const event = JSON.parse(line) as {
				type?: string;
				id?: string;
				command?: string;
				success?: boolean;
				error?: string;
				message?: { role?: string; stopReason?: string; errorMessage?: string };
			};
			if (event.type === "agent_start") {
				entry.任务.started = true;
				if (!entry.当前任务 || entry.当前任务.id !== entry.任务.id) {
					entry.当前任务 = { id: entry.任务.id, settled: false, supervised: false, aborted: false };
				}
				this.#后台转入运行(entry, entry.任务.id);
			}
			if (event.type === "response" && event.id === entry.任务.id && event.success === true)
				this.#记录任务受理(entry, entry.任务.id);
			if (event.type === "response" && event.id === entry.任务.id && event.success === false)
				entry.任务.finish(new Error(`部长 RPC 失败:${event.error ?? event.command}`));
			else if (event.type === "agent_settled" && entry.任务.started) {
				this.#记录任务结算(entry, entry.任务.id, entry.任务.failure);
				this.#完成任务(entry, entry.任务.id);
				entry.任务.finish(entry.任务.failure);
			}
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
			const responseId = response.type === "response" ? response.id : undefined;
			const pending = responseId ? entry.注入待决.get(responseId) : undefined;
			if (responseId && pending) {
				// 只结算这条 id 自己的回执:旧请求的响应不得算作新注入的结果
				entry.注入待决.delete(responseId);
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
				if (response.success === true && 处置 === "handled") this.#完成任务(entry, responseId);
				else if (response.success === true) {
					this.#记录任务受理(entry, responseId);
					if (!entry.当前任务 || entry.当前任务.settled) {
						entry.当前任务 = { id: responseId, settled: false, supervised: false, aborted: false };
					}
					entry.注入待运行.set(responseId, 处置 === "started");
					if (处置 === "started") {
						entry.注入待运行.delete(responseId);
						this.#后台转入运行(entry, responseId);
					}
				} else this.#完成任务(entry, responseId);
			}
		}
		if (delta.childBackground) {
			// 子后台计数只更新保活与监督来源;与当前模型 episode 分开结算。
			this.#重新同步全部活动();
			this.#启动监督时钟();
			this.#后台通知();
			if (delta.childBackground.running === 0 && delta.childBackground.unread === 0) {
				this.#尝试投递任务结果(entry);
			}
		}
		if (delta.lifecycle === "agent_settled") {
			// 热会话 inject 也会开启任务，不能只结算 runTask 持有的 entry.任务。
			if (entry.当前任务) this.#记录任务结算(entry, entry.当前任务.id);
			this.#重新同步全部活动();
			// agent_settled 明确表示没有后续自动重试、压缩或排队续跑。多个 followUp
			// 可能在同一次 agent 循环内消费且不再逐个触发 agent_start,此时统一结算
			// 本会话已受理的 queued/running,避免永久泄漏。
			for (const key of new Set([...entry.后台键, ...entry.后台运行键])) {
				this.#完成任务(entry, key.slice("minister:".length));
			}
			if (entry.任务?.started) {
				this.#记录任务结算(entry, entry.任务.id, entry.任务.failure);
				this.#完成任务(entry, entry.任务.id);
				entry.任务.finish(entry.任务.failure);
			}
			this.#尝试投递任务结果(entry);
			this.#后台通知();
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
			process.stderr.write(`PAO 宿主:保险丝核对失败:${error instanceof Error ? error.message : String(error)}
`);
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
			process.stderr.write(`PAO 宿主:部长用量落账失败:${error instanceof Error ? error.message : String(error)}
`);
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
				"progress",
			);
			this.#审计("提示线", this.#会话目标(handle), `累计轮次达 ${roundLine}(提示不杀)`);
		}
		if (!handle.调用提示已发 && handle.累计.工具调用 >= callLine) {
			handle.调用提示已发 = true;
			this.#通知(
				`[提示线] 部长会话〔${handle.部门}@${projectName(handle.项目根)}〕(pid ${handle.pid}) 累计工具调用达 ${callLine}(提示不杀;正当长活可继续)`,
				"progress",
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
			"supervision",
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
			this.#开始待启动窗口(entry, id);
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
					this.#完成任务(entry, id);
					if (error || stopping) reject(error ?? new Error("部长任务已取消或超时"));
					else resolveTask(entry.state.最终输出);
				},
			};
			input.signal?.addEventListener("abort", stop, { once: true });
			entry.state.最终输出 = "";
			try {
				this.#写命令(entry, { type: "prompt", id, message: input.文本 });
			} catch (error) {
				this.#完成任务(entry, id);
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
		// 写命令前先计在途:即使 RPC 已受理、agent_start 还没到,print 也不能视为空闲。
		this.#开始待启动窗口(entry, id);
		const 待决 = entry.注入待决 ?? new Map();
		entry.注入待决 = 待决;
		const timeoutMs = this.#options.注入超时毫秒 ?? 30_000;
		return await new Promise<MinisterInjectResult>((resolve) => {
			const timer = setTimeout(() => {
				待决.delete(id);
				this.#完成任务(entry, id);
				resolve({ ok: false, 模式: mode, 原因: `部长 pid=${entry.handle.pid} 未在 ${timeoutMs}ms 内回执本次注入` });
			}, timeoutMs);
			const settle = (result: MinisterInjectResult): void => {
				clearTimeout(timer);
				待决.delete(id);
				if (!result.ok) this.#完成任务(entry, id);
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
		for (const [id, pending] of 待决) {
			this.#完成任务(entry, id);
			pending.resolve({ ok: false, 模式: pending.模式, 原因 });
		}
	}

	// ── 保险丝与散场 ────────────────────────────────────────────────────

	/**
	 * 空闲熔断核对(挂事件边界;主控侧工具边界也可显式调用)。只有空闲分钟是熔断线:
	 * 超线者先落短交接→树杀→登记表摘除。缺保温.json=不保温,本函数直接返回。
	 */
	async checkFuse(): Promise<TeardownRecord[]> {
		this.#重新同步全部活动();
		const warmth = this.#保温();
		if (!warmth.存在) return [];
		const idleMinutes = warmth.空闲分钟 ?? WARM_DEFAULTS.空闲分钟;
		const now = this.#时钟().getTime();
		const fuse: TeardownRecord[] = [];
		for (const entry of [...this.#entries.values()]) {
			if (this.#部门仍工作(entry)) continue;
			const idleMs = now - Date.parse(entry.handle.最近事件时间);
			if (idleMs < idleMinutes * 60_000) continue;
			if (this.#有匹配运行活动(entry)) continue;
			fuse.push(await this.#散场Entry(entry, `空闲熔断(超过 ${idleMinutes} 分钟无事件)`));
		}
		return fuse;
	}

	/**
	 * 部长模型 idle 不代表它负责的部门没有工作。只在该部长绑定仍有运行活动时跳过
	 * 空闲熔断;待人工、停审和终态对象不算。活动读取失败时本轮保守跳过,不连带杀工人。
	 */
	#有匹配运行活动(entry: HostEntry): boolean {
		const matches = (input: {
			department: string;
			projectRoot: string;
			context?: string;
			running?: boolean;
			waitingForHuman?: boolean;
		}): boolean => {
			if (input.running === false || input.waitingForHuman === true) return false;
			if (input.department !== entry.handle.部门 || resolve(input.projectRoot) !== entry.handle.项目根) return false;
			return !input.context || !entry.handle.脉络 || input.context === entry.handle.脉络;
		};
		try {
			if (this.#活动().some(matches)) return true;
		} catch (error) {
			logWarn(
				`PAO 宿主:空闲熔断无法读取活动,本轮保守跳过:${error instanceof Error ? error.message : String(error)}`,
			);
			return true;
		}
		return this.registry.list().some(
			(item) =>
				item.running &&
				item.tags !== "部长" &&
				Boolean(item.task_root) &&
				matches({
					department: item.supervisor_dept ?? item.dept ?? "",
					projectRoot: item.task_root ?? "",
					...(item.supervisor_context ? { context: item.supervisor_context } : {}),
				}),
		);
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
				this.#通知(`散场交接落盘失败(pid ${handle.pid}):${record.交接失败}(继续树杀,交接文件为旧货)`, "failure");
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
					"failure",
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
			`${snapshot}
(上级监督唤醒:看一眼,可不动或走干涉)`,
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

	// ── 分层监督公共面(供主控 index、工作流 bridge 和测试接入) ────────────────

	/** 跟随一个仍在工作的工人或部门;重复登记会更新进度并保留原计时。 */
	trackSupervision(work: {
		key: string;
		kind: SupervisionKind;
		department: string;
		projectRoot: string;
		context?: string;
		sessionId?: string;
		ownerSessionId?: string;
		progress?: SupervisionProgress;
		waitingForHuman?: boolean;
		readonly?: boolean;
	}): void {
		this.#监督.track(work);
		this.#启动监督时钟();
	}

	updateSupervision(
		key: string,
		patch: Partial<{
			department: string;
			projectRoot: string;
			context?: string;
			sessionId?: string;
			ownerSessionId?: string;
			progress?: SupervisionProgress;
			waitingForHuman?: boolean;
			readonly?: boolean;
		}>,
	): boolean {
		return this.#监督.update(key, patch);
	}

	/** 显式确认已处理或已实质检查;只有这里会重置监督计时。 */
	markSupervisionHandled(key: string): boolean {
		return this.#options.本地上级 ? this.markLocalSupervisionHandled(key) : this.#监督.markHandled(key);
	}

	/** 部长进程提交的确认回执:父宿主按真实会话与对象路由核验后重计时。 */
	markSupervisionHandledFrom(event: HostToolEndEvent, key: string, receiptSessionId?: string): boolean {
		if (event.toolName !== "pao_ack_supervision" || event.isError) return false;
		// 子进程自报会话必须与父宿主持有的实际 RPC 会话一致,不能只靠部门/项目字面匹配。
		if (receiptSessionId !== undefined && receiptSessionId !== event.sessionId) return false;
		return this.#监督.markHandledForRoute(key, {
			department: event.department,
			projectRoot: event.projectRoot,
			...(event.context !== undefined ? { context: event.context } : {}),
			sessionId: event.sessionId,
		});
	}

	/** 当前进程自己的部长会话提交确认时,核验它确实是对象所属部门与项目。 */
	markLocalSupervisionHandled(key: string): boolean {
		const local = this.#options.本地上级;
		if (!local) return false;
		return this.#监督.markHandledForBinding(key, {
			department: local.department,
			projectRoot: local.projectRoot,
			...(local.context !== undefined ? { context: local.context } : {}),
		});
	}

	/**
	 * 结束一个对象。完成/失败/待裁决会立即投递直接上级并退出周期监督;
	 * canceled 与普通完成相同,只退出。正文由调用方给真实摘要,宿主不补造。
	 */
	async finishSupervision(input: {
		key: string;
		outcome: SupervisionOutcome;
		detail: string;
		noticeKey?: string;
	}): Promise<MinisterInjectResult | { ok: true }> {
		if (input.outcome === "canceled") {
			const recorded = this.#监督.finish(input.key);
			const pending = this.#取消监督投递(input.key);
			if (!recorded && !pending) return { ok: false, 原因: `未登记监督对象:${input.key}` };
			const target = recorded?.kind === "department" ? `部门 ${recorded.department}` : `工人 ${input.key}`;
			this.#审计("监督取消", target, input.detail);
			this.#后台通知();
			this.#停止空闲监督时钟();
			return { ok: true };
		}
		const work = this.#监督.finish(input.key);
		if (!work) return { ok: false, 原因: `未登记监督对象:${input.key}` };
		const target = work.kind === "worker" ? `工人 ${input.key}` : `部门 ${work.department}`;
		const text = `[${input.outcome === "completed" ? "完成" : input.outcome === "failed" ? "失败" : input.outcome === "needs_ruling" ? "待裁决" : "已取消"}] ${target}
${input.detail}`;
		const category: PendingResultDelivery["category"] =
			input.outcome === "failed" ? "failure" : input.outcome === "needs_ruling" ? "ruling" : "result";
		const result =
			work.kind === "department"
				? { ok: true as const }
				: this.#是本地部长(work)
					? this.#options.本地通知
						? (() => {
								this.#options.本地通知!(text, category);
								return { ok: true as const };
							})()
						: { ok: false as const, 原因: "本地部长通知回调未配置" }
					: await this.inject(work.department, work.projectRoot, text, work.context, "followUp");
		if (work.kind === "department" || !result.ok) {
			const deliveryKey = input.noticeKey ?? `finish:${input.key}`;
			this.#结果待投递.set(deliveryKey, {
				key: deliveryKey,
				route: {
					department: work.department,
					projectRoot: work.projectRoot,
					...(work.context !== undefined ? { context: work.context } : {}),
				},
				target: work.kind === "department" ? "main" : "minister",
				category,
				text,
				works: [{ ...work }],
			});
			await this.#投递结果(this.#结果待投递.get(deliveryKey)!);
			this.#启动监督时钟();
		}
		this.#停止空闲监督时钟();
		return result;
	}

	/** 主动同步一次外部活动/到期检查;异步投递仍由宿主完成,不等待模型。 */
	async flushSupervision(): Promise<void> {
		this.#tickSupervision();
		await Promise.allSettled([...this.#监督任务.values(), ...this.#结果任务.values()]);
	}

	/** 停止监督定时器、登记与后台订阅;保留进程散场能力,重复调用安全。 */
	stopTracking(): void {
		this.#stopping = true;
		if (this.#定时器) clearInterval(this.#定时器);
		this.#定时器 = undefined;
		this.#活动取消订阅?.();
		this.#活动取消订阅 = undefined;
		this.#活动源.clear();
		this.#活动监督键.clear();
		this.#监督.clear();
		this.#结果待投递.clear();
		this.#结果任务.clear();
		this.#结果投递已取消.clear();
		this.#监督投递中.clear();
		this.#监督任务.clear();
		this.#部长后台监听.clear();
		this.#工具结束监听.clear();
		this.#后台任务.clear();
		this.#后台键.clear();
		this.#后台运行键.clear();
	}

	/** 主会话结束:先停监督,再树杀全部部长进程。 */
	async shutdown(reason = "主会话关闭全停"): Promise<TeardownRecord[]> {
		this.stopTracking();
		return this.stopAll(reason);
	}

	/**
	 * 会话切换时清理旧会话监督,并恢复当前会话可再次启动跟踪。
	 * 构造时注入的活动源会保留;observeActivity 订阅属于注册它的会话,须由调用方
	 * 在 session_shutdown 取消并由新会话重新登记,避免旧会话闭包串入新会话。
	 */
	resetTracking(): void {
		this.stopTracking();
		this.#stopping = false;
		this.#活动取消订阅 = this.registry.subscribe(() => this.#重新同步全部活动());
		this.#重新同步全部活动();
		this.#启动监督时钟();
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
