import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { baselineSnapshotPath, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, loadCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { bindExecutionContext, executionContextPath } from "../../src/pao/cards/execution-context.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { verifyCard } from "../../src/pao/cards/verifier.ts";
import { claimCardForDispatch } from "../../src/pao/worker/dispatch-core.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pao-verifier-attempt-"));
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

async function retryFixture() {
	const root = tempRoot();
	writeFileSync(join(root, "已跟踪.txt"), "v1\n");
	git(root, ["init"]);
	git(root, ["add", "-A"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "基线"]);
	const cardsDir = join(root, ".pao", "任务", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const card = await createCard(
		cardsDir,
		{
			目标: "第二次尝试复验旧成果",
			部门: "测试",
			验收: "存在: 已跟踪.txt",
			创建: "2026-10-23 01:00",
		},
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
	const first = await claimCardForDispatch({
		cardsDir,
		card_no: String(card.card_no),
		operator: "主控",
		time: "2026-10-23 01:01",
	});
	expect(first.可派).toBe(true);
	if (!first.可派) expect.unreachable();
	writeFileSync(join(root, "旧成果.txt"), "第一次尝试已经写好的成果\n");
	changeCardStatus(first.card, {
		操作者: "主控",
		to: "failed",
		失败类型: "transient",
		时间: "2026-10-23 01:02",
	});
	const second = await claimCardForDispatch({
		cardsDir,
		card_no: String(card.card_no),
		operator: "主控",
		time: "2026-10-23 01:03",
		deferBaseline: true,
	});
	expect(second.可派).toBe(true);
	if (!second.可派) expect.unreachable();
	expect(second.尝试号).toBe(2);
	return { root, cardsDir, secondCard: second.card };
}

async function bindCurrentAttempt(card: ParsedCard): Promise<void> {
	const cardsDir = join(card.path, "..");
	const repositoryRoot = git(cardsDir, ["rev-parse", "--show-toplevel"]);
	const commonGitDir = git(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
	const worktreeBindingDigest = `sha256:${"c".repeat(64)}`;
	const execution = await bindExecutionContext(
		{
			key: {
				cardsDir: cardsDir,
				cardNo: card.card_no,
				attempt: card.frontmatter.attempt,
			},
			projectRoot: repositoryRoot,
			repositoryRoot,
			executionRoot: repositoryRoot,
			worktree: {
				kind: "primary",
				taskRoot: repositoryRoot,
				executionRoot: repositoryRoot,
				commonGitDir,
				inputVersion: head,
				bindingDigest: worktreeBindingDigest,
			},
			snapshotRef: "pao://brief/verifier-attempt-2",
			snapshotDigest: `sha256:${"a".repeat(64)}`,
		},
		{ expectedCurrentAttempt: card.frontmatter.attempt },
	);
	const baseline = await snapshotClaimBaseline(cardsDir, card.card_no, {
		owner: "主控",
		时间: "2026-10-23 01:04",
		验收: card.frontmatter.acceptance,
		attempt: card.frontmatter.attempt,
		execution,
	});
	expect(baseline.可用, baseline.原因).toBe(true);
}

describe("公共 verifyCard 自动消费当前尝试的新式基线", () => {
	it.each(["文件缺失", "JSON 损坏"])("当前执行上下文存在但基线%s时，公共入口拒绝降级旧卡自动交付", async (failure) => {
		const { cardsDir, secondCard } = await retryFixture();
		await bindCurrentAttempt(secondCard);
		const baselinePath = baselineSnapshotPath(cardsDir, secondCard.card_no, secondCard.frontmatter.attempt);
		expect(
			existsSync(
				executionContextPath({
					cardsDir,
					cardNo: secondCard.card_no,
					attempt: secondCard.frontmatter.attempt,
				}),
			),
		).toBe(true);
		if (failure === "文件缺失") unlinkSync(baselinePath);
		else writeFileSync(baselinePath, readFileSync(baselinePath, "utf8").slice(0, 20));
		expect(existsSync(baselinePath)).toBe(failure === "JSON 损坏");

		await expect(verifyCard(cardsDir, secondCard.card_no, { operator: "主控" })).rejects.toMatchObject({
			name: "PaoCardError",
			code: "INVALID_CARD",
		});
		expect(loadCard(cardsDir, secondCard.card_no).frontmatter.status).toBe("in_progress");
	});

	it("无 executionKey 时仍读取第二次尝试的真实执行上下文，并拦截验收声明变化", async () => {
		const { cardsDir, secondCard } = await retryFixture();
		await bindCurrentAttempt(secondCard);
		expect(existsSync(baselineSnapshotPath(cardsDir, secondCard.card_no, 2))).toBe(true);

		const changed = readCard(secondCard.path);
		changed.frontmatter.acceptance = "存在: 旧成果.txt";
		writeFileSync(changed.path, serializeCard(changed.frontmatter, changed.body));

		const checked = await verifyCard(cardsDir, secondCard.card_no, { operator: "主控" });
		expect(checked.result.结论).toBe("全过自动交付");
		expect(checked.result.自动交付).toBeUndefined();
		expect(checked.result.交付说明).toContain("验收声明已变化");
		expect(loadCard(cardsDir, secondCard.card_no).frontmatter.status).toBe("in_progress");
	});

	it("无 executionKey 时仍消费当前回执的 changes 保护，空 changes 不回落到 artifact_path", async () => {
		const { root, cardsDir, secondCard } = await retryFixture();
		await bindCurrentAttempt(secondCard);
		writeFileSync(join(root, "第二次成果.txt"), "第二次尝试写入\n");
		appendReceipt(secondCard, {
			尝试号: secondCard.frontmatter.attempt,
			时间: "2026-10-23 01:04",
			结果: "完成",
			摘要: "旧式回执",
			changes: [{ 路径: "已跟踪.txt", 类型: "modified" }],
			verification: [],
		});
		appendReceipt(secondCard, {
			尝试号: secondCard.frontmatter.attempt,
			时间: "2026-10-23 01:05",
			结果: "完成",
			摘要: "回执声明为空",
			verification: [],
		});
		const cardWithReceipt = readCard(secondCard.path);
		cardWithReceipt.body = cardWithReceipt.body.replace(
			"- summary: 回执声明为空",
			'- summary: 回执声明为空\n- artifact_path: ["第二次成果.txt"]\n- changes: []',
		);
		writeFileSync(cardWithReceipt.path, serializeCard(cardWithReceipt.frontmatter, cardWithReceipt.body));

		const checked = await verifyCard(cardsDir, secondCard.card_no, { operator: "主控" });
		expect(checked.result.自动交付).toBeUndefined();
		expect(checked.result.交付说明).toContain("越界核查 越界");
		expect(checked.result.越界核查?.越界).toContain("?? 第二次成果.txt");
		expect(loadCard(cardsDir, secondCard.card_no).frontmatter.status).toBe("in_progress");
	});

	it("旧式无尝试基线卡没有新式证据，继续按真实旧契约自动交付", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "旧卡产物.txt"), "旧卡成果\n");
		git(root, ["init"]);
		git(root, ["add", "-A"]);
		git(root, ["commit", "--no-gpg-sign", "-qm", "旧卡基线"]);
		const cardsDir = join(root, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		const card = await createCard(cardsDir, {
			目标: "旧式手工卡",
			部门: "测试",
			验收: "存在: 旧卡产物.txt",
			创建: "2026-10-23 02:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-23 02:01" });
		appendReceipt(card, {
			尝试号: card.frontmatter.attempt,
			时间: "2026-10-23 02:02",
			结果: "完成",
			摘要: "旧链路完成",
			changes: [{ 路径: "旧卡产物.txt", 类型: "created" }],
		});
		appendReceipt(card, {
			尝试号: card.frontmatter.attempt,
			时间: "2026-10-23 02:03",
			结果: "完成",
			摘要: "旧链路验收回执",
			changes: [{ 路径: "旧卡产物.txt", 类型: "created" }],
			verification: [],
		});

		const checked = await verifyCard(cardsDir, card.card_no, { operator: "部长A" });
		expect(checked.result.自动交付).toBe(true);
		expect(checked.card.frontmatter.status).toBe("delivered");
	});
});
