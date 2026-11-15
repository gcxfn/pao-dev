import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { diffAgainstBaseline, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, findCardFile, loadCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { deliverCard, deliverCards, registerDeliveryTools } from "../../src/pao/cards/delivery.ts";
import { bindExecutionContext } from "../../src/pao/cards/execution-context.ts";
import * as cardProcess from "../../src/pao/cards/process.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { verifyCard } from "../../src/pao/cards/verifier.ts";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";
import type { TodoItem } from "../../src/pao/todo/index.ts";

/**
 * §13 交卷自动化：stage 范围＝认领基线比对本卡差异清单（逐路径 add、禁 add -A、R15）、
 * 提交信息机械生成、幂等（无改动不空提交）、只 commit 不 push、
 * 验收未过/状态非已交付的拒交行为、批量串行、pao_deliver_card 工具接线。
 */

const tempDirs: string[] = [];
const pendingCancellations = new Map<Promise<unknown>, AbortController>();

afterEach(async () => {
	for (const controller of pendingCancellations.values()) controller.abort();
	await Promise.allSettled([...pendingCancellations.keys()]);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 120000);

function tempDir(prefix = "pao-delivery-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** 干净基线仓库：单次提交后工作树全净（用户脏工作树场景在「清单外不碰」用例单独制造）。 */
function makeRepo(prefix = "pao-delivery-"): string {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	return repo;
}

async function makeDeliverableCard(repo: string, goal = "巡库卡"): Promise<{ cardDir: string; cardNo: number }> {
	const cardDir = join(repo, ".pao", "卡");
	mkdirSync(cardDir, { recursive: true });
	const card = await createCard(cardDir, {
		目标: goal,
		部门: "核心机制",
		验收: "存在: 产物.txt",
		创建: "2026-10-02 10:00",
	});
	changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
	// R14：认领时落基线快照（pao_change_status 工具里的接线动作，此处直接调同一入口）
	await snapshotClaimBaseline(cardDir, card.card_no, { owner: "部长A", 时间: "2026-10-02 10:01" });
	// 模拟 worker 产物
	writeFileSync(join(repo, "产物.txt"), "+worker 产物\n");
	// 模拟机械验收全过：状态落已交付 + 卡上落验收记录（§12→§13 衔接面）
	const claimed = loadCard(cardDir, card.card_no);
	changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30", 依据: "机械验收全部通过" });
	appendVerdictRaw(cardDir, card.card_no, "- 结论: 全过自动交付");
	return { cardDir: cardDir, cardNo: card.card_no };
}

/** 直写一段验收记录（模拟 pao_verify_card 落卡后的派生数据，供交卷侧衔接读取）。 */
function appendVerdictRaw(cardDir: string, cardNo: number, verdictLine: string): void {
	const card = readCardByNumber(cardDir, cardNo);
	const section = `## 机械验收 2026-10-02 10:29\n${verdictLine}`;
	const body = card.body.trim().length > 0 ? `${card.body.trimEnd()}\n\n${section}\n` : `${section}\n`;
	writeFileAtomic(card.path, serializeCard(card.frontmatter, body));
}

function readCardByNumber(cardDir: string, cardNo: number): ParsedCard {
	return readCard(join(cardDir, findCardFile(cardDir, cardNo)!));
}

function commitCount(repo: string): number {
	return Number.parseInt(git(repo, ["rev-list", "--count", "HEAD"]).trim(), 10);
}

/** 临时原生 Git 代理：原参数交给真 Git；commit-tree 成功后阻塞返回，供取消测试精确命中。 */
function blockingGitShim(): { dir: string; marker: string; realGit: string } {
	const dir = tempDir("pao-git-shim-");
	const marker = join(dir, "commit-tree.ready");
	const realGit = execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/).find((p) => /\.exe$/i.test(p))!;
	const source = join(dir, "GitProxy.cs");
	writeFileSync(source, `// 用途：取消测试代理；输入：原 Git 参数与环境变量；输出：真实 Git 原始字节、阶段标记。
using System; using System.Diagnostics; using System.IO; using System.Threading; using System.Threading.Tasks;
class GitProxy {
  static int Main(string[] args) {
    string raw=Environment.CommandLine;
    int end=raw[0]=='"' ? raw.IndexOf('"',1)+1 : raw.IndexOf(' ');
    string tail=end<0 ? "" : raw.Substring(end);
    var info=new ProcessStartInfo(Environment.GetEnvironmentVariable("PAO_TEST_REAL_GIT"),tail);
    info.UseShellExecute=false; info.CreateNoWindow=true;
    info.RedirectStandardOutput=true; info.RedirectStandardError=true;
    var child=Process.Start(info);
    var output=child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
    var error=child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
    child.WaitForExit(); Task.WaitAll(output,error);
    if(Array.IndexOf(args,"commit-tree")>=0 && child.ExitCode==0) {
      var hangInfo=new ProcessStartInfo(Environment.GetEnvironmentVariable("PAO_TEST_NODE"),"-e setInterval(()=>{},1000)");
      hangInfo.UseShellExecute=false; hangInfo.CreateNoWindow=true;
      hangInfo.RedirectStandardOutput=true; hangInfo.RedirectStandardError=true;
      var hang=Process.Start(hangInfo);
      File.WriteAllText(Environment.GetEnvironmentVariable("PAO_TEST_GIT_MARKER"),
        Process.GetCurrentProcess().Id+Environment.NewLine+child.Id+Environment.NewLine+hang.Id+Environment.NewLine+child.ExitCode);
      while(!File.Exists(Environment.GetEnvironmentVariable("PAO_TEST_GIT_MARKER")+".release")) Thread.Sleep(20);
    }
    return child.ExitCode;
  }
}`);
	execFileSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
		["/nologo", "/codepage:65001", "/target:exe", `/out:${join(dir, "git.exe")}`, source], { stdio: "pipe" });
	return { dir, marker, realGit };
}

describe("pao_deliver_card：stage 范围与提交", () => {
	it("已交付卡：按基线差异逐路径 stage 并 commit，提交信息机械生成（卡NNNN 目标 · 已交付 · 机械验收通过）", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		const before = commitCount(repo);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(r.提交哈希).toBeTruthy();
		expect(r.提交信息).toBe(`卡${String(cardNo).padStart(4, "0")} 巡库卡 · delivered · 机械验收通过`);
		expect(r.暂存文件).toEqual(["产物.txt"]);
		expect(commitCount(repo)).toBe(before + 1);
		expect(git(repo, ["log", "-1", "--pretty=%B"]).trim()).toBe(r.提交信息);
		// 提交后工作树对本卡差异清零（.pao 编排区在差分面外）
		const diff = await diffAgainstBaseline(
			join(repo, ".pao", "基线", `卡${String(cardNo).padStart(4, "0")}-基线.txt`),
		);
		expect(diff.worker改动).toEqual([]);
		// 卡文件状态不被交卷改动
		expect(loadCard(cardDir, cardNo).frontmatter.status).toBe("delivered");
	}, 20000);

	it("逐路径 add 不裹挟：worker 增改之外的既有脏文件不进提交（R15）", async () => {
		const repo = makeRepo();
		// 用户派卡前自己的脏改动
		writeFileSync(join(repo, "已跟踪.txt"), "v2-用户改的\n");
		writeFileSync(join(repo, "用户便签.txt"), "用户的\n");
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, { 目标: "范围卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:00" });
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		await snapshotClaimBaseline(cardDir, card.card_no, { owner: "部长A" });
		// worker 只写自己的产物
		writeFileSync(join(repo, "产物.txt"), "worker 的\n");
		const delivered = loadCard(cardDir, card.card_no);
		changeCardStatus(delivered, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		appendVerdictRaw(cardDir, card.card_no, "- 结论: 全过自动交付");

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(true);
		expect(r.暂存文件).toEqual(["产物.txt"]);
		// 用户既有改动仍未暂存、未被提交
		const status = git(repo, ["status", "--porcelain"]);
		expect(status).toContain("已跟踪.txt");
		expect(status).toContain("用户便签.txt");
		expect(status).not.toContain("产物.txt");
	}, 20000);

	it("幂等：无基线外改动不创建空提交", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		await deliverCard(cardDir, cardNo);
		const before = commitCount(repo);

		const r2 = await deliverCard(cardDir, cardNo);

		expect(r2.交卷).toBe(false);
		expect(r2.消息).toContain("幂等");
		expect(commitCount(repo)).toBe(before);
	}, 20000);

	it("用户认领前已暂存的文件保持暂存，只提交本卡路径（R30）", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "已跟踪.txt"), "用户已暂存\n");
		git(repo, ["add", "--", "已跟踪.txt"]);
		const beforeIndex = git(repo, ["diff", "--cached", "--binary"]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim()).toBe("产物.txt");
		expect(git(repo, ["diff", "--cached", "--binary"])).toBe(beforeIndex);
		expect(git(repo, ["show", "HEAD:已跟踪.txt"])).toBe("v1\n");
	}, 20000);

	it("既有暂存文件后来变成 MM，也不冒认成本卡路径（R30 文件级边界）", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "已跟踪.txt"), "用户已暂存\n");
		git(repo, ["add", "--", "已跟踪.txt"]);
		const beforeIndex = git(repo, ["diff", "--cached", "--binary"]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		writeFileSync(join(repo, "已跟踪.txt"), "同文件后续改动\n");

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(r.暂存文件).toEqual(["产物.txt"]);
		expect(git(repo, ["diff", "--cached", "--binary"])).toBe(beforeIndex);
		expect(git(repo, ["status", "--porcelain"])).toContain("MM 已跟踪.txt");
	}, 20000);

	it("本卡重命名同时提交旧路径删除和新路径，用户暂存仍保留", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "用户.txt"), "用户\n");
		git(repo, ["add", "--", "用户.txt"]);
		const beforeIndex = git(repo, ["diff", "--cached", "--binary"]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		git(repo, ["mv", "--", "已跟踪.txt", "改名 文件.txt"]);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(git(repo, ["show", "HEAD:改名 文件.txt"])).toBe("v1\n");
		expect(git(repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain("已跟踪.txt");
		expect(git(repo, ["diff", "--cached", "--binary"])).toBe(beforeIndex);
	}, 20000);

	it("读取 git status 失败时拒绝交卷，不能当成无改动幂等（R30）", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		writeFileSync(join(repo, ".git", "index"), "损坏的测试夹具索引\n");

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("基线不可用");
		expect(r.消息).toContain("git 状态不可用");
		expect(r.消息).not.toContain("幂等");
	}, 20000);

	it("只 commit 不 push：配了远端也不推（远端引用保持为空）", async () => {
		const repo = makeRepo();
		const remote = tempDir("pao-delivery-remote-");
		git(remote, ["init", "--bare"]);
		git(repo, ["remote", "add", "origin", remote]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(git(repo, ["ls-remote", "origin"]).trim()).toBe(""); // 远端零引用：没有任何 push 发生
		expect(r.消息).toContain("未 push");
	}, 20000);
});

describe("pao_deliver_card：与验收员的输出衔接（§12→§13）", () => {
	it("机械验收未过 → 拒绝交卷，不产生提交", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, { 目标: "未过卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:00" });
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		await snapshotClaimBaseline(cardDir, card.card_no);
		writeFileSync(join(repo, "产物.txt"), "x\n");
		const claimed = loadCard(cardDir, card.card_no);
		// owner 强行人工落已交付（绕过机械验收），但卡上验收记录为未过
		changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		appendVerdictRaw(cardDir, card.card_no, "- 结论: 未过");
		const before = commitCount(repo);

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("机械验收未过");
		expect(r.消息).toContain("拒绝交卷");
		expect(r.消息).toContain("复核验收结果");
		expect(commitCount(repo)).toBe(before);
	}, 20000);

	it("状态非已交付 → 拒绝交卷（回执≠终态纪律）", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "进行中卡",
			部门: "核心机制",
			验收: "x",
			创建: "2026-10-02 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		const before = commitCount(repo);

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("状态非已交付");
		expect(r.消息).toContain("pao_verify_card");
		expect(commitCount(repo)).toBe(before);
	}, 20000);

	it("基线快照不可用 → 拒绝交卷，禁 add -A 不猜", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "无基线卡",
			部门: "核心机制",
			验收: "x",
			创建: "2026-10-02 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		changeCardStatus(loadCard(cardDir, card.card_no), { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		writeFileSync(join(repo, "产物.txt"), "x\n");

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("基线不可用");
		expect(r.消息).toContain("add -A");
		expect(commitCount(repo)).toBe(1); // 只有开工基线提交
	}, 20000);
});

interface ToolDef {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { text: string }[] }>;
}

function setup(cardDir?: string): Map<string, ToolDef> {
	const tools = new Map<string, ToolDef>();
	const pi = {
		registerTool: (def: { name: string; execute: ToolDef["execute"] }) =>
			tools.set(def.name, { execute: def.execute }),
		registerCommand: () => {},
		sendMessage: () => {},
		on: () => {},
	};
	registerDeliveryTools(pi as never, cardDir ? { resolveCardsDir: () => cardDir } : undefined);
	return tools;
}

describe("pao_deliver_card：批量与工具接线", () => {
	it.skipIf(process.platform !== "win32")(
		"受管交卷在真实 commit-tree 代理及后代运行时取消，不发布受控引用且宿主不变",
		async () => {
			const started = Date.now();
			const timing: Record<string, number> = {};
			const repo = makeRepo();
			const managed = join(tempDir("pao-cancel-managed-"), "worktree");
			git(repo, ["worktree", "add", "-b", "managed-cancel", managed, "HEAD"]);
			const head = git(repo, ["rev-parse", "HEAD"]).trim();
			const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
			const snapshotRepositoryPath = join(tempDir("pao-cancel-snapshot-"), "repo.git");
			git(repo, ["clone", "--bare", repo, snapshotRepositoryPath]);
			const cardDir = join(repo, ".pao", "卡");
			mkdirSync(cardDir, { recursive: true });
			const card = await createCard(cardDir, { 目标: "取消受管交卷", 部门: "测试", 验收: "存在: 产物.txt", 创建: "2026-10-21 01:00" });
			changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-21 01:01" });
			const snapshotRef = join(repo, ".pao", "input.json");
			const input = JSON.stringify({ cardNo: card.card_no, attempt: 1, head, tree, executionRoot: managed });
			writeFileSync(snapshotRef, input);
			// 复用 V10 的受管绑定形状；宿主登记为夹具，源码、裸仓快照、验收和 Git 进程均为真实。
			const binding = await bindExecutionContext({
				key: { cardsDir: cardDir, cardNo: card.card_no, attempt: 1 }, projectRoot: repo, repositoryRoot: managed, executionRoot: managed,
				worktree: { kind: "managed", worktreeId: "cancel-wt", taskRoot: repo, executionRoot: managed,
					commonGitDir: git(managed, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
					branchName: "managed-cancel", inputVersion: head, bindingDigest: `test-host:${head}`,
					baseline: { sourceRoot: repo, sourceHead: head, treeId: tree, snapshotRepositoryPath, inputVersion: head,
						capturedAt: new Date().toISOString(), fileCount: 1, byteCount: Buffer.byteLength("v1\n"), coverage: "complete",
						includedPaths: ["已跟踪.txt"], excludedPaths: [], notes: [] } },
				snapshotRef, snapshotDigest: `sha256:${createHash("sha256").update(input).digest("hex")}`,
			}, { expectedCurrentAttempt: 1 });
			await snapshotClaimBaseline(cardDir, card.card_no, { owner: "部长A", attempt: 1, execution: binding, 验收: card.frontmatter.acceptance });
			writeFileSync(join(managed, "产物.txt"), "真实产物\n");
			const verification = await verifyCard(cardDir, card.card_no, { operator: "部长A", executionKey: binding.key,
				sandbox_root: join(tempDir("pao-cancel-verify-"), "sandbox") });
			expect(verification.result.自动交付).toBe(true);
			timing.cardReadyMs = Date.now() - started;
			const shim = blockingGitShim();
			const controller = new AbortController();
			const independent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
			const actualRun = cardProcess.runCardProcess;
			const spy = vi.spyOn(cardProcess, "runCardProcess").mockImplementation((cmd, args, cwd, timeout, env, signal) => {
				const shimPath = `${shim.dir};${process.env.PATH ?? process.env.Path ?? ""}`;
				return actualRun(cmd, args, cwd, timeout, { ...process.env, ...env, PATH: shimPath, Path: shimPath,
					PAO_TEST_REAL_GIT: shim.realGit, PAO_TEST_GIT_MARKER: shim.marker, PAO_TEST_NODE: process.execPath }, signal);
			});
			const operation = deliverCard(cardDir, card.card_no, { executionKey: binding.key, signal: controller.signal });
			pendingCancellations.set(operation, controller);
			const outcome = operation.then(
				(result) => ({ kind: "returned" as const, result }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			);
			try {
				const deadline = Date.now() + 10000;
				while (!existsSync(shim.marker)) {
					const settled = await Promise.race([
						new Promise<"wait">((resolve) => setTimeout(() => resolve("wait"), 20)),
						outcome.then(() => "settled" as const),
					]);
					if (settled === "settled") {
						const early = await outcome;
						const detail =
							early.kind === "rejected"
								? early.error instanceof Error
									? `${early.error.name}: ${early.error.message}${
											"details" in early.error ? `；详情：${JSON.stringify(early.error.details)}` : ""
										}`
									: String(early.error)
								: JSON.stringify(early.result);
						throw new Error(`真实 commit-tree 代理未就绪；deliverCard 已提前结束：${detail}`);
					}
					if (Date.now() > deadline) throw new Error("真实 commit-tree 代理未就绪");
				}
				const marker = readFileSync(shim.marker, "utf8").trim().split(/\r?\n/).map(Number);
				const pids = marker.slice(0, 3);
				expect(marker[3]).toBe(0); // 真 Git 已完成 commit-tree，代理仍未返回，引用尚未发布。
				timing.commitTreeReadyMs = Date.now() - started;
				controller.abort();
				const stopped = await outcome;
				expect(stopped.kind).toBe("rejected");
				if (stopped.kind === "rejected") expect(stopped.error).toMatchObject({ name: "AbortError" });
				timing.stoppedMs = Date.now() - started;
				for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
				expect(() => process.kill(independent.pid!, 0)).not.toThrow();
				expect(commitCount(repo)).toBe(1);
				expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
				expect(git(managed, ["rev-parse", "HEAD"]).trim()).toBe(head);
				expect(spawnSync("git", ["rev-parse", "--verify", "refs/pao-execution/deliveries/card-0001-attempt-1"], { cwd: managed }).status).not.toBe(0);
				expect(existsSync(join(managed, "产物.txt"))).toBe(true);
			} finally {
				controller.abort();
				await outcome;
				pendingCancellations.delete(operation);
				spy.mockRestore();
				if (existsSync(shim.marker)) {
					const owned = readFileSync(shim.marker, "utf8").trim().split(/\r?\n/).map(Number).slice(0, 3);
					for (const pid of owned.reverse()) {
						try { process.kill(pid); } catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
						}
					}
				}
				const independentExited = new Promise<void>((resolve) => independent.once("exit", () => resolve()));
				independent.kill();
				await independentExited;
				timing.finishedMs = Date.now() - started;
				if (process.env.PAO_E_EVIDENCE_DIR) {
					mkdirSync(process.env.PAO_E_EVIDENCE_DIR, { recursive: true });
					writeFileSync(join(process.env.PAO_E_EVIDENCE_DIR, "timing-delivery-cancel.json"), JSON.stringify(timing));
				}
			}
		},
		40000,
	);

	it("deliverCards 串行逐卡，单卡被拒不中断其余", async () => {
		const repo = makeRepo();
		const a = await makeDeliverableCard(repo, "甲卡");
		// 乙卡停在待认领，必被拒
		const cardDir = a.cardDir;
		const b = await createCard(cardDir, { 目标: "乙卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:05" });
		const before = commitCount(repo);

		const results = await deliverCards(cardDir, [a.cardNo, b.card_no]);

		expect(results).toHaveLength(2);
		expect(results[0]?.交卷).toBe(true);
		expect(results[1]?.交卷).toBe(false);
		expect(results[1]?.原因).toBe("状态非已交付");
		expect(commitCount(repo)).toBe(before + 1);
	}, 20000);

	it("pao_deliver_card 工具：卡号数组批量、文本带逐卡结果与未推送提示", async () => {
		const repo = makeRepo();
		const a = await makeDeliverableCard(repo, "甲卡");
		const b = await createCard(a.cardDir, { 目标: "乙卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:05" });
		const cardDir = a.cardDir;
		const tools = setup(cardDir);

		const out = await tools.get("pao_deliver_card")!.execute("t1", { card_ref: [a.cardNo, b.card_no] });
		const text = out.content[0].text;
		expect(text).toContain("已交卷");
		expect(text).toContain(`卡${String(a.cardNo).padStart(4, "0")} 甲卡 · delivered · 机械验收通过`);
		expect(text).toContain("拒绝交卷"); // 乙卡待认领被拒
		expect(text).toContain("未推送");
		// 未提供卡目录且未配置默认目录 → 结构化报错
		const bare = setup();
		await expect(bare.get("pao_deliver_card")!.execute("t2", { card_ref: 1 })).rejects.toThrow(/卡目录/);
	}, 20000);
});

// ── S8-内核2（回执对账）：worker 交付回执增「未完成 todo」面 ──────────────────
// 权威清单来自 scanTodoState(getBranch())（todo/index.ts 纯函数），delivery 只做对账呈现；
// 语义红线：todo 全勾≠卡验收通过——验收衔接门判定零改动，todo 数据只是对账信息。

/** 假会话分支：单条成功 todo_write toolResult（权威清单的重建载体，同 todo-write.test.ts 口径） */
function todoBranch(todos: TodoItem[]): SessionEntry[] {
	return [
		{
			type: "message",
			id: `m-todo-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: new Date().toISOString(),
			parentId: undefined,
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "todo_write",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { version: 1, todos },
				timestamp: Date.now(),
			},
		} as unknown as SessionEntry,
	];
}

describe("pao_deliver_card：回执未完成待办对账（S8-内核2）", () => {
	it("有未完成待办 → 回执附对账段：未开始/进行中分列，已取消单列标注语义，已完成项不上榜", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		const branch = todoBranch([
			{ content: "写报告", status: "completed" },
			{ content: "补证据", status: "pending" },
			{ content: "跑长测", status: "in_progress" },
			{ content: "试方案A", status: "cancelled" },
		]);

		const r = await deliverCard(cardDir, cardNo, { 会话分支: branch });

		expect(r.交卷).toBe(true);
		expect(r.消息).toContain("未完成待办对账");
		expect(r.消息).toContain("不参与验收判定"); // 信息面声明（对账≠验收）
		expect(r.消息).toContain("未开始");
		expect(r.消息).toContain("补证据");
		expect(r.消息).toContain("进行中");
		expect(r.消息).toContain("跑长测");
		expect(r.消息).toContain("已取消");
		expect(r.消息).toContain("试方案A");
		expect(r.消息).toContain("不计未完成"); // cancelled 语义单列标注
		expect(r.消息).not.toContain("写报告"); // 已完成项不进对账段
		// 交卷本体行为不变
		expect(r.提交哈希).toBeTruthy();
		expect(commitCount(repo)).toBe(2);
	}, 20000);

	it("全勾 → 回执正常无对账段；验收衔接判定不变：未过仍拒交，全勾不解锁交卷", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		const done = todoBranch([
			{ content: "写报告", status: "completed" },
			{ content: "跑测试", status: "completed" },
		]);
		const r = await deliverCard(cardDir, cardNo, { 会话分支: done });
		expect(r.交卷).toBe(true);
		expect(r.提交哈希).toBeTruthy();
		expect(r.消息).toContain("已交卷"); // 回执正常
		expect(r.消息).not.toContain("待办对账"); // 全勾无对账段

		// 验收红线：机械验收未过 + todo 全勾 → 依旧拒绝交卷（todo 数据不参与验收判定）
		const repo2 = makeRepo();
		const dir2 = join(repo2, ".pao", "卡");
		mkdirSync(dir2, { recursive: true });
		const card = await createCard(dir2, { 目标: "未过卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:00" });
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		await snapshotClaimBaseline(dir2, card.card_no);
		writeFileSync(join(repo2, "产物.txt"), "x\n");
		const claimed = loadCard(dir2, card.card_no);
		changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		appendVerdictRaw(dir2, card.card_no, "- 结论: 未过");
		const before = commitCount(repo2);

		const r2 = await deliverCard(dir2, card.card_no, {
			会话分支: todoBranch([{ content: "全做完", status: "completed" }]),
		});

		expect(r2.交卷).toBe(false);
		expect(r2.原因).toBe("机械验收未过");
		expect(r2.消息).toContain("拒绝交卷");
		expect(commitCount(repo2)).toBe(before);
	}, 20000);

	it("无 todo 历史/空清单/仅剩已取消 → 回执不添对账段", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);

		const noHistory = await deliverCard(cardDir, cardNo, { 会话分支: [] });
		expect(noHistory.交卷).toBe(true);
		expect(noHistory.消息).not.toContain("待办对账");

		// 首交后无改动，后续两次走幂等路径（回执照出，依旧不添段）
		const emptied = todoBranch([]);
		const r2 = await deliverCard(cardDir, cardNo, { 会话分支: emptied });
		expect(r2.消息).toContain("幂等");
		expect(r2.消息).not.toContain("待办对账");

		const onlyCancelled = todoBranch([{ content: "试方案B", status: "cancelled" }]);
		const r3 = await deliverCard(cardDir, cardNo, { 会话分支: onlyCancelled });
		expect(r3.消息).toContain("幂等");
		expect(r3.消息).not.toContain("待办对账");
	}, 20000);

	it("工具接线：pao_deliver_card 从 ctx.sessionManager.getBranch() 取权威清单组装回执", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo, "接线卡");
		const tools = setup(cardDir);
		const ctx = { sessionManager: { getBranch: () => todoBranch([{ content: "清尾巴", status: "pending" }]) } };

		const out = await tools.get("pao_deliver_card")!.execute("t9", { card_ref: cardNo }, undefined, undefined, ctx);

		expect(out.content[0].text).toContain("已交卷");
		expect(out.content[0].text).toContain("未完成待办对账");
		expect(out.content[0].text).toContain("清尾巴");
	}, 20000);
});
describe("pao_deliver_card：产物提交只含 worker 真实产出", () => {
	it("自定布局下基线快照/黑板.md/四指标账.txt 不进交卷 commit（豁免清单兜底）", async () => {
		const repo = makeRepo();
		// 自定布局：卡目录在仓库根的 卡/，派发链自写文件落在仓库根（不在 .pao 内）
		const cardDir = join(repo, "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "豁免卡",
			部门: "核心机制",
			验收: "存在: 产出/hello.txt",
			创建: "2026-10-05 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-05 10:01" });
		await snapshotClaimBaseline(cardDir, card.card_no, { owner: "部长A", 时间: "2026-10-05 10:01" });
		// worker 真实产出 + 派发链自写文件（黑板/账；基线快照认领时已自动落 repo/基线/）
		mkdirSync(join(repo, "产出"), { recursive: true });
		writeFileSync(join(repo, "产出", "hello.txt"), "hello\n");
		writeFileSync(join(repo, "黑板.md"), "# 任务黑板\n");
		writeFileSync(join(repo, "四指标账.txt"), "# 四指标账\n");
		const delivered = loadCard(cardDir, card.card_no);
		changeCardStatus(delivered, { 操作者: "部长A", to: "delivered", 时间: "2026-10-05 10:30" });
		appendVerdictRaw(cardDir, card.card_no, "- 结论: 全过自动交付");

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(true);
		expect(r.暂存文件).toEqual(["产出/hello.txt"]);
		// commit 内容核对：只有 worker 真实产出，系统文件一个不进
		const committed = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
			.trim()
			.split(/\r?\n/)
			.filter(Boolean);
		expect(committed).toEqual(["产出/hello.txt"]);
		// 系统文件仍留在工作树（不被提交也不被清除）
		const status = git(repo, ["status", "--porcelain", "-uall"]);
		expect(status).toContain("黑板.md");
		expect(status).toContain("四指标账.txt");
	}, 20000);
});

describe("V10+V15：主目录 dirty/untracked 复制进 managed worktree 后继续修改", () => {
	it("只交付基线 tree 到 worker tree 的真实内容差，主仓 index 与 dirty 文件逐字节不变", async () => {
		const source = makeRepo();
		writeFileSync(join(source, "已跟踪.txt"), "用户 dirty v2\n");
		writeFileSync(join(source, "用户便签.txt"), "用户 untracked\n");
		git(source, ["add", "--", "已跟踪.txt"]);
		const originalIndex = readFileSync(join(source, ".git", "index"));
		const originalDirty = readFileSync(join(source, "已跟踪.txt"));
		const originalUntracked = readFileSync(join(source, "用户便签.txt"));

		const managed = join(tempDir("pao-managed-"), "worktree");
		git(source, ["worktree", "add", "-b", "managed-card", managed, "HEAD"]);
		writeFileSync(join(managed, "已跟踪.txt"), "用户 dirty v2\n");
		writeFileSync(join(managed, "用户便签.txt"), "用户 untracked\n");
		const cardDir = join(source, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "精确内容差",
			部门: "核心机制",
			验收: "包含: 已跟踪.txt :: worker 增量",
			创建: "2026-10-20 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-20 10:01" });
		const head = git(managed, ["rev-parse", "HEAD"]).trim();
		const treeId = git(managed, ["rev-parse", "HEAD^{tree}"]).trim();
		const commonGitDir = git(managed, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
		const binding = await bindExecutionContext(
			{
				key: { cardsDir: cardDir, cardNo: card.card_no, attempt: 1 },
				projectRoot: source,
				repositoryRoot: managed,
				executionRoot: managed,
				worktree: {
					kind: "managed",
					worktreeId: "wt-v10-v15",
					taskRoot: source,
					executionRoot: managed,
					commonGitDir,
					branchName: "managed-card",
					inputVersion: "input-v1",
					bindingDigest: `sha256:${"d".repeat(64)}`,
					baseline: {
						sourceRoot: source,
						sourceHead: head,
						treeId,
						snapshotRepositoryPath: join(tempDir("pao-snapshot-"), "repo.git"),
						inputVersion: "input-v1",
						capturedAt: "2026-10-20T10:01:00.000Z",
						fileCount: 2,
						byteCount: 30,
						coverage: "complete",
						includedPaths: ["已跟踪.txt", "用户便签.txt"],
						excludedPaths: [],
						notes: [],
					},
				},
				snapshotRef: join(tempDir("pao-input-"), "snapshot.json"),
				snapshotDigest: `sha256:${"e".repeat(64)}`,
				briefRef: `pao-brief://card-1-attempt-1?digest=sha256:${"f".repeat(64)}`,
			},
			{ expectedCurrentAttempt: 1 },
		);
		await snapshotClaimBaseline(cardDir, card.card_no, {
			owner: "部长A",
			时间: "2026-10-20 10:01",
			attempt: 1,
			execution: binding,
			验收: card.frontmatter.acceptance,
		});
		writeFileSync(join(managed, "已跟踪.txt"), "用户 dirty v2\nworker 增量\n");
		const verified = await verifyCard(cardDir, 1, {
			operator: "部长A",
			executionKey: binding.key,
			sandbox_root: join(tempDir("pao-verify-sandbox-"), "sandbox"),
		});
		expect(verified.result.结论).toBe("全过自动交付");
		expect(verified.result.自动交付).toBe(true);

		const result = await deliverCard(cardDir, 1, {
			executionKey: binding.key,
		});

		expect(result.交卷).toBe(true);
		expect(readFileSync(join(source, ".git", "index"))).toEqual(originalIndex);
		expect(readFileSync(join(source, "已跟踪.txt"))).toEqual(originalDirty);
		expect(readFileSync(join(source, "用户便签.txt"))).toEqual(originalUntracked);
		const delivered = git(managed, ["show", `${result.提交哈希}:已跟踪.txt`]);
		expect(delivered).toContain("worker 增量");
		expect(git(managed, ["show", `${result.提交哈希}:用户便签.txt`])).toBe("用户 untracked\n");
		const recordPath = join(cardDir, "..", "delivery-results", "card-0001-attempt-1.json");
		const record = JSON.parse(readFileSync(recordPath, "utf8"));
		expect((await deliverCard(cardDir, 1, { executionKey: binding.key })).提交哈希).toBe(result.提交哈希);
		for (const changed of [
			{ key: { ...record.key, cardsDir: join(source, ".pao", "other") } },
			{ key: { ...record.key, attempt: 2 } },
			{ baselineTree: "0".repeat(40) },
		]) {
			writeFileSync(recordPath, JSON.stringify({ ...record, ...changed }));
			await expect(deliverCard(cardDir, 1, { executionKey: binding.key })).rejects.toThrow(/不同输入|基线 tree 已变化/);
		}
		writeFileSync(recordPath, JSON.stringify(record));
		writeFileSync(join(managed, "已跟踪.txt"), "验收后的新内容\n");
		const stale = await deliverCard(cardDir, 1, { executionKey: binding.key });
		expect(stale.交卷).toBe(false);
		expect(stale.原因).toBe("测试后内容变化");
	}, 60000);
});
