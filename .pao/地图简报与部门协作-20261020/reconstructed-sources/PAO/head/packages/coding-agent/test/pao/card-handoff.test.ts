import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { renderHandoff } from "../../src/pao/cards/handoff.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";

/**
 * M2-09 件4 交接页机械生成（pao_handoff）：四段 markdown，纯机械数据源，
 * 「已验证的」与「还在猜的」分明（不可核验/未验收如实标注）；整页只读不落盘。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-handoff-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** git 仓库：提交基线后留「用户既有改动」（修改 1 个跟踪文件 + 1 个未跟踪便签）。 */
function makeRepo(): string {
	const repo = tempDir();
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "代码.ts"), "export {};\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	writeFileSync(join(repo, "已跟踪.txt"), "v2-用户改的\n");
	writeFileSync(join(repo, "用户便签.txt"), "用户自己的未跟踪文件\n");
	return repo;
}

function makeCardsDir(): string {
	const cardDir = join(tempDir(), "任务", "卡");
	mkdirSync(cardDir, { recursive: true });
	return cardDir;
}

const createCardInput = { 部门: "核心机制", 验收: "存在: 产物/x.md", 创建: "2026-10-02 22:00" };

describe("renderHandoff 交接页四段", () => {
	test("空队列：四段标题齐全，当前目标与未决事项如实标空", async () => {
		const text = await renderHandoff(join(tempDir(), "没有卡"), { 时间: "2026-10-02 23:00" });
		expect(text).toContain("# 交接页（机械生成 2026-10-02 23:00）");
		expect(text).toContain("## 当前目标");
		expect(text).toContain("无活卡（队列为空或全部终态）");
		expect(text).toContain("## 已发生改动");
		expect(text).toContain("## 验证结果");
		expect(text).toContain("## 未决事项");
		expect(text).toContain("无未决事项。");
	});

	test("活卡无基线无验收：如实标 不可核验 与 未验收，不猜", async () => {
		const cardDir = makeCardsDir();
		await createCard(cardDir, { ...createCardInput, 目标: "无基线的卡" });
		const text = await renderHandoff(cardDir, { 时间: "2026-10-02 23:00" });
		expect(text).toContain("卡0001 无基线的卡");
		expect(text).toMatch(/## 已发生改动[\s\S]*不可核验（认领基线不可用/);
		expect(text).toMatch(/## 验证结果[\s\S]*未验收（卡上无机械验收记录）/);
		expect(text).toContain("无未决事项。");
	});

	test("基线可用的活卡：改动清单进页；交回执后进未决事项；整页只读不落盘", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(
			cardDir,
			{ ...createCardInput, 目标: "实现登录" },
			{
				counterPath: join(cardDir, "..", "卡号.txt"),
			},
		);
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 22:05" });
		const baseline = await snapshotClaimBaseline(cardDir, 1, { owner: "部长A", 时间: "2026-10-02 22:05" });
		expect(baseline.可用).toBe(true);
		// worker 干活：改跟踪文件 + 新增产物（用户既有文件不动）
		writeFileSync(join(repo, "src", "代码.ts"), "export const x = 1;\n");
		writeFileSync(join(repo, "产物.diff"), "+worker 的新产物\n");
		appendReceipt(readCard(card.path), { 尝试号: 1, 时间: "2026-10-02 22:10", 结果: "完成", 摘要: "登录完成" });

		const before = readFileSync(card.path, "utf8");
		const text = await renderHandoff(cardDir, { 时间: "2026-10-02 23:00" });
		expect(readFileSync(card.path, "utf8")).toBe(before); // 只读：卡文件未动
		expect(text).toContain("基线外改动 2 个文件");
		expect(text).toContain("M src/代码.ts");
		expect(text).toContain("?? 产物.diff");
		expect(text).toContain("比对基线");
		expect(text).toContain("待审（回执已交，待 owner 审核落终态）");
		// 该卡基线可用：已发生改动段不再标不可核验（页头口径行除外）
		expect(text.split("## 验证结果")[0]).not.toMatch(/- 卡0001[^\n]*不可核验/);
	});

	test("卡上机械验收记录进验证结果段（复用 readLatestVerdict）", async () => {
		const cardDir = makeCardsDir();
		await createCard(
			cardDir,
			{ ...createCardInput, 目标: "已机械核对过的卡" },
			{
				模板正文: "## 机械验收 2026-10-02 21:30\n- 结论: 全过停人工审\n",
			},
		);
		const text = await renderHandoff(cardDir);
		expect(text).toContain("机械验收 2026-10-02 21:30 → 全过停人工审");
	});

	test("终态分流：已交付只退出当前目标；失败/取消进未决事项（终态非已交付）", async () => {
		const cardDir = makeCardsDir();
		const deliverCard = await createCard(cardDir, { ...createCardInput, 目标: "要交付的卡" });
		changeCardStatus(deliverCard, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 22:05" });
		changeCardStatus(deliverCard, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:20", 依据: "验收通过" });
		const cancelCard = await createCard(cardDir, { ...createCardInput, 目标: "要取消的卡" });
		changeCardStatus(cancelCard, { 操作者: "用户", to: "canceled", 时间: "2026-10-02 22:25", 依据: "改需求" });
		const failedCard = await createCard(cardDir, { ...createCardInput, 目标: "会失败的卡" });
		changeCardStatus(failedCard, { 操作者: "部长B", to: "in_progress", 时间: "2026-10-02 22:30" });
		changeCardStatus(failedCard, {
			操作者: "部长B",
			to: "failed",
			失败类型: "missing_input",
			时间: "2026-10-02 22:35",
			依据: "缺凭证",
		});

		const text = await renderHandoff(cardDir, { 时间: "2026-10-02 23:00" });
		const currentGoalSection = text.split("## 已发生改动")[0];
		expect(currentGoalSection).toContain("会失败的卡"); // 失败仍属活卡组
		expect(currentGoalSection).not.toContain("要交付的卡");
		expect(currentGoalSection).not.toContain("要取消的卡");
		const pendingSection = text.split("## 未决事项")[1]!;
		expect(pendingSection).toContain("要取消的卡");
		expect(pendingSection).toContain("canceled（终态非已交付，待 owner 裁决重派/作废）");
		expect(pendingSection).toContain("会失败的卡");
		expect(pendingSection).toContain("failed（终态非已交付，待 owner 裁决重派/作废）");
		expect(pendingSection).not.toContain("要交付的卡");
	});
});

// ── pao_handoff 工具注册与执行 ───────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	description: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

function setup(options?: Parameters<typeof registerCardTools>[1]) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	registerCardTools(pi, options);
	return tools;
}

async function runTool(tool: RegisteredTool, params: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("test-call", params);
	return result.content.map((part) => part.text).join("\n");
}

describe("pao_handoff 工具", () => {
	test("注册面：pao_handoff 可注册，description 说明只读与四段口径", () => {
		const tools = setup();
		const tool = tools.get("pao_handoff");
		expect(tool).toBeTruthy();
		expect(tool!.description).toContain("只读不落盘");
		expect(tool!.description).toContain("不可核验");
	});

	test("卡目录显式传入与 resolveCardsDir 缺省都出四段页", async () => {
		const cardDir = makeCardsDir();
		await createCard(cardDir, { ...createCardInput, 目标: "交接工具卡" });
		const tools = setup({ resolveCardsDir: () => cardDir });
		const explicit = await runTool(tools.get("pao_handoff")!, { cards_dir: cardDir });
		expect(explicit).toContain("# 交接页");
		expect(explicit).toContain("卡0001 交接工具卡");
		const defaultCase = await runTool(tools.get("pao_handoff")!, {});
		expect(defaultCase).toContain("卡0001 交接工具卡");
	});
});
