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

/** 登记时注入的读数来源；三项都缺省为空表/零值，不影响本模块只读语义。 */
interface RegistrationOptions {
	getMinisters?: () => MinisterHandle[];
	getWorkerActivity?: () => readonly ProcessEntry[];
	getSilenceMinutes?: () => number;
}

const owners = new Map<string, DesktopOwnerEntry>();

/**
 * 每个 ExtensionAPI 登记过的会话 id 集合。
 *
 * 用 WeakMap：不持有 pi 的强引用（宿主丢弃 pi 后集合随之回收），也不会跨 pi 串号。
 * 这里只记「这个 pi 名下有哪些会话」，不记别的 pi 的 id——一次登记一个宿主，互不干扰。
 */
const piSessions = new WeakMap<ExtensionAPI, Set<string>>();

/** 取（必要时创建）某个 pi 的会话 id 集合。 */
function sessionsOf(pi: ExtensionAPI): Set<string> {
	let sessions = piSessions.get(pi);
	if (!sessions) {
		sessions = new Set<string>();
		piSessions.set(pi, sessions);
	}
	return sessions;
}

/** 把某会话的 owner 条目写进 owners，并把该会话 id 记进本 pi 的集合。 */
function remember(pi: ExtensionAPI, ctx: ExtensionContext, sessionId: string, options: RegistrationOptions): void {
	owners.set(sessionId, {
		pi,
		ctx,
		getMinisters: options.getMinisters ?? (() => []),
		getWorkerActivity: options.getWorkerActivity ?? (() => []),
		getSilenceMinutes: options.getSilenceMinutes ?? (() => 0),
	});
	sessionsOf(pi).add(sessionId);
}

/** 只删「这个 id 确实属于这个 pi」的条目，别人的会话一条都不碰。 */
function forget(pi: ExtensionAPI, sessionId: string): void {
	const sessions = piSessions.get(pi);
	if (!sessions) return;
	sessions.delete(sessionId);
	if (owners.get(sessionId)?.pi === pi) owners.delete(sessionId);
}

/** 必须由内核主扩展注册；桌面文件扩展不能冒用另一个 ExtensionAPI 的命令闭包。 */
export function registerDesktopOwner(pi: ExtensionAPI, options: RegistrationOptions = {}): void {
	const bind = (_event: unknown, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		remember(pi, ctx, sessionId, options);
	};
	pi.on("session_start", bind);
	// session_tree 是「同一会话换分支」：sessionId 通常不变，此时 remember 就是一次原地刷新。
	// 换分支不会让**另一个独立会话**失效，所以这里一个别的 id 都不碰——
	// 谁真的结束了，由它自己的 session_shutdown 报上来（见下），不由别人替它猜。
	pi.on("session_tree", bind);
	// 关闭只清当前 ctx 这一个会话：不读闭包里的任何可变变量，避免「关 B 把 A 也删了」。
	pi.on("session_shutdown", (event, ctx: ExtensionContext) => {
		const cleanup = () => forget(pi, ctx.sessionManager.getSessionId());
		if (event.onConfirmedShutdown) event.onConfirmedShutdown(cleanup);
		else cleanup();
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
