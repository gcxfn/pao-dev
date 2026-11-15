import { basename } from "node:path";
import { normalizedProjectRoot } from "../dept/projects.ts";

/**
 * 部长会话句柄与机械判定纯函数(M2-01 设计包 §2/§4)。
 *
 * 绑定 key＝部门名＋项目根(归一化绝对路径),同 key 同时最多一个热会话。
 * MinisterHandle 是宿主内存映射的值:pid、pi 会话标识、配方 sha1、最近事件时间、
 * 累计成本/轮次/工具调用,外加提示线/监督的一次性标记。登记表是内存态,重启即失忆
 * 是有意的(架构 §1 无常驻);崩溃恢复核对属 S3。
 */

/** PAO_DEPT 环境变量名(宿主拉起部长会话时强制注入,同 runner 对 worker 的纪律) */
export const PAO_DEPT_ENV = "PAO_DEPT";

/** 部长会话绑定键:部门名＋项目根 */
export interface BindingKey {
	部门: string;
	项目根: string;
	脉络?: string;
}

/** 绑定键 → 内存映射键(部门 trim;项目根走 归一项目根,Windows 大小写/斜杠不敏感) */
export function bindingKeyValue(key: BindingKey): string {
	return `${key.部门.trim()}\u0000${normalizedProjectRoot(key.项目根)}${key.脉络 ? `\u0000${key.脉络}` : ""}`;
}

/** 项目根 → 项目名(显示用,取 basename,保留原始大小写) */
export function projectName(projectRoot: string): string {
	return basename(projectRoot.replace(/\\/g, "/"));
}

/** 部长会话句柄(宿主持有;保温.json 各阈值的机械判定都从累计与最近事件时间算) */
export interface MinisterHandle {
	脉络?: string;
	pid: number;
	/** pi 会话标识(拉起时经 RPC get_state 握手取得;握手未及回落 rpc-<pid>,响应后再刷新) */
	会话标识: string;
	部门: string;
	/** 项目根(归一化前的原始写法,显示与交接路径都用它) */
	项目根: string;
	/** 配方.md sha1(拉起时登记;主控派卡命中时机械比对,不一致仅提示不自动杀) */
	配方指纹: string | null;
	启动时间: string;
	/** 最近事件时间(ISO):输入三类(新卡/回执验收/主控插话)与子进程事件都刷新它 */
	最近事件时间: string;
	累计: { 轮次: number; 工具调用: number; 成本: number };
	/** 轮次提示线已发(一次性通知标记) */
	轮次提示已发: boolean;
	/** 工具调用提示线已发(一次性通知标记) */
	调用提示已发: boolean;
	/** 上次监督唤醒时的累计轮次(周期唤醒按差值触发) */
	上次监督轮次: number;
	/** 待办标记(如 worker 监督快照无热部长会话可注入时落此,盘点可见) */
	待办标记: string[];
}

/** 活性三判据输入(§4:零新增探针,全部来自句柄累计与事件流已有信息) */
export interface LivenessInput {
	/** 是否在跑(事件流 agent_start/agent_settled 维护) */
	运行中: boolean;
	/** 最近事件时间(毫秒纪元) */
	最近事件毫秒: number;
	/** 当前时刻(毫秒纪元;测试注入钟) */
	当前毫秒: number;
	/** 判据①停滞阈值(分钟) */
	停滞阈值分钟: number;
	/** 最近工具调用名序列(判据②的窗口源) */
	最近工具签名: readonly string[];
	/** 判据②窗口 K */
	循环K: number;
	累计轮次: number;
	累计工具调用: number;
	/** 判据③到顶对照的提示线(未配置则该维度不到顶) */
	轮次提示?: number;
	调用提示?: number;
}

/**
 * 活性三判据(§4,机械标出、不自动杀):
 * ①疑似停滞——运行中且最近事件超阈值;②疑似循环——最近 K 次调用同名重复;
 * ③到顶——累计轮次/工具调用达提示线(提示线的盘点常驻标记由此承载)。
 */
export function assessLiveness(input: LivenessInput): string[] {
	const mark: string[] = [];
	if (input.运行中 && input.当前毫秒 - input.最近事件毫秒 >= input.停滞阈值分钟 * 60_000) {
		mark.push(`疑似停滞(运行中且最近事件超 ${input.停滞阈值分钟} 分钟)`);
	}
	const k = input.循环K;
	if (k > 0 && input.最近工具签名.length >= k) {
		const tailWindow = input.最近工具签名.slice(-k);
		if (tailWindow.every((signature) => signature === tailWindow[0]))
			mark.push(`疑似循环(最近 ${k} 次调用同为 ${tailWindow[0]})`);
	}
	if (
		(input.轮次提示 !== undefined && input.累计轮次 >= input.轮次提示) ||
		(input.调用提示 !== undefined && input.累计工具调用 >= input.调用提示)
	) {
		mark.push("到顶(达提示线)");
	}
	return mark;
}

/** 监督快照(§4 机械摘要,非全量转写):轮次/调用/成本行＋活性三判据标记＋最近输出标题 */
export function renderSupervisionSnapshot(input: {
	/** 被监督者描述行,如「部长会话〔前端@pao〕(pid 123)」或「worker 卡0007」 */
	被监督者: string;
	轮次: number;
	工具调用: number;
	成本: number;
	活性: readonly string[];
	/** 最近输出/回执标题(首行) */
	最近输出?: string;
	/** 缺用量轮次(R07:未知不当零,快照如实标注) */
	缺用量轮次?: number;
}): string {
	const line = [
		`[监督快照] ${input.被监督者}:轮次 ${input.轮次}｜工具调用 ${input.工具调用}｜成本 ${Math.round(input.成本 * 1e6) / 1e6}`,
	];
	if (input.缺用量轮次 && input.缺用量轮次 > 0) line.push(`缺用量 ${input.缺用量轮次} 轮(合计为已知下界,不填零)`);
	line.push(`活性:${input.活性.length > 0 ? input.活性.join("；") : "无异常标记"}`);
	if (input.最近输出) line.push(`最近输出:${input.最近输出.split("\n")[0].slice(0, 200)}`);
	line.push("(机械摘要,被监督者不暂停;是否干涉由上级裁决)");
	return line.join("\n");
}

/** 盘点视图的一行(定案11:pid/最近事件/轮次/调用/指纹/活性标记) */
export interface MinisterInventoryLine {
	pid: number;
	会话标识: string;
	部门: string;
	项目名: string;
	轮次: number;
	工具调用: number;
	成本: number;
	配方指纹: string | null;
	最近事件时间: string;
	活性: readonly string[];
	待办标记: readonly string[];
}

/** 盘点部长会话行渲染(纯函数;指纹只展示前 8 位,全指纹不进盘点面) */
export function renderMinisterInventoryLine(row: MinisterInventoryLine): string {
	const fingerprint = row.配方指纹 ? row.配方指纹.slice(0, 8) : "无配方";
	const time = row.最近事件时间.slice(0, 19).replace("T", " ");
	const parts = [
		`pid=${row.pid}`,
		`${row.部门}@${row.项目名}`,
		`会话=${row.会话标识}`,
		`轮次 ${row.轮次}/调用 ${row.工具调用}/成本 ${row.成本}`,
		`指纹 ${fingerprint}`,
		`最近事件 ${time}`,
	];
	const line = `  · ${parts.join("｜")}${row.活性.length > 0 ? `｜活性:${row.活性.join("；")}` : ""}`;
	const todo = row.待办标记.map((mark) => `    [待办] ${mark}`);
	return [line, ...todo].join("\n");
}

/** 全局热会话观测口径:超过只提示不拒(§2 降为观测项,硬闸在单 key 单会话＋三线保险丝) */
export const globalHotSessionLimit = 8;
