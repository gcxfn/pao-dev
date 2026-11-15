/**
 * 受理幂等账：请求判据 → 首次受理身份的落盘正本。
 *
 * 存放位置：`<项目根>/.pao/intake/受理账.json`（项目根由卡目录推导，与项目写锁/卡号计数器同一现场）。
 * 为什么放项目侧而不是 PAO_HOME：判据是「这个任务工作区受理过没有」，跨工作区不该互相认领；
 * 且与卡目录同属一个工作区事实域，重装 PAO_HOME 不应让重复提交重新建卡。
 *
 * 本模块只做「读—判—写」这一件事，复用既有原语，不新造第二套锁/原子写/编号：
 * - 锁与原子写用 cards 模块导出的 withFileLock / writeFileAtomic（全仓唯一实现）；
 * - 卡号由 cards 的 createCard/nextCardNumber 发号，本模块只记卡号结果，不碰计数器。
 *
 * 并发与占位：`reserveIntakeKey` 在锁内「查判据 → 没有就写一条占位」，占位条目用 `pending: true` 标记、
 * cardNo/cardPath 为空串。占位存在的唯一目的是「同判据并发提交时只让一个进去建卡」；
 * 建卡成功转正（`commitIntakeEntry`），任何一步失败都撤回占位（`dropIntakeKey`）——
 * 否则一次失败的受理会把该判据永久锁死，用户改完重试会被判成 duplicate 却查无此卡。
 *
 * 失败纪律：**不静默吞**。
 * - 账文件坏（JSON 坏/版本不认识/条目形状不对）→ 抛 IntakeLedgerError，让受理如实失败，
 *   不重置、不覆盖——坏了就报，人工看现场；
 * - 写账失败 → 抛错，即使卡已建成也不回「已受理」（宁可如实报「受理记录失败」，也不给一个
 *   下次会被重复建卡的假成功）。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { projectRootForCards, withFileLock, writeFileAtomic } from "../cards/index.ts";
import type { IntakeLedgerEntry, IntakeLedgerFile } from "./types.ts";

/** 受理账相对项目根的路径（`.pao/intake/`；与 `任务A/卡/`、`任务A/卡号.txt` 同现场）。 */
export const INTAKE_LEDGER_RELATIVE_PATH = join(".pao", "intake", "受理账.json");

/** 幂等账自身错误：坏账、写失败、取锁失败都走它，code 稳定可判。 */
export class IntakeLedgerError extends Error {
	readonly code: "BAD_LEDGER" | "WRITE_FAILED" | "LOCK_TIMEOUT";
	readonly details: Record<string, unknown>;

	constructor(code: IntakeLedgerError["code"], message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "IntakeLedgerError";
		this.code = code;
		this.details = details;
	}
}

/** 受理账文件绝对路径（卡目录 → 项目根 → `.pao/intake/受理账.json`）。 */
export function intakeLedgerPath(cardsDir: string): string {
	return join(projectRootForCards(cardsDir), INTAKE_LEDGER_RELATIVE_PATH);
}

/** 锁目标路径：账文件本身（proper-lockfile 按 `<账文件>.lock` 建锁目录，账文件可尚不存在）。 */
function lockTarget(path: string): { target: string; cleanup: () => void } {
	// proper-lockfile 要求目标路径存在或其父目录存在；父目录不存在时先建，避免首受理取锁即 ENOENT。
	mkdirSync(dirname(path), { recursive: true });
	return { target: path, cleanup: () => {} };
}

/**
 * 读受理账。文件不存在＝空账（首次受理的正常状态，不是错误）。
 * 文件存在但读不动/解析不了/形状不对＝抛 BAD_LEDGER，绝不当作空账继续（否则重复提交会再建卡）。
 */
export function readIntakeLedger(path: string): IntakeLedgerFile {
	if (!existsSync(path)) return { version: 1, entries: [] };
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new IntakeLedgerError("BAD_LEDGER", `受理账不可读：${(error as Error).message}`, { path });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new IntakeLedgerError("BAD_LEDGER", `受理账不是合法 JSON：${(error as Error).message}`, { path });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new IntakeLedgerError("BAD_LEDGER", "受理账须为 JSON 对象", { path });
	}
	const file = parsed as Partial<IntakeLedgerFile>;
	if (file.version !== 1) {
		throw new IntakeLedgerError("BAD_LEDGER", `受理账版本不认识：${String(file.version)}（须为 1，不自动迁移）`, {
			path,
			version: file.version,
		});
	}
	if (!Array.isArray(file.entries)) {
		throw new IntakeLedgerError("BAD_LEDGER", "受理账 entries 须为数组", { path });
	}
	const entries: IntakeLedgerEntry[] = [];
	for (const [index, item] of file.entries.entries()) {
		if (!item || typeof item !== "object") {
			throw new IntakeLedgerError("BAD_LEDGER", `受理账第 ${index + 1} 条不是对象`, { path, index });
		}
		const entry = item as Partial<IntakeLedgerEntry>;
		if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey.trim().length === 0) {
			throw new IntakeLedgerError("BAD_LEDGER", `受理账第 ${index + 1} 条缺 idempotencyKey`, { path, index });
		}
		// 占位条目不要求 cardNo（还没建卡）；正式条目必须有——否则「duplicate 回填身份」无从谈起。
		if (entry.pending !== true && (typeof entry.cardNo !== "string" || entry.cardNo.length === 0)) {
			throw new IntakeLedgerError("BAD_LEDGER", `受理账第 ${index + 1} 条缺 cardNo（且未标记 pending）`, {
				path,
				index,
			});
		}
		entries.push(entry as IntakeLedgerEntry);
	}
	return { version: 1, entries };
}

/** 按判据查账内既有记录（同 key 只应有一条；有多条取最早＝第一次受理）。 */
export function findIntakeLedgerEntry(path: string, idempotencyKey: string): IntakeLedgerEntry | undefined {
	return readIntakeLedger(path).entries.find((entry) => entry.idempotencyKey === idempotencyKey);
}

/** 原子覆盖整份账（内部用；调用方须持锁）。 */
export function writeIntakeLedger(path: string, file: IntakeLedgerFile): void {
	mkdirSync(dirname(path), { recursive: true });
	try {
		writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
	} catch (error) {
		throw new IntakeLedgerError("WRITE_FAILED", `受理账写入失败：${(error as Error).message}`, { path });
	}
}

/** 取锁包装：把 FileLockError 转成 IntakeLedgerError("LOCK_TIMEOUT")，其余原样抛。 */
async function locked<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
	const { target } = lockTarget(path);
	try {
		return await withFileLock(target, fn);
	} catch (error) {
		if (error instanceof IntakeLedgerError) throw error;
		const code = (error as { code?: string }).code;
		if (code === "LOCK_TIMEOUT") {
			throw new IntakeLedgerError("LOCK_TIMEOUT", `受理账取锁失败：${path}`, {
				path,
				cause: (error as Error).message,
			});
		}
		throw error;
	}
}

/**
 * 占位注册（锁内「查 → 占」）：同判据并发提交时只有一个调用能拿到 `reserved: true`。
 * - 已有正式条目 → `{ reserved: false, existing }`（调用方回 duplicate）；
 * - 已有占位未转正 → 说明有同判据在飞或上次崩在中间：`{ reserved: false, existing }`，
 *   由调用方如实报「受理进行中/上次未完成」，**不**抢过来重复建卡。
 */
export async function reserveIntakeKey(
	path: string,
	placeholder: IntakeLedgerEntry,
): Promise<{ reserved: boolean; existing?: IntakeLedgerEntry }> {
	return locked(path, () => {
		const existing = readIntakeLedger(path).entries.find((item) => item.idempotencyKey === placeholder.idempotencyKey);
		if (existing) return { reserved: false, existing };
		const current = readIntakeLedger(path);
		writeIntakeLedger(path, { version: 1, entries: [...current.entries, placeholder] });
		return { reserved: true };
	});
}

/**
 * 占位转正：把占位条目升级为带真实卡号/卡路径/受理时间的正式记录（清掉 pending）。
 * 返回 false＝找不到该判据的条目（不新建——凭空造一条记录是假账）。
 */
export async function commitIntakeEntry(
	path: string,
	idempotencyKey: string,
	identity: Required<Pick<IntakeLedgerEntry, "cardNo" | "cardPath" | "acceptedAt">>,
): Promise<boolean> {
	return locked(path, () => {
		const current = readIntakeLedger(path);
		const index = current.entries.findIndex((item) => item.idempotencyKey === idempotencyKey);
		if (index < 0) return false;
		const entries = [...current.entries];
		const { pending: _pending, ...rest } = entries[index];
		entries[index] = { ...rest, ...identity };
		writeIntakeLedger(path, { version: 1, entries });
		return true;
	});
}

/**
 * 锁内补写：把首次登记之后才得知的身份（尝试号/实例/节点/轮次）补进既有条目。
 * 建卡时还不知道尝试号（认领才产生），派发受理返回后补写，避免第二个账文件。
 * 只补空位不覆盖已记的真实值（首次记录优先）；找不到条目＝不新建，返回 false。
 */
export async function updateIntakeEntry(
	path: string,
	idempotencyKey: string,
	patch: Pick<IntakeLedgerEntry, "attempt" | "instance" | "node" | "round">,
): Promise<boolean> {
	return locked(path, () => {
		const current = readIntakeLedger(path);
		const index = current.entries.findIndex((item) => item.idempotencyKey === idempotencyKey);
		if (index < 0) return false;
		const merged: IntakeLedgerEntry = { ...current.entries[index] };
		if (merged.attempt === undefined && patch.attempt !== undefined) merged.attempt = patch.attempt;
		if (merged.instance === undefined && patch.instance !== undefined) merged.instance = patch.instance;
		if (merged.node === undefined && patch.node !== undefined) merged.node = patch.node;
		if (merged.round === undefined && patch.round !== undefined) merged.round = patch.round;
		const entries = [...current.entries];
		entries[index] = merged;
		writeIntakeLedger(path, { version: 1, entries });
		return true;
	});
}

/**
 * 撤回占位（锁内删条目）：受理在占位之后任何一步失败都要调，否则该判据被永久锁死。
 * 只删占位（pending 为真）——正式记录绝不删（删了下次重复提交会重新建卡）。
 */
export async function dropIntakeKey(path: string, idempotencyKey: string): Promise<boolean> {
	return locked(path, () => {
		const current = readIntakeLedger(path);
		const entry = current.entries.find((item) => item.idempotencyKey === idempotencyKey);
		if (!entry || entry.pending !== true) return false;
		const entries = current.entries.filter((item) => item.idempotencyKey !== idempotencyKey);
		writeIntakeLedger(path, { version: 1, entries });
		return true;
	});
}
