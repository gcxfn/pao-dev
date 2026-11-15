import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { appendMetricsLine } from "../cards/metrics.ts";
import { DEPT_DIR_NAME } from "../dept/registry.ts";
import { projectName } from "./handle.ts";

/**
 * 部长会话用量落账(M2-01 §2 主控审核 P1 补;M2-04 全角色对账口径)。
 *
 * 每轮 usage(message_end 带 usage 的事件边界)按「部门＋项目」聚合追加
 * <项目根>/.pao/四指标账.txt——与结卡四指标账同文件同格式(cards/metrics.ts 的
 * appendMetricsLine 原样复用:首行口径注释、writeFileAtomic 原子写,锁与格式不另立)。
 *
 * 行映射(同款 6 列制表符,卡号位标「部长」;映射口径为 S2 定案,列语义见下):
 *   卡号位 = 部长
 *   目标位 = 部门:<部门>｜项目:<项目名>
 *   终态位 = 第<N>轮(部长会话无结卡终态,此列承载轮次序号)
 *   总时长秒 = 自会话启动的秒数
 *   全角色合计成本位 = 该轮成本(6 位小数去浮点尾;接口未回 usage 的轮不落账,不填零)
 *   介入次数位 = 0(部长会话不经人工门/打回/分支裁决,恒 0)
 */

/** 部长会话的账路径:<项目根>/.pao/四指标账.txt(与卡指标账同文件,聚合按项目根) */
export function ministerLedgerPath(projectRoot: string): string {
	return join(projectRoot, ".pao", "四指标账.txt");
}

/** 部长账行(纯函数):字段内 Tab/换行压空格——账一行一轮,Tab 是字段分隔符 */
export function buildMinisterLedgerLine(input: {
	部门: string;
	项目根: string;
	轮次: number;
	该轮成本: number;
	会话秒: number;
}): string {
	const sanitize = (text: string): string =>
		text
			.replace(/\s*\r?\n\s*/g, " ")
			.replace(/\t/g, " ")
			.trim();
	return [
		"部长",
		`部门:${sanitize(input.部门)}｜项目:${sanitize(projectName(input.项目根))}`,
		`第${Math.max(0, Math.floor(input.轮次))}轮`,
		String(Math.max(0, Math.round(input.会话秒))),
		String(Math.round(input.该轮成本 * 1e6) / 1e6),
		"0",
	].join("\t");
}

/** 追加一行部长账(薄 IO:目录不存在先建,写盘复用 appendMetricsLine 的原子追加) */
export function writeMinisterLedger(ledgerPath: string, line: string): void {
	mkdirSync(dirname(ledgerPath), { recursive: true });
	appendMetricsLine(ledgerPath, line);
}

/**
 * 监督动作审计留痕:催办(提示线/监督唤醒/待办标记)与散场(空闲熔断/显式散场)触发时
 * 追加一行 JSONL,上级可查证。落 $PAO_HOME/部门/审查/监督审计.jsonl(跨部门一文件)。
 */

/** 监督审计记录(JSONL 一行一条,同 collab/audit.ts 的留痕口径) */
export interface SupervisionAuditRecord {
	/** ISO 时间戳 */
	时间: string;
	/** 动作类型(提示线/监督唤醒/worker监督唤醒/worker监督待办/散场) */
	动作: string;
	/** 目标会话/worker 标识 */
	目标: string;
	/** 触发原因/上下文 */
	原因: string;
}

/** 监督审计路径:$PAO_HOME/部门/审查/监督审计.jsonl */
export function supervisionAuditPath(paoHome: string): string {
	return join(paoHome, DEPT_DIR_NAME, "审查", "监督审计.jsonl");
}

/** 追加一行监督审计(薄 IO:目录不存在先建,JSONL 追加) */
export function writeSupervisionAudit(auditPath: string, record: SupervisionAuditRecord): void {
	mkdirSync(dirname(auditPath), { recursive: true });
	appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
}
