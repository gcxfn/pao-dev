/**
 * 工作流注册入口：pao_start_flow/pao_push_flow/pao_query_flow/pao_confirm_flow 四工具＋ /pao flow 子命令（see/confirm 二级动词）。
 * 用 fakePi 截获注册（同 cards-tools 测试写法）；PAO_HOME 用 fixture 目录注入（resolvePaoHome 与环境变量两路都测）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { listCards, loadCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import * as atomic from "../../src/pao/shared/atomic.ts";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";
import { withFileLock } from "../../src/pao/shared/lock.ts";
import { startControl } from "../../src/pao/workflow/control.ts";
import { parseManifest } from "../../src/pao/workflow/driver.ts";
import { loadRecipe } from "../../src/pao/workflow/recipe.ts";
import { registerWorkflowTools } from "../../src/pao/workflow/tools.ts";

let paoHome: string;
let cardsDir: string;
const envBackup = process.env.PAO_HOME;

beforeEach(() => {
	paoHome = mkdtempSync(join(tmpdir(), "pao-flow-tools-"));
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
	cardsDir = join(paoHome, "任务-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	if (envBackup === undefined) delete process.env.PAO_HOME;
	else process.env.PAO_HOME = envBackup;
	rmSync(paoHome, { recursive: true, force: true });
});

const flowRecipe = `---
名字: 大活流程
参数: [仓库]
节点:
  - 名字: 澄清
    部门: 规划部
    目标: "澄清 {仓库} 的原始意图"
    验收: 澄清纪要落盘
  - 名字: 规划
    部门: 规划部
    目标: "产出 {仓库} 的实施计划"
    验收: 计划落盘
    depends_on: [澄清]
    人工确认: true
---
`;

interface RegisteredTool {
	name: string;
	description: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: { type: string; text: string }[] }>;
}

interface RegisteredCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

function setup(options?: Parameters<typeof registerWorkflowTools>[1]) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const messages: { customType: string; text: string }[] = [];
	const eventHandlers = new Map<string, ((event: unknown) => void)[]>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, definition: RegisteredCommand) => commands.set(name, definition),
		sendMessage: (message: { customType: string; content: { type: string; text: string }[] }) =>
			messages.push({ customType: message.customType, text: message.content.map((part) => part.text).join("\n") }),
		on: (event: string, handler: (event: unknown) => void) => {
			eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	resetPaoSubcommandsForTest();
	registerWorkflowTools(pi, options);
	const fireBeforeAgentStart = (): Record<string, string> => {
		const sections: Record<string, string> = {};
		for (const handler of eventHandlers.get("before_agent_start") ?? [])
			handler({ systemPromptOptions: { sections } });
		return sections;
	};
	const runSub = async (name: string, args = "", ctx: unknown = {}) => {
		const sub = listPaoSubcommands(pi).find((entry) => entry.name === name);
		if (!sub) throw new Error(`子命令 ${name} 未注册`);
		await sub.run(pi, args, ctx);
	};
	return { tools, commands, messages, runSub, fireBeforeAgentStart, pi };
}

async function runTool(tool: RegisteredTool, params: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	const result = await tool.execute("test-call", params, signal);
	return result.content.map((part) => part.text).join("\n");
}

function writeRecipe(): void {
	writeFileSync(join(paoHome, "工作流", "大活流程.md"), flowRecipe, "utf8");
}

function fixtureOptions(): { resolvePaoHome: () => string; resolveCardsDir: () => string } {
	return {
		resolvePaoHome: () => paoHome,
		resolveCardsDir: () => cardsDir,
	};
}

function advanceCard(cardNo: number, to: "in_progress" | "delivered"): void {
	const card = loadCard(cardsDir, cardNo);
	const updated = changeCardStatus(card, { 操作者: "测试员", to, 时间: "2026-10-02 10:05" });
	writeFileAtomic(updated.path, serializeCard(updated.frontmatter, updated.body));
}

describe("registerWorkflowTools 注册面", () => {
	test("结构化动作传递取消信号，不落配方或启动卡", async () => {
		const mock = setup(fixtureOptions());
		const signal = AbortSignal.abort(new Error("桌面动作已取消"));
		await expect(
			mock.runSub("flow", `save ${JSON.stringify({ name: "大活流程", content: flowRecipe })}`, { signal }),
		).rejects.toThrow("桌面动作已取消");
		expect(existsSync(join(paoHome, "工作流", "大活流程.md"))).toBe(false);
		writeRecipe();
		await expect(
			mock.runSub("flow", `start ${JSON.stringify({ name: "大活流程", params: { 仓库: "样本" } })}`, { signal }),
		).rejects.toThrow("桌面动作已取消");
		expect(listCards(cardsDir)).toEqual([]);
		await expect(
			mock.runSub("flow", `control ${JSON.stringify({ name: "大活流程", action: "resume" })}`, { signal }),
		).rejects.toThrow("桌面动作已取消");
	});
	test("结构化 start/save/control 复用工具，失败向调用方上抛", async () => {
		const mock = setup(fixtureOptions());
		await mock.runSub("flow", `save ${JSON.stringify({ name: "大活流程", content: flowRecipe })}`);
		expect(readFileSync(join(paoHome, "工作流", "大活流程.md"), "utf8")).toBe(flowRecipe);
		await mock.runSub("flow", `start ${JSON.stringify({ name: "大活流程", params: { 仓库: "中文空格 项目" } })}`);
		expect(listCards(cardsDir).length).toBeGreaterThan(0);
		await expect(
			mock.runSub("flow", `save ${JSON.stringify({ name: "大活流程", content: flowRecipe })}`),
		).rejects.toThrow();
		await expect(
			mock.runSub("flow", `control ${JSON.stringify({ name: "大活流程", action: "resume" })}`),
		).rejects.toThrow();
		await expect(mock.runSub("flow", "start {bad json")).rejects.toThrow();
	});
	test("注册九工具与 flow 子命令，description 为中文", () => {
		writeRecipe();
		const { tools, commands, pi } = setup(fixtureOptions());
		expect([...tools.keys()].sort()).toEqual([
			"pao_confirm_flow",
			"pao_control_node",
			"pao_decision_pack",
			"pao_push_flow",
			"pao_query_flow",
			"pao_review_flow",
			"pao_save_flow",
			"pao_start_flow",
			"pao_write_recipe",
		]);
		expect([...commands.keys()]).toEqual([]); // 命令统一:模块不再注册独立命令
		const flow = listPaoSubcommands(pi).find((sub) => sub.name === "flow");
		expect(flow).toBeDefined();
		expect(flow?.description).toContain("see");
		expect(flow?.description).toContain("confirm");
		for (const tool of tools.values()) {
			expect(tool.description.length).toBeGreaterThan(10);
			expect(/[\u4e00-\u9fff]/.test(tool.description)).toBe(true);
		}
	});
});

describe("pao_ 启流/推流/查流/确认流", () => {
	test.each(["pao_start_flow", "pao_push_flow", "pao_confirm_flow"])(
		"%s 实际等待发号锁时取消，不发号或新落卡，已有映射保留",
		async (toolName) => {
			writeFileSync(
				join(paoHome, "工作流", "大活流程.md"),
				toolName === "pao_confirm_flow"
					? flowRecipe.replace("验收: 澄清纪要落盘", "验收: 澄清纪要落盘\n    人工确认: true")
					: flowRecipe,
			);
			const { tools } = setup(fixtureOptions());
			if (toolName !== "pao_start_flow") {
				await runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } });
				advanceCard(1, "in_progress");
				advanceCard(1, "delivered");
			}
			const counterPath = join(cardsDir, "..", "..", "卡号.txt");
			const count = toolName === "pao_start_flow" ? "0" : readFileSync(counterPath, "utf8").trim();
			writeFileSync(counterPath, `${count}\n`);
			let releaseLock = () => {};
			let signalLocked = () => {};
			const lockReady = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const lockHeld = new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
			const holder = withFileLock(counterPath, async () => {
				signalLocked();
				await lockHeld;
			});
			await lockReady;
			const controller = new AbortController();
			const params: Record<string, unknown> = { name: "大活流程" };
			if (toolName === "pao_start_flow") params.params = { 仓库: "pao" };
			if (toolName === "pao_confirm_flow") params.node = "澄清";
			const pending = runTool(tools.get(toolName)!, params, controller.signal);
			const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
			try {
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
				controller.abort();
				releaseLock();
				await holder;
				await cancelled;
			} finally {
				controller.abort();
				releaseLock();
				await holder;
				await cancelled;
			}
			expect(readFileSync(counterPath, "utf8").trim()).toBe(count);
			expect(listCards(cardsDir)).toHaveLength(toolName === "pao_start_flow" ? 0 : 1);
			const manifest = join(cardsDir, "..", "工作流实例-大活流程.md");
			if (toolName === "pao_start_flow") {
				expect(existsSync(manifest)).toBe(false);
				await expect(runTool(tools.get(toolName)!, params)).resolves.toContain("澄清→卡0001");
			} else {
				const view = await runTool(tools.get("pao_query_flow")!, { name: "大活流程" });
				expect(view).toContain("澄清：卡0001");
				expect(view).not.toContain("重建");
				if (toolName === "pao_confirm_flow") expect(view).toContain("人工门已确认");
				await expect(runTool(tools.get("pao_push_flow")!, { name: "大活流程" })).resolves.toContain("规划→卡0002");
			}
		},
	);

	test("同一批已落卡后取消，保留流标记和映射，后续节点下次推进才落卡", async () => {
		writeFileSync(join(paoHome, "工作流", "大活流程.md"), flowRecipe.replace("    depends_on: [澄清]\n", ""));
		const { tools } = setup(fixtureOptions());
		const controller = new AbortController();
		const originalWrite = atomic.writeFileAtomic;
		// 模拟用户在第一张卡已写好流标记时取消；文件写入和工具入口均使用真实实现。
		const writes = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, text) => {
			originalWrite(path, text);
			if (text.includes("<!-- pao-workflow:流=大活流程/节点=澄清 -->")) controller.abort();
		});
		await expect(
			runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } }, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		writes.mockRestore();
		expect(listCards(cardsDir).map((card) => card.card_no)).toEqual([1]);
		expect(loadCard(cardsDir, 1).body).toContain("pao-workflow:流=大活流程/节点=澄清");
		const manifest = parseManifest(readFileSync(join(cardsDir, "..", "工作流实例-大活流程.md"), "utf8"));
		expect(manifest.节点).toEqual([{ 名字: "澄清", 卡号: "卡0001", 挂起: undefined, 确认: undefined }]);
		expect(manifest.参数).toEqual({ 仓库: "pao" });
		await expect(runTool(tools.get("pao_push_flow")!, { name: "大活流程" })).resolves.toContain("规划→卡0002");
		expect(listCards(cardsDir).map((card) => card.card_no)).toEqual([1, 2]);
	});

	test("pao_start_flow：校验参数、写清单、落首批卡", async () => {
		writeRecipe();
		const { tools } = setup(fixtureOptions());
		const text = await runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } });
		expect(text).toContain("工作流「大活流程」状态：running");
		expect(text).toContain("澄清→卡0001");
		expect(loadCard(cardsDir, 1).frontmatter.goal).toBe("澄清 pao 的原始意图");

		// 重复启动拒绝
		await expect(
			runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } }),
		).rejects.toThrowError(/\[FLOW_EXISTS\]/);
	});

	test("显式卡目录切换项目后，同名流的清单和后续推进都留在该项目", async () => {
		writeRecipe();
		const otherCards = join(paoHome, "另一项目", ".pao", "卡");
		const { tools } = setup({
			...fixtureOptions(),
			resolveWorkspaceDir: () => join(paoHome, "任务-20261002"),
		});
		await runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "默认项目" } });
		await runTool(tools.get("pao_start_flow")!, {
			name: "大活流程",
			params: { 仓库: "另一项目" },
			cards_dir: otherCards,
		});
		expect(existsSync(join(otherCards, "..", "工作流实例-大活流程.md"))).toBe(true);
		expect(loadCard(otherCards, 1).frontmatter.goal).toBe("澄清 另一项目 的原始意图");
		const view = await runTool(tools.get("pao_query_flow")!, { name: "大活流程", cards_dir: otherCards });
		expect(view).toContain("卡0001");
		await expect(
			runTool(tools.get("pao_push_flow")!, { name: "大活流程", cards_dir: otherCards }),
		).resolves.toContain("running");
	});

	test("v2 实例读冻结配方：启动后编辑配方文件，查流/推流仍按冻结图走（编辑不改变旧实例）", async () => {
		const { tools } = setup({ ...fixtureOptions(), resolveOwnerSessionId: () => "session-1" });
		const body = (nodes: string) => `---\n版本: 2\n名字: 冻结流\n参数: []\n节点:\n${nodes}---\n说明: v2\n`;
		const first = "  - 名字: 甲\n    部门: 规划部\n    目标: 甲活\n    验收: 甲落盘\n";
		writeFileSync(join(paoHome, "工作流", "冻结流.md"), body(first), "utf8");
		// 经控制入口启动（本测试只钉 loadRecipeFor 的冻结读取，不走 v2 启流的部门预检）
		await startControl(loadRecipe(paoHome, "冻结流"), {}, { cardsDir, ownerSessionId: "session-1" });
		// 启动后编辑配方文件：新增节点乙
		writeFileSync(
			join(paoHome, "工作流", "冻结流.md"),
			body(`${first}  - 名字: 乙\n    部门: 规划部\n    目标: 乙活\n    验收: 乙落盘\n    depends_on: [甲]\n`),
			"utf8",
		);
		const seen = await runTool(tools.get("pao_query_flow")!, { name: "冻结流" });
		expect(seen).toContain("甲");
		expect(seen).not.toContain("乙");
		await expect(runTool(tools.get("pao_push_flow")!, { name: "冻结流" })).resolves.not.toContain("乙");
	});

	test("pao_start_flow 缺参数 → [RECIPE_PARAM_MISSING]，未落卡", async () => {
		writeRecipe();
		const { tools } = setup(fixtureOptions());
		await expect(runTool(tools.get("pao_start_flow")!, { name: "大活流程" })).rejects.toThrowError(
			/\[RECIPE_PARAM_MISSING\]/,
		);
	});

	test("pao_start_flow 不存在的配方 → [RECIPE_NOT_FOUND] 不崩", async () => {
		const { tools } = setup(fixtureOptions());
		await expect(runTool(tools.get("pao_start_flow")!, { name: "没有的流" })).rejects.toThrowError(
			/\[RECIPE_NOT_FOUND\]/,
		);
	});

	test("全链：启流→交付→推流→人工门→确认流放行", async () => {
		writeRecipe();
		const { tools } = setup(fixtureOptions());
		await runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } });

		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		const tickText = await runTool(tools.get("pao_push_flow")!, { name: "大活流程" });
		expect(tickText).toContain("规划→卡0002");
		expect(tickText).toContain("（unclaimed）");

		// 卡未交付不许确认
		await expect(runTool(tools.get("pao_confirm_flow")!, { name: "大活流程", node: "规划" })).rejects.toThrowError(
			/\[FLOW_NOT_DELIVERED\]/,
		);

		advanceCard(2, "in_progress");
		advanceCard(2, "delivered");
		const gatedText = await runTool(tools.get("pao_query_flow")!, { name: "大活流程" });
		expect(gatedText).toContain("状态：hold");
		expect(gatedText).toContain("等待人工确认");
		expect(gatedText).toContain("✅ 规划：卡0002（delivered）"); // 二批图形化：已交付节点行首 ✅

		const confirmText = await runTool(tools.get("pao_confirm_flow")!, { name: "大活流程", node: "规划" });
		expect(confirmText).toContain("人工门已确认");
		expect(confirmText).toContain("状态：completed");
	});

	test("pao_query_flow：清单缺失时走卡标记重建，报告带说明", async () => {
		writeRecipe();
		const { tools } = setup(fixtureOptions());
		await runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } });
		unlinkSync(join(paoHome, "任务-20261002", "工作流实例-大活流程.md"));
		const text = await runTool(tools.get("pao_query_flow")!, { name: "大活流程" });
		expect(text).toContain("重建");
		expect(text).toContain("卡0001");
	});

	test("未提供卡目录且无注入 → 明确报错不崩", async () => {
		writeRecipe();
		const { tools } = setup({ resolvePaoHome: () => paoHome });
		await expect(
			runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } }),
		).rejects.toThrowError(/未提供卡目录/);
	});

	test("PAO_HOME 环境变量缺省解析（未传 resolvePaoHome）", async () => {
		writeRecipe();
		process.env.PAO_HOME = paoHome;
		const { tools } = setup();
		const text = await runTool(tools.get("pao_start_flow")!, {
			name: "大活流程",
			params: { 仓库: "pao" },
			cards_dir: cardsDir,
		});
		expect(text).toContain("澄清→卡0001");
	});
});

describe("/pao flow 子命令", () => {
	test("无参列出可用配方；带参一键启动并回显落卡", async () => {
		writeRecipe();
		const { messages, runSub } = setup(fixtureOptions());
		await runSub("flow", "");
		expect(messages[0].text).toContain("可用工作流配方：大活流程");

		await runSub("flow", "大活流程 仓库=pao");
		expect(messages[1].text).toContain("澄清→卡0001");

		// 参数不写 键=值 → 明确报错
		await runSub("flow", "大活流程 仓库pao");
		expect(messages[2].text).toContain("键=值");
	});

	test("flow see 与 flow confirm：查进度与人工门放行", async () => {
		writeRecipe();
		const { messages, runSub } = setup(fixtureOptions());
		await runSub("flow", "大活流程 仓库=pao");
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		await runSub("flow", "see 大活流程");
		expect(messages[1].text).toContain("工作流「大活流程」状态：running");
		expect(messages[1].text).toContain("卡0001");

		// 澄清未标人工门 → 拒绝确认
		await runSub("flow", "confirm 大活流程 澄清");
		expect(messages[2].text).toContain("未标人工确认");

		// 缺节点名 → 用法提示
		await runSub("flow", "confirm 大活流程");
		expect(messages[3].text).toContain("用法：/pao flow confirm <名字> <节点>");
	});

	test("flow confirm 手动配方：点头后渲染报告（手动链不进自动链）", async () => {
		writeFileSync(
			join(paoHome, "工作流", "单门流.md"),
			`---
名字: 单门流
参数: [仓库]
节点:
  - 名字: 把关
    部门: 规划部
    目标: "把关 {仓库}"
    验收: 结论落盘
    人工确认: true
---
`,
		);
		const { messages, runSub } = setup(fixtureOptions());
		await runSub("flow", "单门流 仓库=pao");
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		await runSub("flow", "confirm 单门流 把关");
		expect(messages[1].text).toContain("人工门已确认");
		expect(messages[1].text).toContain("状态：completed");
	});

	test("未注入默认卡目录时 flow 给出指引而不是空路径崩溃", async () => {
		writeRecipe();
		const { messages, runSub } = setup({ resolvePaoHome: () => paoHome });
		await runSub("flow", "大活流程 仓库=pao");
		expect(messages[0].text).toContain("默认卡目录");
	});
});

describe("跑后复盘终态提醒（十八批,§11.6）", () => {
	test("推流到终态→下一轮 before_agent_start 注入 pao-workflow-review,消费式一次", async () => {
		writeRecipe();
		// 全交付终态:澄清＋规划（人工门）都已确认——直接推流得已完成报告
		const mkCard = (cardNo: number, goal: string, node: string) =>
			writeFileAtomic(
				join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-${goal}.md`),
				serializeCard(
					{
						goal: goal,
						dept: "规划部",
						acceptance: "包含: x",
						attempt: 1,
						created: "2026-10-03 10:00",
						completed: "2026-10-03 11:00",
						status: "delivered",
					},
					`<!-- pao-workflow:流=大活流程/节点=${node} -->\n\n正文`,
				),
			);
		mkCard(1, "澄清", "澄清");
		mkCard(2, "规划", "规划");
		writeFileAtomic(
			join(paoHome, "任务-20261002", "工作流实例-大活流程.md"),
			[
				"---",
				"工作流: 大活流程",
				`卡目录: ${cardsDir}`,
				'启动: "2026-10-03 10:00"',
				"状态: 运行中",
				"参数: {}",
				"节点:",
				"  - 名字: 澄清",
				'    卡号: "卡0001"',
				"  - 名字: 规划",
				'    卡号: "卡0002"',
				'    确认: "2026-10-03 11:30"',
				"---",
				"清单",
				"",
			].join("\n"),
		);
		const { tools, fireBeforeAgentStart } = setup(fixtureOptions());
		const text = await runTool(tools.get("pao_push_flow")!, { name: "大活流程" });
		expect(text).toContain("completed");
		const sections = fireBeforeAgentStart();
		expect(sections["pao-workflow-review"]).toContain("大活流程");
		expect(sections["pao-workflow-review"]).toContain("pao_review_flow");
		// 消费式:注入即清空,再触发无残留;同一流终态只提醒一次
		expect(fireBeforeAgentStart()["pao-workflow-review"]).toBeUndefined();
		await runTool(tools.get("pao_push_flow")!, { name: "大活流程" });
		expect(fireBeforeAgentStart()["pao-workflow-review"]).toBeUndefined();
	});

	test("运行中流不触发终态提醒", async () => {
		writeRecipe();
		const { tools, fireBeforeAgentStart } = setup(fixtureOptions());
		await runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } });
		expect(fireBeforeAgentStart()["pao-workflow-review"]).toBeUndefined();
	});
});

// /pao recipe-del <名字>：机械核 deleteRecipe（recipe.ts）+ 命令面回显。fixture 一律临时目录。
describe("/pao recipe-del 子命令", () => {
	test("存在→删除配方本体并回显名字与路径,同名 .bak 备份保留", async () => {
		const mock = setup(fixtureOptions());
		writeRecipe();
		const bak = join(paoHome, "工作流", "大活流程.md.bak-20261003-170013");
		writeFileSync(bak, "旧版", "utf8");
		await mock.runSub("recipe-del", "大活流程");
		const last = mock.messages.at(-1)!;
		expect(last.customType).toBe("pao-workflow");
		expect(last.text).toContain("已删除配方：大活流程");
		expect(last.text).toContain(join(paoHome, "工作流", "大活流程.md"));
		expect(existsSync(join(paoHome, "工作流", "大活流程.md"))).toBe(false);
		expect(existsSync(bak)).toBe(true);
	});

	test("名字不存在→回显 [RECIPE_NOT_FOUND]（fail-closed）,不删任何文件", async () => {
		const mock = setup(fixtureOptions());
		writeRecipe();
		await mock.runSub("recipe-del", "不存在的流");
		expect(mock.messages.at(-1)!.text).toContain("[RECIPE_NOT_FOUND]");
		expect(mock.messages.at(-1)!.text).toContain("未删除");
		expect(existsSync(join(paoHome, "工作流", "大活流程.md"))).toBe(true);
	});

	test("无参回显用法;路径穿越名在名字闸拒绝（RECIPE_FIELD）", async () => {
		const mock = setup(fixtureOptions());
		writeRecipe();
		await mock.runSub("recipe-del", "");
		expect(mock.messages.at(-1)!.text).toContain("用法：/pao recipe-del <名字>");
		await mock.runSub("recipe-del", "../逃逸");
		expect(mock.messages.at(-1)!.text).toContain("[RECIPE_FIELD]");
		// 工作流目录本体未被波及
		expect(existsSync(join(paoHome, "工作流", "大活流程.md"))).toBe(true);
	});
});

// ── 命令/工具同口径（2026-10-03 统一收口反漂移钉）────────────────────────────
// 命令面 /pao flow 与工具面 pao_start_flow/查流/确认流 核心执行同段（tools.ts *Core）：
// 同一配方同一参数，两面渲染必须逐字一致——漂移即测试红。时间戳抹平（确认落盘用真实时钟）。
describe("命令/工具同口径（反漂移钉）", () => {
	const singleGateRecipe = `---
名字: 单门流
参数: [仓库]
节点:
  - 名字: 把关
    部门: 规划部
    目标: "把关 {仓库}"
    验收: 结论落盘
    人工确认: true
---
`;

	/** 两面各跑一个独立实例，卡号计数各自从 0001 起，报告结构可比。 */
	const advanceToDelivered = (dir: string, cardNo: number) => {
		const card = loadCard(dir, cardNo);
		const inProgress = changeCardStatus(card, { 操作者: "测试员", to: "in_progress", 时间: "2026-10-02 10:05" });
		writeFileAtomic(inProgress.path, serializeCard(inProgress.frontmatter, inProgress.body));
		const delivered = changeCardStatus(inProgress, { 操作者: "测试员", to: "delivered", 时间: "2026-10-02 10:06" });
		writeFileAtomic(delivered.path, serializeCard(delivered.frontmatter, delivered.body));
	};

	/** 两面各跑一个独立实例：工具面卡目录开在 paoHome 之外的独立根（卡号计数器缺省落 paoHome 根，
	 *  不隔开则两面共用计数器起号不同，渲染里的卡号没法逐字比）。用完自清。 */
	const altRoot = (): string => {
		const root = mkdtempSync(join(tmpdir(), "pao-flow-same-"));
		sameRuleSweep.push(root);
		return root;
	};
	const sameRuleSweep: string[] = [];

	afterEach(() => {
		for (const dir of sameRuleSweep.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("启流：/pao flow 与 pao_start_flow 渲染逐字一致", async () => {
		writeRecipe();
		const otherRoot = altRoot();
		const otherCards = join(otherRoot, "任务A", "卡");
		mkdirSync(otherCards, { recursive: true });
		const { tools, messages, runSub } = setup(fixtureOptions());
		// 工具面开在另一工作区，命令面开在默认卡目录——同一配方同一参数
		const toolText = await runTool(tools.get("pao_start_flow")!, {
			name: "大活流程",
			params: { 仓库: "pao" },
			cards_dir: otherCards,
		});
		await runSub("flow", "大活流程 仓库=pao");
		expect(messages[0].text).toBe(toolText);
	});

	test("查流：/pao flow see 与 pao_query_flow 渲染逐字一致", async () => {
		writeRecipe();
		const { tools, messages, runSub } = setup(fixtureOptions());
		await runTool(tools.get("pao_start_flow")!, { name: "大活流程", params: { 仓库: "pao" } });
		advanceCard(1, "in_progress");
		advanceCard(1, "delivered");
		const toolText = await runTool(tools.get("pao_query_flow")!, { name: "大活流程" });
		await runSub("flow", "see 大活流程");
		expect(messages[0].text).toBe(toolText);
	});

	test("确认：/pao flow confirm 与 pao_confirm_flow 渲染一致（真实时钟时间戳抹平）", async () => {
		writeFileSync(join(paoHome, "工作流", "单门流.md"), singleGateRecipe, "utf8");
		const otherRoot = altRoot();
		const otherCards = join(otherRoot, "任务A", "卡");
		mkdirSync(otherCards, { recursive: true });
		const { tools, messages, runSub } = setup(fixtureOptions());
		// 工具面实例：启流→交付→工具面点头
		await runTool(tools.get("pao_start_flow")!, { name: "单门流", params: { 仓库: "pao" }, cards_dir: otherCards });
		advanceToDelivered(otherCards, 1);
		const toolText = await runTool(tools.get("pao_confirm_flow")!, {
			name: "单门流",
			node: "把关",
			cards_dir: otherCards,
		});
		// 命令面实例：同一配方另起一个工作区走命令面
		await runSub("flow", "单门流 仓库=pao");
		advanceToDelivered(cardsDir, 1);
		await runSub("flow", "confirm 单门流 把关");
		const scrubTime = (text: string) => text.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "<时间>");
		expect(scrubTime(messages.at(-1)!.text)).toBe(scrubTime(toolText));
		expect(toolText).toContain("人工门已确认");
		expect(toolText).toContain("状态：completed");
	});
});
