import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCard, type ParsedCard, readCard } from "../../src/pao/cards/index.ts";
import { appendDispatchReceipt, executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import { PaoWorkerError } from "../../src/pao/worker/errors.ts";
import { acquireExecutionRootGuard, isExecutionLocked } from "../../src/pao/worker/lock.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import type { ManagedWorktreeBinding, PaoWorktreeHost, WorktreeBinding } from "../../src/pao/worktrees/types.ts";
import { killTree } from "../../src/utils/kill-tree.ts";

const roots: string[] = [];
const runners: WorkerRunner[] = [];

afterEach(async () => {
	for (const runner of runners.splice(0)) {
		try {
			await runner.stopAll();
		} catch {
			// 失败测试保留自己的现场，清理只停止本文件创建的真实子进程。
		}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	).trim();
}

function commit(root: string): string {
	git(root, ["add", "-A"]);
	git(root, ["commit", "--no-gpg-sign", "-m", "真实基线"]);
	return git(root, ["rev-parse", "HEAD"]);
}

function initRepo(root: string): void {
	mkdirSync(root, { recursive: true });
	git(root, ["init"]);
	writeFileSync(join(root, "已跟踪.txt"), "v1\n");
	commit(root);
}

async function card(cardsDir: string, goal: string): Promise<ParsedCard> {
	mkdirSync(cardsDir, { recursive: true });
	return createCard(
		cardsDir,
		{ 目标: goal, 部门: "测试", 验收: "离线脚本完成", 创建: "2026-10-21 09:00" },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}

function managedBinding(
	taskRoot: string,
	executionRoot: string,
	worktreeId: string,
	sourceHead: string,
): ManagedWorktreeBinding {
	const commonGitDir = git(executionRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const inputVersion = git(executionRoot, ["rev-parse", "HEAD^{tree}"]);
	const bindingDigest = `sha256:${createHash("sha256")
		.update(JSON.stringify({ taskRoot, executionRoot, worktreeId, inputVersion }))
		.digest("hex")}`;
	return {
		kind: "managed",
		taskRoot,
		executionRoot,
		commonGitDir,
		worktreeId,
		branchName: `pao/${worktreeId}`,
		inputVersion,
		bindingDigest,
		baseline: {
			sourceRoot: taskRoot,
			sourceHead,
			treeId: inputVersion,
			snapshotRepositoryPath: join(taskRoot, ".pao", "对象.git"),
			inputVersion,
			capturedAt: "2026-10-21T01:00:00.000Z",
			fileCount: 1,
			byteCount: 3,
			coverage: "complete",
			includedPaths: ["已跟踪.txt"],
			excludedPaths: [],
			notes: [],
		},
	};
}

function host(taskRoot: string, bindings: readonly ManagedWorktreeBinding[]): PaoWorktreeHost {
	return {
		async capability() {
			return { ok: true, create: false, cleanup: false, baseline: "recoverable-complete" };
		},
		async create() {
			throw new Error("本用例不创建新工作树");
		},
		async inspect() {
			return [];
		},
		async resolveForDispatch({ target }) {
			if (target.kind !== "managed") throw new Error("本用例只验证 managed 根");
			const found = bindings.find((binding) => binding.worktreeId === target.worktreeId);
			if (!found) throw new Error(`未登记工作树 ${target.worktreeId}`);
			if (found.taskRoot !== taskRoot) throw new Error("任务根不一致");
			return found;
		},
		async requestCleanup() {
			return { ok: false, retained: true, reason: "测试保留现场" };
		},
	};
}

function target(worktreeId: string) {
	return { kind: "managed" as const, worktreeId };
}

function workflowCheck() {
	return undefined;
}

function script(root: string, label: string, startLog: string): { path: string; args: string[] } {
	const path = join(root, `${label}.js`);
	writeFileSync(
		path,
		[
			'const fs = require("node:fs");',
			`fs.appendFileSync(${JSON.stringify(startLog)}, "start " + Date.now() + " ${label}\\n");`,
			'setTimeout(() => {',
			`  fs.appendFileSync(${JSON.stringify(startLog)}, "end " + Date.now() + " ${label}\\n");`,
			'  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({result:"success",artifact_path:[],summary:"完成 ${label}"}) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));',
			"}, 2500);",
		].join("\n"),
		"utf8",
	);
	return { path, args: [] };
}

function handshakeScript(root: string, label: string, startLog: string): { path: string; args: string[] } {
	const path = join(root, `${label}-handshake.js`);
	const readyDir = join(root, "握手");
	writeFileSync(
		path,
		[
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			`const log = ${JSON.stringify(startLog)};`,
			`const readyDir = ${JSON.stringify(readyDir)};`,
			`const label = ${JSON.stringify(label)};`,
			"const ownReady = path.join(readyDir, label + '.ready');",
			"const peerReady = path.join(readyDir, (label === 'a' ? 'b' : 'a') + '.ready');",
			"const go = path.join(readyDir, 'go');",
			"const pid = process.pid;",
			"fs.mkdirSync(readyDir, { recursive: true });",
			"fs.writeFileSync(ownReady, String(pid));",
			"fs.appendFileSync(log, `ready ${Date.now()} ${label} ${pid}\\n`);",
			"const deadline = Date.now() + 20000;",
			"function waitForPeer() {",
			"  if (fs.existsSync(peerReady)) {",
			"    fs.appendFileSync(log, `peer-ready ${Date.now()} ${label} ${pid}\\n`);",
			"    waitForTestRelease();",
			"    return;",
			"  }",
			"  if (Date.now() >= deadline) {",
			"    fs.appendFileSync(log, `timeout ${Date.now()} ${label} ${pid} peer\\n`);",
			"    process.exitCode = 23;",
			"    return;",
			"  }",
			"  setTimeout(waitForPeer, 25);",
			"}",
			"function waitForTestRelease() {",
			"  if (fs.existsSync(go)) {",
			"    fs.writeFileSync(path.join(readyDir, label + '.business'), String(pid));",
			"    fs.appendFileSync(log, `business ${Date.now()} ${label} ${pid}\\n`);",
			'    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({result:"success",artifact_path:[],summary:"握手完成 ' + label + '"}) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));',
			"    return;",
			"  }",
			"  if (Date.now() >= deadline) {",
			"    fs.appendFileSync(log, `timeout ${Date.now()} ${label} ${pid} release\\n`);",
			"    process.exitCode = 23;",
			"    return;",
			"  }",
			"  setTimeout(waitForTestRelease, 25);",
			"}",
			"waitForPeer();",
		].join("\n"),
		"utf8",
	);
	return { path, args: [] };
}

describe("真实 WorkerRunner 与真实 managed Git 根", () => {
	it("两个 managed 根的两个离线 Node 子进程执行时间真实重叠", async () => {
		const root = temp("pao-managed-overlap-");
		initRepo(root);
		const sourceHead = git(root, ["rev-parse", "HEAD"]);
		const workA = join(root, "worktree-a");
		const workB = join(root, "worktree-b");
		git(root, ["worktree", "add", "-b", "pao-a", workA]);
		git(root, ["worktree", "add", "-b", "pao-b", workB]);
		const a = managedBinding(root, workA, "a", sourceHead);
		const b = managedBinding(root, workB, "b", sourceHead);
		const cardsDir = join(root, ".pao", "任务", "卡");
		await card(cardsDir, "A");
		await card(cardsDir, "B");
		const runner = new WorkerRunner({ 证据目录: join(root, "证据") });
		runners.push(runner);
		const log = join(root, "时间线.txt");
		const aScript = handshakeScript(root, "a", log);
		const bScript = handshakeScript(root, "b", log);
		const dispatch = (cardNo: string, worktreeId: string, command: { path: string; args: string[] }) =>
			executeDispatch(
				{ cardsDir, card_no: cardNo, operator: "主控", time: "2026-10-21 09:00" },
				{
					运行器: runner,
					worktreeHost: host(root, [a, b]),
					worktreeTarget: target(worktreeId),
					workflowCheck,
					等待名额: true,
					公共参数: {
						命令: process.execPath,
						参数: [command.path, ...command.args],
						证据目录: join(root, "证据"),
						// 子进程按自己的 worktree 写 ready；执行根仍由宿主绑定和正式派发链核验。
						cwd: worktreeId === "a" ? workA : workB,
					},
				},
				async (claimed, receipt) => {
					expect(receipt.status).toBe("success");
					expect(receipt.exitCode).toBe(0);
					await appendDispatchReceipt(claimed.card, receipt);
					return {
						cardNo: claimed.card.card_no,
						status: receipt.status,
						exitCode: receipt.exitCode,
						pid: receipt.pid,
					};
				},
			);
		const dispatches = [dispatch("1", "a", aScript)];
		// 首个进程进入登记表后再预约第二张卡，防止预约和登记身份不同导致重复计名额。
		await waitFor(() => existsSync(join(root, "握手", "a.ready")), 20_000);
		expect(runner.registry.list().filter((entry) => entry.running)).toHaveLength(1);
		dispatches.push(dispatch("2", "b", bScript));
		await waitFor(
			() =>
				existsSync(join(root, "握手", "a.ready")) &&
				existsSync(join(root, "握手", "b.ready")),
			20_000,
		);
		const live = runner.registry.list().filter((entry) => entry.running);
		expect(live).toHaveLength(2);
		expect(live.map((entry) => entry.pid).every((pid) => processAlive(pid))).toBe(true);
		const liveByCard = new Map(live.map((entry) => [entry.card_no, entry.pid]));
		expect(liveByCard.get("0001")).toBeTypeOf("number");
		expect(liveByCard.get("0002")).toBeTypeOf("number");
		writeFileSync(join(root, "握手", "go"), "release");
		const results = await Promise.all(dispatches);
		expect(results.every((result) => result.可派)).toBe(true);
		const outcomes = results.flatMap((result) => (result.可派 ? [result.result] : []));
		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((outcome) => outcome.status === "success" && outcome.exitCode === 0)).toBe(true);
		expect(outcomes.map((outcome) => outcome.pid).every((pid) => processAlive(pid) === false)).toBe(true);
		const events = existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => {
						const [event, time, id, pid] = line.split(" ");
						return { event, time: Number(time), id, pid: Number(pid) };
					})
			: [];
		const aReady = events.find((entry) => entry.event === "ready" && entry.id === "a")!;
		const bReady = events.find((entry) => entry.event === "ready" && entry.id === "b")!;
		const aBusiness = events.find((entry) => entry.event === "business" && entry.id === "a")!;
		const bBusiness = events.find((entry) => entry.event === "business" && entry.id === "b")!;
		const overlap =
			aReady.time < bBusiness.time &&
			bReady.time < aBusiness.time &&
			aBusiness.time < bReady.time + 20_000 &&
			bBusiness.time < aReady.time + 20_000;
		expect(overlap, JSON.stringify(events)).toBe(true);
		expect(aReady.pid).toBe(liveByCard.get("0001"));
		expect(bReady.pid).toBe(liveByCard.get("0002"));
		expect(readFileSync(join(root, "握手", "a.business"), "utf8")).toBe(String(aReady.pid));
		expect(readFileSync(join(root, "握手", "b.business"), "utf8")).toBe(String(bReady.pid));
		for (const path of [join(cardsDir, "卡0001-A.md"), join(cardsDir, "卡0002-B.md")]) {
			expect(readCard(path).receipts[0]).toMatchObject({ attempt: 1, result: "success" });
		}
		const active = runner.registry.list().filter((entry) => entry.running);
		expect(active).toHaveLength(0);
	}, 60_000);

	it("同一 managed 根的双写被真实执行锁互斥，只启动一个子进程", async () => {
		const root = temp("pao-managed-mutex-");
		initRepo(root);
		const sourceHead = git(root, ["rev-parse", "HEAD"]);
		const work = join(root, "worktree");
		git(root, ["worktree", "add", "-b", "pao-work", work]);
		const binding = managedBinding(root, work, "work", sourceHead);
		const cardsDir = join(root, ".pao", "任务", "卡");
		await card(cardsDir, "A");
		await card(cardsDir, "B");
		const runner = new WorkerRunner({ 证据目录: join(root, "证据") });
		runners.push(runner);
		const log = join(root, "时间线.txt");
		const workerScript = script(root, "one", log);
		const dispatch = (cardNo: string) =>
			executeDispatch(
				{ cardsDir, card_no: cardNo, operator: "主控", time: "2026-10-21 09:00" },
				{
					运行器: runner,
					worktreeHost: host(root, [binding]),
					worktreeTarget: target("work"),
					workflowCheck,
					等待名额: true,
					公共参数: {
						命令: process.execPath,
						参数: [workerScript.path],
						证据目录: join(root, "证据"),
						cwd: work,
					},
				},
				async (claimed, receipt) => receipt.status,
			);
		const [first, second] = await Promise.allSettled([dispatch("1"), dispatch("2")]);
		const fulfilled = [first, second].filter(
			(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof dispatch>>> =>
				result.status === "fulfilled",
		);
		const rejected = [first, second].filter((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(String(rejected[0]!.reason)).toMatch(/执行根.*(锁|占用)|锁被占用/);
		const starts = existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line.startsWith("start "))
			: [];
		expect(starts).toHaveLength(1);
	}, 60_000);

	it("真活 worker 停止未知时保留锁、预约和守卫；随后真退出才全部释放", async () => {
		const root = temp("pao-managed-cancel-");
		initRepo(root);
		const sourceHead = git(root, ["rev-parse", "HEAD"]);
		const work = join(root, "worktree");
		git(root, ["worktree", "add", "-b", "pao-cancel", work]);
		const binding = managedBinding(root, work, "cancel", sourceHead);
		const cardsDir = join(root, ".pao", "任务", "卡");
		await card(cardsDir, "取消验证");
		let injectFailure = true;
		const runner = new WorkerRunner({
			证据目录: join(root, "证据"),
			树杀: async (pid, timeout, createdBefore) => {
					if (injectFailure) {
						throw new PaoWorkerError("停止失败", "注入的一次树杀失败");
					}
					return killTree(pid, timeout, createdBefore);
				},
		});
		runners.push(runner);
		let reservations = 0;
		const reserve = runner.reserveDispatchSlot.bind(runner);
		runner.reserveDispatchSlot = async (input) => {
			const release = await reserve(input);
			reservations++;
			return () => {
				reservations--;
				release();
			};
		};
		const workerScript = join(root, "hang.js");
		writeFileSync(workerScript, "setInterval(() => {}, 1000);\n", "utf8");
		const dispatchPromise = executeDispatch(
			{ cardsDir, card_no: "1", operator: "主控", time: "2026-10-21 09:00" },
			{
				运行器: runner,
				worktreeHost: host(root, [binding]),
				worktreeTarget: target("cancel"),
				workflowCheck,
				等待名额: true,
				公共参数: {
					命令: process.execPath,
					参数: [workerScript],
					证据目录: join(root, "证据"),
					cwd: work,
				},
			},
			async () => "ok",
		);
		await waitFor(() => runner.isRunning(join(cardsDir, "卡0001-取消验证.md")));
		expect(await isExecutionLocked(work)).toBe(true);
		expect(reservations).toBe(1);
		await expect(
			acquireExecutionRootGuard({ taskRoot: root, executionRoot: work, holder: "并行获取者" }),
		).rejects.toMatchObject({ code: "锁被占用" });
		await expect(runner.cancel(join(cardsDir, "卡0001-取消验证.md"))).rejects.toThrow("注入的一次树杀失败");
		expect(await isExecutionLocked(work)).toBe(true);
		expect(reservations).toBe(1);
		await expect(
			acquireExecutionRootGuard({ taskRoot: root, executionRoot: work, holder: "失败后获取者" }),
		).rejects.toMatchObject({ code: "锁被占用" });
		await expect(runner.stopAll()).rejects.toThrow("注入的一次树杀失败");
		expect(await isExecutionLocked(work)).toBe(true);
		expect(reservations).toBe(1);
		injectFailure = false;
		await runner.stopAll();
		await expect(dispatchPromise).resolves.toMatchObject({ 可派: true });
		expect(await isExecutionLocked(work)).toBe(false);
		expect(reservations).toBe(0);
	}, 60_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("等待真实子进程超时");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
