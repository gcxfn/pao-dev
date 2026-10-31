import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
	createLocalPaoWorktreeHost,
	type CreateLocalPaoWorktreeHostOptions,
} from "../../src/pao/worktrees/local-host/index.ts";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workerScript = join(packageRoot, "test/pao/fixtures/local-worktree-process.ts");
const factoryModule = join(packageRoot, "src/pao/worktrees/local-host/index.ts");
const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("createLocalPaoWorktreeHost", () => {
	test("creates a real worktree from the complete captureContentTree baseline", async () => {
		const fixture = await makeFixture("complete");
		await writeFile(join(fixture.repo, "tracked.txt"), "dirty before create\n");
		await writeFile(join(fixture.repo, "untracked.txt"), "untracked before create\n");
		const host = createHost(fixture);
		await expect(stat(join(fixture.root, "state"))).rejects.toMatchObject({ code: "ENOENT" });

		await expect(host.capability(fixture.repo)).resolves.toEqual({
			ok: true,
			create: true,
			cleanup: true,
			baseline: "recoverable-complete",
		});
		const binding = await host.create({ requestId: "create-real", projectRoot: fixture.repo });
		if (binding.kind !== "managed") throw new Error("没有创建受管工作目录");

		expect(binding.executionRoot).toContain(join("state", "worktrees"));
		expect(await readFile(join(binding.executionRoot, "tracked.txt"), "utf8")).toBe(
			"dirty before create\n",
		);
		expect(await readFile(join(binding.executionRoot, "untracked.txt"), "utf8")).toBe(
			"untracked before create\n",
		);
		expect(binding.baseline.coverage).toBe("complete");
		expect(binding.inputVersion).toBe(binding.baseline.treeId);
		expect(
			await git(binding.baseline.snapshotRepositoryPath, "cat-file", "-t", binding.baseline.treeId),
		).toBe("tree");
		expect(await git(fixture.repo, "worktree", "list", "--porcelain")).toContain(
			binding.executionRoot.replaceAll("\\", "/"),
		);

		const replay = await host.create({ requestId: "create-real", projectRoot: fixture.repo });
		expect(replay).toEqual(binding);
		await expect(
			host.resolveForDispatch({
				requestId: "resolve-real",
				projectRoot: fixture.repo,
				target: { kind: "managed", worktreeId: binding.worktreeId },
			}),
		).resolves.toMatchObject({
			worktreeId: binding.worktreeId,
			executionRoot: binding.executionRoot,
		});
	});

	test("a fresh default factory resolves a persisted binding from shared state and Git truth", async () => {
		const fixture = await makeFixture("restart");
		const creator = createHost(fixture);
		const created = await creator.create({ requestId: "create-once", projectRoot: fixture.repo });
		if (created.kind !== "managed") throw new Error("没有创建受管工作目录");

		const resolver = createHost(fixture);
		await expect(
			resolver.resolveForDispatch({
				requestId: "resolve-from-fresh-host",
				projectRoot: fixture.repo,
				target: { kind: "managed", worktreeId: created.worktreeId },
				expectedInputVersion: created.inputVersion,
			}),
		).resolves.toMatchObject({
			kind: "managed",
			worktreeId: created.worktreeId,
			executionRoot: created.executionRoot,
			branchName: created.branchName,
			baseline: created.baseline,
		});
	});

	test("retains dirty or untracked worktrees and releases a clean merged worktree", async () => {
		const fixture = await makeFixture("cleanup");
		const host = createHost(fixture);
		const binding = await host.create({ requestId: "cleanup-real", projectRoot: fixture.repo });
		if (binding.kind !== "managed") throw new Error("没有创建受管工作目录");

		await writeFile(join(binding.executionRoot, "tracked.txt"), "dirty worktree\n");
		await expect(
			host.requestCleanup({
				requestId: "cleanup-dirty",
				projectRoot: fixture.repo,
				worktreeId: binding.worktreeId,
				reason: "验证脏工作树保护",
				executionActive: false,
			}),
		).resolves.toMatchObject({ ok: false, retained: true });
		expect(await readFile(join(binding.executionRoot, "tracked.txt"), "utf8")).toBe(
			"dirty worktree\n",
		);

		await git(binding.executionRoot, "restore", "tracked.txt");
		await writeFile(join(binding.executionRoot, "untracked.txt"), "keep me\n");
		await expect(
			host.requestCleanup({
				requestId: "cleanup-untracked",
				projectRoot: fixture.repo,
				worktreeId: binding.worktreeId,
				reason: "验证未跟踪文件保护",
				executionActive: false,
			}),
		).resolves.toMatchObject({ ok: false, retained: true });
		await rm(join(binding.executionRoot, "untracked.txt"));

		await expect(
			host.requestCleanup({
				requestId: "cleanup-ok",
				projectRoot: fixture.repo,
				worktreeId: binding.worktreeId,
				reason: "干净且已合入",
				executionActive: false,
			}),
		).resolves.toEqual({ ok: true, released: true, branchDeleted: false });
		await expect(readFile(join(binding.executionRoot, "tracked.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("cross-process hosts merge different request records without overwriting state", async () => {
		const fixture = await makeFixture("cross-process");
		const processes = ["p1", "p2", "p3", "p4"].map((requestId) =>
			execFileAsync(
				process.execPath,
				[
					"--experimental-strip-types",
					workerScript,
					factoryModule,
					join(fixture.root, "state"),
					fixture.repo,
					requestId,
				],
				{
					cwd: packageRoot,
					encoding: "utf8",
					env: isolatedEnvironment(fixture.root),
					maxBuffer: 16 * 1024 * 1024,
				},
			),
		);
		const results = await Promise.all(processes);
		const bindings = results.map(
			(result) => JSON.parse(result.stdout.trim()) as { worktreeId: string },
		);
		expect(new Set(bindings.map((binding) => binding.worktreeId)).size).toBe(4);

		const state = JSON.parse(
			await readFile(join(fixture.root, "state", "pao-worktree-host.json"), "utf8"),
		) as { creates: Record<string, { status: string }> };
		expect(Object.keys(state.creates).sort()).toEqual(["p1", "p2", "p3", "p4"]);
		expect(Object.values(state.creates).every((record) => record.status === "completed")).toBe(
			true,
		);
	});
});

function createHost(fixture: Fixture) {
	const options: CreateLocalPaoWorktreeHostOptions = {
		stateRoot: join(fixture.root, "state"),
		projectRoot: fixture.repo,
	};
	return createLocalPaoWorktreeHost(options);
}

interface Fixture {
	readonly root: string;
	readonly repo: string;
}

async function makeFixture(label: string): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), `pao-local-worktree-${label}-`));
	temporaryRoots.push(root);
	const repo = join(root, "repo");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "test@example.com");
	await git(repo, "config", "user.name", "Local Host Test");
	await git(repo, "config", "core.autocrlf", "false");
	await writeFile(join(repo, "tracked.txt"), "head\n");
	await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
	await git(repo, "add", "tracked.txt", "binary.bin");
	await git(repo, "commit", "-qm", "seed");
	return { root, repo };
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
