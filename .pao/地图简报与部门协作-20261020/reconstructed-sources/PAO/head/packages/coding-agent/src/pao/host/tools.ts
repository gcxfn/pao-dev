/**
 * 宿主接线层(M2-01 S2 收口):pao_spawn_minister/pao_dismiss_minister(主控专有——星型纪律,
 * 主控是唯一唤醒源,部长/worker 会话不注册本模块)＋主控通知面＋保险丝事件边界钩子。
 *
 * 通知面:接管 MinisterHost 的提示线/监督快照通知(缺省 stderr),积进环形缓冲,
 * before_agent_start 时渲染成系统提示 section——主控下一次请求必然看见(dept 注册表
 * 快照同款机制)。空闲保险丝核对也挂在 before_agent_start(主控请求边界=事件边界,
 * 不承诺准点;散场记录同样进通知)。
 */
import { Type } from "typebox";

import type { ExtensionAPI, ToolDefinition } from "../../core/extensions/types.ts";
import { SESSION_BUDGET_ENV } from "../worker/budget.ts";
import type { MinisterHost } from "./host.ts";
import { defaultMinisterHost } from "./index.ts";

/** 通知 section 名(before_agent_start 系统提示;无通知时整个 section 不渲染,零噪音) */
export const HOST_NOTICE_SECTION = "pao-host-notice";

/** 通知缓冲上限(提示线一次性×会话数＋监督快照周期,8 条够回看;新在下) */
const notifyLimit = 8;

export interface RegisterHostToolsOptions {
	/** 宿主实例;缺省 defaultMinisterHost(与 pao_dispatch_card 的交接指针/盘点同一实例) */
	host?: MinisterHost;
	/** 通知时间戳时钟(测试注入);缺省系统时钟 */
	时钟?: () => Date;
	resolveContext?: () => string | undefined;
}

function shortTime(now: Date): string {
	return now.toISOString().slice(11, 19);
}

export function registerHostTools(pi: ExtensionAPI, options: RegisterHostToolsOptions = {}): void {
	const host = options.host ?? defaultMinisterHost;
	const clock = options.时钟 ?? (() => new Date());
	const notices: string[] = [];
	const recordNotice = (text: string): void => {
		notices.push(`${shortTime(clock())} ${text}`);
		if (notices.length > notifyLimit) notices.splice(0, notices.length - notifyLimit);
	};
	host.receiveNotice(recordNotice);

	pi.on("before_agent_start", (event) => {
		// 空闲保险丝:主控请求边界核对(异步看,散场记录进通知面;失败不阻断请求)
		void host
			.checkFuse()
			.then((records) => {
				for (const r of records) {
					recordNotice(
						`散场:${r.部门}@${r.项目根}(pid ${r.pid})——${r.原因}${r.交接失败 ? `;交接落盘失败:${r.交接失败}` : ""}`,
					);
				}
			})
			.catch(() => {});
		if (notices.length > 0) {
			event.systemPromptOptions.sections[HOST_NOTICE_SECTION] =
				`[pao 宿主]最近通知(新在下,供主控监督与干涉决策):\n${notices.join("\n")}`;
		}
		return undefined;
	});

	pi.registerTool(buildRaiseTool(host, options.resolveContext));
	pi.registerTool(buildDismissTool(host, options.resolveContext));
}

const RaiseSchema = Type.Object({
	dept: Type.String({ description: "部门名(绑定 key 一半,同时是 PAO_DEPT 注入值;须在部门/注册表.md)" }),
	project_root: Type.Optional(Type.String({ description: "项目根(绑定 key 另一半,归一化绝对路径);缺省当前工作目录" })),
	reason: Type.String({
		description: "为什么需要热部长会话(留痕口径同 pao_dispatch_card:空洞理由是干涉信号,须先自省真的需要吗)",
	}),
	first_message: Type.Optional(
		Type.String({ description: "拉起后立即注入的第一条输入(新卡通知/任务指令);已有热会话时也照注入" }),
	),
	budget: Type.Optional(
		Type.Object({
			turns: Type.Optional(
				Type.Number({
					description:
						"轮次上限——到线先催回执一次(预算内唯一提醒:只许交回执/输出结论),再犯即停。整个预算对象:注入后子会话三口执行前检查(turns/cost/工具次数);已有热会话时忽略,预算只在拉起时注入",
				}),
			),
			toolCalls: Type.Optional(Type.Number({ description: "工具调用次数上限" })),
			cost: Type.Optional(Type.Number({ description: "金额上限(依据已返回费用;缺用量轮次按保守计)" })),
		}),
	),
});

const DismissSchema = Type.Object({
	dept: Type.String({ description: "部门名(与拉起时一致)" }),
	project_root: Type.Optional(Type.String({ description: "项目根(与拉起时一致);缺省当前工作目录" })),
	cause: Type.Optional(Type.String({ description: "散场原因(写进散场记录);缺省「主控显式散场」" })),
});

function buildRaiseTool(
	host: MinisterHost,
	resolveContext?: () => string | undefined,
): ToolDefinition<typeof RaiseSchema> {
	return {
		name: "pao_spawn_minister",
		label: "拉起部长会话",
		description:
			"拉起(或命中)一个部门×项目的热部长会话(RPC 常驻子进程,env 强制 PAO_ROLE=部长+PAO_DEPT)。同 部门+项目根 同时最多一个热会话,已有则直接返回既有句柄。保温.json 缺失时不保温(无空闲熔断/提示线/监督,仅手动散场与主会话关闭全停)。拉起后用 pao_inventory 看部长会话行;派卡到同部门+项目时交接页指针自动附进信封。",
		parameters: RaiseSchema,
		async execute(_id, params) {
			const dept = params.dept?.trim() ?? "";
			const rationale = params.reason?.trim() ?? "";
			if (!dept) return errorReply("拉起未执行:dept 必填");
			if (!rationale) return errorReply("拉起未执行:reason 必填(空洞理由是干涉信号——先自省:真的需要热部长会话吗)");
			const projectRoot = params.project_root?.trim() || process.cwd();
			const started = await host.spawn({
				部门: dept,
				项目根: projectRoot,
				脉络: resolveContext?.(),
				// 预算经宿主 env passthrough 注入(通用名),host.ts 内部 env 强制键在 spread 之后,角色不可被预算覆盖
				...(params.budget ? { 环境变量: { [SESSION_BUDGET_ENV]: JSON.stringify(params.budget) } } : {}),
			});
			if (!started.ok) return errorReply(`拉起未执行:${started.原因}`);
			const h = started.handle;
			const lines = [
				started.已有热会话
					? `已有热会话,直接复用(不双开):${h.部门}(pid ${h.pid},会话 ${h.会话标识})`
					: `已拉起:${h.部门}(pid ${h.pid},会话 ${h.会话标识})`,
				`项目根 ${h.项目根};配方指纹 ${h.配方指纹 ? h.配方指纹.slice(0, 8) : "无配方(PAO_HOME 未设或配方缺失)"};理由「${rationale}」已留痕`,
				...(params.budget && !started.已有热会话
					? [
							`已注入预算:turns ${params.budget.turns ?? "∞"}/toolCalls ${params.budget.toolCalls ?? "∞"}/cost ${params.budget.cost ?? "∞"}(到线先催回执一次)`,
						]
					: params.budget
						? ["预算未注入:已有热会话沿用其原预算(预算只在拉起时生效)"]
						: []),
				"监督面:pao_inventory 列部长会话行;保温.json 缺失时无空闲熔断,不用时建议 pao_dismiss_minister。",
			];
			if (params.first_message?.trim()) {
				const inject = host.inject(dept, h.项目根, params.first_message.trim(), resolveContext?.());
				lines.push(inject.ok ? "首条消息已注入。" : `首条消息注入失败:${inject.原因}`);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { pid: h.pid } };
		},
	};
}

function buildDismissTool(
	host: MinisterHost,
	resolveContext?: () => string | undefined,
): ToolDefinition<typeof DismissSchema> {
	return {
		name: "pao_dismiss_minister",
		label: "散场部长会话",
		description:
			"显式散场一个热部长会话(主控干涉/用完即散):先落短交接页(部门/<名>/交接/,失败如实通知不阻断)→树杀进程→登记表摘除。与空闲熔断同款散场语义,但不要求空闲。",
		parameters: DismissSchema,
		async execute(_id, params) {
			const dept = params.dept?.trim() ?? "";
			if (!dept) return errorReply("散场未执行:dept 必填");
			const projectRoot = params.project_root?.trim() || process.cwd();
			const record = await host.teardown(
				dept,
				projectRoot,
				params.cause?.trim() || "主控显式散场",
				resolveContext?.(),
			);
			if (!record) {
				return errorReply(`散场未执行:无热部长会话(部门「${dept}」项目 ${projectRoot})`);
			}
			const lines = [
				`已散场:${record.部门}(pid ${record.pid})——${record.原因}`,
				record.交接路径 ? `交接页已落:${record.交接路径}` : "交接页未落(无 PAO_HOME)",
				record.交接失败 ? `交接落盘失败:${record.交接失败}(交接文件为旧货)` : "",
			].filter(Boolean);
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { pid: record.pid } };
		},
	};
}

function errorReply(text: string): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, never>;
	isError: boolean;
} {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}
