/**
 * P4-1 桌面画布数据桥＋预检桥＋关联键查询面（hermetic：临时目录 PAO_HOME/项目 fixture）。
 * 覆盖：好/坏配方段隔离、实例清单字段＋卡状态现读、坏实例不拖段、卡缺失如实报、
 * 关联键（执行映射预埋＋卡回执回填）解析、预检 缺参/缺部门/全绿 三态。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { appendReceipt, changeCardStatus, createCard } from "../../src/pao/cards/index.ts";
import { formatProjectList } from "../../src/pao/dept/projects.ts";
import {
	locateCardExecutions,
	readDesktopCanvas,
	readDesktopNodeDetail,
	readDesktopPreflight,
} from "../../src/pao/desktop/canvas.ts";
import { addNodeCards, bindMinister, readControl, startControl } from "../../src/pao/workflow/control.ts";
import { emitRecipeMarkdown, saveRecipe } from "../../src/pao/workflow/distill.ts";
import { loadRecipe, parseRecipe } from "../../src/pao/workflow/recipe.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), `pao-canvas-${prefix}-`));
	roots.push(root);
	return root;
}

const goodFlowRecipe = `---
版本: 2
名字: 好流
参数: [目标项目]
节点:
  - 名字: 实现
    目标: 在 {目标项目} 落地功能
    部门: 工程
    验收: 测试通过
    depends_on: []
  - 名字: 复核
    目标: 复核实现结果
    部门: 评审
    验收: 意见归档
    depends_on: [实现]
    人工确认: true
    模型: 主力
    思考强度: high
---
画布测试用配方。
`;

const badFlowRecipe = `---
版本: 2
名字: 坏流
节点:
  - 名字: 甲
    目标: 甲任务
    部门: 工程
    验收: 验收甲
    depends_on: [乙]
  - 名字: 乙
    目标: 乙任务
    部门: 工程
    验收: 验收乙
    depends_on: [甲]
---
成环配方，加载必须拒绝。
`;

function installRecipes(paoHome: string, names: string[]): void {
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
	if (names.includes("好流")) writeFileSync(join(paoHome, "工作流", "好流.md"), goodFlowRecipe);
	if (names.includes("坏流")) writeFileSync(join(paoHome, "工作流", "坏流.md"), badFlowRecipe);
}

function registerProject(paoHome: string, projectRoot: string): void {
	writeFileSync(
		join(paoHome, "项目清单.md"),
		formatProjectList([
			{ 项目名: "项目", 项目根: projectRoot, 首次服务: "2026-10-05 09:00", 最近服务: "2026-10-05 09:00" },
		]),
	);
}

interface ManifestData {
	工作流: string;
	卡目录: string;
	启动: string;
	状态: string;
	参数?: Record<string, string>;
	节点: Record<string, unknown>[];
	版本?: number;
}

/** 与 driver serializeManifest 同形状写实例清单（YAML frontmatter＋维护注释正文） */
function writeManifest(path: string, data: ManifestData): void {
	writeFileSync(path, `---\n${stringifyYaml(data)}---\n<!-- 驱动器维护：测试 fixture -->\n`);
}

async function makeClaimedCard(cardsDir: string) {
	mkdirSync(cardsDir, { recursive: true });
	const card = await createCard(cardsDir, {
		目标: "实现画布桥",
		部门: "工程",
		验收: "测试通过",
		创建: "2026-10-05 10:00",
	});
	return changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-05 10:01" });
}

describe("readDesktopCanvas 配方段", () => {
	it("好配方出摘要、坏配方显错误不拖全页", () => {
		const root = makeRoot("recipes");
		const paoHome = join(root, "现场");
		installRecipes(paoHome, ["好流", "坏流"]);
		const view = readDesktopCanvas(paoHome);
		expect(view.配方).toHaveLength(2);
		const good = view.配方.find((entry) => entry.名字 === "好流");
		expect(good).toMatchObject({ 可用: true });
		if (good?.可用) {
			expect(good.配方).toMatchObject({
				版本: 2,
				参数: ["目标项目"],
				占位符: ["目标项目"],
				拓扑序: ["实现", "复核"],
			});
			expect(good.配方.节点).toEqual([
				{ 名字: "实现", 部门: "工程", depends_on: [], 人工确认: false },
				{ 名字: "复核", 部门: "评审", depends_on: ["实现"], 人工确认: true, 模型: "主力", 思考强度: "high" },
			]);
		}
		const bad = view.配方.find((entry) => entry.名字 === "坏流");
		expect(bad).toMatchObject({ 可用: false, 错误: { 代码: "RECIPE_CYCLE" } });
		expect(view.错误).toBeUndefined();
	});
	it("配方目录缺失如实为空；目录里的坏条目显错误不拖全页", () => {
		const root = makeRoot("recipes-missing");
		const view = readDesktopCanvas(join(root, "不存在"));
		expect(view.配方).toEqual([]);
		expect(view.错误).toBeUndefined();
		const home = join(root, "现场");
		// 工作流目录里混进同名目录（占位.md 是目录不是文件）：读失败按坏配方条目处理，不拖别的
		mkdirSync(join(home, "工作流", "占位.md"), { recursive: true });
		writeFileSync(join(home, "工作流", "好流.md"), goodFlowRecipe);
		const mixed = readDesktopCanvas(home);
		expect(mixed.配方).toHaveLength(2);
		expect(mixed.配方.find((entry) => entry.名字 === "好流")).toMatchObject({ 可用: true });
		expect(mixed.配方.find((entry) => entry.名字 === "占位")).toMatchObject({ 可用: false });
	});

	it("透出并行组、分支、汇聚和审核回边元数据", async () => {
		const root = makeRoot("parallel-metadata");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		const recipeText = `---
版本: 2
名字: 并行流
参数: []
parallelGroups:
  - id: build
节点:
  - 名字: 分支甲
    目标: 并行实现甲
    部门: 工程
    验收: 测试通过
    depends_on: []
    parallelGroupId: build
    branchId: left
  - 名字: 分支乙
    目标: 并行实现乙
    部门: 工程
    验收: 测试通过
    depends_on: []
    parallelGroupId: build
    branchId: right
  - 名字: 审核
    目标: 审核并行结果
    部门: 评审
    部门标准: 评审标准
    验收: 意见归档
    depends_on: [分支甲, 分支乙]
    parallelGroupId: build
    joinId: build-join
    审核: true
    回边:
      - 目标: 分支甲
        上限: 2
        超限动作: 停滞
---
并行元数据测试。
`;
		mkdirSync(join(paoHome, "工作流"), { recursive: true });
		writeFileSync(join(paoHome, "工作流", "并行流.md"), recipeText);
		registerProject(paoHome, project);
		const recipe = parseRecipe(recipeText, join(paoHome, "工作流", "并行流.md"));
		await startControl(
			recipe,
			{},
			{ cardsDir, workspaceDir: join(project, ".pao", "任务甲"), ownerSessionId: "fixture-owner" },
		);
		const view = readDesktopCanvas(paoHome);
		const entry = view.配方.find((row) => row.名字 === "并行流");
		if (!entry?.可用) throw new Error("并行流配方未读到");
		const summaryNode = entry.配方.节点.find((node) => node.名字 === "审核");
		expect(summaryNode).toMatchObject({
			parallelGroupId: "build",
			joinId: "build-join",
			reviewEdges: [{ target: "分支甲", limit: 2, overflowAction: "停滞" }],
		});
		expect(entry.配方.parallelGroups).toEqual([{ id: "build" }]);
		const instanceNode = view.实例[0]?.节点.find((node) => node.名字 === "审核");
		expect(instanceNode).toMatchObject({
			parallelGroupId: "build",
			joinId: "build-join",
			reviewEdges: [{ target: "分支甲", limit: 2, overflowAction: "停滞" }],
		});
	});
});

describe("readDesktopCanvas 实例段", () => {
	it("v2 多卡节点可读取指定本轮卡，拒绝读取另一节点的卡", async () => {
		const root = makeRoot("multi-detail");
		const home = join(root, "现场");
		const project = join(root, "项目");
		const options = { cardsDir: join(project, ".pao", "卡"), ownerSessionId: "owner" };
		installRecipes(home, ["好流"]);
		registerProject(home, project);
		const recipe = parseRecipe(goodFlowRecipe, join(home, "工作流", "好流.md"));
		await startControl(recipe, { 目标项目: "项目X" }, options);
		await bindMinister(recipe, options, "实现", "minister");
		const flow = readControl(recipe, options);
		const refs = await addNodeCards(
			recipe,
			options,
			{ 实例: flow.实例, 节点: "实现", 轮次: 1, 部长会话: "minister" },
			[
				{ goal: "第一项", acceptance: "完成" },
				{ goal: "第二项", acceptance: "完成" },
			],
		);
		const view = readDesktopCanvas(home);
		const path = view.实例[0].路径;
		expect(view.实例[0].节点.find((node) => node.名字 === "实现")?.卡列表?.map((card) => card.卡号)).toEqual(refs);
		expect(readDesktopNodeDetail(home, path, "实现", refs[1]).卡?.卡号).toBe(refs[1]);
		const invalid = readDesktopNodeDetail(home, path, "复核", refs[1]);
		expect(invalid.卡).toBeUndefined();
		expect(invalid.错误).toContain("不属于此节点的当前轮次");
	});
	it("坐标保存重开及启动后保留；最新配方修改不影响冻结图和详情", async () => {
		const root = makeRoot("frozen");
		const home = join(root, "现场");
		const project = join(root, "项目");
		const workspaceDir = join(project, ".pao", "任务");
		const cardsDir = join(workspaceDir, "卡");
		installRecipes(home, ["好流"]);
		registerProject(home, project);
		const recipe = parseRecipe(goodFlowRecipe, join(home, "工作流", "好流.md"));
		recipe.ui = { positions: { 实现: { x: -12, y: 450 }, 复核: { x: 820, y: 32 } } };
		saveRecipe(home, "好流", emitRecipeMarkdown(recipe), { 覆盖: true, 备份时间: "test" });
		const reopened = loadRecipe(home, "好流");
		expect(reopened.ui).toEqual(recipe.ui);
		await startControl(reopened, { 目标项目: "项目X" }, { cardsDir, workspaceDir, ownerSessionId: "fixture-owner" });
		writeFileSync(join(home, "工作流", "好流.md"), badFlowRecipe.replace("名字: 坏流", "名字: 好流"));
		const view = readDesktopCanvas(home);
		expect(view.异常).toEqual([]);
		expect(view.实例[0].frozenRecipe?.ui).toEqual(recipe.ui);
		expect(view.实例[0].frozenRecipe?.节点.map((node) => node.名字)).toEqual(["实现", "复核"]);
		expect(readDesktopNodeDetail(home, join(workspaceDir, "工作流实例-好流.md"), "复核").模板).toMatchObject({
			部门: "评审",
			模型: "主力",
		});
		expect(() =>
			parseRecipe(emitRecipeMarkdown({ ...recipe, ui: { positions: { 未知: { x: 0, y: 0 } } } }), recipe.文件路径),
		).toThrow("未知节点");
		expect(() =>
			parseRecipe(
				emitRecipeMarkdown({ ...recipe, ui: { positions: { 实现: { x: Infinity, y: 0 } } } }),
				recipe.文件路径,
			),
		).toThrow("有限数");
	});
	it("清单字段＋节点卡状态现读（卡改状态后重读跟随）", async () => {
		const root = makeRoot("instance");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		const card = await makeClaimedCard(cardsDir);
		writeManifest(join(project, ".pao", "任务甲", "工作流实例-好流.md"), {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			参数: { 目标项目: "项目X" },
			节点: [
				{ 名字: "实现", 卡号: `卡${String(card.card_no).padStart(4, "0")}` },
				{ 名字: "复核", 挂起: "等待人工确认" },
			],
		});
		const view = readDesktopCanvas(paoHome);
		expect(view.实例).toHaveLength(1);
		const instance = view.实例[0];
		expect(instance).toMatchObject({
			名字: "好流",
			工作流: "好流",
			状态: "运行中",
			参数: { 目标项目: "项目X" },
		});
		expect(instance.节点).toEqual([
			expect.objectContaining({ 名字: "实现", 状态: "in_progress" }),
			expect.objectContaining({ 名字: "复核", 状态: "no_card", 挂起: "等待人工确认" }),
		]);
		// 卡现读为准：改卡状态后画布重读跟随（清单不作数）
		changeCardStatus(card, { 操作者: "主控", to: "delivered", 时间: "2026-10-05 11:00" });
		const refreshed = readDesktopCanvas(paoHome);
		expect(refreshed.实例[0].节点[0]).toMatchObject({ 状态: "delivered" });
	});

	it("卡缺失如实报读取异常；坏实例清单进异常行不拖好实例", async () => {
		const root = makeRoot("instance-bad");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		const card = await makeClaimedCard(cardsDir);
		writeManifest(join(project, ".pao", "任务甲", "工作流实例-好流.md"), {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			节点: [
				{ 名字: "实现", 卡号: `卡${String(card.card_no).padStart(4, "0")}` },
				{ 名字: "幽灵", 卡号: "卡0042" },
			],
		});
		writeFileSync(
			join(project, ".pao", "工作流实例-坏档.md"),
			"---\n工作流: 坏档\n状态: 莫名其妙\n---\n<!-- 坏字段清单，保留原件人工核对 -->\n",
		);
		writeFileSync(
			join(project, ".pao", "工作流实例-二代.md"),
			"---\n版本: 2\n工作流: 二代\n卡目录: 占位\n启动: 占位\n状态: 运行中\n节点: []\n---\nv2 控制正本，画布不降级\n",
		);
		const view = readDesktopCanvas(paoHome);
		expect(view.实例).toHaveLength(1);
		expect(view.实例[0].节点.map((node) => node.状态)).toEqual(["in_progress", "读取异常"]);
		expect(view.异常.map((row) => row.路径)).toEqual([
			join(project, ".pao", "工作流实例-二代.md"),
			join(project, ".pao", "工作流实例-坏档.md"),
		]);
	});
});

describe("关联键（执行映射预埋＋卡回执回填）", () => {
	it("派发预埋可查会话；运行中优先；回执回填补缺口", async () => {
		const root = makeRoot("correlation");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		const card = await makeClaimedCard(cardsDir);
		writeManifest(join(project, ".pao", "任务甲", "工作流实例-好流.md"), {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			节点: [{ 名字: "实现", 卡号: `卡${String(card.card_no).padStart(4, "0")}` }, { 名字: "复核" }],
		});
		const mappingDir = join(project, ".pao", "执行映射");
		mkdirSync(mappingDir, { recursive: true });
		const identity = { 卡路径: card.path, 尝试: 1, 项目根: project, 会话目录: join(project, ".pao", "worker会话") };
		// 旧尝试：已结算（带会话路径）
		writeFileSync(
			join(mappingDir, "sess-old.jsonl"),
			`${[
				JSON.stringify({ 执行标识: "sess-old", ...identity, 状态: "启动", 时间: "2026-10-05T02:00:00.000Z" }),
				JSON.stringify({
					执行标识: "sess-old",
					...identity,
					状态: "失败",
					会话路径: join(project, ".pao", "worker会话", "w_sess-old.jsonl"),
					时间: "2026-10-05T02:10:00.000Z",
				}),
			].join("\n")}\n`,
		);
		// 当前尝试：运行中（派发预埋，未结算）
		writeFileSync(
			join(mappingDir, "sess-run.jsonl"),
			`${[
				JSON.stringify({ 执行标识: "sess-run", ...identity, 状态: "启动", 时间: "2026-10-05T03:00:00.000Z" }),
				JSON.stringify({ 执行标识: "sess-run", ...identity, 状态: "运行中", 时间: "2026-10-05T03:00:05.000Z" }),
			].join("\n")}\n`,
		);
		const view = readDesktopCanvas(paoHome);
		const implNode = view.实例[0].节点.find((node) => node.名字 === "实现");
		expect(implNode).toMatchObject({
			会话标识: "sess-run",
			会话状态: "运行中",
		});
		const refs = locateCardExecutions(project, card);
		expect(refs).toHaveLength(2);
		expect(refs.find((ref) => ref.执行标识 === "sess-old")).toMatchObject({
			映射状态: "失败",
			会话路径: join(project, ".pao", "worker会话", "w_sess-old.jsonl"),
			来源: "执行映射",
		});
		// 回执回填：映射日志整目录丢失后，卡上回执的 用量.执行标识 仍能指认跑过它的会话
		rmSync(mappingDir, { recursive: true, force: true });
		appendReceipt(card, {
			尝试号: card.frontmatter.attempt,
			时间: "2026-10-05 12:00",
			用量: { run_id: "sess-run" },
		});
		const fallback = locateCardExecutions(project, card);
		expect(fallback).toEqual([{ 执行标识: "sess-run", 时间: "2026-10-05 12:00", 来源: "卡回执" }]);
		const refreshed = readDesktopCanvas(paoHome);
		expect(refreshed.实例[0].节点.find((node) => node.名字 === "实现")).toMatchObject({
			会话标识: "sess-run",
			会话状态: "卡回执",
		});
	});
	it("无派发记录的卡如实不带会话标识", async () => {
		const root = makeRoot("correlation-none");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		await makeClaimedCard(cardsDir);
		writeManifest(join(project, ".pao", "任务甲", "工作流实例-好流.md"), {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			节点: [{ 名字: "实现", 卡号: "卡0001" }],
		});
		const view = readDesktopCanvas(paoHome);
		const node = view.实例[0].节点[0];
		expect(node.会话标识).toBeUndefined();
	});

	it("23 节点与 500 条执行映射保持可读并按节点复用索引", async () => {
		const root = makeRoot("large-canvas");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		const cards: Awaited<ReturnType<typeof makeClaimedCard>>[] = [];
		for (let index = 0; index < 23; index++) cards.push(await makeClaimedCard(cardsDir));
		const nodes = cards.map((card, index) => ({
			名字: `节点${String(index + 1).padStart(2, "0")}`,
			卡号: `卡${String(card.card_no).padStart(4, "0")}`,
		}));
		writeManifest(join(project, ".pao", "工作流实例-大图.md"), {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			节点: nodes,
		});
		const mappingDir = join(project, ".pao", "执行映射");
		mkdirSync(mappingDir, { recursive: true });
		const mappings = Array.from({ length: 500 }, (_, index) => {
			const card = cards[index % cards.length];
			return JSON.stringify({
				执行标识: `sess-${String(index).padStart(4, "0")}`,
				卡路径: card.path,
				状态: "成功",
				时间: `2026-10-05T${String(10 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
			});
		});
		// 重复执行标识按追加顺序取最后一条，且运行中会被节点会话选择优先。
		mappings.push(
			JSON.stringify({
				执行标识: "sess-0000",
				卡路径: cards[0].path,
				状态: "运行中",
				时间: "2026-10-05T23:59:00.000Z",
			}),
		);
		writeFileSync(join(mappingDir, "批量.jsonl"), `${mappings.join("\n")}\n`);

		const view = readDesktopCanvas(paoHome);
		expect(view.异常).toEqual([]);
		expect(view.实例).toHaveLength(1);
		expect(view.实例[0].节点).toHaveLength(23);
		expect(view.实例[0].节点.every((node) => node.状态 === "in_progress")).toBe(true);
		expect(view.实例[0].节点[0]).toMatchObject({
			会话标识: "sess-0000",
			会话状态: "运行中",
		});
	});
});

describe("readDesktopNodeDetail（D8d）", () => {
	it("模板值＋卡面实际值＋执行锚点＋回执轮次齐全；升档理由无记录＝缺省", async () => {
		const root = makeRoot("detail-happy");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		const card = await makeClaimedCard(cardsDir);
		const manifestPath = join(project, ".pao", "任务甲", "工作流实例-好流.md");
		writeManifest(manifestPath, {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			参数: { 目标项目: "项目X" },
			节点: [
				{ 名字: "实现", 卡号: `卡${String(card.card_no).padStart(4, "0")}` },
				{ 名字: "复核", 挂起: "等待人工确认" },
			],
		});
		const mappingDir = join(project, ".pao", "执行映射");
		mkdirSync(mappingDir, { recursive: true });
		writeFileSync(
			join(mappingDir, "sess-run.jsonl"),
			`${JSON.stringify({
				执行标识: "sess-run",
				卡路径: card.path,
				状态: "运行中",
				时间: "2026-10-05T03:00:00.000Z",
			})}\n`,
		);
		appendReceipt(card, {
			尝试号: card.frontmatter.attempt,
			时间: "2026-10-05 12:00",
			结果: "失败",
			失败类型: "missing_input",
			摘要: "第二轮打回：缺项目X清单",
			证据: ["src/a.ts:10"],
		});
		const detail = readDesktopNodeDetail(paoHome, manifestPath, "实现");
		expect(detail.错误).toContain("旧实例没有冻结配方");
		expect(detail.模板).toBeUndefined();
		expect(detail.卡).toMatchObject({
			卡号: `卡${String(card.card_no).padStart(4, "0")}`,
			状态: "in_progress",
			路径: card.path,
		});
		expect(detail.卡?.回执).toHaveLength(1);
		expect(detail.卡?.回执[0]).toMatchObject({ 失败类型: "missing_input", 证据: ["src/a.ts:10"] });
		expect(detail.执行).toEqual([expect.objectContaining({ 执行标识: "sess-run", 映射状态: "运行中" })]);
		expect(detail.升档理由).toBeUndefined();
		// 未落卡节点：模板仍在、卡缺省、执行空
		const pending = readDesktopNodeDetail(paoHome, manifestPath, "复核");
		expect(pending.错误).toContain("旧实例没有冻结配方");
		expect(pending.模板).toBeUndefined();
		expect(pending.卡).toBeUndefined();
		expect(pending.执行).toEqual([]);
	});
	it("节点不在清单＝结构化错误；卡缺失＝卡缺省＋错误、模板照给", async () => {
		const root = makeRoot("detail-bad");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		const card = await makeClaimedCard(cardsDir);
		const manifestPath = join(project, ".pao", "任务甲", "工作流实例-好流.md");
		writeManifest(manifestPath, {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			节点: [
				{ 名字: "实现", 卡号: `卡${String(card.card_no).padStart(4, "0")}` },
				{ 名字: "幽灵", 卡号: "卡0042" },
			],
		});
		expect(readDesktopNodeDetail(paoHome, manifestPath, "不存在")).toMatchObject({
			错误: expect.stringContaining("不在实例清单"),
		});
		const ghost = readDesktopNodeDetail(paoHome, manifestPath, "幽灵");
		expect(ghost.卡).toBeUndefined();
		// 幽灵节点不在配方（配方只有 实现/复核）：模板缺省＋错误点名，卡面错误同报
		expect(ghost.模板).toBeUndefined();
		expect(ghost.错误).toContain("旧实例没有冻结配方");
		expect(ghost.错误).toContain("卡面不可读");
	});
	it("配方不可读＝模板缺省＋错误、卡面照给；实例坏＝整体错误", async () => {
		const root = makeRoot("detail-norecipe");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, []);
		registerProject(paoHome, project);
		const card = await makeClaimedCard(cardsDir);
		const manifestPath = join(project, ".pao", "任务甲", "工作流实例-好流.md");
		writeManifest(manifestPath, {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			节点: [{ 名字: "实现", 卡号: `卡${String(card.card_no).padStart(4, "0")}` }],
		});
		const noRecipe = readDesktopNodeDetail(paoHome, manifestPath, "实现");
		expect(noRecipe.模板).toBeUndefined();
		expect(noRecipe.错误).toContain("配方模板值不可读");
		expect(noRecipe.卡).toMatchObject({ 状态: "in_progress" });
		const broken = join(project, ".pao", "工作流实例-坏档.md");
		writeFileSync(broken, "---\n工作流: 坏\n---\n<!-- 坏字段 -->\n");
		expect(readDesktopNodeDetail(paoHome, broken, "实现")).toMatchObject({
			错误: expect.stringContaining("实例清单不可读"),
		});
	});
	it("卡正文带升档记录行＝原样透出（不解析不推断）", async () => {
		const root = makeRoot("detail-tier");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		installRecipes(paoHome, ["好流"]);
		registerProject(paoHome, project);
		const card = await makeClaimedCard(cardsDir);
		writeFileSync(card.path, `${readFileSync(card.path, "utf8")}\n升档：用例复杂，档位变更至主力。\n`);
		const manifestPath = join(project, ".pao", "任务甲", "工作流实例-好流.md");
		writeManifest(manifestPath, {
			工作流: "好流",
			卡目录: cardsDir,
			启动: "2026-10-05 10:00",
			状态: "运行中",
			节点: [{ 名字: "实现", 卡号: `卡${String(card.card_no).padStart(4, "0")}` }],
		});
		const detail = readDesktopNodeDetail(paoHome, manifestPath, "实现");
		expect(detail.升档理由).toContain("升档：用例复杂");
	});
});

describe("readDesktopPreflight", () => {
	it("缺参结构化返回不 throw", () => {
		const root = makeRoot("preflight-missing-param");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		mkdirSync(project);
		installRecipes(paoHome, ["好流"]);
		const result = readDesktopPreflight(paoHome, project, "好流", {});
		expect(result.可用).toBe(false);
		if (!result.可用) expect(result.错误.代码).toBe("RECIPE_PARAM_MISSING");
	});
	it("部门未登记阻断启动", () => {
		const root = makeRoot("preflight-dept");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		mkdirSync(join(paoHome, "pao配置"), { recursive: true });
		writeFileSync(
			join(paoHome, "pao配置", "档位.json"),
			JSON.stringify({ 档位: [{ 名: "主力", provider: "offline", model: "fake", thinkingLevel: "off" }] }),
		);
		installRecipes(paoHome, ["好流"]);
		const result = readDesktopPreflight(paoHome, project, "好流", { 目标项目: "项目X" });
		expect(result.可用).toBe(true);
		if (result.可用) {
			expect(result.报告.canStart).toBe(false);
			const dept = result.报告.items.find((item) => item.subject === "部门");
			expect(dept?.level).toBe("阻止启动");
		}
	});
	it("部门与档位齐备全绿（仅剩非阻断提示）", () => {
		const root = makeRoot("preflight-green");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		mkdirSync(project);
		mkdirSync(join(paoHome, "pao配置"), { recursive: true });
		writeFileSync(
			join(paoHome, "pao配置", "档位.json"),
			JSON.stringify({ 档位: [{ 名: "主力", provider: "offline", model: "fake", thinkingLevel: "off" }] }),
		);
		mkdirSync(join(paoHome, "部门", "工程"), { recursive: true });
		mkdirSync(join(paoHome, "部门", "评审"), { recursive: true });
		writeFileSync(join(paoHome, "部门", "工程", "配方.md"), "# 工程配方\n干法：测试先行。\n");
		writeFileSync(join(paoHome, "部门", "评审", "配方.md"), "# 评审配方\n干法：对照验收。\n");
		writeFileSync(
			join(paoHome, "部门", "注册表.md"),
			["| 名字 | 标签 | 库路径 |", "| --- | --- | --- |", "| 工程 | | 工程 |", "| 评审 | | 评审 |"].join("\n"),
		);
		installRecipes(paoHome, ["好流"]);
		const result = readDesktopPreflight(paoHome, project, "好流", { 目标项目: "项目X" });
		expect(result.可用).toBe(true);
		if (result.可用) {
			expect(result.报告.canStart).toBe(true);
			expect(result.报告.items.some((item) => item.level === "阻止启动")).toBe(false);
		}
	});
	it("配方不存在结构化返回", () => {
		const root = makeRoot("preflight-norecipe");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		mkdirSync(project);
		const result = readDesktopPreflight(paoHome, project, "不存在", {});
		expect(result.可用).toBe(false);
		if (!result.可用) expect(result.错误.代码).toBe("RECIPE_NOT_FOUND");
	});
});

describe("readDesktopCanvas 视图信封（S6-K4）", () => {
	it("信封四字段；内容未变 revision 去重；内容变化 revision 跟随；publishedAt 为 ISO", () => {
		const root = makeRoot("envelope");
		const home = join(root, "现场");
		installRecipes(home, ["好流"]);
		const first = readDesktopCanvas(home);
		expect(first.envelope.version).toBe(1);
		expect(first.envelope.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(first.envelope.sessionGeneration).toMatch(/^[0-9a-f]{64}$/);
		const second = readDesktopCanvas(home);
		expect(second.envelope.revision).toBe(first.envelope.revision);
		expect(second.envelope.sessionGeneration).toBe(first.envelope.sessionGeneration);
		// 内容变化（多一个配方条目）→ 内容指纹变化；作用域（PAO_HOME）未变 → 代际不变
		installRecipes(home, ["好流", "坏流"]);
		const third = readDesktopCanvas(home);
		expect(third.envelope.revision).not.toBe(first.envelope.revision);
		expect(third.envelope.sessionGeneration).toBe(first.envelope.sessionGeneration);
	});
});
