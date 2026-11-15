import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Suffix of the transient files writeFileAtomic creates before renaming into place. */
export const TMP_SUFFIX = ".tmp";

let tmpCounter = 0;

/**
 * Write `data` to `filePath` durably. A concurrent reader or a crash at any
 * point always observes either the previous file contents or the fully-written
 * new contents — never a missing, truncated, or partially-written file.
 *
 * Steps:
 * - Write to a uniquely-named temp file in the same directory and fsync it.
 * - rename() straight over the target (atomic replace on POSIX). There is no
 *   unlink first, so a crash in the write window cannot leave the target gone.
 * - fsync the containing directory so the rename entry itself survives power
 *   loss, not just the temp file's data blocks.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  // Collision-safe temp name: a pid + monotonic counter + randomness so two
  // writers, or two writes within the same millisecond, never share a path
  // (Date.now() alone is not unique under concurrent writes).
  tmpCounter = (tmpCounter + 1) >>> 0;
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`;

  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameRetrying(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  await syncDirectory(dir);
}

/**
 * Windows rejects rename-over-target with EPERM/EBUSY while another handle
 * (reader, indexer, antivirus) holds the target open without FILE_SHARE_DELETE;
 * POSIX allows the overwrite. Those holds are brief, so retry a few times with
 * a short backoff before surfacing the error. No locking — the retry window
 * covers the observed race.
 */
const RENAME_RETRIES = 3;
const RENAME_BACKOFF_MS = 25;

async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * (attempt + 1)));
    }
  }
}

/** Serialize `value` as pretty JSON with a trailing newline and write it atomically. */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
  } catch {
    // Some platforms (notably Windows) reject opening a directory for fsync.
    // The rename above is still atomic; skip the extra durability step.
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Best effort — a failed directory fsync must not fail the write.
  } finally {
    await handle.close();
  }
}
