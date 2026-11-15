import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { PaoCardError } from "../../src/pao/cards/errors.ts";
import { appendReceipt, isPendingReview } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";

function makeCardsDir(): string {
	// 与任务工作区同构的嵌套布局，避免默认计数器落到共享上级目录
	const dir = mkdtempSync(join(tmpdir(), "pao-receipt-"));
	const cardsDir = join(dir, ".pao", "任务-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

async function makeRunningCard() {
	const card = await createCard(makeCardsDir(), {
		目标: "回执流程卡",
		部门: "核心机制",
		验收: "可判条件",
		创建: "2026-10-02 21:00",
	});
	return changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
}

describe("appendReceipt 回执通道", () => {
	test("当前尝试回执：追加成功，状态不变，派生待审", async () => {
		const card = await makeRunningCard();
		const outcome = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-02 21:30",
			结果: "完成",
			摘要: "已实现，全绿",
			证据: ["npx vitest run cards-*.test.ts"],
			用量: { turns: 6 },
		});
		expect(outcome).toEqual({ kind: "已记录", 待审: true });

		const reread = readCard(card.path);
		// worker 只追加：状态与信封字段未被改动
		expect(reread.frontmatter.status).toBe("in_progress");
		expect(reread.frontmatter.attempt).toBe(1);
		expect(reread.receipts).toHaveLength(1);
		expect(reread.receipts[0]).toMatchObject({ card_no: card.card_no, attempt: 1, result: "完成" });
		expect(isPendingReview(reread)).toBe(true);
	});

	test("同一当前尝试普通回执重送不重复累计；不同结果和证据保留", async () => {
		const card = await makeRunningCard();
		const input = {
			尝试号: 1,
			时间: "2026-10-02 21:30",
			结果: "检查点",
			摘要: "已完成定位",
			用量: { turns: 1 },
			证据: ["source.ts:1"],
		};
		appendReceipt(card, input);
		const disk = readCard(card.path);
		expect(appendReceipt(disk, { ...input, 时间: "2026-10-02 21:31" })).toMatchObject({ 重复: true });
		expect(readCard(card.path).receipts).toHaveLength(1);
		appendReceipt(readCard(card.path), { ...input, 结果: "发现缺陷", 证据: ["source.ts:2"] });
		expect(readCard(card.path).receipts).toHaveLength(2);
	});
	test("worker 无法经回执通道改状态：信封字段保持原样", async () => {
		const card = await makeRunningCard();
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30", 结果: "完成" });
		const reread = readCard(card.path);
		expect(reread.frontmatter.status).toBe("in_progress"); // 不是 已交付
		expect(reread.frontmatter.completed).toBeUndefined();
	});

	test("旧尝试回执只留档：不推进状态、不触发重试、带留档标记", async () => {
		const card = await makeRunningCard();
		// 走一轮失败+重试，当前尝试变 2
		const failed = changeCardStatus(card, {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-02 21:15",
		});
		const back = changeCardStatus(failed, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:16" });
		const running = changeCardStatus(back, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:20" });
		expect(running.frontmatter.attempt).toBe(2);

		const outcome = appendReceipt(running, { 尝试号: 1, 时间: "2026-10-02 21:25", 结果: "完成" });
		expect(outcome).toEqual({ kind: "旧尝试留档" });

		const reread = readCard(running.path);
		expect(reread.frontmatter.status).toBe("in_progress");
		expect(reread.frontmatter.attempt).toBe(2);
		expect(reread.receipts.find((r) => r.attempt === 1)?.archive_flag).toBe("old_attempt");
		expect(isPendingReview(reread)).toBe(false); // 当前尝试（2）没有回执
	});

	test("超前尝试号报 INVALID_RECEIPT；尝试号必须为正整数", async () => {
		const card = await makeRunningCard();
		expect(() => appendReceipt(card, { 尝试号: 2, 时间: "2026-10-02 21:30" })).toThrow(PaoCardError);
		expect(() => appendReceipt(card, { 尝试号: 0, 时间: "2026-10-02 21:30" })).toThrow(PaoCardError);
	});

	test("回执时间不合协议格式时当场拒收（否则写下去的回执再也读不回来）", async () => {
		const card = await makeRunningCard();
		// ISO 时刻：标题行解析不了，回执会静默丢——必须在写入前报错
		expect(() => appendReceipt(card, { 尝试号: 1, 时间: new Date().toISOString(), 结果: "完成" })).toThrow(
			/回执时间必须是本地时刻/,
		);
		expect(() => appendReceipt(card, { 尝试号: 1, 时间: "", 结果: "完成" })).toThrow(PaoCardError);
		// 协议格式仍照常落卡，且重读能解析回来
		const outcome = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-02 21:30",
			结果: "完成",
			证据: ["产物:1 已核对"],
		});
		expect(outcome.kind).toBe("已记录");
		const reread = readCard(card.path);
		expect(reread.receipts).toHaveLength(1);
		expect(reread.receipts[0].evidence).toEqual(["产物:1 已核对"]);
	});

	test("终态卡迟到回执：追加留档，不再变状态", async () => {
		const card = await makeRunningCard();
		const delivered = changeCardStatus(card, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:00" });
		const outcome = appendReceipt(delivered, { 尝试号: 1, 时间: "2026-10-02 22:10", 结果: "补充说明" });
		expect(outcome).toEqual({ kind: "迟到回执留档" });
		const reread = readCard(delivered.path);
		expect(reread.frontmatter.status).toBe("delivered");
		expect(reread.receipts).toHaveLength(1);
		expect(reread.receipts[0].archive_flag).toBe("late_receipt");
		expect(isPendingReview(reread)).toBe(false);
	});

	test("待认领/失败状态的卡不派生待审", async () => {
		const card = await makeRunningCard();
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30", 结果: "完成" });
		const failed = changeCardStatus(card, {
			操作者: "部长A",
			to: "failed",
			失败类型: "missing_input",
			时间: "2026-10-02 21:35",
		});
		expect(isPendingReview(failed)).toBe(false);
	});
});
