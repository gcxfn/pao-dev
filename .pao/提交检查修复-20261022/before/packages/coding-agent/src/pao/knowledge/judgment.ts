/**
 * 巡库初判记录文件约定（M2-05 巡库卡链闭环的机械支撑，§6.7）：
 * 巡库 worker 的初判「走结果文件/回执」——本模块把结果文件的落点、格式与读写固定下来，
 * 让初判有据可查、终审有账可对：
 * - 落点：每库一份 JSONL `<libRoot>/.pao-巡库初判.jsonl`（衍生记录，不是第二份索引）；
 * - worker 侧只准追加本文件＋卡回执，不准动条目正文（红线，卡 约束 字段同款）；
 * - 部长终审时 loadPatrolJudgments 按卡号取出初判，三选一（更新/退役/打回待验证）
 *   的机械动作分别由 改写条目/retireEntry/demoteToPending 承接；⚠️ 标记本身仍只经
 *   inspectLibrary 的统一写入路径维护。
 * 坏行（半截 JSON 等）跳过不抛——记录文件损坏不阻塞查账，也不阻塞终审。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";

/** 初判记录文件名（库根下的点文件，与向量缓存同款「衍生品」待遇） */
export const JUDGMENT_FILE = ".pao-巡库初判.jsonl";

export function judgmentFilePath(libRoot: string): string {
	return join(libRoot, JUDGMENT_FILE);
}

/** 终审三选一（§6.7）：更新（部长改写＋新日期）/ 退役（移归档）/ 打回待验证 */
export type JudgmentAction = "更新" | "退役" | "打回待验证";

export const JUDGMENT_ACTIONS: readonly JudgmentAction[] = ["更新", "退役", "打回待验证"];

export interface PatrolJudgment {
	/** 记录时间 ISO 串 */
	time: string;
	/** 对应巡库卡号 */
	卡号: number;
	/** ⚠️ 条目相对路径（指针，不装正文） */
	relPath: string;
	/** 初判：终审三选一的建议 */
	初判: JudgmentAction;
	/** 一句话理由；可省 */
	理由?: string;
}

/** 追加一条初判（worker 唯一允许的知识库写入；除 ⚠️ 标记外）。 */
export function appendPatrolJudgment(libRoot: string, judgment: PatrolJudgment): void {
	if (!JUDGMENT_ACTIONS.includes(judgment.初判)) {
		throw new Error(`初判必须是三选一（${JUDGMENT_ACTIONS.join("/")}）：${String(judgment.初判)}`);
	}
	const file = judgmentFilePath(libRoot);
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(judgment)}\n`, "utf8");
}

/** 行守卫（仿 usage/ledger.ts isLedgerRow）：形状不对的合法 JSON 同样按坏行跳过。 */
function isPatrolJudgment(value: unknown): value is PatrolJudgment {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.time === "string" &&
		typeof v.卡号 === "number" &&
		typeof v.relPath === "string" &&
		typeof v.初判 === "string" &&
		JUDGMENT_ACTIONS.includes(v.初判 as JudgmentAction)
	);
}

/** 读取初判记录；可按卡号过滤。文件缺失返回 []，坏行跳过（不抛、不阻断终审）。 */
export function loadPatrolJudgments(libRoot: string, filter?: { 卡号?: number }): PatrolJudgment[] {
	const file = judgmentFilePath(libRoot);
	if (!existsSync(file)) return [];
	const out: PatrolJudgment[] = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isPatrolJudgment(parsed)) continue;
			if (filter?.卡号 !== undefined && parsed.卡号 !== filter.卡号) continue;
			out.push(parsed);
		} catch {
			// 坏行跳过：记录文件损坏不阻塞终审
		}
	}
	return out;
}

/** 供归档/清理场景整体重置初判记录（测试与库迁移用；生产路径不调用）。 */
export function rewriteJudgmentFile(libRoot: string, judgments: PatrolJudgment[]): void {
	const file = judgmentFilePath(libRoot);
	mkdirSync(dirname(file), { recursive: true });
	writeFileAtomic(file, judgments.map((j) => `${JSON.stringify(j)}\n`).join(""));
}
