import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { readCard } from "../../src/pao/cards/cardfile.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";

function makeWorkspace(): { cardDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "pao-tools-"));
	const cardDir = join(dir, "任务-20261002", "卡");
	mkdirSync(cardDir, { recursive: true });
	return { cardDir: cardDir };
}

interface RegisteredTool {
	name: string;
	description: string;
	parameters: unknown;
	execute: (id: string, params: any) => Promise<{ content: { type: string; text: string }[] }>;
}

function setup(options?: Parameters<typeof registerCardTools>[1]) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: { customType: string; content: { type: string; text: string }[] }[] = [];
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (
			name: string,
			options_: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
		) => commands.set(name, options_),
		sendMessage: (message: { customType: string; content: { type: string; text: string }[] }) =>
			messages.push(message),
	} as unknown as ExtensionAPI;
	resetPaoSubcommandsForTest();
	registerCardTools(pi, options);
	const runSub = async (name: string, args = "", ctx: unknown = undefined) => {
		const sub = listPaoSubcommands(pi).find((entry) => entry.name === name);
		if (!sub) throw new Error(`子命令 ${name} 未注册`);
		await sub.run(pi, args, ctx);
	};
	return { tools, commands, messages, pi, runSub };
}

async function runTool(tool: RegisteredTool, params: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("test-call", params);
	return result.content.map((part) => part.text).join("\n");
}

describe("公开改状态入口的交付核对", () => {
	test("逐项接受自报未达项：同条件按原始索引分别覆盖，总 basis 与 owner 记录都落卡", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "偏离验收",
			dept: "审校",
			acceptance: "完成实现",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		const cardPath = join(cardDir, "卡0001-偏离验收.md");
		appendReceipt(readCard(cardPath), {
			尝试号: 1,
			时间: "2026-10-20 10:00",
			结果: "完成",
			摘要: "有两点未达",
			verification: [
				{ 条件: "限制", 结论: "fail", 证据: "甲" },
				{ 条件: "限制", 结论: "not_run", 证据: "乙" },
			],
		});

		for (const accepted_deviations of [undefined, []]) {
			await expect(
				runTool(tools.get("pao_change_status")!, {
					cards_dir: cardDir,
					card_ref: 1,
					operator: "部长A",
					new_status: "delivered",
					basis: "只有总依据，没有逐项裁决",
					accepted_deviations,
				}),
			).rejects.toThrow(/数量一致|逐项/);
			expect(readCard(cardPath).frontmatter.status).toBe("in_progress");
		}

		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
				basis: "已综合人工验收",
				accepted_deviations: [{ attempt: 1, verification_index: 0, condition: "限制", basis: "甲可接受" }],
			}),
		).rejects.toThrow("数量一致");
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
				accepted_deviations: [
					{ attempt: 1, verification_index: 0, condition: "限制", basis: "甲可接受" },
					{ attempt: 1, verification_index: 1, condition: "限制", basis: "乙可接受" },
				],
			}),
		).rejects.toThrow(/总验收依据 basis/);

		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "delivered",
			basis: "已综合人工验收",
			accepted_deviations: [
				{ attempt: 1, verification_index: 0, condition: "限制", basis: "甲可接受" },
				{ attempt: 1, verification_index: 1, condition: "限制", basis: "乙可接受" },
			],
		});
		const delivered = readCard(cardPath);
		expect(delivered.frontmatter.status).toBe("delivered");
		expect(delivered.body).toContain("- owner: 部长A");
		expect(delivered.body).toContain("- 尝试: 1");
		expect(delivered.body).toContain("- 未达项 #0: 限制；接受依据: 甲可接受（绑定尝试 1）");
		expect(delivered.body).toContain("- 未达项 #1: 限制；接受依据: 乙可接受（绑定尝试 1）");
	});

	test("相同条件在下一 attempt 重现时，上一 attempt 的接受参数必须拒绝", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "换尝试重放",
			dept: "审校",
			acceptance: "完成实现",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		const cardPath = join(cardDir, "卡0001-换尝试重放.md");
		appendReceipt(readCard(cardPath), {
			尝试号: 1,
			时间: "2026-10-20 10:00",
			结果: "失败",
			摘要: "第一次未达",
			verification: [{ 条件: "限制", 结论: "fail" }],
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "failed",
			failure_type: "transient",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "unclaimed",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		appendReceipt(readCard(cardPath), {
			尝试号: 2,
			时间: "2026-10-20 10:10",
			结果: "完成",
			摘要: "第二次仍有同条件未达",
			verification: [{ 条件: "限制", 结论: "fail" }],
		});

		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
				basis: "总验收依据",
				accepted_deviations: [{ attempt: 1, verification_index: 0, condition: "限制", basis: "旧依据" }],
			}),
		).rejects.toThrow("旧尝试参数不能重放");
		expect(readCard(cardPath).frontmatter.status).toBe("in_progress");
	});

	test("接受参数不能绕开机械失败；failed 不能直接 delivered 且状态保持不变", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "失败卡",
			dept: "审校",
			acceptance: "存在: 缺失.md",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		const cardPath = join(cardDir, "卡0001-失败卡.md");
		appendReceipt(readCard(cardPath), {
			尝试号: 1,
			时间: "2026-10-20 10:00",
			结果: "完成",
			摘要: "自报",
			verification: [{ 条件: "限制", 结论: "fail" }],
		});
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
				basis: "人工复核",
				accepted_deviations: [{ attempt: 1, verification_index: 0, condition: "限制", basis: "可接受" }],
			}),
		).rejects.toThrow("拒绝标为已完成");
		expect(readCard(cardPath).frontmatter.status).toBe("in_progress");

		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "failed",
			failure_type: "transient",
		});
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
				basis: "不能直交付",
			}),
		).rejects.toThrow("failed → delivered");
		expect(readCard(cardPath).frontmatter.status).toBe("failed");
	});

	test("机械条件未过不能用改状态跳过；真实文件通过后仍可完成", async () => {
		const { cardDir } = makeWorkspace();
		// 项目位于 Git 仓库的子目录：机械验收仍以执行项目为根。
		execFileSync("git", ["init", "--quiet"], { cwd: join(cardDir, "..", "..") });
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "交付报告",
			dept: "审校",
			acceptance: "存在: report.md",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
				basis: "自称已完成",
			}),
		).rejects.toThrow("拒绝标为已完成");
		const before = readCard(join(cardDir, "卡0001-交付报告.md"));
		expect(before.frontmatter.status).toBe("in_progress");
		expect(before.frontmatter.completed).toBeUndefined();
		writeFileSync(join(cardDir, "..", "report.md"), "真实报告\n");
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "delivered",
		});
		expect(readCard(before.path).frontmatter.status).toBe("delivered");
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "canceled",
			}),
		).rejects.toThrow("不允许的状态迁移");
	});
	test("纯人工验收必须给出依据，补充依据后保留原有人工完成路径", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "审稿",
			dept: "审校",
			acceptance: "叙事清晰，由主控审阅",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
			}),
		).rejects.toThrow("basis");
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "delivered",
			basis: "已逐段核对叙事与审稿要求",
		});
		expect(readCard(join(cardDir, "卡0001-审稿.md")).frontmatter.status).toBe("delivered");
	});
});

describe("registerCardTools 注册面", () => {
	test("注册六个工具与 queue 子命令，description 为中文", () => {
		const { tools, commands, pi } = setup();
		expect([...tools.keys()].sort()).toEqual([
			"pao_change_status",
			"pao_check_overreach",
			"pao_create_card",
			"pao_handoff",
			"pao_query_queue",
			"pao_submit_receipt",
		]);
		expect(commands.size).toBe(0); // 命令统一:模块不再注册独立命令
		expect(listPaoSubcommands(pi).map((sub) => sub.name)).toContain("queue");
		for (const tool of tools.values()) {
			expect(tool.description.length).toBeGreaterThan(0);
			expect(/[\u4e00-\u9fff]/.test(tool.description)).toBe(true);
		}
	});

	test("pao_create_card 预算参数 description 载明单位口径与卡类型默认区间（M2-04 建卡侧铺轨）", () => {
		const { tools } = setup();
		const schema = tools.get("pao_create_card")!.parameters as {
			properties: { budget?: { description?: string } };
		};
		const desc = schema.properties.budget?.description ?? "";
		// 单位口径：轮次＋工具调用次数
		expect(desc).toContain("轮次");
		expect(desc).toContain("工具调用");
		expect(desc).toContain("100/1000");
		// 三个卡类型默认区间：微任务/常规/大活
		expect(desc).toContain("20/200");
		expect(desc).toContain("500/5000");
		// 主控逐卡估，不设全局死数；机械熔断线定位
		expect(desc).toContain("逐卡");
		expect(desc).toContain("熔断");
	});
});

describe("pao_create_card → pao_submit_receipt → pao_change_status → pao_query_queue 全流程", () => {
	test("取消等待执行停止；停止失败保留进行中，未授权操作者不触发停止", async () => {
		const { cardDir } = makeWorkspace();
		let stops = 0;
		let shouldFail = true;
		const { tools } = setup({
			cancelWorker: async (card) => {
				stops++;
				expect(readCard(card.path).frontmatter.status).toBe("in_progress");
				if (shouldFail) throw new Error("实际进程未停");
			},
		});
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "可取消任务",
			dept: "核心机制",
			acceptance: "完成",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长B",
				new_status: "canceled",
			}),
		).rejects.toThrow("FORBIDDEN_WRITER");
		expect(stops).toBe(0);
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "用户",
				new_status: "canceled",
			}),
		).rejects.toThrow("实际进程未停");
		expect(readCard(join(cardDir, "卡0001-可取消任务.md")).frontmatter.status).toBe("in_progress");
		shouldFail = false;
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "用户",
			new_status: "canceled",
		});
		expect(readCard(join(cardDir, "卡0001-可取消任务.md")).frontmatter.status).toBe("canceled");
		expect(stops).toBe(2);
	});

	test("建卡预算单位落盘一致，不把费用当工具次数", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "预算任务",
			dept: "核心机制",
			acceptance: "完成",
			budget: { turns: 20, toolCalls: 200, cost: 5 },
		});
		expect(readCard(join(cardDir, "卡0001-预算任务.md")).frontmatter.budget).toEqual({
			turns: 20,
			toolCalls: 200,
			cost: 5,
		});
	});
	test("端到端：建卡、认领（依赖门禁）、交回执、验收交付、渲染队列", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();

		const build = await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "前置侦察",
			dept: "核心机制",
			acceptance: "地图落盘",
		});
		expect(build).toContain("卡0001");

		const buildDependent = await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "后续实现",
			dept: "核心机制",
			acceptance: "测试全绿",
			depends_on: ["卡#1"],
		});
		expect(buildDependent).toContain("卡0002");

		// 依赖未交付：认领被拒，报等哪张卡、什么状态
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 2,
				operator: "部长A",
				new_status: "in_progress",
			}),
		).rejects.toThrow(/\[DEPS_NOT_MET\].*卡0001=unclaimed/);

		// 前置交付后放行
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		await runTool(tools.get("pao_submit_receipt")!, {
			cards_dir: cardDir,
			card_ref: "卡#1",
			attempt: 1,
			结果: "完成",
			摘要: "地图已落盘",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "delivered",
			basis: "验收通过",
		});

		const claim = await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 2,
			operator: "部长A",
			new_status: "in_progress",
		});
		expect(claim).toContain("尝试 1");
		expect(claim).toContain("owner=部长A");

		// worker 交回执
		const receipt = await runTool(tools.get("pao_submit_receipt")!, {
			cards_dir: cardDir,
			card_ref: 2,
			attempt: 1,
			结果: "完成",
			摘要: "实现完成",
			证据: ["npx vitest run 全绿"],
			用量: { turns: 9 },
		});
		expect(receipt).toContain("待 owner 审核");

		// 卡文件上状态未被 worker 改动
		const dependent = readCard(join(cardDir, "卡0002-后续实现.md"));
		expect(dependent.frontmatter.status).toBe("in_progress");

		// 查队列渲染
		const queue = await runTool(tools.get("pao_query_queue")!, { cards_dir: cardDir });
		expect(queue).toContain("in_progress（1）");
		expect(queue).toContain("delivered（1）");
		expect(queue).toMatch(/卡0002 [^\n]*\[待审\]/);
		expect(queue).toContain("依赖: 卡0001(delivered)");
	});

	test("失败分型走 pao_change_status：失败必带类型，重试到上限拒绝", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "会失败的卡",
			dept: "核心机制",
			acceptance: "x",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});

		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "failed",
			}),
		).rejects.toThrow(/失败类型/);

		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "failed",
			failure_type: "transient",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "unclaimed",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "failed",
			failure_type: "missing_input",
		});
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "unclaimed",
			}),
		).rejects.toThrow(/\[ATTEMPT_EXCEEDED\]/);
	});

	test("非法迁移报结构化错误码；越权写入报 FORBIDDEN_WRITER", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "直交付卡",
			dept: "核心机制",
			acceptance: "x",
		});
		// 待认领 → 已交付：跳过执行环节，非法迁移
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "delivered",
			}),
		).rejects.toThrow(/\[INVALID_TRANSITION\]/);
		// 部长A 认领后，部长B 无权改状态
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		await expect(
			runTool(tools.get("pao_change_status")!, {
				cards_dir: cardDir,
				card_ref: 1,
				operator: "部长B",
				new_status: "delivered",
			}),
		).rejects.toThrow(/\[FORBIDDEN_WRITER\]/);
	});
});

describe("/pao queue 子命令", () => {
	test("缺卡目录时给出用法提示；有卡目录时发送渲染结果", async () => {
		const { cardDir } = makeWorkspace();
		const { messages, tools, runSub } = setup();
		await runSub("queue", "", undefined);
		expect(messages[0].content[0].text).toContain("未提供卡目录");

		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "命令渲染卡",
			dept: "核心机制",
			acceptance: "x",
		});
		await runSub("queue", cardDir, undefined);
		expect(messages[1].content[0].text).toContain("卡0001 命令渲染卡");
	});

	test("resolveCardsDir 注入后，工具与命令的 卡目录 可省略", async () => {
		const { cardDir } = makeWorkspace();
		const { tools, messages, runSub } = setup({ resolveCardsDir: () => cardDir });
		await runTool(tools.get("pao_create_card")!, { goal: "默认目录卡", dept: "核心机制", acceptance: "x" });
		const queue = await runTool(tools.get("pao_query_queue")!, {});
		expect(queue).toContain("卡0001 默认目录卡");
		await runSub("queue", "", undefined);
		expect(messages[0].content[0].text).toContain("卡0001 默认目录卡");
	});

	test("坏卡进「读取问题」段：队列看着干净不等于没有任务（审查第 5 项）", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "好卡",
			dept: "核心机制",
			acceptance: "x",
		});
		writeFileSync(join(cardDir, "卡0009-坏卡.md"), "---\n目标: 坏卡\n---\n正文\n", "utf8");

		const queue = await runTool(tools.get("pao_query_queue")!, { cards_dir: cardDir });
		expect(queue).toContain("好卡");
		expect(queue).toContain("读取问题（1 项");
		expect(queue).toContain("卡0009-坏卡.md");
	});

	test("干净队列不出「读取问题」段（不因新增披露退化）", async () => {
		const { cardDir } = makeWorkspace();
		const { tools } = setup();
		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "好卡",
			dept: "核心机制",
			acceptance: "x",
		});
		expect(await runTool(tools.get("pao_query_queue")!, { cards_dir: cardDir })).not.toContain("读取问题");
	});
});
