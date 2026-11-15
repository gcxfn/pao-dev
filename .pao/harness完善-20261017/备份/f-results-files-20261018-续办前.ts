/**
 * F 批 R07／R08 验收（内核侧）：成果是文件、右栏能打开旧稿新稿意见。
 *
 * 计划 §13 的两条需求原文：
 *  - R07 成果是文件、右栏能打开、支持旧稿新稿意见；
 *  - R08 日常不读写 JSON、默认可读、原始可展开。
 *
 * 本 spec 只验**内核侧**能证明的三件事，不起界面、不调真实供应商、不 spawn 进程：
 *  1. 成果是真文件：走真实临时计划启动链路（createTemporaryPlan → resolvePlanExecution →
 *     startWorkflow → bindMinister → addNodeCards → 交回执 → 交付），断言成果落在
 *     `创作成果/<计划ID>/<步骤ID>/<轮次>/` 下、是真实文件、内容可读、**不在 `.pao/` 里**；
 *  2. 旧稿新稿意见可同屏取回：同一步骤两个轮次的成果同时存在时，一次读投影给齐
 *     「旧稿路径＋意见＋新稿路径」，且旧稿逐字节未被覆盖；
 *  3. R08 反面：给界面／模型看的投影里有没有可直接展示的中文事实字段，
 *     而不是「只给编号和嵌套 JSON、要读 JSON 才知道发生了什么」。
 *
 * 第 3 条是软性判据，按 Lead 的口径：做不到就如实写成「R08 未满足」，不硬凑断言。
 * 具体做法是把投影摊平成「一句话级事实」逐条检查——断言的是**内容可读性**，
 * 不是「字段名里有没有中文」这种凑数标准。
 *
 * 隔离：全部在 `mkdtempSync` 出来的临时根里跑，PAO_HOME 与项目根各自独立，
 * 结束整体清理；绝不读写正式 PAO_HOME（`D:\AI\workspace\pao`）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { changeCardStatus, loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { readDesktopPlans, type DesktopPlanArtifact, type DesktopPlanStepProgress } from "../../src/pao/desktop/plans.ts";
import { addNodeCards, bindMinister, decideNode, endDecomposition, type NodeIdentity } from "../../src/pao/workflow/control.ts";
import { startWorkflow } from "../../src/pao/workflow/driver.ts";
import type { WorkflowRecipe } from "../../src/pao/workflow/recipe.ts";
import {
	createTemporaryPlan,
	readPlanInstanceIdentity,
	recordPlanStart,
	resolvePlanExecution,
} from "../../src/pao/workflow/plan.ts";

const dirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-f-results-${prefix}-`));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 项目内相对路径统一正斜杠（与 `artifactOf` 的口径一致，断言才可移植）。 */
function toPosix(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

interface 链路 {
	根: string;
	项目根: string;
	计划ID: string;
	配方: WorkflowRecipe;
	配方名: string;
	工作区: string;
	卡目录: string;
	options: { cardsDir: string; workspaceDir: string; ownerSessionId: string };
	identity: { 实例: string };
}

/**
 * 建一份「写初稿 → 审稿」两份步骤的临时计划并真实启动，返回后续交卡要用的全部真值。
 *
 * 为什么真跑启动链路而不是手写控制正本：R07 要证明的是「用户看到的成果文件」，
 * 若控制正本是手搓的，产出的可信度就只等于夹具本身；这里控制正本、卡、回执全部由
 * 生产代码写出来，最后只把「谁的产物」这一件事通过回执表达。
 */
async function 启动最小计划(): Promise<链路> {
	const 根 = tempDir("run");
	const 项目根 = join(根, "项目");
	mkdirSync(项目根, { recursive: true });
	// 部门目录只是给创建计划时的「已注册部门」校验用；本链路不起真实部长，不会去读配方。
	const created = await createTemporaryPlan({
		项目根,
		显示名: "小说第一章",
		来源会话: "sess-1",
		请求ID: "req-1",
		已注册部门: ["写作部", "审稿部"],
		步骤: [
			{ 标题: "写初稿", 部门: "写作部", 要求: "按文风基线写第一章初稿" },
			// 审核节点必须给部门标准、回边只能声明在审核节点上（`src/pao/workflow/recipe.ts:330`、`:348`）；
			// 打回目标 s1 必须能在 s2 的回边里找到，否则 `decideNode` 的前置校验会拒。
			{
				标题: "审稿",
				部门: "审稿部",
				要求: "按文风基线判定初稿",
				依赖: ["s1"],
				审核: true,
				部门标准: "文风基线",
				回边: [{ 目标: "s1", 上限: 2, 超限动作: "停滞" }],
			},
		],
		当刻: "2026-10-17 10:00",
	});
	const 配方名 = `临时计划-${created.计划ID}`;
	const execution = resolvePlanExecution({
		项目根,
		来源会话: "sess-1",
		计划ID: created.计划ID,
		启动请求ID: "start-1",
		定义版本: 1,
	});
	const options = {
		cardsDir: execution.卡目录,
		workspaceDir: execution.工作区,
		ownerSessionId: "sess-1",
	};
	await startWorkflow(execution.配方, {}, options);
	const identity = readPlanInstanceIdentity(execution.工作区, execution.配方名);
	if (!identity) throw new Error("夹具自证失败：启动后读不到实例身份");
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
		受理时刻: "2026-10-17 10:01",
	});
	return {
		根,
		项目根,
		计划ID: created.计划ID,
		配方: execution.配方,
		配方名,
		工作区: execution.工作区,
		卡目录: execution.卡目录,
		options,
		identity,
	};
}

/**
 * 给某一步派一张卡、交回执、交付，再显式交拆解结束。
 *
 * 为什么要交拆解结束：控制正本的 `decideNode`/`addNodeCards` 都要求「节点已就绪」，
 * 而 `ready()` 看的是**前置节点是否 complete**——按真实工作流走就是「上游节点交付后
 * 由它的部长宣布本轮拆解结束」。跳过这一步，下游派卡会被 `节点未就绪或部长会话为空` 拒，
 * 那是夹具漏了生产步骤，不是被测逻辑的问题。
 *
 * 回执里的产物路径按「相对项目根」记录（派卡提示的既有口径），`appendReceipt` 会先做
 * 「路径真实存在」校验——所以这里先把文件写出来，再交回执，顺序不能反。
 */
async function 交一稿(
	link: 链路,
	input: { 节点: "s1" | "s2"; 轮次: number; 相对路径: string; 正文: string; 目标: string; 验收: string },
): Promise<string> {
	const nodeIdentity: NodeIdentity = {
		实例: link.identity.实例,
		节点: input.节点,
		轮次: input.轮次,
		部长会话: "sess-1",
	};
	await bindMinister(link.配方, link.options, input.节点, "sess-1");
	const [ref] = await addNodeCards(link.配方, link.options, nodeIdentity, [
		{ goal: input.目标, acceptance: input.验收 },
	]);
	if (!ref) throw new Error("夹具自证失败：派卡没有返回卡号");
	const 绝对 = join(link.项目根, input.相对路径);
	mkdirSync(join(绝对, ".."), { recursive: true });
	writeFileSync(绝对, input.正文, "utf8");
	changeCardStatus(loadCard(link.卡目录, parseCardRef(ref)), {
		操作者: "sess-1",
		to: "in_progress",
		时间: "2026-10-17 10:05",
	});
	appendReceipt(loadCard(link.卡目录, parseCardRef(ref)), {
		尝试号: 1,
		时间: "2026-10-17 10:30",
		结果: "success",
		摘要: "交了这版草稿",
		产物路径: [input.相对路径],
	});
	changeCardStatus(loadCard(link.卡目录, parseCardRef(ref)), {
		操作者: "sess-1",
		to: "delivered",
		时间: "2026-10-17 10:31",
	});
	await endDecomposition(link.配方, link.options, nodeIdentity);
	return ref;
}

/** 从读投影里取出某一步的进度（找不到就让用例明确失败，不返回 undefined 让后面炸得莫名其妙）。 */
function 取步骤(projectRoot: string, 步骤ID: string): DesktopPlanStepProgress {
	const result = readDesktopPlans(projectRoot);
	expect(result.问题).toEqual([]);
	const plan = result.计划[0];
	expect(plan).toBeTruthy();
	const link = plan!.启动[0];
	expect(link).toBeTruthy();
	const step = link!.进度.find((item) => item.步骤ID === 步骤ID);
	expect(step).toBeTruthy();
	return step!;
}

// ── R07 第 1 条：成果是真文件 ─────────────────────────────────────────────

describe("R07-1 成果是真文件：落在 创作成果/ 下、可读、不在 .pao/ 里", () => {
	it("交付一张卡后，读投影给出的产物是真实文件且内容可读", async () => {
		const link = await 启动最小计划();
		const 相对 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
		const 正文 = "# 第一章\n\n旧桥下的风一直在响。\n";
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 相对, 正文, 目标: "写初稿", 验收: "初稿可读" });

		const step = 取步骤(link.项目根, "s1");
		expect(step.产出).toHaveLength(1);
		const 产出 = step.产出[0]!;
		// 路径真值来自回执，投影只做「落盘核对」，不自己编。
		expect(产出.相对路径).toBe(相对);
		expect(产出.存在).toBe(true);
		expect(产出.说明).toBeUndefined();

		const 绝对 = join(link.项目根, 产出.相对路径);
		expect(statSync(绝对).isFile()).toBe(true);
		// 内容可读且与写进去的逐字节一致：不是占位、不是摘要、不是被改写过的副本。
		expect(readFileSync(绝对, "utf8")).toBe(正文);
	});

	it("成果不落在 .pao/ 里：编排目录下只有卡与控制正本，正文在项目根的正常目录", async () => {
		const link = await 启动最小计划();
		const 相对 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 相对, 正文: "正文\n", 目标: "写初稿", 验收: "初稿可读" });

		const 产出 = 取步骤(link.项目根, "s1").产出[0]!;
		const 相对正斜杠 = 产出.相对路径;
		expect(相对正斜杠.startsWith(".pao/")).toBe(false);
		// 编排目录里确实找不到这份成果的副本：若哪天有人在 .pao/ 下再存一份「界面专用副本」，
		// 这条会红——「一个事实一个家」是本项目公约，成果正文只能有一份。
		expect(existsSync(join(link.项目根, ".pao", "创作成果"))).toBe(false);
		// 卡与控制正本照旧在 .pao/ 下：编排产物与成果正文分家，不混在一起。
		expect(existsSync(link.卡目录)).toBe(true);
		expect(link.工作区.startsWith(join(link.项目根, ".pao"))).toBe(true);
	});

	it("路径按 <计划ID>/<步骤ID>/<轮次> 分层：同一步骤不同轮次的成果不互相覆盖", async () => {
		const link = await 启动最小计划();
		// 两轮写同一步骤：第 1 轮初稿先落地；第 2 轮只有在真被打回重做时才存在（控制正本不允许
		// 手动把轮次往前拨），所以这里走「审稿打回 → s1 进入第 2 轮」的真实路径。
		const 第一轮 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 第一轮, 正文: "第一轮正文\n", 目标: "写初稿", 验收: "初稿可读" });
		const { 新稿: 第二轮 } = await 打回让s1进第二轮(link, { 旧稿: 第一轮, 正文: "第二轮正文\n" });

		const 产出 = 取步骤(link.项目根, "s1").产出;
		expect(产出.map((item) => item.相对路径)).toEqual([第一轮, 第二轮]);
		expect(产出.every((item) => item.存在)).toBe(true);
		// 分层是真目录分层，不是只在投影里写的字符串：两份正文各自在盘上。
		expect(readFileSync(join(link.项目根, 第一轮), "utf8")).toBe("第一轮正文\n");
		expect(readFileSync(join(link.项目根, 第二轮), "utf8")).toBe("第二轮正文\n");
	});
});

// ── R07 第 2 条：旧稿新稿意见可同屏取回 ───────────────────────────────────

/**
 * 让某个步骤进入下一轮：由下游审稿节点按文风基线打回它。
 *
 * 为什么必须这样：控制正本的 `identify()`（`src/pao/workflow/control.ts:407-419`）要求
 * `identity.轮次 === node.轮次`，轮次是**控制正本自己往前拨的**（`decideNode` 的 change 分支
 * 才做 `target.轮次++` 并把旧轮次的卡压进 `历史`）。所以「同一步骤的第 2 轮」在真实系统里
 * 只有一个来源：第 1 轮通过审核、被判定打回、回边把它放回上游。手动拿轮次 2 去派卡会被拒，
 * 这是设计在防「凭空造轮次」，不是夹具写错。
 */
async function 打回让s1进第二轮(
	link: 链路,
	input: { 旧稿: string; 正文: string; 打回理由?: string; 新稿?: string },
): Promise<{ 新稿: string; 打回理由: string }> {
	const 打回理由 = input.打回理由 ?? "初稿缺结尾，人物动机没交代清楚";
	await 交一稿(link, {
		节点: "s2",
		轮次: 1,
		相对路径: `创作成果/${link.计划ID}/s2/1/审稿意见.md`,
		正文: `${打回理由}\n`,
		目标: "审稿",
		验收: "给出判定",
	});
	await decideNode(
		link.配方,
		link.options,
		{ 实例: link.identity.实例, 节点: "s2", 轮次: 1, 部长会话: "sess-1" },
		{ 结果: "change", 理由: 打回理由, 失败轴: "card", 引用: [`${input.旧稿}:1`], 目标: "s1" },
	);
	const 新稿 = input.新稿 ?? `创作成果/${link.计划ID}/s1/2/初稿.md`;
	await 交一稿(link, { 节点: "s1", 轮次: 2, 相对路径: 新稿, 正文: input.正文, 目标: "重写初稿", 验收: "初稿可读" });
	return { 新稿, 打回理由 };
}

/**
 * 造出「第 1 轮被打回、第 2 轮重做」的真实控制状态。
 *
 * 为什么走 `decideNode` 打回而不是手改控制正本：只有真实打回才会把当前轮次的卡压进节点
 * `历史`、把 `轮次++`、并写下 `重做理由`，这样「旧稿是第 1 轮、新稿是第 2 轮、意见是打回理由」
 * 三件事才有同一个来源。手搓控制正本的话，断言的只是夹具自己的假设。
 */
async function 造出打回重做(): Promise<{ link: 链路; 旧稿: string; 新稿: string; 打回理由: string }> {
	const link = await 启动最小计划();
	const 旧稿 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
	await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 旧稿, 正文: "第一轮：旧桥下的风\n", 目标: "写初稿", 验收: "初稿可读" });
	// 审稿节点按文风基线打回写作节点：真实回边会让 s1 进入第 2 轮。
	const { 新稿, 打回理由 } = await 打回让s1进第二轮(link, {
		旧稿,
		正文: "第二轮：旧桥下的风，结尾补上了\n",
	});
	return { link, 旧稿, 新稿, 打回理由 };
}

describe("R07-2 旧稿新稿意见同屏取回：一次读投影给齐，旧稿不被覆盖", () => {
	it("同一读投影里能同时拿到旧稿、新稿与打回意见，一次不用翻两处", async () => {
		const { link, 旧稿, 新稿, 打回理由 } = await 造出打回重做();
		const step = 取步骤(link.项目根, "s1");

		// 旧稿与新稿同时在场，且各自标明属于哪一轮。
		expect(step.产出.map((item) => item.相对路径)).toEqual([旧稿, 新稿]);
		expect(step.产出.map((item) => item.轮次)).toEqual([1, 2]);
		expect(step.产出.map((item) => item.当前轮)).toEqual([false, true]);
		expect(step.产出.every((item) => item.存在)).toBe(true);

		// 意见在同一次投影里：历史第 1 轮带着打回原因，当前第 2 轮带着重做原因。
		const 一轮 = step.记录.find((item) => item.轮次 === 1);
		expect(一轮).toBeTruthy();
		expect(一轮!.原因).toBe(打回理由);

		// 三样东西同屏：这个断言是 R07「右栏能打开旧稿新稿意见」的内核侧等价物。
		expect({
			旧稿: step.产出[0]!.相对路径,
			意见: 一轮!.原因,
			新稿: step.产出[1]!.相对路径,
		}).toEqual({ 旧稿, 意见: 打回理由, 新稿 });
	});

	it("旧稿没被新稿覆盖：两份文件逐字节各是各的", async () => {
		const { link, 旧稿, 新稿 } = await 造出打回重做();
		取步骤(link.项目根, "s1");

		const 旧文 = readFileSync(join(link.项目根, 旧稿), "utf8");
		const 新文 = readFileSync(join(link.项目根, 新稿), "utf8");
		expect(旧文).toBe("第一轮：旧桥下的风\n");
		expect(新文).toBe("第二轮：旧桥下的风，结尾补上了\n");
		expect(旧文).not.toBe(新文);
		// 两份是不同的文件，不是同一个路径的两次快照。
		expect(join(link.项目根, 旧稿)).not.toBe(join(link.项目根, 新稿));
	});

	it.fails("判断打回的那一轮：`判定` 原文取不到，只剩原因（已知缺口，钉住不掩盖）", async () => {
		const { link, 打回理由 } = await 造出打回重做();
		const 一轮 = 取步骤(link.项目根, "s1").记录.find((item) => item.轮次 === 1)!;
		// 原因拿得到：界面能显示「为什么被打回」。
		expect(一轮.原因).toBe(打回理由);
		// 但被打回的那一轮，`判定` 是空的——真值在控制正本的 `历史[].判定` 里，
		// `src/pao/desktop/plans.ts:243-248` 的 `stepRecords` 只写了 `round.判定?.结果` 而
		// `decideNode`（`src/pao/workflow/control.ts:654`）压进历史的 `判定` 是审核**自己**那一轮的
		// （`target.判定` 已被上面的 change 分支清成 undefined），于是「谁判的、判成什么」这一层丢了。
		// 这是读投影的缺口，不是本用例的断言错；F 批写范围含 plans.ts，但改它属 R07 之外的
		// 语义调整，按 Lead 口径先用可执行断言钉住现状并报上去，不在这里偷偷改。
		expect(一轮.判定).toBe("change");
	});

	it("同一路径跨轮次也各留一条：历史版本不被去重吞掉", async () => {
		const link = await 启动最小计划();
		// 两轮写同一个相对路径：第 1 轮的初稿与第 2 轮的重做稿落在同一个文件名上，
		// 但在投影里必须各留一条——否则界面会把「上一版」和「这一版」当成同一份。
		const 路径 = `创作成果/${link.计划ID}/s1/初稿.md`;
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 路径, 正文: "第一版\n", 目标: "写初稿", 验收: "初稿可读" });
		await 打回让s1进第二轮(link, { 旧稿: 路径, 正文: "第二版\n", 新稿: 路径 });

		const 产出 = 取步骤(link.项目根, "s1").产出;
		expect(产出).toHaveLength(2);
		expect(产出.map((item) => item.相对路径)).toEqual([路径, 路径]);
		expect(产出.map((item) => item.轮次)).toEqual([1, 2]);
		// 同名路径只有一份实际文件：第 2 轮覆盖了盘上内容，所以「旧版本存在」这件事只由
		// 投影的轮次记录保证——这正是这条用例要钉住的点（旧版 Map 去重会把第 1 轮整条吞掉）。
		expect(产出.map((item) => item.当前轮)).toEqual([false, true]);
		expect(产出.every((item) => item.存在)).toBe(true);
	});
});

// ── R08 反面：投影要给人话，不要让人读 JSON ───────────────────────────────

describe("R08 投影含可直接展示的中文事实字段（不是嵌套 JSON 驱动）", () => {
	/**
	 * 把一步的投影摊平成「一句话级事实」：字段名带中文单位词，值本身能直接读。
	 *
	 * 判据是**内容可读性**而不是键名好看：一条事实要么是「第 1 轮（卡0001）」这种自带语义的
	 * 中文串，要么是能被界面直接渲染的路径/数字。下面逐项检查，不做「字段名里有没有中文」这种
	 * 凑数判断。
	 */
	function 摊成事实(step: DesktopPlanStepProgress): string[] {
		const facts: string[] = [];
		// 判定原文是 pass/change/reject 机器话，摊平给界面时译成中文——这正是「R08 默认可读」该做的事。
		const 判定中文: Record<string, string> = { pass: "通过", change: "打回重做", reject: "拒绝" };
		facts.push(`这一步是：${step.步骤ID}`);
		facts.push(`现在怎么样：${step.状态}`);
		if (step.轮次 !== undefined) facts.push(`做到第几轮：${step.轮次}`);
		if (step.挂起 !== undefined) facts.push(`为什么停着：${step.挂起}`);
		if (step.已确认 !== undefined) facts.push(`谁确认过：${step.已确认}`);
		facts.push(step.需要人工确认 ? "要不要人点头：要" : "要不要人点头：不要");
		facts.push(step.等待人工确认 ? "是不是在等人：是" : "是不是在等人：不是");
		for (const 记录 of step.记录) {
			facts.push(`第 ${记录.轮次} 轮执行过，卡：${记录.卡.join("、") || "（无）"}`);
			if (记录.判定 !== undefined) facts.push(`第 ${记录.轮次} 轮判定：${判定中文[记录.判定] ?? 记录.判定}`);
			if (记录.原因 !== undefined) facts.push(`第 ${记录.轮次} 轮为什么：${记录.原因}`);
		}
		for (const 产出 of step.产出) {
			facts.push(`${产出.版本依据}产出：${产出.相对路径}`);
			facts.push(`${产出.版本依据}状态：这份文件${产出.存在 ? "在盘上" : `不在盘上（${产出.说明 ?? "原因未记录"}）`}`);
		}
		return facts;
	}

	it("产物自带「第几轮哪张卡产出的」：界面不用自己去拼版本号", async () => {
		const link = await 启动最小计划();
		const 相对 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 相对, 正文: "正文\n", 目标: "写初稿", 验收: "初稿可读" });

		const 产出: DesktopPlanArtifact = 取步骤(link.项目根, "s1").产出[0]!;
		// 版本依据是人话，不是裸数字：`第 1 轮（卡0001）`。
		expect(产出.版本依据).toMatch(/^第 \d+ 轮（卡\d+）$/);
		expect(产出.版本依据).toContain("第 1 轮");
	});

	it("缺文件时给的是中文原因句，不是一个空字段让人猜", async () => {
		const link = await 启动最小计划();
		const 相对 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 相对, 正文: "正文\n", 目标: "写初稿", 验收: "初稿可读" });
		// 产物事后被移走：投影仍列出它，但必须说清「为什么打不开」。
		rmSync(join(link.项目根, 相对));
		const 产出 = 取步骤(link.项目根, "s1").产出[0]!;
		expect(产出.存在).toBe(false);
		expect(产出.说明).toBeTruthy();
		expect(产出.说明!).toMatch(/盘上找不到|不是普通文件|越出/);
		// 原因句是给人读的完整中文说明，不是错误码。
		expect(产出.说明!.length).toBeGreaterThan(6);
	});

	it("整步投影摊得成人话事实表：每条都能直接展示，不需要读 JSON 才知道发生了什么", async () => {
		const { link, 旧稿, 新稿, 打回理由 } = await 造出打回重做();
		const step = 取步骤(link.项目根, "s1");
		const facts = 摊成事实(step);

		// 事实表里出现过「谁、第几轮、为什么、哪份文件」，也就是 R07 同屏要求的人话版。
		expect(facts.some((line) => line.includes("第 2 轮"))).toBe(true);
		expect(facts.some((line) => line.includes(打回理由))).toBe(true);
		expect(facts.some((line) => line.includes(旧稿))).toBe(true);
		expect(facts.some((line) => line.includes(新稿))).toBe(true);
		// 每条事实左边都有中文标签（「…：」或「这一步是：」这种），不是裸键值对。
		for (const line of facts) expect(line).toMatch(/：/);
	});
});

// ── 未满足项如实声明 ─────────────────────────────────────────────────────

describe("R08 未满足之处：如实记录，不硬凑断言", () => {
	/**
	 * 这两条是**已知未满足**，用 `it.fails` 钉住，一旦有人补齐它会变红提醒改回普通用例。
	 *
	 * 为什么不做：R08 说的是「日常不读写 JSON、默认可读、原始可展开」——这块的现状是
	 * 读投影层（`src/pao/desktop/plans.ts`）已经是人话字段了，但**卡片正文、控制正本的
	 * 原始层仍是 YAML frontmatter**，界面若要「原始可展开」必须自己去读 YAML。
	 * 补它要动卡片协议与读投影的默认展开策略，属跨模块设计改动，不在 F 批写范围，
	 * 按 Lead 口径如实报「未满足」，不在这里糊一条假绿的断言。
	 */
	it.fails("R08 待补：投影自身不带「原始层」入口，界面要展开原文只能自己去解析 YAML", async () => {
		const link = await 启动最小计划();
		const 相对 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 相对, 正文: "正文\n", 目标: "写初稿", 验收: "初稿可读" });
		const step = 取步骤(link.项目根, "s1") as unknown as Record<string, unknown>;
		// 期望：投影直接给一段能原样展开的原文。现状：没有这个字段，于是这里的断言必然失败——
		// 这正是「R08 未满足」的可执行证据，而不是一句口头声明。
		expect(step.原始层).toBeTruthy();
	});

	it.fails("R08 待补：控制正本没有投影级「给人读的一整段」，界面要自己拼", async () => {
		const link = await 启动最小计划();
		const 相对 = `创作成果/${link.计划ID}/s1/1/初稿.md`;
		await 交一稿(link, { 节点: "s1", 轮次: 1, 相对路径: 相对, 正文: "正文\n", 目标: "写初稿", 验收: "初稿可读" });
		const result = readDesktopPlans(link.项目根) as unknown as { 人话摘要?: string };
		// 现状：`readDesktopPlans` 只返回结构化对象，没有一整段可直接贴给人看的摘要。
		expect(result.人话摘要).toBeTruthy();
	});
});
