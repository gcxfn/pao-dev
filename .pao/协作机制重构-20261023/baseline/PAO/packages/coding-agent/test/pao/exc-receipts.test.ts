import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { appendReceipt, isPendingReview } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";

/**
 * M1-06 异常核:重复通知、取消后迟到、直通卡收尾(G1-03/G1-04 的卡片层缺口补齐;
 * 旧尝试迟到/超前尝试已在 cards-receipts.test.ts 覆盖,此处不重写)。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCardsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-exc-"));
	tempDirs.push(dir);
	const cardsDir = join(dir, ".pao", "任务-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

async function makeRunningCard(owner = "部长A") {
	const card = await createCard(makeCardsDir(), {
		目标: "异常核卡",
		部门: "核心机制",
		验收: "可判条件",
		创建: "2026-10-02 22:00",
	});
	return changeCardStatus(card, { 操作者: owner, to: "in_progress", 时间: "2026-10-02 22:05" });
}

describe("重复回执:同尝试号交两次不重复推进(G1-04)", () => {
	test("同一尝试交两份回执:都留档,但状态/尝试数/待审不因重复而变化", async () => {
		const card = await makeRunningCard();
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 22:10", 结果: "完成", 摘要: "第一次交" });
		const second = appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 22:12", 结果: "完成", 摘要: "重复通知" });
		// 重复通知仍按「已记录」处理(当前尝试未变),但绝不推进新尝试
		expect(second.kind).toBe("已记录");

		const reread = readCard(card.path);
		expect(reread.receipts).toHaveLength(2);
		expect(reread.frontmatter.attempt).toBe(1); // 不推进新的尝试
		expect(reread.frontmatter.status).toBe("in_progress"); // 不自动晋升
		expect(reread.frontmatter.completed).toBeUndefined(); // 不算交付
		expect(isPendingReview(reread)).toBe(true); // 仍只是待审
	});

	test("重复回执后晋升仍只发生一次:owner 改状态是唯一交付通道", async () => {
		const card = await makeRunningCard();
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 22:10", 结果: "完成" });
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 22:12", 结果: "完成" });
		const delivered = changeCardStatus(card, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:15" });
		expect(delivered.frontmatter.status).toBe("delivered");
		// 迟到的第三份重复回执:留档,状态不动
		const third = appendReceipt(delivered, { 尝试号: 1, 时间: "2026-10-02 22:20", 结果: "完成" });
		expect(third.kind).toBe("迟到回执留档");
		expect(readCard(delivered.path).frontmatter.status).toBe("delivered");
	});
});

describe("取消后迟到回执(G1-04 取消侧)", () => {
	test("取消终态后回执到达:留档不变状态,不再触发改派", async () => {
		const card = await makeRunningCard();
		const cancelled = changeCardStatus(card, { 操作者: "用户", to: "canceled", 时间: "2026-10-02 22:10" });
		const outcome = appendReceipt(cancelled, { 尝试号: 1, 时间: "2026-10-02 22:15", 结果: "完成" });
		expect(outcome).toEqual({ kind: "迟到回执留档" });
		const reread = readCard(cancelled.path);
		expect(reread.frontmatter.status).toBe("canceled");
		expect(reread.receipts[0].archive_flag).toBe("late_receipt");
		// 迟到回执不派生待审,不把取消卡拉回活状态
		expect(isPendingReview(reread)).toBe(false);
	});
});

describe("直通卡收尾(G1-03)", () => {
	test("直通卡有回执但未验收:停在待审,不误结卡", async () => {
		// 直通卡 owner = 主控(架构 §5.1 R03)
		const card = await makeRunningCard("主控");
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 22:10", 结果: "完成", 摘要: "机械活干完了" });
		const reread = readCard(card.path);
		// 回执在而状态未终 = 待审;没有任何通道把「交了回执」当「已交付」
		expect(reread.frontmatter.status).toBe("in_progress");
		expect(isPendingReview(reread)).toBe(true);
	});

	test("直通卡无知识候选:验收通过即可完成,不依赖部长/知识工具", async () => {
		const card = await makeRunningCard("主控");
		// 回执「值得沉淀」为空 → 明记无增量,不编知识
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 22:10", 结果: "完成", 值得沉淀: undefined });
		const delivered = changeCardStatus(card, {
			操作者: "主控",
			to: "delivered",
			时间: "2026-10-02 22:12",
			依据: "机械验收通过,无增量",
		});
		expect(delivered.frontmatter.status).toBe("delivered");
		expect(delivered.frontmatter.completed).toBeTruthy();
	});
});
