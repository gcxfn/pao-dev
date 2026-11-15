import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 原子写：同目录临时文件 + rename。
 *
 * Windows 行为依据：Node 的 fs.rename 在 Windows 走 libuv 的 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，
 * 通常可以覆盖已存在的目标文件；但目标被其他句柄短暂占用（杀软扫描、并发读）时会抛 EPERM。
 * 处理：占用类错误立即重试两次；仍失败则保留原目标并报错，不退回普通覆盖。
 * 临时文件与目标同目录，保证 rename 不跨卷；这不承诺断电持久性。
 */
export function writeFileAtomic(filePath: string, data: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, data, "utf8");
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				renameSync(tmp, filePath);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (attempt === 2 || (code !== "EPERM" && code !== "EACCES")) throw error;
			}
		}
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch (cleanupError) {
			if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new AggregateError(
					[error, cleanupError],
					`原子写入失败：${String(error)}；临时文件清理失败：${String(cleanupError)}；目标：${filePath}`,
					{
						cause: error,
					},
				);
			}
		}
		throw error;
	}
}
