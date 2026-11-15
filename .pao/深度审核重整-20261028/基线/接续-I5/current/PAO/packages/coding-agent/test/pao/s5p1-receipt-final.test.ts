import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { parseWorkerFinalResult } from "../../src/pao/worker/receipt.ts";

/**
 * S5 包1（F-A7）：worker 自报四态（completed/completed_with_deviations/blocked/checkpoint）、
 * verification（条件/pass|fail|not_run/证据）与 changes 声明的解析；
 * 有效尝试的终结结果仅接纳一次（重复终结留档）；checkpoint 不冒充完成（可待审指引但不终结）。
 * 回执新字段落卡后可往返读取（serializeReceipt/parseReceipts）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCardsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-s5p1-receipt-"));
	tempDirs.push(dir); // S5 包3回归时发现的泄漏:mkdtemp 后未登记,afterEach 清不掉
	const cardsDir = join(dir, ".pao", "任务-20261007", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

async function makeRunningCard() {
	const cardsDir = makeCardsDir();
	const card = await createCard(cardsDir, {
		目标: "四态回执卡",
		部门: "核心机制",
		验收: "可判条件",
		创建: "2026-10-07 10:00",
	});
	const running = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-07 10:01" });
	return { cardsDir, card: running };
}

describe("最终 JSON 自报：任务态四态与 verification/changes 解析", () => {
	test("completed + 全 pass verification + changes 完整解析", () => {
		const result = parseWorkerFinalResult(
			JSON.stringify({
				result: "success",
				任务态: "completed",
				artifact_path: [],
				summary: "完成",
				verification: [
					{ 条件: "测试全绿", 结论: "pass", 证据: "npx vitest exit 0" },
					{ 条件: "另一条", 结论: "not_run" },
				],
				changes: [
					{ 路径: "src/a.ts", 类型: "modified", 说明: "改了 a" },
					{ 路径: "src/b.ts", 类型: "created" },
				],
			}),
			process.cwd(),
		);
		expect(result.任务态).toBe("completed");
		expect(result.verification).toHaveLength(2);
		expect(result.verification?.[0]).toEqual({ 条件: "测试全绿", 结论: "pass", 证据: "npx vitest exit 0" });
		expect(result.changes?.[0]?.路径).toBe("src/a.ts");
		expect(result.changes?.[0]?.类型).toBe("modified");
	});

	test("任务态非法值与 verification/changes 坏形状一律拒收", () => {
		expect(() =>
			parseWorkerFinalResult(
				JSON.stringify({ result: "success", 任务态: "done", artifact_path: [], summary: "x" }),
				process.cwd(),
			),
		).toThrow(/任务态/);
		expect(() =>
			parseWorkerFinalResult(
				JSON.stringify({
					result: "success",
					任务态: "completed",
					artifact_path: [],
					summary: "x",
					verification: [{ 条件: "c", 结论: "maybe" }],
				}),
				process.cwd(),
			),
		).toThrow(/verification/);
		expect(() =>
			parseWorkerFinalResult(
				JSON.stringify({
					result: "success",
					任务态: "completed",
					artifact_path: [],
					summary: "x",
					changes: [{ 路径: "", 类型: "modified" }],
				}),
				process.cwd(),
			),
		).toThrow(/changes/);
		expect(() =>
			parseWorkerFinalResult(
				JSON.stringify({
					result: "success",
					任务态: "completed",
					artifact_path: [],
					summary: "x",
					changes: [{ 路径: "a.ts", 类型: "renamed" }],
				}),
				process.cwd(),
			),
		).toThrow(/changes/);
	});

	test("合法检查之后混入说明对象仍拒收整份回执，不默默丢弃末项", () => {
		expect(() =>
			parseWorkerFinalResult(
				JSON.stringify({
					result: "success",
					artifact_path: [],
					summary: "补充说明应在这里",
					verification: [{ 条件: "真实检查", 结论: "pass" }, { condition_note: "还需要独立复核" }],
				}),
				process.cwd(),
			),
		).toThrow("verification 条目须带非空 条件");
	});

	test("无任务态的旧链路最终输出仍按原样解析（兼容）", () => {
		const result = parseWorkerFinalResult(
			JSON.stringify({ result: "success", artifact_path: [], summary: "旧链路" }),
			process.cwd(),
		);
		expect(result.result).toBe("success");
		expect(result.任务态).toBeUndefined();
	});
});

describe("有效尝试的终结结果仅接纳一次", () => {
	test("第二条终结自报只留档不重复接纳", async () => {
		const { card } = await makeRunningCard();
		const first = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-07 10:10",
			结果: "成功",
			摘要: "第一次终结",
			任务态: "completed",
		});
		expect(first).toEqual({ kind: "已记录", 待审: true });
		const second = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-07 10:20",
			结果: "成功",
			摘要: "重复终结",
			任务态: "completed_with_deviations",
		});
		expect(second).toEqual({ kind: "重复终结留档" });
		const fresh = readCard(card.path);
		const accepted = fresh.receipts.filter((r) => !r.archive_flag);
		expect(accepted).toHaveLength(1);
		expect(accepted[0]?.summary).toBe("第一次终结");
		expect(fresh.receipts.some((r) => r.archive_flag === "重复终结留档")).toBe(true);
	});

	test("终结后的迟到 checkpoint 同样留档（尝试已终结）", async () => {
		const { card } = await makeRunningCard();
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-07 10:10", 结果: "成功", 摘要: "终结", 任务态: "blocked" });
		const late = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-07 10:30",
			结果: "成功",
			摘要: "迟到检查点",
			任务态: "checkpoint",
		});
		expect(late).toEqual({ kind: "重复终结留档" });
	});

	test("checkpoint 之后的首条终结自报正常接纳（checkpoint 不是终结）", async () => {
		const { card } = await makeRunningCard();
		const cp = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-07 10:05",
			结果: "成功",
			摘要: "到决策点：选 A 还是 B？",
			任务态: "checkpoint",
		});
		expect(cp).toEqual({ kind: "已记录", 待审: true });
		const done = appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-07 10:15",
			结果: "成功",
			摘要: "按指引选 A 完成",
			任务态: "completed",
		});
		expect(done).toEqual({ kind: "已记录", 待审: true });
		const fresh = readCard(card.path);
		expect(fresh.receipts.every((r) => !r.archive_flag)).toBe(true);
	});

	test("旧尝试的终结自报仍走旧尝试留档（不与当前尝试混算）", async () => {
		const { card } = await makeRunningCard();
		// 尝试 1 终结后 owner 落失败重开（失败→待认领→进行中）→ 尝试 2
		appendReceipt(card, { 尝试号: 1, 时间: "2026-10-07 10:10", 结果: "失败", 摘要: "一败", 任务态: "blocked" });
		const failed = readCard(card.path);
		changeCardStatus(failed, { 操作者: "部长A", to: "failed", 失败类型: "missing_input", 时间: "2026-10-07 10:11" });
		changeCardStatus(readCard(card.path), { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-07 10:11" });
		changeCardStatus(readCard(card.path), { 操作者: "部长A", to: "in_progress", 时间: "2026-10-07 10:12" });
		const attempt2 = readCard(card.path);
		expect(attempt2.frontmatter.attempt).toBe(2);
		const stale = appendReceipt(attempt2, {
			尝试号: 1,
			时间: "2026-10-07 10:13",
			结果: "成功",
			摘要: "旧尝试终结补交",
			任务态: "completed",
		});
		expect(stale).toEqual({ kind: "旧尝试留档" });
	});
});

describe("自报字段落卡往返（serializeReceipt → parseReceipts）", () => {
	test("任务态/verification/changes 落卡后重读不丢", async () => {
		const dir = makeCardsDir();
		const card = await createCard(dir, {
			目标: "往返卡",
			部门: "核心机制",
			验收: "可判条件",
			创建: "2026-10-07 11:00",
		});
		const running = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-07 11:01" });
		appendReceipt(running, {
			尝试号: 1,
			时间: "2026-10-07 11:05",
			结果: "成功",
			摘要: "带自报",
			任务态: "completed_with_deviations",
			verification: [{ 条件: "测试", 结论: "fail", 证据: "exit 1" }],
			changes: [{ 路径: "产物.txt", 类型: "created", 说明: "新产物" }],
		});
		const fresh = readCard(running.path);
		expect(fresh.receipts[0]?.任务态).toBe("completed_with_deviations");
		expect(fresh.receipts[0]?.verification).toEqual([{ 条件: "测试", 结论: "fail", 证据: "exit 1" }]);
		expect(fresh.receipts[0]?.changes).toEqual([{ 路径: "产物.txt", 类型: "created", 说明: "新产物" }]);
	});
});
