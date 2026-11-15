/**
 * 巡库 shell 护栏接线（需求 §6 预案①；M2-05 巡库无人值守上线硬前置的第二道防线）。
 *
 * 装法：派发链对巡库卡注入 PAO_SHELL_GUARD_WORKSPACE（锁定工作区，dispatch-core
 * buildDispatchRunOptions 检测巡库目标时设置、runner 转进子进程 env）；本模块在 pao
 * 扩展顶层注册（不进任何被角色跳过的模块，主控/部长/worker 三角色同装——仿用量页脚
 * 先例），读到该 env 才挂钩子，未设时零行为（有人盯的日常派发不受影响）。
 * 子进程里 worker 会话的 bash/powershell 工具调用先过 审查Shell命令（shell-guard.ts
 * 纯函数），不放行即 block，拒因带护栏口径。
 *
 * 诚实边界（与 shell-guard.ts 声明一致）：这是机械筛不是沙箱；只门 bash/powershell
 * 两类 shell 工具（read/grep 等只读工具与 MCP 工具不在本防线，靠第一道防线＝配方
 * 工具白名单兜底）；常见套壳（bash -c / cmd /c / powershell -Command / env / wsl 等）
 * 已由护栏拆壳递归再审，表外壳与求值花活等剩余绕过面见 shell-guard 头注释。
 */
import type { ExtensionAPI, ToolCallEvent } from "../../core/extensions/types.ts";
import { reviewShellCommand, type ShellGuardConfig, type SystemDirTable } from "./shell-guard.ts";

/** 锁定工作区 env 名（dispatch-core/runner 注入，本模块读取） */
export const SHELL_GUARD_ENV = "PAO_SHELL_GUARD_WORKSPACE";

export interface RegisterShellGuardOptions {
	/** env 源（测试注入）；缺省 process.env */
	env?: NodeJS.ProcessEnv;
	/** 工作区直供（测试注入，优先于 env）；须绝对路径 */
	工作区?: string;
	/** 系统目录表覆写（测试注入）；缺省用 shell-guard 机械缺省表 */
	系统目录表?: SystemDirTable;
}

/**
 * 注册巡库 shell 护栏钩子。返回是否已装（env 与直供都缺 → 不装，零行为）。
 * 装上后 bash/powershell 的每次 tool_call 都过审：不放行即 block，reason 带拒因
 * （模型可见，是它修正命令或如实交回执的依据）。
 */
export function registerShellGuard(pi: ExtensionAPI, options: RegisterShellGuardOptions = {}): boolean {
	const env = options.env ?? process.env;
	const workspaceDir = options.工作区 ?? env[SHELL_GUARD_ENV]?.trim();
	if (!workspaceDir) return false;
	const guardConfig: ShellGuardConfig = { 工作区: workspaceDir, 系统目录: options.系统目录表 ?? {} };
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		// CustomToolCallEvent 的 toolName 是 string 联合成员,窄化不净,取参前自证形状
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		const verdict = reviewShellCommand(command, guardConfig);
		if (verdict.放行) return undefined;
		return {
			block: true,
			reason: `[pao 巡库护栏] 命令被拒（${verdict.类型 ?? "未分类"}，fail-closed）：${verdict.说明 ?? "未给出说明"}`,
		};
	});
	return true;
}
