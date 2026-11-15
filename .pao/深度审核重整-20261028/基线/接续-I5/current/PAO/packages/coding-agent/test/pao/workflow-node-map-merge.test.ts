import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { loadCard, projectRootForCards, serializeCard } from "../../src/pao/cards/index.ts";
import { prepareDispatchBrief } from "../../src/pao/dispatch-brief/brief.ts";
import { executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { bindMinister, readControl, startControl } from "../../src/pao/workflow/control.ts";
import { resolveWorkflowDispatch } from "../../src/pao/workflow/dispatch-context.ts";
import { currentDependencyMaps, registerWorkflowMinisterTools } from "../../src/pao/workflow/minister.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class StubRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		return {
			card_no: options.卡号,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: [],
			summary: "离线派发",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: join(projectRootForCards(join(options.taskRoot!, "卡")), "证据.jsonl"),
			exitCode: 0,
			command: "stub",
			pid: 1,
			duration_ms: 1,
		};
	}
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pao-map-merge-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "任务", "卡");
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "export const a = true;\n");
	writeFileSync(join(root, "src", "b.ts"), "export const b = true;\n");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init", "--quiet");
	git("add", ".");
	git("-c", "user.email=pao@test", "-c", "user.name=pao", "commit", "--no-gpg-sign", "-qm", "base");
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "双地图交接",
			节点: [
				{ 名字: "A", 部门: "规划", 目标: "调查 A", 验收: "给出事实", 只读: true },
				{ 名字: "B", 部门: "审阅", 目标: "调查 B", 验收: "给出事实", 只读: true },
				{ 名字: "C", 部门: "开发", 目标: "消费两份地图", 验收: "存在: src/a.ts", depends_on: ["A", "B"] },
			],
		})}---`,
		join(root, "双地图交接.md"),
	);
	const options = { cardsDir, ownerSessionId: "owner", counterPath: join(root, "卡号.txt") };
	await startControl(recipe, {}, options);
	return { root, cardsDir, recipe, options };
}

function ctx(session: string): ExtensionToolContext {
	return { sessionManager: { getSessionId: () => session } } as unknown as ExtensionToolContext;
}

function toolsFor(
	recipeName: string,
	identity: { 实例: string; 节点: string; 轮次: number; 部长会话: string },
	cardsDir: string,
) {
	const tools = new Map<string, ToolDefinition>();
	const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
	registerWorkflowMinisterTools(pi, { 名字: recipeName, ...identity, owner: "owner", cardsDir });
	return tools;
}

async function saveMaps(s: Awaited<ReturnType<typeof fixture>>) {
	const ids: { 实例: string; 节点: string; 轮次: number; 部长会话: string }[] = [];
	for (const name of ["A", "B"]) {
		await bindMinister(s.recipe, s.options, name, `session-${name}`);
		const flow = readControl(s.recipe, s.options);
		const node = flow.节点.find((candidate) => candidate.名字 === name)!;
		const identity = { 实例: flow.实例, 节点: name, 轮次: node.轮次, 部长会话: `session-${name}` };
		ids.push(identity);
		const tools = toolsFor(s.recipe.名字, identity, s.cardsDir);
		await tools.get("pao_minister_save_node_map")!.execute(
			name,
			{
				coverage: [name === "A" ? "src/a.ts" : "src/b.ts"],
				facts: [name === "A" ? "A 入口在 src/a.ts" : "B 证据在 src/b.ts"],
				unknowns: [name === "A" ? "A 未知项保留" : "B 未知项保留"],
				risks: [name === "A" ? "A 风险保留" : "B 风险保留"],
				scope_basis: [`${name} 的调用方在本文件`],
				scope_confirmed: true,
			},
			undefined,
			undefined,
			ctx(`session-${name}`),
		);
	}
	for (const identity of ids) {
		const tools = toolsFor(s.recipe.名字, identity, s.cardsDir);
		await tools
			.get("pao_breakdown_done")!
			.execute(
				"done",
				{ zero_cards_reason: "已保存节点地图并交给下游" },
				undefined,
				undefined,
				ctx(identity.部长会话),
			);
	}
	return { maps: currentDependencyMaps(readControl(s.recipe, s.options), "C", s.cardsDir), identities: ids };
}

async function submitC(s: Awaited<ReturnType<typeof fixture>>) {
	await bindMinister(s.recipe, s.options, "C", "session-C");
	const flow = readControl(s.recipe, s.options);
	const node = flow.节点.find((candidate) => candidate.名字 === "C")!;
	const identity = { 实例: flow.实例, 节点: "C", 轮次: node.轮次, 部长会话: "session-C" };
	const tools = toolsFor(s.recipe.名字, identity, s.cardsDir);
	const submitted = await tools
		.get("pao_minister_submit_cards")!
		.execute(
			"submit",
			{ cards: [{ goal: "消费上游地图", acceptance: "存在: src/a.ts" }] },
			undefined,
			undefined,
			ctx("session-C"),
		);
	const text = submitted.content[0]?.type === "text" ? submitted.content[0].text : "";
	const cardNumber = /卡(\d+)/.exec(text)?.[1] ?? "";
	return loadCard(s.cardsDir, Number(cardNumber));
}

describe("双只读零卡上游地图交接", () => {
	it("两份 current 地图进入受保护派发 upstream 证据，简报真实消费且不丢结论", async () => {
		const s = await fixture();
		const { maps } = await saveMaps(s);
		expect(maps).toHaveLength(2);
		const card = await submitC(s);
		// 卡面不复制地图；交接引用只由控制正本进入派发。
		expect(card.frontmatter.inputs).toEqual([]);
		const check = (candidate: Parameters<typeof resolveWorkflowDispatch>[0]) =>
			resolveWorkflowDispatch(candidate, { cardsDir: s.cardsDir, owner: "owner" });
		expect(check(card)?.upstreamMapRefs).toEqual(maps);
		const draft = await prepareDispatchBrief({
			cardsDir: s.cardsDir,
			cardPath: card.path,
			projectRoot: s.root,
			executionRoot: s.root,
			upstreamRefs: maps.map((ref) => ({ ref })),
		});

		expect(draft.evidence.filter((entry) => entry.kind === "upstream").map((entry) => entry.ref)).toEqual(maps);
		expect(draft.briefMarkdown).toContain("A 入口在 src/a.ts");
		expect(draft.briefMarkdown).toContain("B 证据在 src/b.ts");
		expect(draft.briefMarkdown).toContain("A 未知项保留");
		expect(draft.briefMarkdown).toContain("B 风险保留");

		const runner = new StubRunner();
		const dispatched = await executeDispatch(
			{ cardsDir: s.cardsDir, card_no: String(card.card_no), operator: "owner", time: "2026-10-22 10:00" },
			{ 运行器: runner, workflowCheck: check },
			async () => "ok",
		);
		expect(dispatched.可派).toBe(true);
		expect(runner.runs).toHaveLength(1);
		// 包含两份地图的多次真实 Git 核验；Windows 实测完整链约 30 秒。
	}, 60_000);

	it("旧式两张自身主图仍拒绝；任一上游源覆盖变化在启动前拒绝", async () => {
		const s = await fixture();
		const { maps } = await saveMaps(s);
		const card = await submitC(s);
		const legacy = {
			...card.frontmatter,
			status: "unclaimed" as const,
			attempt: 0,
			inputs: maps,
		};
		writeFileSync(card.path, serializeCard(legacy, card.body));
		await expect(
			prepareDispatchBrief({
				cardsDir: s.cardsDir,
				cardPath: card.path,
				projectRoot: s.root,
				executionRoot: s.root,
			}),
		).rejects.toMatchObject({ code: "bad_reference" });

		writeFileSync(join(s.root, "src", "b.ts"), "export const b = false;\n");
		// 入队不消费地图；内容变化后仍能提交卡，但真正派发必须拦截且不启动工人。
		const current = await submitC(s);
		const runner = new StubRunner();
		await expect(
			executeDispatch(
				{ cardsDir: s.cardsDir, card_no: String(current.card_no), operator: "owner", time: "2026-10-22 10:01" },
				{
					运行器: runner,
					workflowCheck: (candidate) =>
						resolveWorkflowDispatch(candidate, { cardsDir: s.cardsDir, owner: "owner" }),
				},
				async () => "ok",
			),
		).rejects.toThrow("派发交接的地图覆盖内容已变化");
		expect(runner.runs).toHaveLength(0);
		expect(loadCard(s.cardsDir, current.card_no).frontmatter.status).toBe("unclaimed");
	});
});
