import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CreateLocalPaoWorktreeHostOptions,
	createLocalPaoWorktreeHost,
} from "../../src/pao/worktrees/local-host/index.ts";
import { createSingleRootWorktreeHost } from "../../src/pao/worktrees/types.ts";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerScript = join(packageRoot, "test/pao/fixtures/local-worktree-process.ts");
const factoryModule = join(packageRoot, "src/pao/worktrees/local-host/index.ts");
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("I2-1 默认共享工作目录工厂", () => {
	test("构造工厂不写磁盘，并从容纳脏改动和未跟踪内容的真实 Git 建立可恢复基线", async () => {
		const fixture = await makeFixture("create");
		await writeFile(join(fixture.repo, "tracked.txt"), "dirty tracked\n");
		await mkdir(join(fixture.repo, "src"), { recursive: true });
		await writeFile(join(fixture.repo, "src", "未跟踪说明.txt"), "related untracked\n");
		await writeFile(join(fixture.repo, "二进制.bin"), Buffer.from([0, 1, 2, 3, 255]));
		await mkdir(join(fixture.repo, "目录甲", "子目录乙"), { recursive: true });
		await mkdir(join(fixture.repo, "目录丙"), { recursive: true });
		await writeFile(join(fixture.repo, "目录甲", "子目录乙", "说明.txt"), "multi directory\n");
		await writeFile(
			join(fixture.repo, "目录丙", "批量二进制.dat"),
			Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37 + 11) % 256)),
		);

		const host = createHost(fixture);
		await expect(stat(fixture.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });

		const binding = await host.create({ requestId: "create-complete", projectRoot: fixture.repo });
		expect(binding.kind).toBe("managed");
		if (binding.kind !== "managed") throw new Error("应当创建受管工作目录");

		expect(binding.executionRoot).toBe(
			await canonicalPath(join(fixture.stateRoot, "worktrees", "repo", binding.branchName.slice(3))),
		);
		expect(await readFile(join(binding.executionRoot, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
		expect(await readFile(join(binding.executionRoot, "src", "未跟踪说明.txt"), "utf8")).toBe("related untracked\n");
		expect(await readFile(join(binding.executionRoot, "目录甲", "子目录乙", "说明.txt"), "utf8")).toBe(
			"multi directory\n",
		);
		expect(
			await gitBytes(
				binding.baseline.snapshotRepositoryPath,
				"show",
				`${binding.baseline.treeId}:目录丙/批量二进制.dat`,
			),
		).toEqual(Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37 + 11) % 256)));
		expect(binding.baseline.coverage).toBe("complete");
		expect(binding.baseline.includedPaths).toEqual(
			expect.arrayContaining([
				"tracked.txt",
				"src/未跟踪说明.txt",
				"目录甲/子目录乙/说明.txt",
				"目录丙/批量二进制.dat",
				"已提交中文.txt",
			]),
		);
		expect(await git(binding.baseline.snapshotRepositoryPath, "cat-file", "-t", binding.baseline.treeId)).toBe(
			"tree",
		);
		expect(
			(
				await git(
					binding.baseline.snapshotRepositoryPath,
					"ls-tree",
					"-r",
					"-z",
					"--name-only",
					binding.baseline.treeId,
				)
			)
				.split("\0")
				.filter(Boolean),
		).toEqual(binding.baseline.includedPaths);
		expect(await objectIds(binding.baseline.snapshotRepositoryPath, binding.baseline.treeId)).toEqual(
			await objectIds(fixture.repo, binding.baseline.treeId),
		);
		expect(await git(binding.executionRoot, "rev-parse", "--show-toplevel")).toBe(
			binding.executionRoot.replaceAll("\\", "/"),
		);
	});

	test("第二个默认工厂从同一状态根解析受管绑定，并校验工作树 ID 与输入版本", async () => {
		const fixture = await makeFixture("resolve");
		const creator = createHost(fixture);
		const created = await creator.create({ requestId: "created-once", projectRoot: fixture.repo });
		if (created.kind !== "managed") throw new Error("应当创建受管工作目录");

		const resolver = createHost(fixture);
		const resolved = await resolver.resolveForDispatch({
			requestId: "resolve-from-another-instance",
			projectRoot: fixture.repo,
			target: { kind: "managed", worktreeId: created.worktreeId },
			expectedInputVersion: created.inputVersion,
		});

		expect(resolved).toMatchObject({
			kind: "managed",
			worktreeId: created.worktreeId,
			executionRoot: created.executionRoot,
			branchName: created.branchName,
			inputVersion: created.inputVersion,
			baseline: created.baseline,
		});
		await expect(
			resolver.resolveForDispatch({
				requestId: "resolve-stale-version",
				projectRoot: fixture.repo,
				target: { kind: "managed", worktreeId: created.worktreeId },
				expectedInputVersion: "0".repeat(40),
			}),
		).rejects.toThrow(/输入版本已变化/);
	});

	test("跨实例重放同一请求返回原绑定且不重复创建记录", async () => {
		const fixture = await makeFixture("replay");
		const created = await createHost(fixture).create({
			requestId: "same-request",
			projectRoot: fixture.repo,
		});
		const replayed = await createHost(fixture).create({
			requestId: "same-request",
			projectRoot: fixture.repo,
		});

		expect(replayed).toEqual(created);
		const state = JSON.parse(await readFile(join(fixture.stateRoot, "pao-worktree-host.json"), "utf8")) as {
			readonly creates: Readonly<Record<string, unknown>>;
		};
		expect(Object.keys(state.creates)).toEqual(["same-request"]);
	});

	test("不同进程并发创建不同请求时合并状态且不覆盖记录", async () => {
		const fixture = await makeFixture("concurrent");
		const requestIds = ["parallel-1", "parallel-2"];
		const results = await Promise.all(
			requestIds.map((requestId) =>
				execFileAsync(
					process.execPath,
					["--experimental-strip-types", workerScript, factoryModule, fixture.stateRoot, fixture.repo, requestId],
					{
						cwd: packageRoot,
						encoding: "utf8",
						env: isolatedEnvironment(fixture.root),
						maxBuffer: 16 * 1024 * 1024,
						windowsHide: true,
					},
				),
			),
		);
		const bindings = results.map(
			({ stdout }) =>
				JSON.parse(stdout.trim()) as {
					readonly worktreeId: string;
					readonly executionRoot: string;
				},
		);
		expect(new Set(bindings.map((binding) => binding.worktreeId)).size).toBe(2);
		expect(new Set(bindings.map((binding) => binding.executionRoot)).size).toBe(2);

		const state = JSON.parse(await readFile(join(fixture.stateRoot, "pao-worktree-host.json"), "utf8")) as {
			readonly creates: Readonly<
				Record<string, { readonly status: string; readonly binding?: { readonly worktreeId: string } }>
			>;
		};
		expect(Object.keys(state.creates).sort()).toEqual([...requestIds].sort());
		expect(Object.values(state.creates).every((record) => record.status === "completed")).toBe(true);
		expect(new Set(Object.values(state.creates).map((record) => record.binding?.worktreeId))).toEqual(
			new Set(bindings.map((binding) => binding.worktreeId)),
		);
	});

	test("单根适配器只证明主目录，不声称可创建或清理完整隔离工作目录", async () => {
		const fixture = await makeFixture("single-root");
		const host = createSingleRootWorktreeHost(fixture.repo);

		await expect(host.capability(fixture.repo)).resolves.toEqual({
			ok: true,
			create: false,
			cleanup: false,
			baseline: "primary-only",
		});
		await expect(
			host.resolveForDispatch({
				requestId: "single-root-managed",
				projectRoot: fixture.repo,
				target: { kind: "managed", worktreeId: join(fixture.root, "user-worktree") },
			}),
		).rejects.toThrow(/不支持独立工作目录/);
	});

	test("用户自建工作树不能借绑定 ID 被默认宿主接管", async () => {
		const fixture = await makeFixture("user-worktree");
		const userWorktree = join(fixture.root, "用户工作树");
		await git(fixture.repo, "worktree", "add", "-b", "user/manual", userWorktree, "HEAD");
		const host = createHost(fixture);

		await expect(
			host.resolveForDispatch({
				requestId: "reject-user-worktree",
				projectRoot: fixture.repo,
				target: { kind: "managed", worktreeId: await canonicalPath(userWorktree) },
			}),
		).rejects.toThrow(/不在应用目录根内/);
		await expect(readFile(join(userWorktree, "tracked.txt"), "utf8")).resolves.toBe("committed\n");
		expect(await git(userWorktree, "branch", "--show-current")).toBe("user/manual");
	});

	test("显式创建失败和损坏的持久状态都向调用方报错，不退化为成功", async () => {
		const fixture = await makeFixture("failure");
		const nonGit = join(fixture.root, "not-git");
		await mkdir(nonGit);
		const failedHost = createHost(fixture);
		await expect(failedHost.capability(nonGit)).resolves.toMatchObject({ ok: false });
		await expect(failedHost.create({ requestId: "must-fail", projectRoot: nonGit })).rejects.toThrow();
		await expect(stat(fixture.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });

		const created = await failedHost.create({
			requestId: "before-corruption",
			projectRoot: fixture.repo,
		});
		if (created.kind !== "managed") throw new Error("应当创建受管工作目录");
		await writeFile(join(fixture.stateRoot, "pao-worktree-host.json"), "{broken-json\n");

		await expect(
			createHost(fixture).resolveForDispatch({
				requestId: "corrupt-state",
				projectRoot: fixture.repo,
				target: { kind: "managed", worktreeId: created.worktreeId },
			}),
		).rejects.toThrow();
	});
});

interface Fixture {
	readonly root: string;
	readonly repo: string;
	readonly stateRoot: string;
}

function createHost(fixture: Fixture) {
	const options: CreateLocalPaoWorktreeHostOptions = {
		stateRoot: fixture.stateRoot,
		projectRoot: fixture.repo,
	};
	return createLocalPaoWorktreeHost(options);
}

async function makeFixture(label: string): Promise<Fixture> {
	const paoHome = process.env.PAO_HOME?.trim();
	if (!paoHome) throw new Error("I2-1 真实 Git 测试必须显式设置 PAO_HOME，测试夹具不会写入系统临时目录。");
	if (!isAbsolute(paoHome)) throw new Error(`I2-1 测试的 PAO_HOME 必须是绝对路径：${paoHome}`);
	const fixtureParent = dirname(resolve(paoHome));
	await mkdir(fixtureParent, { recursive: true });
	const root = await mkdtemp(join(fixtureParent, `pao-i2-1-${label}-`));
	temporaryRoots.push(root);
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "i2-1@example.com");
	await git(repo, "config", "user.name", "I2-1 真实 Git 测试");
	await git(repo, "config", "core.autocrlf", "false");
	await writeFile(join(repo, "tracked.txt"), "committed\n");
	await writeFile(join(repo, "已提交中文.txt"), "中文内容\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "seed");
	return { root, repo, stateRoot: join(root, "state") };
}

async function canonicalPath(path: string): Promise<string> {
	return resolve(await import("node:fs/promises").then(({ realpath }) => realpath(path)));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await gitBytes(cwd, ...args)).toString("utf8").trim();
}

async function objectIds(cwd: string, treeId: string): Promise<readonly string[]> {
	return (await git(cwd, "rev-list", "--objects", "--no-object-names", treeId)).split(/\r?\n/).filter(Boolean).sort();
}

async function gitBytes(cwd: string, ...args: string[]): Promise<Buffer> {
	return new Promise((resolveOutput, reject) => {
		const child = execFile(
			"git",
			["-C", cwd, ...args],
			{
				encoding: "buffer",
				env: isolatedEnvironment(dirname(cwd)),
				maxBuffer: 16 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolveOutput(Buffer.from(stdout));
			},
		);
		child.stdin?.end();
	});
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
