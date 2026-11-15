/**
 * S2d 待处理最小版单测（2026-10-04 P2 定案）：聚合五类待处理（人工门待确认／待裁定／超限放行／
 * 缺输入补卡／失败待处置／实例恢复请求／实例异常），每项固定四行（为什么停／要决定什么／建议／证据）。
 * 数据源全部是既有正本：v2 控制正本走真实 startControl→部长绑卡→交付→拆解结束链路，v1 走清单，
 * 卡侧走 createCard＋appendReceipt 真通道——本套只钉聚合口径与呈现，不重复验证上游状态机。
 * 关键回归：人工门未确认的实例在 controlReport 里仍报「运行中」，只扫挂起行会漏掉它。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { createCard, loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { buildFirstRunList } from "../../src/pao/status/firstrun.ts";
import { collectPending, PENDING_ITEM_LIMIT, renderPendingSection } from "../../src/pao/status/pending.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	endDecomposition,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

interface Scenario {
	home: string;
	项目根: string;
	paoDir: string;
	cardsDir: string;
	recipe: ReturnType<typeof parseRecipe>;
	options: Parameters<typeof startControl>[2];
}

/** 落一个真实布局：PAO_HOME 里登记项目，项目根下 .pao 放卡目录与控制正本（平布局,扫描同源） */
function buildScenario(): Scenario {
	const home = tempDir("pao-pending-home-");
	const projectRoot = tempDir("pao-pending-proj-");
	const paoDir = join(projectRoot, ".pao");
	const cardsDir = join(paoDir, "卡");
	mkdirSync(cardsDir, { recursive: true });
	writeFileSync(
		join(home, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| 项目甲 | ${projectRoot} | 2026-10-04 10:00 | 2026-10-04 10:00 |\n`,
		"utf8",
	);
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "验流",
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在", 人工确认: true }],
		})}---\n`,
		join(projectRoot, "验流.md"),
	);
	const options = {
		cardsDir,
		ownerSessionId: "owner",
		counterPath: join(paoDir, "卡号.txt"),
		workspaceDir: paoDir,
	};
	return { home, 项目根: projectRoot, paoDir, cardsDir, recipe, options };
}

/** 真实链路推到人工门前：启动→部长绑定→落卡→卡交付→拆解结束（此后节点停在「等待人工确认」） */
async function pushToHumanGate(s: Scenario): Promise<{ instance: string; round: number }> {
	await startControl(s.recipe, {}, s.options);
	await bindMinister(s.recipe, s.options, "开发", "minister-开发");
	const flow = readControl(s.recipe, s.options);
	const identity = {
		实例: flow.实例,
		节点: "开发",
		轮次: flow.节点.find((n) => n.名字 === "开发")!.轮次,
		部长会话: "minister-开发",
	};
	const refs = await addNodeCards(s.recipe, s.options, identity, [{ goal: "任务", acceptance: "文件存在" }]);
	for (const ref of refs) {
		const card = loadCard(s.cardsDir, parseCardRef(ref));
		writeFileSync(card.path, serializeCard({ ...card.frontmatter, status: "delivered" }, card.body), "utf8");
	}
	await endDecomposition(s.recipe, s.options, identity);
	return { instance: identity.实例, round: identity.轮次 };
}

/** 改控制正本（真停因字段：暂停文案/裁定请求），模拟人工介入前的现场 */
function changeFlow(s: Scenario, change: (flow: ReturnType<typeof readControl>) => void): void {
	const flow = readControl(s.recipe, s.options);
	change(flow);
	// 原始写绕过 mutate：同步派生状态（与控制视图同判据——设了暂停即挂起），否则读侧看到陈旧「运行中」
	if (flow.暂停) flow.状态 = "挂起";
	writeFileSync(controlPath(s.recipe, s.options), `---\n${stringify(flow)}---\n`, "utf8");
}

/** 造失败卡并落末次回执（createCard＋appendReceipt 真通道;尝试号须与卡面一致才落卡） */
async function makeFailureCard(
	s: Scenario,
	goal: string,
	typing: "missing_input" | "insufficient_capability" | "transient",
): Promise<string> {
	const card = await createCard(
		s.cardsDir,
		{ 目标: goal, 部门: "测试", 验收: "完成", 创建: "2026-10-04 12:00", 状态: "failed" },
		{ counterPath: s.options.counterPath },
	);
	writeFileSync(card.path, serializeCard({ ...card.frontmatter, attempt: 1 }, card.body), "utf8");
	appendReceipt(loadCard(s.cardsDir, card.card_no), {
		尝试号: 1,
		时间: "2026-10-04 12:05",
		结果: "失败",
		摘要: `${typing}回执`,
		失败类型: typing,
	});
	return card.path;
}

/** 写 v1 假清单（driver serializeManifest 同构；清单无停因字段） */
function writeV1Manifest(s: Scenario, name: string, status: string): void {
	writeFileSync(
		join(s.paoDir, `工作流实例-${name}.md`),
		`---\n工作流: ${name}\n卡目录: ${s.cardsDir}\n启动: 2026-10-04 10:00\n状态: ${status}\n参数: {}\n节点: []\n---\n<!-- 测试实例 -->\n`,
		"utf8",
	);
}

function types(items: ReturnType<typeof collectPending>): string[] {
	return items.map((item) => item.类型);
}

/** 每项都必须带齐四行口径（为什么停／要决定什么／建议／证据） */
function assertEachFourLines(text: string): void {
	const blocks = text.split("\n▸ ").slice(1);
	expect(blocks.length).toBeGreaterThan(0);
	for (const block of blocks) {
		for (const label of ["为什么停：", "要决定什么：", "建议：", "证据："]) expect(block).toContain(label);
	}
}

describe("collectPending（S2d 待处理聚合）", () => {
	it("空 PAO_HOME：无待处理项,渲染空数组,首跑清单不出待处理段", () => {
		const home = tempDir("pao-pending-empty-");
		expect(collectPending(home)).toEqual([]);
		expect(renderPendingSection([])).toEqual([]);
		const text = buildFirstRunList(home);
		expect(text).not.toContain("待处理（");
		expect(text).toContain("今日待办:无");
	});

	it("人工门待确认：运行中的 v2 实例也列出（只扫挂起行会漏）,建议带真实实例与轮次", async () => {
		const s = buildScenario();
		const { instance, round } = await pushToHumanGate(s);
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["人工门待确认"]);
		const item = items[0]!;
		expect(item.主体).toContain("工作流「验流」节点「开发」（项目甲）");
		expect(item.为什么停).toContain("等待人工确认");
		expect(item.为什么停).toContain("运行中"); // 报告状态如实:不是挂起也照样列
		expect(item.建议).toContain(`instance=${instance}`);
		expect(item.建议).toContain(`round=${round}`);
		expect(item.建议).toContain("action=confirm");
		expect(item.证据).toEqual([join(s.paoDir, "工作流实例-验流.md")]);
		// 该实例在挂起清单里不出现——首跑清单只靠待处理段看到它（固定文案里的「无挂起工作流」不算行）
		const text = buildFirstRunList(s.home);
		expect(text).not.toContain("⏸ - 挂起工作流");
		expect(text).toContain("今日待办:无"); // 待办计数不被待处理段污染
		expect(text).toContain("待处理（1 项");
		expect(text).toContain("人工门待确认");
		assertEachFourLines(text);
	});

	it("待裁定：人工通道的裁定请求列四项中的裁定口径,并注明主控不得代替", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		changeFlow(s, (flow) => {
			flow.裁定 = { 节点: "开发", 轮次: 1, 理由: "两方案取舍", 通道: "人工" };
			flow.暂停 = "等待人工裁定:两方案取舍";
		});
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["待裁定"]);
		expect(items[0]!.要决定什么).toContain("主控不得代替");
		expect(items[0]!.为什么停).toContain("两方案取舍");
		expect(items[0]!.建议).toContain("action=rule");
	});

	it("超限放行：回边超限停滞文案原样呈现,不冒充人工门", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		const copyText = "回边 审查→开发 超限 3:连续两轮不达标";
		changeFlow(s, (flow) => {
			flow.暂停 = copyText;
		});
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["超限放行"]);
		expect(items[0]!.为什么停).toBe(copyText);
		expect(items[0]!.要决定什么).toContain("放行");
	});

	it("v2 一般挂起：无裁定无超限线索时列恢复请求,并提示恢复前确认无在途卡", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		changeFlow(s, (flow) => {
			flow.暂停 = "手工暂停:等现场核查";
		});
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["实例恢复请求"]);
		expect(items[0]!.建议).toContain("action=resume");
		// 恢复三件套给真值：resumeControl 硬校验 prev_owner,照抄必含控制正本 owner
		expect(items[0]!.建议).toContain("prev_owner=owner");
		expect(items[0]!.要决定什么).toContain("在途卡");
	});

	it("v1 清单挂起：如实说明清单无停因字段,只能人工重建（不自动续跑）", async () => {
		const s = buildScenario();
		writeV1Manifest(s, "旧流", "挂起");
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["实例恢复请求"]);
		expect(items[0]!.为什么停).toContain("旧版实例清单");
		expect(items[0]!.建议).toContain("人工重建");
		assertEachFourLines(renderPendingSection(items).join("\n"));
	});

	it("实例异常：坏控制正本显式列异常项,不当空闲清理", async () => {
		const s = buildScenario();
		writeFileSync(join(s.paoDir, "工作流实例-坏流.md"), `---\n版本: 2\n工作流: 坏流\n---\n`, "utf8");
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["实例异常"]);
		expect(items[0]!.为什么停).toContain("卡目录");
		expect(items[0]!.要决定什么).toContain("不得当空闲清理");
	});

	it("坏卡：读不出来的卡列成待处理项并带路径,不当没有任务（审查第 5 项）", async () => {
		const s = buildScenario();
		writeFileSync(join(s.cardsDir, "卡0009-坏卡.md"), "---\n目标: 坏卡\n---\n正文\n", "utf8");
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["坏卡待修"]);
		expect(items[0]!.证据[0]).toContain("卡0009-坏卡.md");
		expect(items[0]!.为什么停.length).toBeGreaterThan(0);
		expect(items[0]!.建议).toContain("保留原件");
	});

	it("失败卡：缺输入列补卡,能力不足列待处置,瞬时故障自动重派不列", async () => {
		const s = buildScenario();
		await makeFailureCard(s, "缺输入活", "missing_input");
		await makeFailureCard(s, "能力不足活", "insufficient_capability");
		await makeFailureCard(s, "瞬时活", "transient");
		const items = collectPending(s.home);
		expect(types(items)).toEqual(["缺输入补卡", "失败待处置"]);
		expect(items[0]!.主体).toContain("缺输入活");
		expect(items[0]!.为什么停).toContain("不自动重派");
		expect(items[0]!.建议).toContain("失败→待认领");
		expect(items[1]!.主体).toContain("能力不足活");
		expect(items[1]!.要决定什么).toContain("重派");
		expect(items.some((item) => item.主体.includes("瞬时活"))).toBe(false);
	});

	it("聚合多源：实例门＋裁定＋卡侧同时在场,超上限截断并给出尾行计数", async () => {
		const s = buildScenario();
		await pushToHumanGate(s);
		await makeFailureCard(s, "缺甲", "missing_input");
		await makeFailureCard(s, "缺乙", "missing_input");
		await makeFailureCard(s, "缺丙", "missing_input");
		await makeFailureCard(s, "缺丁", "missing_input");
		await makeFailureCard(s, "力甲", "insufficient_capability");
		const items = collectPending(s.home);
		expect(types(items)).toEqual([
			"人工门待确认",
			"缺输入补卡",
			"缺输入补卡",
			"缺输入补卡",
			"失败待处置",
			"缺输入补卡",
		]);
		// 末项是同类合并计数项：第 4 张缺输入卡超出单类上限,只计数不再单列
		expect(items[5]!.主体).toContain("另有 1 张缺输入失败卡未列出");
		expect(items.some((item) => item.主体.includes("缺丁"))).toBe(false);
		const lines = renderPendingSection(items);
		expect(lines[0]).toContain("待处理（6 项");
		// 6 项＝上限,正好全列;再加一张卡越过上限看尾行
		await makeFailureCard(s, "力乙", "insufficient_capability");
		const many = collectPending(s.home);
		const manyLines = renderPendingSection(many);
		expect(manyLines.some((line) => line.includes(`…另有 ${many.length - PENDING_ITEM_LIMIT} 项未列出`))).toBe(true);
		assertEachFourLines(manyLines.join("\n"));
	});

	it("限额可传参：cardItemLimit 放行同类全量,itemLimit 截总;不传时默认口径不变", async () => {
		const s = buildScenario();
		for (const goal of ["缺甲", "缺乙", "缺丙", "缺丁", "缺戊"]) await makeFailureCard(s, goal, "missing_input");
		// 默认口径不变:单类前 3 条＋尾行计数
		const defaultItems = collectPending(s.home);
		expect(types(defaultItems)).toEqual(["缺输入补卡", "缺输入补卡", "缺输入补卡", "缺输入补卡"]);
		expect(defaultItems[3]!.主体).toContain("另有 2 张缺输入失败卡未列出");
		// 放行上限:5 张全列,无尾行计数,部门字段随卡面
		const full = collectPending(s.home, { cardItemLimit: 10 });
		expect(types(full)).toEqual(["缺输入补卡", "缺输入补卡", "缺输入补卡", "缺输入补卡", "缺输入补卡"]);
		expect(full.every((item) => item.部门 === "测试")).toBe(true);
		// 总条数上限:截后不冒充全量（条数如实为截后长度,渲染层另有口径）
		expect(collectPending(s.home, { itemLimit: 2 })).toHaveLength(2);
		// 缺省＝旧行为:collectPending 本身不按 PENDING_ITEM_LIMIT 戢,截断发生在渲染层
		expect(collectPending(s.home)).toHaveLength(defaultItems.length);
	});

	it("instanceGateLimit 可传参：双门实例默认两门全列,传 1 截 1 留计数行", async () => {
		const s = buildScenario();
		const recipe = parseRecipe(
			`---\n${stringify({
				版本: 2,
				名字: "双门流",
				参数: [],
				节点: [
					{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在", 人工确认: true },
					{ 名字: "审查", 部门: "审查", 目标: "审代码", 验收: "文件存在", 人工确认: true },
				],
			})}---\n`,
			join(s.项目根, "双门流.md"),
		);
		await startControl(recipe, {}, s.options);
		for (const [node, minister] of [
			["开发", "minister-开发"],
			["审查", "minister-审查"],
		] as const) {
			await bindMinister(recipe, s.options, node, minister);
			const flow = readControl(recipe, s.options);
			const identity = {
				实例: flow.实例,
				节点: node,
				轮次: flow.节点.find((n) => n.名字 === node)!.轮次,
				部长会话: minister,
			};
			const refs = await addNodeCards(recipe, s.options, identity, [
				{ goal: `${node}任务`, acceptance: "文件存在" },
			]);
			for (const ref of refs) {
				const card = loadCard(s.cardsDir, parseCardRef(ref));
				writeFileSync(card.path, serializeCard({ ...card.frontmatter, status: "delivered" }, card.body), "utf8");
			}
			await endDecomposition(recipe, s.options, identity);
		}
		// 默认口径不变:单实例两门都列（INSTANCE_GATE_LIMIT=2）,无计数行
		const defaultItems = collectPending(s.home);
		expect(types(defaultItems)).toEqual(["人工门待确认", "人工门待确认"]);
		expect(defaultItems.every((item) => item.部门 === undefined)).toBe(true);
		// 放行到 1:一门单列＋计数行
		const cutOff = collectPending(s.home, { instanceGateLimit: 1 });
		expect(types(cutOff)).toEqual(["人工门待确认", "人工门待确认"]);
		expect(cutOff[0]!.主体).toContain("「开发」");
		expect(cutOff[1]!.主体).toContain("另有 1 个门未点头");
	});
});

describe("pending 数据源口径（status/workflow-instances）", () => {
	it("实例目录扫描只认工作流实例文件,其他 md 不误列", async () => {
		const s = buildScenario();
		writeV1Manifest(s, "旧流", "挂起");
		writeFileSync(join(s.paoDir, "随手笔记.md"), "无关文件\n", "utf8");
		expect(readdirSync(s.paoDir).filter((f) => f.startsWith("工作流实例-"))).toHaveLength(1);
		expect(collectPending(s.home)).toHaveLength(1);
	});
});
