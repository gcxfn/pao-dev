import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCard, readCard } from "../../src/pao/cards/index.ts";
import {
	appendCardInputReference,
	captureDispatchMap,
	dispatchInputSnapshotPath,
	loadDispatchInputSnapshot,
	saveDispatchMapArtifact,
} from "../../src/pao/dispatch-brief/index.ts";
import { appendDispatchReceipt, executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import { isExecutionLocked } from "../../src/pao/worker/lock.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { createSingleRootWorktreeHost, type ManagedWorktreeBinding } from "../../src/pao/worktrees/types.ts";

const roots: string[] = [];
const runners: WorkerRunner[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pao-nongit-direct-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "卡");
	const paoHome = join(root, "home");
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(join(paoHome, "pao配置"), { recursive: true });
	writeFileSync(
		join(paoHome, "pao配置", "档位.json"),
		JSON.stringify({
			provider: "pao",
			档位: [{ 名: "primary", provider: "offline", model: "offline", thinkingLevel: "off" }],
		}),
	);
	const card = await createCard(cardsDir, {
		目标: "旧卡直接派发",
		部门: "测试",
		验收: "真实离线子进程返回",
		创建: "2026-10-21 10:00",
		档位: "primary",
	});
	const probe = join(root, "probe.json");
	const script = join(root, "probe.cjs");
	writeFileSync(
		script,
		[
			'const fs = require("node:fs");',
			`fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({pid:process.pid,cwd:process.cwd()}));`,
			'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify({result:"success",artifact_path:[],summary:"真实离线完成"})}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0}}}));',
		].join("\n"),
	);
	const runner = new WorkerRunner({ 证据目录: join(root, "evidence") });
	runners.push(runner);
	return {
		root,
		cardsDir,
		card,
		probe,
		runner,
		input: { cardsDir, card_no: "1", operator: "主控", time: "2026-10-21 10:00" },
		options: {
			运行器: runner,
			paoHome,
			workflowCheck: () => undefined,
			公共参数: { 命令: process.execPath, 参数: [script] },
		},
	};
}

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

it("无 worktreeHost 的旧 SDK executeDispatch 在非 Git 根启动真实进程并落成功回执", async () => {
	const f = await fixture();
	const result = await executeDispatch(f.input, f.options, async (claim, receipt) => {
		expect(claim.claimBaseline).toMatchObject({ 可用: false, 原因: expect.stringContaining("not a git repository") });
		expect(receipt.pid).toBeGreaterThan(0);
		await appendDispatchReceipt(claim.card, receipt);
		return receipt;
	});
	expect(result).toMatchObject({ 可派: true, result: { status: "success", attempt: 1 } });
	expect(JSON.parse(readFileSync(f.probe, "utf8"))).toMatchObject({ cwd: f.root, pid: expect.any(Number) });
	expect(readCard(f.card.path).receipts).toHaveLength(1);
	expect(readCard(f.card.path).receipts[0]).toMatchObject({ result: "success", attempt: 1 });
	expect(loadDispatchInputSnapshot(dispatchInputSnapshotPath(f.cardsDir, 1, 1)).execution).toMatchObject({
		versionControl: "none",
		executionRoot: f.root,
		repositoryRoot: f.root,
	});
	expect(await isExecutionLocked(f.root)).toBe(false);
});

it("有效地图所在目录失去 Git 后拒绝直接派发，不启动进程并撤回认领", async () => {
	const f = await fixture();
	git(f.root, ["init"]);
	writeFileSync(join(f.root, "input.txt"), "真实输入\n");
	git(f.root, ["add", "input.txt"]);
	git(f.root, ["commit", "--no-gpg-sign", "-qm", "输入"]);
	const artifact = captureDispatchMap({
		id: "valid-before-git-loss",
		projectRoot: f.root,
		coverage: ["input.txt"],
		scopeConfirmed: true,
		scopeBasis: ["唯一输入"],
		capturedAt: new Date().toISOString(),
	});
	expect(artifact.status).toBe("valid");
	const saved = await saveDispatchMapArtifact({ cardsDir: f.cardsDir, artifact });
	await appendCardInputReference({ cardPath: f.card.path, ref: saved.ref });
	renameSync(join(f.root, ".git"), join(f.root, "git-disabled"));
	await expect(
		executeDispatch(f.input, f.options, async () => {
			throw new Error("不应交回执");
		}),
	).rejects.toThrow("执行根必须具有可核验的 Git 身份");
	expect(existsSync(f.probe)).toBe(false);
	expect(readCard(f.card.path).frontmatter).toMatchObject({ attempt: 0, status: "unclaimed" });
	expect(readCard(f.card.path).receipts).toHaveLength(0);
	expect(await isExecutionLocked(f.root)).toBe(false);
});

it("宿主返回 managed 旧绑定而执行目录无 Git 时拒派，不降级为普通目录", async () => {
	const f = await fixture();
	const executionRoot = join(f.root, "managed");
	mkdirSync(executionRoot);
	// 明确的宿主故障注入：即使宿主提供看似完整的旧证明，也必须读取真实 Git 现场。
	const binding: ManagedWorktreeBinding = {
		kind: "managed",
		taskRoot: f.root,
		executionRoot,
		commonGitDir: join(f.root, "missing.git"),
		worktreeId: "stale-managed",
		branchName: "pao/stale",
		inputVersion: "a".repeat(40),
		bindingDigest: `sha256:${"b".repeat(64)}`,
		baseline: {
			sourceRoot: f.root,
			sourceHead: "c".repeat(40),
			treeId: "a".repeat(40),
			snapshotRepositoryPath: join(f.root, "objects.git"),
			inputVersion: "a".repeat(40),
			capturedAt: new Date().toISOString(),
			fileCount: 1,
			byteCount: 1,
			coverage: "complete",
			includedPaths: ["input.txt"],
			excludedPaths: [],
			notes: [],
		},
	};
	await expect(
		executeDispatch(
			f.input,
			{
				...f.options,
				worktreeHost: { ...createSingleRootWorktreeHost(f.root), resolveForDispatch: async () => binding },
				worktreeTarget: { kind: "managed", worktreeId: binding.worktreeId },
			},
			async () => {
				throw new Error("不应交回执");
			},
		),
	).rejects.toThrow("执行根必须具有可核验的 Git 身份");
	expect(existsSync(f.probe)).toBe(false);
	expect(readCard(f.card.path).frontmatter).toMatchObject({ attempt: 0, status: "unclaimed" });
	expect(readCard(f.card.path).receipts).toHaveLength(0);
	expect(await isExecutionLocked(executionRoot)).toBe(false);
});
