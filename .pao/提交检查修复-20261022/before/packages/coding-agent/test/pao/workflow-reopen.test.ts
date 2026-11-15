/** 控制层回归：真实磁盘状态，卡结果为明确模拟；不冒充宿主完整闭环。 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { listCards, loadCard, parseCardRef, serializeCard, serializeReceipt } from "../../src/pao/cards/index.ts";
import type { ProcessEntry } from "../../src/pao/worker/registry.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	controlReport,
	endDecomposition,
	pauseControl,
	readControl,
	recordControlCalledHuman,
	reopenControl,
	resumeControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pao-reopen-"));
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "恢复",
			参数: ["路径"],
			节点: [
				{ 名字: "实施", 部门: "实施", 目标: "修改", 验收: "存在: result.txt" },
				{ 名字: "审核", 部门: "审核", 目标: "检查", 验收: "明确理由", depends_on: ["实施"] },
				{ 名字: "旁支", 部门: "旁支", 目标: "独立", 验收: "明确理由" },
			],
		})}---\n`,
		join(root, "恢复.md"),
	);
	const options = { cardsDir: join(root, ".pao", "任务", "卡"), ownerSessionId: "owner" };
	await startControl(recipe, { 路径: "/app/bad.py" }, options);
	await bindMinister(recipe, options, "实施", "minister-1");
	const flow = readControl(recipe, options);
	const identity = { 实例: flow.实例, 节点: "实施", 轮次: 1, 部长会话: "minister-1" };
	const [ref] = await addNodeCards(recipe, options, identity, [{ goal: "修复", acceptance: "存在: result.txt" }]);
	await endDecomposition(recipe, options, identity);
	return {
		recipe,
		options,
		identity,
		ref,
		input: { 实例: flow.实例, 原owner: "owner", 节点: "实施", 轮次: 1, 现场核查: "坏验收已核实，无在途，原轮留存" },
	};
}

describe("原实例当前节点受控重开", () => {
	test("保留原实例和旧卡历史，换新轮和部长身份，不影响独立旁支", async () => {
		const s = await fixture();
		await bindMinister(s.recipe, s.options, "旁支", "parallel-session");
		const before = readControl(s.recipe, s.options);
		const oldCard = loadCard(s.options.cardsDir, parseCardRef(s.ref));
		const oldText = readFileSync(oldCard.path, "utf8");
		await reopenControl(s.recipe, s.options, s.input, () => []);
		const after = readControl(s.recipe, s.options);
		expect(after.实例).toBe(before.实例);
		expect(after.owner).toBe("owner");
		expect(after.节点[0]).toMatchObject({ 轮次: 2, 卡: [], 拆解结束: false, 历史: [{ 轮次: 1, 卡: [s.ref] }] });
		expect(after.节点[0].部长会话).toBeUndefined();
		expect(after.节点[2]).toEqual(before.节点[2]);
		expect(readFileSync(oldCard.path, "utf8")).toBe(oldText);
		await expect(
			addNodeCards(s.recipe, s.options, s.identity, [{ goal: "迟到", acceptance: "存在: x" }]),
		).rejects.toThrow(/旧轮次/);
		await bindMinister(s.recipe, s.options, "实施", "minister-2");
		const refs = await addNodeCards(s.recipe, s.options, { ...s.identity, 轮次: 2, 部长会话: "minister-2" }, [
			{ goal: "合格新卡", acceptance: "存在: result.txt" },
		]);
		expect(refs[0]).not.toBe(s.ref);
	});
	test("重开暂停实例保留暂停与叫人记录，再由 resume 显式恢复", async () => {
		const s = await fixture();
		await pauseControl(s.recipe, s.options, "等待旁支修复");
		await recordControlCalledHuman(s.recipe, s.options, "旁支::1::现场核查");
		await reopenControl(s.recipe, s.options, s.input, () => []);
		const reopened = readControl(s.recipe, s.options);
		expect(reopened.节点[0].轮次).toBe(2);
		expect(reopened.暂停).toBe("等待旁支修复");
		expect(reopened.叫人).toBe("旁支::1::现场核查");
		expect(controlReport(reopened).status).toBe("hold");

		await resumeControl(s.recipe, s.options, {
			实例: reopened.实例,
			原owner: reopened.owner,
			现场核查: "旁支已修复，以新轮继续实施",
		});
		const resumed = readControl(s.recipe, s.options);
		expect(resumed.暂停).toBeUndefined();
		expect(resumed.节点[0].轮次).toBe(2);
	});
	test.each([{ 轮次: 2 }, { 实例: "错误" }, { 原owner: "别人" }, { 现场核查: " " }])(
		"拒绝错误身份 %j，原件不变",
		async (patch) => {
			const s = await fixture();
			const path = controlPath(s.recipe, s.options),
				before = readFileSync(path, "utf8");
			await expect(reopenControl(s.recipe, s.options, { ...s.input, ...patch }, () => [])).rejects.toThrow(
				/身份、轮次/,
			);
			expect(readFileSync(path, "utf8")).toBe(before);
		},
	);
	test.each(["in_progress", "delivered"] as const)("拒绝 %s 卡", async (status) => {
		const s = await fixture(),
			card = loadCard(s.options.cardsDir, parseCardRef(s.ref));
		writeFileSync(card.path, serializeCard({ ...card.frontmatter, status, owner: "owner", attempt: 1 }, card.body));
		await expect(reopenControl(s.recipe, s.options, s.input, () => [])).rejects.toThrow(/仍在途|已交付|已完成/);
		expect(readControl(s.recipe, s.options).节点[0].轮次).toBe(1);
	});
	test("即使卡仍未认领，只要有登记活进程也拒绝", async () => {
		const s = await fixture(),
			card = loadCard(s.options.cardsDir, parseCardRef(s.ref));
		const process = { pid: 123, card_no: s.ref, card_path: card.path, running: true } as ProcessEntry;
		await expect(reopenControl(s.recipe, s.options, s.input, () => [process])).rejects.toThrow(/活工人/);
	});
	test("未认领卡已有当前回执时拒绝；已失败的单次回执可留存后重开", async () => {
		const s = await fixture(),
			card = loadCard(s.options.cardsDir, parseCardRef(s.ref));
		const receipt = { card_no: card.card_no, attempt: 0, time: "2026-10-22 18:00", result: "success" };
		writeFileSync(card.path, serializeCard(card.frontmatter, `${card.body}\n${serializeReceipt(receipt)}`));
		await expect(reopenControl(s.recipe, s.options, s.input, () => [])).rejects.toThrow(/回执归属冲突/);
		writeFileSync(
			card.path,
			serializeCard(
				{ ...card.frontmatter, status: "failed", attempt: 1, owner: "owner" },
				`${card.body}\n${serializeReceipt({ ...receipt, attempt: 1 })}`,
			),
		);
		await reopenControl(s.recipe, s.options, s.input, () => []);
		expect(loadCard(s.options.cardsDir, card.card_no).receipts).toHaveLength(1);
	});
	test("下游已有绑定时不清空已有成果", async () => {
		const s = await fixture(),
			flow = readControl(s.recipe, s.options);
		flow.节点[1].部长会话 = "downstream";
		writeFileSync(controlPath(s.recipe, s.options), `---\n${stringify(flow)}---\n`);
		await expect(reopenControl(s.recipe, s.options, s.input, () => [])).rejects.toThrow(/下游已经启动/);
	});
	test("整批最终参数验收先检查，非法卡不落盘也不结束拆解，修正后可提交", async () => {
		const s = await fixture();
		await reopenControl(s.recipe, s.options, s.input, () => []);
		await bindMinister(s.recipe, s.options, "实施", "minister-2");
		const id = { ...s.identity, 轮次: 2, 部长会话: "minister-2" };
		await expect(
			addNodeCards(s.recipe, s.options, id, [
				{ goal: "合法", acceptance: "存在: result.txt" },
				{ goal: "非法", acceptance: "存在: {路径}" },
			]),
		).rejects.toThrow(/绝对路径/);
		expect(listCards(s.options.cardsDir)).toHaveLength(1);
		expect(readControl(s.recipe, s.options).节点[0]).toMatchObject({ 拆解结束: false, 卡: [] });
		await expect(
			addNodeCards(s.recipe, s.options, id, [{ goal: "修正", acceptance: "存在: result.txt" }]),
		).resolves.toHaveLength(1);
	});
});
