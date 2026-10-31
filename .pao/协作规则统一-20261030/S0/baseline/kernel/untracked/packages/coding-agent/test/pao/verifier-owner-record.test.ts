import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { reviewCardForDelivery } from "../../src/pao/cards/verifier.ts";

const roots: string[] = [];
const time = "2026-10-30 03:00";
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const home = process.env.PAO_HOME?.trim();
	if (!home || !isAbsolute(home)) throw new Error("须设置绝对路径的隔离 PAO_HOME");
	mkdirSync(home, { recursive: true });
	const root = mkdtempSync(join(home, "owner-record-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "卡");
	const card = await createCard(
		cardsDir,
		{ 目标: "同分钟接受偏差", 部门: "测试", 验收: "人工检查", 创建: time },
		{ counterPath: join(root, ".pao", "卡号.txt") },
	);
	const claimed = changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: time });
	appendReceipt(claimed, {
		尝试号: 1,
		时间: time,
		结果: "success",
		摘要: "离线夹具：自报未运行，等待裁决",
		verification: [{ 条件: "外部环境验证", 结论: "not_run", 证据: "本例仅验证审计记录" }],
	});
	const options = { operator: "主控", 时间: time };
	const accept = (basis: string) =>
		reviewCardForDelivery(cardsDir, card.card_no, options, "已核对当前成果与限制", [
			{ attempt: 1, verification_index: 0, condition: "外部环境验证", basis },
		]);
	return { path: card.path, accept };
}

test("同分钟的认领记录与接受偏差可并存，完全相同重放不追加", async () => {
	const { path, accept } = await fixture();
	await accept("本项限制已逐项评估");
	const first = readFileSync(path, "utf8");
	expect(first).toContain("- 事件: 状态改为 in_progress");
	expect(first).toContain("- 事件: 接受自报未达项");
	await accept("本项限制已逐项评估");
	expect(readFileSync(path, "utf8")).toBe(first);
	expect(readCard(path).frontmatter.status).toBe("in_progress");
});

test("相同时间、事件及尝试已经受理不同依据时仍拒绝，原依据保留", async () => {
	const { path, accept } = await fixture();
	await accept("最初依据");
	await expect(accept("替换成不同依据")).rejects.toThrow("内容不同的 owner 记录");
	const body = readFileSync(path, "utf8");
	expect(body).toContain("接受依据: 最初依据");
	expect(body).not.toContain("接受依据: 替换成不同依据");
});
