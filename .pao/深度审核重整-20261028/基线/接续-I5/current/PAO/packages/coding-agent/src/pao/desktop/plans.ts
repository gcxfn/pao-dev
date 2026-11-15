/**
 * 临时计划的桌面只读投影（通用工作台阶段 4）：给桌面「对话与查看计划」提供最小查询面。
 *
 * 只读、只报盘上真值：定义来自 `<项目>/.pao/临时工作流/<计划ID>/计划.md`，启动关联来自同目录
 * `启动/<启动请求ID>.md`，实例状态向控制正本核一次（核不到就如实写读不到，不猜「运行中」）。
 * 创建/修改/撤销/启动/保存模板这些动作由主控经内核工具发起，本模块不提供写入入口——
 * 计划明确要求不加重填表单式的「创建临时工作流」按钮，页面只传已发现的身份与用户意图。
 *
 * 坏定义与坏关联都进 `问题`，不静默当没有；同名计划按稳定计划 ID 区分，不用显示名拼路径。
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatCardNumber, loadCard, type ParsedCard, parseCardRef, projectRootForCards } from "../cards/index.ts";
import { redactContext } from "../context/index.ts";
import { controlView, type FlowControl, readControl, readControlView } from "../workflow/control.ts";
import type { DriverOptions } from "../workflow/driver.ts";
import { loadFrozenRecipe } from "../workflow/minister.ts";
import {
	type PlanStartRecord,
	planDir,
	planFilePath,
	planStartRecordPath,
	readPlanStart,
	readTemporaryPlan,
	type TemporaryPlanStep,
} from "../workflow/plan.ts";
import { listPlanFeedback, type PlanFeedbackEntry } from "../workflow/plan-feedback.ts";
import type { DesktopReadIssue } from "./read-model.ts";

/** 步骤摘要：只投影界面要读的键，步骤 ID 是稳定身份。 */
export interface DesktopPlanStep {
	步骤ID: string;
	标题: string;
	部门: string;
	要求: string;
	预期成果?: string;
	依赖: readonly string[];
	人工门: boolean;
	只读: boolean;
	审核: boolean;
}

/** 一步的真实产物：路径原文来自回执 `artifact_path`，是否真的在盘上由内核核一次，界面不猜。
 * 同一相对路径在不同轮次各留一条（历史不许被去重吞掉）：`当前轮` 标出哪条属于本步骤的当前轮次，
 * 界面据此提示「有新版本」但不抢换正文，由用户主动切换，切换后正文与意见的版本才一致。 */
export interface DesktopPlanArtifact {
	路径: string;
	相对路径: string;
	轮次: number;
	卡号: string;
	/** 版本识别依据，恒为「第 N 轮（卡 X）」：界面拿它判断「这份文件是哪一轮哪张卡产出的」。 */
	版本依据: string;
	/** 该产物是否属于该步骤的当前轮次；历史轮次为 false（历史一条都不丢）。 */
	当前轮: boolean;
	存在: boolean;
	说明?: string;
}

/** 一次启动里某个步骤的运行投影：状态沿用单域英文值，产物只取「已交付」卡的回执。 */
export interface DesktopPlanStepProgress {
	步骤ID: string;
	状态: string;
	轮次?: number;
	挂起?: string;
	已确认?: string;
	需要人工确认: boolean;
	/** 这一步的活已经干完、只等人确认放行：controlView 只在人工确认通过后才报 delivered，
	 * 所以「活干完了但还没确认」必须单独给一个位，界面才不用去猜 `挂起` 的中文文案。 */
	等待人工确认: boolean;
	/** 控制正本里这一步当前的卡引用（停卡入口要用它点名，界面不自己编卡号）。 */
	卡: readonly string[];
	/** 这一步的执行记录（第几次、打回原因摘要）；没有控制信息就是空列表。 */
	记录: readonly DesktopPlanStepRecord[];
	读取问题?: string;
	产出: readonly DesktopPlanArtifact[];
}

/** 一次启动受理的关联真值；实例号/工作区/卡目录都从盘上读，不从请求参数推。 */
export interface DesktopPlanStartLink {
	启动请求ID: string;
	实例: string;
	配方名: string;
	工作区: string;
	卡目录: string;
	控制清单: string;
	owner会话: string;
	受理时刻: string;
	/** 控制正本当前状态；读不到控制正本时写明原因，不冒充「运行中」。 */
	状态: string;
	/** 控制正本读不到时为空数组，界面按「状态读不到」处理，不显示成「还没有产出」。 */
	进度: readonly DesktopPlanStepProgress[];
}

/** 计划视图：定义摘要＋启动关联＋意见（已记录/待送达/已送达/已应用分开由状态字段表达）。 */
export interface DesktopPlanView {
	计划ID: string;
	显示名: string;
	定义版本: number;
	已撤销: boolean;
	来源会话?: string;
	创建时刻: string;
	更新时刻: string;
	步骤: readonly DesktopPlanStep[];
	启动: readonly DesktopPlanStartLink[];
	意见: readonly PlanFeedbackEntry[];
}

export interface DesktopPlanReadResult {
	计划: readonly DesktopPlanView[];
	问题: readonly DesktopReadIssue[];
}

type MutableDesktopPlanReadResult = {
	计划: DesktopPlanView[];
	问题: DesktopReadIssue[];
};

function inside(root: string, file: string): boolean {
	const delta = relative(root, file);
	return !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`);
}

function toStep(step: TemporaryPlanStep): DesktopPlanStep {
	return {
		步骤ID: step.步骤ID,
		标题: step.标题,
		部门: step.部门,
		要求: step.要求,
		...(step.预期成果 === undefined ? {} : { 预期成果: step.预期成果 }),
		依赖: step.依赖 ?? [],
		人工门: step.人工门 === true,
		只读: step.只读 === true,
		审核: step.审核 === true,
	};
}

/** 回执里的产物路径按「相对项目根」记录（见 worker 派卡提示），这里把它落到项目根上核一次真值：
 * 越出项目根的不当产物展示；盘上没有的如实标 `存在: false`，界面不许拿别的东西冒充。
 * 基准必须是项目根，不是执行工作区——临时计划的执行工作区在 `.pao/临时工作流/…/执行/<请求>` 下，
 * 拿它当基准会把真实产物全判成「越出工作区」。
 * 导出供单测直接验「真值口径」，不经文件系统以外的推断。 */
export function artifactOf(
	项目根: string,
	记录: string,
	轮次: number,
	卡号: string,
	当前轮: boolean,
): DesktopPlanArtifact {
	const 路径 = 记录.trim();
	const requestRoot = resolve(项目根);
	const 绝对 = isAbsolute(路径) ? resolve(路径) : resolve(requestRoot, 路径);
	// 相对路径统一用正斜杠：它要跨进程给桌面显示与再读取，Windows 反斜杠既难读、也没必要漏到界面。
	const 相对路径 = (relative(requestRoot, 绝对) || ".").split(sep).join("/");
	// 版本依据恒由「轮次＋卡号」拼出，界面不自己编，也不靠文件时间戳猜是哪一版。
	// 卡号本身已经带「卡」前缀（formatCardNumber），这里不再重复加。
	const 版本依据 = `第 ${轮次} 轮（${卡号}）`;
	const artifactResult = (exists: boolean, note?: string): DesktopPlanArtifact => ({
		路径,
		相对路径,
		轮次,
		卡号,
		版本依据,
		当前轮,
		存在: exists,
		...(note === undefined ? {} : { 说明: note }),
	});

	let realRoot: string;
	try {
		realRoot = realpathSync(requestRoot);
	} catch (error) {
		return artifactResult(false, `项目根不可读，无法核实产物路径：${explainPathError(error)}`);
	}
	const lexicallyInside = inside(requestRoot, 绝对);
	let realTarget: string;
	try {
		realTarget = realpathSync(绝对);
	} catch (error) {
		if (isMissingPathError(error))
			return artifactResult(false, "盘上找不到这个文件（可能被移动，或这一轮还没真正产出）");
		return artifactResult(false, `无法核实产物真实路径：${explainPathError(error)}`);
	}
	if (!inside(realRoot, realTarget))
		return artifactResult(
			false,
			lexicallyInside ? "链接的真实路径越出项目，不作为产物展示" : "路径越出工作区，不作为产物展示",
		);

	if (lexicallyInside) {
		try {
			if (findLinkedComponent(requestRoot, 绝对))
				return artifactResult(false, "产物路径包含项目内链接（junction/symlink），不作为产物展示");
		} catch (error) {
			if (isMissingPathError(error))
				return artifactResult(false, "盘上找不到这个文件（可能被移动，或这一轮还没真正产出）");
			return artifactResult(false, `无法核实产物路径是否包含链接：${explainPathError(error)}`);
		}
	}

	try {
		const targetStat = statSync(realTarget);
		if (targetStat.isDirectory()) return artifactResult(false, "目标是目录（EISDIR）");
		if (!targetStat.isFile()) return artifactResult(false, "这个路径在盘上不是普通文件");
	} catch (error) {
		if (isMissingPathError(error))
			return artifactResult(false, "盘上找不到这个文件（可能被移动，或这一轮还没真正产出）");
		return artifactResult(false, `无法核实产物类型：${explainPathError(error)}`);
	}
	return artifactResult(true);
}

/** 只检查项目根以下的路径组件；项目根本身是 junction 时，由两侧 realpath 核范围。 */
function findLinkedComponent(root: string, target: string): string | undefined {
	const delta = relative(root, target);
	if (delta === "") return undefined;
	let current = root;
	for (const part of delta.split(sep)) {
		current = join(current, part);
		if (lstatSync(current).isSymbolicLink()) return current;
	}
	return undefined;
}

function isMissingPathError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function explainPathError(error: unknown): string {
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code === "ENOENT" || code === "ENOTDIR") return "路径不存在";
	if (code === "EACCES" || code === "EPERM") return `没有读取权限（${code}）`;
	if (code === "EISDIR") return "目标是目录（EISDIR）";
	const message = error instanceof Error ? error.message : String(error);
	return code ? `${message}（${code}）` : message;
}

/** 一步的一次执行记录：默认显示第几次执行与打回原因摘要；卡引用与判定原文按需展开。 */
export interface DesktopPlanStepRecord {
	轮次: number;
	卡: readonly string[];
	/** 该轮判定结果原文（pass/change/reject）；没有判定就不写，不猜。 */
	判定?: string;
	/** 判定理由或打回原因原文；没有就不写。 */
	原因?: string;
}

/** 按步骤汇总真实产物：只认状态为 delivered 的卡的回执。
 * 同一路径在不同轮次必须各留一条，不许去重吞历史——旧版是 Map 按相对路径覆盖，历史轮次会被吞掉。
 * `当前轮` 告诉界面哪条是最新的（本步骤当前轮次的卡），界面据此提示「有新版本」但不抢换正文，
 * 由用户主动切换，切换后正文与意见才指向同一版本。输出按「轮次升序、卡号升序」稳定排序。
 * `项目根` 是回执路径的解析基准（与 `projectRootForCards(卡目录)` 同一个根）。 */
function buildStepProgress(
	flow: FlowControl,
	view: ReturnType<typeof controlView>,
	项目根: string,
): DesktopPlanStepProgress[] {
	const definitions = new Map(flow.冻结配方.节点.map((node) => [node.名字, node]));
	const refs = new Map<string, { 轮次: number; 卡: string }[]>();
	for (const node of flow.节点) {
		const list: { 轮次: number; 卡: string }[] = [];
		for (const round of node.历史) for (const ref of round.卡) list.push({ 轮次: round.轮次, 卡: ref });
		for (const ref of node.卡) list.push({ 轮次: node.轮次, 卡: ref });
		refs.set(node.名字, list);
	}
	return view.节点.map((node) => {
		const control = flow.节点.find((item) => item.名字 === node.名字);
		const definition = definitions.get(node.名字);
		const 产物: DesktopPlanArtifact[] = [];
		const 问题: string[] = [];
		// 当前轮次的卡全部交付、且审核有结论，才算「这一步的活干完了」；历史轮次只用于产物盘点。
		let 活干完 = !!control && control.拆解结束 && control.卡.length > 0;
		for (const { 轮次, 卡 } of refs.get(node.名字) ?? []) {
			const 是本轮卡 = !!control?.卡.includes(卡);
			let card: ParsedCard;
			try {
				card = loadCard(flow.卡目录, parseCardRef(卡));
			} catch (error) {
				问题.push(`卡 ${卡} 读不出来：${error instanceof Error ? error.message : String(error)}`);
				if (是本轮卡) 活干完 = false;
				continue;
			}
			if (是本轮卡 && card.frontmatter.status !== "delivered") 活干完 = false;
			if (card.frontmatter.status !== "delivered") continue;
			const 卡号 = formatCardNumber(card.card_no);
			for (const receipt of card.receipts)
				for (const raw of receipt.artifact_path ?? []) {
					产物.push(artifactOf(项目根, raw, 轮次, 卡号, 是本轮卡));
				}
		}
		if (活干完 && definition?.审核 === true && control?.判定?.结果 !== "pass" && !control?.放行修复) 活干完 = false;
		// 轮次升序、卡号升序；Array.sort 稳定，同一轮内保持回执出现顺序。
		产物.sort((a, b) => a.轮次 - b.轮次 || (a.卡号 < b.卡号 ? -1 : a.卡号 > b.卡号 ? 1 : 0));
		return {
			步骤ID: node.名字,
			状态: node.状态,
			...(node.轮次 === undefined ? {} : { 轮次: node.轮次 }),
			...(node.挂起 === undefined ? {} : { 挂起: node.挂起 }),
			...(node.已确认 === undefined ? {} : { 已确认: node.已确认 }),
			需要人工确认: node.人工确认,
			等待人工确认: 活干完 && node.人工确认 && node.已确认 === undefined,
			卡: (refs.get(node.名字) ?? []).map((item) => item.卡),
			记录: stepRecords(control),
			...(问题.length === 0 ? {} : { 读取问题: 问题.join("；") }),
			产出: 产物,
		};
	});
}

/** 同步兼容投影：状态只取持久控制正本，未经当前内容树核对。 */
export function stepProgress(flow: FlowControl, 项目根: string): DesktopPlanStepProgress[] {
	return buildStepProgress(flow, controlView(flow), 项目根);
}

/** 真实桌面投影：一次共享异步核对后复用同一视图构建全部步骤。 */
export async function stepProgressFresh(
	flow: FlowControl,
	options: DriverOptions,
	项目根: string,
	deadMinisters?: ReadonlySet<string>,
): Promise<DesktopPlanStepProgress[]> {
	return buildStepProgress(flow, await readControlView(flow, options, deadMinisters), 项目根);
}

/** 执行记录：历史轮次按发生顺序在前，当前轮次在后；没有控制信息就是空列表。 */
function stepRecords(control: FlowControl["节点"][number] | undefined): DesktopPlanStepRecord[] {
	if (!control) return [];
	const records: DesktopPlanStepRecord[] = control.历史.map((round) => ({
		轮次: round.轮次,
		卡: round.卡,
		...(round.判定 === undefined ? {} : { 判定: round.判定.结果, 原因: round.判定.理由 }),
		...(round.判定 === undefined && round.原因 ? { 原因: round.原因 } : {}),
	}));
	if (control.轮次 > 0)
		records.push({
			轮次: control.轮次,
			卡: control.卡,
			...(control.判定 === undefined ? {} : { 判定: control.判定.结果, 原因: control.判定.理由 }),
			...(control.判定 === undefined && control.重做理由 ? { 原因: control.重做理由 } : {}),
		});
	return records;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function discoverPlanDirectories(
	projectRoot: string,
	result: MutableDesktopPlanReadResult,
): { root: string; directories: string[] } | undefined {
	let root: string;
	try {
		root = realpathSync(projectRoot);
	} catch (error) {
		result.问题.push({ 路径: projectRoot, 说明: `项目目录不可读：${String(error)}` });
		return undefined;
	}
	const 计划根 = join(root, ".pao", "临时工作流");
	try {
		// 逐个目录直读，不走 listTemporaryPlans：那份实现会跳过读不出来的定义，
		// 而这里必须把坏定义点名（否则界面显示「还没有计划」，用户以为自己没建过）。
		const directories = readdirSync(计划根, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(计划根, entry.name));
		return visiblePlanDirectories(root, directories, result);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			result.问题.push({ 路径: 计划根, 说明: `临时计划目录不可读：${String(error)}` });
		return undefined;
	}
}

function visiblePlanDirectories(
	projectRoot: string,
	directories: readonly string[],
	result: MutableDesktopPlanReadResult,
): { root: string; directories: string[] } {
	const root = realpathSync(projectRoot);
	const visible: string[] = [];
	for (const directory of [...directories].sort()) {
		if (!inside(root, realpathSync(directory))) {
			result.问题.push({ 路径: directory, 说明: "临时计划目录越出项目" });
			continue;
		}
		visible.push(directory);
	}
	return { root, directories: visible };
}

function startRecordNames(root: string, planId: string, issues: DesktopReadIssue[]): string[] {
	const startDir = join(planDir(root, planId), "启动");
	try {
		return readdirSync(startDir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -3))
			.sort();
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			issues.push({ 路径: startDir, 说明: `启动关联目录不可读：${errorText(error)}` });
		return [];
	}
}

function planView(root: string, planId: string, starts: readonly DesktopPlanStartLink[]): DesktopPlanView {
	const definition = readTemporaryPlan(root, planId);
	return {
		计划ID: definition.计划ID,
		显示名: definition.显示名,
		定义版本: definition.定义版本,
		已撤销: definition.已撤销 === true,
		...(definition.来源会话 === undefined ? {} : { 来源会话: definition.来源会话 }),
		创建时刻: definition.创建时刻,
		更新时刻: definition.更新时刻,
		步骤: definition.步骤.map(toStep),
		启动: starts,
		意见: listPlanFeedback(root, definition.计划ID),
	};
}

function readStartRecord(projectRoot: string, planId: string, startId: string): PlanStartRecord {
	const record = readPlanStart(planStartRecordPath(projectRoot, planId, startId));
	if (!record) throw new Error("启动关联为空或格式不可识别");
	return record;
}

function startLink(
	record: PlanStartRecord,
	view: ReturnType<typeof controlView>,
	flow: FlowControl,
): DesktopPlanStartLink {
	return {
		...record,
		状态: view.状态,
		进度: buildStepProgress(flow, view, projectRootForCards(record.卡目录)),
	};
}

function unavailableStart(record: PlanStartRecord, error: unknown): DesktopPlanStartLink {
	return { ...record, 状态: `控制正本读不到：${errorText(error)}`, 进度: [] };
}

function readStartLinkSync(projectRoot: string, planId: string, startId: string): DesktopPlanStartLink {
	const record = readStartRecord(projectRoot, planId, startId);
	try {
		const options = { cardsDir: record.卡目录, workspaceDir: record.工作区 };
		const flow = readControl(loadFrozenRecipe(record.配方名, options), options);
		return startLink(record, controlView(flow), flow);
	} catch (error) {
		return unavailableStart(record, error);
	}
}

async function readStartLinkFresh(
	projectRoot: string,
	planId: string,
	startId: string,
	deadMinisters?: ReadonlySet<string>,
): Promise<DesktopPlanStartLink> {
	const record = readStartRecord(projectRoot, planId, startId);
	try {
		const options = { cardsDir: record.卡目录, workspaceDir: record.工作区 };
		const flow = readControl(loadFrozenRecipe(record.配方名, options), options);
		return startLink(record, await readControlView(flow, options, deadMinisters), flow);
	} catch (error) {
		return unavailableStart(record, error);
	}
}

/** 同步兼容读面：定义和卡为当前盘面，启动实例状态未经当前内容树核对。 */
export function readDesktopPlans(projectRoot: string): DesktopPlanReadResult {
	const result: MutableDesktopPlanReadResult = { 计划: [], 问题: [] };
	const discovered = discoverPlanDirectories(projectRoot, result);
	if (!discovered) return result;
	for (const directory of discovered.directories) {
		const planId = basename(directory);
		const starts: DesktopPlanStartLink[] = [];
		for (const startId of startRecordNames(discovered.root, planId, result.问题)) {
			try {
				starts.push(readStartLinkSync(discovered.root, planId, startId));
			} catch (error) {
				result.问题.push({
					路径: join(planDir(discovered.root, planId), "启动", `${startId}.md`),
					说明: `启动关联不可读：${errorText(error)}`,
				});
			}
		}
		try {
			result.计划.push(planView(discovered.root, planId, starts));
		} catch (error) {
			result.问题.push({ 路径: planFilePath(discovered.root, planId), 说明: errorText(error) });
		}
	}
	return redactContext(result) as DesktopPlanReadResult;
}

/** 真实桌面读面：每个启动实例经共享异步入口核对一次当前内容树。 */
export async function readDesktopPlansFresh(
	projectRoot: string,
	deadMinisters?: ReadonlySet<string>,
): Promise<DesktopPlanReadResult> {
	const result: MutableDesktopPlanReadResult = { 计划: [], 问题: [] };
	const discovered = discoverPlanDirectories(projectRoot, result);
	if (!discovered) return result;
	for (const directory of discovered.directories) {
		const planId = basename(directory);
		const starts: DesktopPlanStartLink[] = [];
		for (const startId of startRecordNames(discovered.root, planId, result.问题)) {
			try {
				starts.push(await readStartLinkFresh(discovered.root, planId, startId, deadMinisters));
			} catch (error) {
				result.问题.push({
					路径: join(planDir(discovered.root, planId), "启动", `${startId}.md`),
					说明: `启动关联不可读：${errorText(error)}`,
				});
			}
		}
		try {
			result.计划.push(planView(discovered.root, planId, starts));
		} catch (error) {
			result.问题.push({ 路径: planFilePath(discovered.root, planId), 说明: errorText(error) });
		}
	}
	return redactContext(result) as DesktopPlanReadResult;
}
