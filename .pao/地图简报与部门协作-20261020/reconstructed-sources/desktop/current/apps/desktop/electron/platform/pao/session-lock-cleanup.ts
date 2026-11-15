/**
 * 桌面启动期的死会话锁回收。内核 runtime/session-lock.ts 在
 * <PAO_HOME>/.pao/运行时锁/ 落 <sha256(sessionId)>.json（owner 元数据）与
 * proper-lockfile 的 <同名>.lock 目录等残渣；进程被强杀后 owner json 残留，
 * 新进程 acquire 时报「残留会话锁须显式接管」。桌面宿主在启动早期
 * （任何画布/会话驱动 acquire 之前）按「owner pid 已死或身份损坏」做文件级回收；
 * 活 pid（含复用者）一律不动——宁可漏清不可误杀活会话。
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** 运行时锁目录快照的一条记录；只有 owner json 有内容，残渣目录无内容。 */
export interface SessionLockEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly content?: string;
}

function ownerPidOf(entry: SessionLockEntry): { alive: boolean; pid?: number } {
  if (entry.isDirectory) return { alive: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content ?? "");
  } catch {
    // json 损坏：身份损坏拒绝自动接管的同口径，启动回收直接清走。
    return { alive: false };
  }
  const pid = (parsed as { pid?: unknown } | null)?.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return { alive: false };
  return { alive: true, pid };
}

/**
 * 纯决策：给定目录快照与活 pid 集合，返回应删除的文件名清单。
 * 只处理带 owner json 的基名组：pid 死或 json 损坏 → 删 json 与全部同名前缀残渣；
 * pid 活（含 pid 复用为活进程）→ 全组不动；无 json 的孤儿残渣不动（stale 自愈）。
 */
export function planSessionLockCleanup(
  entries: readonly SessionLockEntry[],
  livePids: ReadonlySet<number>,
): readonly string[] {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const doomed = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const base = entry.name.slice(0, -".json".length);
    const { alive, pid } = ownerPidOf(entry);
    if (alive && pid !== undefined && livePids.has(pid)) continue;
    for (const candidate of byName.keys()) {
      if (candidate === entry.name || candidate.startsWith(`${base}.`)) {
        doomed.add(candidate);
      }
    }
  }
  return [...doomed];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 活着但无权限的进程也会抛 EPERM：按活处理，避免误杀。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 启动接线：读运行时锁目录，清死锁与残渣。目录缺失静默跳过，返回删除条数。 */
export async function cleanupDeadSessionLocks(paoHome: string | undefined): Promise<number> {
  if (!paoHome) return 0;
  const dir = join(paoHome, ".pao", "运行时锁");
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const entries: SessionLockEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) {
      entries.push({ name: dirent.name, isDirectory: true });
      continue;
    }
    let content: string | undefined;
    if (dirent.name.endsWith(".json")) {
      content = await readFile(join(dir, dirent.name), "utf8").catch(() => "");
    }
    entries.push({ name: dirent.name, isDirectory: false, content });
  }
  const candidatePids = new Set<number>();
  for (const entry of entries) {
    const { alive, pid } = ownerPidOf(entry);
    if (alive && pid !== undefined) candidatePids.add(pid);
  }
  const livePids = new Set([...candidatePids].filter(isPidAlive));
  const doomed = planSessionLockCleanup(entries, livePids);
  for (const name of doomed) {
    await rm(join(dir, name), { recursive: true, force: true });
  }
  return doomed.length;
}
