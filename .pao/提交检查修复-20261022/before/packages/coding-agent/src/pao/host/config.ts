import { join } from "node:path";
import { readJsonSafe } from "../shared/json.ts";

/**
 * 保温配置共享读取模块(M2-01 §2/§4,2026-10-02 深夜定案):$PAO_HOME/pao配置/保温.json 是
 * 部长会话保温与监督的唯一配置面。pao_dispatch_card 的部门并发上限(worker/dispatch-core)与本宿主
 * 都从这里读,键语义全仓只有一份。
 *
 * 两类键,缺省语义相反,勿混(§9.3):
 * - 功能键(空闲分钟/轮次提示/调用提示/监督轮次/停滞阈值/循环K):**缺保温文件=不保温**,
 *   功能缺省关(部长会话按需起、用完即散,不内置默认偷偷启用);文件存在但键缺失按机械缺省
 *   (空闲 30/提示 200/2000,开工时按实测校准),监督轮次 0/缺省=该级关。
 * - 护栏键(部门并发上限):配额护栏,文件缺失/键缺失/坏值一律缺省 3 照样生效(安全默认开,
 *   与「缺文件=不保温」的功能语义相反)。
 */

/** 保温配置文件相对 PAO_HOME 的路径(pao_dispatch_card 的部门并发上限同源同文件) */
export const WARM_CONFIG_RELATIVE_PATH = join("pao配置", "保温.json");

/** 保温配置形状:存在=false 时其余键无意义(保温功能全关,护栏走缺省) */
export interface WarmConfig {
	/** 保温.json 是否存在且可解析(缺文件=不保温的功能开关) */
	存在: boolean;
	/** 空闲熔断线(分钟,唯一熔断线);文件存在但缺键按缺省 30 */
	空闲分钟?: number;
	/** 轮次提示线(达标一次性通知＋盘点常驻标记,不杀);缺键按缺省 200 */
	轮次提示?: number;
	/** 工具调用提示线(达标一次性通知＋盘点常驻标记,不杀);缺键按缺省 2000 */
	调用提示?: number;
	/** 工人监督唤醒间隔(累计轮次);0/缺省=该级关 */
	工人监督轮次?: number;
	/** 部门(部长会话)监督唤醒间隔(累计轮次);0/缺省=该级关 */
	部门监督轮次?: number;
	/** 工人监督唤醒间隔(分钟);文件存在时记录原值,独立读取函数负责 15/30 默认 */
	工人监督分钟?: number;
	/** 部门监督唤醒间隔(分钟);文件存在时记录原值,独立读取函数负责 15/30 默认 */
	部门监督分钟?: number;
	/** 活性判据①停滞阈值(分钟);缺键按缺省 15 */
	停滞阈值分钟?: number;
	/** 活性判据②循环检测窗口(最近 K 次调用重复);缺键按缺省 5 */
	循环K?: number;
	/** 部门并发上限(护栏);缺键按缺省 3 */
	部门并发上限?: number;
	/** 上游并发上限(共享额度,M2-03):登记表全部活进程＋在途名额的账号级硬顶,跨部门合并计。
	 *  键缺失=不启用配置层(行为不变——部门层护栏仍默认开;这是「配额已知超卖才显式收紧」
	 *  的功能语义,不是部门护栏那种安全默认开);键值非法同缺失。 */
	上游并发上限?: number;
}

/**
 * toast 通知开关(§23):保温.json「toast 通知」布尔。**缺省开**(键缺失/文件缺失/坏 JSON
 * 均视为开——只有显式 false 才关):与保温功能键「缺文件=不保温」相反,勿混。理由:§23 定位是
 * 后台化的人机契约——无人值守的后台批/人工门静默会漏关键事件,嫌烦是显式动作。
 */
export function toastEnabled(paoHome: string | undefined): boolean {
	if (!paoHome) return true;
	const raw: unknown = readJsonSafe(join(paoHome, WARM_CONFIG_RELATIVE_PATH));
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return true;
	return (raw as Record<string, unknown>)["toast 通知"] !== false;
}

/**
 * worker 静默提醒缺省阈值(分钟):本会话派出的运行中 worker 超过这么久没有任何
 * stdout/stderr 输出,就叫醒上级去看 live 输出并裁决(B 档监督,2026-10-03 用户拍板)。
 */
export const DEFAULT_WORKER_SILENCE_MINUTES = 30;

/** 分层监督的宿主计时默认值:部长查仍在运行的工人,主控查仍有工作的部门。 */
export const DEFAULT_WORKER_SUPERVISION_MINUTES = 15;
export const DEFAULT_DEPARTMENT_SUPERVISION_MINUTES = 30;

/**
 * 分钟监督配置独立读取:文件/键缺失、坏 JSON、非数字或负数都回落默认值;
 * 显式 0 关闭该级监督,正小数向下取整但最小为 1 分钟。
 *
 * 这与旧「轮次监督」是两套兼容口径:分钟监督默认开启,轮次监督仍默认关闭。
 */
function readSupervisionMinutes(paoHome: string | undefined, key: string, fallback: number): number {
	if (!paoHome) return fallback;
	const raw: unknown = readJsonSafe(join(paoHome, WARM_CONFIG_RELATIVE_PATH));
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
	const value = (raw as Record<string, unknown>)[key];
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value === 0) return 0;
	if (value < 0) return fallback;
	return Math.max(1, Math.floor(value));
}

/** 读部长检查仍在运行工人的间隔(分钟);缺省 15,显式 0=关。 */
export function readWorkerSupervisionMinutes(paoHome: string | undefined): number {
	return readSupervisionMinutes(paoHome, "工人监督分钟", DEFAULT_WORKER_SUPERVISION_MINUTES);
}

/** 读主控检查仍有工作部门的间隔(分钟);缺省 30,显式 0=关。 */
export function readDepartmentSupervisionMinutes(paoHome: string | undefined): number {
	return readSupervisionMinutes(paoHome, "部门监督分钟", DEFAULT_DEPARTMENT_SUPERVISION_MINUTES);
}

/**
 * 读 worker 静默提醒阈值(保温.json「worker 静默分钟」)。**缺省开型**(toastEnabled 同款
 * 独立读取函数,不进 WarmConfig 的功能键语义——勿混):键缺失/文件缺失/坏 JSON/非法值一律
 * 缺省 30 生效。理由(用户拍板的监督主判决):派卡非阻塞后,worker 卡死若静默无人知晓,
 * 属关键事件泄漏——监督默认必须在场,嫌烦(调 0)是显式动作;只有显式 0＝关,负数/非数字
 * 按坏值回落缺省(不把配置写错变成监督关闭)。
 */
export function readWorkerSilenceMinutes(paoHome: string | undefined): number {
	if (!paoHome) return DEFAULT_WORKER_SILENCE_MINUTES;
	const raw: unknown = readJsonSafe(join(paoHome, WARM_CONFIG_RELATIVE_PATH));
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_WORKER_SILENCE_MINUTES;
	const value = (raw as Record<string, unknown>)["worker 静默分钟"];
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WORKER_SILENCE_MINUTES;
	if (value <= 0) return value === 0 ? 0 : DEFAULT_WORKER_SILENCE_MINUTES;
	return Math.floor(value);
}

/** 机械缺省(文件存在但键缺失时用);监督轮次无机械缺省(缺键=关,§4「0/缺省＝该级关唤醒」) */
export const WARM_DEFAULTS = {
	空闲分钟: 30,
	轮次提示: 200,
	调用提示: 2000,
	停滞阈值分钟: 15,
	循环K: 5,
} as const;

/** 数值键读取:非负有限数取整(允许 0 的键传 min=0,如监督轮次「0=关」);其余按缺键处理,不猜 */
function positive(value: unknown, min: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.floor(value) : undefined;
}

/**
 * 读保温配置。文件缺失/不可读/坏 JSON/顶层不是对象 → { 存在:false }(不保温,护栏走缺省);
 * 键值非法按缺键处理(不猜不报错——配置坏不改变缺省语义)。
 */
export function readWarmConfig(paoHome: string | undefined): WarmConfig {
	if (!paoHome) return { 存在: false };
	const raw: unknown = readJsonSafe(join(paoHome, WARM_CONFIG_RELATIVE_PATH));
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { 存在: false };
	const obj = raw as Record<string, unknown>;
	return {
		存在: true,
		空闲分钟: positive(obj.空闲分钟, 1),
		轮次提示: positive(obj.轮次提示, 1),
		调用提示: positive(obj.调用提示, 1),
		工人监督轮次: positive(obj.工人监督轮次, 0),
		部门监督轮次: positive(obj.部门监督轮次, 0),
		工人监督分钟: positive(obj.工人监督分钟, 0),
		部门监督分钟: positive(obj.部门监督分钟, 0),
		停滞阈值分钟: positive(obj.停滞阈值分钟, 1),
		循环K: positive(obj.循环K, 1),
		部门并发上限: positive(obj.部门并发上限, 1),
		上游并发上限: positive(obj.上游并发上限, 1),
	};
}
