import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureContentTree, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, loadCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { deliverCard, registerDeliveryTools } from "../../src/pao/cards/delivery.ts";
import { bindExecutionContext, type ExecutionBinding } from "../../src/pao/cards/execution-context.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import * as atomic from "../../src/pao/shared/atomic.ts";

/**
 * 重试累计交卷：历史 attempt 的成果只能在保留基线、真实执行绑定和有效回执
 * 与相邻内容 tree 差逐项对应时进入最终交付；证据不足必须明确拒绝。
 */

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("受控交卷持久化恢复（真实 Git，注入文件写失败）", () => {
	it("引用发布后结果写失败，重试完成同一提交；旧记录仍可重放且校验父提交", async () => {
		const { root, cardsDir, secondBinding } = await positiveFixture();
		const resultPath = join(root, ".pao", "delivery-results", "card-0001-attempt-2.json");
		const ref = "refs/pao-execution/deliveries/card-0001-attempt-2";
		const original = atomic.writeFileAtomic;
		const failure = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, ...args) => {
			if (path === resultPath) throw new Error("模拟结果文件写入失败");
			return original(path, ...args);
		});
		await expect(deliverCard(cardsDir, 1, { executionKey: secondBinding.key })).rejects.toThrow(
			"模拟结果文件写入失败",
		);
		const commit = git(root, ["rev-parse", ref]);
		const pending = JSON.parse(readFileSync(`${resultPath}.pending`, "utf8"));
		expect(pending.deliveryCommit).toBe(commit);
		failure.mockRestore();
		const otherCommit = git(root, ["rev-parse", "HEAD"]);
		git(root, ["update-ref", ref, otherCommit]);
		await expect(deliverCard(cardsDir, 1, { executionKey: secondBinding.key })).rejects.toThrow("引用冲突");
		expect(git(root, ["rev-parse", ref])).toBe(otherCommit);
		git(root, ["update-ref", ref, commit]);
		expect(await deliverCard(cardsDir, 1, { executionKey: secondBinding.key })).toMatchObject({
			交卷: true,
			提交哈希: commit,
		});
		const saved = JSON.parse(readFileSync(resultPath, "utf8"));
		delete saved.baselineCommit; // 升级前已有记录没有该可选字段。
		writeFileSync(resultPath, JSON.stringify(saved));
		expect(await deliverCard(cardsDir, 1, { executionKey: secondBinding.key })).toMatchObject({
			交卷: true,
			提交哈希: commit,
		});
		const forged = git(root, [
			"commit-tree",
			saved.deliveryTree,
			"-p",
			git(root, ["rev-parse", "HEAD"]),
			"-m",
			"same tree wrong parent",
		]);
		saved.deliveryCommit = forged;
		git(root, ["update-ref", ref, forged]);
		writeFileSync(resultPath, JSON.stringify(saved));
		await expect(deliverCard(cardsDir, 1, { executionKey: secondBinding.key })).rejects.toThrow("父提交不自洽");
	}, 60000);

	it("损坏结果保留原始错误，不当作未交付重新提交", async () => {
		const { root, cardsDir, secondBinding } = await positiveFixture();
		await deliverCard(cardsDir, 1, { executionKey: secondBinding.key });
		const resultPath = join(root, ".pao", "delivery-results", "card-0001-attempt-2.json");
		writeFileSync(resultPath, "{broken");
		await expect(deliverCard(cardsDir, 1, { executionKey: secondBinding.key })).rejects.toMatchObject({
			code: "INVALID_CARD",
			details: { cause: expect.any(SyntaxError) },
		});
		expect(readFileSync(resultPath, "utf8")).toBe("{broken");
	}, 60000);
});

function tempRoot(prefix = "pao-delivery-cumulative-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function makeRepo(): string {
	const root = tempRoot();
	writeFileSync(join(root, "已跟踪.txt"), "v1\n");
	git(root, ["init"]);
	git(root, ["add", "-A"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "开工"]);
	return root;
}

function bindingFor(
	card: ParsedCard,
	attempt: number,
	root: string,
	suffix: string,
): Promise<Awaited<ReturnType<typeof bindExecutionContext>>> {
	const head = git(root, ["rev-parse", "HEAD"]);
	return bindExecutionContext(
		{
			key: { cardsDir: join(root, ".pao", "卡"), cardNo: card.card_no, attempt },
			projectRoot: root,
			repositoryRoot: root,
			executionRoot: root,
			worktree: {
				kind: "primary",
				taskRoot: root,
				executionRoot: root,
				commonGitDir: git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
				inputVersion: `${head}:${suffix}`,
				bindingDigest: `sha256:${createHash("sha256").update(`binding-${suffix}`).digest("hex")}`,
			},
			snapshotRef: `pao://brief/card-${card.card_no}-attempt-${attempt}-${suffix}`,
			snapshotDigest: `sha256:${(attempt === 1 ? "a" : "b").repeat(64)}`,
		},
		{ expectedCurrentAttempt: attempt },
	);
}

async function claimWithEvidence(
	root: string,
	cardsDir: string,
	attempt: number,
	suffix: string,
): Promise<{ cardsDir: string; card: ParsedCard; binding: Awaited<ReturnType<typeof bindExecutionContext>> }> {
	let card = loadCard(cardsDir, 1);
	if (attempt === 1) {
		card = changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-23 10:01" });
	} else {
		card = changeCardStatus(card, {
			操作者: "主控",
			to: "unclaimed",
			时间: "2026-10-23 10:03",
		});
		card = changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-23 10:03" });
	}
	expect(card.frontmatter.attempt).toBe(attempt);
	const binding = await bindingFor(card, attempt, root, suffix);
	const baseline = await snapshotClaimBaseline(cardsDir, card.card_no, {
		owner: "主控",
		时间: `2026-10-23 10:0${attempt + 1}`,
		验收: card.frontmatter.acceptance,
		attempt,
		execution: binding,
	});
	expect(baseline.可用, baseline.原因).toBe(true);
	return { cardsDir, card: readCard(card.path), binding };
}

function addReceipt(
	card: ParsedCard,
	attempt: number,
	changes: NonNullable<ParsedCard["receipts"][number]["changes"]>,
	options: {
		taskState?: ParsedCard["receipts"][number]["任务态"];
		verification?: ParsedCard["receipts"][number]["verification"];
	} = {},
): void {
	appendReceipt(readCard(card.path), {
		尝试号: attempt,
		时间: `2026-10-23 10:1${attempt}`,
		结果: attempt === 1 ? "失败" : "成功",
		摘要: attempt === 1 ? "尝试一留下已证实成果" : "尝试二只读复验旧成果",
		...(attempt === 1 ? { 失败类型: "transient" as const } : { 任务态: options.taskState ?? ("completed" as const) }),
		changes,
		...(options.verification !== undefined ? { verification: options.verification } : {}),
	});
}

function markDeliveredWithEvidence(
	root: string,
	cardsDir: string,
	attempt: number,
	binding: ExecutionBinding,
	contentTree: string,
	options: { appendVerdict?: boolean } = {},
): ParsedCard {
	const card = loadCard(cardsDir, 1);
	const delivered =
		card.frontmatter.status === "delivered"
			? card
			: changeCardStatus(card, {
					操作者: "主控",
					to: "delivered",
					时间: `2026-10-23 10:2${attempt}`,
					依据: "测试夹具模拟 owner 批准；验收记录引用真实 execution-context 与内容 tree",
				});
	const head = git(root, ["rev-parse", "HEAD"]);
	const summary = `sha256:${createHash("sha256").update(`${head}:${contentTree}`).digest("hex")}`;
	const sectionLines = [
		`## 机械验收 2026-10-23 10:2${attempt}`,
		"- 结论: 全过自动交付",
		`- 尝试: ${attempt}`,
		`- 执行根: ${root}`,
		`- 仓库根: ${root}`,
		`- 关联摘要: ${binding.bindingDigest}`,
		`- 工作树摘要: ${binding.worktree.bindingDigest}`,
		`- 输入快照: ${binding.snapshotDigest}`,
		`- 基线 tree: ${contentTree}`,
		`- 检查前 tree: ${contentTree}`,
		`- 检查后 tree: ${contentTree}`,
		`- 检查前 HEAD: ${head}`,
		`- 检查后 HEAD: ${head}`,
		`- 检查后内容摘要: ${summary}`,
	];
	if (options.appendVerdict === false) {
		const body = delivered.body.replace(/\n## 机械验收[\s\S]*?(?=\n## |$)/g, "").trimEnd();
		writeFileSync(delivered.path, serializeCard(delivered.frontmatter, body));
		return readCard(delivered.path);
	}
	const withoutPrevious = delivered.body.replace(/\n## 机械验收[\s\S]*?(?=\n## |$)/g, "").trimEnd();
	const body = `${withoutPrevious}\n\n${sectionLines.join("\n")}\n`;
	writeFileSync(delivered.path, serializeCard(delivered.frontmatter, body));
	return readCard(delivered.path);
}

async function positiveFixture(): Promise<{
	root: string;
	cardsDir: string;
	firstBinding: Awaited<ReturnType<typeof bindExecutionContext>>;
	secondBinding: Awaited<ReturnType<typeof bindExecutionContext>>;
	stagedIndex?: string;
}> {
	const root = makeRepo();
	const cardsDir = join(root, ".pao", "卡");
	writeFileSync(join(root, "用户暂存.txt"), "认领前已暂存\n");
	git(root, ["add", "--", "用户暂存.txt"]);
	const stagedIndex = git(root, ["diff", "--cached", "--binary"]);
	mkdirSync(cardsDir, { recursive: true });
	await createCard(cardsDir, {
		目标: "累计交付",
		部门: "测试",
		验收: "存在: 旧成果.txt",
		创建: "2026-10-23 10:00",
	});
	const first = await claimWithEvidence(root, cardsDir, 1, "1");
	writeFileSync(join(root, "旧成果.txt"), "尝试一写出的成果\n");
	const firstEvidence = await captureContentTree(root);
	addReceipt(first.card, 1, [{ 路径: "旧成果.txt", 类型: "created", 说明: "尝试一写入" }]);
	changeCardStatus(readCard(first.card.path), {
		操作者: "主控",
		to: "failed",
		失败类型: "transient",
		依据: "保留成果后重试",
		时间: "2026-10-23 10:02",
	});
	const second = await claimWithEvidence(root, cardsDir, 2, "2");
	addReceipt(second.card, 2, [], {
		verification: [
			{
				条件: "复验上次成果仍然可读",
				结论: "pass",
				证据: `只读复验 ${join(root, "旧成果.txt")}`,
			},
		],
	});
	const unsigned = await captureContentTree(root);
	markDeliveredWithEvidence(root, cardsDir, 2, second.binding, unsigned.tree);
	expect(git(root, ["rev-parse", `${firstEvidence.tree}`])).toBe(firstEvidence.tree);
	return { root, cardsDir, firstBinding: first.binding, secondBinding: second.binding, stagedIndex };
}

async function positiveFixtureWithoutAttemptTwoReceipt(): Promise<{
	root: string;
	cardsDir: string;
	firstBinding: Awaited<ReturnType<typeof bindExecutionContext>>;
	secondBinding: Awaited<ReturnType<typeof bindExecutionContext>>;
}> {
	const root = makeRepo();
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	await createCard(cardsDir, {
		目标: "当前尝试漏报",
		部门: "测试",
		验收: "存在: 旧成果.txt",
		创建: "2026-10-23 10:00",
	});
	const first = await claimWithEvidence(root, cardsDir, 1, "1");
	writeFileSync(join(root, "旧成果.txt"), "尝试一写出的成果\n");
	appendReceipt(readCard(first.card.path), {
		尝试号: 1,
		时间: "2026-10-23 10:11",
		结果: "失败",
		摘要: "尝试一留下已证实成果",
		失败类型: "transient",
		changes: [{ 路径: "旧成果.txt", 类型: "created", 说明: "尝试一写入" }],
	});
	changeCardStatus(readCard(first.card.path), {
		操作者: "主控",
		to: "failed",
		失败类型: "transient",
		依据: "保留成果后重试",
		时间: "2026-10-23 10:02",
	});
	const second = await claimWithEvidence(root, cardsDir, 2, "2");
	addReceipt(second.card, 2, [], {
		verification: [
			{
				条件: "复验上次成果是否仍可读",
				结论: "pass",
				证据: `只读复验 ${join(root, "旧成果.txt")}`,
			},
		],
	});
	return { root, cardsDir, firstBinding: first.binding, secondBinding: second.binding };
}

describe("重试累计交卷：证据归属", () => {
	it("真实历史回执与相邻基线 tree 对应时，第二次只读复验仍提交第一次成果", async () => {
		const fixture = await positiveFixture();
		const result = await deliverCard(fixture.cardsDir, 1, { executionKey: fixture.secondBinding.key });
		expect(result.交卷, JSON.stringify(result)).toBe(true);
		expect(git(fixture.root, ["diff", "--cached", "--binary"])).toBe(fixture.stagedIndex);
		expect(git(fixture.root, ["show", `${result.提交哈希}:旧成果.txt`])).toContain("尝试一写出的成果");
		expect(git(fixture.root, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.提交哈希!])).toBe(
			"旧成果.txt",
		);
	}, 60000);

	it("普通非受管重试累计提交旧成果，同时保持认领前用户暂存", async () => {
		const fixture = await positiveFixture();
		const result = await deliverCard(fixture.cardsDir, 1);
		expect(result.交卷, JSON.stringify(result)).toBe(true);
		expect(git(fixture.root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split(/\r?\n/)).toEqual([
			"旧成果.txt",
		]);
		expect(git(fixture.root, ["show", "HEAD:旧成果.txt"])).toBe("尝试一写出的成果");
		expect(git(fixture.root, ["diff", "--cached", "--binary"])).toBe(fixture.stagedIndex);
	}, 60000);

	it("同根现代卡无 key 且验收后源码变化时拒绝，不推进 HEAD", async () => {
		const fixture = await positiveFixture();
		const before = git(fixture.root, ["rev-parse", "HEAD"]);
		writeFileSync(join(fixture.root, "旧成果.txt"), "验收之后又被修改\n");
		const result = await deliverCard(fixture.cardsDir, 1);
		expect(result.交卷).toBe(false);
		expect(result.原因).toBe("测试后内容变化");
		expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(before);
		expect(git(fixture.root, ["diff", "--cached", "--binary"])).toBe(fixture.stagedIndex);
	}, 60000);

	it("同根现代卡无 key 且验收声明变化时拒绝，不推进 HEAD", async () => {
		const fixture = await positiveFixture();
		const before = git(fixture.root, ["rev-parse", "HEAD"]);
		const card = loadCard(fixture.cardsDir, 1);
		const changed = {
			...card,
			frontmatter: { ...card.frontmatter, acceptance: "存在: 已跟踪.txt" },
		};
		writeFileSync(card.path, serializeCard(changed.frontmatter, changed.body));
		const result = await deliverCard(fixture.cardsDir, 1);
		expect(result.交卷).toBe(false);
		expect(result.原因).toBe("验收声明已变化");
		expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(before);
		expect(git(fixture.root, ["diff", "--cached", "--binary"])).toBe(fixture.stagedIndex);
	}, 60000);

	it("第一次尝试没有历史回执时明确拒绝，不把已存在文件猜成本卡成果", async () => {
		const root = makeRepo();
		const cardsDir = join(root, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		await createCard(cardsDir, { 目标: "无回执", 部门: "测试", 验收: "存在: 旧成果.txt", 创建: "2026-10-23 10:00" });
		const first = await claimWithEvidence(root, cardsDir, 1, "1");
		writeFileSync(join(root, "旧成果.txt"), "来源不明\n");
		changeCardStatus(readCard(first.card.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-23 10:02",
		});
		const second = await claimWithEvidence(root, cardsDir, 2, "2");
		addReceipt(second.card, 2, [], {
			verification: [
				{
					条件: "复验上次成果是否仍可读",
					结论: "pass",
					证据: `只读复验 ${join(root, "旧成果.txt")}`,
				},
			],
		});
		const unsigned = await captureContentTree(root);
		markDeliveredWithEvidence(root, cardsDir, 2, second.binding, unsigned.tree);
		const before = git(root, ["rev-parse", "HEAD"]);
		const result = await deliverCard(cardsDir, 1, { executionKey: second.binding.key });
		expect(result.交卷).toBe(false);
		expect(result.原因).toBe("累计成果归属不足");
		expect(result.消息).toContain("尝试 1 缺少历史回执");
		expect(result.消息).not.toContain("幂等");
		expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
	}, 60000);

	it("历史回执声明与真实 tree 差不符合时拒绝", async () => {
		const root = makeRepo();
		const cardsDir = join(root, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		await createCard(cardsDir, { 目标: "虚报", 部门: "测试", 验收: "存在: 旧成果.txt", 创建: "2026-10-23 10:00" });
		const first = await claimWithEvidence(root, cardsDir, 1, "1");
		writeFileSync(join(root, "旧成果.txt"), "真实写入\n");
		addReceipt(first.card, 1, [{ 路径: "别处.txt", 类型: "created" }]);
		changeCardStatus(readCard(first.card.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-23 10:02",
		});
		const second = await claimWithEvidence(root, cardsDir, 2, "2");
		addReceipt(second.card, 2, [], {
			verification: [
				{
					条件: "复验上次成果是否仍可读",
					结论: "pass",
					证据: `只读复验 ${join(root, "旧成果.txt")}`,
				},
			],
		});
		const current = await captureContentTree(root);
		markDeliveredWithEvidence(root, cardsDir, 2, second.binding, current.tree);
		const result = await deliverCard(cardsDir, 1, { executionKey: second.binding.key });
		expect(result.原因).toBe("累计成果归属不足");
		expect(result.消息).toContain("相邻基线 tree 差不能逐项对应");
	}, 60000);
});

describe("重试累计交卷：保护边界", () => {
	it("认领前同路径已脏时不猜混合编辑归属", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "用户文件.txt"), "认领前用户内容\n");
		const cardsDir = join(root, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		await createCard(cardsDir, {
			目标: "脏文件",
			部门: "测试",
			验收: "存在: 用户文件.txt",
			创建: "2026-10-23 10:00",
		});
		const first = await claimWithEvidence(root, cardsDir, 1, "1");
		writeFileSync(join(root, "用户文件.txt"), "认领前用户内容\nworker 追加\n");
		addReceipt(first.card, 1, [{ 路径: "用户文件.txt", 类型: "modified" }]);
		changeCardStatus(readCard(first.card.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-23 10:02",
		});
		const second = await claimWithEvidence(root, cardsDir, 2, "2");
		addReceipt(second.card, 2, [], {
			verification: [
				{
					条件: "复验上次成果是否仍可读",
					结论: "pass",
					证据: `只读复验 ${join(root, "用户文件.txt")}`,
				},
			],
		});
		const unsigned = await captureContentTree(root);
		markDeliveredWithEvidence(root, cardsDir, 2, second.binding, unsigned.tree);
		const result = await deliverCard(cardsDir, 1, { executionKey: second.binding.key });
		expect(result.原因).toBe("累计成果归属不足");
		expect(result.消息).toContain("认领前已脏");
	}, 60000);

	it("其他卡已声明同一路径时拒绝混入", async () => {
		const fixture = await positiveFixture();
		const other = await createCard(fixture.cardsDir, {
			目标: "其他卡",
			部门: "测试",
			验收: "无",
			创建: "2026-10-23 10:30",
		});
		const claimedOther = changeCardStatus(other, {
			操作者: "主控",
			to: "in_progress",
			时间: "2026-10-23 10:31",
		});
		appendReceipt(claimedOther, {
			尝试号: claimedOther.frontmatter.attempt,
			时间: "2026-10-23 10:32",
			结果: "成功",
			changes: [{ 路径: "旧成果.txt", 类型: "created" }],
		});
		const result = await deliverCard(fixture.cardsDir, 1, { executionKey: fixture.secondBinding.key });
		expect(result.原因).toBe("累计成果归属不足");
		expect(result.消息).toContain("其他卡");
	}, 60000);

	it("共同 Git 仓库下任务根不同的其他卡声明同一路径时仍拒绝混入", async () => {
		const fixture = await positiveFixture();
		const other = await createCard(fixture.cardsDir, {
			目标: "另一任务根",
			部门: "测试",
			验收: "无",
			创建: "2026-10-23 10:30",
		});
		const claimedOther = changeCardStatus(other, {
			操作者: "主控",
			to: "in_progress",
			时间: "2026-10-23 10:31",
		});
		const otherTaskRoot = join(fixture.root, ".pao", "另一任务");
		const head = git(fixture.root, ["rev-parse", "HEAD"]);
		const otherBinding = await bindExecutionContext(
			{
				key: { cardsDir: fixture.cardsDir, cardNo: claimedOther.card_no, attempt: 1 },
				projectRoot: otherTaskRoot,
				repositoryRoot: fixture.root,
				executionRoot: fixture.root,
				worktree: {
					kind: "primary",
					taskRoot: otherTaskRoot,
					executionRoot: fixture.root,
					commonGitDir: git(fixture.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
					inputVersion: `${head}:other-task-root`,
					bindingDigest: `sha256:${createHash("sha256").update("other-task-root").digest("hex")}`,
				},
				snapshotRef: "pao://brief/other-task-root",
				snapshotDigest: `sha256:${"c".repeat(64)}`,
			},
			{ expectedCurrentAttempt: 1 },
		);
		const baseline = await snapshotClaimBaseline(fixture.cardsDir, other.card_no, {
			owner: "主控",
			时间: "2026-10-23 10:31",
			验收: claimedOther.frontmatter.acceptance,
			attempt: 1,
			execution: otherBinding,
		});
		expect(baseline.可用, baseline.原因).toBe(true);
		appendReceipt(readCard(claimedOther.path), {
			尝试号: 1,
			时间: "2026-10-23 10:32",
			结果: "成功",
			changes: [{ 路径: "旧成果.txt", 类型: "created" }],
		});

		const result = await deliverCard(fixture.cardsDir, 1, { executionKey: fixture.secondBinding.key });
		expect(result.原因).toBe("累计成果归属不足");
		expect(result.消息).toContain("其他卡 卡0002 尝试1");
	}, 60000);

	it("第一次尝试的删除与重命名按旧、新路径累计提交", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "将删除.txt"), "删除\n");
		git(root, ["add", "--", "将删除.txt"]);
		git(root, ["commit", "--no-gpg-sign", "-qm", "新增可删除文件"]);
		const cardsDir = join(root, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		await createCard(cardsDir, {
			目标: "删除改名",
			部门: "测试",
			验收: "存在: 新名字.txt",
			创建: "2026-10-23 10:00",
		});
		const first = await claimWithEvidence(root, cardsDir, 1, "1");
		rmSync(join(root, "将删除.txt"));
		git(root, ["mv", "--", "已跟踪.txt", "新名字.txt"]);
		addReceipt(first.card, 1, [
			{ 路径: "将删除.txt", 类型: "deleted" },
			{ 路径: "新名字.txt", 类型: "moved" },
		]);
		changeCardStatus(readCard(first.card.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-23 10:02",
		});
		const second = await claimWithEvidence(root, cardsDir, 2, "2");
		addReceipt(second.card, 2, [], {
			verification: [
				{
					条件: "复验上次成果是否仍可读",
					结论: "pass",
					证据: `只读复验 ${join(root, "新名字.txt")}`,
				},
			],
		});
		const unsigned = await captureContentTree(root);
		markDeliveredWithEvidence(root, cardsDir, 2, second.binding, unsigned.tree);
		const result = await deliverCard(cardsDir, 1, { executionKey: second.binding.key });
		expect(result.交卷, JSON.stringify(result)).toBe(true);
		const paths = git(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", result.提交哈希!]).split(
			/\r?\n/,
		);
		expect(paths).toContain("D\t将删除.txt");
		expect(paths).toContain("R100\t已跟踪.txt\t新名字.txt");
	}, 60000);
});

describe("重试累计交卷：当前尝试独立核验", () => {
	it("重试卡缺少当前真实校验证据时拒绝", async () => {
		const fixture = await positiveFixture();
		markDeliveredWithEvidence(
			fixture.root,
			fixture.cardsDir,
			2,
			fixture.secondBinding,
			(await captureContentTree(fixture.root)).tree,
			{ appendVerdict: false },
		);
		const result = await deliverCard(fixture.cardsDir, 1, { executionKey: fixture.secondBinding.key });
		expect(result.原因).toBe("验收证据缺失");
		expect(result.消息).toContain("找不到当前受管验收记录");
	}, 60000);

	it("历史证据充足但当前回执漏报本次改动时仍拒绝", async () => {
		const fixture = await positiveFixtureWithoutAttemptTwoReceipt();
		writeFileSync(join(fixture.root, "本次漏报.txt"), "本次实际写入\n");
		const beforeEvidence = await captureContentTree(fixture.root);
		writeFileSync(join(fixture.root, "旧成果.txt"), "尝试一写出的成果\n只读复验于第二次尝试\n");
		const unsignedEvidence = await captureContentTree(fixture.root);
		markDeliveredWithEvidence(fixture.root, fixture.cardsDir, 2, fixture.secondBinding, unsignedEvidence.tree);
		expect(git(fixture.root, ["rev-parse", `${beforeEvidence.tree}^{tree}`])).toBe(beforeEvidence.tree);
		const result = await deliverCard(fixture.cardsDir, 1, { executionKey: fixture.secondBinding.key });
		expect(result.原因).toBe("累计成果归属不足");
		expect(result.消息).toContain("尝试 2 的回执声明与相邻基线 tree 差不能逐项对应");
	}, 60000);

	it("真实受管 worktree 的重试链只交付已证明路径，宿主索引与成果保持原样", async () => {
		const source = makeRepo();
		const taskRoot = join(source, ".pao", "任务");
		const cardsDir = join(taskRoot, "卡");
		mkdirSync(cardsDir, { recursive: true });
		writeFileSync(join(source, "用户便签.txt"), "宿主未跟踪文件\n");
		git(source, ["add", "--", "用户便签.txt"]);
		const hostIndex = readFileSync(join(source, ".git", "index"));
		await createCard(cardsDir, {
			目标: "受管累计交付",
			部门: "测试",
			验收: "存在: 旧成果.txt",
			创建: "2026-10-23 10:00",
		});

		const firstRoot = join(tempRoot("pao-managed-first-"), "worktree");
		git(source, ["worktree", "add", "-b", "cumulative-first", firstRoot, "HEAD"]);
		let card = changeCardStatus(loadCard(cardsDir, 1), {
			操作者: "主控",
			to: "in_progress",
			时间: "2026-10-23 10:01",
		});
		const firstBinding = await bindManagedExecution(card, card.frontmatter.attempt, taskRoot, firstRoot, 1);
		await snapshotClaimBaseline(cardsDir, card.card_no, {
			owner: "主控",
			时间: "2026-10-23 10:01",
			验收: card.frontmatter.acceptance,
			attempt: firstBinding.key.attempt,
			execution: firstBinding,
		});
		writeFileSync(join(firstRoot, "旧成果.txt"), "受管尝试一成果\n");
		appendReceipt(readCard(card.path), {
			尝试号: 1,
			时间: "2026-10-23 10:11",
			结果: "失败",
			摘要: "受管尝试一留下成果",
			失败类型: "transient",
			changes: [{ 路径: "旧成果.txt", 类型: "created", 说明: "受管尝试一写入" }],
		});
		card = changeCardStatus(readCard(card.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-23 10:02",
		});
		card = changeCardStatus(card, { 操作者: "主控", to: "unclaimed", 时间: "2026-10-23 10:03" });
		card = changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-23 10:03" });

		const secondRoot = join(tempRoot("pao-managed-second-"), "worktree");
		git(source, ["worktree", "add", "-b", "cumulative-second", secondRoot, "HEAD"]);
		writeFileSync(join(secondRoot, "旧成果.txt"), "受管尝试一成果\n");
		const secondBinding = await bindManagedExecution(card, card.frontmatter.attempt, taskRoot, secondRoot, 2);
		await snapshotClaimBaseline(cardsDir, card.card_no, {
			owner: "主控",
			时间: "2026-10-23 10:03",
			验收: card.frontmatter.acceptance,
			attempt: secondBinding.key.attempt,
			execution: secondBinding,
		});
		appendReceipt(readCard(card.path), {
			尝试号: 2,
			时间: "2026-10-23 10:12",
			结果: "成功",
			摘要: "受管尝试二只读复验",
			任务态: "completed",
			changes: [],
			verification: [
				{
					条件: "复验上次成果仍然可读",
					结论: "pass",
					证据: `只读复验 ${join(secondRoot, "旧成果.txt")}`,
				},
			],
		});
		markDeliveredWithEvidence(secondRoot, cardsDir, 2, secondBinding, (await captureContentTree(secondRoot)).tree);

		git(source, ["worktree", "remove", "--force", firstRoot]);
		expect(() => readFileSync(join(firstRoot, "旧成果.txt"))).toThrow();
		const result = await deliverCard(cardsDir, 1, { executionKey: secondBinding.key });
		expect(result.交卷, JSON.stringify(result)).toBe(true);
		expect(
			git(secondRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.提交哈希!]).split(/\r?\n/),
		).toEqual(["旧成果.txt"]);
		expect(git(secondRoot, ["show", `${result.提交哈希}:旧成果.txt`])).toBe("受管尝试一成果");
		expect(readFileSync(join(source, ".git", "index"))).toEqual(hostIndex);
		expect(git(source, ["status", "--porcelain", "-uall", "--", "已跟踪.txt", "用户便签.txt"])).toBe(
			"A  用户便签.txt",
		);
	}, 60000);

	it("公共交卷工具不传 executionKey 时自动使用当前受管 worktree", async () => {
		const source = makeRepo();
		const taskRoot = join(source, ".pao", "任务");
		const cardsDir = join(taskRoot, "卡");
		mkdirSync(cardsDir, { recursive: true });
		writeFileSync(join(source, "用户便签.txt"), "宿主未跟踪文件\n");
		git(source, ["add", "--", "用户便签.txt"]);
		const hostIndex = readFileSync(join(source, ".git", "index"));
		await createCard(cardsDir, {
			目标: "公共入口受管累计交付",
			部门: "测试",
			验收: "存在: 旧成果.txt",
			创建: "2026-10-23 10:00",
		});

		let card = changeCardStatus(loadCard(cardsDir, 1), {
			操作者: "主控",
			to: "in_progress",
			时间: "2026-10-23 10:01",
		});
		const firstRoot = join(tempRoot("pao-public-first-"), "worktree");
		git(source, ["worktree", "add", "-b", "public-cumulative-first", firstRoot, "HEAD"]);
		const firstBinding = await bindManagedExecution(card, card.frontmatter.attempt, taskRoot, firstRoot, 1);
		await snapshotClaimBaseline(cardsDir, card.card_no, {
			owner: "主控",
			时间: "2026-10-23 10:01",
			验收: card.frontmatter.acceptance,
			attempt: firstBinding.key.attempt,
			execution: firstBinding,
		});
		writeFileSync(join(firstRoot, "旧成果.txt"), "受管尝试一成果\n");
		appendReceipt(readCard(card.path), {
			尝试号: 1,
			时间: "2026-10-23 10:11",
			结果: "失败",
			摘要: "受管尝试一留下成果",
			失败类型: "transient",
			changes: [{ 路径: "旧成果.txt", 类型: "created", 说明: "受管尝试一写入" }],
		});
		card = changeCardStatus(readCard(card.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-23 10:02",
		});
		card = changeCardStatus(card, { 操作者: "主控", to: "unclaimed", 时间: "2026-10-23 10:03" });
		card = changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-23 10:03" });

		const secondRoot = join(tempRoot("pao-public-second-"), "worktree");
		git(source, ["worktree", "add", "-b", "public-cumulative-second", secondRoot, "HEAD"]);
		writeFileSync(join(secondRoot, "旧成果.txt"), "受管尝试一成果\n");
		const secondBinding = await bindManagedExecution(card, card.frontmatter.attempt, taskRoot, secondRoot, 2);
		await snapshotClaimBaseline(cardsDir, card.card_no, {
			owner: "主控",
			时间: "2026-10-23 10:03",
			验收: card.frontmatter.acceptance,
			attempt: secondBinding.key.attempt,
			execution: secondBinding,
		});
		appendReceipt(readCard(card.path), {
			尝试号: 2,
			时间: "2026-10-23 10:12",
			结果: "成功",
			摘要: "受管尝试二只读复验",
			任务态: "completed",
			changes: [],
			verification: [
				{
					条件: "复验上次成果仍然可读",
					结论: "pass",
					证据: `只读复验 ${join(secondRoot, "旧成果.txt")}`,
				},
			],
		});
		markDeliveredWithEvidence(secondRoot, cardsDir, 2, secondBinding, (await captureContentTree(secondRoot)).tree);
		git(source, ["worktree", "remove", "--force", firstRoot]);

		const tools = new Map<
			string,
			{
				execute: (
					id: string,
					params: Record<string, unknown>,
					signal?: AbortSignal,
				) => Promise<{ content: { text: string }[] }>;
			}
		>();
		registerDeliveryTools(
			{
				registerTool: (definition: {
					name: string;
					execute: (
						id: string,
						params: Record<string, unknown>,
						signal?: AbortSignal,
					) => Promise<{ content: { text: string }[] }>;
				}) => tools.set(definition.name, { execute: definition.execute }),
			} as never,
			{ resolveCardsDir: () => cardsDir },
		);
		const output = await tools.get("pao_deliver_card")!.execute("public-entry", { card_ref: 1 });
		const message = output.content[0]!.text;
		expect(message).toContain("已生成受控交付对象");
		expect(message).not.toContain("幂等");
		const commit = git(secondRoot, ["rev-parse", "refs/pao-execution/deliveries/card-0001-attempt-2^{commit}"]);
		expect(message).toContain(commit);
		expect(git(secondRoot, ["show", `${commit}:旧成果.txt`])).toBe("受管尝试一成果");
		expect(readFileSync(join(source, ".git", "index"))).toEqual(hostIndex);
		expect(git(source, ["status", "--porcelain", "-uall", "--", "已跟踪.txt", "用户便签.txt"])).toBe(
			"A  用户便签.txt",
		);
	}, 60000);
});

async function bindManagedExecution(
	card: ParsedCard,
	attempt: number,
	taskRoot: string,
	executionRoot: string,
	suffix: number,
): Promise<ExecutionBinding> {
	const head = git(executionRoot, ["rev-parse", "HEAD"]);
	const treeId = git(executionRoot, ["rev-parse", "HEAD^{tree}"]);
	return bindExecutionContext(
		{
			key: { cardsDir: join(taskRoot, "卡"), cardNo: card.card_no, attempt },
			projectRoot: taskRoot,
			repositoryRoot: executionRoot,
			executionRoot,
			worktree: {
				kind: "managed",
				worktreeId: `cumulative-wt-${suffix}`,
				taskRoot,
				executionRoot,
				commonGitDir: git(executionRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
				branchName: git(executionRoot, ["branch", "--show-current"]),
				inputVersion: `${head}:${suffix}`,
				bindingDigest: `sha256:${createHash("sha256").update(`managed-${suffix}`).digest("hex")}`,
				baseline: {
					sourceRoot: taskRoot,
					sourceHead: head,
					treeId,
					snapshotRepositoryPath: join(tempRoot("pao-managed-snapshot-"), "repo.git"),
					inputVersion: `${head}:${suffix}`,
					capturedAt: "2026-10-23T10:00:00.000Z",
					fileCount: 1,
					byteCount: Buffer.byteLength("v1\n"),
					coverage: "complete",
					includedPaths: ["已跟踪.txt"],
					excludedPaths: [],
					notes: [],
				},
			},
			snapshotRef: join(tempRoot("pao-managed-input-"), "snapshot.json"),
			snapshotDigest: `sha256:${String(suffix).repeat(64)}`,
		},
		{ expectedCurrentAttempt: attempt },
	);
}
