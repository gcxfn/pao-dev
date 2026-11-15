import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { renderAllQueues, renderQueue } from "../../src/pao/cards/render.ts";
import type { QueueCardView } from "../../src/pao/cards/types.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-render-"));
	tempDirs.push(dir);
	return dir;
}

/** 单个项目的 PAO_HOME：项目清单 + <项目根>/.pao/卡（平布局，与 /队列 统计同源） */
function setupProject(projectName: string): { home: string; cardsDir: string } {
	const home = tempDir();
	const projectRoot = tempDir();
	const cardsDir = join(projectRoot, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	writeFileSync(
		join(home, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| ${projectName} | ${projectRoot} | 2026-10-03 10:00 | 2026-10-03 10:00 |\n`,
		"utf8",
	);
	return { home, cardsDir };
}

function view(partial: Partial<QueueCardView> & { card_no: number; goal?: string }): QueueCardView {
	return {
		goal: `卡${partial.card_no}的目标`,
		status: "unclaimed",
		priority: "medium",
		created: "2026-10-02 21:00",
		depends_on: [],
		pending_review: false,
		...partial,
	};
}

describe("renderQueue 渲染契约（§2.2）", () => {
	test("空队列提示", () => {
		expect(renderQueue([])).toContain("队列为空");
	});

	test("分组按状态，组序固定：待认领/进行中/失败/已交付/取消", () => {
		const text = renderQueue([
			view({ card_no: 1, status: "delivered" }),
			view({ card_no: 2, status: "canceled" }),
			view({ card_no: 3, status: "failed" }),
			view({ card_no: 4, status: "in_progress" }),
			view({ card_no: 5, status: "unclaimed" }),
		]);
		const order = ["unclaimed（1）", "in_progress（1）", "failed（1）", "delivered（1）", "canceled（1）"].map((h) =>
			text.indexOf(h),
		);
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("活卡排序 = 优先级降序 + 创建升序（顶卡即下一个要派的）", () => {
		const text = renderQueue([
			view({ card_no: 1, priority: "high", created: "2026-10-02 21:30" }),
			view({ card_no: 2, priority: "high", created: "2026-10-02 21:00" }),
			view({ card_no: 3, priority: "low", created: "2026-10-02 20:00" }),
			view({ card_no: 4, priority: "medium", created: "2026-10-02 22:00" }),
		]);
		const positions = [1, 2, 3, 4].map((n) => text.indexOf(`卡000${n} `));
		// 高-21:00(卡2) → 高-21:30(卡1) → 中(卡4) → 低(卡3)
		expect(positions[1]).toBeLessThan(positions[0]);
		expect(positions[0]).toBeLessThan(positions[3]);
		expect(positions[3]).toBeLessThan(positions[2]);
	});

	test("已交付组 = 完成时间倒序", () => {
		const text = renderQueue([
			view({ card_no: 1, status: "delivered", completed: "2026-10-02 21:00" }),
			view({ card_no: 2, status: "delivered", completed: "2026-10-02 23:00" }),
			view({ card_no: 3, status: "delivered", completed: "2026-10-02 22:00" }),
		]);
		const positions = [1, 2, 3].map((n) => text.indexOf(`卡000${n} `));
		// 卡2(23:00) → 卡3(22:00) → 卡1(21:00)
		expect(positions[1]).toBeLessThan(positions[2]);
		expect(positions[2]).toBeLessThan(positions[0]);
	});

	test("必显依赖边（带前置状态）与 parent 边；parent 不参与依赖判断", () => {
		const text = renderQueue([
			view({ card_no: 1, status: "delivered" }),
			view({ card_no: 2, status: "failed" }),
			view({ card_no: 3, depends_on: ["卡#1", "卡#2"], parent: "卡#1" }),
		]);
		expect(text).toContain("依赖: 卡0001(delivered)、卡0002(failed)");
		expect(text).toContain("父卡: 卡0001(delivered)");
		// 依赖边只由 depends_on 生成：卡3 未列卡2 为 parent 依赖之外的东西
		expect(text.match(/依赖:/g)).toHaveLength(1);
	});

	test("进行中且当前尝试已有回执 → 标「待审」", () => {
		const text = renderQueue([
			view({ card_no: 1, status: "in_progress", pending_review: true }),
			view({ card_no: 2, status: "in_progress", pending_review: false }),
		]);
		expect(text).toMatch(/卡0001 [^\n]*\[待审\]/);
		expect(text.split("\n").find((line) => line.includes("卡0002 "))).not.toContain("待审");
	});

	test("owner 显示：未认领标注", () => {
		const text = renderQueue([view({ card_no: 1 }), view({ card_no: 2, owner: "部长A" })]);
		expect(text).toContain("owner:未认领");
		expect(text).toContain("owner:部长A");
	});
});

describe("renderAllQueues 全局统计（审查第 5 项：坏卡不让数字冒充完整）", () => {
	test("坏卡不进状态计数，但要在行尾显式说明未计入", () => {
		const { home, cardsDir } = setupProject("项目甲");
		writeFileSync(join(cardsDir, "卡0009-坏卡.md"), "---\n目标: 坏卡\n---\n正文\n", "utf8");
		const text = renderAllQueues(home);
		expect(text).toContain("unclaimed 0");
		expect(text).toContain("另有 1 张卡读不出来，未计入以上数字");
	});

	test("没有坏卡时不加多余说明（保持原样）", () => {
		const { home } = setupProject("项目甲");
		const text = renderAllQueues(home);
		expect(text).toContain("unclaimed 0");
		expect(text).not.toContain("读不出来");
	});

	test("卡目录读失败仍是「不可达」，不当零任务", () => {
		const { home, cardsDir } = setupProject("项目甲");
		rmSync(cardsDir, { recursive: true, force: true });
		expect(renderAllQueues(home)).toContain("不可达");
	});
});
