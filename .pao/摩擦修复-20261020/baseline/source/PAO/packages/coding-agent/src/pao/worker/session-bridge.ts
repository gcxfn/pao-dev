import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { utcNow } from "../shared/time.ts";

/** 每次执行独占一份映射日志；父进程崩溃留下“启动/运行中”，不能误读成成功。 */
export interface WorkerSessionBridge {
	执行标识: string;
	会话目录: string;
	映射路径: string;
	record(status: string, detail?: Record<string, unknown>): void;
	sessionPath(): string | undefined;
}

export function createWorkerSessionBridge(input: {
	项目根: string;
	卡路径: string;
	尝试: number;
	执行标识: string;
}): WorkerSessionBridge {
	const projectRoot = resolve(input.项目根);
	const sessionDir = join(projectRoot, ".pao", "worker会话");
	const mappingDir = join(projectRoot, ".pao", "执行映射");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(mappingDir, { recursive: true });
	const mappedPath = join(mappingDir, `${input.执行标识}.jsonl`);
	const identity = {
		...input,
		项目根: projectRoot,
		卡路径: resolve(input.卡路径),
		会话目录: sessionDir,
		ownerPid: process.pid,
	};
	writeFileSync(mappedPath, `${JSON.stringify({ ...identity, 状态: "启动", 时间: utcNow() })}\n`, { flag: "wx" });
	return {
		执行标识: input.执行标识,
		会话目录: sessionDir,
		映射路径: mappedPath,
		record: (status, detail = {}) => {
			appendFileSync(mappedPath, `${JSON.stringify({ ...detail, ...identity, 状态: status, 时间: utcNow() })}\n`);
		},
		sessionPath: () => {
			const matches = readdirSync(sessionDir).filter((name) => name.endsWith(`_${input.执行标识}.jsonl`));
			if (matches.length > 1) throw new Error(`执行标识对应多份会话：${input.执行标识}`);
			return matches[0] ? join(sessionDir, matches[0]) : undefined;
		},
	};
}
