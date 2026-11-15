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
import { controlReport, readControl } from "../workflow/control.ts";
import { humanGateSuspendReason, parseManifest } from "../workflow/driver.ts";
import { loadFrozenRecipe } from "../workflow/minister.ts";

/** 挂起实例行（pano 钻取用路径展开明细,首跑清单只显示名字） */
export interface SuspendedInstanceRow {
	工作流: string;
	项目: string;
	路径: string;
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
	/** v2 实例 ID（节点控制工具要求参数 实例 与其一致,建议文案直接给真值） */
	实例?: string;
	/** v2 控制正本 owner（resume 三件套之一,建议文案直接给真值）;v1 清单无此字段 */
	owner?: string;
	/** 报告节点中挂起原因＝人工门挂起原因的节点（人工门未点头） */
	人工门: { 节点: string; 轮次: number; 卡号?: string }[];
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 读取单个实例文件的真实状态与归属流。任何失败都抛错,由调用方转异常行——不静默。 */
function instanceState(path: string): { 工作流: string; 状态: string } {
	const content = readFileSync(path, "utf8");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
	if (frontmatter.版本 === 2) {
		// v2 控制正本:与 desktop/workflow.ts 同口径,从冻结配方+控制清单读真实状态,不从浅字段猜
		const cardDir = frontmatter.卡目录;
		if (typeof cardDir !== "string" || !cardDir) throw new Error("v2 实例缺必要控制字段「卡目录」");
		const options = { cardsDir: cardDir, workspaceDir: dirname(path) };
		const name = basename(path).slice("工作流实例-".length, -".md".length);
		const flow = readControl(loadFrozenRecipe(name, options), options);
		return { 工作流: flow.工作流, 状态: flow.状态 };
	}
	const manifest = parseManifest(content);
	return { 工作流: manifest.工作流, 状态: manifest.状态 };
}

function dirErrorLine(path: string, file: string, error: unknown): InstanceAnomalyRow {
	return { 路径: path, 文件: file, 原因: `目录读取失败:${errorText(error)}` };
}

/** 遍历各项目 .pao 顶层＋一层子目录的所有工作流实例文件;单个实例的失败按原样进异常行,不中断扫描。 */
function eachInstance(
	paoHome: string,
	exception: InstanceAnomalyRow[],
	visit: (path: string, projectName: string) => void,
): void {
	for (const row of listProjects(paoHome)) {
		const paoDir = join(row.项目根, ".pao");
		const candidates: string[] = [paoDir];
		try {
			for (const entry of readdirSync(paoDir, { withFileTypes: true })) {
				if (entry.isDirectory()) candidates.push(join(paoDir, entry.name));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // 无 .pao 目录＝无工作流实例,如实空
			exception.push(dirErrorLine(paoDir, `${row.项目名}/.pao`, error));
			continue;
		}
		for (const dir of candidates) {
			let files: string[];
			try {
				files = readdirSync(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // 扫描间隙被删,下轮如实反映
				exception.push(dirErrorLine(dir, basename(dir), error));
				continue;
			}
			for (const file of files) {
				if (!file.startsWith("工作流实例-") || !file.endsWith(".md")) continue;
				const path = join(dir, file);
				try {
					visit(path, row.项目名);
				} catch (error) {
					exception.push({ 路径: path, 文件: file, 原因: errorText(error) });
				}
			}
		}
	}
}

/** 扫各项目 .pao 顶层＋一层子目录的工作流实例:挂起清单＋显式异常（坏字段/读失败/目录不可达）。 */
export function scanWorkflowInstances(paoHome: string): WorkflowInstanceScan {
	const scan: WorkflowInstanceScan = { 挂起: [], 异常: [] };
	eachInstance(paoHome, scan.异常, (path, projectName) => {
		const state = instanceState(path);
		if (state.状态 === "挂起") scan.挂起.push({ 工作流: state.工作流, 项目: projectName, 路径: path });
	});
	return scan;
}

/** 读单个实例的待处理信号（v2 走控制正本机械字段;v1 只有清单状态可读）。失败抛错,由调用方转异常行。 */
function instanceSignal(path: string, projectName: string): InstanceSignalRow {
	const content = readFileSync(path, "utf8");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
	if (frontmatter.版本 === 2) {
		const cardDir = frontmatter.卡目录;
		if (typeof cardDir !== "string" || !cardDir) throw new Error("v2 实例缺必要控制字段「卡目录」");
		const options = { cardsDir: cardDir, workspaceDir: dirname(path) };
		const name = basename(path).slice("工作流实例-".length, -".md".length);
		const flow = readControl(loadFrozenRecipe(name, options), options);
		const report = controlReport(flow);
		return {
			路径: path,
			项目: projectName,
			工作流: report.workflow,
			状态: flow.状态,
			实例: flow.实例,
			owner: flow.owner,
			人工门: report.nodes
				.filter((node) => node.hold === humanGateSuspendReason)
				.map((node) => ({ 节点: node.name, 轮次: node.round ?? 0, 卡号: node.card_no })),
			裁定: flow.裁定,
			暂停: flow.暂停,
			待恢复: false,
		};
	}
	const manifest = parseManifest(content);
	return {
		路径: path,
		项目: projectName,
		工作流: manifest.工作流,
		状态: manifest.状态,
		人工门: [],
		待恢复: manifest.状态 === "挂起",
	};
}

/** 扫全部实例的待处理信号（含运行中,供 S2d 待处理聚合用）＋同源异常行。 */
export function scanInstanceSignals(paoHome: string): WorkflowInstanceSignalScan {
	const scan: WorkflowInstanceSignalScan = { 实例: [], 异常: [] };
	eachInstance(paoHome, scan.异常, (path, projectName) => {
		scan.实例.push(instanceSignal(path, projectName));
	});
	return scan;
}
