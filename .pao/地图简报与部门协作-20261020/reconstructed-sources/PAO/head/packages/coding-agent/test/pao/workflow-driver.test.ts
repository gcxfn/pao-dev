/**
 * 工作流机械驱动器（架构 §11.3）：全链落卡、depends_on 顺序推进、人工门停流与点头放行、
 * 失败即停、断点续跑、清单缺失从卡重建、重复启动拒绝。
 * 真相在卡上：卡交付用 cards 既有 changeCardStatus 推进（与 pao_change_status 同一迁移规则）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCards, loadCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { CardStatus } from "../../src/pao/cards/types.ts";
import * as atomic from "../../src/pao/shared/atomic.ts";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";
import {
	confirmWorkflowNode,
	humanCalled,
	manifestPath,
	parseManifest,
	queryWorkflow,
	rebuildEntriesFromCards,
	recordCalledHuman,
	renderReport,
	startWorkflow,
	suspendCallHumanKey,
	tickWorkflow,
	workflowMarker,
} from "../../src/pao/workflow/driver.ts";
import { loadRecipe, recipePath } from "../../src/pao/workflow/recipe.ts";

let paoHome: string;
let cardsDir: string;

beforeEach(() => {
	paoHome = mkdtempSync(join(tmpdir(), "pao-flow-driver-"));
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
	cardsDir = join(paoHome, "任务-20261002", "卡");
});

afterEach(() => {
	rmSync(paoHome, { recursive: true, force: true });
});

const threeStepFlow = `---
名字: 三步流
参数: [仓库]
节点:
  - 名字: 澄清
    部门: 规划部
    目标: "澄清 {仓库} 的原始意图"
    验收: 澄清纪要落盘
  - 名字: 侦察
    部门: 核心机制
    目标: "侦察 {仓库} 的现有实现"
    验收: 侦察笔记落盘
    depends_on: [澄清]
  - 名字: 规划
    部门: 规划部
    目标: "产出 {仓库} 的实施计划"
    验收: 计划落盘
    depends_on: [侦察]
---
`;

/** 门在中段的流：澄清 → 复核（人工确认）→ 规划，验证交付后停流等点头、点头后放行下游。 */
const midGateFlow = `---
名字: 中门流
参数: [仓库]
节点:
  - 名字: 澄清
    部门: 规划部
    目标: "澄清 {仓库} 的原始意图"
    验收: 澄清纪要落盘
  - 名字: 复核
    部门: 规划部
    目标: "对 {仓库} 的澄清结果做漂移复核"
    验收: 复核结论落盘
    depends_on: [澄清]
    人工确认: true
  - 名字: 规划
    部门: 规划部
    目标: "产出 {仓库} 的实施计划"
    验收: 计划落盘
    depends_on: [复核]
---
`;

function writeRecipe(name: string, content: string): void {
	writeFileSync(recipePath(paoHome, name), content, "utf8");
}

function driverOptions() {
	return { cardsDir, now: () => "2026-10-02 10:00" };
}

/** 用 cards 既有状态机把卡推进到目标状态（认领即成 owner，后续迁移同操作者）。 */
function advanceCard(cardNo: number, to: CardStatus): void {
	const card = loadCard(cardsDir, cardNo);
	const updated = changeCardStatus(card, {
		操作者: "测试员",
		to,
		时间: "2026-10-02 10:05",
		失败类型: to === "failed" ? "transient" : undefined,
		依据: to === "failed" ? "测试模拟失败" : undefined,
	});
	writeFileAtomic(updated.path, serializeCard(updated.frontmatter, updated.body));
}

describe("机械驱动器", () => {
	test("启动即落首批卡：无依赖节点落卡、参数代入、正文带流归属标记、清单落盘", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		const report = await startWorkflow(recipe, { 仓库: "pao" }, driverOptions());

		expect(report.status).toBe("running");
		expect(report.created_cards).toEqual([{ node: "澄清", card_no: "卡0001" }]);
		const card = loadCard(cardsDir, 1);
		expect(card.frontmatter.goal).toBe("澄清 pao 的原始意图");
		expect(card.frontmatter.dept).toBe("规划部");
		expect(card.frontmatter.acceptance).toBe("澄清纪要落盘");
		expect(card.frontmatter.depends_on).toEqual([]);
		expect(card.body).toContain(workflowMarker("三步流", "澄清"));
		const manifestFile = manifestPath(recipe, driverOptions());
		expect(existsSync(manifestFile)).toBe(true);
		expect(report.nodes.map((node) => node.status)).toEqual(["unclaimed", "未落卡", "未落卡"]);
	});

	test("depends_on 顺序推进：交付即解锁下游，卡 depends_on 记真实卡号", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);

		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		const second = await tickWorkflow(recipe, options);
		expect(second.created_cards).toEqual([{ node: "侦察", card_no: "卡0002" }]);
		expect(loadCard(cardsDir, 2).frontmatter.depends_on).toEqual(["卡0001"]);

		advanceCard(2, "in_progress");
		advanceCard(2, "delivered");
		const third = await tickWorkflow(recipe, options);
		expect(third.created_cards).toEqual([{ node: "规划", card_no: "卡0003" }]);
		expect(loadCard(cardsDir, 3).frontmatter.depends_on).toEqual(["卡0002"]);
	});

	test("全链交付到已完成：三节点全交付后流状态=已完成", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);
		for (const cardNo of [1, 2, 3]) {
			// 逐节点：交付上一张后推流落下一张
			if (cardNo > 1) await tickWorkflow(recipe, options);
			advanceCard(cardNo, "in_progress");
			advanceCard(cardNo, "delivered");
		}
		const final = await tickWorkflow(recipe, options);
		expect(final.status).toBe("completed");
		expect(final.nodes.every((node) => node.status === "delivered")).toBe(true);
	});

	test("人工门：交付后停流等点头，点头才放行下游；未标门节点自动放行", async () => {
		writeRecipe("中门流", midGateFlow);
		const recipe = loadRecipe(paoHome, "中门流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);

		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		// 复核卡落卡（澄清未标门，交付自动放行）
		const second = await tickWorkflow(recipe, options);
		expect(second.created_cards.map((item) => item.node)).toEqual(["复核"]);
		advanceCard(2, "in_progress");
		advanceCard(2, "delivered");

		// 人工门停住：复核已交付但未点头 → 规划不落卡，流挂起
		const gated = await tickWorkflow(recipe, options);
		expect(gated.status).toBe("hold");
		expect(gated.created_cards).toEqual([]);
		const reviewNode = gated.nodes.find((node) => node.name === "复核")!;
		expect(reviewNode.hold).toBe("等待人工确认");
		expect(gated.nodes.find((node) => node.name === "规划")!.status).toBe("未落卡");

		// 点头 → 放行下游
		const released = await confirmWorkflowNode(recipe, "复核", options);
		expect(released.created_cards).toEqual([{ node: "规划", card_no: "卡0003" }]);
		expect(loadCard(cardsDir, 3).frontmatter.goal).toBe("产出 pao 的实施计划");

		// 未标人工门的节点不可确认
		await expect(confirmWorkflowNode(recipe, "澄清", options)).rejects.toMatchObject({
			code: "FLOW_NODE_NOT_GATED",
		});
	});

	test("失败即停：前置卡失败，下游不落卡并标挂起原因", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);
		advanceCard(1, "in_progress");
		advanceCard(1, "failed");

		const report = await tickWorkflow(recipe, options);
		expect(report.status).toBe("hold");
		const recon = report.nodes.find((node) => node.name === "侦察")!;
		expect(recon.status).toBe("未落卡");
		expect(recon.hold).toContain("前置「澄清」failed");
		expect(listCards(cardsDir)).toHaveLength(1); // 只有失败的那张，下游没落卡
	});

	test.each(["failed", "canceled"] as const)("末节点%s也使流挂起，查流立即反映卡的实际状态", async (status) => {
		writeRecipe(
			"单步流",
			`---\n名字: 单步流\n节点:\n  - 名字: 实施\n    部门: 核心机制\n    目标: 完成修改\n    验收: 测试通过\n---\n`,
		);
		const recipe = loadRecipe(paoHome, "单步流");
		const options = driverOptions();
		await startWorkflow(recipe, {}, options);
		advanceCard(1, "in_progress");
		advanceCard(1, status);
		// 即使还没推流，也不能把已失败的末节点显示成仍在运行。
		expect(queryWorkflow(recipe, options).status).toBe("hold");
		const report = await tickWorkflow(recipe, options);
		expect(report.status).toBe("hold");
		expect(report.nodes[0].hold).toContain(status);
	});

	test("配方节点的轮次和工具次数预算透传到实际卡", async () => {
		writeRecipe(
			"单步流",
			`---\n名字: 单步流\n节点:\n  - 名字: 实施\n    部门: 核心机制\n    目标: 完成修改\n    验收: 测试通过\n    预算: {turns: 20, toolCalls: 200}\n---\n`,
		);
		const recipe = loadRecipe(paoHome, "单步流");
		await startWorkflow(recipe, {}, driverOptions());
		expect(loadCard(cardsDir, 1).frontmatter.budget).toEqual({ turns: 20, toolCalls: 200 });
	});

	test("断点续跑：重启后（全新调用）从实例清单＋卡状态继续推进", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		await startWorkflow(recipe, { 仓库: "pao" }, driverOptions());
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");

		// 模拟重启：全部状态从盘上清单＋卡现读
		const afterRestart = await tickWorkflow(recipe, driverOptions());
		expect(afterRestart.created_cards).toEqual([{ node: "侦察", card_no: "卡0002" }]);
		// 清单里持久化了启动参数，续跑落卡时占位符仍能代入
		expect(loadCard(cardsDir, 2).frontmatter.goal).toBe("侦察 pao 的现有实现");
	});

	test.skipIf(process.platform !== "win32")("Windows 同一卡目录切换斜杠或大小写后仍可推流", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		await startWorkflow(recipe, { 仓库: "pao" }, { ...driverOptions(), cardsDir: cardsDir.replaceAll("\\", "/") });
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		const report = await tickWorkflow(recipe, { ...driverOptions(), cardsDir: cardsDir.toUpperCase() });
		expect(report.created_cards).toEqual([{ node: "侦察", card_no: "卡0002" }]);
		expect(loadCard(cardsDir, 2).frontmatter.goal).toBe("侦察 pao 的现有实现");
	});

	test("重复启动拒绝（FLOW_EXISTS）", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		await startWorkflow(recipe, { 仓库: "pao" }, driverOptions());
		await expect(startWorkflow(recipe, { 仓库: "pao" }, driverOptions())).rejects.toMatchObject({
			code: "FLOW_EXISTS",
		});
	});

	test("v1 配方遇带版本的控制正本：拒绝降级读取（查/推两路同拒）且原件保留", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);
		const path = manifestPath(recipe, options);
		// 盘上实例文件被替换为带版本号的 v2 控制正本形态（同名文件,版本是唯一甄别手段）
		const upgraded = readFileSync(path, "utf8").replace("---\n", "---\n版本: 2\n");
		writeFileSync(path, upgraded);
		await expect(tickWorkflow(recipe, options)).rejects.toThrow("带版本控制的实例须经 v2 控制入口读取");
		expect(() => queryWorkflow(recipe, options)).toThrow("带版本控制的实例须经 v2 控制入口读取");
		// 不修复不覆盖：原件（含版本号）保留给 v2 入口或人工处理
		expect(readFileSync(path, "utf8")).toBe(upgraded);
	});

	test("缺参数启动：startWorkflow 抛 RECIPE_PARAM_MISSING 且不落任何卡", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		await expect(startWorkflow(recipe, {}, driverOptions())).rejects.toMatchObject({
			code: "RECIPE_PARAM_MISSING",
		});
	});

	test("查流只读聚合：清单缺失时从卡标记重建视图", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		await tickWorkflow(recipe, options);

		// 清单在：状态从卡现读
		const live = queryWorkflow(recipe, options);
		expect(live.nodes.map((node) => [node.name, node.card_no, node.status])).toEqual([
			["澄清", "卡0001", "delivered"],
			["侦察", "卡0002", "unclaimed"],
			["规划", undefined, "未落卡"],
		]);

		// 清单丢：从卡正文标记重建（内存视图，不落盘），说明里亮明
		unlinkSync(manifestPath(recipe, options));
		const rebuilt = queryWorkflow(recipe, options);
		expect(rebuilt.note).toContain("重建");
		expect(rebuilt.nodes.find((node) => node.name === "侦察")!.card_no).toBe("卡0002");
		expect(existsSync(manifestPath(recipe, options))).toBe(false);
		expect(rebuildEntriesFromCards(recipe, cardsDir)).toHaveLength(2);
	});

	test("推流未启动的流报 FLOW_NOT_STARTED；渲染报告为中文文本", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		await expect(tickWorkflow(recipe, driverOptions())).rejects.toMatchObject({ code: "FLOW_NOT_STARTED" });

		const report = await startWorkflow(recipe, { 仓库: "pao" }, driverOptions());
		const text = renderReport(report);
		expect(text).toContain("工作流「三步流」状态：running");
		expect(text).toContain("本次落卡：澄清→卡0001");
		expect(text).toContain("节点进度：");
		// 二批图形化：进度条行＋树形连接符节点行（末节点 └─;审查补齐 未落卡→○ 无裸行）
		expect(text).toContain("进度 ────────── 0/3");
		expect(text).toContain("└─ ○ 规划：未落卡（未落卡）");
	});

	test("启动入口校验流名：名字带空格的配方对象拒绝启动（RECIPE_FIELD）", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = { ...loadRecipe(paoHome, "三步流"), 名字: "带 空格" };
		await expect(startWorkflow(recipe, { 仓库: "pao" }, driverOptions())).rejects.toMatchObject({
			code: "RECIPE_FIELD",
		});
	});

	test("单卡文件缺失：查流不炸，该卡标读取异常，其余卡与整体查询照常", async () => {
		writeRecipe("三步流", threeStepFlow);
		const recipe = loadRecipe(paoHome, "三步流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		await tickWorkflow(recipe, options);
		const missingCard = listCards(cardsDir).find((card) => card.card_no === 1)!;
		unlinkSync(missingCard.path);

		const report = queryWorkflow(recipe, options);
		const clarify = report.nodes.find((node) => node.name === "澄清")!;
		expect(clarify.status).toBe("读取异常");
		expect(clarify.hold).toContain("读取失败");
		expect(report.nodes.find((node) => node.name === "侦察")!.card_no).toBe("卡0002");
		expect(report.note).toContain("读取失败");
		expect(report.status).toBe("hold");

		// 推流同样不炸：读取异常节点不落卡，流如实挂起
		const tick = await tickWorkflow(recipe, options);
		expect(tick.created_cards).toEqual([]);
		expect(tick.status).toBe("hold");
	});

	test("中途异常（非取消）：已建卡与清单映射一致保留，异常如实上抛", async () => {
		writeRecipe(
			"双开流",
			`---\n名字: 双开流\n节点:\n  - 名字: 甲\n    部门: 规划部\n    目标: 甲活\n    验收: 甲落盘\n  - 名字: 乙\n    部门: 规划部\n    目标: 乙活\n    验收: 乙落盘\n---\n`,
		);
		const recipe = loadRecipe(paoHome, "双开流");
		const originalWrite = writeFileAtomic;
		const writes = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, text) => {
			if (String(text).includes("/节点=乙 -->")) throw new Error("盘满：乙的流标记写失败");
			originalWrite(path, text);
		});
		await expect(startWorkflow(recipe, {}, driverOptions())).rejects.toThrowError("盘满");
		writes.mockRestore();

		// 甲乙两张卡都实际存在，清单映射都有登记——复盘/查流不丢乙
		expect(listCards(cardsDir).map((card) => card.card_no)).toEqual([1, 2]);
		const manifest = parseManifest(readFileSync(manifestPath(recipe, driverOptions()), "utf8"));
		expect(manifest.节点.map((entry) => [entry.名字, entry.卡号])).toEqual([
			["甲", "卡0001"],
			["乙", "卡0002"],
		]);
		const report = queryWorkflow(recipe, driverOptions());
		expect(report.nodes.find((node) => node.name === "乙")!.card_no).toBe("卡0002");
	});

	test("叫人去重记录（§23 toast②）：键按结构化门节点、落盘跨实例读回、确认点头即清", async () => {
		writeRecipe("中门流", midGateFlow);
		const recipe = loadRecipe(paoHome, "中门流");
		const options = driverOptions();
		await startWorkflow(recipe, { 仓库: "pao" }, options);
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		await tickWorkflow(recipe, options); // 落复核卡
		advanceCard(2, "in_progress");
		advanceCard(2, "delivered");
		const gated = await tickWorkflow(recipe, options); // 复核门挂起

		// 键＝结构化主判据（挂起=等待人工确认 的节点），门换节点键就换
		expect(suspendCallHumanKey(gated)).toBe("门:复核");
		expect(suspendCallHumanKey(gated, "无关停因")).toBe("门:复核");

		const key = suspendCallHumanKey(gated)!;
		expect(humanCalled(recipe, options, key)).toBe(false);
		recordCalledHuman(recipe, options, key);
		recordCalledHuman(recipe, options, key); // 同键幂等，不重复写
		expect(humanCalled(recipe, options, key)).toBe(true);
		// 盘上状态（模拟重启后全新读清单）：叫人键持久化在实例清单 frontmatter
		expect(parseManifest(readFileSync(manifestPath(recipe, options), "utf8")).叫人).toBe("门:复核");

		// 确认点头即清记录：同一个人工门确认后再挂起要允许重新叫人
		await confirmWorkflowNode(recipe, "复核", options);
		expect(humanCalled(recipe, options, key)).toBe(false);
		expect(parseManifest(readFileSync(manifestPath(recipe, options), "utf8")).叫人).toBeUndefined();
	});
});
