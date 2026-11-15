/**
 * 工作流生成路单测（十七批,2026-10-03「走完一次存配方」拍板）:
 * 蒸馏（pao_save_flow的机械核）——逐字提取、依赖卡号→节点名映射、卡树成环拒绝、
 * 外部依赖拒绝、空目录如实报错、非卡文件点名不静默;发射器特殊字符 roundtrip;
 * 落盘（pao_write_recipe的机械核）——校验不过零改动、同名拒绝、覆盖备份、坏名字拒绝、
 * 目录代建;蒸馏→落盘→loadRecipe 全链 roundtrip。fixture 一律临时目录。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cardFileName, serializeCard, serializeReceipt } from "../../src/pao/cards/cardfile.ts";
import type { CardFrontmatter } from "../../src/pao/cards/types.ts";
import { distillRecipe, emitRecipeMarkdown, saveRecipe } from "../../src/pao/workflow/distill.ts";
import {
	deleteRecipe,
	isWorkflowRecipeError,
	loadRecipe,
	parseRecipe,
	recipePath,
} from "../../src/pao/workflow/recipe.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-flow-save-"));
	tempDirs.push(dir);
	return dir;
}

function card(
	cardsDir: string,
	cardNo: number,
	goal: string,
	frontmatter: Partial<CardFrontmatter> & Pick<CardFrontmatter, "goal" | "dept" | "acceptance">,
): void {
	const full: CardFrontmatter = {
		attempt: 0,
		created: "2026-10-03 10:00",
		status: "delivered",
		...frontmatter,
	};
	writeFileSync(join(cardsDir, cardFileName(cardNo, goal)), serializeCard(full, ""), "utf8");
}

function distillCode(fn: () => unknown): { code: string; message: string } {
	try {
		fn();
	} catch (error) {
		if (isWorkflowRecipeError(error)) return { code: error.code, message: error.message };
		return { code: "非配方错", message: error instanceof Error ? error.message : String(error) };
	}
	throw new Error("期望抛错但没有");
}

describe("蒸馏（pao_save_flow机械核）", () => {
	it("链＋分叉卡目录→草稿:逐字提取、节点名去卡号前缀、依赖映射、人工确认全 false", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "侦察地图", { goal: "扫仓库产地图", dept: "侦察", acceptance: "存在: 地图.md" });
		card(cardsDir, 2, "改前端", {
			goal: "按地图改页面",
			dept: "前端",
			acceptance: "存在: 页面.md",
			depends_on: ["卡1"],
		});
		card(cardsDir, 3, "写文档", { goal: "写使用说明", dept: "文档", acceptance: "存在: 说明.md", depends_on: ["1"] });
		writeFileSync(join(cardsDir, "readme.md"), "非卡文件", "utf8");

		const result = distillRecipe(cardsDir, "新项目开工", "20261003-170000");
		expect(result.cardCount).toBe(3);
		expect(result.edgeCount).toBe(2);
		expect(result.skipped).toEqual(["readme.md"]);

		const recipe = parseRecipe(result.content, join("工作流", "新项目开工.md"));
		expect(recipe.名字).toBe("新项目开工");
		expect(recipe.自动执行).toBe(false);
		expect(recipe.参数).toEqual([]);
		expect(recipe.节点.map((node) => node.名字).sort()).toEqual(["侦察地图", "写文档", "改前端"]);
		// 逐字:目标原样进节点（含标点）,依赖两种引用形态（卡1/1）都映射为节点名
		const frontend = recipe.节点.find((node) => node.名字 === "改前端")!;
		expect(frontend.目标).toBe("按地图改页面");
		expect(frontend.depends_on).toEqual(["侦察地图"]);
		expect(recipe.节点.every((node) => node.人工确认 === false)).toBe(true);
		expect(recipe.说明).toContain("逐字提取");
		expect(recipe.说明).toContain("人工确认」未检测");
	});

	it("可选字段（输入/约束/档位/预算/优先级）逐字随行,含特殊字符的串 roundtrip 不坏", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "特种卡", {
			goal: '含:冒号 与"引号" 还有\\反斜杠',
			dept: "前端",
			acceptance: "包含: done",
			constraints: "不许: 动别的",
			inputs: ["docs/地图.md", "docs/需求.md"],
			tier: "fast",
			budget: { turns: 20, toolCalls: 100 },
			priority: "high",
		});
		const { content } = distillRecipe(cardsDir, "特殊字符流", "20261003-170001");
		const recipe = parseRecipe(content, join("工作流", "特殊字符流.md"));
		const node = recipe.节点[0];
		expect(node.目标).toBe('含:冒号 与"引号" 还有\\反斜杠');
		expect(node.约束).toBe("不许: 动别的");
		expect(node.输入).toEqual(["docs/地图.md", "docs/需求.md"]);
		expect(node.档位).toBe("fast");
		expect(node.预算).toEqual({ turns: 20, toolCalls: 100 });
		expect(node.优先级).toBe("high");
	});

	it("依赖成环→拒绝出稿（RECIPE_CYCLE,报环成员）", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "甲", { goal: "甲", dept: "前端", acceptance: "包含: 甲", depends_on: ["卡2"] });
		card(cardsDir, 2, "乙", { goal: "乙", dept: "前端", acceptance: "包含: 乙", depends_on: ["卡1"] });
		const error = distillCode(() => distillRecipe(cardsDir, "环流", "20261003-170002"));
		expect(error.code).toBe("RECIPE_CYCLE");
		expect(error.message).toContain("环");
	});

	it("依赖指向目录外卡号→拒绝（蒸馏只收目录内卡链）", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "甲", { goal: "甲", dept: "前端", acceptance: "包含: 甲", depends_on: ["9"] });
		const error = distillCode(() => distillRecipe(cardsDir, "外依流", "20261003-170003"));
		expect(error.code).toBe("RECIPE_DEP_UNKNOWN");
		expect(error.message).toContain("不在本卡目录");
	});

	it("空目录/全是非卡文件→如实报错不产草稿,坏文件名进 details.跳过", () => {
		const empty = makeDir();
		expect(distillCode(() => distillRecipe(empty, "空流", "t")).code).toBe("RECIPE_FIELD");
		const junk = makeDir();
		writeFileSync(join(junk, "随便.md"), "x", "utf8");
		try {
			distillRecipe(junk, "垃圾流", "t");
		} catch (error) {
			expect(isWorkflowRecipeError(error)).toBe(true);
			if (isWorkflowRecipeError(error)) {
				expect(error.code).toBe("RECIPE_FIELD");
				expect(error.message).toContain("没有可蒸馏的有效卡");
				expect(error.message).toContain("已点名");
				expect(error.details.跳过).toEqual(["随便.md"]);
			}
			return;
		}
		throw new Error("期望抛错但没有");
	});

	it("撞名节点退回含卡号全名保唯一（先来者保净名）;坏卡点名跳过", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "同名", { goal: "第一个", dept: "前端", acceptance: "包含: 一" });
		card(cardsDir, 2, "同名", { goal: "第二个", dept: "前端", acceptance: "包含: 二", depends_on: ["卡1"] });
		writeFileSync(join(cardsDir, cardFileName(3, "坏卡")), "---\n不是映射\n---\n", "utf8");
		const result = distillRecipe(cardsDir, "撞名流", "t");
		expect(result.cardCount).toBe(2);
		expect(result.skipped.length).toBe(1);
		expect(result.skipped[0]).toContain("坏卡");
		const recipe = parseRecipe(result.content, join("工作流", "撞名流.md"));
		// 卡1 先到保净名「同名」,卡2 撞名退回含卡号全名;依赖映射跟着退回名走
		expect(recipe.节点.map((node) => node.名字).sort()).toEqual(["卡0002-同名", "同名"]);
		const second = recipe.节点.find((node) => node.名字 === "卡0002-同名")!;
		expect(second.depends_on).toEqual(["同名"]);
	});
});

describe("落盘（pao_write_recipe机械核）", () => {
	function draftContent(): string {
		return emitRecipeMarkdown({
			名字: "存盘流",
			自动执行: false,
			参数: [],
			节点: [
				{
					名字: "侦察",
					目标: "扫仓库",
					部门: "侦察",
					验收: "存在: 地图.md",
					depends_on: [],
					人工确认: false,
				},
			],
			说明: "## 使用说明\n试跑。",
		});
	}

	it("校验过→原子落盘→loadRecipe 读回全通;目录不存在代建", () => {
		const paoHome = makeDir();
		const result = saveRecipe(paoHome, "存盘流", draftContent(), { 备份时间: "20261003-170004" });
		expect(result.路径).toBe(recipePath(paoHome, "存盘流"));
		expect(result.节点数).toBe(1);
		expect(existsSync(result.路径)).toBe(true);
		const recipe = loadRecipe(paoHome, "存盘流");
		expect(recipe.拓扑序).toEqual(["侦察"]);
	});

	it("校验不过零改动:成环内容拒绝且目录不建、文件不落", () => {
		const paoHome = makeDir();
		const bad = emitRecipeMarkdown({
			名字: "环流",
			自动执行: false,
			参数: [],
			节点: [
				{ 名字: "甲", 目标: "a", 部门: "前端", 验收: "包含: a", depends_on: ["乙"], 人工确认: false },
				{ 名字: "乙", 目标: "b", 部门: "前端", 验收: "包含: b", depends_on: ["甲"], 人工确认: false },
			],
			说明: "x",
		});
		const error = distillCode(() => saveRecipe(paoHome, "环流", bad, { 备份时间: "t" }));
		expect(error.code).toBe("RECIPE_CYCLE");
		expect(existsSync(join(paoHome, "工作流"))).toBe(false);
	});

	it("frontmatter 名字与文件名不一致→拒绝", () => {
		const paoHome = makeDir();
		const mismatch = draftContent().replace('名字: "存盘流"', '名字: "另一个名"');
		const error = distillCode(() => saveRecipe(paoHome, "存盘流", mismatch, { 备份时间: "t" }));
		expect(error.code).toBe("RECIPE_FIELD");
		expect(error.message).toContain("不一致");
	});

	it("同名默认拒绝;覆盖:true 先备份旧字节再写新", () => {
		const paoHome = makeDir();
		saveRecipe(paoHome, "存盘流", draftContent(), { 备份时间: "20261003-170005" });
		const v2 = draftContent().replace("扫仓库", "扫仓库v2");
		expect(() => saveRecipe(paoHome, "存盘流", v2, { 备份时间: "20261003-170006" })).toThrow(/已存在/);
		const result = saveRecipe(paoHome, "存盘流", v2, { 覆盖: true, 备份时间: "20261003-170007" });
		expect(result.备份).toBeTruthy();
		expect(readFileSync(result.备份!, "utf8")).not.toContain("扫仓库v2");
		expect(readFileSync(result.路径, "utf8")).toContain("扫仓库v2");
	});

	it("坏名字（空/路径分隔/点名字/超长）拒绝", () => {
		const paoHome = makeDir();
		const content = draftContent();
		for (const bad of ["", "  ", "a/b", "a\\b", "..", ".", `${"长".repeat(65)}`]) {
			expect(() => saveRecipe(paoHome, bad, content, { 备份时间: "t" })).toThrow(/配方名/);
		}
	});

	it("全链 roundtrip:蒸馏→落盘→loadRecipe→拓扑序与依赖保持", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "侦察地图", { goal: "扫仓库产地图", dept: "侦察", acceptance: "存在: 地图.md" });
		card(cardsDir, 2, "改前端", {
			goal: "按地图改页面",
			dept: "前端",
			acceptance: "存在: 页面.md",
			depends_on: ["卡1"],
		});
		const paoHome = makeDir();
		const distilled = distillRecipe(cardsDir, "全链流", "20261003-170008");
		// 审改步（模拟）:目标参数化——把可变处换 {仓库} 并声明参数,再落盘
		const reviewed = distilled.content
			.replace("扫仓库产地图", "扫 {仓库} 产地图")
			.replace("按地图改页面", "按地图改 {仓库} 页面")
			.replace("参数: []", '参数: ["仓库"]');
		saveRecipe(paoHome, "全链流", reviewed, { 备份时间: "20261003-170009" });
		const recipe = loadRecipe(paoHome, "全链流");
		expect(recipe.参数).toEqual(["仓库"]);
		expect(recipe.占位符).toEqual(["仓库"]);
		expect(recipe.拓扑序).toEqual(["侦察地图", "改前端"]);
		const frontend = recipe.节点.find((node) => node.名字 === "改前端")!;
		expect(frontend.depends_on).toEqual(["侦察地图"]);
	});
});

describe("删除配方（/pao recipe-del机械核）", () => {
	function draftContent(): string {
		return emitRecipeMarkdown({
			名字: "存盘流",
			自动执行: false,
			参数: [],
			节点: [
				{
					名字: "侦察",
					目标: "扫仓库",
					部门: "侦察",
					验收: "存在: 地图.md",
					depends_on: [],
					人工确认: false,
				},
			],
			说明: "## 使用说明\n试跑。",
		});
	}

	it("存在→删除 <名字>.md 本体,回显名字与路径;同名 .bak 备份保留不动", () => {
		const paoHome = makeDir();
		const result = saveRecipe(paoHome, "存盘流", draftContent(), { 备份时间: "20261003-170011" });
		const saved2 = saveRecipe(paoHome, "存盘流", draftContent().replace("扫仓库", "扫仓库v2"), {
			覆盖: true,
			备份时间: "20261003-170012",
		});
		expect(saved2.备份).toBeTruthy();

		const deleted = deleteRecipe(paoHome, "存盘流");
		expect(deleted).toEqual({ 名字: "存盘流", 路径: recipePath(paoHome, "存盘流") });
		expect(existsSync(deleted.路径)).toBe(false);
		// .bak 留着不动：删错的兜底
		expect(existsSync(saved2.备份!)).toBe(true);
		expect(existsSync(result.路径)).toBe(false);
	});

	it("名字不存在→RECIPE_NOT_FOUND 报错（fail-closed,不猜）,报可用配方", () => {
		const paoHome = makeDir();
		saveRecipe(paoHome, "别的流", draftContent().replace("存盘流", "别的流"), { 备份时间: "t" });
		const error = distillCode(() => deleteRecipe(paoHome, "存盘流"));
		expect(error.code).toBe("RECIPE_NOT_FOUND");
		expect(error.message).toContain("未删除");
		expect(error.message).toContain("别的流");
	});

	it("坏名字（空/路径分隔/点名字）在删除前拒绝（RECIPE_FIELD,杜绝穿越）", () => {
		const paoHome = makeDir();
		for (const bad of ["", "  ", "a/b", "a\\b", "..", "."]) {
			expect(() => deleteRecipe(paoHome, bad)).toThrow(/配方名/);
		}
		// 拒绝发生在拼路径之前：越界目标不会被误删
		expect(existsSync(join(paoHome, "工作流"))).toBe(false);
	});
});

describe("蒸馏说明与注册面", () => {
	it("蒸馏说明带来源/时间/两段提醒;自动执行缺省 false 记档在说明", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "单卡", { goal: "a", dept: "前端", acceptance: "包含: a" });
		const { content } = distillRecipe(cardsDir, "说明流", "20261003-170010");
		expect(content).toContain("卡目录");
		expect(content).toContain("20261003-170010");
		expect(content).toContain("参数化");
		expect(content).toContain("自动执行缺省 false");
	});

	it("空节点目录不做目录探测副作用（emitRecipeMarkdown 只产文本）", () => {
		const content = emitRecipeMarkdown({
			名字: "纯发射",
			自动执行: false,
			参数: [],
			节点: [{ 名字: "甲", 目标: "a", 部门: "前端", 验收: "包含: a", depends_on: [], 人工确认: true }],
			说明: "x",
		});
		expect(content).toContain("人工确认: true");
		expect(content.startsWith("---\n")).toBe(true);
	});
});

describe("蒸馏增强（十八批,§11.6）", () => {
	it("卡树:parent（协作母卡）映射为依赖边,与 depends_on 合并去重", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "母卡", { goal: "拆活", dept: "主控", acceptance: "包含: 拆" });
		// 卡2 只挂 parent 不写 depends_on——蒸馏应补出依赖边
		card(cardsDir, 2, "子活", {
			goal: "干活",
			dept: "前端",
			acceptance: "包含: 活",
			parent: "卡1",
			depends_on: ["卡1"],
		});
		const result = distillRecipe(cardsDir, "卡树流", "t");
		expect(result.edgeCount).toBe(1); // parent 与 depends_on 指同一卡 → 去重为一条
		const recipe = parseRecipe(result.content, join("工作流", "卡树流.md"));
		const childAlive = recipe.节点.find((node) => node.名字 === "子活")!;
		expect(childAlive.depends_on).toEqual(["母卡"]);
	});

	it("实施记录:每卡末次成功回执的摘要＋产物进说明,失败回执不进", () => {
		const cardsDir = makeDir();
		const body = [
			serializeReceipt({
				card_no: 1,
				attempt: 1,
				time: "2026-10-03 10:20",
				result: "failed",
				failure_type: "transient",
			}),
			serializeReceipt({
				card_no: 1,
				attempt: 2,
				time: "2026-10-03 10:40",
				result: "success",
				summary: "按地图改完页面",
				artifact_path: ["docs/页面.md"],
			}),
		].join("\n\n");
		writeFileSync(
			join(cardsDir, cardFileName(1, "改前端")),
			serializeCard(
				{
					goal: "改页面",
					dept: "前端",
					acceptance: "包含: 页",
					attempt: 2,
					created: "2026-10-03 10:00",
					status: "delivered",
				},
				body,
			),
			"utf8",
		);
		const { content } = distillRecipe(cardsDir, "回执流", "t");
		expect(content).toContain("## 实施记录");
		expect(content).toContain("改前端:按地图改完页面（产物:docs/页面.md）");
	});

	it("部门经验:任务窗内知识库新增条目点名（mtime 口径）,窗外不进", () => {
		const cardsDir = makeDir();
		card(cardsDir, 1, "侦察", {
			goal: "扫仓库",
			dept: "前端",
			acceptance: "包含: 扫",
			created: "2026-10-03 10:00",
			completed: "2026-10-03 12:00",
		});
		const paoHome = makeDir();
		const kb = join(paoHome, "部门", "前端", "知识库", "教训");
		mkdirSync(kb, { recursive: true });
		const inWindow = join(kb, "窗内教训.md");
		const outWindow = join(kb, "窗外旧账.md");
		writeFileSync(inWindow, "x", "utf8");
		writeFileSync(outWindow, "x", "utf8");
		const t = (h: number) => new Date(2026, 9, 3, h, 0).getTime(); // 月从 0 计:9=10月
		utimesSync(inWindow, new Date(t(11)), new Date(t(11)));
		utimesSync(outWindow, new Date(t(8)), new Date(t(8)));
		const { content } = distillRecipe(cardsDir, "经验流", "t", paoHome);
		expect(content).toContain("## 部门经验");
		expect(content).toContain("前端/知识库/教训/窗内教训.md");
		expect(content).not.toContain("窗外旧账");
		// 不给 paoHome → 整段不出（不猜路径）
		const bare = distillRecipe(cardsDir, "经验流2", "t").content;
		expect(bare).not.toContain("## 部门经验");
	});

	it("配方「技能」字段可解析（按需挂载声明面）;蒸馏不产技能字段（人工审时加）", () => {
		const recipeText = [
			"---",
			'名字: "挂技能流"',
			"自动执行: false",
			"参数: []",
			"节点:",
			'  - 名字: "侦察"',
			'    目标: "a"',
			'    部门: "前端"',
			'    验收: "包含: a"',
			'    技能: ["代码评审", "测试编写"]',
			"    depends_on: []",
			"    人工确认: false",
			"---",
			"说明",
		].join("\n");
		const recipe = parseRecipe(recipeText, join("工作流", "挂技能流.md"));
		expect(recipe.节点[0].技能).toEqual(["代码评审", "测试编写"]);
		// 蒸馏侧:卡目录出来的草稿不含「技能:」行——技能是起草/审时的人工声明,不从卡猜
		const cardsDir = makeDir();
		card(cardsDir, 1, "侦察", { goal: "a", dept: "前端", acceptance: "包含: a" });
		expect(distillRecipe(cardsDir, "无技能流", "t").content).not.toContain("技能:");
	});
});
