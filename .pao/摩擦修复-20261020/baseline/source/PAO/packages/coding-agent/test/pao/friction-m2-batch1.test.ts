/**
 * 摩擦日志 2026-10-02 M1-07 一条龙实测 5 条的 M2 首批修复回归：
 * ①计数器落点统一（双写→只写 .pao/卡号.txt，兼容读旧位置）
 * ②回执≠终态（汇报语义在工具输出/描述里更醒目）
 * ③建部日期由代码取当天写入注册表
 * ④入库同批机械订正条目内状态行
 * ⑤pao_ingest_kb 可选 新钩子 改写钩子提升检索区分度
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { readCard } from "../../src/pao/cards/cardfile.ts";
import { nextCardNumber } from "../../src/pao/cards/counter.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";
import { createDept, parseRegistry, readRegistry, today } from "../../src/pao/dept/index.ts";
import { ingestEntry } from "../../src/pao/knowledge/ingest.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

// ============================================================================
// ① 计数器落点统一
// ============================================================================

describe("摩擦M2-1 计数器落点统一到 .pao/卡号.txt", () => {
	it("旧落点（仓库根 卡号.txt）有账、新落点缺失：从旧值续发，只写新位置", async () => {
		const root = makeTempDir("pao-counter-legacy-");
		const legacyPath = join(root, "卡号.txt");
		const newPath = join(root, ".pao", "卡号.txt");
		mkdirSync(join(root, ".pao"), { recursive: true });
		writeFileSync(legacyPath, "5\n", "utf8");

		expect(await nextCardNumber(newPath)).toBe(6);
		expect(readFileSync(newPath, "utf8").trim()).toBe("6");
		// 旧文件原样保留不回写，逐渐自然废弃
		expect(readFileSync(legacyPath, "utf8").trim()).toBe("5");
	});

	it("双写并存且旧值更大：取旧值续发不重号", async () => {
		const root = makeTempDir("pao-counter-merge-");
		const legacyPath = join(root, "卡号.txt");
		const newPath = join(root, ".pao", "卡号.txt");
		mkdirSync(join(root, ".pao"), { recursive: true });
		writeFileSync(legacyPath, "9\n", "utf8");
		writeFileSync(newPath, "2\n", "utf8");

		expect(await nextCardNumber(newPath)).toBe(10);
		expect(readFileSync(newPath, "utf8").trim()).toBe("10");
		expect(readFileSync(legacyPath, "utf8").trim()).toBe("9");
	});

	it("无旧落点：.pao 布局照常从 1 起发", async () => {
		const root = makeTempDir("pao-counter-fresh-");
		const newPath = join(root, ".pao", "卡号.txt");
		expect(await nextCardNumber(newPath)).toBe(1);
		expect(existsSync(join(root, "卡号.txt"))).toBe(false);
	});
});

// ============================================================================
// ② 回执≠终态（汇报语义）
// ============================================================================

interface RegisteredTool {
	name: string;
	description: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

function setupCardTools() {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	registerCardTools(pi);
	return tools;
}

async function runTool(tool: RegisteredTool, params: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("test-call", params);
	return result.content.map((part) => part.text).join("\n");
}

describe("摩擦M2-2 回执≠终态（汇报语义醒目化）", () => {
	it("交回执输出尾部提示：回执只是声称完成，终态以 owner 执行 pao_change_status 为准", async () => {
		const dir = makeTempDir("pao-receipt-sem-");
		const cardDir = join(dir, "任务-20261002", "卡");
		mkdirSync(cardDir, { recursive: true });
		const tools = setupCardTools();

		await runTool(tools.get("pao_create_card")!, {
			cards_dir: cardDir,
			goal: "定位超时",
			dept: "核心机制",
			acceptance: "复现脚本落盘",
		});
		await runTool(tools.get("pao_change_status")!, {
			cards_dir: cardDir,
			card_ref: 1,
			operator: "部长A",
			new_status: "in_progress",
		});
		const receipt = await runTool(tools.get("pao_submit_receipt")!, {
			cards_dir: cardDir,
			card_ref: "卡#1",
			attempt: 1,
			结果: "完成",
			摘要: "复现脚本已落盘",
		});

		expect(receipt).toContain("回执≠终态");
		expect(receipt).toContain("owner 执行 pao_change_status");
		// 纯文案：逻辑未动，worker 交回执后状态仍不是终态
		const card = readCard(join(cardDir, "卡0001-定位超时.md"));
		expect(card.frontmatter.status).toBe("in_progress");
	});

	it("工具描述写明两者区别（模型看得到）", () => {
		const tools = setupCardTools();
		expect(tools.get("pao_submit_receipt")!.description).toContain("回执≠终态");
		expect(tools.get("pao_change_status")!.description).toContain("唯一通道");
	});
});

// ============================================================================
// ③ 建部日期由代码取当天写入
// ============================================================================

describe("摩擦M2-3 建部日期列由代码填当天", () => {
	it("pao_create_dept 落注册表行带当天建部日期，模板无待填占位残留", async () => {
		const home = makeTempDir("pao-dept-date-");
		await createDept({ paoHome: home, 名字: "平台评测", 标签: ["评测"] });

		const registryPath = join(home, "部门", "注册表.md");
		const text = readFileSync(registryPath, "utf8");
		expect(text).toContain("| 名字 | 能力标签 | 库路径 | 建部日期 |");
		expect(text).toContain(`| 平台评测 | 评测 | 部门/平台评测/知识库 | ${today()} |`);
		// 模板占位注释残留消除：注册表里没有任何「待填/占位」字样
		expect(text).not.toContain("待填");
		expect(text).not.toContain("占位");

		const rows = readRegistry(registryPath);
		expect(rows[0].建部日期).toBe(today());
	});

	it("parseRegistry 兼容旧 3 列行（建部日期缺省 undefined）与 4 列行", () => {
		const legacy = parseRegistry(
			["| 名字 | 能力标签 | 库路径 |", "| --- | --- | --- |", "| 后端 | api | 部门/后端/知识库 |"].join("\n"),
		);
		expect(legacy[0].建部日期).toBeUndefined();

		const modern = parseRegistry(
			[
				"| 名字 | 能力标签 | 库路径 | 建部日期 |",
				"| --- | --- | --- | --- |",
				"| 后端 | api | 部门/后端/知识库 | 2026-10-01 |",
			].join("\n"),
		);
		expect(modern[0].建部日期).toBe("2026-10-01");
	});
});

// ============================================================================
// ④ 入库同批机械订正条目内状态行
// ============================================================================

describe("摩擦M2-4 入库订正条目内候选语义状态行", () => {
	it("候选待晋升 → 正式，正文其余（含非候选状态行）一字不动", async () => {
		const libRoot = makeTempDir("pao-kb-status-");
		for (const dir of ["教训", "待验证"]) mkdirSync(join(libRoot, dir));
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(
			candidate,
			[
				"数据库连接池超时三条经验 2026-10-01",
				"状态: 候选待晋升",
				"正确做法：调大 pool 上限并设超时。",
				"状态: 已在项目A验证（此行非候选语义，保留）",
				"适用范围: demo-proj",
				"来源: 内部压测",
			].join("\n"),
			"utf8",
		);

		const result = await ingestEntry({ libRoot, candidatePath: candidate, type: "教训" });

		const targetPath = join(libRoot, "教训", "连接池经验.md");
		const raw = readFileSync(targetPath, "utf8");
		expect(raw).toContain("状态: 正式");
		expect(raw).not.toContain("候选待晋升");
		// 正文其余不动：非候选语义的行、普通正文与户口行全部原样
		expect(raw).toContain("状态: 已在项目A验证（此行非候选语义，保留）");
		expect(raw).toContain("正确做法：调大 pool 上限并设超时。");
		expect(raw).toContain("适用范围: demo-proj");
		expect(result.actions.some((a) => a.includes("条目状态行已订正"))).toBe(true);

		// 幂等重放：状态行已是 正式，不再产生订正动作
		const replay = await ingestEntry({ libRoot, candidatePath: targetPath, type: "教训" });
		expect(replay.actions.some((a) => a.includes("条目状态行已订正"))).toBe(false);
	});

	it("未知/待晋升/空值同批订正，正式不受影响", async () => {
		const libRoot = makeTempDir("pao-kb-status2-");
		for (const dir of ["做法", "待验证"]) mkdirSync(join(libRoot, dir));
		const cases: [string, string][] = [
			["状态: 未知", "状态: 正式"],
			["状态：待晋升", "状态: 正式"],
			["状态:", "状态: 正式"],
			["状态: 正式", "状态: 正式"],
		];
		for (const [index, [before]] of cases.entries()) {
			const candidate = join(libRoot, "待验证", `条目${index}.md`);
			writeFileSync(candidate, `做法条目钩子 2026-10-01\n${before}\n正文行\n`, "utf8");
			await ingestEntry({ libRoot, candidatePath: candidate, type: "做法", newFileName: `条目${index}.md` });
			const raw = readFileSync(join(libRoot, "做法", `条目${index}.md`), "utf8");
			expect(raw).toContain("状态: 正式");
			expect(raw.split("\n")[1].trim()).toBe("状态: 正式");
		}
	});
});

// ============================================================================
// ⑤ pao_ingest_kb 可选 新钩子
// ============================================================================

describe("摩擦M2-5 入库可选 新钩子 提升检索区分度", () => {
	it("传 新钩子：条目首行与子索引行都用新钩子，日期保留不标 ⚠️", async () => {
		const libRoot = makeTempDir("pao-kb-hook-");
		for (const dir of ["教训", "待验证"]) mkdirSync(join(libRoot, dir));
		const candidate = join(libRoot, "待验证", "连接池经验.md");
		writeFileSync(candidate, "数据库连接池超时经验 2026-10-01\n正文：先看 pool 上限。\n", "utf8");

		const newHook = "平台评测部 mysql 连接池抖动定位手法 2026-10-01";
		const result = await ingestEntry({ libRoot, candidatePath: candidate, type: "教训", 新钩子: newHook });

		const targetPath = join(libRoot, "教训", "连接池经验.md");
		expect(readFileSync(targetPath, "utf8").split("\n")[0]).toBe(newHook);
		const row = readFileSync(join(libRoot, "教训", "子索引.md"), "utf8")
			.split("\n")
			.find((l) => l.includes("](连接池经验.md)"));
		expect(row).toContain(newHook);
		expect(result.actions.some((a) => a.includes("钩子已改写"))).toBe(true);
		// 新钩子带日期：巡检不因缺日期标 ⚠️
		expect(result.inspection.findings[0].flagged).toBe(false);
	});

	it("未传 新钩子：沿用原首行（现状不变）", async () => {
		const libRoot = makeTempDir("pao-kb-hook2-");
		for (const dir of ["做法", "待验证"]) mkdirSync(join(libRoot, dir));
		const candidate = join(libRoot, "待验证", "部署清单.md");
		writeFileSync(candidate, "部署清单三步 2026-10-01\n正文\n", "utf8");

		await ingestEntry({ libRoot, candidatePath: candidate, type: "做法" });

		expect(readFileSync(join(libRoot, "做法", "部署清单.md"), "utf8").split("\n")[0]).toBe("部署清单三步 2026-10-01");
		const row = readFileSync(join(libRoot, "做法", "子索引.md"), "utf8")
			.split("\n")
			.find((l) => l.includes("](部署清单.md)"));
		expect(row).toContain("部署清单三步 2026-10-01");
	});
});
