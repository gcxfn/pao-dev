/**
 * worker 静默扫描与提醒(T04 自 worker/index.ts 拆出,B 档监督核心):
 * 卡死由「静默→叫醒上级去看输出→上级裁决」处理,机械杀只做最后底线。
 * 静默判据 = now −(最近输出时间 ?? 登记时间)> 静默分钟×60_000,信号源是 runner
 * 登记表的 最近输出时间(stdout/stderr 任一 chunk 到达即刷新,registry.markOutput)。
 */

import { DEFAULT_WORKER_SILENCE_MINUTES } from "../host/config.ts";
import { logWarn } from "../shared/log.ts";
import type { ProcessEntry } from "./registry.ts";
import type { WorkerRunner } from "./runner.ts";

/** 静默扫描缺省周期(毫秒)。理由:静默阈值以分钟计,20s 的检测延迟相对可忽略;
 * 扫描成本是登记表一次线性遍历,同样可忽略。测试经 createSilenceReminder 注入
 * 更短周期与伪时钟,不在生产路径上做任何特殊分支。 */
export const DEFAULT_SILENCE_SCAN_INTERVAL_MS = 20_000;

/** 一条静默提醒事项:静默计算与呈现文本分离,扫描纯函数可离线钉行为 */
export interface SilenceReminder {
	cardNo: string;
	silentMs: number;
	/** live 输出绝对路径(上级可直接读取;live 打开失败时缺省) */
	outputPath?: string;
	stderrPath?: string;
	outputTail: string;
}

/**
 * 扫一遍运行中条目,返回需要提醒的静默事项(纯函数)。
 * 去重红线(每静默期只提醒一次):提醒基线按执行标识记录「上次提醒时所依据的活性时间」——
 * 有新输出(最近输出时间刷新)即基线前移,旧记录自然失配;再静默超阈值才再次提醒。
 * 纯内存会话级去重即可(提醒器本就活在会话进程里,R25 运行态重启归零)。
 */
export function scanSilence(input: {
	entries: readonly ProcessEntry[];
	active: ReturnType<WorkerRunner["listActive"]>;
	now: number;
	/** 静默阈值(分钟);≤0 = 关(显式 0 是用户关掉监督的开关) */
	silenceMinutes: number;
	/** 会话级去重基线(调用方持有并复用;本函数按需写入) */
	remindedBaselines: Map<string, number>;
}): SilenceReminder[] {
	if (input.silenceMinutes <= 0) return [];
	const thresholdMs = input.silenceMinutes * 60_000;
	const reminders: SilenceReminder[] = [];
	for (const active of input.active) {
		const key = active.执行标识 || `pid:${active.pid}`;
		const entry = input.entries.find(
			(candidate) =>
				candidate.running &&
				(active.执行标识 ? candidate.run_id === active.执行标识 : candidate.pid === active.pid),
		);
		if (!entry) continue;
		const baseline = Date.parse(entry.最近输出时间 ?? entry.登记时间);
		if (!Number.isFinite(baseline)) continue;
		const silentMs = input.now - baseline;
		if (silentMs <= thresholdMs) continue;
		if (input.remindedBaselines.get(key) === baseline) continue; // 同一静默期已提醒过,不重弹
		input.remindedBaselines.set(key, baseline);
		reminders.push({
			cardNo: active.卡号,
			silentMs,
			outputPath: active.中途输出路径,
			stderrPath: active.中途stderr路径,
			outputTail: active.stdoutTail(5),
		});
	}
	return reminders;
}

/** 静默毫秒 → 展示分钟数(下限 1:不足一分钟也按 1 分钟报,正文与 toast 同口径) */
const silentMinutes = (silentMs: number): number => Math.max(1, Math.floor(silentMs / 60_000));

/** 静默事项 → 上级可裁决的文本:卡号/静默时长/live 路径/输出尾/裁决指引,一样不缺 */
export function formatSilenceReminder(reminder: SilenceReminder): string {
	const minutes = silentMinutes(reminder.silentMs);
	const lines = [
		`[静默提醒] 卡${reminder.cardNo} 已静默 ${minutes} 分钟(无任何 stdout/stderr 输出;阈值＝保温.json「worker 静默分钟」,缺省 ${DEFAULT_WORKER_SILENCE_MINUTES},显式 0=关)。`,
	];
	if (reminder.outputPath) lines.push(`- live 输出(可直接读取):${reminder.outputPath}`);
	if (reminder.stderrPath) lines.push(`- live stderr:${reminder.stderrPath}`);
	const tail = reminder.outputTail.trim();
	lines.push(
		tail
			? `- 输出末几行:\n${tail
					.split("\n")
					.map((line) => `  ${line}`)
					.join("\n")}`
			: "- 输出末几行:(无)",
	);
	lines.push(
		"- 裁决:继续等＝不用做任何事(有输出后计时自动重置);确认卡死须终止＝调 pao_terminate_card(只终止本会话派出的运行中 worker)。",
	);
	return lines.join("\n");
}

/**
 * 会话级静默提醒器:周期扫描本会话 runner 的运行中条目,静默即叫人(通知缓冲＋toast)。
 * 扫描与提醒解耦:scan() 可被测试直驱(伪时钟经 now 注入),生产用缺省 20s 周期的
 * interval(timer unref,不托住进程退出;会话关闭经 stop() 清理)。
 */
export function createSilenceReminder(input: {
	runner: WorkerRunner;
	/** 每次扫描现读(保温.json 可运行期改;坏配置回落缺省 30,监督不因配置坏而失效) */
	readSilenceMinutes: () => number;
	/** 提醒动作:进通知缓冲(下一轮 before_agent_start 注入)＋发 toast */
	notify: (body: string, toastBody: string) => void;
	intervalMs?: number;
	/** 时钟(测试注入伪时钟);缺省 Date.now */
	now?: () => number;
}): { stop: () => void; scan: () => void } {
	const remindedBaselines = new Map<string, number>();
	const now = input.now ?? Date.now;
	let lastErrorText: string | undefined;
	const scan = (): void => {
		try {
			const reminders = scanSilence({
				entries: input.runner.registry.list(),
				active: input.runner.listActive(),
				now: now(),
				silenceMinutes: input.readSilenceMinutes(),
				remindedBaselines,
			});
			for (const reminder of reminders) {
				input.notify(
					formatSilenceReminder(reminder),
					`卡${reminder.cardNo} 已静默 ${silentMinutes(reminder.silentMs)} 分钟;请读 live 输出并裁决(继续等或 pao_terminate_card)`,
				);
			}
			lastErrorText = undefined;
		} catch (error) {
			// 周期回调隔离:单轮扫描失败跳过本轮、下一轮重试,同一错误只 warn 一次防刷屏。
			// 扫描跑在 setInterval 里,放任异常直冲宿主(如桌面 Electron 主进程)即未捕获崩溃弹窗。
			const text = error instanceof Error ? error.message : String(error);
			if (text !== lastErrorText) logWarn(`[pao] 静默扫描失败,跳过本轮:${text}`);
			lastErrorText = text;
		}
	};
	const timer = setInterval(scan, Math.max(1, input.intervalMs ?? DEFAULT_SILENCE_SCAN_INTERVAL_MS));
	timer.unref?.();
	return { stop: () => clearInterval(timer), scan };
}
