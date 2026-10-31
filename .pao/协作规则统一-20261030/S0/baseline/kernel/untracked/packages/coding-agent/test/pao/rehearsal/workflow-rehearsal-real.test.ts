/**
 * 用途：显式开启时运行同 kit、真实产品进程与隔离 Git 的离线正常链，再独立核验证据。
 * 输入：显式 PAO_HOME 与 PAO_REHEARSAL_REAL=1；输出：保留在工作区临时父目录的彩排证据。
 * 边界：只使用回环脚本模型，不访问真实供应商、Docker 或正式 PAO_HOME。
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../..");
const WORKSPACE_TEMP = resolve(REPO_ROOT, "../临时文件夹/PAO彩排-20261030");
const RUNNER = resolve(REPO_ROOT, "bench/rehearsal/run-rehearsal.mjs");
const VERIFIER = resolve(REPO_ROOT, "bench/rehearsal/verify-evidence.mjs");
const realRehearsal = process.env.PAO_REHEARSAL_REAL === "1" ? it : it.skip;

function isWithin(parent: string, candidate: string): boolean {
	const child = relative(parent, candidate);
	return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

function isolatedHome(): string {
	const configured = process.env.PAO_HOME?.trim();
	if (!configured) {
		throw new Error("测试前置错误：必须显式设置工作区内的隔离 PAO_HOME");
	}
	const home = resolve(configured);
	if (!isWithin(WORKSPACE_TEMP, home)) {
		throw new Error(`测试前置错误：PAO_HOME 必须位于 ${WORKSPACE_TEMP}`);
	}
	mkdirSync(home, { recursive: true });
	return home;
}

describe("同 kit 正常链黑盒彩排", () => {
	realRehearsal(
		"正式产品 CLI、部长、工人与 Git 全链通过并保留证据",
		{ timeout: 660_000 },
		() => {
			const paoHome = isolatedHome();
			const output = resolve(WORKSPACE_TEMP, `I5-2-vitest-${randomUUID()}`);
			const env = {
				...process.env,
				PAO_HOME: paoHome,
				PAO_CODING_AGENT_DIR: resolve(WORKSPACE_TEMP, "vitest-agent-dir"),
				PAO_WORKTREE_STATE_ROOT: resolve(WORKSPACE_TEMP, "vitest-worktree-state"),
				PI_OFFLINE: "1",
				PI_NO_LOCAL_LLM: "1",
			};
			const run = spawnSync(process.execPath, [RUNNER, "--output", output], {
				cwd: REPO_ROOT,
				env,
				encoding: "utf8",
				timeout: 620_000,
				windowsHide: true,
			});
			expect(run.status, `${output}\n${run.stderr || run.stdout}`).toBe(0);

			const verification = spawnSync(process.execPath, [VERIFIER, resolve(output, "evidence")], {
				cwd: REPO_ROOT,
				env,
				encoding: "utf8",
				timeout: 60_000,
				windowsHide: true,
			});
			expect(verification.status, verification.stderr || verification.stdout).toBe(0);
			const result = JSON.parse(readFileSync(resolve(output, "evidence/verification.json"), "utf8")) as {
				ok?: unknown;
				controlStatusFromYaml?: unknown;
			};
			expect(result.ok).toBe(true);
			expect(result.controlStatusFromYaml).toBe("已完成");
			process.stdout.write(`I5-2 彩排证据：${output}\n`);
		},
	);
});
