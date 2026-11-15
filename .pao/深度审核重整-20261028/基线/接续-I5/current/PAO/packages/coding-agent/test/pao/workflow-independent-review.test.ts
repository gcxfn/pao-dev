/** 模拟模型回执；真实 Git 副本、Node 工人进程与正式验收链，不调用模型。 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { baselineSnapshotPath, captureContentTree, diffAgainstBaseline } from "../../src/pao/cards/baseline.ts";
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

interface ReviewOverride {
	/** 工人在副本里先执行的证据产出代码（新建文件）；默认只写 .pao/review.md。 */
	evidence?: string[];
	/** 工人对副本内既有业务文件的改动代码；默认无。 */
	mutate?: string;
	/** 覆盖默认回执（声明与 changes 必须与 evidence/mutate 实际产出一致）。 */
	receipt?: unknown;
	acceptance?: string;
	/** 认领与副本绑定完成后、真实工人启动前注入外部变化。 */
	beforeRun?: (options: WorkerRunOptions) => void;
}

async function setup(mutate: boolean, override: ReviewOverride = {}, cardOverrides?: ReviewOverride[]) {
	const root = mkdtempSync(join(tmpdir(), "pao-independent-review-"));
	roots.push(root);
	const project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(project, "source.txt"), "original\n");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
	git(project, "init", "--quiet");
	git(project, "config", "core.autocrlf", "false");
	git(project, "config", "core.eol", "lf");
	git(project, "add", ".");
	git(project, "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline");
	const source = {
		head: git(project, "rev-parse", "HEAD"),
		tree: git(project, "rev-parse", "HEAD^{tree}"),
	};
	const copy = join(root, "review");
	const copies: string[] = [];
	const bindings = new Map<string, ManagedWorktreeBinding>();
	const bindingFor = (executionRoot: string, worktreeId: string, branchName: string): ManagedWorktreeBinding => ({
		kind: "managed",
		worktreeId,
		branchName,
		taskRoot: project,
		executionRoot,
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
	});
	const binding = bindingFor(copy, "review-copy", "codex/review-copy");
	const host: PaoWorktreeHost = {
		async capability() {
			return { ok: true, create: true, cleanup: false, baseline: "recoverable-complete" };
		},
		async create(input) {
			if (!cardOverrides) {
				git(project, "worktree", "add", "--quiet", "-b", "codex/review-copy", copy, source.head);
				copies.push(copy);
				bindings.set(binding.worktreeId, binding);
				return binding;
			}
			if (!input.displayName) throw new Error(`测试宿主缺少审核显示名：${input.requestId}`);
			const sequence = copies.length + 1;
			const executionRoot = join(root, `review-${String(sequence).padStart(4, "0")}`);
			git(project, "worktree", "add", "--quiet", "-b", `codex/review-copy-${sequence}`, executionRoot, source.head);
			copies.push(executionRoot);
			const created = bindingFor(executionRoot, `review-copy-${sequence}`, `codex/review-copy-${sequence}`);
			bindings.set(created.worktreeId, created);
			return created;
		},
		async inspect() {
			return [];
		},
		async resolveForDispatch(input) {
			if (input.target.kind !== "managed") return binding;
			const resolved = bindings.get(input.target.worktreeId);
			if (!resolved) throw new Error(`测试宿主找不到工作树：${input.target.worktreeId}`);
			return resolved;
		},
		async requestCleanup() {
			return { ok: false, retained: true, reason: "测试保留证据，统一在 afterEach 清理" };
		},
	};
	const script = join(root, "worker.cjs");
	const defaultReceipt = {
		result: "success",
		summary: "模拟模型回执；真实工人已执行验证",
		artifact_path: [".pao/review.md"],
		任务态: "completed",
		changes: [],
		verification: [{ 条件: "读取独立副本", 结论: "pass", 证据: "source.txt" }],
	};
	const workerCases = (
		cardOverrides ?? [
			{ ...override, mutate: mutate ? "fs.writeFileSync('source.txt','changed\\n');" : override.mutate },
		]
	).map((spec, index) => ({
		key: cardOverrides ? `review-${String(index + 1).padStart(4, "0")}` : "review",
		code: `${spec.mutate ?? ""}
${(spec.evidence ?? []).join("\n")}
fs.mkdirSync('.pao',{recursive:true});fs.writeFileSync('.pao/review.md','checked');
const receipt=${JSON.stringify(spec.receipt ?? defaultReceipt)};
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(receipt)}],stopReason:'end'}}));`,
	}));
	writeFileSync(
		script,
		`const fs=require('node:fs');
const path=require('node:path');
if(fs.readFileSync('source.txt','utf8').replace(/\\r\\n/g,'\\n')!=='original\\n')throw Error('wrong input');
const card=path.basename(process.cwd());
${workerCases
	.map(
		(workerCase) => `if(card===${JSON.stringify(workerCase.key)}){
${workerCase.code}
} else`,
	)
	.join("\n")}
throw Error('unknown review copy: '+card);
`,
	);
	class TestRunner extends WorkerRunner {
		override run(options: WorkerRunOptions) {
			override.beforeRun?.(options);
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
	const refs = await addNodeCards(
		recipe,
		options,
		identity,
		(cardOverrides ?? [override]).map((card, index) => ({
			goal: cardOverrides ? `独立执行验证 ${index + 1}` : "独立执行验证",
			acceptance: card.acceptance ?? "存在: source.txt",
		})),
	);
	await endDecomposition(recipe, options, identity);
	return { recipe, options, project, copy, copies, ref: refs[0], refs, source, git, identity };
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
		await expect(decideNode(s.recipe, s.options, s.identity, pass)).rejects.toThrow(
			"原项目成果已变化，与审核副本所依据的 attempt 基线不一致",
		);
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
		).rejects.toThrow("原项目成果已变化，与审核副本所依据的 attempt 基线不一致");
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
		await expect(decision).rejects.toThrow(
			/文件锁获取失败|判定期间成果内容发生变化|工作树内容在内容树捕获期间发生变化|原项目成果已变化，与审核副本所依据的 attempt 基线不一致/,
		);
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

	/** 独立验证卡的 receipt；worker 产物的声明由既有越界核查逐项核对。 */
	function evidenceReceipt(paths: string[], changes: { 路径: string; 类型: string }[]) {
		return {
			result: "success",
			summary: "模拟模型回执；真实工人已在副本产出验证证据",
			artifact_path: paths,
			任务态: "completed",
			changes,
			verification: [{ 条件: "核对独立副本证据", 结论: "pass", 证据: "source.txt" }],
		};
	}

	describe("独立审核证据产出边界（r24 后续）", () => {
		/** 新建声明验证脚本/报告并跑通，随后机械验收全部走完。 */
		async function withDeclaredEvidence(override: ReviewOverride = {}) {
			return setup(false, {
				...override,
				acceptance: "存在: verify-review.cjs\n包含: verify_report.md :: 报告\n跑: node verify-review.cjs",
				evidence: [
					`fs.writeFileSync('verify-review.cjs', ${JSON.stringify("const fs=require('node:fs');if(fs.readFileSync('source.txt','utf8')!=='original\\n')process.exit(1);console.log('reviewed');\n")});fs.writeFileSync('verify_report.md','报告\\n');`,
				],
				receipt: evidenceReceipt(
					["verify-review.cjs", "verify_report.md"],
					[
						{ 路径: "verify-review.cjs", 类型: "created" },
						{ 路径: "verify_report.md", 类型: "created" },
					],
				),
			});
		}

		it("副本根新增声明验证脚本与报告：机械验收过、卡交付且源项目未新增文件", async () => {
			const s = await withDeclaredEvidence();
			const result = await runAutoChain(s.recipe, s.options);
			expect(result.stopReason, JSON.stringify(result)).not.toContain("版本不一致");
			expect(
				result.steps.find((step) => step.stage === "失败"),
				JSON.stringify(result),
			).toBeUndefined();
			expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("delivered");
			expect(existsSync(join(s.copy, "verify-review.cjs"))).toBe(true);
			expect(existsSync(join(s.project, "verify-review.cjs"))).toBe(false);
			expect(existsSync(join(s.project, "verify_report.md"))).toBe(false);
			expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		}, 60_000);

		it("修改副本已有业务文件仍被拒绝", async () => {
			const s = await setup(false, {
				evidence: ["fs.writeFileSync('verify_evidence.md','报告\\n');"],
				mutate: "fs.writeFileSync('source.txt','mutated\\n');",
				receipt: evidenceReceipt(["source.txt", "verify_evidence.md"], [{ 路径: "source.txt", 类型: "modified" }]),
			});
			const result = await runAutoChain(s.recipe, s.options);
			expect(result.stopReason).toContain("版本不一致");
			expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("failed");
			expect(readFileSync(join(s.copy, "source.txt"), "utf8")).toBe("mutated\n");
			expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		}, 60_000);

		it("删除副本已有业务文件仍被拒绝", async () => {
			const s = await setup(false, {
				evidence: ["fs.writeFileSync('verify_evidence.md','报告\\n');"],
				mutate: "fs.rmSync('source.txt');",
				receipt: evidenceReceipt(
					["verify_evidence.md"],
					[
						{ 路径: "source.txt", 类型: "deleted" },
						{ 路径: "verify_evidence.md", 类型: "created" },
					],
				),
			});
			const result = await runAutoChain(s.recipe, s.options);
			expect(result.stopReason).toContain("版本不一致");
			expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("failed");
			expect(existsSync(join(s.copy, "source.txt"))).toBe(false);
			expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		}, 60_000);

		it("重命名副本已有业务文件仍被拒绝", async () => {
			const s = await setup(false, {
				evidence: ["fs.writeFileSync('verify_evidence.md','报告\\n');"],
				mutate: "fs.renameSync('source.txt','renamed_source.txt');",
				receipt: evidenceReceipt(
					["renamed_source.txt"],
					[
						{ 路径: "renamed_source.txt", 类型: "moved" },
						{ 路径: "source.txt", 类型: "deleted" },
					],
				),
			});
			const result = await runAutoChain(s.recipe, s.options);
			expect(result.stopReason).toContain("版本不一致");
			expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("failed");
			expect(existsSync(join(s.copy, "renamed_source.txt"))).toBe(true);
			expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		}, 60_000);

		it("未声明的新增文件被越界核查拒绝", async () => {
			const s = await setup(false, {
				evidence: ["fs.writeFileSync('verify_evidence.md','报告\\n');fs.writeFileSync('undeclared.tmp','x\\n');"],
				receipt: evidenceReceipt(["verify_evidence.md"], [{ 路径: "verify_evidence.md", 类型: "created" }]),
			});
			const result = await runAutoChain(s.recipe, s.options);
			expect(result.steps.find((entry) => entry.stage === "失败")?.note).toContain("审核证据声明与副本真实新增不符");
			expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("failed");
			expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		}, 60_000);

		it("源项目在派发后新增业务文件被拒绝", async () => {
			const override: ReviewOverride = {
				evidence: ["fs.writeFileSync('verify_evidence.md','报告\\n');"],
				receipt: evidenceReceipt(["verify_evidence.md"], [{ 路径: "verify_evidence.md", 类型: "created" }]),
			};
			const s = await setup(false, override);
			override.beforeRun = () => writeFileSync(join(s.project, "injected.md"), "派发后写进原项目\n");
			const result = await runAutoChain(s.recipe, s.options);
			expect(result.stopReason).toContain("版本不一致");
			expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("failed");
			expect(readFileSync(join(s.project, "source.txt"), "utf8")).toBe("original\n");
		}, 60_000);

		it("原项目只提交同内容不误认内容变化", async () => {
			let commit: () => void;
			const s = await withDeclaredEvidence({ beforeRun: () => commit() });
			commit = () => {
				s.git(
					s.project,
					"-c",
					"user.name=test",
					"-c",
					"user.email=t@t",
					"commit",
					"--allow-empty",
					"-qm",
					"同内容仅提交",
				);
			};
			const result = await runAutoChain(s.recipe, s.options);
			expect(result.stopReason, JSON.stringify(result)).not.toContain("版本不一致");
			expect(loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status).toBe("delivered");
		}, 60_000);

		it("副本基线不可用（内容树快照缺失）不放行", async () => {
			const s = await withDeclaredEvidence();
			let removed = false;
			const result = await runAutoChain(s.recipe, {
				...s.options,
				onReceipt: () => {
					const baseline = baselineSnapshotPath(s.options.cardsDir, parseCardRef(s.ref), 1);
					expect(existsSync(baseline)).toBe(true);
					rmSync(baseline);
					removed = true;
				},
			});
			expect(removed).toBe(true);
			expect(result.stopReason).not.toContain("派发异常");
			expect(result.steps.find((entry) => entry.stage === "失败")?.note).toContain("审核副本基线不可用");
			expect(
				result.steps.find((step) => step.stage === "失败" || step.stage === "停审"),
				JSON.stringify(result),
			).toBeDefined();
			const status = loadCard(s.options.cardsDir, parseCardRef(s.ref)).frontmatter.status;
			expect(status === "failed" || status === "in_progress").toBe(true);
			expect(status).not.toBe("delivered");
		}, 60_000);

		it("三张审核卡各新增不同声明证据，机械验收和最终 pass 共用同一原成果版本", async () => {
			const cardOverrides = [1, 2, 3].map((index) => {
				const script = `verify-review-${index}.cjs`;
				const report = `verify_report_${index}.md`;
				const marker = `review-${index}`;
				return {
					acceptance: `存在: ${script}\n包含: ${report} :: 报告\n跑: node ${script}`,
					evidence: [
						`fs.writeFileSync(${JSON.stringify(script)}, ${JSON.stringify(
							`const fs=require('node:fs');if(!fs.readFileSync('source.txt','utf8').includes('original'))process.exit(1);console.log(${JSON.stringify(marker)});\n`,
						)});fs.writeFileSync(${JSON.stringify(report)}, ${JSON.stringify(`报告 ${index}\n`)});`,
					],
					receipt: {
						result: "success",
						summary: `模拟模型回执；真实工人已执行第 ${index} 份独立审核证据`,
						artifact_path: [script, report],
						任务态: "completed",
						changes: [
							{ 路径: script, 类型: "created" },
							{ 路径: report, 类型: "created" },
						],
						verification: [{ 条件: `核对独立副本第 ${index} 份证据`, 结论: "pass", 证据: script }],
					},
				} satisfies ReviewOverride;
			});
			const s = await setup(false, {}, cardOverrides);
			const result = await runAutoChain(s.recipe, s.options);
			if (result.steps.filter((step) => step.stage === "验收").length !== 3) {
				const copySource = s.copies.map((root) => ({
					root,
					source: existsSync(join(root, "source.txt"))
						? readFileSync(join(root, "source.txt"), "utf8")
						: "(missing)",
				}));
				throw new Error(
					`三卡组合未完成机械验收：${JSON.stringify(result)}；源=${JSON.stringify(
						readFileSync(join(s.project, "source.txt"), "utf8"),
					)}；副本=${JSON.stringify(copySource)}`,
				);
			}
			expect(result.stopReason, JSON.stringify(result)).not.toContain("版本不一致");
			expect(result.steps.filter((step) => step.stage === "验收").map((step) => step.note)).toEqual([
				expect.stringContaining("全过自动交付"),
				expect.stringContaining("全过自动交付"),
				expect.stringContaining("全过自动交付"),
			]);
			expect(
				result.steps.find((step) => step.stage === "失败" || step.stage === "停审"),
				JSON.stringify(result),
			).toBeUndefined();

			const pass = {
				结果: "pass" as const,
				理由: "三张审核卡均由真实 Node 工人和三条真实检查命令完成，原项目成果未变化",
				引用: ["source.txt:1"],
			};
			await decideNode(s.recipe, s.options, s.identity, pass);

			const sourceTree = (await captureContentTree(s.project)).tree;
			const cardResults = await Promise.all(
				s.refs.map(async (ref, index) => {
					const card = loadCard(s.options.cardsDir, parseCardRef(ref));
					expect(card.frontmatter.status).toBe("delivered");
					const diff = await diffAgainstBaseline(
						baselineSnapshotPath(s.options.cardsDir, card.card_no, card.frontmatter.attempt),
					);
					expect(diff.基线Tree).toBe(sourceTree);
					expect(diff.worker改动.map((entry) => `${entry.状态} ${entry.文件}`)).toEqual([
						expect.stringMatching(/^(?:A|\?\?) verify_report_[123]\.md$/),
						expect.stringMatching(/^(?:A|\?\?) verify-review-[123]\.cjs$/),
					]);
					return {
						baselineTree: diff.基线Tree,
						copyTree: diff.当前Tree,
						copyRoot: s.copies[index],
					};
				}),
			);
			expect(new Set(cardResults.map((item) => item.baselineTree))).toEqual(new Set([sourceTree]));
			expect(new Set(cardResults.map((item) => item.copyTree)).size).toBe(3);
			for (const [index, item] of cardResults.entries()) {
				expect(item.copyRoot).toBeDefined();
				expect(existsSync(join(item.copyRoot!, `verify-review-${index + 1}.cjs`))).toBe(true);
				expect(existsSync(join(item.copyRoot!, `verify_report_${index + 1}.md`))).toBe(true);
				expect(existsSync(join(s.project, `verify-review-${index + 1}.cjs`))).toBe(false);
				expect(existsSync(join(s.project, `verify_report_${index + 1}.md`))).toBe(false);
			}
			const flow = readControl(s.recipe, s.options);
			expect(flow.节点[0].判定?.结果).toBe("pass");
			expect(flow.节点[0].判定?.contentTree).toBe(sourceTree);
			expect((await readControlReport(flow, s.options)).status).toBe("completed");
		}, 120_000);
	});
});
