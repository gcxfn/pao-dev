/**
 * /pao pano 子命令单测(全景三批·任务 2,2026-10-03 命令统一):五区聚合文本、空态如实、数据源同源
 * (renderAllQueues/deptBacklogSnapshot/挂起工作流扫法/后台计数/用量账)、
 * 命令注册、TUI 运行态门控(ctx.mode)与钻取循环(select 返回 部门/工作流/worker/刷新/退出)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard, formatCardNumber } from "../../src/pao/cards/index.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { deptBacklogSnapshot } from "../../src/pao/dept/panels.ts";
import { formatProjectList } from "../../src/pao/dept/projects.ts";
import { formatRegistry } from "../../src/pao/dept/registry.ts";
import {
	buildDeptDetailPage,
	buildPanoramaPage,
	buildWorkflowDetailPage,
	registerPanorama,
} from "../../src/pao/panorama/index.ts";
import { buildFirstRunList } from "../../src/pao/status/firstrun.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { startControl } from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { parseFrontmatter } from "../../src/utils/frontmatter.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-panorama-"));
	tempDirs.push(dir);
	return dir;
}

it("部门注册表不可读在快照、全景、首跑清单中显式报错", () => {
	const home = tempDir();
	mkdirSync(join(home, "部门", "注册表.md"), { recursive: true });
	expect(() => deptBacklogSnapshot(home)).toThrow("部门知识积压读取失败");
	expect(buildPanoramaPage({ paoHome: home })).toContain("部门知识积压读取失败");
	expect(buildFirstRunList(home)).toContain("部门知识积压读取失败");
});

function capturePi() {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: { customType: string; text: string }[] = [];
	const pi = {
		registerCommand: (
			name: string,
			options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
		) => commands.set(name, options),
		registerTool: () => {},
		on: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: { customType: string; content: { text: string }[] }) =>
			messages.push({ customType: message.customType, text: message.content[0].text }),
	} as unknown as ExtensionAPI;
	resetPaoSubcommandsForTest();
	const runSub = async (name: string, args = "", ctx: unknown = {}) => {
		const sub = listPaoSubcommands(pi).find((entry) => entry.name === name);
		if (!sub) throw new Error(`子命令 ${name} 未注册`);
		await sub.run(pi, args, ctx);
	};
	return { commands, messages, pi, runSub };
}

/** 部门注册表＋库目录(待验证 1 条＋教训区 ⚠️ 1 行) */
function writeDeptFixture(home: string, dept = "测试部"): void {
	const lib = join(home, "部门", dept, "知识库");
	mkdirSync(join(lib, "待验证"), { recursive: true });
	writeFileSync(join(lib, "待验证", "候选1.md"), "内容", "utf8");
	mkdirSync(join(lib, "教训"), { recursive: true });
	writeFileSync(join(lib, "教训", "子索引.md"), "- 条目 ⚠️ 需复核\n- 正常条目", "utf8");
	writeFileSync(
		join(home, "部门", "注册表.md"),
		formatRegistry([{ 名字: dept, 标签: ["qa"], 库路径: `部门/${dept}/知识库` }]),
		"utf8",
	);
}

/** 项目清单＋项目 .pao 下一个挂起工作流实例 */
function writeWorkflowFixture(home: string, projectName: string, projectRoot: string, flowName: string): string {
	writeFileSync(
		join(home, "项目清单.md"),
		formatProjectList([
			{ 项目名: projectName, 项目根: projectRoot, 首次服务: "2026-10-01 09:00", 最近服务: "2026-10-01 09:00" },
		]),
		"utf8",
	);
	mkdirSync(join(projectRoot, ".pao", "卡"), { recursive: true });
	const manifestPath = join(projectRoot, ".pao", `工作流实例-${flowName}.md`);
	writeFileSync(
		manifestPath,
		[
			"---",
			`工作流: ${flowName}`,
			`卡目录: ${join(projectRoot, ".pao", "卡")}`,
			'启动: "2026-10-01 10:00"',
			"状态: 挂起",
			"参数:",
			'  章节: "3"',
			"节点:",
			"  - 名字: 首章",
			'    卡号: "0001"',
			"  - 名字: 次章",
			"    挂起: 等待前置交付",
			"---",
			"<!-- 驱动器维护 -->",
			"",
		].join("\n"),
		"utf8",
	);
	return manifestPath;
}

/** 生成可由共享 readWorkflowInstance 读取的 v2 控制实例，并留下人工门/轮次/卡号现场。 */
async function writeV2WorkflowFixture(
	home: string,
	projectName: string,
	projectRoot: string,
	flowName: string,
): Promise<{ controlPath: string; cardsDir: string; instance: string }> {
	const cardsDir = join(projectRoot, ".pao", "任务-v2", "卡");
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(join(home, "工作流"), { recursive: true });
	const recipePath = join(home, "工作流", `${flowName}.md`);
	const recipeText = `---\n${stringify({
		版本: 2,
		名字: flowName,
		参数: [],
		节点: [{ 名字: "把关", 部门: "规划部", 目标: "确认目标", 验收: "完成", 人工确认: true }],
	})}---\n`;
	writeFileSync(recipePath, recipeText, "utf8");
	const recipe = parseRecipe(recipeText, recipePath);
	await startControl(recipe, {}, { cardsDir, ownerSessionId: `owner-${projectName}` });
	const controlPath = join(dirname(cardsDir), `工作流实例-${flowName}.md`);
	const card = await createCard(cardsDir, {
		目标: "人工确认卡",
		部门: "规划部",
		验收: "完成",
		创建: "2026-10-10 10:00",
	});
	const parsed = parseFrontmatter<Record<string, any>>(readFileSync(controlPath, "utf8"));
	const control = parsed.frontmatter;
	control.状态 = "挂起";
	control.暂停 = "等待人工确认";
	control.节点[0].部长会话 = "minister";
	control.节点[0].拆解结束 = true;
	control.节点[0].卡 = [formatCardNumber(card.card_no)];
	writeFileSync(controlPath, `---\n${stringify(control)}---\n`, "utf8");
	writeFileSync(
		join(home, "项目清单.md"),
		formatProjectList([
			{ 项目名: projectName, 项目根: projectRoot, 首次服务: "2026-10-10 10:00", 最近服务: "2026-10-10 10:00" },
		]),
		"utf8",
	);
	return { controlPath, cardsDir, instance: String(control.实例) };
}

describe("buildPanoramaPage 五区聚合", () => {
	it("空 PAO_HOME:五区标题齐全,空态如实(无项目/无挂起/无部门/未接入/尚无跨会话账)", () => {
		const text = buildPanoramaPage({ paoHome: tempDir() });
		expect(text).toContain("── 队列 ──");
		expect(text).toContain("尚无服务过的项目记录");
		expect(text).toContain("── 工作流 ──\n挂起工作流:无");
		expect(text).toContain("── 部门 ──\n无");
		expect(text).toContain("── 后台 ──\n后台扇出:未接入");
		expect(text).toContain("在途 worker:无");
		expect(text).toContain("── 用量 ──\n尚无跨会话账");
	});

	it("有料各项目:队列计数、挂起工作流名字、部门积压、后台三态、worker 行", () => {
		const home = tempDir();
		const projectRoot = join(tempDir(), "projA");
		const manifestPath = writeWorkflowFixture(home, "项目A", projectRoot, "重构成稿");
		writeDeptFixture(home);
		const text = buildPanoramaPage({
			paoHome: home,
			后台: { in_flight: 2, completed_unread: 1 },
			在途worker: [{ pid: 4321, 卡号: "0007", 命令: "node -e ..." }],
		});
		expect(text).toContain(`挂起 1:重构成稿（项目A）`);
		expect(text).toContain("项目A");
		expect(text).toContain("- 测试部:待验证 1 条｜⚠️ 教训 1");
		expect(text).toContain("后台扇出:在途 2 批 · 完成未读 1 批");
		expect(text).toContain("在途 worker 1:pid 4321 卡0007");
		// 钻取要用的实例路径与页显示解耦:页文本不含绝对路径噪音
		expect(text).not.toContain(manifestPath);
	});

	it("后台计数全零＝空闲;在途 worker 0＝无(聚合页不冒充)", () => {
		const text = buildPanoramaPage({
			paoHome: tempDir(),
			后台: { in_flight: 0, completed_unread: 0 },
			在途worker: [],
		});
		expect(text).toContain("后台扇出:空闲");
		expect(text).toContain("在途 worker:无");
	});

	it("用量区一行:formatLedgerSummary 数据行并入,自身区头不重复", async () => {
		const { appendLedgerRow, buildLedgerRow } = await import("../../src/pao/usage/ledger.ts");
		const home = tempDir();
		appendLedgerRow(
			home,
			buildLedgerRow(
				{ 累计: { input: 100, output: 10, cacheRead: 0, cost: 0.02, turns: 3 }, 缺用量轮次: 0 },
				"主控",
				"2026-10-01T09:00:00Z",
			),
		);
		const text = buildPanoramaPage({ paoHome: home });
		expect(text).toContain("── 用量 ──\n会话 1（主控 1）");
		expect(text.match(/── 用量区/g)).toBeNull();
	});
});

describe("钻取明细页", () => {
	it("buildWorkflowDetailPage:manifest 节点全展开(卡号映射/挂起原因/参数)", () => {
		const home = tempDir();
		const projectRoot = join(tempDir(), "projB");
		const manifestPath = writeWorkflowFixture(home, "项目B", projectRoot, "评审流");
		const text = buildWorkflowDetailPage(manifestPath);
		expect(text).toContain("── 工作流:评审流（挂起）──");
		expect(text).toContain("启动:2026-10-01 10:00");
		expect(text).toContain("参数:章节=3");
		expect(text).toContain("节点 2:");
		expect(text).toContain("- 首章（卡0001）");
		expect(text).toContain("- 次章（未落卡 · 挂起:等待前置交付）");
	});

	it("buildWorkflowDetailPage:v2 控制实例显示实例身份/轮次/停因/卡号", async () => {
		const home = tempDir();
		const projectRoot = tempDir();
		const fixture = await writeV2WorkflowFixture(home, "项目-v2", projectRoot, "v2流");
		const text = buildWorkflowDetailPage(fixture.controlPath);
		expect(text).toContain("── 工作流:v2流（挂起）──");
		expect(text).toContain(`实例:${fixture.instance}`);
		expect(text).toContain("轮次:1");
		expect(text).toContain("挂起:等待人工确认");
		expect(text).toContain("卡0001");
		expect(text).toContain(`卡目录:${fixture.cardsDir}`);
	});

	it("buildWorkflowDetailPage:实例文件缺失＝读取失败行,不抛", () => {
		expect(buildWorkflowDetailPage(join(tempDir(), "不存在.md"))).toContain("工作流详情读取失败");
	});

	it("buildDeptDetailPage:该部门快照明细＋登记表在途 worker 行(按部门过滤)", () => {
		const home = tempDir();
		writeDeptFixture(home);
		const runner = new WorkerRunner();
		runner.registry.register({
			pid: 111,
			card_no: "0003",
			command: "node x",
			dept: "测试部",
			dispatch_reason: "单卡理由",
		});
		runner.registry.register({ pid: 222, card_no: "0009", command: "node y", dept: "别的部" });
		const text = buildDeptDetailPage(home, "测试部", runner);
		expect(text).toContain("── 部门:测试部 ──");
		expect(text).toContain("待验证 1 条");
		expect(text).toContain("⚠️ 教训 1");
		expect(text).toContain("- pid 111 卡0003 · 单卡理由");
		expect(text).not.toContain("pid 222");
	});

	it("buildDeptDetailPage:无快照/无在途＝如实显示", () => {
		const home = tempDir();
		const runner = new WorkerRunner();
		const text = buildDeptDetailPage(home, "幽灵部", runner);
		expect(text).toContain("快照无此部门");
		expect(text).toContain("在途 worker:无");
	});
});

describe("registerPanorama 注册与钻取循环", () => {
	it("挂 pano 子命令;run 发 pao-panorama 聚合页;非 TUI 运行态(json)不进钻取", async () => {
		const { pi, runSub, messages } = capturePi();
		registerPanorama(pi, { resolvePaoHome: () => tempDir() });
		expect(listPaoSubcommands(pi).map((sub) => sub.name)).toContain("pano");
		const select = vi.fn();
		await runSub("pano", "", { mode: "json", ui: { select } });
		expect(messages).toHaveLength(1);
		expect(messages[0].customType).toBe("pao-panorama");
		expect(messages[0].text).toContain("── 队列 ──");
		expect(select).not.toHaveBeenCalled();
	});

	it("TUI 运行态钻取:刷新重建聚合页并回循环,退出收口;listActive 空则无 worker 行可选", async () => {
		const captured = capturePi();
		const { messages } = captured;
		const runner = new WorkerRunner();
		const selectQueue = ["刷新", "退出"];
		const select = vi.fn(() => Promise.resolve(selectQueue.shift()));
		const custom = vi.fn(() => Promise.resolve());
		registerPanorama(captured.pi, { resolvePaoHome: () => tempDir(), getRunner: () => runner });
		await captured.runSub("pano", "", { mode: "tui", ui: { select, custom } });
		expect(select).toHaveBeenCalledTimes(2);
		expect(custom).not.toHaveBeenCalled();
		expect(messages.filter((m) => m.customType === "pao-panorama").length).toBeGreaterThanOrEqual(2); // 首发＋刷新
	});

	it("同名工作流不同项目/卡目录:全景选择项可区分且点选打开对应实例", async () => {
		const home = tempDir();
		const projectA = tempDir();
		const projectB = tempDir();
		writeFileSync(
			join(home, "项目清单.md"),
			formatProjectList([
				{ 项目名: "项目A", 项目根: projectA, 首次服务: "2026-10-10 10:00", 最近服务: "2026-10-10 10:00" },
				{ 项目名: "项目B", 项目根: projectB, 首次服务: "2026-10-10 10:00", 最近服务: "2026-10-10 10:00" },
			]),
			"utf8",
		);
		const manifestPaths = [
			join(projectA, ".pao", "任务甲", "工作流实例-同名流.md"),
			join(projectB, ".pao", "任务乙", "工作流实例-同名流.md"),
		];
		for (const [index, path] of manifestPaths.entries()) {
			const cardsDir = join(dirname(path), "卡");
			mkdirSync(cardsDir, { recursive: true });
			writeFileSync(
				path,
				[
					"---",
					"工作流: 同名流",
					`卡目录: ${JSON.stringify(cardsDir)}`,
					"启动: 2026-10-10 10:00",
					"状态: 挂起",
					"参数: {}",
					"节点:",
					`  - 名字: ${index === 0 ? "甲节点" : "乙节点"}`,
					`    卡号: "${index === 0 ? "0001" : "0002"}"`,
					"    挂起: 等待人工确认",
					"---",
				].join("\n"),
				"utf8",
			);
		}
		const captured = capturePi();
		const selectedLabels: string[] = [];
		let pickCount = 0;
		const select = vi.fn(async (_title: string, options: string[]) => {
			const labels = options.filter((option) => option.startsWith("同名流（"));
			if (pickCount === 0) {
				pickCount++;
				expect(labels).toHaveLength(2);
				expect(labels[0]).not.toBe(labels[1]);
				const picked = labels.find((label) => label.includes("项目A"));
				expect(picked).toBeDefined();
				selectedLabels.push(picked!);
				return picked;
			}
			if (pickCount === 1) {
				pickCount++;
				const picked = labels.find((label) => label.includes("项目B"));
				expect(picked).toBeDefined();
				selectedLabels.push(picked!);
				return picked;
			}
			return "退出";
		});
		registerPanorama(captured.pi, { resolvePaoHome: () => home });
		await captured.runSub("pano", "", { mode: "tui", ui: { select } });
		expect(selectedLabels).toHaveLength(2);
		const detailTexts = captured.messages
			.filter((message) => message.customType === "pao-panorama")
			.map((message) => message.text);
		expect(detailTexts.some((text) => text.includes(join(projectA, ".pao", "任务甲", "卡")))).toBe(true);
		expect(detailTexts.some((text) => text.includes(join(projectB, ".pao", "任务乙", "卡")))).toBe(true);
	});

	it("worker 行钻取:选 worker → ui.custom 被调且快照取口按 pid 匹配 listActive", async () => {
		const { writeFileSync } = await import("node:fs");
		const captured = capturePi();
		const runner = new WorkerRunner();
		const script = join(tempDir(), "noop.js");
		writeFileSync(script, "setTimeout(() => {}, 6000);", "utf8");
		const runPromise = runner.run({
			卡号: "0021",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd: tempDir(),
			证据目录: tempDir(),
		});
		try {
			let customFactory: ((...args: unknown[]) => unknown) | undefined;
			const custom = vi.fn((factory: (...args: unknown[]) => unknown) => {
				customFactory = factory;
				return Promise.resolve();
			});
			const selectQueue: (string | undefined)[] = [undefined, "退出"];
			const select = vi.fn((_title: string, options: string[]) => {
				if (selectQueue.length === 2) {
					const row = options.find((label) => label.startsWith("worker pid") && label.includes("卡0021"));
					selectQueue[0] = row;
				}
				return Promise.resolve(selectQueue.shift());
			});
			registerPanorama(captured.pi, { resolvePaoHome: () => tempDir(), getRunner: () => runner });
			await captured.runSub("pano", "", { mode: "tui", ui: { select, custom } });
			expect(select).toHaveBeenCalledTimes(2);
			expect(custom).toHaveBeenCalledTimes(1);
			expect(customFactory).toBeDefined();
		} finally {
			await runner.cancel("0021");
		}
		await runPromise;
	});

	it("resolvePaoHome 抛错:notify 错误不发页不炸", async () => {
		const notify = vi.fn();
		const captured = capturePi();
		registerPanorama(captured.pi, {
			resolvePaoHome: () => {
				throw new Error("缺少 PAO_HOME");
			},
		});
		await captured.runSub("pano", "", { mode: "json", ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("全景读取失败"), "error");
		expect(captured.messages).toHaveLength(0);
	});
});
