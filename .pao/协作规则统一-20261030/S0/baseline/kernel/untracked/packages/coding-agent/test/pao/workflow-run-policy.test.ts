import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { controlPath, controlReport, readControl, startControl } from "../../src/pao/workflow/control.ts";
import { renderReport } from "../../src/pao/workflow/driver.ts";
import type { WorkflowRunMode } from "../../src/pao/workflow/policy.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { registerWorkflowTools } from "../../src/pao/workflow/tools.ts";

const ENV_KEYS = ["PAO_HOME", "PAO_RUN_MODE", "PI_OFFLINE", "PI_NO_LOCAL_LLM"] as const;

interface Tool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		update?: unknown,
		ctx?: { hasUI: boolean; ui: { confirm: () => Promise<boolean> } },
	) => Promise<{ content: { type: string; text: string }[] }>;
}

const roots: string[] = [];
let envBackup: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root: string;
let site: string;
let project: string;
let cardsDir: string;

function recipeContent(gated = false): string {
	return `---
版本: 2
名字: ${gated ? "人工门样例" : "运行方式样例"}
自动执行: false
参数: []
节点:
  - 名字: 实施
    部门: 开发部
    目标: 完成样例
    验收: "存在: 成果.txt"
${gated ? "    人工确认: true\n" : ""}---
`;
}

function recipe(gated = false) {
	return parseRecipe(recipeContent(gated), join(site, "工作流", `${gated ? "人工门样例" : "运行方式样例"}.md`));
}

function writeSiteRecipe(gated = false): void {
	const value = recipe(gated);
	writeFileSync(value.文件路径, recipeContent(gated), "utf8");
}

function driverOptions(mode: WorkflowRunMode = "attended") {
	return {
		cardsDir,
		ownerSessionId: "owner",
		runMode: mode,
	};
}

function registerTools(mode: () => WorkflowRunMode) {
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	registerWorkflowTools(pi, {
		resolvePaoHome: () => site,
		resolveCardsDir: () => cardsDir,
		resolveOwnerSessionId: () => "owner",
		resolveRunMode: mode,
	});
	return tools;
}

async function runTool(tools: Map<string, Tool>, name: string, params: Record<string, unknown>): Promise<string> {
	const result = await tools.get(name)!.execute("test", params, undefined, undefined, {
		hasUI: true,
		ui: { confirm: async () => true },
	});
	return result.content.map((part) => part.text).join("\n");
}

beforeEach(() => {
	const temporaryRoot = process.env.PAO_HOME;
	if (!temporaryRoot) throw new Error("运行方式测试须先设置隔离 PAO_HOME 作为临时目录父级");
	mkdirSync(temporaryRoot, { recursive: true });
	root = mkdtempSync(join(temporaryRoot, "pao-run-policy-"));
	roots.push(root);
	site = join(root, "site");
	project = join(root, "project");
	cardsDir = join(project, ".pao", "卡");
	mkdirSync(join(site, "工作流"), { recursive: true });
	mkdirSync(join(site, "pao配置"), { recursive: true });
	mkdirSync(join(site, "部门", "开发部"), { recursive: true });
	mkdirSync(cardsDir, { recursive: true });
	writeFileSync(
		join(site, "pao配置", "档位.json"),
		JSON.stringify({ 档位: [{ 名: "快", provider: "offline", model: "fake", thinkingLevel: "off" }] }),
	);
	writeFileSync(
		join(site, "部门", "注册表.md"),
		"| 名字 | 能力标签 | 库路径 | 建部日期 |\n| --- | --- | --- | --- |\n| 开发部 | 开发 | 部门/开发部 | 2026-10-30 |\n",
	);
	writeFileSync(join(site, "部门", "开发部", "配方.md"), "离线样例配方\n");
	for (const key of ENV_KEYS) envBackup[key] = process.env[key];
	process.env.PAO_HOME = site;
	process.env.PI_OFFLINE = "1";
	process.env.PI_NO_LOCAL_LLM = "1";
	delete process.env.PAO_RUN_MODE;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const previous = envBackup[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	envBackup = {};
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("I1-1 新实例可信运行方式", () => {
	test("startControl 在落盘前拒绝模型自行提权，不创建实例", async () => {
		const value = recipe();
		await expect(startControl(value, { run_mode: "unattended" }, driverOptions("attended"))).rejects.toThrow(
			/冲突.*仅授权 attended/,
		);
		expect(existsSync(controlPath(value, driverOptions("attended")))).toBe(false);
	});

	test("旧的 v2 控制清单没有运行方式字段时按有人值守读取", async () => {
		const value = recipe();
		await startControl(value, {}, driverOptions("attended"));
		const path = controlPath(value, driverOptions("attended"));
		const text = readFileSync(path, "utf8").replace(/^运行方式: 有人值守\r?\n/m, "");
		writeFileSync(path, text, "utf8");
		const flow = readControl(value, driverOptions());
		expect(flow.运行方式).toBeUndefined();
		expect(controlReport(flow).run_mode).toBe("attended");
		expect(renderReport(controlReport(flow))).toContain("运行方式：有人值守");
	});

	test("可信 unattended 默认冻结，参数不留策略键，push 与查询不能改写", async () => {
		writeSiteRecipe();
		let trusted: WorkflowRunMode = "unattended";
		const tools = registerTools(() => trusted);
		const started = await runTool(tools, "pao_start_flow", { name: "运行方式样例" });
		expect(started).toContain("运行方式：无人值守");
		const value = recipe();
		const flow = readControl(value, driverOptions());
		expect(flow.运行方式).toBe("无人值守");
		expect(flow.参数).not.toHaveProperty("run_mode");
		expect(readFileSync(controlPath(value, driverOptions()), "utf8")).toContain("运行方式: 无人值守");

		trusted = "attended";
		await runTool(tools, "pao_push_flow", { name: "运行方式样例" });
		const queried = await runTool(tools, "pao_query_flow", { name: "运行方式样例" });
		expect(queried).toContain("运行方式：无人值守");
		expect(readControl(value, driverOptions()).运行方式).toBe("无人值守");

		await expect(
			runTool(tools, "pao_start_flow", { name: "运行方式样例", params: { run_mode: "unattended" } }),
		).rejects.toThrow(/冲突.*仅授权 attended/);
		expect(readControl(value, driverOptions()).运行方式).toBe("无人值守");
	});

	test("工具入口拒绝未知模式、非法可信值和未授权无人值守，且不写实例", async () => {
		writeSiteRecipe();
		let trusted: unknown = "attended";
		const tools = registerTools(() => trusted as WorkflowRunMode);
		const value = recipe();
		await expect(
			runTool(tools, "pao_start_flow", { name: "运行方式样例", params: { run_mode: "unattended" } }),
		).rejects.toThrow(/仅授权 attended/);
		await expect(
			runTool(tools, "pao_start_flow", { name: "运行方式样例", params: { run_mode: "automatic" } }),
		).rejects.toThrow(/run_mode 须为 attended 或 unattended/);
		trusted = "invalid";
		await expect(runTool(tools, "pao_start_flow", { name: "运行方式样例" })).rejects.toThrow(
			/可信宿主运行方式配置无效/,
		);
		expect(existsSync(controlPath(value, driverOptions()))).toBe(false);
	});

	test("可信 unattended 下人工确认节点在创建实例前拒绝", async () => {
		writeSiteRecipe(true);
		const tools = registerTools(() => "unattended");
		const value = recipe(true);
		await expect(runTool(tools, "pao_start_flow", { name: "人工门样例" })).rejects.toThrow(
			/人工确认门.*无人值守实例不能越过人工门/,
		);
		expect(existsSync(controlPath(value, driverOptions("unattended")))).toBe(false);
		await expect(startControl(value, {}, driverOptions("unattended"))).rejects.toThrow(
			/人工确认门.*无人值守实例不能越过人工门/,
		);
		expect(existsSync(controlPath(value, driverOptions("unattended")))).toBe(false);
	});

	test("可信 unattended 允许模型显式降低为 attended，本次新实例冻结 attended", async () => {
		writeSiteRecipe();
		const tools = registerTools(() => "unattended");
		await runTool(tools, "pao_start_flow", {
			name: "运行方式样例",
			params: { run_mode: "attended" },
		});
		expect(readControl(recipe(), driverOptions("unattended")).运行方式).toBe("有人值守");
	});
});
