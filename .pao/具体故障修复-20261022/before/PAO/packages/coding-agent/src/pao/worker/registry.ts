/**
 * 进程登记表:运行器本轮拉起的全部进程(pid、命令、卡号)。
 * 停止只处理登记在案的进程,不按进程名全局清理(架构 §1 后台运行契约)。
 */

import { pathKey } from "../shared/path-key.ts";
import { utcNow } from "../shared/time.ts";

export interface ProcessEntry {
	pid: number;
	card_no: string;
	/** 完整命令行(旧审计字段；进程日志只存脱敏标签) */
	command: string;
	登记时间: string;
	running: boolean;
	/**
	 * 归属部门(pao_dispatch_card/pao_fanout 拉起时填卡.部门,部门并发上限按它数活进程;
	 * 旧条目或非派单链路拉起的进程为 null)。可空,不改既有字段名(最小侵入)。
	 */
	dept: string | null;
	/**
	 * 派单理由留痕(pao_dispatch_card=单卡理由,pao_fanout=批次理由;供上级盘点审查,缺省 null)。
	 */
	dispatch_reason: string | null;
	/**
	 * 条目标签(可空):部长会话条目标「部长」(无对应卡,card_no 为空串);worker 条目为 null,
	 * 不填标签。最小侵入新增字段,不改既有字段名(M2-01 定案7)。
	 */
	tags?: string | null;
	card_path?: string;
	attempt?: number;
	run_id?: string;
	/** worker 读取共享卡与工作流状态的根。 */
	task_root?: string;
	/** 直接负责这张卡的部门;与 dept 同源,作为外部监督路由的显式字段。 */
	supervisor_dept?: string;
	/** 直接上级绑定脉络(工作流节点必须携带,普通部门可空)。 */
	supervisor_context?: string;
	/** 直接上级真实会话标识；普通部长自派工为当前部长，工作流为节点部长。 */
	supervisor_session?: string;
	/** 工作流实例/节点等业务对象名,仅用于监督摘要,避免正文转写。 */
	supervision_key?: string;
	/** 部门对象稳定键；不同部门即使同 owner/context 也必须不同。 */
	supervision_department_key?: string;
	supervision_label?: string;
	supervision_owner?: string;
	supervision_goal?: string;
	supervision_progress?: string;
	supervision_blocker?: string;
	supervision_evidence?: string[];
	supervision_target?: "local" | "minister";
	supervision_binding?: {
		source: "runtime" | "workflow";
		role: "main" | "minister" | "worker" | "unknown";
		target: "local" | "minister" | "department";
	};
	/** worker 路由解析角色的来源；只用于审计，不参与投递判断。 */
	supervision_role?: "main" | "minister" | "worker" | "unknown";
	/** 本次 worker 的真实执行根，也是 execution 长锁的键。 */
	execution_root?: string;
	worktree_id?: string;
	/** 本次冻结输入快照摘要。 */
	snapshot_digest?: string;
	/** 宿主证明摘要；启动前已与 execution-context 核对。 */
	worktree_binding_digest?: string;
	/** attempt 关联记录摘要；不得拿来冒充宿主证明摘要。 */
	execution_binding_digest?: string;
	/**
	 * 最近输出时间(stdout/stderr 任一有数据即刷新,ISO 字符串):B 档静默提醒的活性信号源。
	 * 可空新增字段,不改既有字段名;undefined = 登记以来尚未吐过任何字节(本身就是最强静默信号)。
	 */
	最近输出时间?: string;
	/**
	 * 认领租约四字段(S5 包3,运行器事实,不加卡协议字段):派发链认领时随 spawn 落登记条目。
	 * 认领时间/租约到期(ISO)＝监督信号(到期不自动放权,只提示需人裁决);认领代数＝孤儿显式
	 * 接管推进的代际;被接管＝该条目所属代已被接管,读投影据此拒旧 worker 状态覆盖。
	 */
	认领时间?: string;
	租约到期?: string;
	认领代数?: number;
	被接管?: boolean;
}

export class ProcessRegistry {
	#entries: ProcessEntry[] = [];
	/**
	 * pid → 同 pid 条目桶（含已退出条目；pid 复用时同 pid 多条并存）。
	 * markExited/markOutput 按 pid 定位走桶，免每次 stdout/stderr chunk 线性扫全表——
	 * 登记表只增不删（list() 是「本轮拉起全部进程」的审计面，消费方自行按 running 过滤），
	 * 索引与 #entries 同步维护，clear() 一并清。
	 */
	#byPid = new Map<number, ProcessEntry[]>();
	/** 认领代数（按卡路径计数,S5 包3）：0＝从未接管；孤儿显式接管 +1,旧条目随之打 被接管 */
	#generations = new Map<string, number>();

	/** 归一化卡路径键（Windows 大小写不敏感,shared/path-key 唯一实现,与 runner executionKey 同口径） */
	#cardKey(cardPath: string): string {
		return pathKey(cardPath);
	}

	/** 当前认领代数（无记录＝0）;新认领条目登记时取值 */
	claimGeneration(cardPath: string): number {
		return this.#generations.get(this.#cardKey(cardPath)) ?? 0;
	}

	/**
	 * 孤儿显式接管（S5 包3）：推进该卡的认领代数并把既有条目标 被接管——旧 worker 的
	 * 续命/释放/交还/回执不再代表当前尝试（读投影据此拒旧状态覆盖）。只在这里改代数。
	 */
	bumpClaimGeneration(cardPath: string): number {
		const key = this.#cardKey(cardPath);
		const next = (this.#generations.get(key) ?? 0) + 1;
		this.#generations.set(key, next);
		for (const entry of this.#entries)
			if (entry.card_path !== undefined && this.#cardKey(entry.card_path) === key) entry.被接管 = true;
		return next;
	}

	register(
		entry: Omit<ProcessEntry, "登记时间" | "running" | "dept" | "dispatch_reason"> & {
			登记时间?: string;
			dept?: string | null;
			dispatch_reason?: string | null;
			tags?: string | null;
		},
	): void {
		const recorded: ProcessEntry = {
			登记时间: utcNow(),
			running: true,
			...entry,
			// 部门/派单理由/标签归一为 null(不是 undefined):可空字段的「未填」语义,放 spread 后兜住显式 undefined
			dept: entry.dept ?? null,
			dispatch_reason: entry.dispatch_reason ?? null,
			tags: entry.tags ?? null,
		};
		this.#entries.push(recorded);
		const bucket = this.#byPid.get(recorded.pid);
		if (bucket) bucket.push(recorded);
		else this.#byPid.set(recorded.pid, [recorded]);
		this.#changed();
	}

	markExited(pid: number, runId?: string): void {
		for (const entry of this.#byPid.get(pid) ?? []) {
			if (runId === undefined || entry.run_id === runId) entry.running = false;
		}
		this.#changed();
	}

	/**
	 * 活性打点:进程有输出(stdout/stderr)即刷新最近输出时间。按 pid+执行标识定位,
	 * 只动运行中条目;打点失败静默(信号源旁路,不许影响输出收集主路)。
	 */
	markOutput(pid: number, runId?: string): void {
		const bucket = this.#byPid.get(pid);
		if (!bucket) return;
		const at = utcNow();
		for (const entry of bucket) {
			if (entry.running && (runId === undefined || entry.run_id === runId)) entry.最近输出时间 = at;
		}
	}

	/**
	 * 更新本进程条目的监督进度；空文本清空旧值，避免把已完成步骤继续当成当前进度。
	 * 结算发生在 close 之后，因此这里只能按 pid+run_id 定对象，不能再用 running 拒绝终态写入。
	 */
	markProgress(pid: number, runId: string | undefined, progress: string | undefined): void {
		const bucket = this.#byPid.get(pid);
		if (!bucket) return;
		const value = progress?.trim().slice(0, 600);
		for (const entry of bucket) {
			if (runId !== undefined && entry.run_id !== runId) continue;
			if (value) entry.supervision_progress = value;
			else delete entry.supervision_progress;
		}
		this.#changed();
	}

	/** 登记本次执行可读取的证据入口；正式派发只传可验证的文件路径。 */
	markEvidence(pid: number, runId: string | undefined, evidence: readonly string[]): void {
		const bucket = this.#byPid.get(pid);
		if (!bucket) return;
		const values = [...new Set(evidence.map((value) => value.trim()).filter(Boolean))];
		for (const entry of bucket) {
			if (runId !== undefined && entry.run_id !== runId) continue;
			if (values.length > 0) entry.supervision_evidence = values;
			else delete entry.supervision_evidence;
		}
		this.#changed();
	}

	/** 宿主运行态变化时供外部监听。监听者不得改变 registry 真相;回调异常只影响该监听者。 */
	#listeners = new Set<() => void>();
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#changed(): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				/* 订阅是宿主旁路,异常不能污染进程登记/回执主链 */
			}
		}
	}

	/** 快照(副本),供调用方盘点审计 */
	list(): ProcessEntry[] {
		return this.#entries.map((entry) => ({ ...entry }));
	}

	clear(): void {
		this.#entries = [];
		this.#byPid.clear();
		this.#changed();
	}
}
