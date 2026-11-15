import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { PaoCardError } from "../../src/pao/cards/errors.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";

/**
 * M2-09 回执校验加强（增量三格）：产物路径真实存在（声明了才查）、摘要 ≤3 行、
 * 尝试号与卡面连续（既有校验覆盖确认）。拒收＝PaoCardError，卡文件不动，worker 重写。
 */

function makeCardsDir(): string {
	// 与任务工作区同构的嵌套布局，产物相对项目根 dir；计数器仍归 .pao。
	const dir = mkdtempSync(join(tmpdir(), "pao-receipt-checks-"));
	const cardsDir = join(dir, ".pao", "任务-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

function workspaceRoot(cardsDir: string): string {
	return join(cardsDir, "..", "..", "..");
}

async function makeRunningCard() {
	const cardsDir = makeCardsDir();
	const card = await createCard(cardsDir, {
		目标: "回执三格校验卡",
		部门: "核心机制",
		验收: "可判条件",
		创建: "2026-10-02 21:00",
	});
	const running = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
	return { cardsDir, card: running };
}

describe("回执三格校验：产物路径真实存在（声明了才查）", () => {
	test("嵌套任务卡的相对产物路径以项目根为基准：文件在则记录", async () => {
		const { cardsDir, card } = await makeRunningCard();
		writeFileSync(join(workspaceRoot(cardsDir), "产物.txt"), "worker 写入\n");
		const outcome = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-02 21:30",
			结果: "完成",
			摘要: "产物已落",
			产物路径: ["产物.txt"],
		});
		expect(outcome).toEqual({ kind: "已记录", 待审: true });
	});

	test("项目根没有产物时，不把 .pao 下的同名文件当成产物", async () => {
		const { cardsDir, card } = await makeRunningCard();
		writeFileSync(join(workspaceRoot(cardsDir), ".pao", "产物.txt"), "这不是项目产物\n");
		expect(() =>
			appendReceipt(card, {
				尝试号: 1,
				时间: "2026-10-02 21:30",
				产物路径: ["产物.txt"],
			}),
		).toThrow(/回执产物路径不存在/);
	});

	test("声明的产物不存在即拒收（INVALID_RECEIPT），卡文件不动", async () => {
		const { card } = await makeRunningCard();
		const before = readFileSync(card.path, "utf8");
		try {
			appendReceipt(card, {
				尝试号: 1,
				时间: "2026-10-02 21:30",
				结果: "完成",
				摘要: "虚报产物",
				产物路径: ["幽灵.txt"],
			});
			expect.unreachable("应当拒收");
		} catch (error) {
			expect(error).toBeInstanceOf(PaoCardError);
			const err = error as PaoCardError;
			expect(err.code).toBe("INVALID_RECEIPT");
			expect(err.message).toContain("幽灵.txt");
			expect(err.details.缺失产物).toEqual(["幽灵.txt"]);
		}
		// 拒收不落卡：正文无回执段，重读一致
		expect(readCard(card.path).receipts).toHaveLength(0);
		expect(readFileSync(card.path, "utf8")).toBe(before);
	});

	test("多条产物逐一核对：部分缺失时整条拒收并列出缺失项", async () => {
		const { cardsDir, card } = await makeRunningCard();
		writeFileSync(join(workspaceRoot(cardsDir), "产物.txt"), "有这个\n");
		expect(() =>
			appendReceipt(card, {
				尝试号: 1,
				时间: "2026-10-02 21:30",
				产物路径: ["产物.txt", "缺的.md"],
			}),
		).toThrow(/缺的\.md/);
	});

	test("绝对路径原样查：存在放行，不存在拒收", async () => {
		const { cardsDir, card } = await makeRunningCard();
		const outside = join(cardsDir, "..", "外部产物.txt");
		writeFileSync(outside, "工作区外的真实文件\n");
		const outcome = appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30", 产物路径: [outside] });
		expect(outcome).toEqual({ kind: "已记录", 待审: true });

		const missing = join(workspaceRoot(cardsDir), "没有这文件.txt");
		expect(() => appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:31", 产物路径: [missing] })).toThrow(
			PaoCardError,
		);
	});

	test("回答型任务不报产物（缺省或空表）不查存在性：合法不拒收", async () => {
		const { card } = await makeRunningCard();
		expect(appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30", 结果: "完成", 摘要: "纯回答" }).kind).toBe(
			"已记录",
		);
		expect(appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:31", 产物路径: [] }).kind).toBe("已记录");
	});

	test("留档回执同过这道门：旧尝试/迟到回执声明不存在的产物同样拒收", async () => {
		const { card } = await makeRunningCard();
		// 旧尝试通道：失败→待认领→进行中，尝试升到 2 后交尝试 1 的回执
		const failed = changeCardStatus(card, {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-02 21:15",
		});
		const back = changeCardStatus(failed, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:16" });
		const running = changeCardStatus(back, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:20" });
		expect(() => appendReceipt(running, { 尝试号: 1, 时间: "2026-10-02 21:25", 产物路径: ["幽灵.txt"] })).toThrow(
			PaoCardError,
		);

		// 迟到回执通道：终态卡上补交不存在产物的回执同样拒收
		const delivered = changeCardStatus(running, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:00" });
		expect(() => appendReceipt(delivered, { 尝试号: 2, 时间: "2026-10-02 22:10", 产物路径: ["幽灵.txt"] })).toThrow(
			PaoCardError,
		);
	});
});

describe("回执三格校验：摘要 ≤3 行（按换行计）", () => {
	test("3 行以内放行（含正好 3 行）", async () => {
		const { card } = await makeRunningCard();
		const outcome = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-02 21:30",
			摘要: "第一行\n第二行\n第三行",
		});
		expect(outcome).toEqual({ kind: "已记录", 待审: true });
	});

	test("超过 3 行拒收（4 行即拒），卡上不留该回执", async () => {
		const { card } = await makeRunningCard();
		try {
			appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30", 摘要: "一\n二\n三\n四" });
			expect.unreachable("应当拒收");
		} catch (error) {
			expect(error).toBeInstanceOf(PaoCardError);
			expect((error as PaoCardError).code).toBe("INVALID_RECEIPT");
			expect((error as PaoCardError).message).toContain("3 行");
		}
		expect(readCard(card.path).receipts).toHaveLength(0);
	});

	test("留档回执的超行摘要同样拒收，不静默截断", async () => {
		const { card } = await makeRunningCard();
		const delivered = changeCardStatus(card, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:00" });
		expect(() => appendReceipt(delivered, { 尝试号: 1, 时间: "2026-10-02 22:10", 摘要: "一\n二\n三\n四" })).toThrow(
			PaoCardError,
		);
		expect(readCard(delivered.path).receipts).toHaveLength(0);
	});
});

describe("回执三格校验：尝试号与卡面连续（既有校验覆盖确认）", () => {
	test("等于卡面当前尝试才以「已记录」落卡；超前即 INVALID_RECEIPT；滞后走旧尝试留档不拒收", async () => {
		const { card } = await makeRunningCard();
		// == 当前尝试：正常落卡
		expect(appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30" }).kind).toBe("已记录");
		// > 当前尝试：结构化错误（超前尝试不存在）
		expect(() => appendReceipt(card, { 尝试号: 2, 时间: "2026-10-02 21:31" })).toThrow(PaoCardError);
		// < 当前尝试：模板 §2 设计内的留档通道，不是拒收对象
		const failed = changeCardStatus(card, {
			操作者: "部长A",
			to: "failed",
			失败类型: "missing_input",
			时间: "2026-10-02 21:35",
		});
		const back = changeCardStatus(failed, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:36" });
		const running = changeCardStatus(back, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:40" });
		const outcome = appendReceipt(running, { 尝试号: 1, 时间: "2026-10-02 21:41" });
		expect(outcome).toEqual({ kind: "旧尝试留档" });
		expect(
			readCard(running.path).receipts.find((r) => r.attempt === 1 && r.archive_flag === "old_attempt"),
		).toBeTruthy();
	});
});

describe("拒收通道与存在性基准", () => {
	test("错误带 code=INVALID_RECEIPT 走 PaoCardError 通道（与既有校验同款）", async () => {
		const { card } = await makeRunningCard();
		const caught: unknown[] = [];
		try {
			appendReceipt(card, { 尝试号: 5, 时间: "2026-10-02 21:30" });
		} catch (error) {
			caught.push(error);
		}
		try {
			appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30", 摘要: "一\n二\n三\n四" });
		} catch (error) {
			caught.push(error);
		}
		expect(caught).toHaveLength(2);
		for (const error of caught) {
			expect(error).toBeInstanceOf(PaoCardError);
			expect((error as PaoCardError).code).toBe("INVALID_RECEIPT");
		}
	});

	test("拒收后 worker 重写再交可正常落卡（拒收不是终局）", async () => {
		const { cardsDir, card } = await makeRunningCard();
		expect(() => appendReceipt(card, { 尝试号: 1, 时间: "2026-10-02 21:30", 摘要: "一\n二\n三\n四" })).toThrow(
			PaoCardError,
		);
		writeFileSync(join(workspaceRoot(cardsDir), "产物.txt"), "补上了\n");
		const outcome = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-02 21:35",
			摘要: "改好了",
			产物路径: ["产物.txt"],
		});
		expect(outcome).toEqual({ kind: "已记录", 待审: true });
		expect(readCard(card.path).receipts).toHaveLength(1);
		expect(existsSync(join(workspaceRoot(cardsDir), "产物.txt"))).toBe(true);
	});
});
