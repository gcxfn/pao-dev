import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCardNumber } from "../../src/pao/cards/counter.ts";
import { changeCardStatus, createCard, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { artifactOf, readDesktopPlans, stepProgress } from "../../src/pao/desktop/plans.ts";
import { readDesktopFlows } from "../../src/pao/desktop/workflow.ts";
import { addNodeCards, bindMinister, type FlowControl } from "../../src/pao/workflow/control.ts";
import { startWorkflow } from "../../src/pao/workflow/driver.ts";
import {
	createTemporaryPlan,
	planDir,
	planFilePath,
	readPlanInstanceIdentity,
	recordPlanStart,
	resolvePlanExecution,
	undoTemporaryPlan,
} from "../../src/pao/workflow/plan.ts";
import { recordPlanFeedback, recordPlanFeedbackDelivery } from "../../src/pao/workflow/plan-feedback.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-desktop-plans-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function 建计划(项目根: string) {
	return createTemporaryPlan({
		项目根,
		显示名: "小说创作",
		来源会话: "sess-1",
		请求ID: "req-1",
		已注册部门: ["策划部", "写作部", "审稿部"],
		步骤: [
			{ 标题: "讨论计划", 部门: "策划部", 要求: "把方向与章节计划讨论清楚", 人工门: true },
			{ 标题: "写初稿", 部门: "写作部", 要求: "按计划写初稿", 依赖: ["s1"] },
		],
		当刻: "2026-10-14 10:00",
	});
}

describe("桌面临时计划只读投影（阶段 4 第 1、3 项）", () => {
	it("项目里没有临时计划目录时是「还没有计划」，不是读失败", () => {
		const 项目根 = tempDir();
		expect(readDesktopPlans(项目根)).toEqual({ 计划: [], 问题: [] });
	});

	it("读到计划定义与步骤摘要：步骤 ID 稳定、依赖与人工门如实", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const result = readDesktopPlans(项目根);
		expect(result.问题).toEqual([]);
		expect(result.计划).toHaveLength(1);
		const plan = result.计划[0]!;
		expect(plan.计划ID).toBe(created.计划ID);
		expect(plan.显示名).toBe("小说创作");
		expect(plan.定义版本).toBe(1);
		expect(plan.已撤销).toBe(false);
		expect(plan.来源会话).toBe("sess-1");
		expect(plan.步骤.map((step) => step.步骤ID)).toEqual(["s1", "s2"]);
		expect(plan.步骤[0]!.人工门).toBe(true);
		expect(plan.步骤[1]!.依赖).toEqual(["s1"]);
		expect(plan.启动).toEqual([]);
		expect(plan.意见).toEqual([]);
	});

	it("真实启动一次后，启动关联里的实例与控制正本一致，状态来自控制正本", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: "sess-1",
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{
				cardsDir: execution.卡目录,
				workspaceDir: execution.工作区,
				ownerSessionId: "sess-1",
			},
		);
		const identity = readPlanInstanceIdentity(execution.工作区, execution.配方名);
		expect(identity).toBeTruthy();
		recordPlanStart(execution.关联路径, {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-1",
			实例: identity!.实例,
			配方名: execution.配方名,
			工作区: execution.工作区,
			卡目录: execution.卡目录,
			控制清单: execution.控制清单,
			owner会话: "sess-1",
			受理时刻: "2026-10-14 10:30",
		});
		const result = readDesktopPlans(项目根);
		expect(result.问题).toEqual([]);
		expect(result.计划[0]!.启动).toHaveLength(1);
		const link = result.计划[0]!.启动[0]!;
		expect(link.启动请求ID).toBe("start-1");
		expect(link.实例).toBe(identity!.实例);
		expect(link.工作区).toBe(execution.工作区);
		expect(link.卡目录).toBe(execution.卡目录);
		expect(link.状态).toBe("运行中");
		// 真实启动后还没有交付卡：进度如实为空产出，界面不许拿预期成果冒充产物。
		expect(link.进度.map((item) => item.步骤ID)).toEqual(["s1", "s2"]);
		expect(link.进度.every((item) => item.产出.length === 0)).toBe(true);
	});

	it("意见按真实状态投影：记录是已记录，投递失败留原因不改写成已送达", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const recorded = await recordPlanFeedback({
			项目根,
			计划ID: created.计划ID,
			期望定义版本: 1,
			目标: { 类型: "步骤", 步骤ID: "s1" },
			正文: "先看一版人物小传再定稿",
			来源会话: "sess-1",
			当刻: "2026-10-14 10:05",
		});
		expect(recorded.entry.状态).toBe("已记录");
		await recordPlanFeedbackDelivery({
			项目根,
			计划ID: created.计划ID,
			意见ID: recorded.entry.意见ID,
			送达: false,
			结果: "部长正在处理，须指定 streamingBehavior，本次拒收",
			来源会话: "sess-1",
			当刻: "2026-10-14 10:06",
		});
		const result = readDesktopPlans(项目根);
		expect(result.计划[0]!.意见).toHaveLength(1);
		const feedback = result.计划[0]!.意见[0]!;
		expect(feedback.意见ID).toBe(recorded.entry.意见ID);
		expect(feedback.状态).toBe("投递失败");
		expect(feedback.投递?.结果).toContain("拒收");
	});

	it("坏定义点名进问题，不静默显示成「还没有计划」", async () => {
		const 项目根 = tempDir();
		await 建计划(项目根);
		mkdirSync(join(项目根, ".pao", "临时工作流", "p-bad"), { recursive: true });
		writeFileSync(planFilePath(项目根, "p-bad"), "---\n显示名: 缺计划ID\n---\n正文\n");
		const result = readDesktopPlans(项目根);
		expect(result.计划).toHaveLength(1);
		expect(result.问题.some((issue) => issue.路径.includes("p-bad") && issue.说明.length > 0)).toBe(true);
	});

	it("坏启动关联点名进问题，计划本身仍可见", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		mkdirSync(join(planDir(项目根, created.计划ID), "启动"), { recursive: true });
		writeFileSync(join(planDir(项目根, created.计划ID), "启动", "start-bad.md"), "");
		const result = readDesktopPlans(项目根);
		expect(result.计划).toHaveLength(1);
		expect(result.计划[0]!.启动).toEqual([]);
		expect(result.问题.some((issue) => issue.路径.includes("start-bad"))).toBe(true);
	});

	it("已撤销的计划仍可见（带撤销标记），不当作不存在", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		await undoTemporaryPlan({
			项目根,
			来源会话: "sess-1",
			计划ID: created.计划ID,
			请求ID: "req-undo-1",
			预期定义版本: 1,
			当刻: "2026-10-14 11:00",
		});
		const result = readDesktopPlans(项目根);
		expect(result.计划[0]!.已撤销).toBe(true);
		expect(result.计划[0]!.定义版本).toBe(2);
	});
});

describe("步骤真实产物投影（阶段 5 第 4 项：产物点击来自真实产物）", () => {
	/** 只喂投影要读的字段：控制正本的完整写入路径由 driver 负责，这里验只读口径。 */
	function fakeFlow(卡目录: string, 卡号: number): FlowControl {
		return {
			版本: 2,
			实例: "实例-1",
			owner: "sess-1",
			脉络: "",
			工作流: "临时-p-1",
			卡目录,
			启动: "",
			状态: "运行中",
			冻结配方: {
				名字: "临时-p-1",
				版本: 2,
				自动执行: false,
				参数: {},
				节点: [{ 名字: "s1", 目标: "写初稿", 部门: "写作部", 验收: "初稿可读", depends_on: [], 人工确认: false }],
				说明: "",
				文件路径: "",
				占位符: [],
				拓扑序: ["s1"],
			},
			参数: {},
			节点: [{ 名字: "s1", 轮次: 1, 卡: [String(卡号)], 拆解结束: true, 历史: [] }],
			回边次数: {},
			记录: [],
		} as unknown as FlowControl;
	}

	it("已交付卡的回执路径落成真实产物：在盘、被删、越界三种真值分别如实", async () => {
		const base = tempDir();
		const 工作区 = join(base, "项目");
		const 卡目录 = join(工作区, ".pao", "卡");
		mkdirSync(卡目录, { recursive: true });
		mkdirSync(join(工作区, "创作成果"), { recursive: true });
		writeFileSync(join(工作区, "创作成果", "初稿.md"), "# 初稿\n");
		writeFileSync(join(base, "越界.md"), "# 越界\n");
		const card = await createCard(卡目录, {
			目标: "写初稿",
			部门: "写作部",
			验收: "初稿可读",
			创建: "2026-10-14 10:00",
			状态: "delivered",
		});
		// 回执尝试号须等于卡面当前尝试；建卡默认 0，这里按真实链路推进到 1。
		card.frontmatter.attempt = 1;
		appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-14 10:30",
			结果: "success",
			摘要: "初稿完成",
			产物路径: ["创作成果/初稿.md", "../越界.md"],
		});
		const first = stepProgress(fakeFlow(卡目录, card.card_no), 工作区);
		expect(first).toHaveLength(1);
		expect(first[0]!.步骤ID).toBe("s1");
		expect(first[0]!.状态).toBe("delivered");
		expect(first[0]!.产出.find((item) => item.路径 === "创作成果/初稿.md")?.存在).toBe(true);
		const 越界 = first[0]!.产出.find((item) => item.路径 === "../越界.md");
		expect(越界?.存在).toBe(false);
		expect(越界?.说明).toContain("越出工作区");
		// 产物事后被移走：仍如实列出，但标成盘上找不到，不冒充「还在」。
		rmSync(join(工作区, "创作成果", "初稿.md"));
		const second = stepProgress(fakeFlow(卡目录, card.card_no), 工作区);
		const 已删 = second[0]!.产出.find((item) => item.路径 === "创作成果/初稿.md");
		expect(已删?.存在).toBe(false);
		expect(已删?.说明).toContain("盘上找不到");
	});

	it("同一路径跨轮次各留一条：历史产物不被去重吞掉，只有最新一轮是当前轮", async () => {
		const base = tempDir();
		const 工作区 = join(base, "项目");
		const 卡目录 = join(工作区, ".pao", "卡");
		mkdirSync(卡目录, { recursive: true });
		mkdirSync(join(工作区, "创作成果"), { recursive: true });
		// 两轮写同一个相对路径：第 1 轮的初稿与第 2 轮的重做稿是两份不同的历史，不许互相覆盖。
		const 路径 = "创作成果/初稿.md";
		writeFileSync(join(工作区, "创作成果", "初稿.md"), "# 初稿\n");
		const 旧卡 = await createCard(卡目录, {
			目标: "写初稿",
			部门: "写作部",
			验收: "初稿可读",
			创建: "2026-10-14 10:00",
			状态: "delivered",
		});
		旧卡.frontmatter.attempt = 1;
		appendReceipt(旧卡, {
			尝试号: 1,
			时间: "2026-10-14 10:30",
			结果: "success",
			摘要: "初稿完成",
			产物路径: [路径],
		});
		const 新卡 = await createCard(卡目录, {
			目标: "按审核意见重写初稿",
			部门: "写作部",
			验收: "初稿可读",
			创建: "2026-10-14 11:00",
			状态: "delivered",
		});
		新卡.frontmatter.attempt = 1;
		appendReceipt(新卡, {
			尝试号: 1,
			时间: "2026-10-14 11:30",
			结果: "success",
			摘要: "按审核意见重写",
			产物路径: [路径],
		});
		const flow = fakeFlow(卡目录, 新卡.card_no);
		// 旧卡退进历史轮次、新卡是当前轮次：模拟控制正本打回重做后的真实形状。
		flow.节点[0]!.历史 = [{ 轮次: 1, 卡: [String(旧卡.card_no)], 原因: "初稿缺结尾" }];
		flow.节点[0]!.轮次 = 2;
		const 进度 = stepProgress(flow, 工作区);
		const 产出 = 进度[0]!.产出;
		// 反例（修复前 byPath 按相对路径覆盖）：同路径两条只剩一条，历史轮次被吞掉。
		expect(产出).toHaveLength(2);
		expect(产出.map((item) => item.相对路径)).toEqual([路径, 路径]);
		expect(产出.map((item) => item.轮次)).toEqual([1, 2]);
		expect(产出.map((item) => item.版本依据)).toEqual([
			`第 1 轮（${formatCardNumber(旧卡.card_no)}）`,
			`第 2 轮（${formatCardNumber(新卡.card_no)}）`,
		]);
		expect(产出.map((item) => item.当前轮)).toEqual([false, true]);
		// 两条都存在：历史那条也得如实报盘上真值，不是合成占位。
		expect(产出.map((item) => item.存在)).toEqual([true, true]);
	});

	it("未交付的卡不贡献产物：进行中的卡即使写了回执也不算「已产出」", async () => {
		const base = tempDir();
		const 工作区 = join(base, "项目");
		const 卡目录 = join(工作区, ".pao", "卡");
		mkdirSync(卡目录, { recursive: true });
		mkdirSync(join(工作区, "创作成果"), { recursive: true });
		writeFileSync(join(工作区, "创作成果", "草稿.md"), "# 草稿\n");
		const card = await createCard(卡目录, {
			目标: "写初稿",
			部门: "写作部",
			验收: "初稿可读",
			创建: "2026-10-14 10:00",
			状态: "in_progress",
		});
		card.frontmatter.attempt = 1;
		appendReceipt(card, {
			尝试号: 1,
			时间: "2026-10-14 10:30",
			结果: "success",
			摘要: "先交一版草稿",
			产物路径: ["创作成果/草稿.md"],
		});
		const progress = stepProgress(fakeFlow(卡目录, card.card_no), 工作区);
		expect(progress[0]!.状态).toBe("in_progress");
		expect(progress[0]!.产出).toEqual([]);
	});

	it("产物判定以项目根和目标双侧真实路径为准：根为链接不误拒，根内链接一律拒绝", () => {
		const base = tempDir();
		const project = join(base, "project");
		const projectLink = join(base, "project-link");
		const outside = join(base, "outside");
		mkdirSync(join(project, "成果"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(project, "成果", "内部.md"), "# 内部\n");
		writeFileSync(join(outside, "外部.md"), "# 外部\n");
		const linkType = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(project, projectLink, linkType);
		symlinkSync(join(project, "成果"), join(project, "内部链接"), linkType);
		symlinkSync(outside, join(project, "外部链接"), linkType);

		const linkedRootArtifact = artifactOf(projectLink, "成果/内部.md", 1, "卡0001", true);
		expect(linkedRootArtifact.存在).toBe(true);
		expect(linkedRootArtifact.说明).toBeUndefined();
		expect(linkedRootArtifact.相对路径).toBe("成果/内部.md");

		const canonicalTargetArtifact = artifactOf(
			projectLink,
			join(realpathSync(project), "成果", "内部.md"),
			1,
			"卡0001",
			true,
		);
		expect(canonicalTargetArtifact.存在).toBe(true);
		expect(canonicalTargetArtifact.说明).toBeUndefined();

		const internalLinkArtifact = artifactOf(project, "内部链接/内部.md", 1, "卡0001", true);
		expect(internalLinkArtifact.存在).toBe(false);
		expect(internalLinkArtifact.说明).toContain("项目内链接");

		const externalLinkArtifact = artifactOf(project, "外部链接/外部.md", 1, "卡0001", true);
		expect(externalLinkArtifact.存在).toBe(false);
		expect(externalLinkArtifact.说明).toContain("真实路径越出项目");
		expect(realpathSync(projectLink)).toBe(realpathSync(project));
		expect(realpathSync(join(project, "外部链接", "外部.md"))).toBe(realpathSync(join(outside, "外部.md")));
	});

	it("产物为目录时明确报 EISDIR", () => {
		const project = tempDir();
		mkdirSync(join(project, "成果"), { recursive: true });

		const artifact = artifactOf(project, "成果", 1, "卡0001", true);

		expect(artifact.存在).toBe(false);
		expect(artifact.说明).toBe("目标是目录（EISDIR）");
	});

	it("卡读不出来时记进读取问题，不当作「没有产物」静默略过", async () => {
		const base = tempDir();
		const 工作区 = join(base, "项目");
		const 卡目录 = join(工作区, ".pao", "卡");
		mkdirSync(卡目录, { recursive: true });
		const progress = stepProgress(fakeFlow(卡目录, 9999), 工作区);
		expect(progress[0]!.产出).toEqual([]);
		expect(progress[0]!.读取问题).toContain("卡 9999 读不出来");
	});

	it("人工门等待位：活干完但未确认才置真，确认后置假（controlView 在确认前不报 delivered）", async () => {
		const base = tempDir();
		const 工作区 = join(base, "项目");
		const 卡目录 = join(工作区, ".pao", "卡");
		mkdirSync(卡目录, { recursive: true });
		const card = await createCard(卡目录, {
			目标: "定稿",
			部门: "策划部",
			验收: "可发布",
			创建: "2026-10-14 10:00",
			状态: "delivered",
		});
		const flow = fakeFlow(卡目录, card.card_no);
		// 把这一步改成人工门：内核在人工确认通过前 completion 为假，状态只会是 in_progress。
		flow.冻结配方.节点[0]!.人工确认 = true;
		const 未确认 = stepProgress(flow, 工作区);
		expect(未确认[0]!.状态).toBe("in_progress");
		expect(未确认[0]!.等待人工确认).toBe(true);
		flow.节点[0]!.确认 = "2026-10-14 11:00";
		const 已确认 = stepProgress(flow, 工作区);
		expect(已确认[0]!.状态).toBe("delivered");
		expect(已确认[0]!.等待人工确认).toBe(false);
	});

	it("执行记录投影：历史轮次的判定与原因照抄，当前轮次补在最后（界面不猜第几次）", async () => {
		const base = tempDir();
		const 工作区 = join(base, "项目");
		const 卡目录 = join(工作区, ".pao", "卡");
		mkdirSync(卡目录, { recursive: true });
		const card = await createCard(卡目录, {
			目标: "定稿",
			部门: "策划部",
			验收: "可发布",
			创建: "2026-10-14 10:00",
			状态: "delivered",
		});
		const flow = fakeFlow(卡目录, card.card_no);
		flow.节点[0]!.历史 = [
			{
				轮次: 1,
				卡: ["0001"],
				判定: { 结果: "change", 理由: "初稿缺结尾", 引用: ["卡0001"], 时间: "2026-10-14 10:20" },
				原因: "审核打回",
			},
		];
		flow.节点[0]!.重做理由 = "按审核意见重写结尾";
		const 进度 = stepProgress(flow, 工作区);
		expect(进度[0]!.记录).toEqual([
			{ 轮次: 1, 卡: ["0001"], 判定: "change", 原因: "初稿缺结尾" },
			{ 轮次: 1, 卡: [String(card.card_no)], 原因: "按审核意见重写结尾" },
		]);
	});

	it("真实启动布局下产物按项目根解析：执行工作区在 .pao 里，真实产物不许被判成越界", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: "sess-1",
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{
				cardsDir: execution.卡目录,
				workspaceDir: execution.工作区,
				ownerSessionId: "sess-1",
			},
		);
		const identity = readPlanInstanceIdentity(execution.工作区, execution.配方名)!;
		recordPlanStart(execution.关联路径, {
			计划ID: created.计划ID,
			定义版本: 1,
			启动请求ID: "start-1",
			实例: identity.实例,
			配方名: execution.配方名,
			工作区: execution.工作区,
			卡目录: execution.卡目录,
			控制清单: execution.控制清单,
			owner会话: "sess-1",
			受理时刻: "2026-10-14 10:01",
		});
		// 派卡提示要求「文件产物写相对项目根的真实路径」；这里就照那个口径产出。
		mkdirSync(join(项目根, "创作成果"), { recursive: true });
		writeFileSync(join(项目根, "创作成果", "初稿.md"), "# 初稿\n");
		const options = {
			cardsDir: execution.卡目录,
			workspaceDir: execution.工作区,
			ownerSessionId: "sess-1",
		};
		const nodeIdentity = { 实例: identity.实例, 节点: "s1", 轮次: 1, 部长会话: "sess-1" };
		await bindMinister(execution.配方, options, "s1", "sess-1");
		const [ref] = await addNodeCards(execution.配方, options, nodeIdentity, [
			{ goal: "写初稿", acceptance: "初稿可读" },
		]);
		changeCardStatus(loadCard(execution.卡目录, parseCardRef(ref!)), {
			操作者: "sess-1",
			to: "in_progress",
			时间: "2026-10-14 10:05",
		});
		appendReceipt(loadCard(execution.卡目录, parseCardRef(ref!)), {
			尝试号: 1,
			时间: "2026-10-14 10:30",
			结果: "success",
			摘要: "初稿完成",
			产物路径: ["创作成果/初稿.md"],
		});
		changeCardStatus(loadCard(execution.卡目录, parseCardRef(ref!)), {
			操作者: "sess-1",
			to: "delivered",
			时间: "2026-10-14 10:31",
		});

		const result = readDesktopPlans(项目根);
		expect(result.问题).toEqual([]);
		const 产出 = result.计划[0]!.启动[0]!.进度[0]!.产出;
		expect(产出).toHaveLength(1);
		expect(产出[0]!.相对路径).toBe("创作成果/初稿.md");
		expect(产出[0]!.存在).toBe(true);
		expect(产出[0]!.说明).toBeUndefined();
	});

	it("临时计划的控制正本埋在 .pao 深处也要被实例扫描发现（否则界面读不到节点状态）", async () => {
		const 项目根 = tempDir();
		const created = await 建计划(项目根);
		const execution = resolvePlanExecution({
			项目根,
			来源会话: "sess-1",
			计划ID: created.计划ID,
			启动请求ID: "start-1",
			定义版本: 1,
		});
		await startWorkflow(
			execution.配方,
			{},
			{
				cardsDir: execution.卡目录,
				workspaceDir: execution.工作区,
				ownerSessionId: "sess-1",
			},
		);
		// 控制正本的真实位置：<项目根>/.pao/临时工作流/<计划ID>/执行/<启动请求>/工作流实例-<配方名>.md
		expect(execution.控制清单).toBe(join(execution.工作区, `工作流实例-${execution.配方名}.md`));
		const flows = readDesktopFlows(项目根);
		expect(flows.问题).toEqual([]);
		expect(flows.工作流.map((flow) => flow.控制.实例)).toEqual([
			readPlanInstanceIdentity(execution.工作区, execution.配方名)!.实例,
		]);
		expect(flows.工作流[0]!.进度.节点.map((node) => node.名字)).toEqual(["s1", "s2"]);
	});
});
