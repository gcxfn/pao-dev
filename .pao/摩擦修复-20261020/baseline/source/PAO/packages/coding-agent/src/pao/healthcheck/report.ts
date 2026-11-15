/**
 * 体检报告(M0-07):探针结果汇总成架构 §6.2「评测」条目格式的 markdown 并落盘。
 * 条目规矩:首行钩子+日期、正文一页纸、带适用边界(模型/端点/版本/平台)、现状断言带「截至」、
 * 不用 YAML frontmatter(读者是模型)。密钥永不写入:报告只记鉴权方式,不记值。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { writeFileAtomic } from "../shared/atomic.ts";

import type { ProbeResult } from "./probes.ts";

export interface HealthcheckModelInfo {
	id: string;
	name: string;
	provider: string;
	baseUrl: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface HealthcheckReport {
	/** YYYY-MM-DD HH:mm */
	time: string;
	model: HealthcheckModelInfo;
	/** 鉴权方式描述(不含密钥值) */
	auth: string;
	probes: ProbeResult[];
	total_usage: Usage;
	calls: number;
}

export interface EntryMetaInfo {
	/** pi fork 的 coding-agent 包版本 */
	pi_version: string;
	/** 如 win32/v22.x */
	platform: string;
}

/** 文件名安全化:去掉路径分隔符等不友好字符 */
function safeFileName(text: string): string {
	return text.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "模型";
}

export function sumProbeUsage(probe: ProbeResult[]): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const entry of probe) {
		total.input += entry.用量.input ?? 0;
		total.output += entry.用量.output ?? 0;
		total.cacheRead += entry.用量.cacheRead ?? 0;
		total.cacheWrite += entry.用量.cacheWrite ?? 0;
		total.totalTokens += entry.用量.totalTokens ?? 0;
		total.cost.input += entry.用量.cost?.input ?? 0;
		total.cost.output += entry.用量.cost?.output ?? 0;
		total.cost.cacheRead += entry.用量.cost?.cacheRead ?? 0;
		total.cost.cacheWrite += entry.用量.cost?.cacheWrite ?? 0;
		total.cost.total += entry.用量.cost?.total ?? 0;
		if (entry.用量.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + entry.用量.reasoning;
	}
	return total;
}

/** 从探针结果提炼首行钩子:全过/有失败/全崩三种口径 */
function hookLine(probe: ProbeResult[]): string {
	const failed = probe.filter((entry) => entry.状态 === "失败");
	const substantive = probe.filter((entry) => entry.状态 === "通过" || entry.状态 === "观察完成");
	if (failed.length === 0 && substantive.length > 0) return `${substantive.length} 项探针无失败`;
	if (failed.length === probe.length) return "全部探针失败(端点不可用或无鉴权)";
	return `${failed.length} 项失败(${failed.map((entry) => entry.探针).join("、")})`;
}

/** 渲染 §6.2 评测条目(纯函数,不碰盘) */
export function renderEvalEntry(report: HealthcheckReport, meta: EntryMetaInfo): string {
	const date = report.time.slice(0, 10);
	const usage = report.total_usage;
	const failedItems = report.probes.filter((entry) => entry.状态 === "失败");
	const lines: string[] = [
		`# ${report.model.name} 端点体检:${hookLine(report.probes)}(截至 ${date})`,
		"",
		`适用边界:${report.model.id}@${report.model.provider}(${report.model.baseUrl});pi fork ${meta.pi_version};${meta.platform};截至 ${date}。由 pao_health_check 生成;部门知识库未建前暂存 .pao/体检/,建部后可入库为评测条目。`,
		"",
		"## 端点与配置",
		`- 端点 ${report.model.baseUrl};上下文窗口 ${report.model.contextWindow};目录声明 reasoning=${String(report.model.reasoning)}`,
		`- 鉴权:${report.auth}`,
		"",
		`## 完成情况(${report.calls} 次模型调用)`,
	];
	for (const entry of report.probes) {
		const section = [`- ${entry.探针}:${entry.状态}`];
		if (entry.说明) section.push(`——${entry.说明}`);
		if (entry.观察.length > 0) section.push(`(${entry.观察.join(";")})`);
		lines.push(section.join(""));
	}
	lines.push(
		"",
		"## 总用量",
		`输入 ${usage.input} / 输出 ${usage.output}${usage.reasoning !== undefined ? `(思考 ${usage.reasoning})` : ""} / 缓存读 ${usage.cacheRead} / 合计 ${usage.totalTokens} token`,
		"",
		"## 返工原因",
		failedItems.length === 0 ? "无" : failedItems.map((entry) => `${entry.探针}:${entry.说明 ?? "失败"}`).join(";"),
		"",
	);
	return lines.join("\n");
}

/**
 * 落盘评测条目;返回写入路径。同名(同分钟重跑)自动加 -2 后缀,不覆盖。
 */
export function writeEvalEntry(dir: string, report: HealthcheckReport, meta: EntryMetaInfo): string {
	mkdirSync(dir, { recursive: true });
	const [date, hourMinute] = [report.time.slice(0, 10), report.time.slice(11, 16).replaceAll(":", "")];
	const baseName = `${date}-体检-${safeFileName(report.model.id)}-${hourMinute}`;
	let outPath = join(dir, `${baseName}.md`);
	for (let seq = 2; existsSync(outPath); seq++) {
		outPath = join(dir, `${baseName}-${seq}.md`);
	}
	writeFileAtomic(outPath, renderEvalEntry(report, meta));
	return outPath;
}
