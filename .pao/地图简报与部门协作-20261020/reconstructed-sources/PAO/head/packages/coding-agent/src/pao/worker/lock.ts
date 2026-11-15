import { mkdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";

import lockfile from "proper-lockfile";

import { isLockHeldError } from "../shared/lock.ts";
import { PaoWorkerError } from "./errors.ts";
import { StopProof } from "./runner.ts";

/**
 * 项目写锁原语(架构 R06:只管受 PAO 调度的写,不承诺拦外部编辑器)。
 *
 * 实现用 proper-lockfile(mkdir 原子性,Windows 跨进程安全,与 cards/dept 同款依赖),
 * 锁目标 = <项目根>/.pao/项目锁(空标记文件),锁目录 = 其旁的 项目锁.lock。
 * 项目根先 realpath 规范化,Windows 大小写/别名(短路径、符号链接)落到同一物理目录即同一把锁。
 *
 * 契约:acquireProjectLock 与 releaseProjectLock 必须成对;放锁必须出示运行器签发的
 * StopProof(先停后放锁,架构 R05)。持锁进程崩溃后锁目录残留,按 stale(默认 24h)过期,
 * 不提供自动清锁——R05 定案「异常重启不自动清锁重跑」,由人决定。
 */

export interface ProjectWriteLock {
	/** 规范化后的项目根 */
	项目根: string;
	/** 锁目标文件路径 */
	锁路径: string;
	持有者: string;
	获得时间: string;
}

export interface AcquireLockOptions {
	项目根: string;
	持有者: string;
	/** 获取锁重试次数,默认 0(拿不到立即报锁被占用,由调用方决定等待策略) */
	重试?: number;
}

/** 释放函数不放进锁对象(保持可序列化),存模块级 WeakMap */
const pendingRelease = new WeakMap<ProjectWriteLock, () => Promise<void>>();

async function canonicalDir(dir: string): Promise<string> {
	try {
		return await realpath(dir);
	} catch {
		throw new PaoWorkerError("无效参数", `项目根不存在:${dir}`);
	}
}

/** 取项目写锁。项目根必须已存在;拿不到锁抛 PaoWorkerError("锁被占用")。 */
export async function acquireProjectLock(options: AcquireLockOptions): Promise<ProjectWriteLock> {
	const projectRoot = await canonicalDir(options.项目根);
	const paoDir = path.join(projectRoot, ".pao");
	await mkdir(paoDir, { recursive: true });
	const lockPath = path.join(paoDir, "项目锁");
	await writeFile(lockPath, "", { flag: "a" });
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(lockPath, {
			realpath: false,
			stale: 24 * 60 * 60 * 1000,
			retries: { retries: options.重试 ?? 0, minTimeout: 100, maxTimeout: 1000, factor: 2, randomize: false },
		});
	} catch (error) {
		if (isLockHeldError(error)) {
			throw new PaoWorkerError("锁被占用", `项目写锁被占用:${lockPath}`, { 锁路径: lockPath, cause: String(error) });
		}
		throw error;
	}
	const lock: ProjectWriteLock = {
		项目根: projectRoot,
		锁路径: lockPath,
		持有者: options.持有者,
		获得时间: new Date().toISOString(),
	};
	pendingRelease.set(lock, release);
	return lock;
}

/**
 * 释放项目写锁。必须出示 cancel/stopAll 签发的 StopProof——运行器确认进程真停后才可能拿到凭据,
 * 「先停后放锁」由此在类型与运行期双重强制。
 */
export async function releaseProjectLock(lock: ProjectWriteLock, proof: StopProof): Promise<void> {
	if (!(proof instanceof StopProof)) {
		throw new PaoWorkerError("无效凭据", "释放项目写锁必须出示运行器签发的停止确认凭据(先停后放锁)");
	}
	const release = pendingRelease.get(lock);
	if (!release) {
		throw new PaoWorkerError("无效凭据", "锁句柄无效或已释放", { 锁路径: lock.锁路径 });
	}
	pendingRelease.delete(lock);
	await release();
}

/**
 * 查询项目是否被占(纯读,不清锁)。提示性检查——真正的互斥由 acquireProjectLock 强制,
 * 这里误报/漏报不会造成并发写。读失败如实上抛:proper-lockfile 的 check 已把「锁目录不存在
 * (ENOENT)」归一为 false,其余错误(权限/IO)不再吞成「未锁」——误判未锁会掩盖真问题。
 */
export async function isProjectLocked(projectRoot: string): Promise<boolean> {
	const root = await canonicalDir(projectRoot);
	const lockPath = path.join(root, ".pao", "项目锁");
	return await lockfile.check(lockPath, { realpath: false });
}
