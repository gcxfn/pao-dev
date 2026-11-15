import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { type AppendReceiptInput, appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { verifyCard } from "../../src/pao/cards/verifier.ts";

/**
 * S5 包1：机械验收消费 worker 自报（verification/changes/任务态）——
 * 自报 fail/not_run 阻止自动交付并留 owner 逐项复核；pass 不免检不授予；
 * checkpoint/blocked 不冒充完成；实际 git 改动与 changes 比对，越界/虚报不自动交付；
 * 认领时验收声明哈希与当前不一致 → 原审失效须重审，不自动交付。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-s5p1-verify-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

function makeRepo(): string {
	const repo = tempDir();
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	return repo;
}

/** 认领卡＋验收哈希快照；worker 改动由用例自落。 */
async function makeClaimedCard(
	repo: string,
	acceptance: string,
): Promise<{ cardDir: string; cardNo: number; card: ParsedCard }> {
	const cardDir = join(repo, ".pao", "卡");
	mkdirSync(cardDir, { recursive: true });
	const card = await createCard(cardDir, {
		目标: "自报消费卡",
		部门: "核心机制",
		验收: acceptance,
		创建: "2026-10-07 09:00",
	});
	const running = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-07 09:01" });
	await snapshotClaimBaseline(cardDir, card.card_no, {
		owner: "部长A",
		时间: "2026-10-07 09:01",
		验收: acceptance,
	});
	return { cardDir, cardNo: card.card_no, card: running };
}

/** 当前尝试落一条自报回执（回答型：无产物路径声明）。 */
function attachReceipt(
	card: ParsedCard,
	fields: Partial<Pick<AppendReceiptInput, "任务态" | "verification" | "changes" | "产物路径">>,
): void {
	appendReceipt(readCard(card.path), {
		尝试号: readCard(card.path).frontmatter.attempt,
		时间: "2026-10-07 09:30",
		结果: "成功",
		摘要: "自报",
		产物路径: fields.产物路径 ?? [],
		任务态: fields.任务态,
		verification: fields.verification,
		changes: fields.changes,
	});
}

describe("机械验收消费自报 verification：未达项不能自动交付", () => {
	it("自报 fail → 机械条目全过仍停 owner 逐项复核，不自动交付", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		attachReceipt(card, {
			任务态: "completed_with_deviations",
			verification: [{ 条件: "覆盖率达到 80%", 结论: "fail", 证据: "coverage 报告 61%" }],
		});
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.结论).toBe("全过停人工审");
		expect(result.自报未达项).toEqual([
			{ 尝试: 1, verification_index: 0, 条件: "覆盖率达到 80%", 自报结论: "fail", 证据: "coverage 报告 61%" },
		]);
		expect(result.自动交付).toBeUndefined();
		expect(readCard(card.path).frontmatter.status).toBe("in_progress");
	});

	it("自报 not_run 同样停人工复核（不完整验收不算自动通过）", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		attachReceipt(card, {
			任务态: "completed",
			verification: [{ 条件: "手工回归清单", 结论: "not_run" }],
		});
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.结论).toBe("全过停人工审");
		expect(result.自报未达项?.[0]).toMatchObject({ 条件: "手工回归清单", 自报结论: "not_run" });
		expect(result.自动交付).toBeUndefined();
	});

	it("自报全 pass 不能免检：机械条目缺文件照判未过（pass 不授予能力）", async () => {
		const repo = makeRepo();
		// 不写 产物.txt：机械条目必败，自报 pass 不得豁免
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		attachReceipt(card, {
			任务态: "completed",
			verification: [{ 条件: "产物已写", 结论: "pass", 证据: "我写过了" }],
		});
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.结论).toBe("未过");
		expect(result.条目结果.some((r) => r.类型 === "存在" && r.结果 === "未过")).toBe(true);
	});

	it("无自报回执的旧链路行为不变：机械全过仍自动交付（钉子）", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		void card;
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.结论).toBe("全过自动交付");
		expect(result.自动交付).toBe(true);
	});
});

describe("checkpoint/blocked 不冒充完成", () => {
	it("最新回执为 checkpoint → 机械全过不自动交付", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		attachReceipt(card, { 任务态: "checkpoint" });
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.结论).toBe("全过自动交付");
		expect(result.自动交付).toBeUndefined();
		expect(result.交付说明 ?? "").toContain("checkpoint");
		expect(readCard(card.path).frontmatter.status).toBe("in_progress");
	});

	it("最新回执为 blocked → 不自动交付", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		attachReceipt(card, { 任务态: "blocked" });
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.自动交付).toBeUndefined();
		expect(result.交付说明 ?? "").toContain("blocked");
	});

	it("checkpoint 后补 completed → 以最新终结自报为准，可自动交付", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		attachReceipt(card, { 任务态: "checkpoint" });
		attachReceipt(card, { 任务态: "completed" });
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.自动交付).toBe(true);
	});
});

describe("实际 git 改动与 changes 声明比对：越界/虚报不自动交付", () => {
	it("改动与声明相符 → 自动交付", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		// worker 改动必须发生在认领快照之后，才算 worker 的账（快照前写＝用户既有改动）
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		attachReceipt(card, {
			任务态: "completed",
			changes: [{ 路径: "产物.txt", 类型: "created", 说明: "新产物" }],
		});
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.自动交付).toBe(true);
		expect(result.越界核查?.结论).toBe("干净");
	});

	it("git 真值有未声明的改动（越界）→ 不自动交付", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		writeFileSync(join(repo, "偷偷改.txt"), "做了没说\n");
		attachReceipt(card, {
			任务态: "completed",
			changes: [{ 路径: "产物.txt", 类型: "created", 说明: "新产物" }],
		});
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.自动交付).toBeUndefined();
		expect(result.越界核查?.结论).toBe("越界");
		expect(result.交付说明 ?? "").toContain("越界");
		expect(readCard(card.path).frontmatter.status).toBe("in_progress");
	});

	it("声明了不存在的改动（虚报）→ 不自动交付", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		attachReceipt(card, {
			任务态: "completed",
			changes: [
				{ 路径: "产物.txt", 类型: "created", 说明: "真产物" },
				{ 路径: "幻觉文件.txt", 类型: "created", 说明: "说了没做" },
			],
		});
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.自动交付).toBeUndefined();
		expect(result.越界核查?.结论).toBe("虚报");
	});
});

describe("验收声明哈希：内容一变原审失效", () => {
	it("认领后改验收字段 → 不自动交付，提示须重审", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		// worker/外部把验收改得更容易（自我放行），认领时哈希对不上
		const tampered = readCard(card.path);
		writeFileSync(
			tampered.path,
			serializeCard({ ...tampered.frontmatter, acceptance: "存在: 已跟踪.txt" }, tampered.body),
		);
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.自动交付).toBeUndefined();
		expect(result.交付说明 ?? "").toContain("重审");
		expect(readCard(tampered.path).frontmatter.status).toBe("in_progress");
	});

	it("验收未被改（哈希一致）→ 自动交付照常", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		const { cardDir, cardNo, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		void card;
		const { result } = await verifyCard(cardDir, cardNo, { operator: "部长A" });
		expect(result.自动交付).toBe(true);
	});
});
