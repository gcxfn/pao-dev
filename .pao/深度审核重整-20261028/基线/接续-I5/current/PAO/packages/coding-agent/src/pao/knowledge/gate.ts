/**
 * worker 受限补查门（§6.4 + R01）：只查本部、只读、限一次、查了什么记回执。
 *
 * - 部门锁死：查不到别的部，`部门=全部` 及其别名直接拒绝；
 * - 「一次」按 卡号+授权轮次 计：重试不恢复额度，要加查先明确追加授权轮次；
 *   额度状态跨门实例共享（进程内登记 + 回执文件核对），重开门也赖不掉；
 * - 只读：底层查库以 writeCache:false 运行，无任何写路径；
 * - 回执记录查了什么词、返回几条。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmbedClient } from "./embed.ts";
import type { OutboundConfig } from "./outbound.ts";
import { paoHome } from "./paths.ts";
import { type SearchOptions, searchLibrary } from "./search.ts";
import type { SearchResult } from "./types.ts";

export interface RestrictedQueryAuth {
	/** 卡号：授权到哪张卡 */
	cardId: string;
	/** 授权轮次：同一卡重试沿用同轮次，不恢复额度；追加授权则轮次 +1 */
	round: number;
}

export interface QueryReceipt {
	time: string;
	cardId: string;
	round: number;
	/** 锁定的本部名 */
	dept: string;
	query: string;
	/** 正式依据 + 风险提示的总条数 */
	hitCount: number;
}

export interface GateOptions {
	/** 本部知识库根目录（锁死） */
	libRoot: string;
	/** 本部名（用于拒绝跨部与「全部」别名） */
	deptName: string;
	auth: RestrictedQueryAuth;
	/** 回执落盘路径；缺省 PAO_HOME/.pao/补查回执.jsonl */
	receiptPath?: string;
	/** 自定义回执写入（测试注入）；注入后不再读写默认回执文件 */
	appendReceipt?: (receipt: QueryReceipt) => void | Promise<void>;
	embed?: EmbedClient | null;
	outbound?: OutboundConfig;
	/** 宿主绑定的项目，受限工具不得由模型参数覆盖。 */
	project?: string;
	now?: Date;
}

/** 「全部」类别名：出现即拒绝，防绕出本部。 */
export const ALL_DEPT_ALIASES = ["全部", "所有", "全部部门", "all", "*", "any"];

export interface RestrictedGate {
	readonly deptName: string;
	readonly auth: RestrictedQueryAuth;
	readonly used: boolean;
	/** 执行受限补查。额度已用、跨部参数、空查询都拒绝并说明。 */
	query(
		queryText: string,
		opts?: { topK?: number; dept?: string; expectedVersion?: string; signal?: AbortSignal },
	): Promise<SearchResult>;
}

/** 额度键：卡号+授权轮次 */
function quotaKey(auth: RestrictedQueryAuth): string {
	return `${auth.cardId}#${auth.round}`;
}

/** 进程内额度登记：同进程内重开门不重置额度。 */
const consumedQuotas = new Set<string>();

function defaultReceiptPath(): string {
	return join(paoHome(), ".pao", "补查回执.jsonl");
}

/** 回执行守卫（仿 usage/ledger.ts isLedgerRow）：额度键只认 cardId/round 类形齐的行，坏行跳过。 */
function isQuotaRow(value: unknown): value is RestrictedQueryAuth {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.cardId === "string" && typeof v.round === "number";
}

/** 从回执文件恢复额度状态（跨会话赖不掉）。 */
function loadConsumedKeys(receiptPath: string): void {
	try {
		if (!existsSync(receiptPath)) return;
		for (const line of readFileSync(receiptPath, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (!isQuotaRow(parsed)) continue;
				consumedQuotas.add(quotaKey(parsed));
			} catch {
				// 损坏行跳过，不影响其余回执
			}
		}
	} catch {
		// 读不到回执文件不阻塞创建，进程内登记仍在
	}
}

export function createRestrictedGate(options: GateOptions): RestrictedGate {
	const receiptPath = options.receiptPath ?? defaultReceiptPath();
	// 自定义回执写入时，额度只认进程内登记（测试场景）；否则核对回执文件
	if (!options.appendReceipt) loadConsumedKeys(receiptPath);

	const searchDefaults: Pick<SearchOptions, "libRoot" | "embed" | "outbound" | "project" | "now"> = {
		libRoot: options.libRoot,
		embed: options.embed ?? null,
		outbound: options.outbound,
		project: options.project,
		now: options.now,
	};

	return {
		deptName: options.deptName,
		auth: options.auth,
		get used() {
			return consumedQuotas.has(quotaKey(options.auth));
		},
		async query(
			queryText: string,
			opts: { topK?: number; dept?: string; expectedVersion?: string; signal?: AbortSignal } = {},
		): Promise<SearchResult> {
			const key = quotaKey(options.auth);
			if (consumedQuotas.has(key)) {
				throw new Error(
					`受限补查已用过：卡号 ${options.auth.cardId} 授权轮次 ${options.auth.round} 只允许一次补查，重试不恢复额度；仍不够请报部长补指针或明确追加授权轮次。`,
				);
			}
			const dept = opts.dept?.trim();
			if (dept && dept !== options.deptName) {
				const aliasHit = ALL_DEPT_ALIASES.includes(dept.toLowerCase());
				throw new Error(
					aliasHit
						? `受限补查拒绝「${dept}」：只允许查本部「${options.deptName}」，不得经全部/别名绕出本部。`
						: `受限补查拒绝跨部：请求「${dept}」，本部锁定为「${options.deptName}」。`,
				);
			}
			if (!queryText || !queryText.trim()) {
				throw new Error("受限补查拒绝空查询。");
			}
			// 先占额度再执行：本次调用即消耗，失败/异常同样不返还（重试不恢复额度）
			consumedQuotas.add(key);
			let result: SearchResult;
			try {
				result = await searchLibrary({
					...searchDefaults,
					query: queryText,
					topK: opts.topK,
					expectedVersion: opts.expectedVersion,
					signal: opts.signal,
					writeCache: false, // 只读：不写缓存，无任何写路径
				});
			} catch (error) {
				await recordReceipt({
					time: new Date().toISOString(),
					cardId: options.auth.cardId,
					round: options.auth.round,
					dept: options.deptName,
					query: queryText,
					hitCount: -1,
				});
				throw error;
			}
			await recordReceipt({
				time: new Date().toISOString(),
				cardId: options.auth.cardId,
				round: options.auth.round,
				dept: options.deptName,
				query: queryText,
				hitCount: result.hits.length + result.riskHits.length,
			});
			return result;
		},
	};

	async function recordReceipt(receipt: QueryReceipt): Promise<void> {
		if (options.appendReceipt) {
			await options.appendReceipt(receipt);
			return;
		}
		mkdirSync(dirname(receiptPath), { recursive: true });
		appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
	}
}
