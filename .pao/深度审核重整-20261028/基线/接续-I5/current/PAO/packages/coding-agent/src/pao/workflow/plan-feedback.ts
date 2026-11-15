/**
 * 临时计划的步骤/文件意见关联（总计划第 4.5 节、阶段 4 第 4 项）。
 *
 * 意见是用户对「哪一版计划的哪一步、或哪一次轮次的哪个文件」说的话，所以：
 * - 记录时绑定当时的定义版本与阅读到的版本；之后计划被改、或出现了新稿，都不改绑，
 *   只提示「有新版本」（§4.5：文件意见绑定提交时正在阅读的版本，不悄悄改绑新稿）。
 * - 状态只说五件事：已记录、待送达、已送达、投递失败、已应用。
 *   「已送达」只能由真实投递回执写入（发出去就算成功是审查第 7 项的原缺陷）；
 *   「已应用」必须有业务处理依据，不靠前端勾选生效。
 * - 记录落 <计划目录>/意见.md；读改写全在同一文件锁内；历史轮次各记各条，不因路径相同互相覆盖。
 * - 同一投递请求 ID 重试是回放，参数变了复用同 ID 被拒（§4.4 第①条）。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { nowString } from "../shared/time.ts";
import {
	assertPlanOwnership,
	planDir,
	planLockPath,
	readTemporaryPlan,
	type TemporaryPlanDefinition,
	TemporaryPlanError,
	throwIfPlanAborted,
} from "./plan.ts";

/** 意见文件：一份计划一个（同一锁内读改写）。 */
export const PLAN_FEEDBACK_FILE_NAME = "意见.md";

export type PlanFeedbackStatus = "已记录" | "待送达" | "已送达" | "投递失败" | "已应用";

/** 讨论对象：整个流程、某一步，或某一步某一轮次的某个文件。
 * 流程级（整体）意见是对计划目标的评价，没有「哪一步」可言，
 * 因此用独立分支表达——绝不写成空 `步骤ID`（空 ID 在盘上会让意见变成找不到对象的孤儿）。 */
export type PlanFeedbackTarget =
	| { 类型: "流程" }
	| { 类型: "步骤"; 步骤ID: string }
	| {
			类型: "文件";
			步骤ID: string;
			/** 执行轮次（历史轮次各记各条） */
			轮次: number;
			/** 已确认的成果路径（宿主核实过的相对/绝对路径原文） */
			路径: string;
			/** 用户阅读到的是哪一版（版本识别依据，如轮次＋文件时间戳/差异摘要） */
			版本依据: string;
	  };

export interface PlanFeedbackDelivery {
	送达: boolean;
	结果: string;
	投递请求ID?: string;
	部长?: string;
	实例?: string;
	时刻: string;
}

export interface PlanFeedbackApplication {
	依据: string;
	时刻: string;
}

export interface PlanFeedbackEntry {
	意见ID: string;
	计划ID: string;
	/** 提交时正在看的定义版本 */
	定义版本: number;
	目标: PlanFeedbackTarget;
	正文: string;
	状态: PlanFeedbackStatus;
	记录时刻: string;
	更新时刻: string;
	/** 投递请求 ID：给了它才算「待送达」，回执按同一 ID 结算 */
	投递请求ID?: string;
	投递?: PlanFeedbackDelivery;
	应用?: PlanFeedbackApplication;
}

export function planFeedbackPath(项目根: string, 计划ID: string): string {
	return join(planDir(项目根, 计划ID), PLAN_FEEDBACK_FILE_NAME);
}

export function newFeedbackId(now = new Date()): string {
	const 日期 = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
	return `f-${日期}-${randomUUID().replaceAll("-", "").slice(0, 6)}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseFeedbackFile(content: string, filePath: string): PlanFeedbackEntry[] {
	let raw: Record<string, unknown>;
	try {
		raw = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
	} catch (error) {
		throw new TemporaryPlanError("PLAN_CORRUPT", `意见记录不是合法 YAML：${filePath}（${errorText(error)}）`);
	}
	const 记录 = raw.记录;
	if (记录 === undefined || 记录 === null) return [];
	if (!Array.isArray(记录)) {
		throw new TemporaryPlanError("PLAN_CORRUPT", `意见记录「记录」应为列表：${filePath}`);
	}
	for (const [index, entry] of 记录.entries()) {
		if (typeof entry !== "object" || entry === null) {
			throw new TemporaryPlanError("PLAN_CORRUPT", `意见记录第 ${index + 1} 条不是对象：${filePath}`);
		}
		const row = entry as Record<string, unknown>;
		const 意见ID = row.意见ID;
		const 正文 = row.正文;
		const 状态 = row.状态;
		if (typeof 意见ID !== "string" || !意见ID) {
			throw new TemporaryPlanError("PLAN_CORRUPT", `意见记录第 ${index + 1} 条缺「意见ID」：${filePath}`);
		}
		if (typeof 正文 !== "string" || !正文.trim()) {
			throw new TemporaryPlanError("PLAN_CORRUPT", `意见记录第 ${index + 1} 条缺「正文」：${filePath}`);
		}
		if (typeof 状态 !== "string" || 状态.length === 0) {
			throw new TemporaryPlanError("PLAN_CORRUPT", `意见记录第 ${index + 1} 条缺「状态」：${filePath}`);
		}
	}
	return 记录 as PlanFeedbackEntry[];
}

function serializeFeedback(entries: readonly PlanFeedbackEntry[]): string {
	return `---\n${stringify({ 记录: [...entries] })}---\n\n临时计划的步骤/文件意见关联：绑定提交时的定义版本与阅读版本；状态只由真实投递回执与业务依据推进。\n`;
}

function readFeedbackRows(项目根: string, 计划ID: string): PlanFeedbackEntry[] {
	const path = planFeedbackPath(项目根, 计划ID);
	if (!existsSync(path)) return [];
	return parseFeedbackFile(readFileSync(path, "utf8"), path);
}

function loadPlan(项目根: string, 计划ID: string): TemporaryPlanDefinition {
	return readTemporaryPlan(项目根, 计划ID);
}

function assertTarget(definition: TemporaryPlanDefinition, target: PlanFeedbackTarget): void {
	// 流程级意见的对象是「这份计划的目标」，不是某一步：不核步骤，也不允许空 ID 冒充。
	if (target.类型 === "流程") return;
	const 步骤 = definition.步骤.find((step) => step.步骤ID === target.步骤ID);
	if (!步骤) {
		throw new TemporaryPlanError("PLAN_INVALID", `意见指向的步骤不在计划里：${target.步骤ID}`, {
			计划ID: definition.计划ID,
		});
	}
	if (target.类型 === "步骤") return;
	if (!target.路径.trim()) {
		throw new TemporaryPlanError("PLAN_INVALID", "文件意见必须给出已确认的成果路径");
	}
	if (!target.版本依据.trim()) {
		throw new TemporaryPlanError("PLAN_INVALID", "文件意见必须记下用户读的是哪一版（版本识别依据）");
	}
	if (!Number.isInteger(target.轮次) || target.轮次 < 1) {
		throw new TemporaryPlanError("PLAN_INVALID", `文件意见的轮次须为正整数：${target.轮次}`);
	}
}

export interface PlanFeedbackRecordInput {
	项目根: string;
	计划ID: string;
	/** 提交时正在看的定义版本；给了就核，漂移即拒（旧意见不能绑到新版本上） */
	期望定义版本?: number;
	目标: PlanFeedbackTarget;
	正文: string;
	/** 投递请求 ID：同一逻辑投递重试沿用原 ID */
	投递请求ID?: string;
	/** 来源主控会话：有归属的计划只认原主控（与改/撤/启同一口径） */
	来源会话?: string;
	/** 取消信号：受理前被取消就抛 PLAN_ABORTED（不落意见记录） */
	信号?: AbortSignal;
	当刻?: string;
}

export interface PlanFeedbackRecordResult {
	entry: PlanFeedbackEntry;
	/** 同请求 ID 重放（盘上原有记录），没有新落一条 */
	回放?: boolean;
}

export async function recordPlanFeedback(input: PlanFeedbackRecordInput): Promise<PlanFeedbackRecordResult> {
	throwIfPlanAborted(input.信号, "记意见");
	if (!input.正文?.trim()) {
		throw new TemporaryPlanError("PLAN_INVALID", "意见正文不能为空");
	}
	const path = planFeedbackPath(input.项目根, input.计划ID);
	mkdirSync(planDir(input.项目根, input.计划ID), { recursive: true });
	return withFileLock(planLockPath(input.项目根, input.计划ID), async () => {
		throwIfPlanAborted(input.信号, "记意见");
		const definition = loadPlan(input.项目根, input.计划ID);
		assertPlanOwnership(definition, input.来源会话, "给这份计划提意见");
		return withFileLock(path, async () => {
			throwIfPlanAborted(input.信号, "记意见");
			const entries = readFeedbackRows(input.项目根, input.计划ID);
			const body = input.正文.trim();
			if (input.投递请求ID) {
				const existing = entries.find((entry) => entry.投递请求ID === input.投递请求ID);
				if (existing) {
					const same =
						existing.计划ID === input.计划ID &&
						(input.期望定义版本 === undefined || existing.定义版本 === input.期望定义版本) &&
						JSON.stringify(existing.目标) === JSON.stringify(input.目标) &&
						existing.正文 === body;
					if (!same) {
						throw new TemporaryPlanError(
							"PLAN_REQUEST_CONFLICT",
							`投递请求 ID ${input.投递请求ID} 已用于另一条意见，参数不一致不重用`,
							{ 投递请求ID: input.投递请求ID, 已有意见ID: existing.意见ID },
						);
					}
					return { entry: existing, 回放: true };
				}
			}
			assertTarget(definition, input.目标);
			if (input.期望定义版本 !== undefined && input.期望定义版本 !== definition.定义版本) {
				throw new TemporaryPlanError(
					"PLAN_VERSION_CONFLICT",
					`意见要绑定提交时看到的那一版计划：提交版本 ${input.期望定义版本}，当前版本 ${definition.定义版本}`,
					{ 期望定义版本: input.期望定义版本, 当前定义版本: definition.定义版本 },
				);
			}
			const 时刻 = input.当刻 ?? nowString();
			const entry: PlanFeedbackEntry = {
				意见ID: newFeedbackId(),
				计划ID: definition.计划ID,
				定义版本: definition.定义版本,
				目标: input.目标,
				正文: body,
				状态: input.投递请求ID ? "待送达" : "已记录",
				记录时刻: 时刻,
				更新时刻: 时刻,
				...(input.投递请求ID ? { 投递请求ID: input.投递请求ID } : {}),
			};
			writeFileAtomic(path, serializeFeedback([...entries, entry]));
			return { entry };
		});
	});
}

export interface PlanFeedbackDeliveryInput {
	项目根: string;
	计划ID: string;
	意见ID: string;
	/** true＝送达，false＝投递失败（失败也要给真实原因） */
	送达: boolean;
	/** 真实投递结果：送达回执原文或失败原因（空白不算） */
	结果: string;
	/** 投递请求 ID：必须与登记时的那一个一致，错 ID 不结算这条意见 */
	投递请求ID?: string;
	部长?: string;
	/** 投递所属实例：给了就核，跨实例的回执不结算这条意见 */
	实例?: string;
	/** 来源主控会话：与改/撤/启同一口径 */
	来源会话?: string;
	/** 取消信号：受理前被取消就抛 PLAN_ABORTED（不落回执） */
	信号?: AbortSignal;
	当刻?: string;
}

export async function recordPlanFeedbackDelivery(input: PlanFeedbackDeliveryInput): Promise<PlanFeedbackEntry> {
	throwIfPlanAborted(input.信号, "记意见投递回执");
	if (!input.结果?.trim()) {
		throw new TemporaryPlanError("PLAN_INVALID", "投递回执必须给出真实结果（送达回执或失败原因）");
	}
	const path = planFeedbackPath(input.项目根, input.计划ID);
	mkdirSync(planDir(input.项目根, input.计划ID), { recursive: true });
	return withFileLock(planLockPath(input.项目根, input.计划ID), async () => {
		throwIfPlanAborted(input.信号, "记意见投递回执");
		const definition = loadPlan(input.项目根, input.计划ID);
		assertPlanOwnership(definition, input.来源会话, "写这份计划的意见回执");
		return withFileLock(path, async () => {
			throwIfPlanAborted(input.信号, "记意见投递回执");
			const entries = readFeedbackRows(input.项目根, input.计划ID);
			const index = entries.findIndex((entry) => entry.意见ID === input.意见ID);
			if (index < 0) {
				throw new TemporaryPlanError("PLAN_NOT_FOUND", `意见不存在：${input.意见ID}`, { 意见ID: input.意见ID });
			}
			const current = entries[index]!;
			// 结算必须对上号：登记时给了投递请求 ID 的意见，回执不给 ID 或给错 ID 都不能结算——
			// 否则一条迟到/张冠李戴的回执会悄悄改掉另一条意见的状态（§6.4 第 7 条）。
			if (current.投递请求ID && input.投递请求ID !== current.投递请求ID) {
				throw new TemporaryPlanError(
					"PLAN_REQUEST_CONFLICT",
					input.投递请求ID
						? `投递回执的请求 ID 与登记的不一致：登记 ${current.投递请求ID}，回执 ${input.投递请求ID}`
						: `这条意见登记过投递请求 ${current.投递请求ID}，回执必须带上同一个请求 ID 才能结算；不带的回执一律不结算`,
					{ 登记投递请求ID: current.投递请求ID, 回执投递请求ID: input.投递请求ID ?? "" },
				);
			}
			// 跨实例回执不结算：两边都给了实例且对不上，说明回执来自另一份执行，不能改这条意见。
			const 当前实例 = current.投递?.实例;
			if (当前实例 && input.实例 && 当前实例 !== input.实例) {
				throw new TemporaryPlanError(
					"PLAN_REQUEST_CONFLICT",
					`投递回执的实例与登记的不一致：登记 ${当前实例}，回执 ${input.实例}；跨实例的回执不能结算这条意见`,
					{ 登记实例: 当前实例, 回执实例: input.实例 },
				);
			}
			// 「已应用」是业务终态：迟到回执不能把它或最后一次有效投递改回去。
			if (current.状态 === "已应用") return current;
			const result = input.结果.trim();
			const sameDelivery =
				current.投递?.送达 === input.送达 &&
				current.投递?.结果 === result &&
				(current.投递?.投递请求ID ?? "") === (input.投递请求ID ?? "") &&
				(current.投递?.部长 ?? "") === (input.部长 ?? "") &&
				(current.投递?.实例 ?? "") === (input.实例 ?? "");
			if (current.状态 === "已送达") {
				if (input.送达 && sameDelivery) return current;
				throw new TemporaryPlanError(
					"PLAN_REQUEST_CONFLICT",
					`意见 ${input.意见ID} 已经送达，矛盾或参数不同的迟到回执不能改写既有投递结果`,
					{ 意见ID: input.意见ID, 已记录送达: true, 回执送达: input.送达 },
				);
			}
			if (current.状态 === "投递失败" && !input.送达 && sameDelivery) return current;
			const 时刻 = input.当刻 ?? nowString();
			const updated: PlanFeedbackEntry = {
				...current,
				状态: input.送达 ? "已送达" : "投递失败",
				更新时刻: 时刻,
				投递: {
					送达: input.送达,
					结果: result,
					...(input.投递请求ID ? { 投递请求ID: input.投递请求ID } : {}),
					...(input.部长 ? { 部长: input.部长 } : {}),
					...(input.实例 ? { 实例: input.实例 } : 当前实例 ? { 实例: 当前实例 } : {}),
					时刻,
				},
			};
			const next = [...entries];
			next[index] = updated;
			writeFileAtomic(path, serializeFeedback(next));
			return updated;
		});
	});
}

export interface PlanFeedbackApplyInput {
	项目根: string;
	计划ID: string;
	意见ID: string;
	/** 业务处理依据：哪张卡/哪次修订/哪次交付按这条意见改了（空白不算数） */
	依据: string;
	/** 来源主控会话：与改/撤/启同一口径 */
	来源会话?: string;
	/** 取消信号：受理前被取消就抛 PLAN_ABORTED（不落标记） */
	信号?: AbortSignal;
	当刻?: string;
}

export async function markPlanFeedbackApplied(input: PlanFeedbackApplyInput): Promise<PlanFeedbackEntry> {
	throwIfPlanAborted(input.信号, "标意见已应用");
	if (!input.依据?.trim()) {
		throw new TemporaryPlanError("PLAN_INVALID", "「已应用」必须有真实业务处理依据，不能只靠标记");
	}
	const path = planFeedbackPath(input.项目根, input.计划ID);
	mkdirSync(planDir(input.项目根, input.计划ID), { recursive: true });
	return withFileLock(planLockPath(input.项目根, input.计划ID), async () => {
		throwIfPlanAborted(input.信号, "标意见已应用");
		const definition = loadPlan(input.项目根, input.计划ID);
		assertPlanOwnership(definition, input.来源会话, "标这份计划的意见已应用");
		return withFileLock(path, async () => {
			throwIfPlanAborted(input.信号, "标意见已应用");
			const entries = readFeedbackRows(input.项目根, input.计划ID);
			const index = entries.findIndex((entry) => entry.意见ID === input.意见ID);
			if (index < 0) {
				throw new TemporaryPlanError("PLAN_NOT_FOUND", `意见不存在：${input.意见ID}`, { 意见ID: input.意见ID });
			}
			const current = entries[index]!;
			const 时刻 = input.当刻 ?? nowString();
			const updated: PlanFeedbackEntry = {
				...current,
				状态: "已应用",
				更新时刻: 时刻,
				应用: { 依据: input.依据.trim(), 时刻 },
			};
			const next = [...entries];
			next[index] = updated;
			writeFileAtomic(path, serializeFeedback(next));
			return updated;
		});
	});
}

export function listPlanFeedback(项目根: string, 计划ID: string): PlanFeedbackEntry[] {
	return readFeedbackRows(项目根, 计划ID);
}
