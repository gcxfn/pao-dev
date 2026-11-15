/**
 * /pao pano 子命令（原 /全景）:五区一屏纯读聚合＋TUI 钻取循环。
 *
 * 数据源全部复用既有件、不建第二份口径（与 /状态 同纪律）:
 * - 队列区 = cards/render renderAllQueues（/队列 --全部 同源,只读 import）;
 * - 工作流区 = 扫各项目 .pao 顶层＋一层子目录的 工作流实例-*.md（status/workflow-instances 共享扫描,
 *   firstrun 同一口径;v1 parseManifest 严格校验、v2 readControl 读真实状态;坏字段/读失败/目录不可达
 *   显式列「实例异常」,不伪装空闲;只读,不改实例清单）;
 * - 部门区 = dept/panels deptBacklogSnapshot（面板同源,一字不改只读复用）;
 * - 后台区 = fanout 运行态计数（接线层闭包传入,未注册如实「未接入」）＋在途 worker 行
 *   （worker/runner listActive 实时快照）;
 * - 用量区 = usage/ledger formatLedgerSummary（跨会话账聚合,去自身区头后并入）。
 *
 * 交互:构建聚合文本 → sendMessage pao-panorama（一批已注册彩色面板）→ 仅 TUI 运行态
 * （ctx.mode === "tui"）进入 ctx.ui.select 钻取循环:部门行/挂起工作流行/在途 worker 行/
 * 刷新/退出;钻取任一环失败（RPC/json 等无 select）静默跳过,聚合页照发不炸。
 * worker 角色门控在接线层（src/pao/index.ts role !== "worker"）,本模块不重复判。
 */
import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { renderAllQueues } from "../cards/render.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { type DeptBacklogRow, deptBacklogSnapshot } from "../dept/panels.ts";
import type { FanoutBackgroundState } from "../fanout/index.ts";
import { scanWorkflowInstances } from "../status/workflow-instances.ts";
import { aggregateLedger, formatLedgerSummary, parseLedger, readLedgerText } from "../usage/ledger.ts";
import type { WorkerRunner } from "../worker/runner.ts";
import { parseManifest } from "../workflow/driver.ts";
import { showWorkerLivePage } from "./worker-live.ts";

/** /pao pano 注册注入面（接线层传入;全部延迟到调用时解析,缺配置不炸注册） */
export interface PanoramaOptions {
	resolvePaoHome: () => string;
	/** 后台扇出运行态计数(接线层 fanout 闭包);返回 undefined＝fanout 未注册,后台区如实「未接入」 */
	后台计数?: () => FanoutBackgroundState | undefined;
	/** 运行器取口(接线层同一实例);缺省/未返回＝无在途 worker 行 */
	getRunner?: () => WorkerRunner | undefined;
}

/** 命令 handler 的 ctx 最小面(测试注入用;真实 = ExtensionCommandContext) */
interface PanoramaCtx {
	mode?: string;
	ui: {
		select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
		custom?: unknown;
	};
}

/** 后台区 worker 概要（聚合页只报 pid/卡号;实时尾巴在钻取的 worker 实时页里） */
export interface PanoramaWorkerSummary {
	pid: number;
	卡号: string;
	命令: string;
}

export interface PanoramaPageInput {
	paoHome: string;
	后台?: FanoutBackgroundState;
	在途worker?: readonly PanoramaWorkerSummary[];
}

/** 挂起工作流实例(扫法同 status/firstrun,多留路径供钻取展开) */
interface SuspendedWorkflow {
	工作流: string;
	项目: string;
	路径: string;
}

/** 挂起工作流实例（status/workflow-instances 共享扫描;实例异常在聚合页工作流区显式出行,不在钻取清单展开） */
export function findSuspendedWorkflows(paoHome: string): SuspendedWorkflow[] {
	return scanWorkflowInstances(paoHome).挂起;
}

function errorLine(prefix: string, error: unknown): string {
	return `${prefix}读取失败：${error instanceof Error ? error.message : String(error)}`;
}

/** 部门区行（renderDeptPanels 同款格式,面板同源不建第二份口径） */
export function formatDeptRow(row: DeptBacklogRow): string {
	const parts = [`待验证 ${row.待验证} 条`];
	if (row.警示.length > 0) parts.push(`⚠️ ${row.警示.map((f) => `${f.area} ${f.count}`).join("、")}`);
	return `- ${row.部门}:${parts.join("｜")}`;
}

/** 用量区正文:formatLedgerSummary 输出去掉自身「── 用量区」区头后并入（一行口径） */
function usageBody(paoHome: string): string {
	const parsed = parseLedger(readLedgerText(paoHome));
	return formatLedgerSummary(aggregateLedger(parsed.rows), parsed.坏行数)
		.split("\n")
		.filter((line) => !line.startsWith("── 用量区"))
		.join("\n");
}

/**
 * 全景聚合页（纯函数,单测友好）:队列/工作流/部门/后台/用量五区,区与区空行分隔;
 * 各区读失败降级为该区错误行互不拖垮,空态如实「无」。
 */
export function buildPanoramaPage(input: PanoramaPageInput): string {
	const { paoHome } = input;
	const sections: string[] = [];

	// 队列区:各项目卡计数（renderAllQueues 只读复用,不可达项目自带显式标注）
	let queue: string;
	try {
		queue = renderAllQueues(paoHome);
	} catch (error) {
		queue = errorLine("队列", error);
	}
	sections.push(`── 队列 ──\n${queue}`);

	// 工作流区:挂起实例名字列表＋实例异常显式行（status/workflow-instances 共享扫描,坏字段/读失败不伪装空闲）
	let workflow: string;
	try {
		const scan = scanWorkflowInstances(paoHome);
		workflow = [
			scan.挂起.length === 0
				? "挂起工作流:无"
				: `挂起 ${scan.挂起.length}:${scan.挂起.map((s) => `${s.工作流}（${s.项目}）`).join("、")}`,
			...(scan.异常.length > 0
				? [`实例异常 ${scan.异常.length}:${scan.异常.map((a) => `${a.文件}（${a.原因}）`).join("、")}`]
				: []),
		].join("\n");
	} catch (error) {
		workflow = errorLine("工作流", error);
	}
	sections.push(`── 工作流 ──\n${workflow}`);

	// 部门区:积压快照逐行
	let dept: string;
	try {
		const rows = deptBacklogSnapshot(paoHome);
		dept = rows.length === 0 ? "无" : rows.map(formatDeptRow).join("\n");
	} catch (error) {
		dept = errorLine("部门", error);
	}
	sections.push(`── 部门 ──\n${dept}`);

	// 后台区:fanout 运行态计数（三态同 /pao status 口径）＋在途 worker 行
	const backgroundLine =
		input.后台 === undefined
			? "后台扇出:未接入（fanout 模块未注册时无后台扇出面）"
			: input.后台.in_flight === 0 && input.后台.completed_unread === 0
				? "后台扇出:空闲（pao_fanout background:true 受理后此处显示在途与完成未读）"
				: `后台扇出:在途 ${input.后台.in_flight} 批 · 完成未读 ${input.后台.completed_unread} 批（完成摘要下一轮自动注入）`;
	const workers = input.在途worker ?? [];
	const workerLine =
		workers.length === 0
			? "在途 worker:无"
			: `在途 worker ${workers.length}:${workers.map((w) => `pid ${w.pid}${w.卡号 ? ` 卡${w.卡号}` : ""}`).join("、")}`;
	sections.push(`── 后台 ──\n${backgroundLine}\n${workerLine}`);

	// 用量区:跨会话账一行
	let usage: string;
	try {
		usage = usageBody(paoHome);
	} catch (error) {
		usage = errorLine("用量", error);
	}
	sections.push(`── 用量 ──\n${usage}`);

	return sections.join("\n\n");
}

/** 部门明细页:该部门积压快照明细＋该部门在途 worker 行（登记表按部门归属过滤） */
export function buildDeptDetailPage(paoHome: string, dept: string, runner?: WorkerRunner): string {
	const lines: string[] = [`── 部门:${dept} ──`];
	let row: DeptBacklogRow | undefined;
	try {
		row = deptBacklogSnapshot(paoHome).find((r) => r.部门 === dept);
	} catch (error) {
		lines.push(errorLine("部门快照", error));
	}
	lines.push(row ? formatDeptRow(row) : "快照无此部门（未注册或库不可达）——如实显示");
	const workers = (runner?.registry.list() ?? []).filter((entry) => entry.running && entry.dept === dept);
	lines.push("");
	if (workers.length === 0) lines.push("在途 worker:无");
	else {
		lines.push(`在途 worker ${workers.length}:`);
		for (const entry of workers) {
			lines.push(
				`- pid ${entry.pid}${entry.card_no ? ` 卡${entry.card_no}` : ""}${entry.dispatch_reason ? ` · ${entry.dispatch_reason}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

/** 工作流详情页:实例清单 manifest 节点全展开（映射/挂起原因/人工确认;卡状态真相在卡上,此处不读卡） */
export function buildWorkflowDetailPage(manifestPath: string): string {
	try {
		const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
		const lines: string[] = [
			`── 工作流:${manifest.工作流}（${manifest.状态}）──`,
			`启动:${manifest.启动}`,
			`卡目录:${manifest.卡目录}`,
		];
		const params = Object.entries(manifest.参数);
		lines.push(params.length > 0 ? `参数:${params.map(([k, v]) => `${k}=${v}`).join("、")}` : "参数:无");
		lines.push(`节点 ${manifest.节点.length}:`);
		for (const node of manifest.节点) {
			const parts = [node.卡号 !== undefined ? `卡${node.卡号}` : "未落卡"];
			if (node.挂起 !== undefined) parts.push(`挂起:${node.挂起}`);
			if (node.确认 !== undefined) parts.push(`确认:${node.确认}`);
			lines.push(`- ${node.名字}（${parts.join(" · ")}）`);
		}
		return lines.join("\n");
	} catch (error) {
		return errorLine("工作流详情", error);
	}
}

function renderPanoramaPage(pi: ExtensionAPI, options: PanoramaOptions, paoHome: string): void {
	pi.sendMessage({
		customType: "pao-panorama",
		content: [
			{
				type: "text",
				text: buildPanoramaPage({
					paoHome,
					后台: options.后台计数?.(),
					在途worker: options.getRunner?.()?.listActive(),
				}),
			},
		],
		display: true,
	});
}

function renderDetailPage(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: "pao-panorama", content: [{ type: "text", text }], display: true });
}

async function openWorkerPage(ctx: PanoramaCtx, options: PanoramaOptions, pid: number): Promise<void> {
	if (typeof ctx.ui.custom !== "function") {
		ctx.ui.notify?.("当前运行态不支持 worker 实时页（ctx.ui.custom 不可用）", "warning");
		return;
	}
	await showWorkerLivePage(ctx.ui as Parameters<typeof showWorkerLivePage>[0], () =>
		options
			.getRunner?.()
			?.listActive()
			.find((worker) => worker.pid === pid),
	);
}

/** 钻取循环:select 每轮重建（部门/挂起工作流/在途 worker 都随现场刷新）,刷新重建聚合页,退出/失焦即收 */
async function drillLoop(pi: ExtensionAPI, options: PanoramaOptions, ctx: PanoramaCtx, paoHome: string): Promise<void> {
	const select = ctx.ui.select!;
	const refreshLabel = "刷新";
	const exitLabel = "退出";
	for (;;) {
		const workers = options.getRunner?.()?.listActive() ?? [];
		const suspended = findSuspendedWorkflows(paoHome);
		const backlog = deptBacklogSnapshot(paoHome);
		const entries: { label: string; open: () => Promise<void> | void }[] = [
			...backlog.map((row) => ({
				label: `部门:${row.部门}（待验证 ${row.待验证}）`,
				open: () => renderDetailPage(pi, buildDeptDetailPage(paoHome, row.部门, options.getRunner?.())),
			})),
			...suspended.map((flow) => ({
				label: `${flow.工作流}（${flow.项目}）`,
				open: () => renderDetailPage(pi, buildWorkflowDetailPage(flow.路径)),
			})),
			...workers.map((worker) => ({
				label: `worker pid ${worker.pid}${worker.卡号 ? ` · 卡${worker.卡号}` : ""}`,
				open: () => openWorkerPage(ctx, options, worker.pid),
			})),
		];
		const picked = await select("全景钻取", [...entries.map((entry) => entry.label), refreshLabel, exitLabel]);
		if (picked === undefined || picked === exitLabel) return;
		if (picked === refreshLabel) {
			renderPanoramaPage(pi, options, paoHome);
			continue;
		}
		const hit = entries.find((entry) => entry.label === picked);
		if (hit) await hit.open();
	}
}

/** 注册 /pao pano 子命令（原 /全景）:聚合页照发,钻取仅 TUI 运行态（ctx.mode === "tui"）且 select 可用时进入 */
export function registerPanorama(pi: ExtensionAPI, options: PanoramaOptions): void {
	addPaoSubcommand(pi, {
		name: "pano",
		label: "全景",
		description:
			"一屏五区纯读聚合（队列/工作流/部门/后台/用量）＋TUI 钻取：部门明细、挂起工作流清单、在途 worker 实时 stdout 尾巴;数据源与 /pao status /pao queue 同源",
		run: async (pi, _args, ctxRaw: unknown) => {
			const ctx = ctxRaw as PanoramaCtx;
			let paoHome: string;
			try {
				paoHome = options.resolvePaoHome();
			} catch (error) {
				ctx.ui.notify?.(errorLine("全景", error), "error");
				return;
			}
			renderPanoramaPage(pi, options, paoHome);
			if (ctx.mode !== "tui" || typeof ctx.ui?.select !== "function") return;
			try {
				await drillLoop(pi, options, ctx, paoHome);
			} catch {
				// 钻取环境不可用（select/custom 运行期抛错）:聚合页已发出,静默收口不炸会话
			}
		},
	});
}
