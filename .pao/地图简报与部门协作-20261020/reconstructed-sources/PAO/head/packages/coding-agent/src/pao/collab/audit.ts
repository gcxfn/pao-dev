/**
 * 协作中转审计（§8.2）：落队列与否都留痕，JSONL 追加，一行一条。
 * 审计路径参数注入，不硬编码；追加走 cards 的跨进程文件锁。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "../shared/lock.ts";
import type { CollabVerdict } from "./review.ts";

/**
 * /派 用户直派的审计结果值（M2-02）：用户＝最高授权，不经机械中转直接落队列，
 * 但落卡同样留审计——与三路裁决并列写进同一 JSONL，审计线不缺用户直派的账。
 */
export const USER_DIRECT_VERDICT = "用户直派" as const;
export type CollabAuditVerdict = CollabVerdict | typeof USER_DIRECT_VERDICT;

/** 协作中转审计记录（JSONL 一行一条）。卡号：放行＝新卡号；拒绝/待裁决＝幂等命中卡号或 null。 */
export interface CollabAuditRecord {
	时间: string;
	来源部门: string;
	目标部门: string;
	卡号: number | null;
	校验结果: CollabAuditVerdict;
	/** 协作卡目标（人读审计用，可选） */
	目标?: string;
	/** 拒绝原因/裁决标记的结构化摘要（可选） */
	原因?: string[];
}

/** 追加一条审计记录（JSONL，带文件锁；目录不存在时自动创建，须先建目录——锁目录建在目标旁边）。 */
export async function auditAppend(auditPath: string, record: CollabAuditRecord): Promise<void> {
	mkdirSync(dirname(auditPath), { recursive: true });
	await withFileLock(auditPath, () => {
		appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
	});
}
