/**
 * 工作流复盘机械报告单测（十八批,§11.6 跑后复盘闭环）:
 * 从卡与回执现读——尝试/派发/打回/末次失败类型/末次成功摘要/产物/人工门/预算vs实耗;
 * 拓扑序含未落卡节点、孤儿卡点名不静默、汇总回执不重复计、缺用量标未知不填零。
 * fixture 一律临时目录。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cardFileName, serializeCard, serializeReceipt } from "../../src/pao/cards/cardfile.ts";
import type { CardFrontmatter } from "../../src/pao/cards/types.ts";
import { type WorkflowManifest, workflowMarker } from "../../src/pao/workflow/driver.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { buildReviewReport, renderReviewReport } from "../../src/pao/workflow/review.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-flow-review-"));
	tempDirs.push(dir);
	return dir;
}

function writeCard(
	cardsDir: string,
	cardNo: number,
	goal: string,
	frontmatter: Partial<CardFrontmatter> & Pick<CardFrontmatter, "goal" | "dept" | "acceptance">,
	body: string,
): void {
	writeFileSync(
		join(cardsDir, cardFileName(cardNo, goal)),
		serializeCard({ attempt: 0, created: "2026-10-03 10:00", status: "delivered", ...frontmatter }, body),
		"utf8",
	);
}

const RECIPE_TEXT = [
	"---",
	'名字: "复盘流"',
	"自动执行: false",
	"参数: []",
	"节点:",
	'  - 名字: "侦察"',
	'    目标: "扫仓库"',
	'    部门: "侦察"',
	'    验收: "包含: 扫"',
	'    预算: { "turns": 20, "toolCalls": 100 }',
	"    depends_on: []",
	"    人工确认: false",
	'  - 名字: "文档"',
	'    目标: "写文档"',
	'    部门: "文档"',
	'    验收: "包含: 文档"',
	'    depends_on: ["侦察"]',
	"    人工确认: true",
	'  - 名字: "未跑"',
	'    目标: "兜底"',
	'    部门: "前端"',
	'    验收: "包含: 兜"',
	'    depends_on: ["文档"]',
	"    人工确认: false",
	"---",
	"说明",
].join("\n");

function manifest(): WorkflowManifest {
	return {
		工作流: "复盘流",
		卡目录: "unused",
		启动: "2026-10-03 10:00",
		状态: "已完成",
		参数: {},
		节点: [
			{ 名字: "侦察", 卡号: "0001" },
			{ 名字: "文档", 卡号: "0002", 确认: "2026-10-03 11:30" },
		],
	};
}

describe("buildReviewReport / renderReviewReport", () => {
	it("每节点行:尝试重试/派发/打回失败类型/末次摘要/产物/人工门/预算vs实耗;未落卡如实列出", () => {
		const cardsDir = makeDir();
		writeCard(
			cardsDir,
			1,
			"侦察",
			{ goal: "扫仓库", dept: "侦察", acceptance: "包含: 扫", attempt: 2 },
			[
				workflowMarker("复盘流", "侦察"),
				serializeReceipt({
					card_no: 1,
					attempt: 1,
					time: "2026-10-03 10:20",
					result: "failed",
					failure_type: "transient",
					summary: "第一次挂了",
				}),
				serializeReceipt({
					card_no: 1,
					attempt: 2,
					time: "2026-10-03 10:40",
					result: "success",
					summary: "产出了地图",
					artifact_path: ["docs/地图.md"],
					usage: { turns: 8, toolCalls: 40, cost: 0.1 },
				}),
			].join("\n\n"),
		);
		writeCard(
			cardsDir,
			2,
			"文档",
			{ goal: "写文档", dept: "文档", acceptance: "包含: 文档", attempt: 1 },
			[
				workflowMarker("复盘流", "文档"),
				serializeReceipt({
					card_no: 2,
					attempt: 1,
					time: "2026-10-03 11:00",
					result: "success",
					summary: "写完使用说明",
					artifact_path: ["docs/使用.md"],
					usage: { 来源: "汇总", turns: 8, toolCalls: 40 }, // 汇总行不重复计
				}),
			].join("\n\n"),
		);
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const report = buildReviewReport(recipe, cardsDir, manifest());

		expect(report.实例状态).toBe("已完成");
		expect(report.节点.map((row) => row.节点)).toEqual(["侦察", "文档", "未跑"]);
		const recon = report.节点[0];
		expect(recon.尝试).toBe(2);
		expect(recon.派发次数).toBe(2);
		expect(recon.打回).toBe(1);
		expect(recon.末次失败类型).toBe("transient");
		expect(recon.末次成功摘要).toBe("产出了地图");
		expect(recon.产物).toEqual(["docs/地图.md"]);
		expect(recon.预算).toEqual({ turns: 20, toolCalls: 100 });
		expect(recon.实耗).toEqual({ turns: 8, toolCalls: 40, cost: 0.1, 未知: false });
		const doc = report.节点[1];
		expect(doc.人工确认).toBe(true);
		expect(doc.已确认).toBe("2026-10-03 11:30");
		expect(doc.实耗).toEqual({ turns: 0, toolCalls: 0, cost: 0, 未知: false }); // 汇总行跳过
		const notRun = report.节点[2];
		expect(notRun.尝试).toBe(0);
		expect(notRun.产物).toEqual([]);

		const text = renderReviewReport(report);
		expect(text).toContain("复盘（机械报告）");
		expect(text).toContain("尝试2（重试1）");
		expect(text).toContain("打回1(transient)");
		expect(text).toContain("未落卡");
		expect(text).toContain("20轮/100次 | 8轮/40次/$0.10");
		expect(text).toContain("总账:节点 3、尝试 3、派发 3、打回 1");
		expect(text).toContain("pao_write_recipe");
	});

	it("孤儿卡（标记的节点不在配方）点名不静默;缺用量标未知不填零", () => {
		const cardsDir = makeDir();
		writeCard(
			cardsDir,
			5,
			"旧节点",
			{ goal: "已被删", dept: "前端", acceptance: "包含: 删", attempt: 1, status: "failed" },
			`${workflowMarker("复盘流", "已删节点")}\n\n${serializeReceipt({
				card_no: 5,
				attempt: 1,
				time: "2026-10-03 10:20",
				result: "success",
				usage: { turns: 3 }, // 缺 toolCalls/cost
			})}`,
		);
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const report = buildReviewReport(recipe, cardsDir, undefined);
		expect(report.孤儿卡).toEqual([{ 卡号: 5, 节点: "已删节点", 卡状态: "failed" }]);
		const text = renderReviewReport(report);
		expect(text).toContain("孤儿卡");
		expect(text).toContain("已删节点");
		expect(report.实例状态).toBeUndefined();
		expect(text).toContain("（清单缺失）");
		// 缺用量不填零:孤儿卡不进节点行（配方已删该节点）,其用量只在孤儿点名里呈现,不进总账
		expect(report.节点.every((row) => row.卡号 !== 5)).toBe(true);
	});

	it("别的流的卡不串台（marker 流名不匹配即忽略）", () => {
		const cardsDir = makeDir();
		writeCard(
			cardsDir,
			1,
			"外卡",
			{ goal: "别家", dept: "前端", acceptance: "包含: 别", attempt: 1 },
			`${workflowMarker("别的流", "侦察")}\n\n正文`,
		);
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const report = buildReviewReport(recipe, cardsDir, undefined);
		expect(report.节点.every((row) => row.卡号 === undefined)).toBe(true);
		expect(report.孤儿卡).toEqual([]);
	});

	it("回执「值得沉淀」进结晶判定段（借鉴①:复盘环节显式判定,零新真相源）", () => {
		const cardsDir = makeDir();
		writeCard(
			cardsDir,
			3,
			"沉淀",
			{ goal: "跑测试", dept: "测试", acceptance: "包含: 通过", attempt: 1 },
			`${workflowMarker("复盘流", "侦察")}\n\n${serializeReceipt({
				card_no: 3,
				attempt: 1,
				time: "2026-10-03 10:30",
				result: "success",
				summary: "定向跑完",
				worth_distilling: "先跑定向再跑全量",
			})}`,
		);
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const report = buildReviewReport(recipe, cardsDir, undefined);
		expect(report.结晶候选).toEqual([
			{ 卡号: 3, 节点: "侦察", 值得沉淀: "先跑定向再跑全量", 出处: "卡0003 回执 2026-10-03 10:30" },
		]);
		const text = renderReviewReport(report);
		expect(text).toContain("结晶判定");
		expect(text).toContain("卡0003·侦察：先跑定向再跑全量");
		expect(text).toContain("静默丢弃＝违规");
		expect(text.indexOf("结晶判定")).toBeLessThan(text.indexOf("下一步:"));
	});

	it("无「值得沉淀」也显式判定为未结晶（复盘报告必须出声,不是漏看）", () => {
		const cardsDir = makeDir();
		writeCard(
			cardsDir,
			4,
			"平淡",
			{ goal: "跑测试", dept: "测试", acceptance: "包含: 通过", attempt: 1 },
			`${workflowMarker("复盘流", "侦察")}\n\n${serializeReceipt({
				card_no: 4,
				attempt: 1,
				time: "2026-10-03 10:40",
				result: "success",
				summary: "定向跑完",
			})}`,
		);
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const report = buildReviewReport(recipe, cardsDir, undefined);
		expect(report.结晶候选).toEqual([]);
		expect(renderReviewReport(report)).toContain("未结晶出做法");
	});
});
