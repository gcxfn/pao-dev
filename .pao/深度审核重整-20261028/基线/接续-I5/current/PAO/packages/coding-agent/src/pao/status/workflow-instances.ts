/**
 * 工作流实例清单扫描（首跑清单 firstrun 与 /pao pano 全景共用同一口径,只读不落盘）。
 *
 * 浅字段分流修复（2026-10-04）:
 * - v1 实例走 driver parseManifest——必要控制字段严格校验,坏字段/缺字段抛错,不再降级伪装「运行中」;
 * - v2 实例走 workflow/control readControl→controlReport 读真实状态（损坏时 [FLOW_CONTROL] 显式失败）,
 *   运行中/已完成不列（挂起清单语义不变）,但损坏实例显式进「异常」,不再被静默跳过称无挂起;
 * - 实例文件读失败/解析失败 → 异常行（文件名+原因）,不与「空闲/无实例」混同,不得当空闲清理或自动续跑;
 * - 目录读取失败区分 ENOENT（无 .pao 目录＝无实例,如实跳过）与其他错误（不可达≠空,显式上报路径+原因）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { listProjects } from "../dept/projects.ts";
import { controlReport, type FlowControl, readControl, readControlReport } from "../workflow/control.ts";
import {
	type DriveReport,
	type DriverOptions,
	humanGateSuspendReason,
	parseManifest,
	type WorkflowManifest,
} from "../workflow/driver.ts";
import { loadFrozenRecipe } from "../workflow/minister.ts";
import type { WorkflowRecipe } from "../workflow/recipe.ts";

/** 挂起实例行（pano 钻取用路径展开明细,首跑清单只显示名字） */
export interface SuspendedInstanceRow {
	工作流: string;
	项目: string;
	路径: string;
	/** v2 控制正本的实例身份；v1 没有实例 UUID。 */
	实例?: string;
}

/** 单实例共享读取结果：状态扫描和全景详情共用同一版本分流。 */
export interface WorkflowInstanceRecord {
	路径: string;
	版本: 1 | 2;
	工作流: string;
	状态: "运行中" | "挂起" | "已完成";
	清单?: WorkflowManifest;
	控制?: FlowControl;
	报告?: DriveReport;
}

/** 实例异常行：实例文件坏字段/读失败,或目录不可达——显式上报,不与空闲混同 */
export interface InstanceAnomalyRow {
	/** 实例文件（或读失败的目录）绝对路径 */
	路径: string;
	/** 展示用短名（实例文件名或目录名） */
	文件: string;
	原因: string;
}

export interface WorkflowInstanceScan {
	挂起: SuspendedInstanceRow[];
	异常: InstanceAnomalyRow[];
}

/**
 * 实例信号行（S2d 待处理聚合用,2026-10-04 P2）：机械列「停因」字段,不做文案猜测。
 * 与挂起清单的差别:含运行中实例——人工门未确认的 v2 实例在 controlReport 里仍是「运行中」
 * （complete 要求 node.确认 已写）,只扫挂起行会漏掉「为什么停在这里」的头号来源。
 */
export interface InstanceSignalRow {
	路径: string;
	项目: string;
	工作流: string;
	状态: string;
	/** 实例实际使用的卡目录；面板命令面据此定位同名工作流的具体实例。 */
	卡目录?: string;
	/** v2 实例 ID（节点控制工具要求参数 实例 与其一致,建议文案直接给真值） */
	实例?: string;
	/** v2 冻结配方；面板根据实例真相列人工确认节点，不依赖当前 PAO_HOME 配方文件。 */
	配方?: WorkflowRecipe;
	/** v2 控制正本 owner（resume 三件套之一,建议文案直接给真值）;v1 清单无此字段 */
	owner?: string;
	/** 报告节点中挂起原因＝人工门挂起原因的节点（人工门未点头） */
	人工门: { 节点: string; 轮次: number; 卡号?: string }[];
	/** 曾有审核 pass、但共享报告仍挂起的节点；原因直接取共享控制报告，不在状态模块复制版本规则。 */
	nodeHolds: WorkflowNodeHold[];
	/** 控制正本上待裁定的请求（通道 主控/人工 由 control 写） */
	裁定?: { 节点: string; 轮次: number; 理由: string; 通道: "主控" | "人工" };
	/** 控制正本挂起文案（含「回边 … 超限」这类超限停滞） */
	暂停?: string;
	/** 旧版清单挂起:清单无停因字段,只能人工重建后继续 */
	待恢复: boolean;
}

export interface WorkflowInstanceSignalScan {
	实例: InstanceSignalRow[];
	异常: InstanceAnomalyRow[];
}

/** 共享报告里仍有挂起事实、且该轮曾提交审核 pass 的节点。 */
export interface WorkflowNodeHold {
	node: string;
	round: number;
	cardNo?: string;
	status: string;
	hold: string;
}

/** 一个待读取的实例文件位置；项目根供结果页保留原行字段。 */
export interface WorkflowInstanceFile {
	path: string;
	projectName: string;
	projectRoot: string;
}

interface WorkflowInstanceFileScan {
	files: WorkflowInstanceFile[];
	anomalies: InstanceAnomalyRow[];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 读取单个实例文件的真实状态与归属流。任何失败都抛错,由调用方转异常行——不静默。
 * v1/v2 的分流只在这里维护，详情页不要再按浅字段自行猜版本。
 */
type InstanceReadInput = {
	content: string;
	path: string;
	version: 1 | 2;
	cardDir?: string;
	options?: DriverOptions;
	flow?: FlowControl;
};

function readInstanceInput(path: string): InstanceReadInput {
	const content = readFileSync(path, "utf8");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
	if (frontmatter.版本 !== 2) return { content, path, version: 1 };
	const cardDir = frontmatter.卡目录;
	if (typeof cardDir !== "string" || !cardDir) throw new Error("v2 实例缺必要控制字段「卡目录」");
	const options = { cardsDir: cardDir, workspaceDir: dirname(path) };
	const name = basename(path).slice("工作流实例-".length, -".md".length);
	return {
		content,
		path,
		version: 2,
		cardDir,
		options,
		flow: readControl(loadFrozenRecipe(name, options), options),
	};
}

function reportStatus(report: DriveReport): WorkflowInstanceRecord["状态"] {
	return report.status === "completed" ? "已完成" : report.status === "hold" ? "挂起" : "运行中";
}

/**
 * 审核曾通过但当前报告仍挂起的节点；人工门由独立字段处理，避免同一停因重复列出。
 * 是否仍有效只由共享报告判定，状态模块只关联同节点、同轮次的持久审核事实。
 */
export function workflowNodeHolds(flow: FlowControl, report: DriveReport): WorkflowNodeHold[] {
	const reviewedPasses = new Set(
		flow.节点.filter((node) => node.判定?.结果 === "pass").map((node) => `${node.名字}\0${node.轮次}`),
	);
	return report.nodes.flatMap((node) => {
		const round = node.round ?? 0;
		if (
			!reviewedPasses.has(`${node.name}\0${round}`) ||
			node.hold === undefined ||
			node.hold === humanGateSuspendReason
		)
			return [];
		return [
			{
				node: node.name,
				round,
				...(node.card_no === undefined ? {} : { cardNo: node.card_no }),
				status: node.status,
				hold: node.hold,
			},
		];
	});
}

function projectReport(record: WorkflowInstanceRecord, report: DriveReport): WorkflowInstanceRecord {
	return {
		...record,
		状态: reportStatus(report),
		报告: report,
	};
}

/**
 * 同步兼容读面：v2 状态只取持久控制正本，未经当前内容树核对。
 * 真实桌面与状态查询应调用 readWorkflowInstanceFresh。
 */
export function readWorkflowInstance(path: string): WorkflowInstanceRecord {
	const input = readInstanceInput(path);
	if (input.version === 1) {
		const manifest = parseManifest(input.content, path);
		return { 路径: path, 版本: 1, 工作流: manifest.工作流, 状态: manifest.状态, 清单: manifest };
	}
	const flow = input.flow!;
	const report = controlReport(flow);
	return {
		路径: path,
		版本: 2,
		工作流: flow.工作流,
		状态: reportStatus(report),
		控制: flow,
		报告: report,
	};
}

/** 真实状态读面：v2 经共享异步入口核对一次当前内容树。 */
export async function readWorkflowInstanceFresh(
	path: string,
	deadMinisters?: ReadonlySet<string>,
): Promise<WorkflowInstanceRecord> {
	const input = readInstanceInput(path);
	if (input.version === 1) {
		const manifest = parseManifest(input.content, path);
		return { 路径: path, 版本: 1, 工作流: manifest.工作流, 状态: manifest.状态, 清单: manifest };
	}
	const flow = input.flow!;
	const options = input.options!;
	const report = await readControlReport(flow, options, deadMinisters);
	return projectReport({ 路径: path, 版本: 2, 工作流: flow.工作流, 状态: reportStatus(report), 控制: flow }, report);
}

function dirErrorLine(path: string, file: string, error: unknown): InstanceAnomalyRow {
	return { 路径: path, 文件: file, 原因: `目录读取失败:${errorText(error)}` };
}

/**
 * 向下收集实例可能所在的目录（跳过依赖目录），供「.pao 顶层＋一层子目录」以外的深层现场使用：
 * 临时计划的控制正本埋在 `.pao/临时工作流/<计划>/执行/<请求>/`。桌面 `readDesktopFlows` 用同一份
 * 收集器，保证 TUI 与卡片页面对同一个现场给出同一结论（阶段 6 第 5 项）。
 */
export function collectInstanceDirectories(start: string, depth: number): string[] {
	if (depth <= 0) return [];
	let entries: { name: string; isDirectory(): boolean }[];
	try {
		entries = readdirSync(start, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "node_modules") continue;
		const directory = join(start, entry.name);
		out.push(directory, ...collectInstanceDirectories(directory, depth - 1));
	}
	return out;
}

/**
 * 发现各项目 .pao 顶层及其下固定层数的工作流实例文件。
 * 目录不可达与文件位置分开返回；文件内容读取与解析仍由调用方逐项处理。
 */
export function scanWorkflowInstanceFiles(paoHome: string): WorkflowInstanceFileScan {
	const scan: WorkflowInstanceFileScan = { files: [], anomalies: [] };
	for (const row of listProjects(paoHome)) {
		const paoDir = join(row.项目根, ".pao");
		try {
			readdirSync(paoDir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // 无 .pao 目录＝无工作流实例,如实空
			scan.anomalies.push(dirErrorLine(paoDir, `${row.项目名}/.pao`, error));
			continue;
		}
		const candidates = [paoDir, ...collectInstanceDirectories(paoDir, 4)];
		for (const dir of candidates) {
			let files: string[];
			try {
				files = readdirSync(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // 扫描间隙被删,下轮如实反映
				scan.anomalies.push(dirErrorLine(dir, basename(dir), error));
				continue;
			}
			for (const file of files) {
				if (!file.startsWith("工作流实例-") || !file.endsWith(".md")) continue;
				scan.files.push({ path: join(dir, file), projectName: row.项目名, projectRoot: row.项目根 });
			}
		}
	}
	return scan;
}

/** 遍历已发现的工作流实例文件;单个实例的失败按原样进异常行,不中断扫描。 */
function eachInstance(
	paoHome: string,
	exception: InstanceAnomalyRow[],
	visit: (path: string, projectName: string) => void,
): void {
	const scan = scanWorkflowInstanceFiles(paoHome);
	exception.push(...scan.anomalies);
	for (const file of scan.files) {
		try {
			visit(file.path, file.projectName);
		} catch (error) {
			exception.push({ 路径: file.path, 文件: basename(file.path), 原因: errorText(error) });
		}
	}
}

async function eachInstanceFresh(
	paoHome: string,
	exception: InstanceAnomalyRow[],
	visit: (path: string, projectName: string) => Promise<void>,
): Promise<void> {
	const scan = scanWorkflowInstanceFiles(paoHome);
	exception.push(...scan.anomalies);
	for (const file of scan.files) {
		try {
			await visit(file.path, file.projectName);
		} catch (error) {
			exception.push({ 路径: file.path, 文件: basename(file.path), 原因: errorText(error) });
		}
	}
}

/** 同步兼容扫描：v2 使用持久控制正本，未经当前内容树核对；真实状态查询应调用 Fresh。 */
export function scanWorkflowInstances(paoHome: string): WorkflowInstanceScan {
	const scan: WorkflowInstanceScan = { 挂起: [], 异常: [] };
	eachInstance(paoHome, scan.异常, (path, projectName) => {
		const state = readWorkflowInstance(path);
		if (state.状态 === "挂起")
			scan.挂起.push({ 工作流: state.工作流, 项目: projectName, 路径: path, 实例: state.控制?.实例 });
	});
	return scan;
}

/** 真实状态扫描：v2 实例逐项等待共享入口核对当前内容树。 */
export async function scanWorkflowInstancesFresh(paoHome: string): Promise<WorkflowInstanceScan> {
	const scan: WorkflowInstanceScan = { 挂起: [], 异常: [] };
	await eachInstanceFresh(paoHome, scan.异常, async (path, projectName) => {
		const state = await readWorkflowInstanceFresh(path);
		if (state.状态 === "挂起")
			scan.挂起.push({ 工作流: state.工作流, 项目: projectName, 路径: path, 实例: state.控制?.实例 });
	});
	return scan;
}

/** 读单个实例的待处理信号（v2 走控制正本机械字段;v1 只有清单状态可读）。失败抛错,由调用方转异常行。 */
function signalFromRecord(path: string, projectName: string, instance: WorkflowInstanceRecord): InstanceSignalRow {
	if (instance.版本 === 2 && instance.控制 && instance.报告) {
		const flow = instance.控制;
		const report = instance.报告;
		return {
			路径: path,
			项目: projectName,
			工作流: report.workflow,
			状态: instance.状态,
			卡目录: flow.卡目录,
			实例: flow.实例,
			配方: flow.冻结配方,
			owner: flow.owner,
			人工门: report.nodes
				.filter((node) => node.hold === humanGateSuspendReason)
				.map((node) => ({ 节点: node.name, 轮次: node.round ?? 0, 卡号: node.card_no })),
			nodeHolds: workflowNodeHolds(flow, report),
			裁定: flow.裁定,
			暂停: flow.暂停,
			待恢复: false,
		};
	}
	const manifest = instance.清单!;
	return {
		路径: path,
		项目: projectName,
		工作流: manifest.工作流,
		状态: manifest.状态,
		卡目录: manifest.卡目录,
		人工门: [],
		nodeHolds: [],
		待恢复: manifest.状态 === "挂起",
	};
}

function instanceSignal(path: string, projectName: string): InstanceSignalRow {
	return signalFromRecord(path, projectName, readWorkflowInstance(path));
}

/** 扫全部实例的待处理信号（含运行中,供 S2d 待处理聚合用）＋同源异常行。 */
export function scanInstanceSignals(paoHome: string): WorkflowInstanceSignalScan {
	const scan: WorkflowInstanceSignalScan = { 实例: [], 异常: [] };
	eachInstance(paoHome, scan.异常, (path, projectName) => {
		scan.实例.push(instanceSignal(path, projectName));
	});
	return scan;
}

/** 真实信号扫描：每个 v2 实例只核对一次当前内容树。 */
export async function scanInstanceSignalsFresh(paoHome: string): Promise<WorkflowInstanceSignalScan> {
	const scan: WorkflowInstanceSignalScan = { 实例: [], 异常: [] };
	await eachInstanceFresh(paoHome, scan.异常, async (path, projectName) => {
		scan.实例.push(signalFromRecord(path, projectName, await readWorkflowInstanceFresh(path)));
	});
	return scan;
}
