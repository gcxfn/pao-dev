/**
 * §11.6 按需技能挂载单测（十八批,T02 后解释正本归 workflow/dispatch-context）:
 * 卡面工作流标记→配方节点「技能」声明→resolveWorkflowDispatch 派前解析→
 * resolveDispatchParameters 与部门配方技能合并。fail-closed 三族:配方缺/节点缺/技能文件缺
 * 一律拒派;无标记卡零行为。fixture 一律临时目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cardFileName, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import type { CardFrontmatter } from "../../src/pao/cards/types.ts";
import { resolveDispatchParameters } from "../../src/pao/worker/dispatch-core.ts";
import { resolveWorkflowDispatch } from "../../src/pao/workflow/dispatch-context.ts";
import { workflowMarker } from "../../src/pao/workflow/driver.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-flow-skills-"));
	tempDirs.push(dir);
	return dir;
}

const RECIPE = [
	"---",
	'名字: "挂技能流"',
	"自动执行: false",
	"参数: []",
	"节点:",
	'  - 名字: "评审"',
	'    目标: "a"',
	'    部门: "审查"',
	'    验收: "包含: a"',
	'    技能: ["对抗审查"]',
	"    depends_on: []",
	"    人工确认: false",
	'  - 名字: "无技能"',
	'    目标: "b"',
	'    部门: "审查"',
	'    验收: "包含: b"',
	"    depends_on: []",
	"    人工确认: false",
	"---",
	"说明",
].join("\n");

function setup(): { paoHome: string; cardsDir: string } {
	const paoHome = makeDir();
	const cardsDir = makeDir();
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
	writeFileSync(join(paoHome, "工作流", "挂技能流.md"), RECIPE, "utf8");
	// 部门配方带一个技能,与节点技能不同名——验证合并（配方.md 是列表行格式,recipeField 按行正则解析）
	mkdirSync(join(paoHome, "部门", "审查"), { recursive: true });
	writeFileSync(join(paoHome, "部门", "审查", "配方.md"), "# 审查部\n\n- skills: 常驻审查\n", "utf8");
	mkdirSync(join(paoHome, "pao配置", "skills", "常驻审查"), { recursive: true });
	writeFileSync(join(paoHome, "pao配置", "skills", "常驻审查", "SKILL.md"), "x", "utf8");
	return { paoHome, cardsDir };
}

function writeCardWithMarker(
	cardsDir: string,
	cardNo: number,
	goal: string,
	marker: string | undefined,
	frontmatter: Partial<CardFrontmatter> & Pick<CardFrontmatter, "goal" | "dept" | "acceptance">,
): void {
	const body = marker ? `${marker}\n\n正文` : "正文";
	writeFileSync(
		join(cardsDir, cardFileName(cardNo, goal)),
		serializeCard({ attempt: 1, created: "2026-10-03 10:00", status: "unclaimed", ...frontmatter }, body),
		"utf8",
	);
}

function readParams(cardsDir: string, cardNo: number) {
	return readCard(join(cardsDir, cardFileName(cardNo, "评审")));
}

describe("工作流派发解释与按需技能挂载", () => {
	it("标记卡→配方节点技能自动挂载,经 dispatch-core 与部门配方技能合并去重", () => {
		const { paoHome, cardsDir } = setup();
		mkdirSync(join(paoHome, "pao配置", "skills", "对抗审查"), { recursive: true });
		writeFileSync(join(paoHome, "pao配置", "skills", "对抗审查", "SKILL.md"), "x", "utf8");
		// S5 包2:仓内工作流声明的技能须经本地允许清单确认（pao配置/skills/允许清单.json）才挂载
		writeFileSync(join(paoHome, "pao配置", "skills", "允许清单.json"), '["对抗审查"]\n', "utf8");
		writeCardWithMarker(cardsDir, 1, "评审", workflowMarker("挂技能流", "评审"), {
			goal: "a",
			dept: "审查",
			acceptance: "包含: a",
		});
		const card = readParams(cardsDir, 1);
		const workflow = resolveWorkflowDispatch(card, { cardsDir, paoHome });
		expect(workflow?.skills).toEqual([join(paoHome, "pao配置", "skills", "对抗审查")]);
		const resolved = resolveDispatchParameters(card, cardsDir, paoHome, workflow?.skills);
		expect(resolved.skills).toEqual([
			join(paoHome, "pao配置", "skills", "常驻审查"),
			join(paoHome, "pao配置", "skills", "对抗审查"),
		]);
	});

	it("技能文件缺→拒派 fail-closed（点名节点与技能）", () => {
		const { paoHome, cardsDir } = setup(); // 不建 对抗审查/
		writeCardWithMarker(cardsDir, 1, "评审", workflowMarker("挂技能流", "评审"), {
			goal: "a",
			dept: "审查",
			acceptance: "包含: a",
		});
		expect(() => resolveWorkflowDispatch(readParams(cardsDir, 1), { cardsDir, paoHome })).toThrow(/节点技能不存在/);
	});

	it("配方缺（标记指向不存在的流）→拒派;节点缺→拒派", () => {
		const { paoHome, cardsDir } = setup();
		writeCardWithMarker(cardsDir, 1, "评审", workflowMarker("已删流", "评审"), {
			goal: "a",
			dept: "审查",
			acceptance: "包含: a",
		});
		expect(() => resolveWorkflowDispatch(readParams(cardsDir, 1), { cardsDir, paoHome })).toThrow(/已删流/);
		writeCardWithMarker(cardsDir, 2, "评审", workflowMarker("挂技能流", "不存在的节点"), {
			goal: "a",
			dept: "审查",
			acceptance: "包含: a",
		});
		expect(() => resolveWorkflowDispatch(readParams(cardsDir, 2), { cardsDir, paoHome })).toThrow(/没有节点/);
	});

	it("无标记卡零行为（解析返回 undefined,平常零挂载——只有部门配方技能）", () => {
		const { paoHome, cardsDir } = setup();
		writeCardWithMarker(cardsDir, 1, "评审", undefined, { goal: "a", dept: "审查", acceptance: "包含: a" });
		const card = readParams(cardsDir, 1);
		expect(resolveWorkflowDispatch(card, { cardsDir, paoHome })).toBeUndefined();
		expect(resolveDispatchParameters(card, cardsDir, paoHome).skills).toEqual([
			join(paoHome, "pao配置", "skills", "常驻审查"),
		]);
	});

	it("标记指向未声明技能的节点→只有部门配方技能,不报错", () => {
		const { paoHome, cardsDir } = setup();
		writeCardWithMarker(cardsDir, 1, "评审", workflowMarker("挂技能流", "无技能"), {
			goal: "b",
			dept: "审查",
			acceptance: "包含: b",
		});
		const card = readParams(cardsDir, 1);
		const workflow = resolveWorkflowDispatch(card, { cardsDir, paoHome });
		const resolved = resolveDispatchParameters(card, cardsDir, paoHome, workflow?.skills);
		expect(resolved.skills).toEqual([join(paoHome, "pao配置", "skills", "常驻审查")]);
	});
});
