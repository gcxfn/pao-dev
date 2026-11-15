/**
 * 分层监督的宿主状态机。
 *
 * 这里只管“什么时候该让哪一级上级看一次”，不管进程、卡片、RPC 或权限：
 * - worker 默认每 15 分钟提醒直接负责部长；department 默认每 30 分钟提醒主控。
 * - 同一次到期的同一位上级合并成一条；已注入但未显式处理的检查不重复唤醒。
 * - markHandled 后才从处理时刻重新计时。agent_settled、模型结束或正文注入都不算处理。
 * - 停审、等待用户决定和终态对象不参与周期检查;只读分析仍可能走偏,照常受监督。
 *
 * 状态全在内存，随宿主会话停止而清空；卡与回执仍是业务真相。
 */

export type SupervisionKind = "worker" | "department";
export type SupervisionOutcome = "completed" | "failed" | "needs_ruling" | "canceled";

export interface SupervisionProgress {
	goal?: string;
	recentProgress?: string;
	changes?: readonly string[];
	verification?: readonly string[];
	blocker?: string;
	evidence?: readonly string[];
}

export interface SupervisionRoute {
	department: string;
	projectRoot: string;
	context?: string;
	sessionId?: string;
}

export interface SupervisionWorkInput extends SupervisionRoute {
	key: string;
	kind: SupervisionKind;
	/** 主控工作流 owner;部级到期按它合并成一次提醒。 */
	ownerSessionId?: string;
	progress?: SupervisionProgress;
	/** 部门已停审或待人工，明确不进入“仍有工作”集合。 */
	waitingForHuman?: boolean;
	/** 兼容活动快照的权限标记;权限只读不改变监督判断。 */
	readonly?: boolean;
}

interface SupervisionRecord extends SupervisionWorkInput {
	lastHandledAt: number;
	pendingNoticeKey?: string;
}

export interface SupervisionAckReceipt {
	type: "pao_supervision_ack";
	key: string;
	sessionId?: string;
}

export function isSupervisionAckReceipt(value: unknown): value is SupervisionAckReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const details = value as Record<string, unknown>;
	return (
		details.type === "pao_supervision_ack" &&
		typeof details.key === "string" &&
		details.key.trim().length > 0 &&
		(details.sessionId === undefined || typeof details.sessionId === "string")
	);
}

export interface SupervisionWake {
	key: string;
	kind: SupervisionKind;
	route: SupervisionRoute;
	target: "minister" | "main";
	intervalMinutes: number;
	noticeKey: string;
	text: string;
	works: readonly SupervisionWorkInput[];
	ownerSessionId?: string;
}

export interface SupervisionStateOptions {
	clock: () => number;
	workerMinutes: () => number;
	departmentMinutes: () => number;
}

const routeKey = (input: SupervisionRoute): string =>
	`${input.department}\u0000${input.projectRoot}\u0000${input.context ?? ""}\u0000${input.sessionId ?? ""}`;

const progressLine = (label: string, value: string | undefined): string | undefined =>
	value?.trim() ? `- ${label}:${value.trim()}` : undefined;

const listLines = (label: string, values: readonly string[] | undefined): string[] =>
	values?.some((value) => value.trim())
		? [
				`- ${label}:${values
					.filter((value) => value.trim())
					.map((value) => ` ${value.trim()}`)
					.join("；")}`,
			]
		: [];

export function renderSupervisionWork(work: SupervisionWorkInput): string {
	const p = work.progress ?? {};
	const metadata = [
		`部门 ${work.department}`,
		work.ownerSessionId ? `owner ${work.ownerSessionId}` : undefined,
		work.sessionId ? `会话 ${work.sessionId}` : undefined,
		work.projectRoot ? `项目 ${work.projectRoot}` : undefined,
	]
		.filter(Boolean)
		.join("｜");
	return [
		`【${work.kind === "worker" ? "工人" : "部门"}】${work.key}`,
		`- 归属:${metadata}`,
		progressLine("目标", p.goal) ?? "- 目标:(未提供)",
		progressLine("近期进展", p.recentProgress) ?? "- 近期进展:(未提供)",
		...listLines("改动", p.changes),
		...listLines("自测/核验", p.verification),
		progressLine("阻塞", p.blocker),
		...listLines("证据入口", p.evidence),
	].join("\n");
}

export class SupervisionState {
	#options: SupervisionStateOptions;
	#records = new Map<string, SupervisionRecord>();

	constructor(options: SupervisionStateOptions) {
		this.#options = options;
	}

	track(work: SupervisionWorkInput): void {
		const now = this.#options.clock();
		const existing = this.#records.get(work.key);
		if (existing) {
			const scheduleChanged =
				existing.kind !== work.kind ||
				existing.department !== work.department ||
				existing.projectRoot !== work.projectRoot ||
				existing.context !== work.context ||
				existing.sessionId !== work.sessionId;
			this.#records.set(work.key, {
				...existing,
				...work,
				lastHandledAt: scheduleChanged ? now : existing.lastHandledAt,
			});
			return;
		}
		this.#records.set(work.key, {
			...work,
			lastHandledAt: now,
		});
	}

	update(key: string, patch: Partial<Omit<SupervisionWorkInput, "key">>): boolean {
		const existing = this.#records.get(key);
		if (!existing) return false;
		this.#records.set(key, { ...existing, ...patch, key });
		return true;
	}

	finish(key: string): SupervisionWorkInput | undefined {
		const existing = this.#records.get(key);
		if (!existing) return undefined;
		this.#records.delete(key);
		return existing;
	}

	markHandled(key: string): boolean {
		const existing = this.#records.get(key);
		if (!existing) return false;
		existing.lastHandledAt = this.#options.clock();
		existing.pendingNoticeKey = undefined;
		return true;
	}

	/** 已注入但等候显式处理的 key;用于“未投递不算检查、注入也不重复唤醒”。 */
	noticeInjected(key: string, noticeKey: string): void {
		const existing = this.#records.get(key);
		if (existing) existing.pendingNoticeKey = noticeKey;
	}

	noticeRejected(key: string): void {
		const existing = this.#records.get(key);
		if (existing) existing.pendingNoticeKey = undefined;
	}

	due(): SupervisionWake[] {
		const now = this.#options.clock();
		const workerMinutes = Math.max(0, this.#options.workerMinutes());
		const departmentMinutes = Math.max(0, this.#options.departmentMinutes());
		const due = [...this.#records.values()].filter((record) => {
			if (record.waitingForHuman || record.pendingNoticeKey) return false;
			const interval = record.kind === "worker" ? workerMinutes : departmentMinutes;
			return interval > 0 && now - record.lastHandledAt >= interval * 60_000;
		});
		const groups = new Map<
			string,
			{
				route: SupervisionRoute;
				target: "minister" | "main";
				works: SupervisionRecord[];
				ownerSessionId?: string;
			}
		>();
		for (const record of due) {
			const target = record.kind === "worker" ? "minister" : "main";
			const mergeKey =
				record.kind === "department" ? `owner:${record.ownerSessionId ?? "unowned"}` : routeKey(record);
			const groupKey = `${target}\u0000${mergeKey}`;
			const group = groups.get(groupKey);
			if (group) group.works.push(record);
			else
				groups.set(groupKey, {
					route: {
						department: record.department,
						projectRoot: record.projectRoot,
						...(record.context !== undefined ? { context: record.context } : {}),
						...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
					},
					target,
					works: [record],
					...(record.ownerSessionId !== undefined ? { ownerSessionId: record.ownerSessionId } : {}),
				});
		}
		return [...groups.values()].map((group) => {
			const route = group.route;
			const kind = group.works[0]!.kind;
			const intervalMinutes = kind === "worker" ? workerMinutes : departmentMinutes;
			const noticeKey = `supervision:${routeKey(route)}:${kind}:${now}`;
			const wake: SupervisionWake = {
				key: group.works.map((work) => work.key).join("\n"),
				kind,
				// 部级按 owner 合并时,department 只作标题,不代表所有对象都在一个部门。
				route,
				target: group.target,
				intervalMinutes,
				noticeKey,
				works: group.works.map(({ lastHandledAt: _lastHandledAt, pendingNoticeKey: _pending, ...work }) => work),
				...(group.ownerSessionId !== undefined ? { ownerSessionId: group.ownerSessionId } : {}),
				text: [
					`[监督检查] ${kind === "worker" ? `工人检查间隔 ${intervalMinutes} 分钟` : `部门检查间隔 ${intervalMinutes} 分钟`}`,
					...group.works.map((work) => renderSupervisionWork(work)),
					"请判断偏航、重复劳动、范围扩张和阻塞;普通监督不暂停下级。",
					...group.works.map(
						(work) =>
							`逐个使用 pao_ack_supervision(key="${work.key}")确认已实际检查后再调用;未确认的提醒不会重复唤醒。`,
					),
				].join("\n\n"),
			};
			for (const work of group.works) work.pendingNoticeKey = noticeKey;
			return wake;
		});
	}

	/**
	 * 重新计时仍等待处理的监督项。若对象已空闲、等待人工或终态,状态机保留记录但本轮不发。
	 */
	reschedule(wake: SupervisionWake): void {
		for (const key of wake.key.split("\n")) {
			const existing = this.#records.get(key);
			if (existing) existing.pendingNoticeKey = undefined;
		}
	}

	/** 直接上级提交确认时,只允许处理其绑定能看到的对象。 */
	markHandledForRoute(key: string, route: SupervisionRoute): boolean {
		const existing = this.#records.get(key);
		if (!existing) return false;
		if (
			existing.department !== route.department ||
			existing.projectRoot !== route.projectRoot ||
			(existing.context ?? "") !== (route.context ?? "") ||
			(route.sessionId !== undefined && existing.sessionId !== undefined && existing.sessionId !== route.sessionId)
		)
			return false;
		return this.markHandled(key);
	}

	/** 宿主只按部门/项目/脉络验证可见范围时,会议话 id 只作对象状态匹配,不要求确认前已知。 */
	markHandledForBinding(key: string, route: Omit<SupervisionRoute, "sessionId">): boolean {
		const existing = this.#records.get(key);
		if (!existing) return false;
		if (
			existing.department !== route.department ||
			existing.projectRoot !== route.projectRoot ||
			(existing.context ?? "") !== (route.context ?? "")
		)
			return false;
		return this.markHandled(key);
	}

	/** 当前活动对象的 key 快照;宿主据此移除已从活动源消失且不再可投递的对象。 */
	keys(): string[] {
		return [...this.#records.keys()];
	}

	/** 只保留指定 key;用于活动源取消或快照重建时清理 stale 记录。 */
	retainOnly(keys: ReadonlySet<string>): void {
		for (const key of [...this.#records.keys()]) {
			if (!keys.has(key)) this.#records.delete(key);
		}
	}

	waitingForHuman(key: string): boolean {
		const existing = this.#records.get(key);
		return existing?.waitingForHuman === true;
	}

	clear(): void {
		this.#records.clear();
	}

	size(): number {
		return this.#records.size;
	}
}
