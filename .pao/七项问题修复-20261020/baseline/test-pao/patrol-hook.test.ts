/**
 * 卡0006 验收 3＋4：afterInspect 回调接线——缺省时 pao_inspect_kb 行为与现在完全一致；
 * 接线后回调收巡检报告、可触发落卡并把提示文本并进工具输出（含幂等提示）。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listCards } from "../../src/pao/cards/index.ts";
import { registerKnowledgeTools } from "../../src/pao/knowledge/tools.ts";
import { createPatrolHook } from "../../src/pao/patrol/hook.ts";

let root: string;
let cardsDir: string;
let libRoot: string;
const NOW = new Date("2026-10-02T10:00:00");

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pao-patrol-hook-"));
	cardsDir = join(root, ".pao", "卡");
	libRoot = join(root, "知识库");
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(libRoot);
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir));
	}
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** 写一条超期条目（首行日期远早于当前，稳定触发 ⚠️，不依赖网络与端点）。 */
function writeStale(relPath: string): void {
	writeFileSync(join(libRoot, relPath), "超期条目 2026-01-01 版本:v2\n正文\n适用范围: demo-proj", "utf8");
}

interface RegisteredTool {
	name: string;
	definition: ToolDefinition<any, any, any>;
}

function fakePi(): ExtensionAPI & { registered: RegisteredTool[] } {
	const registered: RegisteredTool[] = [];
	const api = {
		registerTool(definition: ToolDefinition<any, any, any>) {
			registered.push({ name: definition.name, definition });
		},
	};
	return Object.assign(api, { registered }) as never;
}

function inspectTool(pi: ExtensionAPI & { registered: RegisteredTool[] }): ToolDefinition<any, any, any> {
	return pi.registered.find((t) => t.name === "pao_inspect_kb")!.definition;
}

async function runInspect(pi: ExtensionAPI & { registered: RegisteredTool[] }): Promise<string> {
	const result = await inspectTool(pi).execute(
		"id",
		{ kb_path: libRoot, stale_days: 90 } as never,
		undefined,
		undefined,
		{} as never,
	);
	return result.content[0].type === "text" ? result.content[0].text : "";
}

function hookOptions() {
	return {
		部门: "后端",
		resolveCardsDir: () => cardsDir,
		counterPath: join(root, "卡号.txt"),
		知识库路径: libRoot,
		now: () => NOW,
	};
}

describe("卡0006：afterInspect 回调接线", () => {
	test("缺省（不传 afterInspect）：pao_inspect_kb 行为与未接线完全一致，不落卡", async () => {
		writeStale("教训/超期.md");
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null });
		const text = await runInspect(pi);
		expect(text).toContain("巡检完成");
		expect(text).toContain("⚠️ 1 条");
		expect(text).not.toContain("巡库");
		expect(readdirSync(cardsDir).filter((f) => f.endsWith(".md")).length).toBe(0);
	});

	test("接线后过阈值：落巡库卡，提示文本并进 pao_inspect_kb 输出", async () => {
		for (const name of ["教训/a.md", "教训/b.md", "做法/c.md", "导览/d.md", "评测/e.md"]) {
			writeStale(name);
		}
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null, afterInspect: createPatrolHook(hookOptions()) });
		const text = await runInspect(pi);
		expect(text).toContain("巡检完成");
		expect(text).toContain("已落巡库卡");
		expect(text).toContain("不准动条目正文");
		// 落卡可查：状态 待认领、部门=发起部门
		const cards = listCards(cardsDir);
		expect(cards.length).toBe(1);
		expect(cards[0]!.frontmatter.goal.startsWith("巡库：")).toBe(true);
		expect(cards[0]!.frontmatter.status).toBe("unclaimed");
		expect(cards[0]!.frontmatter.dept).toBe("后端");
		expect(cards[0]!.frontmatter.tier).toBe("fast");
		// 输入含知识库根指针与 ⚠️ 条目相对路径
		expect(cards[0]!.frontmatter.inputs).toContain(`知识库根:${libRoot}`);
		expect(cards[0]!.frontmatter.inputs).toContain("教训/a.md");
		// 提示文本带卡号
		expect(text).toContain(`卡#${cards[0]!.card_no}`);
	});

	test("接线后不过阈值：回调返回 undefined，输出不追加、不落卡", async () => {
		writeStale("教训/a.md"); // 1 条 < 阈值 5
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null, afterInspect: createPatrolHook(hookOptions()) });
		const text = await runInspect(pi);
		expect(text).toContain("巡检完成");
		expect(text).not.toContain("巡库卡");
		expect(readdirSync(cardsDir).filter((f) => f.endsWith(".md")).length).toBe(0);
	});

	test("回调幂等：同部门未终态巡库卡已存在 → 提示不重复落卡", async () => {
		for (const name of ["教训/a.md", "教训/b.md", "做法/c.md", "导览/d.md", "评测/e.md"]) {
			writeStale(name);
		}
		const pi = fakePi();
		registerKnowledgeTools(pi, { embed: null, afterInspect: createPatrolHook(hookOptions()) });
		const first = await runInspect(pi);
		expect(first).toContain("已落巡库卡");
		const second = await runInspect(pi);
		expect(second).toContain("不重复落卡");
		expect(listCards(cardsDir).length).toBe(1);
	});

	test("createPatrolHook 直调：不过阈值返回 undefined，不触碰卡目录", async () => {
		const hook = createPatrolHook(hookOptions());
		const hint = await hook({ findings: [], flaggedCount: 0 });
		expect(hint).toBeUndefined();
		expect(readdirSync(cardsDir).filter((f) => f.endsWith(".md")).length).toBe(0);
	});
});
