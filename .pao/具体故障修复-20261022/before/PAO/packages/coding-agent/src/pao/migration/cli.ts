/**
 * S9 迁移工具 CLI（独立入口，不挂扩展注册表）：
 *   node src/pao/migration/cli.ts migrate --root <目录> [--dry-run] [--backup-dir <目录>] [--sleep-ms <毫秒>]
 *   node src/pao/migration/cli.ts list-sessions --root <会话根目录>
 *
 * --root 必填（不猜默认）。逐文件结果与汇总以 JSONL 打到 stdout；错误打到 stderr。
 * 退出码：0 成功；1 存在冲突/错误；2 用法错误。
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCardMigration } from "./migrate.ts";
import { listSessionDirs } from "./sessions.ts";

const USAGE = `用法：
  migrate --root <目录> [--dry-run] [--backup-dir <目录>] [--sleep-ms <毫秒>]
  list-sessions --root <会话根目录>`;

function parseArgs(argv: string[]): { command: string; flags: Map<string, string | true> } {
	const [command, ...rest] = argv;
	const flags = new Map<string, string | true>();
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (!arg.startsWith("--")) throw new Error(`无法识别的参数：${arg}\n${USAGE}`);
		const name = arg.slice(2);
		const value = rest[i + 1];
		if (value === undefined || value.startsWith("--")) {
			flags.set(name, true); // 布尔旗标（如 --dry-run）
			continue;
		}
		flags.set(name, value);
		i++;
	}
	return { command, flags };
}

async function main(): Promise<number> {
	const { command, flags } = parseArgs(process.argv.slice(2));
	const rootFlag = flags.get("root");
	const root = typeof rootFlag === "string" && rootFlag.length > 0 ? rootFlag : undefined;
	const backupDir = typeof flags.get("backup-dir") === "string" ? (flags.get("backup-dir") as string) : undefined;
	const sleepMs =
		typeof flags.get("sleep-ms") === "string" ? Number.parseInt(flags.get("sleep-ms") as string, 10) || 0 : 0;
	if (command === "migrate") {
		if (!root) {
			process.stderr.write(`migrate 需要 --root <目录>（显式目标根，必填，不猜默认）\n${USAGE}\n`);
			return 2;
		}
		try {
			const run = runCardMigration(root, {
				dryRun: flags.get("dry-run") === true,
				backupDir,
				sleepMs,
				onResult: (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
			});
			const summary = {
				summary: {
					root,
					dryRun: flags.get("dry-run") === true,
					files: run.results.length,
					migrated: run.results.filter((r) => r.status === "migrated").length,
					wouldMigrate: run.results.filter((r) => r.status === "would-migrate").length,
					unchanged: run.results.filter((r) => r.status === "unchanged").length,
					conflicts: run.results.filter((r) => r.status === "conflict").length,
					errors: run.results.filter((r) => r.status === "error").length,
					exitCode: run.exitCode,
				},
			};
			process.stdout.write(`${JSON.stringify(summary)}\n`);
			return run.exitCode;
		} catch (error) {
			process.stderr.write(`${(error as Error).message}\n`);
			return 2;
		}
	}
	if (command === "list-sessions") {
		if (!root) {
			process.stderr.write(`list-sessions 需要 --root <会话根目录>（必填，不猜默认；只列不删）\n${USAGE}\n`);
			return 2;
		}
		try {
			const dirs = listSessionDirs(root);
			for (const info of dirs) process.stdout.write(`${JSON.stringify(info)}\n`);
			const total = dirs.reduce((sum, d) => sum + d.sessions, 0);
			process.stdout.write(
				`${JSON.stringify({ summary: { dirs: dirs.length, sessions: total, note: "只列不删；正式删除须 S12 授权" } })}\n`,
			);
			return 0;
		} catch (error) {
			process.stderr.write(`${(error as Error).message}\n`);
			return 2;
		}
	}
	process.stderr.write(`未知子命令：${command ?? "(空)"}\n${USAGE}\n`);
	return 2;
}

const invokedAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
	main().then(
		(code) => process.exit(code),
		(error) => {
			process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
			process.exit(2);
		},
	);
}
