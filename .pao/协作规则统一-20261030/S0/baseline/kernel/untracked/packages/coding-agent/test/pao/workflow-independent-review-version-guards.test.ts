/** 模拟模型回执；真实 Git 仓库、受管副本、Node 工人、机械验收和工作流判定入口。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { baselineSnapshotPath } from "../../src/pao/cards/baseline.ts";
import { executionContextPath } from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus, loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { type AutoChainOptions, runAutoChain } from "../../src/pao/workflow/auto.ts";
import {
	addNodeCards,
	bindMinister,
	decideNode,
	endDecomposition,
	pauseControl,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import {
	createSingleRootWorktreeHost,
	type ManagedWorktreeBinding,
	type PaoWorktreeHost,
} from "../../src/pao/worktrees/types.ts";

/**
 * 只在下面两个竞态用例启用：拦住真实 helper 的返回时机。
 * 未启用时全部委托真实实现，其余用例仍是真实 Git/副本/验收链。
 */
const reviewVersionGate = vi.hoisted(() => ({
	enabled: false,
	entered: undefined as (() => void) | undefined,
	release: undefined as (() => void) | undefined,
}));
vi.mock("../../src/pao/cards/baseline.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/pao/cards/baseline.ts")>();
	return {
		...actual,
		async verifyReviewEvidenceVersion(input: Parameters<typeof actual.verifyReviewEvidenceVersion>[0]) {
			if (!reviewVersionGate.enabled) return actual.verifyReviewEvidenceVersion(input);
			await new Promise<void>((resolve) => {
				reviewVersionGate.release = resolve;
				reviewVersionGate.entered?.();
			});
			return actual.verifyReviewEvidenceVersion(input);
		},
	};
});

const roots: string[] = [];
const runners: WorkerRunner[] = [];

afterEach(async () => {
	reviewVersionGate.enabled = false;
	reviewVersionGate.entered = undefined;
	reviewVersionGate.release?.();
	reviewVersionGate.release = undefined;
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface CardSpec {
	script: string;
	report: string;
	acceptance?: string;
	body: string;
}

interface Fixture {
	root: string;
	project: string;
	recipe: ReturnType<typeof parseRecipe>;
	options: AutoChainOptions;
	identity: { 实例: string; 节点: string; 轮次: number; 部长会话: string };
	refs: string[];
	copies: string[];
	git: (cwd: string, ...args: string[]) => string;
}

function yamlRecipe(review = true) {
	const name = review ? "独立审核版本守卫" : "普通实施版本守卫";
	return parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: name,
			参数: [],
			自动执行: true,
			节点: [
				{
					名字: review ? "审核" : "开发",
					部门: review ? "审核" : "开发",
					目标: review ? "独立核查" : "实施",
					验收: "存在: source.txt",
					...(review ? { 只读: true, 审核: true, 部门标准: "真实证据" } : {}),
				},
			],
		})}---\n`,
		join(tmpdir(), `${name}.md`),
	);
}

async function setup(specs: CardSpec[], review = true): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "pao-review-version-guard-"));
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
	const copies: string[] = [];
	const bindings = new Map<string, ManagedWorktreeBinding>();
	const host: PaoWorktreeHost = {
		async capability() {
			return { ok: true, create: true, cleanup: false, baseline: "recoverable-complete" };
		},
		async create(input) {
			if (!input.displayName) throw new Error(`缺少审核显示名：${input.requestId}`);
			const sequence = copies.length + 1;
			const executionRoot = join(root, `review-${String(sequence).padStart(4, "0")}`);
			// 每次真实新建副本都以该次派发前的 HEAD 为起点，而不是夹具初始化时的旧提交。
			const sourceHead = git(project, "rev-parse", "HEAD");
			const sourceTree = git(project, "rev-parse", "HEAD^{tree}");
			git(project, "worktree", "add", "--quiet", "-b", `codex/review-copy-${sequence}`, executionRoot, sourceHead);
			copies.push(executionRoot);
			const binding: ManagedWorktreeBinding = {
				kind: "managed",
				worktreeId: `review-copy-${sequence}`,
				branchName: `codex/review-copy-${sequence}`,
				taskRoot: project,
				executionRoot,
				commonGitDir: join(project, ".git"),
				inputVersion: "review-input",
				bindingDigest: `sha256:${String(sequence).repeat(64).slice(0, 64)}`,
				baseline: {
					sourceRoot: project,
					sourceHead,
					treeId: sourceTree,
					snapshotRepositoryPath: project,
					inputVersion: "review-input",
					capturedAt: new Date().toISOString(),
					fileCount: 1,
					byteCount: readFileSync(join(executionRoot, "source.txt")).byteLength,
					coverage: "complete",
					includedPaths: ["source.txt"],
					excludedPaths: [".pao"],
					notes: [],
				},
			};
			bindings.set(binding.worktreeId, binding);
			return binding;
		},
		async inspect() {
			return [];
		},
		async resolveForDispatch(input) {
			if (input.target.kind !== "managed") throw new Error("测试只接受受管副本");
			const binding = bindings.get(input.target.worktreeId);
			if (!binding) throw new Error(`找不到工作树：${input.target.worktreeId}`);
			return binding;
		},
		async requestCleanup() {
			return { ok: false, retained: true, reason: "测试保留现场，afterEach 统一清理" };
		},
	};
	const script = join(root, "worker.cjs");
	const normalReceipt = {
		result: "success",
		summary: "模拟模型回执；真实 Node 工人已执行普通实施",
		artifact_path: ["implement.cjs", "implementation.md"],
		任务态: "completed",
		changes: [
			{ 路径: "implement.cjs", 类型: "created" },
			{ 路径: "implementation.md", 类型: "created" },
		],
		verification: [{ 条件: "执行实施检查", 结论: "pass", 证据: "implement.cjs" }],
	};
	const workerCases = specs.map((item, index) => ({
		key: `review-${String(index + 1).padStart(4, "0")}`,
		body: item.body,
	}));
	writeFileSync(
		script,
		review
			? `const fs=require('node:fs');
const path=require('node:path');
const card=path.basename(process.cwd());
if(!/original|second-baseline/.test(fs.readFileSync('source.txt','utf8')))throw Error('wrong input');
const cardName=path.basename(process.cwd());
${workerCases
	.map(
		(item) => `if(card===${JSON.stringify(item.key)}){
${item.body}
} else`,
	)
	.join("\n")}
throw Error('unknown review copy: '+cardName);
	`
			: `const fs=require('node:fs');
fs.writeFileSync('implement.cjs', 'console.log("implemented")\\n');
fs.writeFileSync('implementation.md', 'done\\n');
const receipt=${JSON.stringify(normalReceipt)};
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(receipt)}],stopReason:'end'}}));
`,
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
	const recipe = yamlRecipe(review);
	const options: AutoChainOptions = {
		cardsDir: join(project, ".pao", "卡"),
		ownerSessionId: "owner",
		运行器: runner,
		paoHome,
		worktreeHost: review ? host : createSingleRootWorktreeHost(project),
	};
	await startControl(recipe, {}, options);
	const nodeName = review ? "审核" : "开发";
	await bindMinister(recipe, options, nodeName, "reviewer");
	const identity = {
		实例: readControl(recipe, options).实例,
		节点: nodeName,
		轮次: 1,
		部长会话: "reviewer",
	};
	const refs = await addNodeCards(
		recipe,
		options,
		identity,
		specs.map((item, index) => ({
			goal: `${nodeName}${index + 1}`,
			acceptance: item.acceptance ?? `存在: ${item.script}\n存在: ${item.report}\n跑: node ${item.script}`,
		})),
	);
	await endDecomposition(recipe, options, identity);
	return { root, project, recipe, options, identity, refs, copies, git };
}

function receipt(script: string, report: string, overrides: Record<string, unknown> = {}) {
	return {
		result: "success",
		summary: "模拟模型回执；真实 Node 工人已执行独立审核",
		artifact_path: [script, report],
		任务态: "completed",
		changes: [
			{ 路径: script, 类型: "created" },
			{ 路径: report, 类型: "created" },
		],
		verification: [{ 条件: "执行审核证据", 结论: "pass", 证据: script }],
		...overrides,
	};
}

function evidenceSpec(index: number, overrides: Record<string, unknown> = {}): CardSpec {
	const script = `verify-review-${index}.cjs`;
	const report = `verify-report-${index}.md`;
	return {
		script,
		report,
		acceptance: `存在: ${script}\n包含: ${report} :: report\n跑: node ${script}`,
		body: `fs.writeFileSync(${JSON.stringify(script)}, ${JSON.stringify(
			`const fs=require('node:fs');const text=fs.readFileSync('source.txt','utf8');if(!/original|second-baseline/.test(text))process.exit(1);console.log('reviewed-${index}');\n`,
		)});fs.writeFileSync(${JSON.stringify(report)}, ${JSON.stringify(`report ${index}\n`)});
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(${JSON.stringify(receipt(script, report, overrides))})}],stopReason:'end'}}));`,
	};
}

function pass(理由 = "真实 Node 工人与机械验收已核对，原项目成果未变化") {
	return { 结果: "pass" as const, 理由, 引用: ["source.txt:1"] };
}

function holdNextReviewVersion(): Promise<void> {
	reviewVersionGate.enabled = true;
	reviewVersionGate.release = undefined;
	return new Promise((resolve) => {
		reviewVersionGate.entered = resolve;
	});
}

function releaseReviewVersion(): void {
	const release = reviewVersionGate.release;
	if (!release) throw new Error("审核版本核对尚未开始");
	release();
}

function moveCardToNextAttempt(cardsDir: string, ref: string): void {
	const current = loadCard(cardsDir, parseCardRef(ref));
	const operator = current.frontmatter.owner;
	if (!operator) throw new Error("竞态夹具缺少卡 owner");
	changeCardStatus(current, {
		操作者: operator,
		to: "failed",
		失败类型: "unknown_outcome",
		依据: "模拟返修开始",
		时间: "2026-10-27 18:00",
	});
	const failed = loadCard(cardsDir, parseCardRef(ref));
	changeCardStatus(failed, {
		操作者: operator,
		to: "unclaimed",
		依据: "模拟返修重开",
		时间: "2026-10-27 18:01",
	});
	const reopened = loadCard(cardsDir, parseCardRef(ref));
	changeCardStatus(reopened, {
		操作者: operator,
		to: "in_progress",
		依据: "模拟新尝试启动",
		时间: "2026-10-27 18:02",
	});
}

async function runDelivered(s: Fixture) {
	const result = await runAutoChain(s.recipe, s.options);
	expect(result.steps.filter((step) => step.stage === "验收")).toHaveLength(s.refs.length);
	expect(result.steps.find((step) => step.stage === "失败" || step.stage === "停审")).toBeUndefined();
	for (const ref of s.refs) {
		expect(loadCard(s.options.cardsDir, parseCardRef(ref)).frontmatter.status).toBe("delivered");
	}
	return result;
}

describe("独立审核证据版本的定向负例", () => {
	it("验证后修改副本证据：最终 pass 拒绝", async () => {
		const s = await setup([evidenceSpec(1)]);
		await runDelivered(s);
		writeFileSync(join(s.copies[0]!, "verify-report-1.md"), "tampered after verification\n");
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("审核副本检查后 tree 已变化");
		expect(readControl(s.recipe, s.options).节点[0]!.判定).toBeUndefined();
	}, 60_000);

	it("验证后向副本新增未声明证据：最终 pass 拒绝", async () => {
		const s = await setup([evidenceSpec(1)]);
		await runDelivered(s);
		writeFileSync(join(s.copies[0]!, "late-undeclared.txt"), "not declared\n");
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("审核副本检查后 tree 已变化");
	}, 60_000);

	it.each([
		["版本 helper 等待后正常返回，但卡已换新尝试", "attempt"],
		["版本 helper 等待后真实抛错，且卡已取消", "canceled"],
	] as const)(
		"%s：不落失败、不覆盖现场",
		async (_name, cardChange) => {
			const s = await setup([evidenceSpec(1)]);
			const entering = holdNextReviewVersion();
			const chain = runAutoChain(s.recipe, s.options);
			await entering;

			const ref = s.refs[0]!;
			if (cardChange === "attempt") {
				moveCardToNextAttempt(s.options.cardsDir, ref);
			} else {
				// 让真实 helper 在恢复后拒绝；此处同时模拟审核等待期间的取消。
				writeFileSync(join(s.project, "source.txt"), "changed while review version waits\n");
				const card = loadCard(s.options.cardsDir, parseCardRef(ref));
				changeCardStatus(card, {
					操作者: "用户",
					to: "canceled",
					依据: "模拟审核等待期间取消",
					时间: "2026-10-27 18:03",
				});
			}
			const beforeRelease = loadCard(s.options.cardsDir, parseCardRef(ref));
			const bodyBeforeRelease = beforeRelease.body;
			releaseReviewVersion();

			const result = await chain;
			expect(result.stopReason).toContain("状态或尝试已变化");
			expect(result.steps.find((step) => step.stage === "失败")).toBeUndefined();
			const card = loadCard(s.options.cardsDir, parseCardRef(ref));
			expect(card.body).toBe(bodyBeforeRelease);
			if (cardChange === "attempt") {
				expect(card.frontmatter.status).toBe("in_progress");
				expect(card.frontmatter.attempt).toBe(2);
			} else {
				expect(card.frontmatter.status).toBe("canceled");
				expect(card.frontmatter.attempt).toBe(1);
			}
			expect(readControl(s.recipe, s.options).节点[0]!.判定).toBeUndefined();
			await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("全部卡机械交付");
		},
		60_000,
	);

	it("两张审核卡真实基于不同原成果版本：聚合拒绝覆盖多个原成果", async () => {
		const s = await setup([evidenceSpec(1), evidenceSpec(2)]);
		const first = await runAutoChain(s.recipe, { ...s.options, maxCards: 1 });
		expect(first.steps.filter((step) => step.stage === "验收")).toHaveLength(1);
		writeFileSync(join(s.project, "source.txt"), "second-baseline\n");
		s.git(s.project, "add", "source.txt");
		s.git(s.project, "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "second baseline");
		const second = await runAutoChain(s.recipe, s.options);
		expect(second.steps.filter((step) => step.stage === "验收")).toHaveLength(1);
		const cards = s.refs.map((ref) => loadCard(s.options.cardsDir, parseCardRef(ref)));
		const baselines = cards.map((card) => {
			const raw = JSON.parse(
				readFileSync(baselineSnapshotPath(s.options.cardsDir, card.card_no, card.frontmatter.attempt), "utf8"),
			) as { tree?: unknown };
			expect(card.frontmatter.status).toBe("delivered");
			expect(raw.tree).toBeTypeOf("string");
			return raw.tree as string;
		});
		expect(new Set(baselines).size).toBe(2);
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow(
			/验证卡覆盖了多个原成果版本|原项目成果已变化/,
		);
		expect(readControl(s.recipe, s.options).节点[0]!.判定).toBeUndefined();
	}, 120_000);

	it.each([
		["execution-context", "执行绑定"],
		["基线", "基线证据"],
	] as const)(
		"%s 绑定摘要被篡改：最终 pass 拒绝",
		async (target, message) => {
			const s = await setup([evidenceSpec(1)]);
			await runDelivered(s);
			const card = loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!));
			const path =
				target === "execution-context"
					? executionContextPath({ cardsDir: s.options.cardsDir, cardNo: card.card_no, attempt: 1 })
					: baselineSnapshotPath(s.options.cardsDir, card.card_no, 1);
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			raw.bindingDigest = `sha256:${"f".repeat(64)}`;
			writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
			await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow(message);
		},
		60_000,
	);

	it("execution-context 缺失：不能降级成静态审核", async () => {
		const s = await setup([evidenceSpec(1)]);
		await runDelivered(s);
		const card = loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!));
		rmSync(executionContextPath({ cardsDir: s.options.cardsDir, cardNo: card.card_no, attempt: 1 }));
		await expect(decideNode(s.recipe, s.options, s.identity, pass("未验证运行；仅按静态证据检查"))).rejects.toThrow(
			"执行绑定不可核对",
		);
	}, 60_000);

	it("attempt 过期：旧卡不能为当前尝试盖章", async () => {
		const s = await setup([evidenceSpec(1)]);
		await runDelivered(s);
		const card = loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!));
		card.frontmatter.attempt = 2;
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("尝试");
	}, 60_000);

	it("普通实施卡真实执行后不能借独立审核路径放行", async () => {
		const s = await setup(
			[
				{
					script: "implement.cjs",
					report: "implementation.md",
					body: `fs.writeFileSync('implement.cjs', 'console.log("implemented")\\n');fs.writeFileSync('implementation.md', 'done\\n');`,
				},
			],
			false,
		);
		const result = await runAutoChain(s.recipe, s.options);
		if (result.steps.filter((step) => step.stage === "验收").length !== 1)
			throw new Error(
				`普通实施卡未进入验收：${JSON.stringify(result)}；卡=${readFileSync(
					loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!)).path,
					"utf8",
				)}`,
			);
		expect(result.steps.filter((step) => step.stage === "验收")).toHaveLength(1);
		expect(loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!)).frontmatter.status).toBe("delivered");
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("须在拆解结束");
	}, 60_000);

	it("取消后的审核卡不能判定放行", async () => {
		const s = await setup([evidenceSpec(1)]);
		const card = loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!));
		changeCardStatus(card, { 操作者: "用户", to: "canceled", 依据: "取消测试", 时间: "2026-10-27 10:01" });
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("全部卡机械交付");
		expect(readControl(s.recipe, s.options).节点[0]!.判定).toBeUndefined();
	}, 60_000);

	it("暂停后的审核节点不能跳过人工门", async () => {
		const s = await setup([evidenceSpec(1)]);
		await runDelivered(s);
		await pauseControl(s.recipe, s.options, "人工恢复门");
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("暂停");
		expect(readControl(s.recipe, s.options).暂停).toBe("人工恢复门");
	}, 60_000);

	it("错误部长身份和旧轮次不能推进审核", async () => {
		const s = await setup([evidenceSpec(1)]);
		await runDelivered(s);
		await expect(decideNode(s.recipe, s.options, { ...s.identity, 部长会话: "forged" }, pass())).rejects.toThrow(
			"部长会话",
		);
		await expect(decideNode(s.recipe, s.options, { ...s.identity, 轮次: 99 }, pass())).rejects.toThrow("旧轮次");
		expect(readControl(s.recipe, s.options).节点[0]!.判定).toBeUndefined();
	}, 60_000);

	it("真实机械失败：卡落失败且不请求部长", async () => {
		const spec = evidenceSpec(1);
		spec.acceptance = "跑: node missing-check.cjs";
		const s = await setup([spec]);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).toContain("机械验收未过");
		expect(loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!)).frontmatter.status).toBe("failed");
	}, 60_000);

	it("not_run 未逐项接受：停在 owner，不召唤部长 pass", async () => {
		const spec = evidenceSpec(1, {
			verification: [{ 条件: "人工审核报告", 结论: "not_run", 证据: "待 owner 逐项裁决" }],
		});
		const s = await setup([spec]);
		const result = await runAutoChain(s.recipe, s.options);
		expect(result.stopReason).toContain("自报未达项");
		expect(result.stopReason).toContain("accepted_deviations");
		expect(loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!)).frontmatter.status).toBe("in_progress");
	}, 60_000);

	it("合法静态审核仍必须显式写明未验证运行", async () => {
		const s = await setup([evidenceSpec(1)]);
		await runDelivered(s);
		const card = loadCard(s.options.cardsDir, parseCardRef(s.refs[0]!));
		rmSync(executionContextPath({ cardsDir: s.options.cardsDir, cardNo: card.card_no, attempt: 1 }), {
			force: true,
		});
		rmSync(baselineSnapshotPath(s.options.cardsDir, card.card_no, 1), { force: true });
		const body = card.body
			.replace(
				/^-\s*(?:执行根|关联摘要|工作树摘要|输入快照|基线 tree|检查前 tree|检查后 tree|检查前 HEAD|检查后 HEAD|检查后内容摘要):.*(?:\r?\n|$)/gm,
				"",
			)
			.replace(/^## 机械验收 .*$/gm, "## 已失效验收");
		writeFileSync(card.path, serializeCard(card.frontmatter, body));
		await expect(decideNode(s.recipe, s.options, s.identity, pass())).rejects.toThrow("未验证运行");
		await expect(
			decideNode(s.recipe, s.options, s.identity, pass("未验证运行；仅按静态证据检查")),
		).resolves.toBeUndefined();
		expect(readControl(s.recipe, s.options).节点[0]!.判定?.结果).toBe("pass");
	}, 60_000);
});
