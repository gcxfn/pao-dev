/**
 * 桌面 owner 注册表：同进程只读活性的唯一信号源。
 *
 * 主控会话注册后，桌面读投影（read-model）与本模块的 readDesktopWorkerActivity 共用同一份
 * owners；只看本进程内、cwd 等于目标项目的会话，CLI 进程与心跳都不参与。
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { MinisterHandle } from "../host/handle.ts";
import type { ProcessEntry } from "../worker/registry.ts";

/** 桌面 owner 条目：一个会话一份；活性与阈值同源于该会话内核运行器与保温配置。 */
export interface DesktopOwnerEntry {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	getMinisters: () => MinisterHandle[];
	/** 本会话运行器登记表快照（同进程活性信号源；未注入返回空表）。 */
	getWorkerActivity: () => readonly ProcessEntry[];
	/** 静默阈值分钟（保温.json「worker 静默分钟」现读；0=关）。 */
	getSilenceMinutes: () => number;
}

const owners = new Map<string, DesktopOwnerEntry>();

/** 必须由内核主扩展注册；桌面文件扩展不能冒用另一个 ExtensionAPI 的命令闭包。 */
export function registerDesktopOwner(
	pi: ExtensionAPI,
	options: {
		getMinisters?: () => MinisterHandle[];
		getWorkerActivity?: () => readonly ProcessEntry[];
		getSilenceMinutes?: () => number;
	} = {},
): void {
	let id: string | undefined;
	const bind = (_event: unknown, ctx: ExtensionContext) => {
		if (id && owners.get(id)?.pi === pi) owners.delete(id);
		id = ctx.sessionManager.getSessionId();
		owners.set(id, {
			pi,
			ctx,
			getMinisters: options.getMinisters ?? (() => []),
			getWorkerActivity: options.getWorkerActivity ?? (() => []),
			getSilenceMinutes: options.getSilenceMinutes ?? (() => 0),
		});
	};
	pi.on("session_start", bind);
	pi.on("session_tree", bind);
	pi.on("session_shutdown", () => {
		if (id && owners.get(id)?.pi === pi) owners.delete(id);
	});
}

/** 读当前 owner 条目（不校验项目）；供同进程身份比对使用。 */
export function desktopOwnerEntry(sessionId: string): DesktopOwnerEntry | undefined {
	return owners.get(sessionId);
}

/** 已绑定项目语义的 owner 取用：会话、项目任一不符即拒绝，不能重放旧动作。 */
export function desktopOwner(sessionId: string, project: string): DesktopOwnerEntry {
	const current = owners.get(sessionId);
	if (!current || current.ctx.sessionManager.getSessionId() !== sessionId || current.ctx.cwd !== project)
		throw new Error("原会话 owner 不可用或已切换；请回到对应会话重新查看，不能重放旧动作。");
	return current;
}

/** 一条桌面 worker 活性行（只读投影；不含 pid/命令）。 */
export interface DesktopWorkerActivityRow {
	/** 会话（owner）标识 */
	会话: string;
	/** 执行标识（当前尝试的关联键；登记缺失时为空串） */
	执行标识: string;
	/** 卡路径（realpath；项目范围过滤依据） */
	卡路径: string;
	/** 登记表条目的尝试号（-1=未记） */
	尝试: number;
	/** 登记时间（ISO） */
	登记时间: string;
	/** 最近输出时间（ISO；undefined＝登记以来无任何输出） */
	最近输出时间?: string;
	/** 是否仍在运行 */
	运行中: boolean;
	/** 静默阈值（分钟；0=关） */
	静默分钟: number;
	/** 认领租约四字段（S5 包3，运行器事实，桌面 amber 呈现与接管覆盖判定用）；登记缺失时缺省 */
	认领时间?: string;
	租约到期?: string;
	认领代数?: number;
	被接管?: boolean;
}

/**
 * 桌面会话派出的 worker 活性只读投影（同进程）。
 * 只覆盖本进程（桌面主进程）内、且 cwd 等于给定项目的会话；CLI 进程不在内，也不造心跳。
 * 按卡路径落在项目根内过滤；尝试号原样带出，由调用方按卡面尝试判「当前尝试」。
 */
export function readDesktopWorkerActivity(project: string): DesktopWorkerActivityRow[] {
	const root = realpathSync(resolve(project));
	const rows: DesktopWorkerActivityRow[] = [];
	for (const [sessionId, entry] of owners) {
		if (entry.ctx.sessionManager.getSessionId() !== sessionId) continue;
		let ownerRoot: string;
		try {
			ownerRoot = realpathSync(entry.ctx.cwd);
		} catch {
			continue;
		}
		if (ownerRoot !== root) continue;
		const silenceMinutes = entry.getSilenceMinutes();
		for (const item of entry.getWorkerActivity()) {
			if (!item.card_path) continue;
			let cardPath: string;
			try {
				cardPath = realpathSync(item.card_path);
			} catch {
				continue;
			}
			const delta = relative(root, cardPath);
			if (isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`)) continue;
			rows.push({
				会话: sessionId,
				执行标识: item.run_id ?? "",
				卡路径: cardPath,
				尝试: typeof item.attempt === "number" ? item.attempt : -1,
				登记时间: item.登记时间,
				最近输出时间: item.最近输出时间,
				运行中: item.running,
				静默分钟: silenceMinutes,
				// S5 包3 租约四字段原样带出（运行器事实；条目未带则缺省）
				认领时间: item.认领时间,
				租约到期: item.租约到期,
				认领代数: item.认领代数,
				被接管: item.被接管,
			});
		}
	}
	return rows;
}
