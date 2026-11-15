/**
 * §21 /pao status 仪表盘——任务＋部门（先行区）＋用量（M2-04 尾接入）。
 *
 * 一屏纯读总览：数据源全部复用既有件（renderAllQueues＝/队列 --全部 同源、
 * renderDeptPanels＝/队列 部门面板同源），只做聚合渲染,不新造数据、不进系统提示。
 * 一个命令一个数据出口：首跑清单（§16.1）与 M3 桌面壳复用同一出口。
 *
 * 未做区如实标注不冒充：后台区已接入(§20 fanout 运行态计数,R25 重启归零)、
 * 值守区随 §16.2 桌面在场调度（M3,§16.1 首跑清单已落 status/firstrun.ts）,页脚一行说明。
 * 用量区已随 M2-04 尾接入（用量账.jsonl 跨会话聚合）。
 * worker 不装（role.ts 跳过清单——/队列 同款口径）。
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { renderAllQueues } from "../cards/render.ts";
import { addPaoSubcommand } from "../command-router.ts";
import type { FanoutBackgroundState } from "../fanout/index.ts";
import { renderDeptPanels } from "../index.ts";
import { aggregateLedger, formatLedgerSummary, parseLedger, readLedgerText } from "../usage/ledger.ts";

/** /状态 状态注册的注入面（测试/宿主覆盖） */
export interface StatusCommandOptions {
	resolvePaoHome: () => string;
	/** 后台扇出运行态计数快照(接线层传入);返回 undefined＝fanout 未注册,后台区如实显示未接入 */
	后台计数?: () => FanoutBackgroundState | undefined;
}

/**
 * 渲染 /状态 全文（纯读,不落盘）：任务区（各项目卡计数,不可达显式标注）＋部门区
 * （待验证积压＋⚠️）＋用量区（跨会话账聚合）＋后台区（§20 运行态计数）＋值守区说明。
 * 任一区读失败降级为该区错误行,不拖垮另一区。
 */
export async function renderStatusPage(paoHome: string, background?: FanoutBackgroundState): Promise<string> {
	const sections: string[] = [];
	try {
		sections.push(`── 任务区（各项目卡计数；就绪未派高亮见 /队列 的 [就绪] 标记）──\n${renderAllQueues(paoHome)}`);
	} catch (error) {
		sections.push(`── 任务区读取失败：${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const panels = await renderDeptPanels(paoHome);
		sections.push(
			panels.length > 0
				? `── 部门区（知识库待验证与 ⚠️）──\n${panels.join("\n\n")}`
				: "── 部门区 ──\n尚无部门注册（pao_create_dept 后此处显示各部门库待验证与 ⚠️）",
		);
	} catch (error) {
		sections.push(`── 部门区读取失败：${error instanceof Error ? error.message : String(error)}`);
	}
	// 用量区(§15 跨会话账,2026-10-03 M2-04 尾接入):读 用量账.jsonl 纯聚合——会话/角色/轮次/成本,
	// 缺账会话与坏行如实标注(R07);尚无账＝如实空态。每轮 footer 仍是会话内账,两口径不混。
	try {
		const parsed = parseLedger(readLedgerText(paoHome));
		sections.push(formatLedgerSummary(aggregateLedger(parsed.rows), parsed.坏行数));
	} catch (error) {
		sections.push(`── 用量区读取失败：${error instanceof Error ? error.message : String(error)}`);
	}
	// 后台区(§21,2026-10-03 接入):fanout 会话级运行态计数——在途(已受理未 settle)/完成未读(待注入摘要)。
	// R25 运行态语义如实标注:重启归零、真相以卡文件为准;fanout 未注册(被跳过/未接线)＝如实显示未接入。
	// 二批图形化:行首状态符号 在途◉/空闲○/未接入◌(「后台扇出:」起的后文子串原样保留)。
	const backgroundLine =
		background === undefined
			? "◌ 后台扇出:未接入（fanout 模块未注册时无后台扇出面）"
			: background.in_flight === 0 && background.completed_unread === 0
				? "○ 后台扇出:空闲（pao_fanout background:true 受理后此处显示在途与完成未读）"
				: `◉ 后台扇出:在途 ${background.in_flight} 批 · 完成未读 ${background.completed_unread} 批（完成摘要下一轮自动注入）`;
	sections.push(
		`── 后台/值守区 ──\n${backgroundLine}（运行态计数,重启归零——真相以卡文件为准 R25）\n值守区:随 §16.2 桌面在场调度（M3）;§16.1 首跑清单已落地（session_start 今日待办）。`,
	);
	return sections.join("\n\n");
}

/** 注册 /pao status 子命令（原 /状态；主控/部长——worker 由 role.ts 跳过清单门控不注册）。 */
export function registerStatusCommand(pi: ExtensionAPI, options: StatusCommandOptions): void {
	addPaoSubcommand(pi, {
		name: "status",
		label: "状态",
		description:
			"一屏纯读总览（§21）：各项目卡计数＋部门知识库积压＋跨会话用量账＋后台扇出运行态计数；数据源与 /pao queue 同源,不新造数据",
		run: async (pi) => {
			let text: string;
			try {
				text = await renderStatusPage(options.resolvePaoHome(), options.后台计数?.());
			} catch (error) {
				text = `/pao status 读取失败：${error instanceof Error ? error.message : String(error)}`;
			}
			pi.sendMessage({ customType: "pao-status", content: [{ type: "text", text }], display: true });
		},
	});
}
