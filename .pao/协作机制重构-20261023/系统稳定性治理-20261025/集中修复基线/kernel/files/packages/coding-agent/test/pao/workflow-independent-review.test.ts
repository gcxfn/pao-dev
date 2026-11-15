/** 模拟模型回执；真实 Git 副本、Node 工人进程与正式验收链，不调用模型。 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { baselineSnapshotPath } from "../../src/pao/cards/baseline.ts";
import { executionContextPath } from "../../src/pao/cards/execution-context.ts";
import { loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { runAutoChain } from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	decideNode,
	endDecomposition,
	readControl,
	readControlReport,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import type { ManagedWorktreeBinding, PaoWorktreeHost } from "../../src/pao/worktrees/types.ts";

const roots: string[] = [];
const runners: WorkerRunner[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(mutate: boolean) {
	const root = mkdtempSync(join(tmpdir(), "pao-independent-review-"));
	roots.push(root);
	const project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(project, "source.txt"), "original\n");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
	git(project, "init", "--quiet");
	git(project, "add", ".");
	git(project, "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline");
	const source = {
		head: git(project, "rev-parse", "HEAD"),
		tree: git(project, "rev-parse", "HEAD^{tree}"),
	};
	const copy = join(root, "review");
	const binding: ManagedWorktreeBinding = {
		kind: "managed",
		worktreeId: "review-copy",
		branchName: "codex/review-copy",
		taskRoot: project,
		executionRoot: copy,
		commonGitDir: join(project, ".git"),
		inputVersion: "review-input",
		bindingDigest: `sha256:${"1".repeat(64)}`,
		baseline: {
			sourceRoot: project,
			sourceHead: source.head,
			treeId: source.tree,
			snapshotRepositoryPath: project,
			inputVersion: "review-input",
			capturedAt: new Date().toISOString(),
			fileCount: 1,
			byteCount: 9,
			coverage: "complete",
			includedPaths: ["source.txt"],
			excludedPaths: [".pao"],
			notes: [],
		},
	};
	const host: PaoWorktreeHost = {
		async capability() {
			return { ok: true, create: true, cleanup: false, baseline: "recoverable-complete" };
		},
		async create() {
			git(project, "worktree", "add", "--quiet", "-b", "codex/review-copy", copy, source.head);
			return binding;
		},
		async inspect() {
			return [];
		},
		async resolveForDispatch() {
			return binding;
		},
		async requestCleanup() {
			return { ok: false, retained: true, reason: "测试保留证据，统一在 afterEach 清理" };
		},
	};
	const script = join(root, "worker.cjs");
	writeFileSync(
		script,
		`const fs=require('node:fs');
if(fs.readFileSync('source.txt','utf8')!=='original\\n')throw Error('wrong input');
${mutate ? "fs.writeFileSync('source.txt','changed\\n');" : ""}
fs.mkdirSync('.pao',{recursive:true});fs.writeFileSync('.pao/review.md','checked');
const receipt={result:'success',summary:'模拟模型回执；真实工人已执行验证',artifact_path:['.pao/review.md'],任务态:'completed',changes:[],verification:[{条件:'读取独立副本',结论:'pass',证据:'source.txt'}]};
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(receipt)}],stopReason:'end'}}));`,
	);
	class TestRunner extends WorkerRunner {
		override run(options: WorkerRunOptions) {
			return super.run({ ...options, 命令: process.execPath, 参数: [script] });
		}
	}
	const runner = new TestRunner();
	runners.push(runner);
	const paoHome = join(root, "home");
	mkdirSync(join(paoHome, "pao配置"), { recursive: true });
	writeFileSync(
		join(paoHome, "pao配置", "档位.json"),
		JSON.stringify({
			provider: "pao",
			档位: [{ 名: "primary", provider: "offline", model: "offline", thinkingLevel: "off" }],
		}),
	);
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "独立验证",
			参数: [],
			自动执行: true,
			节点: [
				{
					名字: "审核",
					部门: "审核",
					目标: "独立核查",
					验收: "存在: source.txt",
					只读: true,
					审核: true,
					部门标准: "真实证据",
				},
			],
		})}---\n`,
		join(root, "独立验证.md"),
	);
	const options = {
		cardsDir: join(project, ".pao", "卡"),
		ownerSessionId: "owner",
		运行器: runner,
		paoHome,
		worktreeHost: host,
	};
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "审核", "reviewer");
	const identity = { 实例: readControl(recipe, options).实例, 节点: "审核", 轮次: 1, 部长会话: "reviewer" };
	const [ref] = await addNodeCards(recipe, options, identity, [
		{ goal: "独立执行验证", acceptance: "存在: source.txt" },
	]);
	await endDecomposition(recipe, options, identity);
	return { recipe, options, project, copy, ref, source, git, identity };
}

describe("独立审核工人", () => {
	it("在独立副本执行、交付证据，原项目与 HEAD 不被改写", async () => {
		const s = await setup(false);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason, JSON.stringify(result)).not.toContain("派发异常");
		expect(
			result.steps.find((step) => step.stage === "失败"),
			JSON.stringify(result),
		).toBeUndefined();
		expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("delivered");
		expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		expect(s.git(s.project, "rev-parse", "HEAD")).toBe(s.source.head);
		expect(result.report.status).not.toBe("completed"); // 工人证据不替代部长最终判定。
	}, 30_000);
	it("工人修改副本业务源码即拒绝审核放行，不能借验证卡交付修补代码", async () => {
		const s = await setup(true);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).toContain("审核验证成果版本不一致");
		expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("failed");
		expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		expect(readFileSync(join(s.copy, "source.txt"), "utf8")).toBe("changed\n");
	}, 30_000);
	it("首次合法通过绑定当前成果，检查后源码变化即拒绝旧卡重新盖章", async () => {
		const s = await setup(false);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).not.toContain("派发异常");
		const pass = {
			结果: "pass" as const,
			理由: "真实 Node 工人和机械验收均已核对",
			引用: ["source.txt:1"],
		};
		await decideNode(s.recipe, s.options, s.identity, pass);
		expect((await readControlReport(readControl(s.recipe, s.options), s.options)).status).toBe("completed");
		const checkedTree = readControl(s.recipe, s.options).节点[0].判定!.contentTree;

		writeFileSync(join(s.project, "source.txt"), "changed-after-check\n");
		await expect(decideNode(s.recipe, s.options, s.identity, pass)).rejects.toThrow("检查后 tree 已过期");
		const flow = readControl(s.recipe, s.options);
		expect(flow.节点[0].判定?.contentTree).toBe(checkedTree);
		expect(flow.记录.some((entry) => entry.事件 === "审核判定失效")).toBe(false);
		expect((await readControlReport(flow, s.options)).status).not.toBe("completed");
	}, 30_000);
	it("等待判定前原项目源码变化，首次 pass 不能给旧卡重新盖章", async () => {
		const s = await setup(false);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).not.toContain("派发异常");
		writeFileSync(join(s.project, "source.txt"), "changed-before-pass\n");
		await expect(
			decideNode(s.recipe, s.options, s.identity, {
				结果: "pass",
				理由: "真实 Node 工人和机械验收均已核对",
				引用: ["source.txt:1"],
			}),
		).rejects.toThrow("检查后 tree 已过期");
		const flow = readControl(s.recipe, s.options);
		expect(flow.节点[0].判定).toBeUndefined();
		expect((await readControlReport(flow, s.options)).status).not.toBe("completed");
	}, 30_000);
	it("等待控制锁期间源码变化，第一次 pass 也拒绝", async () => {
		const s = await setup(false);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).not.toContain("派发异常");
		const lock = `${controlPath(s.recipe, s.options)}.lock`;
		mkdirSync(lock);
		const decision = decideNode(s.recipe, s.options, s.identity, {
			结果: "pass",
			理由: "真实 Node 工人和机械验收均已核对",
			引用: ["source.txt:1"],
		});
		await new Promise((done) => setTimeout(done, 300));
		writeFileSync(join(s.project, "source.txt"), "changed-while-locked\n");
		rmSync(lock, { recursive: true, force: true });
		await expect(decision).rejects.toThrow(/文件锁获取失败|判定期间成果内容发生变化|检查后 tree 已过期/);
		expect(readControl(s.recipe, s.options).节点[0].判定).toBeUndefined();
	}, 30_000);
	it("新式执行证据缺机械验收结论时，未验证运行理由不能降级放行", async () => {
		const s = await setup(false);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).not.toContain("派发异常");
		const card = loadCard(s.options.cardsDir, parseCardRef(s.ref));
		expect(card.frontmatter.status).toBe("delivered");
		expect(
			existsSync(
				executionContextPath({
					cardsDir: s.options.cardsDir,
					cardNo: card.card_no,
					attempt: card.frontmatter.attempt,
				}),
			),
		).toBe(true);
		const body = card.body.replace(/^## 机械验收 (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/gm, "## 失效验收 $1");
		expect(body).not.toMatch(/^## 机械验收 \d{4}/m);
		writeFileSync(card.path, serializeCard(card.frontmatter, body));

		await expect(
			decideNode(s.recipe, s.options, s.identity, {
				结果: "pass",
				理由: "未验证运行；但当前尝试已有新式执行证据",
				引用: ["source.txt:1"],
			}),
		).rejects.toThrow("不能降级为静态审核");
		expect(readControl(s.recipe, s.options).节点[0].判定).toBeUndefined();
	}, 30_000);
	it("新式执行证据缺执行根和关联摘要时，未验证运行理由不能降级放行", async () => {
		const s = await setup(false);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).not.toContain("派发异常");
		const card = loadCard(s.options.cardsDir, parseCardRef(s.ref));
		expect(card.frontmatter.status).toBe("delivered");
		expect(
			existsSync(
				executionContextPath({
					cardsDir: s.options.cardsDir,
					cardNo: card.card_no,
					attempt: card.frontmatter.attempt,
				}),
			),
		).toBe(true);
		expect(card.body).toMatch(/^-\s*执行根:\s*.+$/m);
		expect(card.body).toMatch(/^-\s*关联摘要:\s*.+$/m);
		const body = card.body.replace(/^-\s*执行根:.*(?:\r?\n|$)/gm, "").replace(/^-\s*关联摘要:.*(?:\r?\n|$)/gm, "");
		expect(body).not.toMatch(/^-\s*(?:执行根|关联摘要):/m);
		writeFileSync(card.path, serializeCard(card.frontmatter, body));

		await expect(
			decideNode(s.recipe, s.options, s.identity, {
				结果: "pass",
				理由: "未验证运行；但当前尝试已有新式执行证据",
				引用: ["source.txt:1"],
			}),
		).rejects.toThrow("不能降级为静态审核");
		expect(readControl(s.recipe, s.options).节点[0].判定).toBeUndefined();
	}, 30_000);
	it("无新式执行证据的旧卡仍可按未验证运行契约放行", async () => {
		const s = await setup(false);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).not.toContain("派发异常");
		const card = loadCard(s.options.cardsDir, parseCardRef(s.ref));
		expect(card.frontmatter.status).toBe("delivered");
		rmSync(
			executionContextPath({
				cardsDir: s.options.cardsDir,
				cardNo: card.card_no,
				attempt: card.frontmatter.attempt,
			}),
			{ force: true },
		);
		rmSync(baselineSnapshotPath(s.options.cardsDir, card.card_no, card.frontmatter.attempt), { force: true });
		const body = card.body.replace(/^-\s*执行根:.*(?:\r?\n|$)/gm, "").replace(/^-\s*关联摘要:.*(?:\r?\n|$)/gm, "");
		writeFileSync(card.path, serializeCard(card.frontmatter, body));

		await expect(
			decideNode(s.recipe, s.options, s.identity, {
				结果: "pass",
				理由: "未验证运行；本测试模拟没有新式执行证据的旧卡",
				引用: ["source.txt:1"],
			}),
		).resolves.toBeUndefined();
		expect(readControl(s.recipe, s.options).节点[0].判定?.结果).toBe("pass");
	}, 30_000);
});
