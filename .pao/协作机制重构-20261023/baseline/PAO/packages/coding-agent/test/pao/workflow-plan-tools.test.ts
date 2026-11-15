/**
 * 临时计划工具面回归（通用工作台 · 阶段 3 第 ③④项）。
 * 覆盖：建/改/撤/查/启动/存模板六个动作走真实注册工具；启动必须有宿主确认事实，
 * 同一启动请求重试找回原实例；部门取自 PAO_HOME 注册表；模板保存白名单。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import {
	type PlanConfirmation,
	planExecDir,
	planRecipeName,
	planStartRecordPath,
	readTemporaryPlan,
	recordStartIntent,
	resolvePlanExecution,
} from "../../src/pao/workflow/plan.ts";
import { type PlanToolsOptions, registerPlanTools } from "../../src/pao/workflow/plan-tools.ts";
import { parseRecipe, requireParams, substituteParams } from "../../src/pao/workflow/recipe.ts";
import type { WorkflowCommon } from "../../src/pao/workflow/tools.ts";
import { parseFrontmatter } from "../../src/utils/frontmatter.ts";

const dirs: string[] = [];
const 部门 = ["策划部", "写作部"];

function tempDir(prefix = "pao-plan-tools-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: never,
		signal?: AbortSignal,
		update?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { type: "text"; text: string }[] }>;
}

function mockPi() {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool: (definition: CapturedTool) => {
			tools.set(definition.name, definition);
		},
		on: () => {},
	};
	return { pi: pi as unknown as ExtensionAPI, tools };
}

async function call(
	tools: Map<string, CapturedTool>,
	name: string,
	params: Record<string, unknown>,
	ctx?: unknown,
	signal?: AbortSignal,
): Promise<string> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`工具未注册：${name}`);
	const result = await tool.execute("t1", params as never, signal, undefined, ctx);
	return result.content[0]?.text ?? "";
}

async function setup() {
	const 项目根 = tempDir();
	const paoHome = join(tempDir(), "现场");
	mkdirSync(join(paoHome, "pao配置"), { recursive: true });
	writeFileSync(
		join(paoHome, "pao配置", "档位.json"),
		JSON.stringify({ 档位: [{ 名: "快", provider: "offline", model: "fake", thinkingLevel: "off" }] }),
	);
	for (const name of 部门) await createDept({ paoHome, 名字: name, 默认档位: "快" });
	const { pi, tools } = mockPi();
	const options: PlanToolsOptions = {
		resolvePaoHome: () => paoHome,
		resolveProjectRoot: () => 项目根,
		resolveOwnerSessionId: () => "sess-1",
	};
	const common: WorkflowCommon = { queueReview: () => {} };
	registerPlanTools(pi, options, common);
	return { 项目根, paoHome, tools, options, common };
}

/** 建一份两步计划，返回计划 ID 与工具回显。 */
async function 建计划(tools: Map<string, CapturedTool>, requestId = "req-1") {
	const text = await call(tools, "pao_plan_create", {
		request_id: requestId,
		display_name: "小说创作",
		steps: [
			{ title: "讨论计划", dept: "策划部", requirement: "把方向与章节计划讨论清楚" },
			{ title: "写初稿", dept: "写作部", requirement: "按计划写初稿", depends_on: [1] },
		],
	});
	const 计划ID = /计划ID：(p-[\w-]+)/.exec(text)?.[1];
	if (!计划ID) throw new Error(`建计划没拿到计划 ID：${text}`);
	return { text, 计划ID };
}

/** 用「用户已确认」的宿主回调再注册一遍工具，返回工具表与确认调用记录。 */
function withConfirmation(
	options: PlanToolsOptions,
	common: WorkflowCommon,
	mode: "同意" | "错版" = "同意",
): { tools: Map<string, CapturedTool>; seen: string[] } {
	const { pi, tools } = mockPi();
	const seen: string[] = [];
	registerPlanTools(
		pi,
		{
			...options,
			requestConfirmation: (request) => {
				seen.push(`${request.计划ID}/${request.定义版本}/${request.启动请求ID}`);
				return {
					计划ID: request.计划ID,
					定义版本: mode === "错版" ? request.定义版本 + 98 : request.定义版本,
					启动请求ID: request.启动请求ID,
					来源: "宿主确认回调",
					时刻: "2026-10-14 10:30",
				};
			},
		},
		common,
	);
	return { tools, seen };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("临时计划工具面：建改撤查（阶段 3 第 ③项）", () => {
	it("创建落盘：返回计划 ID 与版本，且不落执行目录、不落卡", async () => {
		const f = await setup();
		const { text, 计划ID } = await 建计划(f.tools);
		expect(text).toContain("定义已落盘");
		expect(text).toContain("策划部");
		const definition = readTemporaryPlan(f.项目根, 计划ID);
		expect(definition.步骤.map((step) => step.步骤ID)).toEqual(["s1", "s2"]);
		expect(existsSync(join(f.项目根, ".pao", "临时工作流", 计划ID, "执行"))).toBe(false);
		expect(existsSync(join(f.项目根, ".pao", "临时工作流", 计划ID, "卡"))).toBe(false);
	});

	it("同一 request_id 重试是回放；换参数复用同 ID 被拒；并发重复创建只落一份", async () => {
		const f = await setup();
		const first = await 建计划(f.tools, "req-1");
		const replay = await 建计划(f.tools, "req-1");
		expect(replay.计划ID).toBe(first.计划ID);
		expect(replay.text).toContain("回放");
		await expect(
			call(f.tools, "pao_plan_create", {
				request_id: "req-1",
				display_name: "另一个计划",
				steps: [{ title: "别的", dept: "策划部", requirement: "换个要求" }],
			}),
		).rejects.toThrow(/request_id|请求/);
		const [并发1, 并发2] = await Promise.all([建计划(f.tools, "req-2"), 建计划(f.tools, "req-2")]);
		expect(并发1.计划ID).toBe(并发2.计划ID);
		expect(readdirSync(join(f.项目根, ".pao", "临时工作流")).length).toBe(2);
	});

	it("未登记部门在创建入口就被拒", async () => {
		const f = await setup();
		await expect(
			call(f.tools, "pao_plan_create", {
				request_id: "req-3",
				display_name: "越界计划",
				steps: [{ title: "乱来", dept: "不存在的部门", requirement: "随便" }],
			}),
		).rejects.toThrow(/部门/);
	});

	it("修改：改标题保持步骤 ID，版本递增；版本漂移被拒；撤销后不能再改", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const modified = await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-mod-1",
			expected_version: 1,
			action: "modify",
			steps: [
				{ title: "讨论计划（改了标题）", dept: "策划部", requirement: "把方向与章节计划讨论清楚" },
				{ title: "写初稿", dept: "写作部", requirement: "按计划写初稿", depends_on: [1] },
			],
		});
		expect(modified).toContain("定义版本：2");
		expect(readTemporaryPlan(f.项目根, 计划ID).步骤.map((step) => step.步骤ID)).toEqual(["s1", "s2"]);
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-mod-2",
				expected_version: 1,
				action: "undo",
			}),
		).rejects.toThrow(/版本/);
		const undone = await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-mod-3",
			expected_version: 2,
			action: "undo",
		});
		expect(undone).toContain("撤销");
		expect(readTemporaryPlan(f.项目根, 计划ID).已撤销).toBe(true);
	});

	it("查询：列定义与启动关联，未启动时如实说没有执行现场", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const text = await call(f.tools, "pao_plan_query", {});
		expect(text).toContain(计划ID);
		expect(text).toContain("未启动");
		const one = await call(f.tools, "pao_plan_query", { plan_id: 计划ID });
		expect(one).toContain("小说创作");
	});
});

describe("临时计划工具面：启动与确认边界（阶段 3 第 ④项）", () => {
	it("没有宿主确认回调也没有界面时一律拒：模型自述不算确认", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		await expect(
			call(f.tools, "pao_plan_start", {
				plan_id: 计划ID,
				definition_version: 1,
				start_request_id: "start-1",
			}),
		).rejects.toThrow(/PLAN_CONFIRM_REQUIRED/);
	});

	it("确认事实必须与计划/版本/启动请求三者一致：错版确认被拒", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const { tools } = withConfirmation(f.options, f.common, "错版");
		await expect(
			call(tools, "pao_plan_start", { plan_id: 计划ID, definition_version: 1, start_request_id: "start-1" }),
		).rejects.toThrow(/确认事实与本次请求不一致/);
	});

	it("界面确认（ctx.ui.confirm）也认，且用户拒绝就不启动", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const 拒绝 = { hasUI: true, ui: { confirm: async () => false } };
		await expect(
			call(
				f.tools,
				"pao_plan_start",
				{ plan_id: 计划ID, definition_version: 1, start_request_id: "start-ui" },
				拒绝,
			),
		).rejects.toThrow(/PLAN_CONFIRM_REQUIRED|用户/);
	});

	it("用户确认后真实受理：返回真实实例与执行目录；同启动请求重试找回原实例", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const { tools, seen } = withConfirmation(f.options, f.common);
		const text = await call(tools, "pao_plan_start", {
			plan_id: 计划ID,
			definition_version: 1,
			start_request_id: "start-1",
		});
		expect(seen).toEqual([`${计划ID}/1/start-1`]);
		expect(text).toContain("已受理：实例");
		expect(text).toContain("执行目录");
		const 工作区 = join(f.项目根, ".pao", "临时工作流", 计划ID, "执行", "start-1");
		expect(existsSync(join(工作区, `工作流实例-${planRecipeName(计划ID)}.md`))).toBe(true);
		expect(existsSync(join(工作区, "卡"))).toBe(true);
		// 重试：找回原实例，不再启动第二份、不再触发第二次确认
		const retry = await call(tools, "pao_plan_start", {
			plan_id: 计划ID,
			definition_version: 1,
			start_request_id: "start-1",
		});
		expect(retry).toContain("找回原实例");
		expect(seen.length).toBe(1);
		expect(readdirSync(工作区).filter((name) => name.startsWith("工作流实例-")).length).toBe(1);
	});

	it("已启动的计划被冻结：不能再改再撤", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const { tools } = withConfirmation(f.options, f.common);
		await call(tools, "pao_plan_start", { plan_id: 计划ID, definition_version: 1, start_request_id: "start-1" });
		await expect(
			call(tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-mod-9",
				expected_version: 1,
				action: "undo",
			}),
		).rejects.toThrow(/已启动|冻结/);
	});
});

describe("临时计划工具面：存模板（阶段 3 第 ⑤项）", () => {
	it("本次特有路径默认拒存并点名；显式允许才原样保存，且不含会话/卡号/实例状态", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-mod-1",
			expected_version: 1,
			action: "modify",
			steps: [
				{
					title: "讨论计划",
					dept: "策划部",
					requirement: "把方向与章节计划讨论清楚",
					constraints: `只读 ${join(f.项目根, "创作成果")} 下的东西`,
				},
				{ title: "写初稿", dept: "写作部", requirement: "按计划写初稿", depends_on: [1] },
			],
		});
		await expect(
			call(f.tools, "pao_plan_save_template", {
				plan_id: 计划ID,
				definition_version: 2,
				template_name: "小说创作模板",
			}),
		).rejects.toThrow(/路径/);
		const text = await call(f.tools, "pao_plan_save_template", {
			plan_id: 计划ID,
			definition_version: 2,
			template_name: "小说创作模板",
			allow_project_specific_paths: true,
		});
		expect(text).toContain("模板已保存");
		expect(text).toContain("本次特有路径");
		const 模板 = join(f.paoHome, "工作流", "小说创作模板.md");
		expect(existsSync(模板)).toBe(true);
		const body = readFileSync(模板, "utf8");
		expect(body).toContain("策划部");
		expect(body).not.toContain("sess-1");
		expect(body).not.toContain("卡0");
		expect(body).not.toContain("start-1");
		expect(body).not.toContain("实例:");
		await expect(
			call(f.tools, "pao_plan_save_template", {
				plan_id: 计划ID,
				definition_version: 2,
				template_name: "小说创作模板",
				allow_project_specific_paths: true,
			}),
		).rejects.toThrow(/已存在|同名|覆盖/);
	});
});

describe("讨论转计划的上下文与意见关联（阶段 4 第 2、4 项）", () => {
	it("系统提示里给出讨论转计划纪律、已登记部门与当前项目已有计划", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-section");
		const handlers: ((event: { systemPromptOptions: { sections: Record<string, string> } }) => void)[] = [];
		const pi = {
			registerTool: () => {},
			on: (
				_event: string,
				handler: (event: { systemPromptOptions: { sections: Record<string, string> } }) => void,
			) => handlers.push(handler),
		} as unknown as ExtensionAPI;
		registerPlanTools(pi, f.options, f.common);
		expect(handlers.length).toBe(1);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		for (const handler of handlers) handler(event);
		const section = event.systemPromptOptions.sections.pao_temporary_plan ?? "";
		expect(section).toContain("普通回复里的编号清单/Todo/原型关键字都不会触发真实创建");
		expect(section).toContain("已登记部门：策划部、写作部");
		expect(section).toContain(计划ID);
		expect(section).toContain("未启动");
	});

	it("步骤意见绑定提交时的定义版本；版本漂移拒收，不许悄悄改绑新版本", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-1");
		const text = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			definition_version: 1,
			target_kind: "步骤",
			step_id: "s1",
			text: "这一步先别急着定稿，我想再看一版人物小传",
		});
		expect(text).toContain("已记下这条意见");
		expect(text).toContain("已记录");
		expect(text).toContain("步骤 s1");
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "record",
				definition_version: 1,
				target_kind: "步骤",
				step_id: "s9",
				text: "不存在的步骤",
			}),
		).rejects.toThrow(/不在计划里/);
		// 计划被改到版本 2 后再用版本 1 提意见：拒（旧意见不能绑到新版本上）。
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-fb-1-modify",
			expected_version: 1,
			action: "modify",
			steps: [
				{ title: "讨论计划", dept: "策划部", requirement: "把方向与章节计划讨论清楚" },
				{ title: "写初稿", dept: "写作部", requirement: "按计划写初稿", depends_on: [1] },
			],
		});
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "record",
				definition_version: 1,
				target_kind: "步骤",
				step_id: "s1",
				text: "旧版本的确认",
			}),
		).rejects.toThrow(/提交时看到的那一版/);
		// 改标题不动步骤 ID：同一条意见在改标题后仍指向 s1。
		const list = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(list).toContain("步骤 s1");
		expect(list).toContain("定义版本 1");
	});

	it("投递状态只说真话：没回执不算送达，失败留原因，已应用要有业务依据", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-2");
		const 记录 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			definition_version: 1,
			target_kind: "文件",
			step_id: "s2",
			round: 1,
			file_path: "创作成果/小说/第1章.md",
			version_basis: "第 1 轮 2026-10-14 10:20",
			text: "开头太平，把冲突提到前三百字",
			deliver_request_id: "deliver-1",
		});
		expect(记录).toContain("待送达");
		const 意见ID = /(f-\d{8}-[0-9a-f]{6})/.exec(记录)?.[1];
		expect(意见ID).toBeTruthy();
		// 登记过投递请求 ID 的意见：回执不带同一个 ID 就不结算（无法核实的回执保持原状态）。
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "delivery",
				feedback_id: 意见ID,
				delivered: false,
				result: "没带请求 ID 的回执",
			}),
		).rejects.toThrow(/必须带上同一个请求 ID/);
		const 未结算 = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(未结算).toContain("待送达");
		// 投递失败：如实记「投递失败」并留下原因，不显示已送达。
		const 失败 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "delivery",
			feedback_id: 意见ID,
			delivered: false,
			result: "部长正在处理，须指定 streamingBehavior，本次拒收",
			deliver_request_id: "deliver-1",
		});
		expect(失败).toContain("投递失败");
		expect(失败).toContain("拒收");
		// 空白依据不许标已应用。
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "apply",
				feedback_id: 意见ID,
				evidence: "   ",
			}),
		).rejects.toThrow(/业务处理依据/);
		// 重投成功 + 真实依据 → 已送达 → 已应用。
		const 送达 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "delivery",
			feedback_id: 意见ID,
			delivered: true,
			result: "queued",
			deliver_request_id: "deliver-1",
		});
		expect(送达).toContain("已送达");
		const 应用 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "apply",
			feedback_id: 意见ID,
			evidence: "卡0007 第 2 轮修订稿前三百字已按此调整",
		});
		expect(应用).toContain("已应用");
		const list = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(list).toContain("创作成果/小说/第1章.md");
		expect(list).toContain("第 1 轮 2026-10-14 10:20");
		expect(list).toContain("已应用依据：卡0007");
	});

	it("文件意见必须给齐轮次与阅读版本；同一投递请求 ID 重试是回放，换参数被拒", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-3");
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "record",
				target_kind: "文件",
				step_id: "s2",
				file_path: "创作成果/小说/第1章.md",
				text: "缺版本依据",
			}),
		).rejects.toThrow(/第几轮次|轮次/);
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "record",
				target_kind: "文件",
				step_id: "s2",
				round: 1,
				file_path: "创作成果/小说/第1章.md",
				text: "缺版本依据",
			}),
		).rejects.toThrow(/version_basis|哪一版/);
		const 首次 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			target_kind: "文件",
			step_id: "s2",
			round: 1,
			file_path: "创作成果/小说/第1章.md",
			version_basis: "第 1 轮",
			text: "同一句话",
			deliver_request_id: "deliver-9",
		});
		const 意见ID = /(f-\d{8}-[0-9a-f]{6})/.exec(首次)?.[1];
		const 重放 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			target_kind: "文件",
			step_id: "s2",
			round: 1,
			file_path: "创作成果/小说/第1章.md",
			version_basis: "第 1 轮",
			text: "同一句话",
			deliver_request_id: "deliver-9",
		});
		expect(重放).toContain("回放");
		expect(重放).toContain(意见ID ?? "");
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "record",
				target_kind: "文件",
				step_id: "s2",
				round: 1,
				file_path: "创作成果/小说/第1章.md",
				version_basis: "第 1 轮",
				text: "换了内容的同一请求 ID",
				deliver_request_id: "deliver-9",
			}),
		).rejects.toThrow(/参数不一致/);
		const list = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(list.match(/同一句话/g)?.length).toBe(1);
	});
});

describe("工具面归属与取消（批次 A 第 ①②项）", () => {
	it("project_root 与宿主项目不一致：工具入口就拒，不在那个项目里落任何东西", async () => {
		const f = await setup();
		const 别的项目 = tempDir();
		await expect(
			call(f.tools, "pao_plan_create", {
				project_root: 别的项目,
				request_id: "req-cross",
				display_name: "越项目计划",
				steps: [{ title: "乱来", dept: "策划部", requirement: "随便" }],
			}),
		).rejects.toThrow(/PLAN_FORBIDDEN/);
		expect(existsSync(join(别的项目, ".pao"))).toBe(false);
	});

	it("取消信号穿透到内核：确认等待期间被取消就抛 PLAN_ABORTED，不落启动关联", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const { tools } = withConfirmation(f.options, f.common);
		const 已取消 = AbortSignal.abort(new Error("用户取消"));
		await expect(
			call(
				tools,
				"pao_plan_start",
				{ plan_id: 计划ID, definition_version: 1, start_request_id: "start-abort" },
				undefined,
				已取消,
			),
		).rejects.toThrow(/PLAN_ABORTED/);
		expect(existsSync(planStartRecordPath(f.项目根, 计划ID, "start-abort"))).toBe(false);
		// 改入口同样被取消拦下。
		await expect(
			call(
				f.tools,
				"pao_plan_update",
				{
					plan_id: 计划ID,
					request_id: "req-abort",
					expected_version: 1,
					action: "modify",
					steps: [{ title: "取消了的改名", dept: "策划部", requirement: "随便" }],
				},
				undefined,
				已取消,
			),
		).rejects.toThrow(/PLAN_ABORTED/);
		expect(readTemporaryPlan(f.项目根, 计划ID).定义版本).toBe(1);
	});

	it("等确认期间取消立即返回；迟到的「同意」不会再起实例", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const { pi, tools } = mockPi();
		let 进入!: () => void;
		let 同意!: (value: PlanConfirmation) => void;
		const 等待中 = new Promise<void>((resolve) => {
			进入 = resolve;
		});
		registerPlanTools(
			pi,
			{
				...f.options,
				requestConfirmation: () => {
					进入();
					return new Promise<PlanConfirmation>((resolve) => {
						同意 = resolve;
					});
				},
			},
			f.common,
		);
		const controller = new AbortController();
		const pending = tools
			.get("pao_plan_start")!
			.execute(
				"cancel",
				{ plan_id: 计划ID, definition_version: 1, start_request_id: "cancel-wait" } as never,
				controller.signal,
			);
		await 等待中;
		controller.abort(new Error("用户取消启动"));
		await expect(pending).rejects.toThrow("用户取消启动");
		// 迟到的同意：受理段已经不会再执行了。
		同意({ 计划ID, 定义版本: 1, 启动请求ID: "cancel-wait", 来源: "宿主确认回调", 时刻: "2026-10-17 12:00" });
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(existsSync(planExecDir(f.项目根, 计划ID, "cancel-wait"))).toBe(false);
		expect(existsSync(planStartRecordPath(f.项目根, 计划ID, "cancel-wait"))).toBe(false);
	});

	it("等确认期间来源主控被切换：回来后拒启，不拿等待前那份身份放行", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const { pi, tools } = mockPi();
		let owner = "sess-1";
		registerPlanTools(
			pi,
			{
				...f.options,
				resolveOwnerSessionId: () => owner,
				requestConfirmation: (request) => {
					owner = "sess-other";
					return { ...request, 来源: "宿主确认回调", 时刻: "2026-10-17 12:00" };
				},
			},
			f.common,
		);
		await expect(
			call(tools, "pao_plan_start", { plan_id: 计划ID, definition_version: 1, start_request_id: "owner-change" }),
		).rejects.toThrow(/主控已切换/);
		expect(existsSync(planExecDir(f.项目根, 计划ID, "owner-change"))).toBe(false);
	});
});

describe("工具面冻结窗口与稳定步骤 ID（批次 A 第 ③④项）", () => {
	it("只落了「受理中」意图（控制正本还没形成）时，改与撤都已被冻结", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		// 模拟启动工具在锁内已留痕、但启流还没返回的窗口期。
		recordStartIntent(planStartRecordPath(f.项目根, 计划ID, "start-1"), {
			计划ID,
			定义版本: 1,
			启动请求ID: "start-1",
			owner会话: "sess-1",
		});
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-mod-window",
				expected_version: 1,
				action: "modify",
				steps: [{ title: "窗口期偷偷改", dept: "策划部", requirement: "随便" }],
			}),
		).rejects.toThrow(/已启动|冻结/);
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-undo-window",
				expected_version: 1,
				action: "undo",
			}),
		).rejects.toThrow(/已启动|冻结/);
		// 同启动请求重查：报不完整启动，不自动再启一份。
		const { tools } = withConfirmation(f.options, f.common);
		await expect(
			call(tools, "pao_plan_start", { plan_id: 计划ID, definition_version: 1, start_request_id: "start-1" }),
		).rejects.toThrow(/不完整启动/);
	});

	it("重排步骤只改顺序：带 step_id 的步骤意见与依赖不断", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		const reordered = await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-reorder",
			expected_version: 1,
			action: "modify",
			steps: [
				{ step_id: "s2", title: "写初稿", dept: "写作部", requirement: "按计划写初稿" },
				{ step_id: "s1", title: "讨论计划", dept: "策划部", requirement: "把方向与章节计划讨论清楚" },
			],
		});
		expect(reordered).toContain("定义版本：2");
		expect(readTemporaryPlan(f.项目根, 计划ID).步骤.map((step) => step.步骤ID)).toEqual(["s2", "s1"]);
	});

	it("新增步骤发新 ID 不顶替旧 ID；指定不存在的 step_id 被拒", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-add-step",
			expected_version: 1,
			action: "modify",
			steps: [
				{ step_id: "s1", title: "讨论计划", dept: "策划部", requirement: "把方向与章节计划讨论清楚" },
				{ step_id: "s2", title: "写初稿", dept: "写作部", requirement: "按计划写初稿" },
				{ title: "审稿", dept: "策划部", requirement: "看一遍初稿" },
			],
		});
		expect(readTemporaryPlan(f.项目根, 计划ID).步骤.map((step) => step.步骤ID)).toEqual(["s1", "s2", "s3"]);
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-bad-step",
				expected_version: 2,
				action: "modify",
				steps: [{ step_id: "s99", title: "不存在的步骤", dept: "策划部", requirement: "随便" }],
			}),
		).rejects.toThrow(/s99/);
	});

	it("删掉还挂着意见的步骤被拒：意见绑定的是稳定步骤 ID，不能悄悄变孤儿", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools);
		await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			target_kind: "步骤",
			step_id: "s2",
			text: "这一步先别删",
			definition_version: 1,
		});
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-drop-step",
				expected_version: 1,
				action: "modify",
				steps: [{ step_id: "s1", title: "讨论计划", dept: "策划部", requirement: "把方向与章节计划讨论清楚" }],
			}),
		).rejects.toThrow(/还挂着意见/);
	});
});

describe("意见事实与版本绑定（批次 B：新审阅 4/9/12）", () => {
	it("整体意见针对流程目标：不写空步骤 ID，也不要 step_id", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-flow");
		const 记录 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			definition_version: 1,
			target_kind: "流程",
			text: "整份计划的目标要重写：先把读者是谁定下来",
		});
		expect(记录).toContain("已记录");
		expect(记录).toContain("流程目标");
		// 盘上不许落成空步骤 ID 的孤儿意见。
		const 定义目录 = planExecDir(f.项目根, 计划ID, "x");
		expect(定义目录).toContain("执行");
		const list = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(list).toContain("流程目标（整份计划）");
		expect(list).not.toMatch(/步骤 \s*｜/);
		// 整体意见再带 step_id 是自相矛盾：拒，别让模型两头讨好。
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "record",
				target_kind: "流程",
				step_id: "s1",
				text: "又整体又某一步",
			}),
		).rejects.toThrow(/不要给 step_id/);
		// 空 step_id 仍被拒，但错误里给出整体意见的正确写法。
		await expect(
			call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "record", text: "没说清针对谁" }),
		).rejects.toThrow(/target_kind=流程/);
	});

	it("整体意见不吃「删步骤」的孤儿判定：删步骤与它无关，但步骤意见仍拦", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-flow-2");
		await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			target_kind: "流程",
			text: "整体目标没问题，步骤可以调",
		});
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-drop-ok",
				expected_version: 1,
				action: "modify",
				steps: [{ step_id: "s1", title: "讨论计划", dept: "策划部", requirement: "把方向与章节计划讨论清楚" }],
			}),
		).resolves.toContain("定义版本 2");
	});

	it("登记过投递请求 ID 的意见：不带 ID 的回执不结算，错 ID 回执被拒", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-receipt");
		const 记录 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			definition_version: 1,
			step_id: "s1",
			text: "把人物关系表补上",
			deliver_request_id: "deliver-A",
		});
		const 意见ID = /(f-\d{8}-[0-9a-f]{6})/.exec(记录)?.[1] ?? "";
		// 张冠李戴的回执：请求 ID 对不上，不许结算。
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "delivery",
				feedback_id: 意见ID,
				delivered: true,
				result: "别的投递回执",
				deliver_request_id: "deliver-B",
			}),
		).rejects.toThrow(/请求 ID 与登记的不一致|不一致/);
		// 不带的回执同样不结算：无法核实就保持原状态（待送达）。
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "delivery",
				feedback_id: 意见ID,
				delivered: true,
				result: "没有 ID 的回执",
			}),
		).rejects.toThrow(/必须带上同一个请求 ID/);
		const 未变 = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(未变).toContain("待送达");
		// 对上了才结算。
		const 送达 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "delivery",
			feedback_id: 意见ID,
			delivered: true,
			result: "已交给写作部",
			deliver_request_id: "deliver-A",
		});
		expect(送达).toContain("已送达");
	});

	it("跨实例回执不结算另一条意见：实例对不上就拒", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-instance");
		const 记录 = await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "record",
			definition_version: 1,
			step_id: "s1",
			text: "这句口语化一点",
			deliver_request_id: "deliver-C",
		});
		const 意见ID = /(f-\d{8}-[0-9a-f]{6})/.exec(记录)?.[1] ?? "";
		// 第一次回执落在实例 inst-1 上：如实记「投递失败」，实例留档。
		await call(f.tools, "pao_plan_feedback", {
			plan_id: 计划ID,
			action: "delivery",
			feedback_id: 意见ID,
			delivered: false,
			result: "部长忙，先拒收",
			deliver_request_id: "deliver-C",
			instance_id: "inst-1",
		});
		const list = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(list).toContain("投递失败");
		// 另一个实例的回执张冠李戴地来结算这条意见：拒，原状态不被改掉。
		await expect(
			call(f.tools, "pao_plan_feedback", {
				plan_id: 计划ID,
				action: "delivery",
				feedback_id: 意见ID,
				delivered: true,
				result: "另一份执行的送达回执",
				deliver_request_id: "deliver-C",
				instance_id: "inst-2",
			}),
		).rejects.toThrow(/跨实例|实例与登记的不一致/);
		const 未变 = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(未变).toContain("投递失败");
	});

	it("意见入口也接取消信号：受理前被取消不落任何意见记录", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-fb-abort");
		const 已取消 = () => AbortSignal.abort(new Error("用户取消"));
		// record：取消在写盘前生效，盘上不该有这份计划的意见文件。
		await expect(
			call(
				f.tools,
				"pao_plan_feedback",
				{ plan_id: 计划ID, action: "record", target_kind: "流程", text: "取消前的话" },
				undefined,
				已取消(),
			),
		).rejects.toThrow(/PLAN_ABORTED|受理前被取消/);
		const list = await call(f.tools, "pao_plan_feedback", { plan_id: 计划ID, action: "list" });
		expect(list).toContain("还没有记过意见");
	});
});

describe("查询详情与按对象读取（批次 C 第 ③项：新审阅 8）", () => {
	it("给了 plan_id 是完整详情：逐步给要求/输入/约束/验收/技能/预算/人工门/审核与来源身份", async () => {
		const f = await setup();
		const 建 = await call(f.tools, "pao_plan_create", {
			request_id: "req-detail",
			display_name: "详情计划",
			steps: [
				{
					title: "调研",
					dept: "策划部",
					requirement: "把资料找齐",
					inputs: ["创作成果/设定.md"],
					constraints: "只读已确认资料",
					expected_artifacts: "创作成果/调研.md",
					skills: ["检索"],
					budget_turns: 6,
					priority: "高",
				},
				{
					title: "审稿",
					dept: "写作部",
					requirement: "逐条核对",
					depends_on: [1],
					audit: true,
					dept_standard: "错别字零容忍",
					human_gate: true,
				},
			],
		});
		const 计划ID = /计划ID：(p-[\w-]+)/.exec(建)?.[1] ?? "";
		const 详情 = await call(f.tools, "pao_plan_query", { plan_id: 计划ID });
		// 身份与运行关联：空对话里凭计划 ID 就能找回「当初是谁提的、什么要求」。
		expect(详情).toContain("来源主控 sess-1");
		expect(详情).toContain("运行关联：未启动");
		expect(详情).toContain("把资料找齐");
		expect(详情).toContain("创作成果/设定.md");
		expect(详情).toContain("只读已确认资料");
		expect(详情).toContain("创作成果/调研.md");
		expect(详情).toContain("检索");
		expect(详情).toContain("轮次 6");
		expect(详情).toContain("人工门：是");
		expect(详情).toContain("审核：是｜部门标准：错别字零容忍");
		// 还没改过：历史版本如实报「没有」，不编一个。
		expect(详情).toContain("还没有版本历史");
	});

	it("列表默认简短：不给 plan_id 只列摘要，不把每步完整字段倒出来", async () => {
		const f = await setup();
		await call(f.tools, "pao_plan_create", {
			request_id: "req-list",
			display_name: "列表计划",
			steps: [{ title: "讨论", dept: "策划部", requirement: "讨论方向", constraints: "约束不该出现在简短列表里" }],
		});
		const 列表 = await call(f.tools, "pao_plan_query", {});
		expect(列表).toContain("列表计划");
		expect(列表).not.toContain("约束不该出现在简短列表里");
	});

	it("按对象读取：around_step 只给那一步，step_detail 只给一项；点不存在的步骤点名报错", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-detail-2");
		const 单步 = await call(f.tools, "pao_plan_query", { plan_id: 计划ID, around_step: "s2" });
		expect(单步).toContain("s2 写初稿");
		// 只给这一步的完整面：s2 的要求在（无 around_step 时它是同样的行），s1 的要求不在。
		// 摘要行里两者都会出现（那是列表口径），所以这里按「要求正文」判，不按摘要行判。
		expect(单步).toContain("要求：按计划写初稿");
		expect(单步).not.toContain("要求：把方向与章节计划讨论清楚");
		// 一项一项读：只要「身份」，长要求不进上下文。
		const 单项 = await call(f.tools, "pao_plan_query", {
			plan_id: 计划ID,
			around_step: "s2",
			step_detail: "身份",
		});
		expect(单项).toContain("步骤ID s2");
		expect(单项).toContain("部门 写作部");
		expect(单项).not.toContain("把方向与章节计划讨论清楚");
		// 序号也能定位（1 起）。
		const 按序号 = await call(f.tools, "pao_plan_query", { plan_id: 计划ID, around_step: "1", step_detail: "身份" });
		expect(按序号).toContain("步骤ID s1");
		// 点一个不存在的步骤：点名报错，不当没这回事。
		await expect(call(f.tools, "pao_plan_query", { plan_id: 计划ID, around_step: "s99" })).rejects.toThrow(
			/没有步骤 s99/,
		);
	});
});

describe("撤销最近一次修改与模板参数化（批次 C 第 ①④项：新审阅 6/7）", () => {
	it("action=revert 把内容回到上一版并作为新版本落盘，整份计划仍可继续改", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-rv-1");
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-rv-2",
			expected_version: 1,
			action: "modify",
			display_name: "改坏了的名字",
		});
		const 撤销 = await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-rv-3",
			expected_version: 2,
			action: "revert",
		});
		expect(撤销).toContain("恢复自：定义版本 1");
		expect(撤销).toContain("定义版本：3");
		expect(readTemporaryPlan(f.项目根, 计划ID).显示名).toBe("小说创作");
		// 撤销之后这份计划照旧有效：还能继续改。
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-rv-4",
				expected_version: 3,
				action: "modify",
				display_name: "撤销之后又改",
			}),
		).resolves.toContain("定义版本：4");
	});

	it("revert 与 undo 不混同：revert 后仍可改，undo 后定义冻结", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-mix-1");
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-mix-2",
			expected_version: 1,
			action: "modify",
			display_name: "第二版",
		});
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-mix-3",
			expected_version: 2,
			action: "revert",
		});
		// 撤回整份才是另一条路：之后这份定义不能再改。
		const 撤回 = await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-mix-4",
			expected_version: 3,
			action: "undo",
		});
		expect(撤回).toContain("已撤销");
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-mix-5",
				expected_version: 4,
				action: "modify",
				display_name: "撤回之后还想改",
			}),
		).rejects.toThrow(/已撤销/);
	});

	it("版本冲突拒覆盖：expected_version 与盘上不一致时 revert 不动手", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-cf-1");
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-cf-2",
			expected_version: 1,
			action: "modify",
			display_name: "第二版",
		});
		await expect(
			call(f.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-cf-3",
				expected_version: 1,
				action: "revert",
			}),
		).rejects.toThrow(/版本漂移|PLAN_VERSION_CONFLICT/);
		expect(readTemporaryPlan(f.项目根, 计划ID).显示名).toBe("第二版");
	});

	it("revert 也接取消信号与归属校验：受理前取消不落版本，别的会话不能替原主控撤销", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-rv-abort");
		await call(f.tools, "pao_plan_update", {
			plan_id: 计划ID,
			request_id: "req-rv-abort-2",
			expected_version: 1,
			action: "modify",
			display_name: "第二版",
		});
		await expect(
			call(
				f.tools,
				"pao_plan_update",
				{ plan_id: 计划ID, request_id: "req-rv-abort-3", expected_version: 2, action: "revert" },
				undefined,
				AbortSignal.abort(new Error("用户取消")),
			),
		).rejects.toThrow(/PLAN_ABORTED|受理前被取消/);
		expect(readTemporaryPlan(f.项目根, 计划ID).定义版本).toBe(2);
		// 别的会话拿去撤销：归属不符，拒。
		const 别的 = withConfirmation({ ...f.options, resolveOwnerSessionId: () => "sess-other" }, f.common);
		await expect(
			call(别的.tools, "pao_plan_update", {
				plan_id: 计划ID,
				request_id: "req-rv-abort-4",
				expected_version: 2,
				action: "revert",
			}),
		).rejects.toThrow(/来源主控是 sess-1/);
	});

	it("保存模板时用 params 参数化本次路径：模板声明参数、可用同一套配方校验器，换项目填参就能再跑", async () => {
		const f = await setup();
		const 本次路径 = join(f.项目根, "素材", "设定.md");
		const 建 = await call(f.tools, "pao_plan_create", {
			request_id: "req-tpl-1",
			display_name: "带路径计划",
			steps: [
				{
					title: "调研",
					dept: "策划部",
					requirement: `按 ${本次路径} 里的设定写`,
					expected_artifacts: "创作成果/调研.md",
				},
			],
		});
		const 计划ID = /计划ID：(p-[\w-]+)/.exec(建)?.[1] ?? "";
		const saved = await call(f.tools, "pao_plan_save_template", {
			plan_id: 计划ID,
			definition_version: 1,
			template_name: "参数化模板",
			params: { 设定路径: 本次路径 },
		});
		expect(saved).toContain("已参数化：{设定路径}");
		const content = readFileSync(join(f.paoHome, "工作流", "参数化模板.md"), "utf8");
		expect(content).toContain("{设定路径}");
		expect(content).not.toContain(本次路径);
		const recipe = parseRecipe(content, "参数化模板");
		expect(recipe.参数).toEqual(["设定路径"]);
		expect(recipe.占位符).toEqual(["设定路径"]);
	});

	it("params 点名了一段不存在的文本：拒存并说清，不静默留一个用不上的空参数", async () => {
		const f = await setup();
		const { 计划ID } = await 建计划(f.tools, "req-tpl-2");
		await expect(
			call(f.tools, "pao_plan_save_template", {
				plan_id: 计划ID,
				definition_version: 1,
				template_name: "空参数模板",
				params: { 不存在的参数: "D:\\别处\\没有这段.md" },
			}),
		).rejects.toThrow(/没找到要替换的文本/);
		expect(existsSync(join(f.paoHome, "工作流", "空参数模板.md"))).toBe(false);
	});

	it("相对的项目内成果路径不算「本次特有路径」：普通计划不该被挡在模板之外", async () => {
		const f = await setup();
		// 这条计划的预期成果是项目内相对路径（创作成果/…），历史实现会把它截出 /初稿.md 误报成绝对路径。
		const 建 = await call(f.tools, "pao_plan_create", {
			request_id: "req-tpl-3",
			display_name: "相对路径计划",
			steps: [{ title: "写初稿", dept: "写作部", requirement: "写初稿", expected_artifacts: "创作成果/初稿.md" }],
		});
		const 计划ID = /计划ID：(p-[\w-]+)/.exec(建)?.[1] ?? "";
		const saved = await call(f.tools, "pao_plan_save_template", {
			plan_id: 计划ID,
			definition_version: 1,
			template_name: "相对路径模板",
		});
		expect(saved).toContain("模板里没有本次特有路径");
		expect(saved).not.toContain("/初稿.md");
	});
});

describe("模板换项目：参数化后能给另一个项目起一份干净的新计划（批次 C 出批条件：跨项目无污染）", () => {
	it("在 A 项目存的模板，换到 B 项目填参就能起新计划：不带 A 的路径、身份与执行状态", async () => {
		const f = await setup();
		const 甲路径 = join(f.项目根, "素材", "设定.md");
		const 建 = await call(f.tools, "pao_plan_create", {
			request_id: "req-cross-1",
			display_name: "甲项目计划",
			steps: [
				{
					title: "写初稿",
					dept: "写作部",
					requirement: `按 ${甲路径} 里的设定写初稿`,
					expected_artifacts: "创作成果/初稿.md",
				},
			],
		});
		const 甲计划ID = /计划ID：(p-[\w-]+)/.exec(建)?.[1] ?? "";
		await call(f.tools, "pao_plan_save_template", {
			plan_id: 甲计划ID,
			definition_version: 1,
			template_name: "跨项目模板",
			params: { 设定路径: 甲路径 },
		});

		// 换到 B 项目（另一个项目根）：模板本身不该带着 A 的身份或路径。
		const 乙项目根 = tempDir("pao-plan-b-");
		const 模板内容 = readFileSync(join(f.paoHome, "工作流", "跨项目模板.md"), "utf8");
		expect(模板内容).not.toContain(甲路径);
		const 配方 = parseRecipe(模板内容, "跨项目模板");
		// 「不带 A 的身份」按 frontmatter 判：模板正文的溯源说明（「由临时计划「甲项目计划」（p-…）保存」）
		// 是有意留下的出处标注，不是执行状态；状态字段（会话/卡号/实例/请求记录）一律不进模板。
		expect(JSON.stringify(parseFrontmatter(模板内容).frontmatter)).not.toContain(甲计划ID);
		// 模板声明了参数：B 项目填了值就能跑；不填则该被现有校验拒（缺值时不能静默用空串）。
		expect(配方.参数).toEqual(["设定路径"]);
		expect(() => requireParams(配方, {})).toThrow(/缺值/);

		// 在 B 项目里按同一模板起一份新计划（用配方机制启流，等价于用户「用于本次任务」）。
		// 替换发生在**解析后的节点字段**上，与 control.startControl 同构：substituteParams 不做 YAML 转义，
		// 若在原始 YAML 文本上替换，Windows 路径的反斜杠会被原样注入双引号标量（YAML 读成 `\U` 非法转义）。
		// 生产路径从不这样用：模板先按原样解析，参数只在启动时往内存里的字段上代入。
		const 乙设定 = join(乙项目根, "素材", "乙设定.md");
		const 参数取值 = { 设定路径: 乙设定 };
		const 乙节点 = 配方.节点.map((node) => ({
			...node,
			目标: substituteParams(node.目标, 参数取值),
			验收: substituteParams(node.验收, 参数取值),
			...(node.输入 ? { 输入: node.输入.map((item) => substituteParams(item, 参数取值)) } : {}),
		}));
		const 乙配方 = { ...配方, 节点: 乙节点 };
		expect(乙配方.参数).toEqual(["设定路径"]);
		// 占位符已替换成本项目的真实路径：B 计划里没有 A 的路径。
		// 按解析后的字段值比对（不是 JSON 文本：JSON.stringify 会把反斜杠转义成 \\，直连字符比对会假失败）。
		const 乙目标 = 乙配方.节点[0]!.目标;
		expect(乙目标).toContain(乙设定);
		expect(乙目标).not.toContain(甲路径);
		expect(乙目标).not.toContain("{设定路径}");
		// 换一份新计划起实例：新实例落在**它自己项目**的执行目录里，不带甲计划的 ID 或身份。
		// （建计划走工具的 resolveProjectRoot，落点是宿主注入的项目根；这里比的是「新实例不带旧身份」，
		// 不是「能把计划建到任意别的项目根下」——后者工具面本就禁止，见 resolveProjectRoot 的归属校验。）
		const 乙计划 = await 建计划(f.tools, "req-cross-2");
		expect(乙计划.计划ID).not.toBe(甲计划ID);
		const 乙执行 = resolvePlanExecution({
			项目根: f.项目根,
			计划ID: 乙计划.计划ID,
			启动请求ID: "start-cross-b",
			定义版本: 1,
			来源会话: "sess-1",
		});
		expect(乙执行.工作区.startsWith(f.项目根)).toBe(true);
		expect(乙执行.工作区).toContain(乙计划.计划ID);
		expect(乙执行.工作区).not.toContain(甲计划ID);
	});
});
