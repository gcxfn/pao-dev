/**
 * S9 历史会话目录清单（只列不删）。
 * 历史会话的处置方案是删除而非渲染兼容（S9 第 5 条）；正式删除是 S12 授权后的动作，
 * 本模块只提供清单：给定会话根（pi 会话布局 `<configDir>/agent/sessions/<编码后cwd>/*.jsonl`），
 * 逐目录报 jsonl 数、字节数、最后修改时间。显式根必填，不猜默认位置。
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SessionDirInfo {
	/** 编码后的 cwd 目录名（相对会话根）。 */
	dir: string;
	/** 目录内 .jsonl 会话文件数。 */
	sessions: number;
	/** 会话文件总字节数。 */
	bytes: number;
	/** 最近一次会话文件修改时间（ISO 字符串）。 */
	lastModified: string;
}

export function listSessionDirs(sessionsRoot: string): SessionDirInfo[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(sessionsRoot, { withFileTypes: true });
	} catch {
		throw new Error(`会话根目录不存在或不可读：${sessionsRoot}（--root 必填，不猜默认）`);
	}
	const infos: SessionDirInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(sessionsRoot, entry.name);
		let sessions = 0;
		let bytes = 0;
		let lastMtimeMs = 0;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".jsonl")) continue;
			sessions++;
			const stat = statSync(join(dir, file));
			bytes += stat.size;
			lastMtimeMs = Math.max(lastMtimeMs, stat.mtimeMs);
		}
		infos.push({
			dir: entry.name,
			sessions,
			bytes,
			lastModified: lastMtimeMs > 0 ? new Date(lastMtimeMs).toISOString() : "",
		});
	}
	return infos.sort((a, b) => a.dir.localeCompare(b.dir));
}
