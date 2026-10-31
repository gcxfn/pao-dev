import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { acquireExecutionLock, detectExecutionOccupancy, releaseDispatchLock } from "../../src/pao/worker/lock.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { createLocalPaoWorktreeHost } from "../../src/pao/worktrees/local-host/index.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("I2-3a 默认共享工作目录工厂的清理保护", () => {
	test("真实执行 lease 存在时拒绝删除并保留 lease 与工作目录", async () => {
		const fixture = await makeFixture("active-lease");
		const host = createHost(fixture);
		const binding = await host.create({ requestId: "create-active-lease", projectRoot: fixture.repo });
		if (binding.kind !== "managed") throw new Error("默认工厂应当创建受管工作目录。");

		const lock = await acquireExecutionLock({
			root: binding.executionRoot,
			holder: "I2-3a 活动执行 lease",
		});
		try {
			await expect(detectExecutionOccupancy(binding.executionRoot)).resolves.toBe("active");
			await expect(
				host.requestCleanup({
					requestId: "cleanup-active-lease",
					projectRoot: fixture.repo,
					worktreeId: binding.worktreeId,
					reason: "验证活动执行 lease 保护",
					executionActive: false,
				}),
			).resolves.toMatchObject({
				ok: false,
				retained: true,
				reason: expect.stringMatching(/正在使用|活动任务/),
			});

			expect((await stat(binding.executionRoot)).isDirectory()).toBe(true);
			expect(existsSync(join(binding.executionRoot, ".pao", "执行占位.json"))).toBe(true);
			expect(existsSync(join(binding.executionRoot, ".pao", "执行锁.lock"))).toBe(true);
			expect(await git(binding.executionRoot, "branch", "--show-current")).toBe(binding.branchName);
		} finally {
			const proof = new WorkerRunner().confirmStopped("I2-3a 活动执行 lease");
			await releaseDispatchLock(lock, proof);
		}
	});

	test("未合并成果拒绝清理并保留分支与工作目录", async () => {
		const fixture = await makeFixture("unmerged");
		const host = createHost(fixture);
		const binding = await host.create({ requestId: "create-unmerged", projectRoot: fixture.repo });
		if (binding.kind !== "managed") throw new Error("默认工厂应当创建受管工作目录。");

		await writeFile(join(binding.executionRoot, "未合并成果.txt"), "只存在于受管分支\n");
		await git(binding.executionRoot, "add", "未合并成果.txt");
		await git(binding.executionRoot, "commit", "-qm", "未合并成果");

		await expect(
			host.requestCleanup({
				requestId: "cleanup-unmerged",
				projectRoot: fixture.repo,
				worktreeId: binding.worktreeId,
				reason: "验证未合并成果保护",
				executionActive: false,
			}),
		).resolves.toMatchObject({
			ok: false,
			retained: true,
			reason: expect.stringMatching(/尚未合入/),
		});

		expect((await stat(binding.executionRoot)).isDirectory()).toBe(true);
		expect(await git(fixture.repo, "show-ref", "--verify", `refs/heads/${binding.branchName}`)).toContain(
			`refs/heads/${binding.branchName}`,
		);
		expect(await git(binding.executionRoot, "branch", "--show-current")).toBe(binding.branchName);
	});

	test("用户自建工作目录不能借绑定 ID 被接管或删除", async () => {
		const fixture = await makeFixture("user-owned");
		const userWorktree = join(fixture.root, "用户工作目录");
		await git(fixture.repo, "worktree", "add", "-b", "user/manual", userWorktree, "HEAD");
		const worktreeId = await realpath(userWorktree);
		const host = createHost(fixture);

		await expect(
			host.resolveForDispatch({
				requestId: "resolve-user-owned",
				projectRoot: fixture.repo,
				target: { kind: "managed", worktreeId },
			}),
		).rejects.toThrow(/不在应用目录根内/);
		await expect(
			host.requestCleanup({
				requestId: "cleanup-user-owned",
				projectRoot: fixture.repo,
				worktreeId,
				reason: "验证用户自建工作目录保护",
				executionActive: false,
			}),
		).resolves.toMatchObject({
			ok: false,
			retained: true,
			reason: expect.stringMatching(/路径不在应用工作目录根内/),
		});

		expect((await stat(userWorktree)).isDirectory()).toBe(true);
		expect(await git(userWorktree, "branch", "--show-current")).toBe("user/manual");
		expect(await git(fixture.repo, "show-ref", "--verify", "refs/heads/user/manual")).toContain(
			"refs/heads/user/manual",
		);
	});

	test("干净且已合入的受管工作目录允许清理，相同请求重放保持幂等", async () => {
		const fixture = await makeFixture("clean-merged");
		const host = createHost(fixture);
		const binding = await host.create({ requestId: "create-clean-merged", projectRoot: fixture.repo });
		if (binding.kind !== "managed") throw new Error("默认工厂应当创建受管工作目录。");
		const request = {
			requestId: "cleanup-clean-merged",
			projectRoot: fixture.repo,
			worktreeId: binding.worktreeId,
			reason: "验证干净已合入成果清理",
			executionActive: false as const,
		};

		await expect(host.requestCleanup(request)).resolves.toEqual({
			ok: true,
			released: true,
			branchDeleted: false,
		});
		await expect(stat(binding.executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await git(fixture.repo, "show-ref", "--verify", `refs/heads/${binding.branchName}`)).toContain(
			`refs/heads/${binding.branchName}`,
		);

		await expect(host.requestCleanup(request)).resolves.toEqual({
			ok: true,
			released: true,
			branchDeleted: false,
		});
		const state = JSON.parse(await readFile(join(fixture.stateRoot, "pao-worktree-host.json"), "utf8")) as {
			readonly cleanups: Readonly<Record<string, unknown>>;
		};
		expect(Object.keys(state.cleanups)).toEqual([request.requestId]);
	});

	test("损坏的执行占位以真实磁盘故障形成 unknown，并拒绝清理且保留占位", async () => {
		const fixture = await makeFixture("unknown-occupancy");
		const host = createHost(fixture);
		const binding = await host.create({ requestId: "create-unknown", projectRoot: fixture.repo });
		if (binding.kind !== "managed") throw new Error("默认工厂应当创建受管工作目录。");
		const reservation = join(binding.executionRoot, ".pao", "执行占位.json");
		await mkdir(dirname(reservation), { recursive: true });
		await writeFile(reservation, "{损坏的执行占位", "utf8");

		await expect(detectExecutionOccupancy(binding.executionRoot)).resolves.toBe("unknown");
		await expect(
			host.requestCleanup({
				requestId: "cleanup-unknown",
				projectRoot: fixture.repo,
				worktreeId: binding.worktreeId,
				reason: "验证未知停止状态下保留现场",
				executionActive: false,
			}),
		).resolves.toMatchObject({
			ok: false,
			retained: true,
			reason: expect.stringMatching(/占用状态未知/),
		});

		expect((await stat(binding.executionRoot)).isDirectory()).toBe(true);
		expect(await readFile(reservation, "utf8")).toBe("{损坏的执行占位");
	});
});

interface Fixture {
	readonly root: string;
	readonly repo: string;
	readonly stateRoot: string;
}

function createHost(fixture: Fixture) {
	return createLocalPaoWorktreeHost({
		stateRoot: fixture.stateRoot,
		projectRoot: fixture.repo,
	});
}

async function makeFixture(label: string): Promise<Fixture> {
	const paoHome = process.env.PAO_HOME?.trim();
	if (!paoHome) throw new Error("I2-3a 真实 Git 测试必须显式设置 PAO_HOME，夹具不会写入系统临时目录。");
	if (!isAbsolute(paoHome)) throw new Error(`I2-3a 测试的 PAO_HOME 必须是绝对路径：${paoHome}`);
	const fixtureParent = dirname(resolve(paoHome));
	await mkdir(fixtureParent, { recursive: true });
	const root = await mkdtemp(join(fixtureParent, `pao-i2-3a-${label}-`));
	temporaryRoots.push(root);
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "i2-3a@example.com");
	await git(repo, "config", "user.name", "I2-3a 真实 Git 测试");
	await git(repo, "config", "core.autocrlf", "false");
	await writeFile(join(repo, ".gitignore"), ".pao/\n");
	await writeFile(join(repo, "tracked.txt"), "committed\n");
	await git(repo, "add", ".gitignore", "tracked.txt");
	await git(repo, "commit", "-qm", "seed");
	return { root, repo, stateRoot: join(root, "state") };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: isolatedEnvironment(dirname(cwd)),
		windowsHide: true,
	});
	return stdout.trim();
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.startsWith("GIT_")) delete environment[key];
	}
	return {
		...environment,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
		PAO_HOME: join(root, "pao-home"),
		PI_CODING_AGENT_DIR: join(root, "coding-agent"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}
