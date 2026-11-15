import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { baselineSnapshotPath, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, loadCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { deliverCard } from "../../src/pao/cards/delivery.ts";
import { bindExecutionContext, executionContextPath } from "../../src/pao/cards/execution-context.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { reviewCardForDelivery, verifyCard } from "../../src/pao/cards/verifier.ts";
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
	it.each([false, true])(
		"仅人工条件也固定内容，逐项接受后交卷仍校验变化（验后修改=%s）",
		async (changedAfterReview) => {
			const root = tempRoot();
			writeFileSync(join(root, "source.txt"), "baseline\n");
			git(root, ["init"]);
			git(root, ["add", "source.txt"]);
			git(root, ["commit", "--no-gpg-sign", "-qm", "base"]);
			const cardsDir = join(root, ".pao", "卡");
			const card = await createCard(
				cardsDir,
				{ 目标: "人工检查成果", 部门: "测试", 验收: "由主控人工检查实现", 创建: "2026-10-27 00:00" },
				{ counterPath: join(root, ".pao", "卡号.txt") },
			);
			const claimed = await claimCardForDispatch({
				cardsDir,
				card_no: String(card.card_no),
				operator: "主控",
				time: "2026-10-27 00:00",
				deferBaseline: true,
			});
			expect(claimed.可派).toBe(true);
			if (!claimed.可派) expect.unreachable();
			await bindCurrentAttempt(claimed.card);
			writeFileSync(join(root, "source.txt"), "implemented\n");
			appendReceipt(claimed.card, {
				尝试号: 1,
				时间: "2026-10-27 00:01",
				结果: "success",
				摘要: "模拟工人完成，等待人工检查",
				产物路径: ["source.txt"],
				verification: [{ 条件: "人工检查实现", 结论: "not_run" }],
			});
			const checked = await verifyCard(cardsDir, card.card_no, { operator: "主控" });
			expect(checked.result.结论).toBe("全过停人工审");
			expect(checked.result.条目结果).toEqual([]);
			expect(checked.result.代码内容?.检查前Tree).toMatch(/^[a-f0-9]{40}$/);
			expect(checked.result.代码内容?.检查后Tree).toBe(checked.result.代码内容?.检查前Tree);
			expect(loadCard(cardsDir, card.card_no).frontmatter.status).toBe("in_progress");
			const reviewed = await reviewCardForDelivery(cardsDir, card.card_no, { operator: "主控" }, "人工检查确认", [
				{ attempt: 1, verification_index: 0, condition: "人工检查实现", basis: "已人工核对当前实现" },
			]);
			changeCardStatus(reviewed, { 操作者: "主控", to: "delivered", 时间: "2026-10-27 00:02" });
			if (changedAfterReview) writeFileSync(join(root, "source.txt"), "changed after review\n");
			const result = await deliverCard(cardsDir, card.card_no);
			expect(result.交卷).toBe(!changedAfterReview);
			if (changedAfterReview) expect(result.原因).toBe("测试后内容变化");
		},
		60000,
	);
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

		const rejected = await verifyCard(cardsDir, secondCard.card_no, { operator: "主控" }).catch(
			(error: unknown) => error,
		);
		expect(rejected).toMatchObject({
			name: "PaoCardError",
			code: "INVALID_CARD",
			details: {
				卡号: secondCard.card_no,
				尝试: secondCard.frontmatter.attempt,
			},
		});
		if (!(rejected instanceof Error)) throw new Error("公共 verifyCard 应以 Error 拒绝");
		const reason = (rejected as Error & { details?: { 原因?: unknown } }).details?.原因;
		expect(typeof reason).toBe("string");
		expect(reason).not.toBe("");
		expect(rejected.message).toContain(String(reason));
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
