/**
 * §19 交付唤醒单测：就绪扫描纯函数（findUnlockedCards/renderUnlockNotice）、
 * /队列「就绪」高亮（§19 通道②）、落已交付后的内联已解锁提示
 * （§19 通道①：pao_change_status 与 pao_verify_card 自动交付两落点）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { projectRootForCards } from "../../src/pao/cards/cardfile.ts";
import { renderQueue } from "../../src/pao/cards/render.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";
import type { QueueCardView } from "../../src/pao/cards/types.ts";
import { registerVerifierTools } from "../../src/pao/cards/verifier.ts";
import type { WakeupCardView } from "../../src/pao/cards/wakeup.ts";
import { findUnlockedCards, renderUnlockNotice } from "../../src/pao/cards/wakeup.ts";

// ============================================================================
// 纯函数
// ============================================================================

function scan(partial: Partial<WakeupCardView> & { card_no: number }): WakeupCardView {
	return { goal: `卡${partial.card_no}目标`, status: "unclaimed", depends_on: [], ...partial };
}

describe("findUnlockedCards 就绪扫描（§19 口径）", () => {
	test("上游全已交付＋下游待认领有依赖 → 就绪；按卡号升序", () => {
		const unlocked = findUnlockedCards([
			scan({ card_no: 3, depends_on: ["卡#1"] }),
			scan({ card_no: 1, status: "delivered", depends_on: ["卡#9"] }),
			scan({ card_no: 9, status: "delivered" }),
			scan({ card_no: 2, depends_on: ["卡#9", "卡#1"] }),
		]);
		expect(unlocked).toEqual([
			{ card_no: 2, goal: "卡2目标" },
			{ card_no: 3, goal: "卡3目标" },
		]);
	});

	test("上游进行中/失败/取消 → 不就绪（放行只认已交付）", () => {
		for (const status of ["in_progress", "failed", "canceled"] as const) {
			const unlocked = findUnlockedCards([
				scan({ card_no: 1, status: status }),
				scan({ card_no: 2, depends_on: ["卡#1"] }),
			]);
			expect(unlocked).toEqual([]);
		}
	});

	test("依赖卡不在本次视图（跨队列/不存在）→ 保守不就绪", () => {
		expect(findUnlockedCards([scan({ card_no: 2, depends_on: ["卡#77"] })])).toEqual([]);
	});

	test("无依赖的待认领卡不标（建卡即可派，标了只有噪音）；非待认领不标", () => {
		expect(findUnlockedCards([scan({ card_no: 1 }), scan({ card_no: 2 })])).toEqual([]);
		expect(
			findUnlockedCards([
				scan({ card_no: 1, status: "delivered" }),
				scan({ card_no: 2, status: "in_progress", depends_on: ["卡#1"] }),
			]),
		).toEqual([]);
	});

	test("renderUnlockNotice：空 → undefined（零噪音）；有 → 单行含卡号与目标", () => {
		expect(renderUnlockNotice([])).toBeUndefined();
		const text = renderUnlockNotice([
			{ card_no: 7, goal: "写文档" },
			{ card_no: 8, goal: "" },
		]);
		expect(text).toContain("[交付唤醒 §19] 已解锁 2 张可派");
		expect(text).toContain("卡0007 写文档");
		expect(text).toContain("卡0008");
		expect(text).toContain("待认领");
	});
});

// ============================================================================
// /队列 就绪高亮（§19 通道②）
// ============================================================================

function view(partial: Partial<QueueCardView> & { card_no: number }): QueueCardView {
	return {
		goal: `卡${partial.card_no}的目标`,
		status: "unclaimed",
		priority: "medium",
		created: "2026-10-03 12:00",
		depends_on: [],
		pending_review: false,
		...partial,
	};
}

describe("renderQueue「就绪」高亮（§19 通道②）", () => {
	test("待认领且依赖全满足 → 标 [就绪]；依赖未满足与无依赖不标", () => {
		const text = renderQueue([
			view({ card_no: 1, status: "delivered" }),
			view({ card_no: 2, depends_on: ["卡#1"] }),
			view({ card_no: 3, depends_on: ["卡#1", "卡#9"] }),
			view({ card_no: 4 }),
		]);
		expect(text).toMatch(/卡0002 [^\n]*\[就绪\]/);
		expect(text.split("\n").find((l) => l.includes("卡0003 "))).not.toContain("就绪");
		expect(text.split("\n").find((l) => l.includes("卡0004 "))).not.toContain("就绪");
	});

	test("零行为回归：无待认领依赖满足时渲染与既有口径一致（无「就绪」字样）", () => {
		const text = renderQueue([
			view({ card_no: 1, status: "in_progress" }),
			view({ card_no: 2, depends_on: ["卡#1"] }),
		]);
		expect(text).not.toContain("就绪");
	});
});

// ============================================================================
// 通道①：落已交付工具的内联提示（pao_change_status / pao_verify_card 自动交付）
// ============================================================================

interface RegisteredTool {
	name: string;
	execute: (id: string, params: any) => Promise<{ content: { type: string; text: string }[] }>;
}

function capturePi() {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	return { tools, pi };
}

function makeCardsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-wakeup-"));
	// 协议任务工作区布局 .pao/<任务>/卡（cardfile.projectRootForCards 以 .pao 层定位项目根）
	const cardsDir = join(dir, ".pao", "任务-20261003", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

async function runTool(tool: RegisteredTool | undefined, params: Record<string, unknown>): Promise<string> {
	if (!tool) throw new Error("工具未注册");
	const result = await tool.execute("test-call", params);
	return result.content.map((part) => part.text).join("\n");
}

describe("通道①：pao_change_status 落已交付 → 内联已解锁提示", () => {
	test("上游交付瞬间下游就绪：返回文本带 [交付唤醒]；无就绪下游时零噪音", async () => {
		const cardsDir = makeCardsDir();
		const { tools, pi } = capturePi();
		registerCardTools(pi, {});
		const makeCard = tools.get("pao_create_card")!;
		await runTool(makeCard, {
			cards_dir: cardsDir,
			goal: "上游活",
			dept: "测试",
			acceptance: "存在: 上游.txt",
			depends_on: [],
		});
		await runTool(makeCard, {
			cards_dir: cardsDir,
			goal: "下游活",
			dept: "测试",
			acceptance: "存在: 下游.txt",
			depends_on: ["卡#1"],
		});
		const changeStatus = tools.get("pao_change_status")!;
		// 待认领 → 进行中（owner 认领）：此步不提示（未到已交付）
		const claimText = await runTool(changeStatus, {
			cards_dir: cardsDir,
			card_ref: 1,
			operator: "主控",
			new_status: "in_progress",
		});
		expect(claimText).not.toContain("交付唤醒");
		// 无 execution-context 的常规卡仍检查真实成果，缺文件时拒绝；完成成果后再交付。
		await expect(runTool(changeStatus, {
			cards_dir: cardsDir, card_ref: 1, operator: "主控", new_status: "delivered",
		})).rejects.toThrow(/机械验收/);
		writeFileSync(join(projectRootForCards(cardsDir), "上游.txt"), "上游成果\n");
		// 进行中 → 已交付：下游卡2 依赖满足 → 内联提示
		const deliverText = await runTool(changeStatus, {
			cards_dir: cardsDir,
			card_ref: 1,
			operator: "主控",
			new_status: "delivered",
		});
		expect(deliverText).toContain("delivered");
		expect(deliverText).toContain("[交付唤醒 §19] 已解锁 1 张可派");
		expect(deliverText).toContain("卡0002 下游活");
		// 交付无下游的卡（卡2 已在待认领但无依赖孙卡）：零噪音
		const claim2 = await runTool(changeStatus, {
			cards_dir: cardsDir,
			card_ref: 2,
			operator: "主控",
			new_status: "in_progress",
		});
		expect(claim2).not.toContain("交付唤醒");
		writeFileSync(join(projectRootForCards(cardsDir), "下游.txt"), "下游成果\n");
		const deliver2 = await runTool(changeStatus, {
			cards_dir: cardsDir,
			card_ref: 2,
			operator: "主控",
			new_status: "delivered",
		});
		expect(deliver2).not.toContain("交付唤醒");
	});
});

describe("通道①：pao_verify_card 机械全过自动交付 → 内联已解锁提示", () => {
	test("自动落已交付时提示下游就绪卡", async () => {
		const cardsDir = makeCardsDir();
		const { tools, pi } = capturePi();
		registerCardTools(pi, {});
		registerVerifierTools(pi, { resolveCardsDir: () => cardsDir });
		const makeCard = tools.get("pao_create_card")!;
		// 上游卡：机械验收句式（存在:），需认领后产物真实存在才全过
		await runTool(makeCard, {
			cards_dir: cardsDir,
			goal: "上游机械活",
			dept: "测试",
			acceptance: "存在: 产物.txt",
			depends_on: [],
		});
		await runTool(makeCard, {
			cards_dir: cardsDir,
			goal: "下游活",
			dept: "测试",
			acceptance: "存在: 下游.txt",
			depends_on: ["卡#1"],
		});
		const changeStatus = tools.get("pao_change_status")!;
		await runTool(changeStatus, { cards_dir: cardsDir, card_ref: 1, operator: "主控", new_status: "in_progress" });
		// 存在: 句式相对项目根——任务布局 .pao/<任务>/卡 的项目根 = .pao 上一级（即临时根）
		const projectRoot = join(cardsDir, "..", "..", "..");
		writeFileSync(join(projectRoot, "产物.txt"), "上游交付物", "utf8");
		const acceptance = tools.get("pao_verify_card")!;
		const text = await runTool(acceptance, { card_ref: 1, operator: "主控" });
		expect(text).toContain("全过自动交付");
		expect(text).toContain("[交付唤醒 §19]");
		expect(text).toContain("卡0002 下游活");
	});
});
