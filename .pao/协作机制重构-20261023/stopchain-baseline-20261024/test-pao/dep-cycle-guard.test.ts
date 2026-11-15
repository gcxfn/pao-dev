/**
 * 依赖环防呆（用户拍板 2026-10-03「/派 加依赖环防呆」的落地修正）：
 * /派 语法不带依赖、直派卡恒无 depends_on——结构性产生不了环；环的真实来源是
 * ①带依赖的建卡逐步累积（B 依赖 A、再把 A 改回依赖 B）②手工编辑卡文件③历史遗留。
 * 防呆落两处：pao_create_card 带依赖时拦「上游在含未交付卡的环中」；pao_change_status 依赖闸
 * 阻塞时点名环成员（不再以"上游进行中"表象让人死等）。
 * 全已交付的历史环放行（M2-02 定案：只拒死等不翻旧账）两条路径都要保持。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard, loadCard } from "../../src/pao/cards/index.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-dep-cycle-"));
	tempDirs.push(dir);
	return dir;
}

function tempCardsDir(): string {
	const cardsDir = join(tempDir(), "pao", "task", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

interface Captured {
	tools: {
		name: string;
		execute: (...args: unknown[]) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
	}[];
}

function setupTools(cardsDir: string): Captured["tools"] {
	const tools: Captured["tools"] = [];
	const pi = {
		registerTool: (tool: { name: string }) => tools.push(tool as never),
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	registerCardTools(pi, { resolveCardsDir: () => cardsDir });
	return tools;
}

function toolOf(tools: Captured["tools"], name: string): Captured["tools"][number] {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`未注册 ${name}`);
	return tool;
}

/** 执行并取文本;工具把校验失败 throw 出去(pao 惯例:Error 消息即用户面),捕获后返回消息文本 */
async function textOf(tool: Captured["tools"][number], params: unknown): Promise<string> {
	try {
		const result = await tool.execute("t", params, undefined);
		return result.content.map((c) => c.text ?? "").join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** 手工把一张卡改成依赖指定卡（模拟编辑卡文件/历史遗留——环的真实来源） */
function manuallyEditDeps(cardsDir: string, fileName: string, depends_on: string[]): void {
	const path = join(cardsDir, fileName);
	const text = readFileSync(path, "utf8");
	const patched = text.replace(/^depends_on:.*$/m, `depends_on: [${depends_on.join(", ")}]`);
	if (patched === text && !text.includes("depends_on:")) {
		throw new Error("手改失败:卡文件无 depends_on 行");
	}
	writeFileSync(path, patched, "utf8");
}

describe("依赖环防呆·pao_create_card", () => {
	it("上游在含未交付卡的环中：拒建并报环成员", async () => {
		const cardsDir = tempCardsDir();
		await createCard(cardsDir, {
			目标: "A",
			部门: "测试",
			验收: "完成",
			depends_on: ["卡2"],
			创建: "2026-10-03 12:00",
		});
		await createCard(cardsDir, {
			目标: "B",
			部门: "测试",
			验收: "完成",
			depends_on: ["卡1"],
			创建: "2026-10-03 12:00",
		});
		const tools = setupTools(cardsDir);
		const text = await textOf(toolOf(tools, "pao_create_card"), {
			goal: "C",
			dept: "测试",
			acceptance: "完成",
			depends_on: ["卡1"],
		});
		expect(text).toContain("依赖环防呆");
		expect(text).toContain("卡0001");
		expect(text).toContain("拒建");
	});

	it("无环依赖照常建卡（防呆零误伤）", async () => {
		const cardsDir = tempCardsDir();
		await createCard(cardsDir, { 目标: "A", 部门: "测试", 验收: "完成", 创建: "2026-10-03 12:00" });
		const tools = setupTools(cardsDir);
		const text = await textOf(toolOf(tools, "pao_create_card"), {
			goal: "B",
			dept: "测试",
			acceptance: "完成",
			depends_on: ["卡1"],
		});
		expect(text).toContain("已建卡");
		expect(text).not.toContain("依赖环");
	});

	it("全已交付的历史环：放行不翻旧账（M2-02 定案）", async () => {
		const cardsDir = tempCardsDir();
		const a = await createCard(cardsDir, {
			目标: "A",
			部门: "测试",
			验收: "完成",
			depends_on: ["卡2"],
			创建: "2026-10-03 12:00",
		});
		const b = await createCard(cardsDir, {
			目标: "B",
			部门: "测试",
			验收: "完成",
			depends_on: ["卡1"],
			创建: "2026-10-03 12:00",
		});
		// 手工交付两卡（绕状态机,模拟历史环:建卡时互不存在,后手改成的环,如今全交付）
		for (const card of [a, b]) {
			const path = join(cardsDir, card.filename);
			writeFileSync(path, readFileSync(path, "utf8").replace(/^status:.*$/m, "status: delivered"), "utf8");
		}
		const tools = setupTools(cardsDir);
		const text = await textOf(toolOf(tools, "pao_create_card"), {
			goal: "C",
			dept: "测试",
			acceptance: "完成",
			depends_on: ["卡1"],
		});
		expect(text).toContain("已建卡");
	});
});

describe("依赖环防呆·pao_change_status 依赖闸", () => {
	it("环内卡启动：报环名而非『依赖未放行』表象", async () => {
		const cardsDir = tempCardsDir();
		const a = await createCard(cardsDir, { 目标: "A", 部门: "测试", 验收: "完成", 创建: "2026-10-03 12:00" });
		const b = await createCard(cardsDir, { 目标: "B", 部门: "测试", 验收: "完成", 创建: "2026-10-03 12:00" });
		manuallyEditDeps(cardsDir, a.filename, ["卡2"]);
		manuallyEditDeps(cardsDir, b.filename, ["卡1"]);
		const tools = setupTools(cardsDir);
		const text = await textOf(toolOf(tools, "pao_change_status"), {
			card_ref: 1,
			new_status: "in_progress",
			operator: "主控",
		});
		expect(text).toContain("依赖环");
		expect(text).toContain("卡0001");
		expect(text).toContain("死锁");
		expect(loadCard(cardsDir, 1).frontmatter.status).toBe("unclaimed"); // 未被启动
	});

	it("普通未交付阻塞照旧报依赖未放行（非环不点名）", async () => {
		const cardsDir = tempCardsDir();
		await createCard(cardsDir, { 目标: "A", 部门: "测试", 验收: "完成", 创建: "2026-10-03 12:00" });
		await createCard(cardsDir, {
			目标: "B",
			部门: "测试",
			验收: "完成",
			depends_on: ["卡1"],
			创建: "2026-10-03 12:00",
		});
		const tools = setupTools(cardsDir);
		const text = await textOf(toolOf(tools, "pao_change_status"), {
			card_ref: 2,
			new_status: "in_progress",
			operator: "主控",
		});
		expect(text).toContain("依赖未放行");
		expect(text).toContain("unclaimed");
		expect(text).not.toContain("依赖环");
	});
});
