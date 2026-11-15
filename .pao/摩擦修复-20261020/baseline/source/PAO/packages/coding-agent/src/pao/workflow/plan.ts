/**
 * 临时计划定义（通用工作台 · 阶段 3）。
 *
 * 定位：主控对话在「不填表单、不加按钮」的前提下创建的临时工作流**定义**——只存步骤要求、部门、
 * 依赖与人工门，不存节点/卡状态与费用（那属于执行实例，见 control.ts 的 v2 控制正本）。
 * 定义落盘 `<项目>/.pao/临时工作流/<计划ID>/计划.md`（跑起来之后的控制与卡在 执行/<启动请求ID>/ 下）。
 *
 * 三条不许越界的规则（计划 §4.2/§4.4）：
 *  1. 显示名可重名可含空格，**不参与拼磁盘路径**；内部配方名由稳定计划 ID 派生。
 *  2. 步骤有定义内稳定 ID（`s1`/`s2`…），显示顺序只供阅读；改标题不动 ID，所以改标题不会丢意见对象。
 *  3. 创建只落定义，不启动；启动只受理一次，重试按启动请求 ID 找回原实例，绝不静默再启第二份。
 *
 * 校验：结构/依赖/成环/未知部门/请求 ID 冲突在落盘前拒；配方合法性（有向无环、验收非空、回边规则）
 * 复用 `emitRecipeMarkdown` + `parseRecipe` 既有全量校验，不另写第二套。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { CardBudget, CardPriority, CardTier } from "../cards/types.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { nowString } from "../shared/time.ts";
import { emitRecipeMarkdown, saveRecipe } from "./distill.ts";
import { parseRecipe, type RecipeNode, type WorkflowRecipe } from "./recipe.ts";

/** 计划目录名（相对项目根的 .pao）。 */
export const TEMPORARY_PLAN_DIR_NAME = "临时工作流";

export type TemporaryPlanErrorCode =
	| "PLAN_NOT_FOUND" // 计划不存在
	| "PLAN_CORRUPT" // 定义文件读不出/结构坏（显式报错，不重建假状态）
	| "PLAN_INVALID" // 结构/依赖/部门不合法
	| "PLAN_VERSION_CONFLICT" // 预期定义版本与盘上不一致（有人在中间改过）
	| "PLAN_REQUEST_CONFLICT" // 同一逻辑请求 ID 带着不同参数又来一次
	| "PLAN_ALREADY_STARTED" // 已启动，定义冻结，不能再改/再撤
	| "PLAN_UNDONE" // 已撤销，不能再改/再启
	| "PLAN_START_PARTIAL" // 启动关联与控制正本对不上（不完整启动）
	| "PLAN_CONFIRM_REQUIRED" // 启动必须有宿主确认事实
	| "PLAN_FORBIDDEN" // 归属不符：项目根与宿主不一致，或不是该计划的来源主控
	| "PLAN_ABORTED"; // 受理前被取消：不落任何定义变更、启动关联与新执行请求

export class TemporaryPlanError extends Error {
	readonly code: TemporaryPlanErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: TemporaryPlanErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "TemporaryPlanError";
		this.code = code;
		this.details = details;
	}
}

export function isTemporaryPlanError(error: unknown): error is TemporaryPlanError {
	return error instanceof TemporaryPlanError;
}

/** 计划步骤：定义里只有「要做什么」，没有卡号、没有轮次、没有执行状态。 */
export interface TemporaryPlanStep {
	/** 定义内稳定 ID（`s1`…）；改标题不动它，所以意见/文件关联不会因改名而丢 */
	步骤ID: string;
	标题: string;
	部门: string;
	要求: string;
	/** 预期成果＝验收要求（也进卡面 验收 字段）；缺省退回用「要求」 */
	预期成果?: string;
	/** 上游成果或资料：进卡面 输入 字段；丢了这个字段，恢复出来的要求就少了「拿什么干」 */
	输入?: string[];
	/** 依赖的步骤 ID（同一计划内） */
	依赖?: string[];
	/** 人工门：交付后停流等用户点头 */
	人工门?: boolean;
	只读?: boolean;
	审核?: boolean;
	部门标准?: string;
	约束?: string;
	档位?: CardTier;
	预算?: CardBudget;
	优先级?: CardPriority;
	技能?: string[];
	回边?: NonNullable<RecipeNode["回边"]>;
}

/** 已落盘请求的回放记录：同逻辑请求重试沿用原结果，不改盘。 */
interface PlanRequestRecord {
	版本: number;
	参数指纹: string;
	结果: string;
}

export interface TemporaryPlanDefinition {
	计划ID: string;
	显示名: string;
	定义版本: number;
	项目根: string;
	来源会话?: string;
	创建时刻: string;
	更新时刻: string;
	已撤销?: boolean;
	步骤: TemporaryPlanStep[];
	请求记录: Record<string, PlanRequestRecord>;
}

// ── 路径 ──────────────────────────────────────────────────────────────────

export function planRoot(项目根: string): string {
	return join(resolve(项目根), ".pao", TEMPORARY_PLAN_DIR_NAME);
}

export function planDir(项目根: string, 计划ID: string): string {
	return join(planRoot(项目根), 计划ID);
}

export function planFilePath(项目根: string, 计划ID: string): string {
	return join(planDir(项目根, 计划ID), "计划.md");
}

/** 执行目录按启动请求 ID 派生：同一请求重试落在同一目录，才不会起第二份实例。 */
export function planExecDir(项目根: string, 计划ID: string, 启动请求ID: string): string {
	return join(planDir(项目根, 计划ID), "执行", 启动请求ID);
}

export function planStartRecordPath(项目根: string, 计划ID: string, 启动请求ID: string): string {
	return join(planDir(项目根, 计划ID), "启动", `${启动请求ID}.md`);
}

/** 未启动定义的最小版本历史落点：`<计划目录>/历史/版本-<N>.md`（N 是被替换掉的那一版）。 */
export const PLAN_HISTORY_DIR_NAME = "历史";

export function planHistoryDir(项目根: string, 计划ID: string): string {
	return join(planDir(项目根, 计划ID), PLAN_HISTORY_DIR_NAME);
}

export function planHistoryPath(项目根: string, 计划ID: string, 定义版本: number): string {
	return join(planHistoryDir(项目根, 计划ID), `版本-${定义版本}.md`);
}

/** 内部配方名由稳定计划 ID 派生（显示名不拼路径、可重名）。 */
export function planRecipeName(计划ID: string): string {
	return `临时-${计划ID}`;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 计划 ID：`p-<YYYYMMDD>-<6位十六进制>`，稳定、路径安全、可读。 */
export function newPlanId(now = new Date()): string {
	const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
	return `p-${stamp}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

function assertSafeId(value: string, label: string): void {
	if (!ID_PATTERN.test(value)) {
		throw new TemporaryPlanError(
			"PLAN_INVALID",
			`${label}不合法（只允许字母数字_-，≤64 字符）：${JSON.stringify(value)}`,
		);
	}
}

/**
 * 字符串数组字段的清洗：逐条 trim、去空、去重。
 * 缺字段（undefined）不算错，返回空数组；给了但不是字符串数组就显式报错——
 * 不静默丢掉用户写的东西（丢了以后恢复出来的要求就少了「拿什么干」）。
 */
function 清洗字符串数组(value: unknown, label: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new TemporaryPlanError("PLAN_INVALID", `${label}须是字符串数组`);
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new TemporaryPlanError("PLAN_INVALID", `${label}里出现了非字符串项：${JSON.stringify(item)}`);
		}
		const trimmed = item.trim();
		if (trimmed && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

// ── 读写 ──────────────────────────────────────────────────────────────────

function serializePlan(definition: TemporaryPlanDefinition): string {
	const { 计划ID, 显示名, 定义版本, 项目根, 来源会话, 创建时刻, 更新时刻, 已撤销, 步骤, 请求记录 } = definition;
	const frontmatter: Record<string, unknown> = {
		计划ID,
		显示名,
		定义版本,
		项目根,
		...(来源会话 ? { 来源会话 } : {}),
		创建时刻,
		更新时刻,
		...(已撤销 ? { 已撤销: true } : {}),
		步骤,
		请求记录,
	};
	return `---\n${stringify(frontmatter)}---\n\n主控创建的临时工作流定义：只记步骤要求、部门与依赖；卡号、轮次与执行状态在执行实例里。\n`;
}

function parsePlanFile(content: string, filePath: string): TemporaryPlanDefinition {
	let raw: Record<string, unknown>;
	try {
		raw = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
	} catch (error) {
		throw new TemporaryPlanError("PLAN_CORRUPT", `计划定义不是合法 YAML：${filePath}（${errorText(error)}）`);
	}
	const 计划ID = raw.计划ID;
	const 显示名 = raw.显示名;
	const 定义版本 = raw.定义版本;
	const 步骤 = raw.步骤;
	if (typeof 计划ID !== "string" || !计划ID)
		throw new TemporaryPlanError("PLAN_CORRUPT", `计划定义缺「计划ID」：${filePath}`);
	if (typeof 显示名 !== "string" || !显示名.trim())
		throw new TemporaryPlanError("PLAN_CORRUPT", `计划定义缺「显示名」：${filePath}`);
	if (typeof 定义版本 !== "number" || !Number.isInteger(定义版本) || 定义版本 < 1) {
		throw new TemporaryPlanError("PLAN_CORRUPT", `计划定义「定义版本」须为正整数：${filePath}`);
	}
	if (!Array.isArray(步骤) || 步骤.length === 0)
		throw new TemporaryPlanError("PLAN_CORRUPT", `计划定义没有步骤：${filePath}`);
	const definition: TemporaryPlanDefinition = {
		计划ID,
		显示名,
		定义版本,
		项目根: typeof raw.项目根 === "string" ? raw.项目根 : "",
		来源会话: typeof raw.来源会话 === "string" ? raw.来源会话 : undefined,
		创建时刻: typeof raw.创建时刻 === "string" ? raw.创建时刻 : "",
		更新时刻: typeof raw.更新时刻 === "string" ? raw.更新时刻 : "",
		已撤销: raw.已撤销 === true ? true : undefined,
		步骤: 步骤 as TemporaryPlanStep[],
		请求记录: (raw.请求记录 ?? {}) as Record<string, PlanRequestRecord>,
	};
	return definition;
}

/** 读定义：路径属该项目、可读、版本可识别；损坏显式报错，不重建假状态。 */
export function readTemporaryPlan(项目根: string, 计划ID: string): TemporaryPlanDefinition {
	assertSafeId(计划ID, "计划 ID");
	const path = planFilePath(项目根, 计划ID);
	if (!existsSync(path)) {
		throw new TemporaryPlanError("PLAN_NOT_FOUND", `临时计划不存在：${path}`, { 计划ID });
	}
	return parsePlanFile(readFileSync(path, "utf8"), path);
}

export function listTemporaryPlans(项目根: string): TemporaryPlanDefinition[] {
	const root = planRoot(项目根);
	if (!existsSync(root)) return [];
	const plans: TemporaryPlanDefinition[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name, "计划.md");
		if (!existsSync(path)) continue;
		try {
			plans.push(parsePlanFile(readFileSync(path, "utf8"), path));
		} catch {
			// 坏定义由 query 逐条点名（listTemporaryPlans 只给可读的），不静默当没有
		}
	}
	return plans.sort((a, b) => a.创建时刻.localeCompare(b.创建时刻));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── 最小版本历史（批次 C） ────────────────────────────────────────────────

/**
 * 未启动定义的**最小版本历史**：每次改/撤之前，把「被替换掉的那一版」原样存档一份。
 *
 * 为什么不是 git：临时计划落在用户项目的 `.pao/` 里，用户项目未必是 git 仓，也不该由内核替他提交。
 * 存档走 `writeFileAtomic`，与当前版同一把计划锁，所以「存档成功但新版本没写成」的中间态是可恢复的：
 * 当前版仍是旧的完整内容，历史里也只是多了一份和它相同的副本，不产生假状态。
 */
function archivePlanVersion(项目根: string, 计划ID: string, definition: TemporaryPlanDefinition): string {
	const path = planHistoryPath(项目根, 计划ID, definition.定义版本);
	mkdirSync(planHistoryDir(项目根, 计划ID), { recursive: true });
	writeFileAtomic(path, serializePlan(definition));
	return path;
}

export interface PlanHistoryEntry {
	定义版本: number;
	路径: string;
	/** 能通过结构校验的历史版本；读不出的版本没有这一项，只在 `问题` 里点名 */
	定义?: TemporaryPlanDefinition;
	问题?: string;
}

/** 列历史版本（升序）。坏存档照实点名，不当没有，也不拿它去覆盖当前版。 */
export function listPlanHistory(项目根: string, 计划ID: string): PlanHistoryEntry[] {
	const dir = planHistoryDir(项目根, 计划ID);
	if (!existsSync(dir)) return [];
	const entries: PlanHistoryEntry[] = [];
	for (const name of readdirSync(dir)) {
		const match = /^版本-(\d+)\.md$/.exec(name);
		if (!match) continue;
		const path = join(dir, name);
		const 定义版本 = Number(match[1]);
		try {
			entries.push({ 定义版本, 路径: path, 定义: parsePlanFile(readFileSync(path, "utf8"), path) });
		} catch (error) {
			entries.push({ 定义版本, 路径: path, 问题: errorText(error) });
		}
	}
	return entries.sort((a, b) => a.定义版本 - b.定义版本);
}

export interface PlanRecoveryResult {
	定义: TemporaryPlanDefinition;
	/** 当前版本可读，用的是它；否则是从历史里找回的版本 */
	来源: "当前" | "历史";
	路径: string;
	问题: string[];
}

/**
 * 写入中断后的定位：当前版读得出就用当前版；读不出就退到**最近一个能通过校验**的历史版本。
 * 只认通过校验的版本，不用空步骤或默认值拼一份出来充数（拼出来的假定义会让后面所有判断都错）。
 */
export function resolveRecoverablePlan(项目根: string, 计划ID: string): PlanRecoveryResult {
	const 问题: string[] = [];
	const currentPath = planFilePath(项目根, 计划ID);
	try {
		return { 定义: readTemporaryPlan(项目根, 计划ID), 来源: "当前", 路径: currentPath, 问题 };
	} catch (error) {
		问题.push(`当前定义读不出：${errorText(error)}`);
	}
	const 历史 = listPlanHistory(项目根, 计划ID);
	for (const entry of 历史) {
		if (entry.问题) 问题.push(`历史版本 ${entry.定义版本} 读不出：${entry.问题}`);
	}
	const 可用 = 历史.filter((entry) => entry.定义).sort((a, b) => b.定义版本 - a.定义版本)[0];
	if (可用?.定义) {
		return { 定义: 可用.定义, 来源: "历史", 路径: 可用.路径, 问题 };
	}
	throw new TemporaryPlanError(
		"PLAN_CORRUPT",
		`当前定义与全部历史版本都读不出，没有可用的定义：${currentPath}${问题.length > 0 ? `（${问题.join("；")}）` : ""}`,
		{ 计划ID, 问题 },
	);
}

// ── 归属与取消 ────────────────────────────────────────────────────────────

/**
 * 项目归属：定义里记的 `项目根` 必须与本次操作的项目一致。
 * 定义从哪个项目目录读出来就只能改哪个项目；工具传参只能**确认**归属，不能改写归属。
 */
export function assertPlanProject(definition: TemporaryPlanDefinition, 项目根: string): void {
	const expected = resolve(项目根);
	const recorded = definition.项目根 ? resolve(definition.项目根) : "";
	if (recorded && recorded !== expected) {
		throw new TemporaryPlanError(
			"PLAN_FORBIDDEN",
			`临时计划「${definition.计划ID}」属于项目 ${recorded}，不是当前项目 ${expected}；不能跨项目操作（本批不做跨主控接管）`,
			{ 计划ID: definition.计划ID, 计划项目根: recorded, 当前项目根: expected },
		);
	}
}

/**
 * 主控归属：改/撤/启/存模板这类**写**操作必须来自创建这份计划的来源会话。
 * 没登记来源主控的计划（CLI 一次性会话常见）谁都改得动，不假装有归属；
 * 读操作（query、意见列表）不受限——同一个项目里看计划不算越权。
 */
export function assertPlanOwnership(
	definition: TemporaryPlanDefinition,
	来源会话: string | undefined,
	动作: string,
): void {
	const owner = definition.来源会话?.trim();
	if (!owner) return;
	const actor = 来源会话?.trim();
	if (actor !== owner) {
		throw new TemporaryPlanError(
			"PLAN_FORBIDDEN",
			`临时计划「${definition.计划ID}」的来源主控是 ${owner}，当前会话 ${actor || "（未提供）"} 不能${动作}：请回到原主控会话操作，或另建一份计划（本批不做跨主控接管）`,
			{ 计划ID: definition.计划ID, 来源主控: owner, 当前会话: actor ?? "" },
		);
	}
}

/**
 * 取消检查：受理前任何一步被取消都抛 PLAN_ABORTED。
 * 已取消的请求绝不落定义变更、启动关联或新执行请求——取消要能穿透到落盘之前。
 */
export function throwIfPlanAborted(信号: AbortSignal | undefined, 动作: string): void {
	if (!信号?.aborted) return;
	const reason =
		信号.reason instanceof Error ? 信号.reason.message : typeof 信号.reason === "string" ? 信号.reason : "";
	throw new TemporaryPlanError(
		"PLAN_ABORTED",
		`${动作}在受理前被取消：没有落定义变更、启动关联或新执行请求${reason ? `（取消原因：${reason}）` : ""}`,
		{ 取消原因: reason },
	);
}

// ── 校验 ──────────────────────────────────────────────────────────────────

function normalizeSteps(rawSteps: readonly TemporaryPlanStep[], 已注册部门: readonly string[]): TemporaryPlanStep[] {
	if (rawSteps.length === 0) throw new TemporaryPlanError("PLAN_INVALID", "临时计划至少要有一个步骤");
	const seen = new Set<string>();
	const steps: TemporaryPlanStep[] = [];
	for (const raw of rawSteps) {
		const 步骤ID = raw.步骤ID?.trim();
		const 标题 = raw.标题?.trim();
		const 部门 = raw.部门?.trim();
		const 要求 = raw.要求?.trim();
		if (!步骤ID) throw new TemporaryPlanError("PLAN_INVALID", "步骤缺「步骤ID」");
		assertSafeId(步骤ID, `步骤 ID「${标题 ?? 步骤ID}」`);
		if (seen.has(步骤ID)) throw new TemporaryPlanError("PLAN_INVALID", `步骤 ID 重复：${步骤ID}`);
		seen.add(步骤ID);
		if (!标题) throw new TemporaryPlanError("PLAN_INVALID", `步骤 ${步骤ID} 缺「标题」`);
		if (!部门) throw new TemporaryPlanError("PLAN_INVALID", `步骤「${标题}」缺「部门」`);
		if (!已注册部门.includes(部门)) {
			throw new TemporaryPlanError("PLAN_INVALID", `步骤「${标题}」的部门未注册：${部门}`, {
				部门,
				已注册部门: [...已注册部门],
			});
		}
		if (!要求) throw new TemporaryPlanError("PLAN_INVALID", `步骤「${标题}」缺「要求」`);
		if (raw.审核 === true && !raw.部门标准?.trim()) {
			throw new TemporaryPlanError("PLAN_INVALID", `步骤「${标题}」标了审核但缺「部门标准」`);
		}
		const 输入 = 清洗字符串数组(raw.输入, `步骤「${标题}」的「输入」`);
		steps.push({
			...raw,
			步骤ID,
			标题,
			部门,
			要求,
			预期成果: raw.预期成果?.trim() || undefined,
			输入: 输入.length > 0 ? 输入 : undefined,
			依赖: [...(raw.依赖 ?? [])],
			技能: raw.技能 ? [...raw.技能] : undefined,
		});
	}
	const ids = new Set(steps.map((step) => step.步骤ID));
	for (const step of steps) {
		for (const dep of step.依赖 ?? []) {
			if (!ids.has(dep)) {
				throw new TemporaryPlanError("PLAN_INVALID", `步骤「${step.标题}」依赖不存在的步骤：${dep}`, {
					步骤: step.步骤ID,
					依赖: dep,
				});
			}
			if (dep === step.步骤ID) {
				throw new TemporaryPlanError("PLAN_INVALID", `步骤「${step.标题}」依赖自身`);
			}
		}
	}
	assertNoCycle(steps);
	return steps;
}

/** 依赖成环在落盘前拒（配方校验也会拒，这里先给人和主控一个明白文案）。 */
function assertNoCycle(steps: readonly TemporaryPlanStep[]): void {
	const byId = new Map(steps.map((step) => [step.步骤ID, step]));
	const visiting = new Set<string>();
	const done = new Set<string>();
	const walk = (id: string, trail: string[]): void => {
		if (done.has(id)) return;
		if (visiting.has(id)) {
			throw new TemporaryPlanError("PLAN_INVALID", `步骤依赖成环：${[...trail, id].join(" → ")}`);
		}
		visiting.add(id);
		for (const dep of byId.get(id)?.依赖 ?? []) walk(dep, [...trail, id]);
		visiting.delete(id);
		done.add(id);
	};
	for (const step of steps) walk(step.步骤ID, []);
}

/**
 * 结构指纹：同逻辑请求重试要和原请求「参数一致」，否则拒绝复用请求 ID。
 * 显式按字段拼，不依赖对象键序，避免重建对象时顺序不同被误判成参数变了。
 */
function fingerprint(input: {
	显示名: string;
	来源会话?: string;
	步骤: readonly TemporaryPlanStep[];
	操作: string;
}): string {
	return JSON.stringify({
		操作: input.操作,
		显示名: input.显示名,
		来源会话: input.来源会话 ?? null,
		步骤: input.步骤.map((step) => ({
			步骤ID: step.步骤ID,
			标题: step.标题,
			部门: step.部门,
			要求: step.要求,
			预期成果: step.预期成果 ?? null,
			依赖: step.依赖 ?? [],
			人工门: step.人工门 ?? false,
			只读: step.只读 ?? false,
			审核: step.审核 ?? false,
			部门标准: step.部门标准 ?? null,
			约束: step.约束 ?? null,
			档位: step.档位 ?? null,
			预算: step.预算 ?? null,
			技能: step.技能 ?? [],
		})),
	});
}

function nextStepId(steps: readonly TemporaryPlanStep[]): string {
	let max = 0;
	for (const step of steps) {
		const match = /^s(\d+)$/.exec(step.步骤ID);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `s${max + 1}`;
}

// ── 业务动作：创建 / 修改 / 撤销 ────────────────────────────────────────────

export interface PlanCreateInput {
	项目根: string;
	显示名: string;
	来源会话?: string;
	/** 步骤只给内容，步骤 ID 由内核按顺序发（稳定、不改标题） */
	步骤: readonly (Omit<TemporaryPlanStep, "步骤ID"> & { 步骤ID?: string })[];
	/** 逻辑请求 ID：同一次创建的重试必须沿用同一个值 */
	请求ID: string;
	/** 已注册部门名（宿主解析；不在表里的部门拒建） */
	已注册部门: readonly string[];
	/** 时间戳注入，便于测试 */
	当刻?: string;
}

export interface PlanWriteResult {
	计划ID: string;
	定义版本: number;
	摘要: string;
	路径: string;
	/** true＝本次是重复请求回放，盘上没有新变化 */
	回放: boolean;
}

function renderSummary(definition: TemporaryPlanDefinition): string {
	const lines = [
		`临时计划 ${definition.计划ID}「${definition.显示名}」定义版本 ${definition.定义版本}${definition.已撤销 ? "（已撤销）" : ""}`,
		`步骤 ${definition.步骤.length} 个，依赖：${
			definition.步骤.filter((step) => (step.依赖 ?? []).length > 0).length
		} 个步骤有待完成前置`,
	];
	for (const step of definition.步骤) {
		const 人工门 = step.人工门 ? "｜人工门" : "";
		const deps = (step.依赖 ?? []).length > 0 ? `｜依赖 ${(step.依赖 ?? []).join("、")}` : "";
		lines.push(`- ${step.步骤ID} ${step.标题}（${step.部门}）${deps}${人工门}`);
	}
	return lines.join("\n");
}

/** 落盘并返回结果（调用方已在锁内）。 */
function writePlan(definition: TemporaryPlanDefinition, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomic(path, serializePlan(definition));
}

function recordReplay(
	definition: TemporaryPlanDefinition,
	请求ID: string,
	参数指纹: string,
): PlanWriteResult | undefined {
	const record = definition.请求记录[请求ID];
	if (!record) return undefined;
	if (record.参数指纹 !== 参数指纹) {
		throw new TemporaryPlanError(
			"PLAN_REQUEST_CONFLICT",
			`请求 ID「${请求ID}」已用于另一组参数；同一逻辑请求的重试必须参数一致，换了内容请换请求 ID`,
			{ 请求ID },
		);
	}
	return {
		计划ID: definition.计划ID,
		定义版本: definition.定义版本,
		摘要: record.结果,
		路径: planFilePath(definition.项目根, definition.计划ID),
		回放: true,
	};
}

export async function createTemporaryPlan(input: PlanCreateInput): Promise<PlanWriteResult> {
	assertSafeId(input.请求ID, "请求 ID");
	const 项目根 = resolve(input.项目根);
	if (!existsSync(项目根)) throw new TemporaryPlanError("PLAN_INVALID", `项目根不存在：${项目根}`);
	const 显示名 = input.显示名.trim();
	if (!显示名) throw new TemporaryPlanError("PLAN_INVALID", "临时计划缺「显示名」");
	// 创建时按顺序发稳定步骤 ID（`s1`…）；以后改标题不动它，意见/文件关联才不会因改名而丢。
	const 带ID: TemporaryPlanStep[] = [];
	for (const step of input.步骤) {
		带ID.push({ ...step, 步骤ID: step.步骤ID?.trim() || nextStepId(带ID) });
	}
	const 步骤 = normalizeSteps(带ID, input.已注册部门);
	const 参数指纹 = fingerprint({ 显示名, 来源会话: input.来源会话, 步骤, 操作: "创建" });
	const 当刻 = input.当刻 ?? nowString();
	// 创建幂等必须在项目级锁内做：两个并发请求各自生成计划 ID 的话会落两个定义。
	const 创建锁 = join(planRoot(项目根), "创建.lock");
	mkdirSync(planRoot(项目根), { recursive: true });
	return withFileLock(创建锁, () => {
		for (const existing of listTemporaryPlans(项目根)) {
			const replayed = recordReplay(existing, input.请求ID, 参数指纹);
			if (replayed) return replayed;
		}
		const 计划ID = newPlanId(new Date(当刻.replace(" ", "T")));
		const definition: TemporaryPlanDefinition = {
			计划ID,
			显示名,
			定义版本: 1,
			项目根,
			来源会话: input.来源会话,
			创建时刻: 当刻,
			更新时刻: 当刻,
			步骤,
			请求记录: {},
		};
		const 摘要 = renderSummary(definition);
		definition.请求记录[input.请求ID] = { 版本: 1, 参数指纹, 结果: 摘要 };
		const path = planFilePath(项目根, 计划ID);
		writePlan(definition, path);
		return { 计划ID, 定义版本: 1, 摘要, 路径: path, 回放: false };
	});
}

export interface PlanModifyInput {
	项目根: string;
	计划ID: string;
	请求ID: string;
	/** 预期定义版本：盘上不是它就说明中间有人改过，拒改（版本漂移） */
	预期定义版本: number;
	显示名?: string;
	/** 给全量步骤（整份替换）；只改标题就传改好标题的同一份 */
	步骤?: readonly TemporaryPlanStep[];
	已注册部门: readonly string[];
	/** 当前会话：写操作必须与定义的来源主控一致（没登记来源主控的计划不限） */
	来源会话?: string;
	/** 取消信号：受理前被取消就抛 PLAN_ABORTED，不落任何变更 */
	信号?: AbortSignal;
	当刻?: string;
}

export async function modifyTemporaryPlan(input: PlanModifyInput): Promise<PlanWriteResult> {
	assertSafeId(input.请求ID, "请求 ID");
	throwIfPlanAborted(input.信号, "修改临时计划");
	const 项目根 = resolve(input.项目根);
	const path = planFilePath(项目根, input.计划ID);
	const 锁 = join(planDir(项目根, input.计划ID), "计划.lock");
	mkdirSync(planDir(项目根, input.计划ID), { recursive: true });
	return withFileLock(锁, () => {
		// 锁内复核：取消与归属都要在真正读盘/写盘之前判，避免等锁期间状态变了还照改
		throwIfPlanAborted(input.信号, "修改临时计划");
		const current = readTemporaryPlan(项目根, input.计划ID);
		assertPlanProject(current, 项目根);
		assertPlanOwnership(current, input.来源会话, "改");
		const 显示名 = (input.显示名 ?? current.显示名).trim();
		const 步骤 = input.步骤 ? normalizeSteps(input.步骤, input.已注册部门) : current.步骤;
		const 参数指纹 = fingerprint({ 显示名, 来源会话: current.来源会话, 步骤, 操作: "修改" });
		const replayed = recordReplay(current, input.请求ID, 参数指纹);
		if (replayed) return replayed;
		assertNotStarted(项目根, input.计划ID);
		if (current.已撤销) throw new TemporaryPlanError("PLAN_UNDONE", `临时计划已撤销，不能再改：${input.计划ID}`);
		if (current.定义版本 !== input.预期定义版本) {
			throw new TemporaryPlanError(
				"PLAN_VERSION_CONFLICT",
				`定义版本漂移：盘上是 ${current.定义版本}，请求基于 ${input.预期定义版本}；请重读后再改`,
				{ 盘上版本: current.定义版本, 预期版本: input.预期定义版本 },
			);
		}
		const 当刻 = input.当刻 ?? nowString();
		const next: TemporaryPlanDefinition = {
			...current,
			显示名,
			定义版本: current.定义版本 + 1,
			更新时刻: 当刻,
			步骤,
		};
		const 摘要 = renderSummary(next);
		next.请求记录 = { ...current.请求记录, [input.请求ID]: { 版本: next.定义版本, 参数指纹, 结果: 摘要 } };
		// 先把「被替换掉的这一版」存档，再写新版本：存档失败就整个改动作失败，不留半截状态。
		archivePlanVersion(项目根, input.计划ID, current);
		// 写盘前最后一道取消检查：确认没被取消才落盘
		throwIfPlanAborted(input.信号, "修改临时计划");
		writePlan(next, path);
		return { 计划ID: next.计划ID, 定义版本: next.定义版本, 摘要, 路径: path, 回放: false };
	});
}

export interface PlanUndoInput {
	项目根: string;
	计划ID: string;
	请求ID: string;
	预期定义版本: number;
	/** 当前会话：写操作必须与定义的来源主控一致 */
	来源会话?: string;
	信号?: AbortSignal;
	当刻?: string;
}
export async function undoTemporaryPlan(input: PlanUndoInput): Promise<PlanWriteResult> {
	assertSafeId(input.请求ID, "请求 ID");
	throwIfPlanAborted(input.信号, "撤销临时计划");
	const 项目根 = resolve(input.项目根);
	const path = planFilePath(项目根, input.计划ID);
	const 锁 = join(planDir(项目根, input.计划ID), "计划.lock");
	mkdirSync(planDir(项目根, input.计划ID), { recursive: true });
	return withFileLock(锁, () => {
		throwIfPlanAborted(input.信号, "撤销临时计划");
		const current = readTemporaryPlan(项目根, input.计划ID);
		assertPlanProject(current, 项目根);
		assertPlanOwnership(current, input.来源会话, "撤销");
		const 参数指纹 = fingerprint({
			显示名: current.显示名,
			来源会话: current.来源会话,
			步骤: current.步骤,
			操作: "撤销",
		});
		const replayed = recordReplay(current, input.请求ID, 参数指纹);
		if (replayed) return replayed;
		assertNotStarted(项目根, input.计划ID);
		if (current.定义版本 !== input.预期定义版本) {
			throw new TemporaryPlanError(
				"PLAN_VERSION_CONFLICT",
				`定义版本漂移：盘上是 ${current.定义版本}，请求基于 ${input.预期定义版本}；请重读后再撤`,
				{ 盘上版本: current.定义版本, 预期版本: input.预期定义版本 },
			);
		}
		const 当刻 = input.当刻 ?? nowString();
		const next: TemporaryPlanDefinition = {
			...current,
			已撤销: true,
			定义版本: current.定义版本 + 1,
			更新时刻: 当刻,
		};
		const 摘要 = `${renderSummary(next)}\n（已撤销：定义保留作最小未执行版本，不会再被启动）`;
		next.请求记录 = { ...current.请求记录, [input.请求ID]: { 版本: next.定义版本, 参数指纹, 结果: 摘要 } };
		archivePlanVersion(项目根, input.计划ID, current);
		throwIfPlanAborted(input.信号, "撤销临时计划");
		writePlan(next, path);
		return { 计划ID: next.计划ID, 定义版本: next.定义版本, 摘要, 路径: path, 回放: false };
	});
}

export interface PlanRevertInput {
	项目根: string;
	计划ID: string;
	请求ID: string;
	/** 预期定义版本：盘上不是它就说明中间有人改过，拒撤（版本冲突不覆盖） */
	预期定义版本: number;
	/** 要回到的那个历史版本；缺省＝最近一个历史版本 */
	目标定义版本?: number;
	来源会话?: string;
	信号?: AbortSignal;
	当刻?: string;
}

export interface PlanRevertResult extends PlanWriteResult {
	/** 恢复到的是哪一版（历史里的版本号） */
	恢复自: number;
	/** 恢复动作产生的新定义版本 */
	恢复为: number;
}

/**
 * 「撤销最近一次修改」＝读旧版 → 核当前版 → **形成新修订**。
 *
 * 与「撤回整份计划」（undoTemporaryPlan）是两件事，不混同：这里只是让内容回到上一版，
 * 计划本身照旧可执行；撤回整份是把计划标为已撤销、不再启动。
 * 内容不是原地倒退，而是把旧版内容作为**新的一版**写下去（版本号继续往前走），
 * 这样「谁在什么时候撤到哪一版」在请求记录与历史里都留得下，不会出现版本号回头造成的歧义。
 */
export async function revertTemporaryPlan(input: PlanRevertInput): Promise<PlanRevertResult> {
	assertSafeId(input.请求ID, "请求 ID");
	throwIfPlanAborted(input.信号, "撤销最近一次修改");
	const 项目根 = resolve(input.项目根);
	const path = planFilePath(项目根, input.计划ID);
	const 锁 = join(planDir(项目根, input.计划ID), "计划.lock");
	mkdirSync(planDir(项目根, input.计划ID), { recursive: true });
	return withFileLock(锁, () => {
		throwIfPlanAborted(input.信号, "撤销最近一次修改");
		const current = readTemporaryPlan(项目根, input.计划ID);
		assertPlanProject(current, 项目根);
		assertPlanOwnership(current, input.来源会话, "撤销最近一次修改");
		const 参数指纹 = fingerprint({
			显示名: current.显示名,
			来源会话: current.来源会话,
			步骤: current.步骤,
			操作: `撤销最近修改@${input.目标定义版本 ?? "最近"}`,
		});
		const replayed = recordReplay(current, input.请求ID, 参数指纹);
		if (replayed) return { ...replayed, 恢复自: input.目标定义版本 ?? 0, 恢复为: replayed.定义版本 };
		assertNotStarted(项目根, input.计划ID);
		if (current.定义版本 !== input.预期定义版本) {
			throw new TemporaryPlanError(
				"PLAN_VERSION_CONFLICT",
				`定义版本漂移：盘上是 ${current.定义版本}，请求基于 ${input.预期定义版本}；请重读后再撤销这次修改`,
				{ 盘上版本: current.定义版本, 预期版本: input.预期定义版本 },
			);
		}
		const 历史 = listPlanHistory(项目根, input.计划ID);
		const 坏版本 = 历史.filter((entry) => entry.问题);
		const 可选 = 历史.filter((entry) => entry.定义);
		// 指定版本时必须真的存在且通过校验：读不出就报读不出，绝不拿别的版本顶替。
		const target =
			input.目标定义版本 === undefined
				? 可选.sort((a, b) => b.定义版本 - a.定义版本)[0]
				: 可选.find((entry) => entry.定义版本 === input.目标定义版本);
		if (!target?.定义) {
			const 坏命中 = 坏版本.find((entry) => entry.定义版本 === input.目标定义版本);
			if (坏命中) {
				throw new TemporaryPlanError(
					"PLAN_CORRUPT",
					`历史版本 ${坏命中.定义版本} 读不出，不能用它恢复（原件保留在 ${坏命中.路径}）：${坏命中.问题}`,
					{ 计划ID: input.计划ID, 目标定义版本: 坏命中.定义版本, 路径: 坏命中.路径 },
				);
			}
			throw new TemporaryPlanError(
				"PLAN_INVALID",
				`没有可恢复的历史版本${input.目标定义版本 === undefined ? "" : `（指定的版本 ${input.目标定义版本} 不在历史里）`}：这份计划还没有被改过，或历史存档已被清理`,
				{ 计划ID: input.计划ID, 历史版本: 历史.map((entry) => entry.定义版本) },
			);
		}
		const 旧版 = target.定义;
		const 当刻 = input.当刻 ?? nowString();
		const next: TemporaryPlanDefinition = {
			...current,
			显示名: 旧版.显示名,
			步骤: 旧版.步骤,
			定义版本: current.定义版本 + 1,
			更新时刻: 当刻,
		};
		const 摘要 = `${renderSummary(next)}\n（已撤销最近一次修改：内容回到定义版本 ${旧版.定义版本}，作为新的定义版本 ${next.定义版本} 落盘；整份计划仍有效，「撤回整份计划」是另一个动作）`;
		next.请求记录 = { ...current.请求记录, [input.请求ID]: { 版本: next.定义版本, 参数指纹, 结果: 摘要 } };
		// 撤销动作本身也存档当前版，否则连着撤销两次时第二次会找不到上一版。
		archivePlanVersion(项目根, input.计划ID, current);
		throwIfPlanAborted(input.信号, "撤销最近一次修改");
		writePlan(next, path);
		return { 计划ID: next.计划ID, 定义版本: next.定义版本, 摘要, 路径: path, 回放: false, 恢复自: 旧版.定义版本, 恢复为: next.定义版本 };
	});
}

/**
 * 已启动（存在任何启动**证据**）的计划定义冻结：改/撤/恢复都不许动。
 * 证据＝启动关联文件，或已受理中尚未落实例的启动意图，或已形成的控制正本——
 * 三者只要有一条，「这一版正在启动」就是既成事实，编辑必须被拒。
 */
function assertNotStarted(项目根: string, 计划ID: string): void {
	const evidence = listPlanStartEvidence(项目根, 计划ID);
	if (evidence.length === 0) return;
	const 描述 = evidence
		.map((item) => (item.实例 ? `实例 ${item.实例}` : `启动请求 ${item.启动请求ID}（已受理、尚未落实例）`))
		.join("、");
	throw new TemporaryPlanError(
		"PLAN_ALREADY_STARTED",
		`临时计划已启动（${描述}），定义已冻结；要改请另建一份计划`,
		{ 已启动: evidence.map((item) => item.实例 ?? item.启动请求ID) },
	);
}

// ── 启动关联 ──────────────────────────────────────────────────────────────

export interface PlanStartRecord {
	计划ID: string;
	定义版本: number;
	启动请求ID: string;
	实例: string;
	配方名: string;
	工作区: string;
	卡目录: string;
	控制清单: string;
	owner会话: string;
	受理时刻: string;
}

function serializeStartRecord(record: PlanStartRecord): string {
	return `---\n${stringify(record)}---\n\n本次启动的实例关联：同一启动请求 ID 重试按本文件找回原实例，不许再启第二份。\n`;
}

/** 写启动关联（控制正本已形成之后调用，所以关联缺失＝启动没走完，如实报待恢复）。 */
export function recordPlanStart(recordPath: string, record: PlanStartRecord): void {
	mkdirSync(join(recordPath, ".."), { recursive: true });
	writeFileAtomic(recordPath, serializeStartRecord(record));
}

export function readPlanStart(recordPath: string): PlanStartRecord | undefined {
	if (!existsSync(recordPath)) return undefined;
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(recordPath, "utf8"));
	if (typeof frontmatter.实例 !== "string" || !frontmatter.实例) return undefined;
	return frontmatter as unknown as PlanStartRecord;
}

/**
 * 启动意图：确认已过、实例还没起来的**窗口期**也要留痕。
 * 不先落这一笔的话，「控制正本已形成但关联还没写」之间编辑能钻进来改定义（批次 A 缺陷）。
 * 意图与关联共用同一路径，落实例后由 `recordPlanStart` 覆盖成完整关联。
 */
export interface PlanStartIntent {
	计划ID: string;
	定义版本: number;
	启动请求ID: string;
	状态: "受理中" | "已受理";
	owner会话: string;
	提交时刻: string;
}

function serializeStartIntent(intent: PlanStartIntent): string {
	return `---\n${stringify(intent)}---\n\n本次启动已受理、实例尚未落实的留痕：定义从这一刻起冻结，编辑一律被拒。\n`;
}

/** 写/覆盖启动意图（调用方在计划锁内调用；实例落实后用 recordPlanStart 覆盖成完整关联）。 */
export function recordPlanStartIntent(recordPath: string, intent: PlanStartIntent): void {
	mkdirSync(dirname(recordPath), { recursive: true });
	writeFileAtomic(recordPath, serializeStartIntent(intent));
}

export function readPlanStartIntent(recordPath: string): PlanStartIntent | undefined {
	if (!existsSync(recordPath)) return undefined;
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter<Record<string, unknown>>(readFileSync(recordPath, "utf8")).frontmatter;
	} catch {
		return undefined;
	}
	if (frontmatter.状态 !== "受理中" && frontmatter.状态 !== "已受理") return undefined;
	if (typeof frontmatter.启动请求ID !== "string" || !frontmatter.启动请求ID) return undefined;
	return frontmatter as unknown as PlanStartIntent;
}

function listPlanStarts(项目根: string, 计划ID: string): PlanStartRecord[] {
	const dir = join(planDir(项目根, 计划ID), "启动");
	if (!existsSync(dir)) return [];
	const records: PlanStartRecord[] = [];
	for (const name of readdirSync(dir)) {
		const record = readPlanStart(join(dir, name));
		if (record) records.push(record);
	}
	return records;
}

/** 一次启动的冻结证据：关联（已落实例）／意图（已受理待落实例）／控制正本（关联丢失也要算）。 */
interface PlanStartEvidence {
	启动请求ID: string;
	实例?: string;
}

/**
 * 冻结证据收集：改/撤之前用它判断「这一版是不是已经在启动路上」。
 * 三条来源都算证据——只要有一条成立，编辑就要被拒，不能因为「关联还没写完」就放行。
 */
function listPlanStartEvidence(项目根: string, 计划ID: string): PlanStartEvidence[] {
	const byRequest = new Map<string, PlanStartEvidence>();
	const 启动目录 = join(planDir(项目根, 计划ID), "启动");
	if (existsSync(启动目录)) {
		for (const name of readdirSync(启动目录)) {
			const path = join(启动目录, name);
			const record = readPlanStart(path);
			if (record) {
				byRequest.set(record.启动请求ID || name.replace(/\.md$/, ""), {
					启动请求ID: record.启动请求ID || name.replace(/\.md$/, ""),
					实例: record.实例,
				});
				continue;
			}
			const intent = readPlanStartIntent(path);
			if (intent) byRequest.set(intent.启动请求ID, { 启动请求ID: intent.启动请求ID });
		}
	}
	// 关联整份丢了、控制正本却已经在：仍是既成启动，照样冻结（不能靠删关联解冻）。
	const 执行目录 = join(planDir(项目根, 计划ID), "执行");
	if (existsSync(执行目录)) {
		for (const name of readdirSync(执行目录)) {
			const identity = readControlIdentity(join(执行目录, name, `工作流实例-${planRecipeName(计划ID)}.md`));
			if (!identity) continue;
			const existing = byRequest.get(name);
			byRequest.set(name, { 启动请求ID: name, 实例: existing?.实例 ?? identity.实例 });
		}
	}
	return [...byRequest.values()];
}

/** 只读控制正本的实例身份（不加载配方：找回原实例时配方可能已经不在模板库里）。 */
function readControlIdentity(控制清单: string): { 实例: string; owner: string } | undefined {
	if (!existsSync(控制清单)) return undefined;
	try {
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(控制清单, "utf8"));
		if (frontmatter.版本 !== 2 || typeof frontmatter.实例 !== "string" || !frontmatter.实例) return undefined;
		return { 实例: frontmatter.实例, owner: typeof frontmatter.owner === "string" ? frontmatter.owner : "" };
	} catch {
		return undefined;
	}
}

// ── 定义 → 配方 ──────────────────────────────────────────────────────────

/** 步骤 ID → 配方节点（节点名就是稳定 ID；显示标题进卡面「目标」）。 */
function stepToNode(step: TemporaryPlanStep): RecipeNode {
	const 目标 = [step.标题, step.要求, step.预期成果 ? `预期成果：${step.预期成果}` : ""].filter(Boolean).join("\n");
	const node: RecipeNode = {
		名字: step.步骤ID,
		目标,
		部门: step.部门,
		// 验收必填：预期成果优先，缺省退回要求（创建时已保证要求非空）
		验收: step.预期成果 ?? step.要求,
		depends_on: [...(step.依赖 ?? [])],
		人工确认: step.人工门 === true,
	};
	if (step.只读 !== undefined) node.只读 = step.只读;
	if (step.输入 && step.输入.length > 0) node.输入 = [...step.输入];
	if (step.审核 !== undefined) node.审核 = step.审核;
	if (step.部门标准) node.部门标准 = step.部门标准;
	if (step.约束) node.约束 = step.约束;
	if (step.档位) node.档位 = step.档位;
	if (step.预算) node.预算 = step.预算;
	if (step.优先级) node.优先级 = step.优先级;
	if (step.技能 && step.技能.length > 0) node.技能 = [...step.技能];
	if (step.回边 && step.回边.length > 0) node.回边 = step.回边;
	return node;
}

/**
 * 定义 → v2 配方：先发射成配方 markdown 再走 `parseRecipe` 全量校验（有向无环、验收非空、回边只在审核节点…），
 * 复用既有校验而不是在计划模块里再写一遍规则。
 */
export function planToRecipe(
	definition: TemporaryPlanDefinition,
	配方名 = planRecipeName(definition.计划ID),
): WorkflowRecipe {
	const content = emitRecipeMarkdown({
		版本: 2,
		名字: 配方名,
		自动执行: true,
		参数: [],
		节点: definition.步骤.map(stepToNode),
		说明: `主控创建的临时计划「${definition.显示名}」（${definition.计划ID}，定义版本 ${definition.定义版本}）；未保存为模板。`,
	});
	// 自检用合成文件名：parseRecipe 会核对「配方名字 == 文件名」，这里还没有真实落盘路径。
	return parseRecipe(content, `${配方名}.md`);
}

// ── 确认事实 ──────────────────────────────────────────────────────────────

/**
 * 宿主确认事实：只能来自宿主确认回调或可信用户交互事件，且必须绑定计划 ID、定义版本与启动请求 ID。
 * 模型自己传 `confirmed: true`、转述「用户已同意」或普通助手文本都构造不出这个对象。
 */
export interface PlanConfirmation {
	计划ID: string;
	定义版本: number;
	启动请求ID: string;
	来源: "宿主确认回调" | "用户交互事件";
	时刻: string;
}

export function assertPlanConfirmation(
	confirmation: unknown,
	expect: { 计划ID: string; 定义版本: number; 启动请求ID: string },
): PlanConfirmation {
	if (!confirmation || typeof confirmation !== "object") {
		throw new TemporaryPlanError(
			"PLAN_CONFIRM_REQUIRED",
			"启动临时计划需要宿主确认回调提供确认事实（用户点头）；模型自述的同意不算",
		);
	}
	const value = confirmation as Partial<PlanConfirmation>;
	if (value.来源 !== "宿主确认回调" && value.来源 !== "用户交互事件") {
		throw new TemporaryPlanError("PLAN_CONFIRM_REQUIRED", "确认事实来源不可信：只认宿主确认回调或可信用户交互事件");
	}
	if (value.计划ID !== expect.计划ID || value.定义版本 !== expect.定义版本 || value.启动请求ID !== expect.启动请求ID) {
		throw new TemporaryPlanError(
			"PLAN_CONFIRM_REQUIRED",
			"确认事实与本次请求不一致（计划/定义版本/启动请求三者必须一致）；用户确认的是当时展示的那一版",
			{ 确认: { 计划ID: value.计划ID, 定义版本: value.定义版本, 启动请求ID: value.启动请求ID }, 请求: expect },
		);
	}
	return value as PlanConfirmation;
}

// ── 启动 ──────────────────────────────────────────────────────────────────

export interface PlanExecution {
	配方: WorkflowRecipe;
	配方名: string;
	工作区: string;
	卡目录: string;
	关联路径: string;
	控制清单: string;
	定义版本: number;
	/** 已有实例（关联或控制正本里读到）：本次是找回，不是新受理 */
	找回?: PlanStartRecord;
}

export interface PlanExecutionInput {
	项目根: string;
	计划ID: string;
	启动请求ID: string;
	/** 本次启动锁定的定义版本：与盘上不一致即拒（确认后又被改，旧确认失效） */
	定义版本: number;
	/** 当前会话：启动必须来自定义的来源主控（没登记来源主控的计划不限） */
	来源会话?: string;
	/** 取消信号：确认等待期间被取消就抛 PLAN_ABORTED */
	信号?: AbortSignal;
}

export function resolvePlanExecution(input: PlanExecutionInput): PlanExecution {
	assertSafeId(input.启动请求ID, "启动请求 ID");
	throwIfPlanAborted(input.信号, "启动临时计划");
	const 项目根 = resolve(input.项目根);
	const definition = readTemporaryPlan(项目根, input.计划ID);
	assertPlanProject(definition, 项目根);
	assertPlanOwnership(definition, input.来源会话, "启动");
	if (definition.已撤销) throw new TemporaryPlanError("PLAN_UNDONE", `临时计划已撤销，不能启动：${input.计划ID}`);
	if (definition.定义版本 !== input.定义版本) {
		throw new TemporaryPlanError(
			"PLAN_VERSION_CONFLICT",
			`确认的是定义版本 ${input.定义版本}，盘上已是 ${definition.定义版本}（确认后计划被改，旧确认失效）；请重读后再确认`,
			{ 盘上版本: definition.定义版本, 确认版本: input.定义版本 },
		);
	}
	const 工作区 = planExecDir(项目根, input.计划ID, input.启动请求ID);
	const 卡目录 = join(工作区, "卡");
	const 配方名 = planRecipeName(input.计划ID);
	const 关联路径 = planStartRecordPath(项目根, input.计划ID, input.启动请求ID);
	const 控制清单 = join(工作区, `工作流实例-${配方名}.md`);
	const existing = readPlanStart(关联路径);
	if (existing) {
		if (existing.实例 !== readControlIdentity(控制清单)?.实例) {
			throw new TemporaryPlanError(
				"PLAN_START_PARTIAL",
				`启动关联指向实例 ${existing.实例}，但控制清单读不到同一实例：${控制清单}；属不完整启动，须人工确认后再处理，不会自动再启一份`,
				{ 关联: existing, 控制清单 },
			);
		}
		return {
			配方: planToRecipe(definition),
			配方名,
			工作区,
			卡目录,
			关联路径,
			控制清单,
			定义版本: definition.定义版本,
			找回: existing,
		};
	}
	// 关联缺失但控制正本已在：属「控制文件已形成但返回丢失」，只能找回、不许再启。
	const identity = readControlIdentity(控制清单);
	if (identity) {
		return {
			配方: planToRecipe(definition),
			配方名,
			工作区,
			卡目录,
			关联路径,
			控制清单,
			定义版本: definition.定义版本,
			找回: {
				计划ID: definition.计划ID,
				定义版本: definition.定义版本,
				启动请求ID: input.启动请求ID,
				实例: identity.实例,
				配方名,
				工作区,
				卡目录,
				控制清单,
				owner会话: identity.owner,
				受理时刻: "",
			},
		};
	}
	// 已有「受理中」意图但控制正本还没形成：属上一次受理走到一半（进程死在启动中途）。
	// 不能当没发生过再启一份——主控要人工核对后处理，这里如实报不完整启动。
	const intent = readPlanStartIntent(关联路径);
	if (intent && intent.定义版本 === input.定义版本) {
		throw new TemporaryPlanError(
			"PLAN_START_PARTIAL",
			`这次启动请求（${input.启动请求ID}）已在 ${intent.提交时刻} 受理过，但执行目录里读不到控制正本：${控制清单}；属不完整启动，请人工核对后处理（不会自动再启一份）`,
			{ 意图: intent, 控制清单 },
		);
	}
	return { 配方: planToRecipe(definition), 配方名, 工作区, 卡目录, 关联路径, 控制清单, 定义版本: definition.定义版本 };
}

/**
 * 受理留痕：写「这一版正在启动」的意图（调用方在计划锁内、真正启流之前调用）。
 * 先落这一笔，编辑与第二次启动才会被冻结；实例落实后由调用方覆盖成完整关联。
 */
export function recordStartIntent(
	关联路径: string,
	intent: Omit<PlanStartIntent, "状态" | "提交时刻"> & { 提交时刻?: string },
): PlanStartIntent {
	const full: PlanStartIntent = {
		计划ID: intent.计划ID,
		定义版本: intent.定义版本,
		启动请求ID: intent.启动请求ID,
		owner会话: intent.owner会话,
		状态: "受理中",
		提交时刻: intent.提交时刻 ?? nowString(),
	};
	recordPlanStartIntent(关联路径, full);
	return full;
}

/**
 * 受理后从盘上读真实实例身份：真相在控制正本里，不拿请求参数当结果。
 * 启动工具只有在读到它之后才能落启动关联，并回报真实实例号。
 */
export function readPlanInstanceIdentity(
	工作区: string,
	配方名: string,
): { 实例: string; owner: string; 控制清单: string } | undefined {
	const 控制清单 = join(工作区, `工作流实例-${配方名}.md`);
	const identity = readControlIdentity(控制清单);
	if (!identity) return undefined;
	return { 实例: identity.实例, owner: identity.owner, 控制清单 };
}

// ── 查询 ──────────────────────────────────────────────────────────────────
export interface PlanQueryResult {
	/** 指定计划 ID 时是这份定义；列全部时缺省（正文在「摘要」里逐条列） */
	定义?: TemporaryPlanDefinition;
	启动: PlanStartRecord[];
	/** 本次查询附带的说明行（坏定义、坏关联等） */
	问题: string[];
	摘要: string;
}

/** 查询/恢复查看：路径属项目、可读、版本可识别；损坏显式报错，不重建假状态。 */
export function queryTemporaryPlan(项目根: string, 计划ID?: string): PlanQueryResult {
	const root = planRoot(项目根);
	const 问题: string[] = [];
	if (计划ID) {
		const definition = readTemporaryPlan(项目根, 计划ID);
		return {
			定义: definition,
			启动: listPlanStarts(项目根, 计划ID),
			问题,
			摘要: renderSummary(definition),
		};
	}
	const plans = existsSync(root) ? listTemporaryPlans(项目根) : [];
	if (existsSync(root)) {
		for (const name of readdirSync(root)) {
			const path = join(root, name, "计划.md");
			if (!existsSync(path)) continue;
			try {
				parsePlanFile(readFileSync(path, "utf8"), path);
			} catch (error) {
				问题.push(`${path}：${errorText(error)}`);
			}
		}
	}
	const lines = [`临时计划 ${plans.length} 份（${root}）`];
	for (const plan of plans) {
		const 启动 = listPlanStarts(项目根, plan.计划ID);
		lines.push(
			`- ${plan.计划ID}「${plan.显示名}」定义版本 ${plan.定义版本}${plan.已撤销 ? "（已撤销）" : ""}｜${plan.步骤.length} 步｜${
				启动.length > 0 ? `已启动：${启动.map((start) => `实例 ${start.实例}`).join("、")}` : "未启动"
			}`,
		);
	}
	for (const problem of 问题) lines.push(`- 读不出：${problem}`);
	if (plans.length === 0 && 问题.length === 0) lines.push("（还没有临时计划）");
	return {
		启动: plans.flatMap((plan) => listPlanStarts(项目根, plan.计划ID)),
		问题,
		摘要: lines.join("\n"),
	};
}

// ── 保存为模板 ────────────────────────────────────────────────────────────

export interface PlanTemplateInput {
	项目根: string;
	计划ID: string;
	定义版本: number;
	模板名: string;
	paoHome: string;
	/** 允许把本次特有路径原样存进模板（默认拒：先给用户确认） */
	允许未泛化路径?: boolean;
	/**
	 * 要参数化的本次文本：`{参数名: 本次的字面量}`，落进模板时替换成 `{参数名}` 并在「参数」表声明。
	 * 不给替换表时，含本次特有路径的计划默认被拒（除非显式 `允许未泛化路径`）。
	 */
	参数?: Record<string, string>;
	/** 当前会话：存模板同样是这份计划的写操作，必须来自来源主控 */
	来源会话?: string;
	/** 取消信号：受理前被取消就抛 PLAN_ABORTED（不落模板文件） */
	信号?: AbortSignal;
	当刻?: string;
}

export interface PlanTemplateResult {
	路径: string;
	节点数: number;
	备份?: string;
	/** 检测到的本次特有路径（未泛化） */
	未泛化路径: string[];
}

/**
 * 本次特有的绝对路径：盘符开头（`C:\` / `C:/`）或根斜杠开头（`/x`）。
 *
 * 不能写成 `/(?:[A-Za-z]:[\\/]|\/)[^\s…]*​/`：那样 `创作成果/初稿.md` 这种**项目内相对路径**
 * 会被从中间的斜杠截出 `/初稿.md` 并误报成「本次特有路径」，把正常计划全挡在模板之外。
 * 所以要求匹配必须从一个路径的**开头**起算：盘符前不能紧挨着路径字符，根斜杠前不能紧挨着非空白。
 */
const PROJECT_PATH_PATTERN = /(?<![^\s"'（(【「,，。；;:：])(?:[A-Za-z]:[\\/]|\/)[^\s"'，。；、）】]*/g;

/** 参数名必须能当占位符用：非空、不含花括号与空白。 */
const PARAM_NAME_PATTERN = /^[^{}\s]+$/;

/** 会进模板的文本字段（白名单）：参数替换与路径扫描都只认这几处。 */
const TEMPLATE_TEXT_FIELDS = ["标题", "要求", "预期成果", "约束", "部门标准"] as const;

/**
 * 把本次特有的字面量（绝对路径等）换成 `{参数名}` 占位符。
 *
 * 为什么必须显式给替换表：内核**不猜**哪段文字是「本该参数化的东西」。猜错会把要求改坏，
 * 比不参数化更糟；所以只做用户点名的那几个替换，替换不到就报错而不是静默留一个用了不上的空参数。
 */
function parameterizeSteps(
	steps: readonly TemporaryPlanStep[],
	参数: Record<string, string>,
): { 步骤: TemporaryPlanStep[]; 未命中: string[] } {
	const 未命中: string[] = [];
	for (const [名字, 值] of Object.entries(参数)) {
		if (!PARAM_NAME_PATTERN.test(名字)) {
			throw new TemporaryPlanError("PLAN_INVALID", `参数名不合法（不许含花括号或空白）：${JSON.stringify(名字)}`);
		}
		if (!值 || !值.trim()) {
			throw new TemporaryPlanError("PLAN_INVALID", `参数「${名字}」没有给要替换掉的本次文本`);
		}
	}
	const 替换 = (text: string | undefined): string | undefined => {
		if (!text) return text;
		let out = text;
		for (const [名字, 值] of Object.entries(参数)) {
			if (!out.includes(值)) continue;
			out = out.split(值).join(`{${名字}}`);
		}
		return out;
	};
	const 步骤 = steps.map((step) => {
		const next: TemporaryPlanStep = { ...step };
		for (const field of TEMPLATE_TEXT_FIELDS) {
			const 原值 = next[field];
			if (typeof 原值 === "string") next[field] = 替换(原值) ?? 原值;
		}
		if (step.输入 && step.输入.length > 0) {
			next.输入 = step.输入.map((item) => 替换(item) ?? item);
		}
		return next;
	});
	// 每个声明的参数都必须真的替换到东西：否则它进了模板参数表却没有对应占位符，
	// 换项目填参时用户会以为改了某处，实际什么都没变。
	const 命中 = new Set<string>();
	const 扫 = (text: string | undefined): void => {
		if (!text) return;
		for (const 名字 of Object.keys(参数)) if (text.includes(`{${名字}}`)) 命中.add(名字);
	};
	for (const step of 步骤) {
		for (const field of TEMPLATE_TEXT_FIELDS) 扫(step[field]);
		for (const item of step.输入 ?? []) 扫(item);
	}
	for (const 名字 of Object.keys(参数)) if (!命中.has(名字)) 未命中.push(名字);
	return { 步骤, 未命中 };
}

/** 收集会进模板的字段里出现的绝对路径（本次特有的产出目录等），要用户确认才能原样保存。 */
export function findTemplatePaths(definition: TemporaryPlanDefinition): string[] {
	const found = new Set<string>();
	const scan = (text: string | undefined): void => {
		if (!text) return;
		for (const match of text.matchAll(PROJECT_PATH_PATTERN)) found.add(match[0]);
	};
	for (const step of definition.步骤) {
		for (const field of TEMPLATE_TEXT_FIELDS) scan(step[field]);
		for (const item of step.输入 ?? []) scan(item);
	}
	return [...found];
}

/**
 * 白名单提取：只带可复用的步骤/部门/依赖/约束/技能/预算/验收/人工门/审核定义——
 * 会话、卡号、实例状态与本次成果路径都不进模板（模板不是本次运行的副本）。
 *
 * 参数化：调用方给的替换表把本次特有文本换成 `{参数名}`，并在 frontmatter 的「参数」里声明，
 * 于是「换一个项目、填了参数就能再跑一份新计划」。占位符是否全部已声明由 `parseRecipe` 同一套校验兜底。
 */
export function buildPlanTemplateContent(
	definition: TemporaryPlanDefinition,
	配方名: string,
	参数: Record<string, string> = {},
): string {
	const { 步骤 } = parameterizeSteps(definition.步骤, 参数);
	return emitRecipeMarkdown({
		版本: 2,
		名字: 配方名,
		自动执行: true,
		参数: Object.keys(参数),
		节点: 步骤.map(stepToNode),
		说明: `由临时计划「${definition.显示名}」（${definition.计划ID}，定义版本 ${definition.定义版本}）保存的模板；不含会话、卡号、实例状态与本次成果路径。`,
	});
}

/**
 * 保存模板：定义版本要一致（确认的是那一版），字段走白名单，落盘复用 `saveRecipe`（同名拒、原子写）。
 * 本次特有路径没有安全泛化办法，所以默认拒绝保存并把路径列出来给用户确认；确认后仍原样保留并在结果里点名。
 */
export function savePlanAsTemplate(input: PlanTemplateInput): PlanTemplateResult {
	throwIfPlanAborted(input.信号, "存为模板");
	const 项目根 = resolve(input.项目根);
	const definition = readTemporaryPlan(项目根, input.计划ID);
	assertPlanProject(definition, 项目根);
	assertPlanOwnership(definition, input.来源会话, "存为模板");
	if (definition.定义版本 !== input.定义版本) {
		throw new TemporaryPlanError(
			"PLAN_VERSION_CONFLICT",
			`定义版本漂移：盘上是 ${definition.定义版本}，请求基于 ${input.定义版本}；请重读后再保存模板`,
			{ 盘上版本: definition.定义版本, 预期版本: input.定义版本 },
		);
	}
	// 先按用户点名的替换表参数化，再看还剩哪些本次特有路径：
	// 顺序反了会把「即将被参数化掉的路径」也当成未泛化路径报出去。
	const 替换表 = input.参数 ?? {};
	const 参数化 = parameterizeSteps(definition.步骤, 替换表);
	if (参数化.未命中.length > 0) {
		throw new TemporaryPlanError(
			"PLAN_INVALID",
			`这些参数在计划里没找到要替换的文本，不能声明成空参数：${参数化.未命中.join("、")}；请给「本次的字面量」而不是参数名，或去掉这个参数`,
			{ 未命中参数: 参数化.未命中 },
		);
	}
	const 未泛化路径 = findTemplatePaths({ ...definition, 步骤: 参数化.步骤 });
	if (未泛化路径.length > 0 && input.允许未泛化路径 !== true) {
		throw new TemporaryPlanError(
			"PLAN_INVALID",
			`这版计划里含本次特有路径，不能直接当模板：${未泛化路径.join("、")}；用 params 把它们换成参数占位符，或显式确认原样保存（allow_project_specific_paths）`,
			{ 未泛化路径 },
		);
	}
	const content = buildPlanTemplateContent(definition, input.模板名, 替换表);
	const 已存在 = existsSync(join(resolve(input.paoHome), "工作流", `${input.模板名}.md`));
	if (已存在) {
		throw new TemporaryPlanError(
			"PLAN_INVALID",
			`模板名已被占用：${input.模板名}；同名模板不覆盖（要改请先在模板库里改名或删旧版）`,
			{ 模板名: input.模板名 },
		);
	}
	const result = saveRecipe(input.paoHome, input.模板名, content, {
		覆盖: false,
		备份时间: (input.当刻 ?? nowString()).replace(/[: ]/g, "-"),
	});
	return { 路径: result.路径, 节点数: result.节点数, 备份: result.备份, 未泛化路径 };
}
