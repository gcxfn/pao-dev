import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import {
	createCard,
	listCardTemplates,
	loadCardBodyTemplate,
	readCard,
	resolveCardTemplatePath,
} from "../../src/pao/cards/cardfile.ts";
import { isPaoCardError } from "../../src/pao/cards/errors.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";

/**
 * M2-09 件3 卡模板库：建卡「模板」参数把已批准模板（pao配置/卡模板/）的正文骨架带进新卡。
 * 模板文件本身用临时夹具建，不依赖使用现场（使用现场与开发仓是两个仓库）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** 临时 PAO_HOME：pao配置/卡模板/ 下放两块测试模板——侦察 带 frontmatter（测剥壳），巡库 纯正文。 */
function makeTemplateHome(): { home: string; templateDir: string } {
	const home = tempDir("pao-tmpl-home-");
	const templateDir = join(home, "pao配置", "卡模板");
	mkdirSync(templateDir, { recursive: true });
	writeFileSync(
		join(templateDir, "侦察.md"),
		["---", "名字: 侦察", "---", "", "## 目标", "侦察目标示例", "", "## 机械验收", "- 存在: 产物/侦察.md", ""].join(
			"\n",
		),
		"utf8",
	);
	writeFileSync(join(templateDir, "巡库.md"), ["## 目标", "巡库目标示例", ""].join("\n"), "utf8");
	return { home, templateDir: templateDir };
}

function makeCardsDir(): string {
	const cardDir = join(tempDir("pao-tmpl-cards-"), "任务", "卡");
	mkdirSync(cardDir, { recursive: true });
	return cardDir;
}

const createCardInput = {
	目标: "带模板的卡",
	部门: "核心机制",
	验收: "存在: 产物/x.md",
	创建: "2026-10-02 22:00",
};

/** 工具参数面（pao_create_card 英文键；createCard 直调仍走上面的中文内码面） */
const toolCardInput = {
	goal: "带模板的卡",
	dept: "核心机制",
	acceptance: "存在: 产物/x.md",
};

// ── 纯函数：模板路径解析与正文提取 ─────────────────────────────────────────

describe("resolveCardTemplatePath 模板参数解析", () => {
	test("名字查找 <PAO_HOME>/pao配置/卡模板/<名>.md；带 .md 后缀不双写", () => {
		const { home, templateDir } = makeTemplateHome();
		const expected = join(templateDir, "侦察.md");
		expect(resolveCardTemplatePath("侦察", home)).toBe(expected);
		expect(resolveCardTemplatePath("侦察.md", home)).toBe(expected);
	});

	test("缺 PAO_HOME 时只收绝对路径：给名字结构化报错，不静默降级为无模板", () => {
		expect(() => resolveCardTemplatePath("侦察")).toThrow(/只收绝对路径/);
		expect(() => resolveCardTemplatePath("侦察", "  ")).toThrow(/只收绝对路径/);
	});

	test("绝对路径直接用；不存在报 CARD_NOT_FOUND", () => {
		const { templateDir } = makeTemplateHome();
		const path = join(templateDir, "侦察.md");
		expect(resolveCardTemplatePath(path, undefined)).toBe(path);
		try {
			resolveCardTemplatePath(join(templateDir, "不存在.md"));
			expect.unreachable("应报错");
		} catch (error) {
			expect(isPaoCardError(error)).toBe(true);
			expect((error as Error).message).toContain("找不到卡模板");
		}
	});

	test("名字找不到报错并列出现有模板名，不让人猜", () => {
		const { home } = makeTemplateHome();
		expect(() => resolveCardTemplatePath("不存在", home)).toThrow(/找不到卡模板.*可用：侦察、巡库/s);
	});

	test("空模板参数报 INVALID_CARD", () => {
		expect(() => resolveCardTemplatePath("   ")).toThrow(/模板参数为空/);
	});
});

describe("loadCardBodyTemplate / listCardTemplates", () => {
	test("模板带 frontmatter 只取正文（卡 frontmatter 仍由建卡流程生成）；纯正文原样返回", () => {
		const { templateDir } = makeTemplateHome();
		const reconBody = loadCardBodyTemplate(join(templateDir, "侦察.md"));
		expect(reconBody).toContain("侦察目标示例");
		expect(reconBody).not.toContain("名字: 侦察");
		expect(reconBody).not.toMatch(/^---/);
		expect(loadCardBodyTemplate(join(templateDir, "巡库.md"))).toContain("巡库目标示例");
	});

	test("模板目录不存在视为空清单；存在时列名排序", () => {
		expect(listCardTemplates(join(tempDir("pao-tmpl-none-"), "没有"))).toEqual([]);
		const { templateDir } = makeTemplateHome();
		expect(listCardTemplates(templateDir)).toEqual(["侦察", "巡库"]);
	});
});

// ── createCard 模板正文入参 ───────────────────────────────────────────────

describe("createCard 模板正文", () => {
	test("模板正文插入新卡正文，frontmatter 仍由 input 生成，卡文件只有一块 frontmatter", async () => {
		const cardDir = makeCardsDir();
		const card = await createCard(cardDir, createCardInput, { 模板正文: "## 目标\n模板骨架内容\n" });
		// 正文经 frontmatter 解析往返（parseFrontmatter 会 trim 尾部空白）
		expect(card.body).toBe("## 目标\n模板骨架内容");
		const reread = readCard(card.path);
		expect(reread.frontmatter.status).toBe("unclaimed");
		expect(reread.frontmatter.acceptance).toBe(createCardInput.验收);
		const raw = readFileSync(card.path, "utf8");
		expect(raw.match(/^---$/gm)).toHaveLength(2); // 一块 frontmatter 的开合两行
		expect(raw).toContain("模板骨架内容");
	});

	test("模板正文空白视为坏模板：结构化报错不静默", async () => {
		const cardDir = makeCardsDir();
		await expect(createCard(cardDir, createCardInput, { 模板正文: "  \n\t" })).rejects.toThrow(/模板正文为空/);
	});

	test("不给模板：正文为空（回归基线不变）", async () => {
		const cardDir = makeCardsDir();
		const card = await createCard(cardDir, createCardInput);
		expect(card.body.trim()).toBe("");
	});
});

// ── pao_create_card「模板」参数工具透传 ──────────────────────────────────────────

interface RegisteredTool {
	name: string;
	description: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

function setup(options?: Parameters<typeof registerCardTools>[1]) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	registerCardTools(pi, options);
	return tools;
}

async function runTool(tool: RegisteredTool, params: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("test-call", params);
	return result.content.map((part) => part.text).join("\n");
}

describe("pao_create_card「模板」参数", () => {
	test("模板名经 resolvePaoHome 解析：正文骨架进卡，frontmatter 验收字段不受模板影响", async () => {
		const { home } = makeTemplateHome();
		const cardDir = makeCardsDir();
		const tools = setup({ resolveCardsDir: () => cardDir, resolvePaoHome: () => home });
		const text = await runTool(tools.get("pao_create_card")!, {
			...toolCardInput,
			cards_dir: cardDir,
			template: "侦察",
		});
		expect(text).toContain("正文带模板「侦察」骨架");
		const card = readCard(join(cardDir, "卡0001-带模板的卡.md"));
		expect(card.body).toContain("侦察目标示例");
		expect(card.body).toContain("存在: 产物/侦察.md");
		expect(card.frontmatter.acceptance).toBe(toolCardInput.acceptance); // 验收字段来自参数，模板不动信封
	});

	test("模板绝对路径直接生效", async () => {
		const { templateDir } = makeTemplateHome();
		const cardDir = makeCardsDir();
		const tools = setup({ resolveCardsDir: () => cardDir });
		await runTool(tools.get("pao_create_card")!, {
			...toolCardInput,
			cards_dir: cardDir,
			template: join(templateDir, "巡库.md"),
		});
		expect(readCard(join(cardDir, "卡0001-带模板的卡.md")).body).toContain("巡库目标示例");
	});

	test("未知模板名报错列可用清单；未配置 resolvePaoHome 时给名字报只收绝对路径", async () => {
		const { home } = makeTemplateHome();
		const cardDir = makeCardsDir();
		const tools = setup({ resolveCardsDir: () => cardDir, resolvePaoHome: () => home });
		await expect(
			runTool(tools.get("pao_create_card")!, { ...toolCardInput, cards_dir: cardDir, template: "没有的" }),
		).rejects.toThrow(/找不到卡模板.*可用：侦察、巡库/s);
		const noHomeTool = setup({ resolveCardsDir: () => cardDir });
		await expect(
			runTool(noHomeTool.get("pao_create_card")!, { ...toolCardInput, cards_dir: cardDir, template: "侦察" }),
		).rejects.toThrow(/只收绝对路径/);
		// resolvePaoHome 抛错（如环境未配置 PAO_HOME）同样落在「只收绝对路径」，不静默
		const throwingTool = setup({
			resolveCardsDir: () => cardDir,
			resolvePaoHome: () => {
				throw new Error("缺少环境变量 PAO_HOME");
			},
		});
		await expect(
			runTool(throwingTool.get("pao_create_card")!, { ...toolCardInput, cards_dir: cardDir, template: "侦察" }),
		).rejects.toThrow(/只收绝对路径/);
	});
});
