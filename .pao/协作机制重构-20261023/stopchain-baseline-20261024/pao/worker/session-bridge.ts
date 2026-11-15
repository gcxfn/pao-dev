import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathKey } from "../shared/path-key.ts";
import { utcNow } from "../shared/time.ts";

/** 每次执行独占一份映射日志；父进程崩溃留下“启动/运行中”，不能误读成成功。 */
export interface WorkerSessionBridge {
	执行标识: string;
	会话目录: string;
	映射路径: string;
	延续会话?: string;
	record(status: string, detail?: Record<string, unknown>): void;
	sessionPath(): string | undefined;
}

export function createWorkerSessionBridge(input: {
	任务根?: string;
	/** 旧调用兼容；任务根是唯一正本。 */
	项目根?: string;
	卡路径: string;
	尝试: number;
	执行标识: string;
	executionRoot?: string;
	worktreeId?: string;
	snapshotDigest?: string;
	worktreeBindingDigest?: string;
	executionBindingDigest?: string;
}): WorkerSessionBridge {
	const root = input.任务根 ?? input.项目根;
	if (!root) throw new Error("createWorkerSessionBridge 缺少任务根");
	const taskRoot = resolve(root);
	const sessionDir = join(taskRoot, ".pao", "worker会话");
	const mappingDir = join(taskRoot, ".pao", "执行映射");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(mappingDir, { recursive: true });
	const mappedPath = join(mappingDir, `${input.执行标识}.jsonl`);
	// 只延续本卡上一尝试已结算的会话；运行中、未知、换执行根和旧格式均新开。
	const candidates: string[] = [];
	const recoveryNotes: string[] = [];
	if (input.尝试 > 1 && input.executionRoot) {
		for (const name of readdirSync(mappingDir).filter((name) => name.endsWith(".jsonl"))) {
			const lines = readFileSync(join(mappingDir, name), "utf8").trim().split("\n");
			let previous: Record<string, unknown>;
			try {
				const first = JSON.parse(lines[0]);
				if (first.卡路径 !== resolve(input.卡路径) || first.尝试 !== input.尝试 - 1) continue;
				previous = JSON.parse(lines.at(-1)!);
			} catch {
				throw new Error(`执行映射损坏，须核查后重试：${join(mappingDir, name)}`);
			}
			if (previous.卡路径 !== resolve(input.卡路径) || previous.尝试 !== input.尝试 - 1) continue;
			if (!["success", "failed"].includes(String(previous.状态)) || typeof previous.会话路径 !== "string") continue;
			if (
				previous.executionRoot !== resolve(input.executionRoot) ||
				previous.worktreeId !== input.worktreeId ||
				previous.worktreeBindingDigest !== input.worktreeBindingDigest
			)
				continue;
			let sessionPath: string;
			try {
				sessionPath = realpathSync(previous.会话路径);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				recoveryNotes.push(`上一尝试会话已不存在，新开会话：${previous.会话路径}`);
				continue;
			}
			if (pathKey(dirname(sessionPath)) !== pathKey(realpathSync(sessionDir)))
				throw new Error(`会话不在本任务受管目录，拒绝延续：${sessionPath}`);
			const header = JSON.parse(readFileSync(sessionPath, "utf8").split("\n", 1)[0]);
			if (
				header.type !== "session" ||
				typeof header.cwd !== "string" ||
				pathKey(resolve(header.cwd)) !== pathKey(resolve(input.executionRoot))
			)
				continue;
			candidates.push(sessionPath);
		}
	}
	if (candidates.length > 1) throw new Error("上一尝试存在多份可延续会话，保留现场核查");
	const resumedSession = candidates[0];
	const identity = {
		...input,
		任务根: taskRoot,
		卡路径: resolve(input.卡路径),
		会话目录: sessionDir,
		ownerPid: process.pid,
		...(resumedSession ? { 延续会话: resumedSession } : {}),
		...(recoveryNotes.length ? { 会话恢复说明: recoveryNotes } : {}),
	};
	writeFileSync(mappedPath, `${JSON.stringify({ ...identity, 状态: "启动", 时间: utcNow() })}\n`, { flag: "wx" });
	return {
		执行标识: input.执行标识,
		会话目录: sessionDir,
		映射路径: mappedPath,
		延续会话: resumedSession,
		record: (status, detail = {}) => {
			appendFileSync(mappedPath, `${JSON.stringify({ ...detail, ...identity, 状态: status, 时间: utcNow() })}\n`);
		},
		sessionPath: () => {
			if (resumedSession) return resumedSession;
			const matches = readdirSync(sessionDir).filter((name) => name.endsWith(`_${input.执行标识}.jsonl`));
			if (matches.length > 1) throw new Error(`执行标识对应多份会话：${input.执行标识}`);
			return matches[0] ? join(sessionDir, matches[0]) : undefined;
		},
	};
}
