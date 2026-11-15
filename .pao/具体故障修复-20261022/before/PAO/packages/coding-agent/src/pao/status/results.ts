/**
 * D8c 结果页聚合＋恢复摘要（设计包 2026-10-04，§6 拍板：升级桌面扩展既有「结果与恢复」tab，
 * §3 新 AppView 方案作废）。按工作流实例聚合四样——要求／实际 diff（文件级）／验收／遗留——
 * ＋恢复摘要四态（已完成／已中断／已改未验／拟续跑，判据全部来自正本结构化字段，可并存如实并列）。
 *
 * 照 status/pending.ts 模式：纯读零落盘、逐源 try/catch 降级异常项、判据取正本结构化字段不猜文案。
 * 散卡（无工作流实例）不进结果面（拍板 2：「待处理」tab 已覆盖散卡口径）；v1 旧实例进结果行但
 * 四样如实标注不可结构化读取（无控制正本），不编造。坏实例如实进异常行（同 collectPending 口径），
 * 不得当空闲清理或自动续跑。
 *
 * git 调用走注入点（options.runGit，缺省 execFile 真跑），hermetic 测试注入假输出；
 * 实现照 workflow/control.ts buildDecisionPackage:648-661 的只读拆版——不落盘判定包、不 assertOwner。
 * 本模块只读：「拟续跑」只给建议命令文案（同 pending.ts 口径），续跑必须由用户在对话/控制入口显式发起。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
	type BaselineDiff,
	baselineSnapshotPath,
	checkBoundaryWrite,
	PROJECT_CONTENT_PATHSPECS,
	parseSnapshot,
} from "../cards/baseline.ts";
import { listCards, loadCard } from "../cards/cardfile.ts";
import { formatCardNumber, parseCardRef } from "../cards/counter.ts";
import type { ParsedCard } from "../cards/types.ts";
import { readLatestVerdict } from "../cards/verifier.ts";
import { gitSpawnErrorText } from "../shared/git.ts";
import { controlView, type FlowControl } from "../workflow/control.ts";
import { humanGateSuspendReason, parseWorkflowMarker, type WorkflowManifest } from "../workflow/driver.ts";
import { substituteParams } from "../workflow/recipe.ts";
import { type InstanceAnomalyRow, readWorkflowInstance, scanWorkflowInstanceFiles } from "./workflow-instances.ts";

/** 单次 git 调用结果（注入点契约；code!==0 时 stderr 带原因）。 */
export interface ResultsGitOutput {
	code: number;
	stdout: string;
	stderr: string;
}
/** git 注入点：args 不含 "git" 本体；cwd 为工作目录。缺省实现同 control.ts gitOutput。 */
export type ResultsRunGit = (args: string[], cwd: string) => Promise<ResultsGitOutput>;

export interface CollectResultsOptions {
	/** git 注入点；缺省 execFile 真跑（测试注入假输出保 hermetic）。 */
	runGit?: ResultsRunGit;
}

export interface ResultsDiffFile {
	/** git name-status 状态码（A/M/D/R…；R 显示为「新 -> 旧」同 baseline.ts 口径） */
	状态: string;
	文件: string;
}

/** 节点实际 diff（文件级，控制体积；全文留按需钻取——拍板 1）。 */
export type NodeDiffSection =
	| { 可用: false; 原因: string }
	| { 可用: true; 摘要: string; 文件: ResultsDiffFile[]; 新增未跟踪: string[] };

export interface NodeRequirement {
	/** 冻结配方 def.验收（substituteParams 后），判定包同源（control.ts:640） */
	卡面轴: string;
	/** def.部门标准；缺省如实「未声明」（control.ts:641） */
	部门标准轴: string;
}

export interface NodeAcceptance {
	/** 卡正文「## 机械验收」派生段（readLatestVerdict，verifier.ts:535） */
	记录: { 卡: string; 时间: string; 结论: string }[];
	/** 节点判定（Decision：结果/理由/时间） */
	判定?: { 结果: string; 理由: string; 时间: string };
	/** 机械验收与判定皆缺时的如实说明 */
	缺失说明?: string;
}

/** 单节点四样（要求／实际 diff／验收／遗留）。恢复摘要的「已改未验」两判据从这里机械推导。 */
export interface NodeResultSection {
	节点: string;
	轮次: number;
	卡: string[];
	要求: NodeRequirement;
	实际diff: NodeDiffSection;
	验收: NodeAcceptance;
	遗留: string[];
}

export interface RecoveryLine {
	态: "已完成" | "已中断" | "已改未验" | "拟续跑";
	文案: string;
	证据: string[];
}

/** 恢复摘要四态（设计包 §2）：判据全取正本结构化字段；四态可并存，如实并列。 */
export interface RecoverySummary {
	/** controlReport 状态「已完成」（complete 的机械口径，control.ts:167-173） */
	已完成: boolean;
	/** 状态「挂起」或 人工门/裁定/暂停 有值（判据与 scanInstanceSignals 同源，不猜文案） */
	已中断: boolean;
	/** 节点「基线外改动>0 且对应卡无机械验收段且无判定」；两判据冲突时并列展示不取其一（拍板 5） */
	已改未验: boolean;
	/** 有待处理信号的机械建议命令（同 pending.ts 文案；本视图零动作，续跑走对话/控制入口） */
	拟续跑: boolean;
	行: RecoveryLine[];
}

export interface OrphanCard {
	卡号: number;
	节点: string;
	卡状态: string;
}

/** 单实例结果行：标识五样＋分节点四样＋孤儿卡＋恢复摘要。 */
export interface InstanceResultRow {
	项目: string;
	项目根: string;
	工作流: string;
	/** v2 实例 UUID；v1 旧清单无实例 ID，如实空串 */
	实例: string;
	路径: string;
	/** controlReport 投影状态（v2）；v1 为清单状态 */
	状态: string;
	/** 非致命降级说明（如孤儿卡扫描失败）；v1 行说明四样为何不可读 */
	说明?: string;
	节点结果: NodeResultSection[];
	孤儿卡: OrphanCard[];
	恢复: RecoverySummary;
}

/** 坏实例/目录不可达异常行（同 collectPending 的实例异常口径，不得当空闲清理）。 */
export type ResultsAnomalyRow = InstanceAnomalyRow;

export interface InstanceResultsSnapshot {
	line: InstanceResultRow[];
	exception: ResultsAnomalyRow[];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 缺省 git 执行（同 workflow/control.ts gitOutput：quotepath=false、隐藏窗口、16MiB 上限）。 */
function defaultRunGit(args: string[], cwd: string): Promise<ResultsGitOutput> {
	return new Promise((done) =>
		execFile(
			"git",
			["-c", "core.quotepath=false", ...args],
			{ cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) =>
				done({ code: error ? 1 : 0, stdout, stderr: stderr || (error ? gitSpawnErrorText(error) : "") }),
		),
	);
}

/**
 * 只在一次结果聚合调用内复用相同 Git 查询。
 * key 同时包含真实工作目录和完整参数，避免不同项目、不同基线或不同排除规则串用结果；
 * Promise 也缓存失败，保持原有错误说明而不悄悄重跑。
 */
function memoizeRunGit(runGit: ResultsRunGit): ResultsRunGit {
	const pending = new Map<string, Promise<ResultsGitOutput>>();
	return (args, cwd) => {
		// 只用真实路径生成缓存键，让同一个项目通过符号链接访问时仍共用
		// 查询；找不到目录时保留原 cwd 交给 runGit，从而不改变原错误语义。
		let keyCwd = cwd;
		try {
			keyCwd = realpathSync(cwd);
		} catch {
			// 缓存键退回原值；真正的目录错误仍由 runGit 报告。
		}
		const key = JSON.stringify([keyCwd, args]);
		const existing = pending.get(key);
		if (existing) return existing;
		const current = Promise.resolve().then(() => runGit(args, cwd));
		pending.set(key, current);
		return current;
	};
}

/** git status --porcelain -z 解析（NUL 分隔、路径原样；R/C 条目消费第二字段），与 baseline.ts 同口径。 */
function parsePorcelainZ(out: string): ResultsDiffFile[] {
	const fields = out.split("\0");
	const entries: ResultsDiffFile[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]!;
		if (!field) continue;
		const xy = field.slice(0, 2);
		const file = field.slice(3);
		if (/[RC]/.test(xy)) {
			const originalPath = fields[++i] ?? "";
			entries.push({ 状态: xy.trim(), 文件: `${file} -> ${originalPath}` });
		} else {
			entries.push({ 状态: xy.trim() || "??", 文件: file });
		}
	}
	return entries;
}

/** git diff --name-status 行解析（R/C 为「旧\t新」两路径，显示为「新 -> 旧」）。 */
function parseNameStatusLine(line: string): ResultsDiffFile {
	const parts = line.split("\t");
	if (parts.length >= 3) return { 状态: parts[0]!, 文件: `${parts[2]} -> ${parts[1]}` };
	return { 状态: parts[0] ?? "?", 文件: parts[1] ?? "" };
}

/** 单卡越界核查遗留（重算：git 真值 − 认领基线 vs 末次回执声明；无认领快照的卡不比对不猜）。 */
async function outOfScopeLeftover(cardsDir: string, card: ParsedCard, runGit: ResultsRunGit): Promise<string[]> {
	const snapshotPath = baselineSnapshotPath(cardsDir, card.card_no);
	if (!existsSync(snapshotPath)) return [];
	try {
		const text = readFileSync(snapshotPath, "utf8");
		const baseline = parseSnapshot(text);
		const projectRoot = /^# 项目根: (.+)$/m.exec(text)?.[1]?.trim();
		if (!projectRoot) return [`卡${formatCardNumber(card.card_no)} 越界比对无法进行：快照缺项目根`];
		const status = await runGit(
			[
				"status",
				"--porcelain",
				"-z",
				// 未跟踪目录展开到文件级：全新目录场景（目录里无已跟踪文件）git 只报目录级
				// `?? 产出/`，与回执的文件级声明比对不上（与 baseline.ts gitStatusEntries 同口径，S6-K4 修）
				"-uall",
				"--",
				".",
				":(exclude).pao",
			],
			projectRoot,
		);
		if (status.code !== 0)
			return [
				`卡${formatCardNumber(card.card_no)} 越界比对无法进行：git 状态不可用（${status.stderr.slice(0, 200)}）`,
			];
		const base = new Set(baseline.flatMap((entry) => entry.文件.split(" -> ")));
		const diff: BaselineDiff = {
			基线可用: true,
			worker改动: parsePorcelainZ(status.stdout).filter((entry) =>
				entry.文件.split(" -> ").every((path) => !base.has(path)),
			),
			既有条目数: baseline.length,
			项目根: projectRoot,
			汇总: "",
		};
		const last = card.receipts[card.receipts.length - 1];
		const declared = Array.isArray(last?.artifact_path) ? last!.artifact_path! : [];
		const check = checkBoundaryWrite(diff, declared, { 项目根: projectRoot });
		return check.结论 === "干净" ? [] : [`卡${formatCardNumber(card.card_no)} 越界核查 ${check.结论}：${check.汇总}`];
	} catch (error) {
		return [`卡${formatCardNumber(card.card_no)} 越界比对失败：${errorText(error).slice(0, 200)}`];
	}
}

/** 单节点四样段（照 buildDecisionPackage 只读拆版：不落盘、不 assertOwner、diff 只取文件级）。 */
async function nodeResultSection(
	flow: FlowControl,
	node: FlowControl["节点"][number],
	runGit: ResultsRunGit,
): Promise<NodeResultSection> {
	const def = flow.冻结配方.节点.find((n) => n.名字 === node.名字)!;
	const leftover: string[] = [];
	// 要求＝冻结配方两轴（判定包同源，control.ts:640-641）
	const requirement: NodeRequirement = {
		卡面轴: substituteParams(def.验收, flow.参数),
		部门标准轴: def.部门标准 ?? "未声明",
	};
	let cards: ParsedCard[] = [];
	try {
		cards = node.卡.map((ref) => loadCard(flow.卡目录, parseCardRef(ref)));
	} catch (error) {
		leftover.push(`卡读取失败：${errorText(error).slice(0, 200)}`);
	}
	// 实际 diff＝文件级清单＋stat 摘要＋新增未跟踪（控制体积；全文留「按需读取」钻取，拍板 1）
	let actualDiff: NodeDiffSection;
	if (!node.基线) {
		actualDiff = { 可用: false, 原因: `缺 diff 基线：${node.基线错误 ?? "未固定"}` };
	} else {
		const baseline = node.基线;
		try {
			const nameStatus = await runGit(
				[
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					"--name-status",
					baseline.提交,
					"--",
					...PROJECT_CONTENT_PATHSPECS,
				],
				baseline.项目根,
			);
			const stat = await runGit(
				["diff", "--no-ext-diff", "--no-textconv", "--stat", baseline.提交, "--", ...PROJECT_CONTENT_PATHSPECS],
				baseline.项目根,
			);
			const untracked = await runGit(
				["ls-files", "--others", "--exclude-standard", "-z", "--", ...PROJECT_CONTENT_PATHSPECS],
				baseline.项目根,
			);
			if (nameStatus.code !== 0 || stat.code !== 0)
				actualDiff = { 可用: false, 原因: `diff 读取失败:${(nameStatus.stderr || stat.stderr).slice(0, 300)}` };
			else if (untracked.code !== 0)
				actualDiff = { 可用: false, 原因: `未跟踪文件读取失败:${untracked.stderr.slice(0, 300)}` };
			else {
				const statLine = stat.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "无已跟踪差异";
				actualDiff = {
					可用: true,
					摘要: statLine,
					文件: nameStatus.stdout.split(/\r?\n/).filter(Boolean).map(parseNameStatusLine),
					新增未跟踪: untracked.stdout
						.split("\0")
						.filter((p) => p && !p.startsWith(".pao/") && !baseline.未跟踪.includes(p)),
				};
			}
		} catch (error) {
			actualDiff = { 可用: false, 原因: `diff 读取异常:${errorText(error).slice(0, 300)}` };
		}
	}
	if (node.基线?.未跟踪.length)
		leftover.push(
			`基线已有未跟踪文件（${node.基线.未跟踪.length} 个），内容变化未能归因，须独立核查：${node.基线.未跟踪.join("、")}`,
		);
	// 验收＝卡正文机械验收段（readLatestVerdict）＋节点判定；两者皆缺→「缺验收记录」
	const record: NodeAcceptance["记录"] = [];
	for (const card of cards) {
		const verdict = readLatestVerdict(card.body);
		if (verdict)
			record.push({
				卡: formatCardNumber(card.card_no),
				时间: verdict.时间,
				结论: verdict.结论 || "（段内未记结论）",
			});
	}
	const judgement = node.判定 ? { 结果: node.判定.结果, 理由: node.判定.理由, 时间: node.判定.时间 } : undefined;
	const acceptance: NodeAcceptance = {
		记录: record,
		...(judgement ? { 判定: judgement } : {}),
		...(!judgement && record.length === 0 ? { 缺失说明: "缺验收记录" } : {}),
	};
	// 遗留·越界核查：每卡重算（认领基线快照＋当前 git 真值＋回执声明），非干净结论透传
	for (const card of cards) leftover.push(...(await outOfScopeLeftover(flow.卡目录, card, runGit)));
	return {
		节点: node.名字,
		轮次: node.轮次,
		卡: [...node.卡],
		要求: requirement,
		实际diff: actualDiff,
		验收: acceptance,
		遗留: leftover,
	};
}

/** v2 恢复摘要四态（判据与 pending.ts signalPending / scanInstanceSignals 同源，不猜文案）。 */
function resumeSummary(
	flow: FlowControl,
	view: ReturnType<typeof controlView>,
	path: string,
	nodeResult: NodeResultSection[],
): RecoverySummary {
	const line: RecoveryLine[] = [];
	const humanGate = view.节点.filter((node) => node.挂起 === humanGateSuspendReason);
	const completed = view.状态 === "已完成";
	if (completed)
		line.push({
			态: "已完成",
			文案: "控制正本状态：已完成（卡全交付＋判定 pass/放行＋人工门已确认的机械口径）",
			证据: [path],
		});
	const interrupted =
		view.状态 === "挂起" || humanGate.length > 0 || flow.裁定 !== undefined || flow.暂停 !== undefined;
	if (flow.暂停) line.push({ 态: "已中断", 文案: `实例暂停：${flow.暂停}`, 证据: [path] });
	for (const gate of humanGate)
		line.push({
			态: "已中断",
			文案: `节点 ${gate.名字} 第 ${gate.轮次} 轮等待人工确认（${humanGateSuspendReason}，报告状态仍是「${view.状态}」）`,
			证据: [path],
		});
	if (flow.裁定)
		line.push({
			态: "已中断",
			文案: `节点 ${flow.裁定.节点} 第 ${flow.裁定.轮次} 轮待${flow.裁定.通道}裁定：${flow.裁定.理由}`,
			证据: [path],
		});
	if (!flow.暂停 && humanGate.length === 0 && !flow.裁定 && view.状态 === "挂起")
		line.push({ 态: "已中断", 文案: "控制正本状态：挂起（无更细停因字段）", 证据: [path] });
	// 已改未验两判据（拍板 5：冲突并列展示，不加第三标签）：
	// ①基线外改动>0（节点 diff 文件＋新增未跟踪）；②对应卡无机械验收段且无判定
	let editedUnverified = false;
	for (const node of nodeResult) {
		const editCount = node.实际diff.可用 ? node.实际diff.文件.length + node.实际diff.新增未跟踪.length : undefined;
		const unverified = node.验收.记录.length === 0 && !node.验收.判定;
		if (editCount === undefined) {
			if (unverified)
				line.push({
					态: "已改未验",
					文案: `节点 ${node.节点}：缺 diff 基线无法核验改动；卡无机械验收段且无判定（两判据并列，不下单方结论）`,
					证据: [path],
				});
			continue;
		}
		if (editCount > 0 && unverified) {
			editedUnverified = true;
			line.push({
				态: "已改未验",
				文案: `节点 ${node.节点}：基线外改动 ${editCount} 处，且卡无机械验收段、无判定`,
				证据: [path],
			});
		} else if (editCount > 0) {
			line.push({
				态: "已改未验",
				文案: `节点 ${node.节点}（判据并列）：基线外改动 ${editCount} 处（>0）；但卡有机械验收记录/判定，「未验」不成立`,
				证据: [path],
			});
		} else if (unverified) {
			line.push({
				态: "已改未验",
				文案: `节点 ${node.节点}（判据并列）：无基线外改动；但卡无机械验收段且无判定`,
				证据: [path],
			});
		}
	}
	// 拟续跑＝待处理信号机械建议（同 pending.ts 文案给真值；本视图零动作）
	const suggestion: string[] = [];
	for (const gate of humanGate)
		suggestion.push(
			`pao_control_node action=confirm name=${flow.工作流} instance=${flow.实例} node=${gate.名字} round=${gate.轮次}（须你在界面确认）`,
		);
	if (flow.裁定)
		suggestion.push(
			`pao_control_node action=rule name=${flow.工作流} instance=${flow.实例} node=${flow.裁定.节点} round=${flow.裁定.轮次} result=<pass|change|reject> reason=<…>`,
		);
	else if (flow.暂停?.includes("超限"))
		suggestion.push("拍板后用 pao_control_node action=confirm 放行，或停流改配方后建新实例（不改进已冻结实例）");
	if (suggestion.length === 0 && view.状态 === "挂起")
		suggestion.push(
			`pao_control_node action=resume name=${flow.工作流} instance=${flow.实例} prev_owner=${flow.owner} reason=<现场核查>（须你在界面确认）`,
		);
	for (const command of suggestion) line.push({ 态: "拟续跑", 文案: command, 证据: [path] });
	return {
		已完成: completed,
		已中断: interrupted,
		已改未验: editedUnverified,
		拟续跑: suggestion.length > 0,
		行: line,
	};
}

/** v1 旧实例行：无控制正本结构化字段，四样如实标注不可读，不编造；恢复摘要只有清单状态可依。 */
function v1InstanceLine(
	path: string,
	projectName: string,
	projectRoot: string,
	manifest: WorkflowManifest,
): InstanceResultRow {
	const suspend = manifest.状态 === "挂起";
	const line: RecoveryLine[] = [];
	if (manifest.状态 === "已完成")
		line.push({ 态: "已完成", 文案: "旧版实例清单状态：已完成（清单口径，未经 v2 机械完成判据）", 证据: [path] });
	if (suspend) {
		line.push({ 态: "已中断", 文案: "旧版实例清单挂起；清单无停因字段，停因无法从清单读出", 证据: [path] });
		line.push({
			态: "拟续跑",
			文案: "旧版实例不可自动续跑；保留原件，核对卡与回执后人工重建新实例",
			证据: [path],
		});
	}
	return {
		项目: projectName,
		项目根: projectRoot,
		工作流: manifest.工作流,
		实例: "",
		路径: path,
		状态: manifest.状态,
		说明: "旧版实例（v1）：无 v2 控制正本结构化字段，四样（要求/实际 diff/验收/遗留）不可结构化读取；历史展示，须人工重建后才能续跑",
		节点结果: [],
		孤儿卡: [],
		恢复: {
			已完成: manifest.状态 === "已完成",
			已中断: suspend,
			已改未验: false,
			拟续跑: suspend,
			行: line,
		},
	};
}

/** 读单个实例并聚合成结果行（v2 走控制正本机械字段；v1 只有清单状态可读）。失败抛错，由调用方转异常行。 */
async function instanceResultLine(
	path: string,
	projectName: string,
	projectRoot: string,
	runGit: ResultsRunGit,
): Promise<InstanceResultRow> {
	const instance = readWorkflowInstance(path);
	if (instance.版本 === 1) {
		if (!instance.清单) throw new Error("v1 实例读取未返回清单");
		return v1InstanceLine(path, projectName, projectRoot, instance.清单);
	}
	const flow = instance.控制!;
	const view = controlView(flow);
	const nodeResult: NodeResultSection[] = [];
	for (const node of flow.节点) {
		try {
			nodeResult.push(await nodeResultSection(flow, node, runGit));
		} catch (error) {
			const reason = errorText(error).slice(0, 200);
			nodeResult.push({
				节点: node.名字,
				轮次: node.轮次,
				卡: [...node.卡],
				要求: { 卡面轴: "读取失败", 部门标准轴: "读取失败" },
				实际diff: { 可用: false, 原因: `节点段读取失败：${reason}` },
				验收: { 记录: [], 缺失说明: `节点段读取失败：${reason}` },
				遗留: [],
			});
		}
	}
	// 孤儿卡（review.ts buildReviewReport 同口径：标记指向本流但节点不在配方，配方改版遗留，点名不丢弃）
	let orphanCard: OrphanCard[] = [];
	const description: string[] = [];
	try {
		orphanCard = listCards(flow.卡目录).flatMap((card) => {
			const marker = parseWorkflowMarker(card.body);
			if (!marker || marker.流 !== flow.工作流) return [];
			if (flow.冻结配方.节点.some((n) => n.名字 === marker.节点)) return [];
			return [{ 卡号: card.card_no, 节点: marker.节点, 卡状态: card.frontmatter.status }];
		});
	} catch (error) {
		description.push(`孤儿卡扫描失败：${errorText(error).slice(0, 200)}`);
	}
	return {
		项目: projectName,
		项目根: projectRoot,
		工作流: flow.工作流,
		实例: flow.实例,
		路径: path,
		状态: view.状态,
		...(description.length ? { 说明: description.join("；") } : {}),
		节点结果: nodeResult,
		孤儿卡: orphanCard,
		恢复: resumeSummary(flow, view, path, nodeResult),
	};
}

/**
 * 聚合各项目工作流实例的结果面（只读，零落盘；各源失败逐段降级，坏实例如实进异常行，不抛错炸视图）。
 * 散卡（无工作流实例）不进本面；v1 旧实例四样如实标注不可读。git 调用走注入点保 hermetic。
 */
export async function collectInstanceResults(
	paoHome: string,
	options: CollectResultsOptions = {},
): Promise<InstanceResultsSnapshot> {
	const runGit = memoizeRunGit(options.runGit ?? defaultRunGit);
	const exception: ResultsAnomalyRow[] = [];
	const line: InstanceResultRow[] = [];
	let discovered: ReturnType<typeof scanWorkflowInstanceFiles>;
	try {
		discovered = scanWorkflowInstanceFiles(paoHome);
	} catch (error) {
		return {
			line: [],
			exception: [{ 路径: join(paoHome, "项目清单.md"), 文件: "项目清单.md", 原因: errorText(error) }],
		};
	}
	exception.push(...discovered.anomalies);
	for (const file of discovered.files) {
		try {
			line.push(await instanceResultLine(file.path, file.projectName, file.projectRoot, runGit));
		} catch (error) {
			const pathParts = file.path.split(/[\\/]/);
			exception.push({ 路径: file.path, 文件: pathParts.at(-1) ?? file.path, 原因: errorText(error) });
		}
	}
	return { line: line, exception: exception };
}
