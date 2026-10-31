import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { bindExecutionContext, executionContextPath } from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import type { ProcessEntry } from "../../src/pao/worker/registry.ts";
import {
	addNodeCards,
	bindMinister,
	buildDecisionPackage,
	type NodeIdentity,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const configuredParent = process.env.PAO_HOME?.trim();
if (!configuredParent || !isAbsolute(configuredParent)) throw new Error("判定包测试须显式设置绝对路径的隔离 PAO_HOME");
const isolatedParent = resolve(configuredParent);
mkdirSync(isolatedParent, { recursive: true });
const FIXTURE_ROOT = mkdtempSync(join(isolatedParent, "pao-decision-facts-"));
const cases: string[] = [];

function isWithin(parent: string, child: string): boolean {
	const value = relative(parent, child);
	return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

afterEach(() => {
	for (const dir of cases.splice(0)) {
		if (!isWithin(FIXTURE_ROOT, resolve(dir)) || resolve(dir) === FIXTURE_ROOT)
			throw new Error(`拒绝清理本测试目录外的路径：${dir}`);
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

afterAll(() => {
	if (!isWithin(isolatedParent, FIXTURE_ROOT) || FIXTURE_ROOT === isolatedParent)
		throw new Error(`拒绝清理隔离父目录外的路径：${FIXTURE_ROOT}`);
	rmSync(FIXTURE_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.quotepath=off", "-c", "user.email=test@example.invalid", "-c", "user.name=test", ...args],
		{
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
}

function caseRoot(): string {
	mkdirSync(FIXTURE_ROOT, { recursive: true });
	const root = mkdtempSync(join(FIXTURE_ROOT, "case-"));
	cases.push(root);
	return root;
}

function writeEvidence(input: { path: string; cardPath: string; cardNo: number; runId: string }): void {
	const number = String(input.cardNo).padStart(4, "0");
	const lines = [
		JSON.stringify({
			type: "pao_worker_live",
			卡号: number,
			卡路径: input.cardPath,
			尝试: 1,
			执行标识: input.runId,
			pid: 1234,
			开始时间: "2026-10-30T00:00:00.000Z",
		}),
		JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "exit-three",
			toolName: "powershell",
			args: { command: "exit 3" },
		}),
		JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "exit-three",
			toolName: "powershell",
			result: {
				content: [],
				structuredContent: { exit_code: 3 },
			},
			isError: true,
		}),
		JSON.stringify({
			type: "pao_worker_evidence",
			卡号: number,
			卡路径: input.cardPath,
			尝试: 1,
			执行标识: input.runId,
			exitCode: 0,
			stderrTail: "",
		}),
	];
	mkdirSync(join(input.path, ".."), { recursive: true });
	writeFileSync(input.path, `${lines.join("\n")}\n`, "utf8");
}

interface Fixture {
	root: string;
	taskRoot: string;
	cardsDir: string;
	cardPath: string;
	cardNo: number;
	evidencePath: string;
	bindingPath: string;
	identity: NodeIdentity;
	recipe: ReturnType<typeof parseRecipe>;
	options: {
		cardsDir: string;
		workspaceDir: string;
		ownerSessionId: string;
	};
}

async function fixture(options: { receipt?: boolean; modelChanges?: boolean } = {}): Promise<Fixture> {
	const root = caseRoot();
	const taskRoot = join(root, "task");
	mkdirSync(taskRoot, { recursive: true });
	writeFileSync(join(taskRoot, "source.txt"), "baseline\n", "utf8");
	writeFileSync(join(taskRoot, "modified.txt"), "v1\n", "utf8");
	writeFileSync(join(taskRoot, "deleted.txt"), "remove me\n", "utf8");
	git(taskRoot, ["init", "--quiet"]);
	git(taskRoot, ["add", "source.txt", "modified.txt", "deleted.txt"]);
	git(taskRoot, ["commit", "--no-gpg-sign", "-qm", "baseline"]);

	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "判定事实",
			参数: [],
			节点: [{ 名字: "开发", 部门: "测试", 目标: "验证事实", 验收: "真实 Git", 工人数量: 1 }],
		})}---\n`,
		join(taskRoot, ".pao", "判定事实.md"),
	);
	const driverOptions = {
		cardsDir: join(taskRoot, ".pao", "卡"),
		workspaceDir: join(taskRoot, ".pao"),
		ownerSessionId: "owner",
	};
	await startControl(recipe, {}, driverOptions);
	await bindMinister(recipe, driverOptions, "开发", "minister-development");
	const flow = readControl(recipe, driverOptions);
	const node = flow.节点.find((candidate) => candidate.名字 === "开发")!;
	const identity: NodeIdentity = {
		实例: flow.实例,
		节点: node.名字,
		轮次: node.轮次,
		部长会话: node.部长会话!,
	};
	const [cardRef] = await addNodeCards(recipe, driverOptions, identity, [
		{ goal: "读取判定事实", acceptance: "真实 Git" },
	]);
	changeCardStatus(loadCard(driverOptions.cardsDir, parseCardRef(cardRef)), {
		操作者: "owner",
		to: "in_progress",
		时间: "2026-10-30 09:00",
	});
	const card = loadCard(driverOptions.cardsDir, parseCardRef(cardRef));
	const head = git(taskRoot, ["rev-parse", "HEAD"]);
	const binding = await bindExecutionContext(
		{
			key: {
				cardsDir: driverOptions.cardsDir,
				cardNo: card.card_no,
				attempt: card.frontmatter.attempt,
			},
			projectRoot: taskRoot,
			repositoryRoot: taskRoot,
			executionRoot: taskRoot,
			worktree: {
				kind: "primary",
				taskRoot,
				executionRoot: taskRoot,
				commonGitDir: git(taskRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
				inputVersion: head,
				bindingDigest: `sha256:${createHash("sha256").update("decision-facts").digest("hex")}`,
			},
			snapshotRef: "pao://brief/i3-decision-facts",
			snapshotDigest: `sha256:${"d".repeat(64)}`,
		},
		{ expectedCurrentAttempt: card.frontmatter.attempt },
	);
	const snapshot = await snapshotClaimBaseline(driverOptions.cardsDir, card.card_no, {
		owner: "owner",
		时间: "2026-10-30 09:01",
		attempt: card.frontmatter.attempt,
		execution: binding,
	});
	if (!snapshot.可用) throw new Error(`测试基线创建失败：${snapshot.原因 ?? "未给出原因"}`);

	const evidencePath = join(taskRoot, ".pao", "证据", "run.live.jsonl");
	writeEvidence({
		path: evidencePath,
		cardPath: card.path,
		cardNo: card.card_no,
		runId: "run-current",
	});
	if (options.receipt !== false) {
		appendReceipt(loadCard(driverOptions.cardsDir, parseCardRef(cardRef)), {
			尝试号: 1,
			时间: "2026-10-30 09:02",
			结果: "success",
			摘要: "证据已交",
			证据: [evidencePath],
			用量: { run_id: "run-current" },
			changes: options.modelChanges ? [{ 路径: "ghost.txt", 类型: "created", 说明: "模型伪报" }] : undefined,
			verification: options.modelChanges ? [{ 条件: "模型声称已通过", 结论: "pass", 证据: "模型文本" }] : undefined,
		});
	}

	return {
		root,
		taskRoot,
		cardsDir: driverOptions.cardsDir,
		cardPath: card.path,
		cardNo: card.card_no,
		evidencePath,
		bindingPath: executionContextPath(binding.key),
		identity,
		recipe,
		options: driverOptions,
	};
}

function processEntries(f: Fixture, runIds: readonly string[]): ProcessEntry[] {
	return runIds.map((runId, index) => ({
		pid: 1000 + index,
		card_no: `卡${String(f.cardNo).padStart(4, "0")}`,
		command: "test-worker",
		登记时间: "2026-10-30T01:00:00.000Z",
		running: false,
		dept: "测试",
		dispatch_reason: "判定包事实测试",
		card_path: f.cardPath,
		attempt: 1,
		run_id: runId,
	}));
}

function section(markdown: string, start: string, end: string): string {
	const startAt = markdown.indexOf(start);
	const endAt = markdown.indexOf(end, startAt + start.length);
	if (startAt < 0 || endAt < 0) throw new Error(`判定包缺少区段：${start}`);
	return markdown.slice(startAt, endAt);
}

const CARD_BODY_HEADING = "#### 当前卡正文（完整原文，仅展示一次；回执 changes/verification 仅模型宣称）";

describe("判定包接入 worker 程序事实", () => {
	it("当前真实 Git 改动与退出码 3 进入程序事实，模型伪报只进入声明区", async () => {
		const f = await fixture({ modelChanges: true });
		writeFileSync(join(f.taskRoot, "modified.txt"), "v2 worker\n", "utf8");
		unlinkSync(join(f.taskRoot, "deleted.txt"));
		mkdirSync(join(f.taskRoot, "created"), { recursive: true });
		writeFileSync(join(f.taskRoot, "created", "new.txt"), "worker new\n", "utf8");
		const storedCard = readFileSync(f.cardPath, "utf8");
		expect(storedCard).toContain("ghost.txt");
		expect(storedCard).toContain("模型声称已通过");

		const packagePath = await buildDecisionPackage(
			f.recipe,
			f.options,
			f.identity,
			processEntries(f, ["run-current"]),
		);
		const contents = readFileSync(packagePath, "utf8");
		const program = section(contents, "#### 程序采集事实", CARD_BODY_HEADING);
		const cardBody = contents.slice(contents.indexOf(CARD_BODY_HEADING));

		expect(program).toContain("工具：powershell");
		expect(program).toContain("toolCallId：exit-three");
		expect(program).toContain("结构化 exit_code：3");
		expect(program).toContain('命令："exit 3"');
		expect(program).toContain('created：["created/new.txt"]');
		expect(program).toContain('modified：["modified.txt"]');
		expect(program).toContain('deleted：["deleted.txt"]');
		expect(program).not.toContain("ghost.txt");
		expect(program).not.toContain("模型声称已通过");
		expect(cardBody).toContain("以下回执中的 changes/verification 仅为模型宣称，不是程序事实");
		expect(cardBody).toContain("ghost.txt");
		expect(cardBody).toContain("模型声称已通过");
		expect(contents.match(/ghost\.txt/g) ?? []).toHaveLength(1);
		expect(contents.match(/模型声称已通过/g) ?? []).toHaveLength(1);
	});

	it("旧 attempt 的证据不回灌到当前卡", async () => {
		const f = await fixture();
		let card = loadCard(f.cardsDir, f.cardNo);
		card = changeCardStatus(card, {
			操作者: "owner",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-30 10:00",
		});
		card = changeCardStatus(card, { 操作者: "owner", to: "unclaimed", 时间: "2026-10-30 10:01" });
		card = changeCardStatus(card, { 操作者: "owner", to: "in_progress", 时间: "2026-10-30 10:02" });
		expect(card.frontmatter.attempt).toBe(2);
		appendReceipt(card, {
			尝试号: 2,
			时间: "2026-10-30 10:03",
			结果: "success",
			证据: [f.evidencePath],
			用量: { run_id: "run-current" },
		});
		const currentEntries = processEntries(f, ["run-current"]).map((entry) => ({ ...entry, attempt: 2 }));

		const contents = readFileSync(
			await buildDecisionPackage(f.recipe, f.options, f.identity, currentEntries),
			"utf8",
		);
		const program = section(contents, "#### 程序采集事实", CARD_BODY_HEADING);
		expect(program).toContain("命令事实：不可用");
		expect(program).toContain("证据尝试号身份不匹配");
		expect(program).toContain("文件改动事实：不可用");
		expect(program).not.toContain('命令："exit 3"');
		expect(program).not.toContain("created：");
	});

	it("错误执行绑定显示不可用，不读取或泄露错误根内容", async () => {
		const f = await fixture();
		writeFileSync(join(f.taskRoot, "modified.txt"), "v2 worker\n", "utf8");
		const wrongRoot = join(f.root, "wrong-root");
		mkdirSync(wrongRoot, { recursive: true });
		writeFileSync(join(wrongRoot, "wrong-root-secret.txt"), "WRONG_ROOT_SECRET\n", "utf8");
		const binding = JSON.parse(readFileSync(f.bindingPath, "utf8")) as {
			executionRoot: string;
			worktree: { executionRoot: string };
		};
		binding.executionRoot = wrongRoot;
		binding.worktree.executionRoot = wrongRoot;
		writeFileSync(f.bindingPath, `${JSON.stringify(binding)}\n`, "utf8");

		const contents = readFileSync(
			await buildDecisionPackage(f.recipe, f.options, f.identity, processEntries(f, ["run-current"])),
			"utf8",
		);
		const program = section(contents, "#### 程序采集事实", CARD_BODY_HEADING);
		expect(program).toContain("当前 attempt 执行绑定不可用");
		expect(program).toContain("文件改动事实：不可用");
		expect(program).not.toContain("WRONG_ROOT_SECRET");
		expect(program).not.toContain("wrong-root-secret.txt");
	});

	it("历史文本回执缺少证据路径时保持未知", async () => {
		const f = await fixture({ receipt: false });
		appendReceipt(loadCard(f.cardsDir, f.cardNo), {
			尝试号: 1,
			时间: "2026-10-30 11:00",
			结果: "success",
			摘要: "旧文本回执",
			changes: [{ 路径: "text-only.txt", 类型: "created", 说明: "没有证据路径" }],
		});

		const contents = readFileSync(await buildDecisionPackage(f.recipe, f.options, f.identity, []), "utf8");
		const program = section(contents, "#### 程序采集事实", CARD_BODY_HEADING);
		expect(program).toContain("缺当前 attempt 回执或 receipt.evidence_path");
		expect(program).toContain("命令事实：未知");
		expect(program).toContain("文件改动事实：未知");
		expect(program).not.toContain("created：");
		expect(program).not.toContain("modified：");
		expect(program).not.toContain("deleted：");
	});

	it("旧任意命令日志不进入程序事实", async () => {
		const f = await fixture({ receipt: false });
		const legacyLog = join(f.taskRoot, ".pao", "证据", "legacy-command.log");
		writeFileSync(legacyLog, "exit 0\nclaimed success\n", "utf8");
		appendReceipt(loadCard(f.cardsDir, f.cardNo), {
			尝试号: 1,
			时间: "2026-10-30 11:30",
			结果: "success",
			摘要: "旧命令日志",
			证据: [legacyLog],
			用量: { run_id: "run-current" },
		});

		const contents = readFileSync(
			await buildDecisionPackage(f.recipe, f.options, f.identity, processEntries(f, ["run-current"])),
			"utf8",
		);
		const program = section(contents, "#### 程序采集事实", CARD_BODY_HEADING);
		expect(program).toContain("命令事实：不可用");
		expect(program).toContain("不是有效 JSON");
		expect(program).not.toContain('命令："exit 0"');
		expect(program).not.toContain("结构化 exit_code");
		expect(program).not.toContain("claimed success");
	});

	it("派单登记存在多个 run_id 时拒绝猜证据归属", async () => {
		const f = await fixture();
		const contents = readFileSync(
			await buildDecisionPackage(f.recipe, f.options, f.identity, processEntries(f, ["run-current", "run-old"])),
			"utf8",
		);
		const program = section(contents, "#### 程序采集事实", CARD_BODY_HEADING);
		expect(program).toContain("多个不同 run_id");
		expect(program).toContain("拒绝猜测证据归属");
		expect(program).toContain("命令事实：未知");
		expect(program).toContain("文件改动事实：不可用");
		expect(program).not.toContain('命令："exit 3"');
	});
});
