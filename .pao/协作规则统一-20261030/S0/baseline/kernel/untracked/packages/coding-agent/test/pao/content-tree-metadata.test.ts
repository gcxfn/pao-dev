import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureContentTree } from "../../src/pao/cards/baseline.ts";
import * as cardProcess from "../../src/pao/cards/process.ts";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	process.env.PATH = originalPath;
});

function tempDir(prefix = "pao-content-tree-metadata-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.quotepath=off", "-c", "user.name=I0-7a", "-c", "user.email=i0-7a@example.invalid", ...args],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
}

function makeRepo(prefix?: string, initArgs: string[] = ["--object-format=sha1"]): string {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "说明 文档.txt"), "baseline\n", "utf8");
	git(repo, ["init", ...initArgs]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "baseline"]);
	return repo;
}

/** 旧实现分开执行的三条只读命令；用于逐字段核对单次查询没有改变事实。 */
function legacyMetadata(cwd: string): { repositoryRoot: string; head: string; commonGitDir: string } {
	return {
		repositoryRoot: git(cwd, ["rev-parse", "--show-toplevel"]).trim(),
		head: git(cwd, ["rev-parse", "HEAD"]).trim(),
		commonGitDir: git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
	};
}

it("状态读取失败时仍等待本轮私有索引任务结束，再清理并暴露原错", async () => {
	const repo = makeRepo();
	const realRun = cardProcess.runCardProcess;
	let enterTree!: () => void;
	let releaseTree!: () => void;
	const entered = new Promise<void>((resolve) => {
		enterTree = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		releaseTree = resolve;
	});
	vi.spyOn(cardProcess, "runCardProcess").mockImplementation(async (...args) => {
		if (args[1].includes("status")) return { code: 1, stdout: "", stderr: "模拟状态读取失败" };
		if (args[1].includes("read-tree")) {
			enterTree();
			await gate;
		}
		return realRun(...args);
	});
	let settled = false;
	const result = captureContentTree(repo).then(
		() => {
			settled = true;
			return undefined;
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	await entered;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(settled).toBe(false);
	releaseTree();
	await expect(result).resolves.toMatchObject({ message: "模拟状态读取失败" });
});

it("两路命令同时失败时保留全部错误及停止未确认类型", async () => {
	const repo = makeRepo();
	const realRun = cardProcess.runCardProcess;
	vi.spyOn(cardProcess, "runCardProcess").mockImplementation(async (...args) => {
		if (args[1].includes("read-tree")) throw new Error("模拟tree错误");
		if (args[1].includes("status"))
			throw new cardProcess.CardProcessStopUnconfirmedError("模拟status停止未确认", new Error("模拟进程未停"));
		return realRun(...args);
	});
	const result = await captureContentTree(repo).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(result).toBeInstanceOf(cardProcess.CardProcessStopUnconfirmedError);
	const causes = (result as cardProcess.CardProcessStopUnconfirmedError).stopError as AggregateError;
	expect(causes).toBeInstanceOf(AggregateError);
	expect(causes.errors).toHaveLength(2);
	expect(causes.errors[0].message).toBe("模拟tree错误");
	expect(causes.errors[1]).toBeInstanceOf(cardProcess.CardProcessStopUnconfirmedError);
});

it("复用状态快照仍保留原始未跟踪路径、系统文件差异和真实暂存区", async () => {
	const repo = makeRepo();
	const arrowName = process.platform === "win32" ? "含 - 箭头.txt" : "含 -> 箭头.txt";
	writeFileSync(join(repo, "新 文件.txt"), "new\n");
	writeFileSync(join(repo, arrowName), "arrow\n");
	writeFileSync(join(repo, "黑板.md"), "system\n");
	writeFileSync(join(repo, "忽略.txt"), "ignored\n");
	writeFileSync(join(repo, ".git", "info", "exclude"), "忽略.txt\n");
	mkdirSync(join(repo, ".pao"));
	writeFileSync(join(repo, ".pao", "噪声.txt"), "orchestration\n");
	writeFileSync(join(repo, "说明 文档.txt"), "staged\n");
	git(repo, ["add", "--", "说明 文档.txt"]);
	const statusBefore = git(repo, ["status", "--porcelain", "-z"]);
	const stagedBefore = git(repo, ["diff", "--cached"]);
	const captured = await captureContentTree(repo);
	expect(captured.untracked).toEqual([arrowName, "新 文件.txt", "黑板.md"]);
	expect(captured.untrackedSet).toEqual(new Set(captured.untracked));
	expect(captured.status.some((entry) => entry.文件 === "黑板.md")).toBe(false);
	expect(captured.status.some((entry) => entry.文件 === "说明 文档.txt" && entry.状态 === "M")).toBe(true);
	expect(git(repo, ["status", "--porcelain", "-z"])).toBe(statusBefore);
	expect(git(repo, ["diff", "--cached"])).toBe(stagedBefore);
});

/**
 * 用临时原生 Git 代理覆盖真实 Git 不常出现的成功但字段缺失场景。
 * Windows 用随系统提供的 C# 编译器，其他平台用 POSIX shell；测试仍调用同一个子进程入口。
 */
function gitOutputShim(output: string): string {
	const dir = tempDir("pao-git-output-shim-");
	if (process.platform === "win32") {
		const source = join(dir, "GitOutputShim.cs");
		writeFileSync(
			source,
			`using System;
using System.Text;
class GitOutputShim {
  static void Main() {
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.Out.Write(Encoding.UTF8.GetString(Convert.FromBase64String("${Buffer.from(output).toString("base64")}")));
  }
}`,
			"utf8",
		);
		execFileSync(
			"C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
			["/nologo", "/codepage:65001", "/target:exe", `/out:${join(dir, "git.exe")}`, source],
			{ stdio: "pipe" },
		);
	} else {
		const executable = join(dir, "git");
		writeFileSync(executable, `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\n`, "utf8");
		chmodSync(executable, 0o755);
	}
	return dir;
}

async function withGitOutput<T>(output: string, operation: () => Promise<T>): Promise<T> {
	const shimDir = gitOutputShim(output);
	process.env.PATH = `${shimDir}${delimiter}${originalPath ?? ""}`;
	try {
		return await operation();
	} finally {
		process.env.PATH = originalPath;
	}
}

describe("captureContentTree Git 元数据读取", () => {
	it("标准仓库与子目录沿用原三命令的仓库根和 HEAD，严格模式仍拒绝子目录", async () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "子 目录"));
		const expected = legacyMetadata(repo);

		const rootCapture = await captureContentTree(repo);
		expect(rootCapture.repositoryRoot).toBe(expected.repositoryRoot);
		expect(rootCapture.head).toBe(expected.head);
		expect(expected.head).toMatch(/^[a-f0-9]{40}$/);

		const subdirectory = join(repo, "子 目录");
		const subCapture = await captureContentTree(subdirectory);
		expect(subCapture.repositoryRoot).toBe(expected.repositoryRoot);
		expect(subCapture.head).toBe(expected.head);
		await expect(captureContentTree(subdirectory, undefined, true)).rejects.toThrow(
			"执行根不是仓库根，拒绝从子目录建立不完整内容基线",
		);
	});

	it("linked worktree 的仓库根取工作树、HEAD 相同，共同 Git 目录沿用主仓", async () => {
		const repo = makeRepo();
		const linkedParent = tempDir("pao-content-tree-linked-parent-");
		const worktree = join(linkedParent, "linked 工作树 中文");
		git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
		const expected = legacyMetadata(worktree);

		const captured = await captureContentTree(worktree);
		expect(captured.repositoryRoot).toBe(expected.repositoryRoot);
		expect(captured.head).toBe(expected.head);
		expect(captured.repositoryRoot).not.toBe(legacyMetadata(repo).repositoryRoot);
	});

	it("仓库路径同时含空格和中文时仍与原三命令逐字段一致", async () => {
		const repo = makeRepo("pao-content-tree-中文 空格-");
		const expected = legacyMetadata(repo);

		const captured = await captureContentTree(repo);
		expect(captured.repositoryRoot).toBe(expected.repositoryRoot);
		expect(captured.head).toBe(expected.head);
		expect(captured.repositoryRoot).toContain("中文 空格");
	});

	it("SHA-1 与 SHA-256 仓库的 40/64 位 HEAD 都保留", async () => {
		const sha1Repo = makeRepo("pao-content-tree-sha1-", ["--object-format=sha1"]);
		const sha256Repo = makeRepo("pao-content-tree-sha256-", ["--object-format=sha256"]);

		const sha1 = await captureContentTree(sha1Repo);
		const sha256 = await captureContentTree(sha256Repo);
		expect(sha1.head).toMatch(/^[a-f0-9]{40}$/);
		expect(sha256.head).toMatch(/^[a-f0-9]{64}$/);
	});

	it("Git 失败保留真实错误", async () => {
		const notRepository = tempDir("pao-content-tree-not-repo-");
		await expect(captureContentTree(notRepository)).rejects.toThrow(/not a git repository|不是 git 仓库/i);
	});

	it("共同 Git 目录缺失时明确报错", async () => {
		const repo = makeRepo();
		const expected = legacyMetadata(repo);
		await withGitOutput(`${expected.repositoryRoot}\n${expected.head}\n`, () =>
			expect(captureContentTree(repo)).rejects.toThrow("git rev-parse --git-common-dir 未返回共同 Git 目录"),
		);
	});

	it("取消信号在元数据读取前原样传播", async () => {
		const repo = makeRepo();
		const controller = new AbortController();
		const reason = new Error("I0-7a 测试取消");
		controller.abort(reason);
		await expect(captureContentTree(repo, controller.signal)).rejects.toBe(reason);
	});
});
