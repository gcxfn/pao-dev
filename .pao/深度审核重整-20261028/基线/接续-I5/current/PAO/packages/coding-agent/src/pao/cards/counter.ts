import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeFileAtomic } from "../shared/atomic.ts";
import { withFileLock } from "../shared/lock.ts";
import { PaoCardError } from "./errors.ts";

/**
 * 旧落点（摩擦日志 2026-10-02「卡号计数器双写」）：M1 时期在仓库根写过 卡号.txt，
 * 与项目编排目录 .pao/卡号.txt 并存，有重号风险。新落点在 .pao 下时旧落点即其上级目录的
 * 卡号.txt；计数器不在 .pao 下（调用方自定布局）无从推断，返回 null 不做兼容读。
 */
function legacyCounterPath(counterPath: string): string | null {
	const parent = dirname(counterPath);
	if (basename(parent).toLowerCase() !== ".pao") return null;
	const legacy = join(parent, "..", "卡号.txt");
	return legacy === counterPath ? null : legacy;
}

/** 读计数器账面：缺失/空/非正数一律按 0，读不了不阻断发号。 */
function readCount(path: string | null): number {
	if (!path || !existsSync(path)) return 0;
	try {
		const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	} catch {
		return 0;
	}
}

/**
 * 卡号发号器：按项目独立递增，计数器文件一行存当前最大号。
 * 跨进程安全 = withFileLock（proper-lockfile，mkdir 原子性，Windows 可用，见 shared/lock.ts 依据）。
 * 计数器路径由调用方传入（约定 `<项目>/.pao/卡号.txt`，见 createCard 默认值推导）。
 * 落点统一：写入只写该路径；读取兼容旧落点（仓库根 卡号.txt），旧值更大时取旧值续发，
 * 旧文件原样保留不回写，让其自然废弃。
 */
export async function nextCardNumber(counterPath: string, signal?: AbortSignal): Promise<number> {
	signal?.throwIfAborted();
	const legacyPath = legacyCounterPath(counterPath);
	// 锁前确保计数器存在：proper-lockfile 的 stale 检查基于锁目录而非目标文件，
	// 目标缺失也能锁，但首次并发初建统一写旧账面值（无旧账写 0）无害，避免读时才建
	if (!existsSync(counterPath)) {
		writeFileAtomic(counterPath, `${readCount(legacyPath)}\n`);
	}
	return withFileLock(counterPath, () => {
		// 等待锁时可能收到取消；发号前检查，锁仍由 withFileLock 正常释放。
		signal?.throwIfAborted();
		// 双写时代旧文件可能仍被旧代码推进：基线取新落点与旧落点的较大值
		const current = Math.max(readCount(counterPath), readCount(legacyPath));
		const next = current + 1;
		writeFileAtomic(counterPath, `${next}\n`);
		return next;
	});
}

/** 卡号 → 文件名/引用用的四位编号（卡0001）。 */
export function formatCardNumber(n: number): string {
	return `卡${String(n).padStart(4, "0")}`;
}

/** 解析卡引用：接受 "卡0017" / "卡#17" / "17"。 */
export function parseCardRef(ref: string): number {
	const match = /^(?:卡#?)?0*(\d+)$/.exec(ref.trim());
	if (!match) {
		throw new PaoCardError("INVALID_CARD", `无法识别的卡引用：${ref}`, { ref });
	}
	return Number.parseInt(match[1], 10);
}
