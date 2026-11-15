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
import type { Decision, FlowControl } from "../../src/pao/workflow/control.ts";
import { type WorkflowManifest, workflowMarker } from "../../src/pao/workflow/driver.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { buildReviewReport, buildV2ReviewReport, renderReviewReport } from "../../src/pao/workflow/review.ts";

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
		// 打回逐轮列原因：复盘默认按轮次给出摘要，不让人翻原始回执。
		expect(recon.打回记录).toEqual([{ 尝试: 1, 失败类型: "transient", 摘要: "第一次挂了" }]);
		expect(recon.末次成功摘要).toBe("产出了地图");
		expect(recon.产物).toEqual(["docs/地图.md"]);
		expect(recon.预算).toEqual({ turns: 20, toolCalls: 100 });
		expect(recon.实耗).toEqual({ turns: 8, toolCalls: 40, cost: 0.1, 未知: true });
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
		expect(text).toContain("第 1 次尝试被打回（transient）：第一次挂了");
		expect(text).toContain("未落卡");
		expect(text).toContain("20轮/100次 | 8轮/40次/$0.10");
		expect(text).toContain("有缺账,已知下界");
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

	it("v2 按控制正本当前轮与历史轮卡引用隔离实例,同卡去重,汇总行不双计,缺 usage 不当完整零", () => {
		const cardsDir = makeDir();
		const writeV2Card = (cardNo: number, instance: string, round: number, attempt: number, receipts: string[]) =>
			writeCard(
				cardsDir,
				cardNo,
				"甲",
				{ goal: "甲活", dept: "测试", acceptance: "通过", attempt, status: "delivered" },
				[
					workflowMarker("复盘流", "侦察"),
					`<!-- pao-workflow-v2:实例=${instance}/轮次=${round} -->`,
					...receipts,
				].join("\n\n"),
			);
		const current = "instance-current";
		writeV2Card(1, current, 1, 2, [
			serializeReceipt({
				card_no: 1,
				attempt: 1,
				time: "2026-10-03 10:10",
				result: "failed",
				failure_type: "transient",
				summary: "第一轮打回",
				usage: { turns: 2, toolCalls: 3, cost: 0.2 },
			}),
			serializeReceipt({
				card_no: 1,
				attempt: 2,
				time: "2026-10-03 10:20",
				result: "success",
				summary: "重做后成功",
				artifact_path: ["docs/甲.md"],
				usage: { turns: 4, toolCalls: 5, cost: 0.3 },
			}),
		]);
		writeV2Card(2, current, 1, 1, [
			serializeReceipt({
				card_no: 2,
				attempt: 1,
				time: "2026-10-03 10:30",
				result: "success",
				summary: "第二工人成功",
				artifact_path: ["docs/乙.md"],
				usage: { turns: 1, toolCalls: 2, cost: 0.1 },
			}),
			serializeReceipt({
				card_no: 2,
				attempt: 1,
				time: "2026-10-03 10:31",
				result: "success",
				summary: "母卡汇总",
				usage: { 来源: "汇总", turns: 99, toolCalls: 99, cost: 99 },
			}),
		]);
		writeV2Card(3, current, 2, 1, [
			serializeReceipt({
				card_no: 3,
				attempt: 1,
				time: "2026-10-03 11:00",
				result: "success",
				summary: "缺失用量",
			}),
		]);
		// 同配方当前实例的另一张合法卡归到别的节点，不混入侦察节点。
		writeCard(
			cardsDir,
			4,
			"文档",
			{ goal: "写文档", dept: "文档", acceptance: "通过", attempt: 1, status: "delivered" },
			[
				workflowMarker("复盘流", "文档"),
				`<!-- pao-workflow-v2:实例=${current}/轮次=1 -->`,
				serializeReceipt({
					card_no: 4,
					attempt: 1,
					time: "2026-10-03 10:00",
					result: "success",
					summary: "文档节点成功",
					usage: { turns: 50, toolCalls: 50, cost: 50 },
				}),
			].join("\n\n"),
		);
		// 同实例当前轮的两张首试卡都应归入侦察节点；不能按尝试总和减一伪造重试。
		writeV2Card(5, current, 2, 1, [
			serializeReceipt({
				card_no: 5,
				attempt: 1,
				time: "2026-10-03 11:01",
				result: "success",
				summary: "缺失用量来源未知",
				usage: { 来源: "unknown", turns: 1, toolCalls: 1, cost: 0 },
			}),
		]);
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const decision: Decision = {
			结果: "change",
			理由: "补甲",
			失败轴: "card",
			引用: ["docs/甲.md:1"],
			目标: "侦察",
			时间: "2026-10-03 10:40",
		};
		const flow: FlowControl = {
			版本: 2,
			实例: current,
			owner: "owner",
			脉络: "脉络",
			工作流: "复盘流",
			卡目录: cardsDir,
			启动: "2026-10-03 09:00",
			状态: "已完成",
			冻结配方: recipe,
			参数: {},
			节点: [
				{
					名字: "侦察",
					轮次: 2,
					卡: ["0003", "0005"],
					拆解结束: true,
					历史: [{ 轮次: 1, 卡: ["0001", "0002", "0001"], 判定: decision, 原因: "第一轮打回" }],
				},
				{
					名字: "文档",
					轮次: 1,
					卡: ["0004"],
					拆解结束: true,
					历史: [],
				},
				{
					名字: "未跑",
					轮次: 1,
					卡: [],
					拆解结束: true,
					零卡理由: "未执行",
					历史: [],
				},
			],
			回边次数: { "侦察→侦察": 1 },
			记录: [{ 时间: "2026-10-03 12:00", 事件: "人工恢复", 理由: "复核后继续" }],
		};
		const report = buildV2ReviewReport(recipe, cardsDir, flow);
		const recon = report.节点.find((row) => row.节点 === "侦察")!;
		expect(recon.卡号列表).toEqual([1, 2, 3, 5]);
		expect(recon.卡号列表).not.toContain(4);
		expect(recon.派发次数).toBe(5); // 侦察 6 条非留档回执里，卡0002 的汇总回执不是派发
		expect(recon.打回记录.map((record) => record.尝试)).toEqual([1]);
		expect(recon.末次成功摘要).toBe("缺失用量来源未知");
		expect(recon.尝试).toBe(5);
		expect(recon.重试).toBe(1);
		expect(recon.打回).toBe(1);
		expect(recon.产物).toEqual(["docs/甲.md", "docs/乙.md"]);
		expect(recon.实耗).toEqual({ turns: 8, toolCalls: 11, cost: 0.6, 未知: true });
		expect(recon.实耗.turns).not.toBe(99);
		const doc = report.节点.find((row) => row.节点 === "文档")!;
		expect(doc.尝试).toBe(1);
		expect(doc.重试).toBe(0);
		expect(report.v2控制?.回边次数).toEqual({ "侦察→侦察": 1 });
		expect(report.v2控制?.记录).toEqual(flow.记录);
		expect(report.v2控制?.判定[0]?.历史).toEqual([{ 轮次: 1, 判定: decision, 原因: "第一轮打回" }]);
		const text = renderReviewReport(report);
		expect(text).toContain("派发5");
		expect(text).toContain("━ 侦察 | 卡0001、卡0002、卡0003、卡0005 | delivered | 尝试5（重试1）");
		expect(text).toContain("━ 文档 | 卡0004 | delivered | 尝试1（重试0）");
		expect(text).toContain("有缺账,已知下界");
		expect(text).toContain("总账:节点 3、尝试 6、派发 6、打回 1、重试 1。");
		expect(text).toContain("回边次数");
		expect(text).toContain("人工恢复");
	});

	it("v2 两张不同工人的首试卡合计尝试2但重试0,不能把尝试总和减一", () => {
		const cardsDir = makeDir();
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const instance = "two-workers";
		for (const cardNo of [1, 2]) {
			writeCard(
				cardsDir,
				cardNo,
				`侦察${cardNo}`,
				{
					goal: `扫仓库${cardNo}`,
					dept: "侦察",
					acceptance: "包含: 扫",
					attempt: 1,
					status: "delivered",
				},
				[
					workflowMarker("复盘流", "侦察"),
					`<!-- pao-workflow-v2:实例=${instance}/轮次=1 -->`,
					serializeReceipt({
						card_no: cardNo,
						attempt: 1,
						time: `2026-10-03 10:0${cardNo}`,
						result: "success",
						summary: `工人${cardNo}成功`,
						artifact_path: [`docs/工人${cardNo}.md`],
						usage: { turns: 1, toolCalls: 1, cost: 0 },
					}),
				].join("\n\n"),
			);
		}
		const flow: FlowControl = {
			版本: 2,
			实例: instance,
			owner: "owner",
			脉络: "two-workers",
			工作流: "复盘流",
			卡目录: cardsDir,
			启动: "2026-10-03 09:00",
			状态: "已完成",
			冻结配方: recipe,
			参数: {},
			节点: recipe.节点.map((node) => ({
				名字: node.名字,
				轮次: 1,
				卡: node.名字 === "侦察" ? ["0001", "0002"] : [],
				拆解结束: true,
				...(node.名字 === "侦察" ? {} : { 零卡理由: "未执行" }),
				历史: [],
			})),
			回边次数: {},
			记录: [],
		};
		const row = buildV2ReviewReport(recipe, cardsDir, flow).节点.find((item) => item.节点 === "侦察")!;
		expect(row.尝试).toBe(2);
		expect(row.重试).toBe(0);
		expect(row.派发次数).toBe(2);
		expect(row.打回).toBe(0);
		expect(renderReviewReport(buildV2ReviewReport(recipe, cardsDir, flow))).toContain(
			"━ 侦察 | 卡0001、卡0002 | delivered | 尝试2（重试0）",
		);
	});

	it("v2 同一尝试号的母卡汇总回执不重复计入派发/打回/成功摘要/产物;可用汇总不把数字铺回实耗", () => {
		const cardsDir = makeDir();
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const instance = "summary-receipt";
		writeCard(
			cardsDir,
			1,
			"多工人汇总",
			{ goal: "扫仓库", dept: "侦察", acceptance: "包含: 扫", attempt: 1, status: "delivered" },
			[
				workflowMarker("复盘流", "侦察"),
				`<!-- pao-workflow-v2:实例=${instance}/轮次=1 -->`,
				serializeReceipt({
					card_no: 1,
					attempt: 1,
					time: "2026-10-03 10:30",
					result: "success",
					summary: "真实工人成功",
					artifact_path: ["docs/真实.md"],
					usage: { turns: 2, toolCalls: 3, cost: 0.2 },
				}),
				serializeReceipt({
					card_no: 1,
					attempt: 1,
					time: "2026-10-03 10:31",
					result: "failed",
					failure_type: "transient",
					summary: "母卡汇总打回不应另算",
					artifact_path: ["docs/汇总.md"],
					usage: { 来源: "汇总", turns: 99, toolCalls: 99, cost: 99 },
				}),
				serializeReceipt({
					card_no: 1,
					attempt: 1,
					time: "2026-10-03 10:32",
					result: "success",
					summary: "母卡可用汇总",
					artifact_path: ["docs/汇总2.md"],
					usage: { 来源: "汇总", turns: 1, toolCalls: 1, cost: 0.1 },
				}),
			].join("\n\n"),
		);
		const flow: FlowControl = {
			版本: 2,
			实例: instance,
			owner: "owner",
			脉络: instance,
			工作流: "复盘流",
			卡目录: cardsDir,
			启动: "2026-10-03 09:00",
			状态: "已完成",
			冻结配方: recipe,
			参数: {},
			节点: recipe.节点.map((node) => ({
				名字: node.名字,
				轮次: 1,
				卡: node.名字 === "侦察" ? ["0001"] : [],
				拆解结束: true,
				...(node.名字 === "侦察" ? {} : { 零卡理由: "未执行" }),
				历史: [],
			})),
			回边次数: {},
			记录: [],
		};
		const row = buildV2ReviewReport(recipe, cardsDir, flow).节点.find((item) => item.节点 === "侦察")!;
		expect(row.派发次数).toBe(1);
		expect(row.打回).toBe(0);
		expect(row.末次成功摘要).toBe("真实工人成功");
		expect(row.产物).toEqual(["docs/真实.md"]);
		expect(row.实耗).toEqual({ turns: 2, toolCalls: 3, cost: 0.2, 未知: false });
	});

	it("v2 控制正本引用但未能读出卡时,报告行与总账明确标 CARD_NOT_FOUND 汇总不完整", () => {
		const cardsDir = makeDir();
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const instance = "missing-reference";
		writeCard(
			cardsDir,
			1,
			"扫仓库",
			{ goal: "扫仓库", dept: "侦察", acceptance: "包含: 扫", attempt: 1, status: "delivered" },
			[workflowMarker("复盘流", "侦察"), `<!-- pao-workflow-v2:实例=${instance}/轮次=2 -->`].join("\n\n"),
		);
		const flow: FlowControl = {
			版本: 2,
			实例: instance,
			owner: "owner",
			脉络: instance,
			工作流: "复盘流",
			卡目录: cardsDir,
			启动: "2026-10-03 09:00",
			状态: "已完成",
			冻结配方: recipe,
			参数: {},
			节点: [
				{
					名字: "侦察",
					轮次: 2,
					卡: ["0001"],
					拆解结束: true,
					历史: [{ 轮次: 1, 卡: ["9999"], 原因: "旧轮引用" }],
				},
				...recipe.节点.slice(1).map((node) => ({
					名字: node.名字,
					轮次: 1,
					卡: [] as string[],
					拆解结束: true,
					零卡理由: "未执行",
					历史: [],
				})),
			],
			回边次数: {},
			记录: [],
		};
		const report = buildV2ReviewReport(recipe, cardsDir, flow);
		expect(report.节点[0]?.缺失卡号列表).toEqual([9999]);
		expect(report.节点[0]?.实耗.未知).toBe(true);
		expect(report.v2控制?.缺失卡).toEqual([{ 节点: "侦察", 轮次: 1, 卡号: 9999 }]);
		const text = renderReviewReport(report);
		expect(text).toContain("━ 侦察 | 卡0001；缺卡卡9999（CARD_NOT_FOUND）");
		expect(text).toContain("$0.00（有缺账,已知下界）");
		expect(text).toContain(
			"总账:节点 3、尝试 1、派发 0、打回 0、重试 0；汇总不完整（CARD_NOT_FOUND）：缺失卡 1 张，控制引用未全部计入。",
		);
	});

	it("v2 多工人末次失败与成功按 receipt.time 排序,不按建卡数组最后一张猜", () => {
		const cardsDir = makeDir();
		const recipe = parseRecipe(RECIPE_TEXT, join("工作流", "复盘流.md"));
		const instance = "completion-time";
		// 先建卡0001，后建卡0002；但0001在10:59完成，0002在10:01完成。
		writeCard(
			cardsDir,
			1,
			"先建后完成",
			{ goal: "先建后完成", dept: "侦察", acceptance: "包含: 扫", attempt: 1, status: "delivered" },
			[
				workflowMarker("复盘流", "侦察"),
				`<!-- pao-workflow-v2:实例=${instance}/轮次=1 -->`,
				serializeReceipt({
					card_no: 1,
					attempt: 1,
					time: "2026-10-03 10:59",
					result: "failed",
					failure_type: "fatal",
					summary: "后完成失败",
				}),
			].join("\n\n"),
		);
		writeCard(
			cardsDir,
			2,
			"后建先完成",
			{ goal: "后建先完成", dept: "侦察", acceptance: "包含: 扫", attempt: 1, status: "delivered" },
			[
				workflowMarker("复盘流", "侦察"),
				`<!-- pao-workflow-v2:实例=${instance}/轮次=1 -->`,
				serializeReceipt({
					card_no: 2,
					attempt: 1,
					time: "2026-10-03 10:01",
					result: "success",
					summary: "先完成成功",
				}),
			].join("\n\n"),
		);
		const flow: FlowControl = {
			版本: 2,
			实例: instance,
			owner: "owner",
			脉络: instance,
			工作流: "复盘流",
			卡目录: cardsDir,
			启动: "2026-10-03 09:00",
			状态: "已完成",
			冻结配方: recipe,
			参数: {},
			节点: recipe.节点.map((node) => ({
				名字: node.名字,
				轮次: 1,
				卡: node.名字 === "侦察" ? ["0001", "0002"] : [],
				拆解结束: true,
				...(node.名字 === "侦察" ? {} : { 零卡理由: "未执行" }),
				历史: [],
			})),
			回边次数: {},
			记录: [],
		};
		const row = buildV2ReviewReport(recipe, cardsDir, flow).节点.find((item) => item.节点 === "侦察")!;
		expect(row.末次失败类型).toBe("fatal");
		expect(row.末次成功摘要).toBe("先完成成功");
	});
});
