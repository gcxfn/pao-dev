/**
 * §16.1 首跑清单单测：四类待办各有料才出行（未完卡失败点名/就绪未派 §19 通道③/
 * 挂起工作流两层布局/部门积压同源计数）、全空如实空闲、session_start 显示一次
 * 不进每轮提示、渲染失败不炸会话启动。数据源全部同源件,本套只钉聚合与呈现。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCard } from "../../src/pao/cards/index.ts";
import type { CardStatus } from "../../src/pao/cards/types.ts";
import { formatRegistry } from "../../src/pao/dept/registry.ts";
import { buildFirstRunList, registerFirstRun } from "../../src/pao/status/firstrun.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-firstrun-"));
	tempDirs.push(dir);
	return dir;
}

/** 落项目清单（一行一项目）＋返回该项目卡目录（平布局 <项目根>/.pao/卡） */
function setupProject(paoHome: string, projectName: string): string {
	const projectRoot = tempDir();
	mkdirSync(join(projectRoot, ".pao", "卡"), { recursive: true });
	writeFileSync(
		join(paoHome, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| ${projectName} | ${projectRoot} | 2026-10-03 10:00 | 2026-10-03 10:00 |\n`,
		"utf8",
	);
	return join(projectRoot, ".pao", "卡");
}

async function makeCard(cardsDir: string, target: string, status: CardStatus, dependsOn: string[] = []): Promise<void> {
	await createCard(
		cardsDir,
		{ 目标: target, 部门: "测试", 验收: "完成", 创建: "2026-10-03 12:00", 状态: status, depends_on: dependsOn },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
}

/** 工作流实例文件（driver serializeManifest 同构 frontmatter）;sub 省略＝平布局 .pao 顶层,给出＝任务工作区 */
function writeManifest(paoHome: string, projectName: string, workflowName: string, status: string, sub?: string): void {
	const rows = readFileSync(join(paoHome, "项目清单.md"), "utf8")
		.split("\n")
		.find((line) => line.includes(projectName));
	if (!rows) throw new Error(`项目 ${projectName} 未登记`);
	const projectRoot = rows.split("|")[2].trim();
	const dir = sub === undefined ? join(projectRoot, ".pao") : join(projectRoot, ".pao", sub);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `工作流实例-${workflowName}.md`),
		`---\n工作流: ${workflowName}\n卡目录: ${dir}\n启动: 2026-10-03 10:00\n状态: ${status}\n参数: {}\n节点: []\n---\n<!-- 测试实例 -->\n`,
		"utf8",
	);
}

describe("buildFirstRunList（§16.1 纯读聚合）", () => {
	it("空 PAO_HOME：如实空闲一句,不冒充待办", async () => {
		const text = await buildFirstRunList(tempDir());
		expect(text).toContain("首跑清单（§16.1）");
		expect(text).toContain("今日待办:无");
		expect(text).toContain("/状态");
	});

	it("坏卡计入待办并给 ✗ 前缀与路径,不当空闲（审查第 5 项）", async () => {
		const home = tempDir();
		const cardsDir = setupProject(home, "项目甲");
		writeFileSync(join(cardsDir, "卡0009-坏卡.md"), "---\n目标: 坏卡\n---\n正文\n", "utf8");
		const text = await buildFirstRunList(home);
		expect(text).toContain("坏卡 1");
		expect(text).toContain("卡0009-坏卡.md");
		expect(text).toContain("✗ ");
		expect(text).not.toContain("今日待办:无");
	});

	it("未完卡:失败点名卡号与目标,进行中计数,已交付/待认领不出行", async () => {
		const home = tempDir();
		const cardsDir = setupProject(home, "项目A");
		await makeCard(cardsDir, "做甲", "in_progress");
		await makeCard(cardsDir, "做乙", "failed");
		await makeCard(cardsDir, "做丙", "delivered");
		const text = await buildFirstRunList(home);
		expect(text).toContain("✗ - 项目A:进行中 1、失败 1（卡0002 做乙）"); // 二批图形化：失败点名行首 ✗
		expect(text).not.toContain("做甲）"); // 进行中只计数不点名
		expect(text).not.toContain("做丙");
	});

	it("就绪未派（§19 通道③）:待认领＋依赖全交付才列,点卡号;无依赖卡不列", async () => {
		const home = tempDir();
		const cardsDir = setupProject(home, "项目B");
		await makeCard(cardsDir, "前置", "delivered");
		await makeCard(cardsDir, "下游活", "unclaimed", ["卡0001"]);
		await makeCard(cardsDir, "独立活", "unclaimed");
		const text = await buildFirstRunList(home);
		expect(text).toContain("○ - 项目B:就绪未派 1（卡0002）"); // 二批图形化：就绪未派行首 ○
		expect(text).not.toContain("卡0003");
	});

	it("待认领巡库卡按 isPatrolGoal 口径计数,普通待认领不算", async () => {
		const home = tempDir();
		const cardsDir = setupProject(home, "项目C");
		await makeCard(cardsDir, "巡库：全库体检", "unclaimed");
		await makeCard(cardsDir, "普通活", "unclaimed");
		const text = await buildFirstRunList(home);
		expect(text).toContain("◇ - 项目C:巡库待认领 1"); // 二批图形化：巡库行首 ◇
	});

	it("挂起工作流:平布局与任务工作区两层都扫,已完成不列", async () => {
		const home = tempDir();
		setupProject(home, "项目D");
		writeManifest(home, "项目D", "修复链", "挂起");
		writeManifest(home, "项目D", "重构", "挂起", "任务X");
		writeManifest(home, "项目D", "跑完的", "已完成");
		const text = await buildFirstRunList(home);
		expect(text).toContain("⏸ - 挂起工作流 2:修复链（项目D）、重构（项目D）"); // 二批图形化：挂起行首 ⏸
		expect(text).not.toContain("跑完的");
	});

	it("部门积压:同源计数（待验证条数＋⚠️ 行数）", async () => {
		const home = tempDir();
		mkdirSync(join(home, "部门", "测试部", "知识库", "待验证"), { recursive: true });
		writeFileSync(
			join(home, "部门", "注册表.md"),
			formatRegistry([{ 名字: "测试部", 标签: ["qa"], 库路径: "部门/测试部/知识库" }]),
			"utf8",
		);
		writeFileSync(join(home, "部门", "测试部", "知识库", "待验证", "候选1.md"), "内容", "utf8");
		mkdirSync(join(home, "部门", "测试部", "知识库", "教训"), { recursive: true });
		writeFileSync(join(home, "部门", "测试部", "知识库", "教训", "子索引.md"), "- 条目 ⚠️ 需复核\n- 正常", "utf8");
		const text = await buildFirstRunList(home);
		expect(text).toContain("⚠ - 部门待验证 1 条（测试部 1）"); // 二批图形化：部门积压行首 ⚠
		expect(text).toContain("⚠ - 知识库 ⚠️ 1 行（教训 1）");
	});
});

describe("registerFirstRun（session_start 一次）", () => {
	function capturePi() {
		const messages: { customType: string; text: string }[] = [];
		const handlers = new Map<string, ((event?: unknown) => unknown)[]>();
		const pi = {
			on: (event: string, handler: (event?: unknown) => unknown) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => {};
			},
			registerCommand: () => {},
			registerTool: () => {},
			sendMessage: (message: { customType: string; content: { text: string }[] }) =>
				messages.push({ customType: message.customType, text: message.content[0].text }),
		} as unknown as ExtensionAPI;
		return { messages, handlers, pi };
	}

	it("session_start 显示一次今日待办（customType pao-firstrun,display 用户面）", async () => {
		const home = tempDir();
		const captured = capturePi();
		registerFirstRun(captured.pi, { resolvePaoHome: () => home });
		expect(captured.messages).toHaveLength(0);
		for (const handler of captured.handlers.get("session_start") ?? []) await handler();
		expect(captured.messages).toHaveLength(1);
		expect(captured.messages[0].customType).toBe("pao-firstrun");
		expect(captured.messages[0].text).toContain("今日待办:无");
	});
	it("首跑历史保留，但普通请求、压缩与树摘要全部排除其他项目待办", async () => {
		const captured = capturePi();
		registerFirstRun(captured.pi, { resolvePaoHome: tempDir });
		const messages = [
			{ role: "custom", customType: "pao-firstrun", content: "其他项目秘密待办" },
			{ role: "user", content: "当前项目任务" },
		];
		const result = captured.handlers.get("context")?.[0]({ messages }) as { messages: unknown[] };
		expect(result.messages).toEqual([messages[1]]);
		expect(messages).toHaveLength(2);
		const compact = { preparation: { messagesToSummarize: messages, turnPrefixMessages: messages } };
		captured.handlers.get("session_before_compact")?.[0](compact);
		expect(compact.preparation.messagesToSummarize).toEqual([messages[1]]);
		expect(compact.preparation.turnPrefixMessages).toEqual([messages[1]]);
		const entry = { type: "custom_message", customType: "pao-firstrun", content: "其他项目秘密待办" };
		const tree = { preparation: { entriesToSummarize: [entry, { type: "message", message: messages[1] }] } };
		captured.handlers.get("session_before_tree")?.[0](tree);
		expect(tree.preparation.entriesToSummarize).toHaveLength(1);
		expect(JSON.stringify(tree)).not.toContain("其他项目秘密待办");
	});

	it("渲染抛错被兜住:warn 不炸会话启动,不 sendMessage", async () => {
		const captured = capturePi();
		registerFirstRun(captured.pi, {
			resolvePaoHome: () => {
				throw new Error("boom");
			},
		});
		for (const handler of captured.handlers.get("session_start") ?? []) await handler();
		expect(captured.messages).toHaveLength(0);
	});
});
