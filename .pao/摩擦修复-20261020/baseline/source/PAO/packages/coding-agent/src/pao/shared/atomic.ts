import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 原子写：同目录临时文件 + rename。
 *
 * Windows 行为依据：Node 的 fs.rename 在 Windows 走 libuv 的 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，
 * 通常可以覆盖已存在的目标文件；但目标被其他句柄短暂占用（杀软扫描、并发读）时会抛 EPERM。
 * 处理：rename 失败立即重试两次，仍失败回退 copyFile+unlink（最后手段，非严格原子，仅防丢数据）。
 * 临时文件与目标同目录，保证 rename 不跨卷。
 */
export function writeFileAtomic(filePath: string, data: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, data, "utf8");
		let renamed = false;
		for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
			try {
				renameSync(tmp, filePath);
				renamed = true;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// 仅对 Windows 占用类错误重试；其余（如目标目录不存在）直接走回退
				if (code !== "EPERM" && code !== "EACCES") break;
			}
		}
		if (!renamed) {
			copyFileSync(tmp, filePath);
			unlinkSync(tmp);
		}
	} finally {
		if (existsSync(tmp)) {
			try {
				unlinkSync(tmp);
			} catch {
				// 清理失败不掩盖主流程结果
			}
		}
	}
}
