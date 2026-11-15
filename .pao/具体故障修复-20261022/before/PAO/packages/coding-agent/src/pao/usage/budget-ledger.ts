/**
 * 显式总预算的授权账（计划 §8.2）：**用户显式给多少，才允许花多少**。
 *
 * 三条设计底线（都是计划原文的直译）：
 * 1. **只有用户显式给总预算才启用**。没有授权记录 = 不启用跨任务额度，
 *    绝不凭空设一个默认总限额（`readLedger` 对不存在的账返回"未授权"而不是"额度 0"）。
 * 2. **加额度是显式操作**，必须带版本和当时的余额依据（`grantBudget` 记 `version`/`余额依据`）。
 * 3. **取消不抹费用**：任何状态转移都不删除已花的钱；只能追加新的授权版本。
 *
 * 落盘用 withFileLock + writeFileAtomic（照 intake/ledger.ts 的既定口径）；
 * 坏账抛 `BudgetLedgerError`，**绝不静默重置**——静默重置等于悄悄把额度恢复满，
 * 正是"偷偷刷新默认额度"那条禁令。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../shared/atomic.ts";
import { FileLockError, withFileLock } from "../shared/lock.ts";

/** 账本文件名（相对 PAO_HOME） */
export const BUDGET_LEDGER_FILENAME = "总预算账.json";

/** 预留记录的状态。 */
export type ReservationStatus =
	/** 已预留、还没结算：这笔钱已经占住了，别人不能再用。 */
	| "reserved"
	/** 已按实际用量结算：`已结算费用` 是真实结果（可能小于预留额，差额已归还）。 */
	| "settled"
	/** 明确未受理（派发前就被拒）：预留额已全额归还，`已结算费用` 为 0。 */
	| "released"
	/** 结果不明：进程崩了/超时/没收到回执。**预留额继续占着**（先查再决定，不重复授额）。 */
	| "unknown";

/** 一条预留记录（= 一次"给某个请求留钱"的事实，重启后能核对原请求）。 */
export interface BudgetReservation {
	/** 请求判据：同判据重复调用必须复用同一条记录，不能各领一份。 */
	idempotencyKey: string;
	/** 预留金额（美元）。 */
	预留额: number;
	status: ReservationStatus;
	/** 预留发生时间（ISO）。 */
	预留时间: string;
	/** 结算/释放时间（ISO）；未结算为 undefined。 */
	结算时间?: string;
	/** 真实花掉的钱（美元）；只有 settled 才有确定值。 */
	已结算费用?: number;
	/**
	 * 内容指纹：同一判据但内容不同 → 拒（避免"同判据不同任务"被悄悄当成同一条）。
	 * 由调用方算（`fingerprintRequest`），本模块只存不比。
	 */
	指纹: string;
	/** 这条记录属于哪个卡/任务（可空：总量预留可能先于具体卡）。 */
	卡号?: string;
	/** 备注（为什么未知、谁结算的等）。 */
	备注?: string;
}

/** 一次显式授权（版本化：加额度只能追加新版本，不改旧版本）。 */
export interface BudgetGrant {
	/** 版本号，从 1 递增。每次加额度必须 +1。 */
	version: number;
	/** 本次授权后**总预算**（美元）：是总量，不是增量。 */
	总预算: number;
	/** 授权时间（ISO）。 */
	授权时间: string;
	/** 授权时的余额依据（当时已花多少、还剩多少），便于事后核对。 */
	余额依据: { 已花: number; 授权前总预算: number };
	/** 谁授权的（用户显式操作的标识）。 */
	授权人: string;
}

/** 账本文件形状。 */
export interface BudgetLedgerFile {
	version: 1;
	/** 授权版本链（空数组 = 用户从未给过总预算）。 */
	grants: BudgetGrant[];
	/** 预留记录。 */
	reservations: BudgetReservation[];
}

/** 坏账/写失败/锁超时：一律抛，不静默降级。 */
export class BudgetLedgerError extends Error {
	readonly code: "BAD_LEDGER" | "WRITE_FAILED" | "LOCK_TIMEOUT";
	readonly details?: unknown;
	constructor(code: BudgetLedgerError["code"], message: string, details?: unknown) {
		super(message);
		this.name = "BudgetLedgerError";
		this.code = code;
		this.details = details;
	}
}

export function budgetLedgerPath(paoHome: string): string {
	return join(paoHome, BUDGET_LEDGER_FILENAME);
}

function emptyLedger(): BudgetLedgerFile {
	return { version: 1, grants: [], reservations: [] };
}

function isReservation(value: unknown): value is BudgetReservation {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.idempotencyKey === "string" &&
		typeof v.预留额 === "number" &&
		Number.isFinite(v.预留额) &&
		v.预留额 >= 0 &&
		typeof v.预留时间 === "string" &&
		typeof v.指纹 === "string" &&
		(v.status === "reserved" || v.status === "settled" || v.status === "released" || v.status === "unknown") &&
		(v.已结算费用 === undefined || (typeof v.已结算费用 === "number" && Number.isFinite(v.已结算费用)))
	);
}

function isGrant(value: unknown): value is BudgetGrant {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	const basis = v.余额依据 as Record<string, unknown> | undefined;
	return (
		typeof v.version === "number" &&
		Number.isSafeInteger(v.version) &&
		v.version >= 1 &&
		typeof v.总预算 === "number" &&
		Number.isFinite(v.总预算) &&
		v.总预算 >= 0 &&
		typeof v.授权时间 === "string" &&
		typeof v.授权人 === "string" &&
		typeof basis === "object" &&
		basis !== null &&
		typeof basis.已花 === "number" &&
		typeof basis.授权前总预算 === "number"
	);
}

/**
 * 读账本。文件不存在 = **从未授权**（返回空账 + 调用方按"未启用"处理），不是错误。
 * 文件存在但内容坏了 = 抛 BAD_LEDGER：宁可停手，也不猜一个额度出来。
 */
export function readBudgetLedger(path: string): BudgetLedgerFile {
	if (!existsSync(path)) return emptyLedger();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new BudgetLedgerError("BAD_LEDGER", `总预算账无法解析（拒绝猜到额度）：${path}`, error);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new BudgetLedgerError("BAD_LEDGER", `总预算账不是对象：${path}`);
	}
	const file = parsed as Partial<BudgetLedgerFile>;
	if (file.version !== 1 || !Array.isArray(file.grants) || !Array.isArray(file.reservations)) {
		throw new BudgetLedgerError("BAD_LEDGER", `总预算账形状不对（需要 version:1 + grants[] + reservations[]）：${path}`);
	}
	for (const grant of file.grants) {
		if (!isGrant(grant)) throw new BudgetLedgerError("BAD_LEDGER", `总预算账里有坏授权记录：${path}`, grant);
	}
	for (const reservation of file.reservations) {
		if (!isReservation(reservation))
			throw new BudgetLedgerError("BAD_LEDGER", `总预算账里有坏预留记录：${path}`, reservation);
	}
	return { version: 1, grants: file.grants, reservations: file.reservations };
}

function writeBudgetLedger(path: string, file: BudgetLedgerFile): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileAtomic(path, JSON.stringify(file, null, "\t"));
	} catch (error) {
		throw new BudgetLedgerError("WRITE_FAILED", `总预算账写入失败：${path}`, error);
	}
}

/** 锁内执行；锁占用转成可识别的 LOCK_TIMEOUT，调用方据此判断"别人正在改"。 */
async function locked<T>(path: string, fn: () => T): Promise<T> {
	try {
		return await withFileLock(path, fn);
	} catch (error) {
		if (error instanceof FileLockError) {
			throw new BudgetLedgerError("LOCK_TIMEOUT", `总预算账被占用：${path}`, error);
		}
		throw error;
	}
}

/** 当前生效的总预算（= 最新一个授权版本的总预算）。 */
export function currentGrant(file: BudgetLedgerFile): BudgetGrant | undefined {
	return file.grants.length > 0 ? file.grants[file.grants.length - 1] : undefined;
}

/**
 * 当前"已被占住"的钱 = 所有 reserved / unknown 记录的预留额 + 所有 settled 的已结算费用。
 *
 * 为什么 unknown 也算占住：结果不明时这笔钱可能已经花掉了，先当它花了（保守），
 * 再去查真实结果。**先查、不重复授额**——宁可暂时少给额度，也不能超支。
 */
export function committedSpend(file: BudgetLedgerFile): number {
	let total = 0;
	for (const reservation of file.reservations) {
		if (reservation.status === "settled") total += reservation.已结算费用 ?? 0;
		else if (reservation.status === "reserved" || reservation.status === "unknown") total += reservation.预留额;
		// released：已全额归还，不计。
	}
	return total;
}

/** 剩余可用（美元）；未授权时返回 undefined——**不返回 0**，因为"没授权"和"额度用光"是两件事。 */
export function remainingBudget(file: BudgetLedgerFile): number | undefined {
	const grant = currentGrant(file);
	if (!grant) return undefined;
	return Math.max(0, grant.总预算 - committedSpend(file));
}

/** 同一判据的已有预留（重启后靠它核对"原请求"，不重复授额）。 */
export function findReservation(
	file: BudgetLedgerFile,
	idempotencyKey: string,
): BudgetReservation | undefined {
	return file.reservations.find((reservation) => reservation.idempotencyKey === idempotencyKey);
}

/** 显式加额度（只追加新版本，不改历史）。返回新版本。 */
export async function grantBudget(
	path: string,
	input: { 总预算: number; 授权人: string; 授权时间: string },
): Promise<BudgetGrant> {
	if (!Number.isFinite(input.总预算) || input.总预算 < 0) {
		throw new BudgetLedgerError("BAD_LEDGER", `总预算须为非负数值：${input.总预算}`);
	}
	if (!input.授权人.trim()) throw new BudgetLedgerError("BAD_LEDGER", "加额度必须记下授权人（显式操作）");
	return locked(path, () => {
		const file = readBudgetLedger(path);
		const 授权前总预算 = currentGrant(file)?.总预算;
		const grant: BudgetGrant = {
			version: file.grants.length + 1,
			总预算: input.总预算,
			授权时间: input.授权时间,
			余额依据: { 已花: committedSpend(file), 授权前总预算: 授权前总预算 ?? 0 },
			授权人: input.授权人,
		};
		file.grants.push(grant);
		writeBudgetLedger(path, file);
		return grant;
	});
}

/**
 * 原子的"检查并预留"：锁内读账 → 判断剩不剩 → 写新记录。
 *
 * **这是"并发不能各领一份完整总额"的实现点**：两个并发调用会在这把文件锁上排队，
 * 后到的那个读到的已经是前者写过的新账面，因此只看得到扣掉前者之后的余额。
 * 如果把检查放在锁外（先读余额、再锁、再写），两个并发请求就会各读到同样的全额。
 *
 * 返回 `{ ok: true, reservation }` 或 `{ ok: false, reason }`（reason 是给用户看的真实原因）。
 * 同一判据重复预留 → 复用已有记录（`reused: true`），不再扣一份。
 */
export async function reserveBudget(
	path: string,
	input: {
		idempotencyKey: string;
		金额: number;
		指纹: string;
		现在: string;
		卡号?: string;
	},
): Promise<
	| { ok: true; reservation: BudgetReservation; reused: boolean }
	| { ok: false; reason: string }
> {
	return locked(path, () => {
		const file = readBudgetLedger(path);
		const grant = currentGrant(file);
		if (!grant) {
			// 没授权 = 不启用跨任务额度。这不是"额度 0"，是"用户没给总预算"。
			return { ok: false as const, reason: "用户未显式给总预算：跨任务额度未启用（不会凭空设默认限额）" };
		}
		const existing = findReservation(file, input.idempotencyKey);
		if (existing) {
			if (existing.指纹 !== input.指纹) {
				return {
					ok: false as const,
					reason: `同一判据 ${input.idempotencyKey} 的内容和上次不同（指纹不符）：拒绝把不同任务当成同一条`,
				};
			}
			// 同判据重入：不重复扣额，直接把已有记录交回去（重启后核对的正是这条）。
			return { ok: true as const, reservation: existing, reused: true };
		}
		if (!Number.isFinite(input.金额) || input.金额 < 0) {
			return { ok: false as const, reason: `预留金额须为非负数值：${input.金额}` };
		}
		const 剩 = Math.max(0, grant.总预算 - committedSpend(file));
		if (input.金额 > 剩) {
			return {
				ok: false as const,
				reason: `总预算不足：本次需要 $${input.金额.toFixed(2)}，剩余 $${剩.toFixed(2)}（版本 ${grant.version} 总预算 $${grant.总预算.toFixed(2)}）`,
			};
		}
		const reservation: BudgetReservation = {
			idempotencyKey: input.idempotencyKey,
			预留额: input.金额,
			status: "reserved",
			预留时间: input.现在,
			指纹: input.指纹,
			...(input.卡号 ? { 卡号: input.卡号 } : {}),
		};
		file.reservations.push(reservation);
		writeBudgetLedger(path, file);
		return { ok: true as const, reservation, reused: false };
	});
}

/**
 * 结算（按实际用量）。
 *
 * - `实际费用` 小于预留额 → 差额自动归还（committedSpend 只算实际费用）；
 * - `实际费用` 大于预留额 → **如实记下超额**，不裁剪（裁剪等于假装没超支）；
 * - `实际费用` 为 undefined（费用未知）→ 状态记 `unknown`，预留额继续占着，直到有人查清。
 *
 * 找不到该判据的记录 → 抛（不能给一笔凭空出现的结算）。
 */
export async function settleBudget(
	path: string,
	input: { idempotencyKey: string; 实际费用?: number; 现在: string; 备注?: string },
): Promise<BudgetReservation> {
	return locked(path, () => {
		const file = readBudgetLedger(path);
		const reservation = findReservation(file, input.idempotencyKey);
		if (!reservation) {
			throw new BudgetLedgerError("BAD_LEDGER", `总预算账里没有判据 ${input.idempotencyKey} 的预留记录，拒绝结算`);
		}
		if (input.实际费用 === undefined) {
			// 费用未知：不假装结算成功。预留额继续占着（保守），等查到真实结果再 settle。
			reservation.status = "unknown";
			reservation.结算时间 = input.现在;
			reservation.备注 = input.备注 ?? "费用未知（未回 usage 或缺账）：预留额继续占用，先查不重复授额";
		} else {
			if (!Number.isFinite(input.实际费用) || input.实际费用 < 0) {
				throw new BudgetLedgerError("BAD_LEDGER", `实际费用须为非负数值：${input.实际费用}`);
			}
			reservation.status = "settled";
			reservation.已结算费用 = input.实际费用;
			reservation.结算时间 = input.现在;
			if (input.实际费用 > reservation.预留额) {
				reservation.备注 = `实际费用超出预留额：预留 $${reservation.预留额.toFixed(2)} → 实际 $${input.实际费用.toFixed(2)}（如实记录，未裁剪）`;
			} else if (input.备注) {
				reservation.备注 = input.备注;
			}
		}
		writeBudgetLedger(path, file);
		return reservation;
	});
}

/**
 * 归还未受理的预留（派发前就被拒的情形）。
 *
 * 只允许 `reserved` → `released`；`unknown` 不许直接归还（结果还没查清，归还会导致超支）。
 * 已 `settled` 的也不许归还（钱已经花了，取消不抹费用）。
 */
export async function releaseBudget(
	path: string,
	input: { idempotencyKey: string; 现在: string; 备注?: string },
): Promise<BudgetReservation | undefined> {
	return locked(path, () => {
		const file = readBudgetLedger(path);
		const reservation = findReservation(file, input.idempotencyKey);
		if (!reservation) return undefined;
		if (reservation.status === "settled") {
			throw new BudgetLedgerError(
				"BAD_LEDGER",
				`判据 ${input.idempotencyKey} 已结算（$${(reservation.已结算费用 ?? 0).toFixed(2)}），不能归还——取消不抹费用`,
			);
		}
		if (reservation.status === "unknown") {
			throw new BudgetLedgerError(
				"BAD_LEDGER",
				`判据 ${input.idempotencyKey} 结果不明，须先查清再结算或归还（不许直接归还，否则可能超支）`,
			);
		}
		reservation.status = "released";
		reservation.结算时间 = input.现在;
		reservation.备注 = input.备注 ?? "未受理，预留额已全额归还";
		writeBudgetLedger(path, file);
		return reservation;
	});
}

/**
 * 重启核对：按判据查这条请求现在到底是什么状态。
 * 返回 `missing`（账里没有）/`reserved`/`settled`/`released`/`unknown`，供调用方决定能否继续。
 */
export function inspectReservation(
	paoHome: string,
	idempotencyKey: string,
): { state: "missing" } | { state: ReservationStatus; reservation: BudgetReservation } {
	const file = readBudgetLedger(budgetLedgerPath(paoHome));
	const reservation = findReservation(file, idempotencyKey);
	if (!reservation) return { state: "missing" };
	return { state: reservation.status, reservation };
}
