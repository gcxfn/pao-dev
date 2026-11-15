/** 部门直接任务完成链：真实 Git 与 Node 子进程；业务回执为固定离线夹具，不调用模型。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { listCards } from "../../src/pao/cards/index.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const roots: string[] = [];
const shutdowns: (() => Promise<void>)[] = [];
beforeEach(() => {
	vi.stubEnv("PAO_ROLE", "主控");
	vi.stubEnv("PAO_DEPT", "");
});
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=offline", "-c", "user.email=offline@example.invalid", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

it.each([
	{ label: "机械验收通过后自动交付并提交", acceptance: "存在: result.txt", status: "delivered", committed: true },
	{ label: "机械条件未过时保留失败证据", acceptance: "存在: missing.txt", status: "failed", committed: false },
	{
		label: "blocked 不因机械全过而交付",
		acceptance: "存在: result.txt",
		status: "in_progress",
		committed: false,
		taskState: "blocked",
	},
	{
		label: "checkpoint 不因机械全过而交付",
		acceptance: "存在: result.txt",
		status: "in_progress",
		committed: false,
		taskState: "checkpoint",
	},
	{
		label: "人工条件保留待审，不由完成自报放行",
		acceptance: "存在: result.txt\n用户确认内容符合要求",
		status: "in_progress",
		committed: false,
	},
])(
	"受理直接任务：$label",
	async (scenario) => {
		const { acceptance, status, committed } = scenario;
		const taskState = "taskState" in scenario ? scenario.taskState : "completed";
		const root = mkdtempSync(join(tmpdir(), "pao-intake-completion-"));
		roots.push(root);
		const project = join(root, "project");
		const paoHome = join(root, "home");
		const cardsDir = join(project, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		mkdirSync(join(paoHome, "pao配置"), { recursive: true });
		await createDept({ paoHome, 名字: "实施" });
		writeFileSync(
			join(paoHome, "pao配置", "档位.json"),
			JSON.stringify({
				provider: "pao",
				档位: [{ 名: "primary", provider: "offline", model: "offline", thinkingLevel: "off" }],
			}),
		);
		writeFileSync(join(project, "input.txt"), "原始输入\n");
		git(project, "init", "--quiet");
		git(project, "add", "input.txt");
		git(project, "commit", "--no-gpg-sign", "-qm", "baseline");
		const baseline = git(project, "rev-parse", "HEAD");
		const script = join(root, "worker.cjs");
		writeFileSync(
			script,
			[
				'const fs = require("node:fs");',
				'fs.writeFileSync("result.txt", "离线工人实际产物\\n");',
				`const receipt = ${JSON.stringify({ result: "success", summary: "固定离线回执", artifact_path: ["result.txt"], 任务态: taskState, changes: [{ 类型: "created", 路径: "result.txt", 说明: "真实工人写入" }] })};`,
				'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(receipt)}],stopReason:"end"}}));',
			].join("\n"),
		);
		const tools: ToolDefinition[] = [];
		const runner = new WorkerRunner({ 证据目录: join(root, "evidence") });
		const pi = {
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") shutdowns.push(handler);
			},
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		const face = registerWorkerTools(pi, {
			runner,
			signals: false,
			resolveCardsDir: () => cardsDir,
			resolvePaoHome: () => paoHome,
			dispatchParameters: { 命令: process.execPath, 参数: [script] },
		});
		const tool = tools.find((entry) => entry.name === "pao_accept_task")!;
		const result = await tool.execute(
			"offline-direct",
			{
				target: "读取输入并产生结果",
				dept: "实施",
				acceptance,
				dispatch: true,
				reason: "离线直接任务验收",
				request_key: "direct-task",
			} as never,
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).not.toBe(true);
		await face.waitForBackground();
		const [card] = listCards(cardsDir);
		expect(card.frontmatter.status).toBe(status);
		expect(card.frontmatter.attempt).toBe(1);
		expect(card.receipts).toHaveLength(1);
		expect(card.receipts[0].result).toBe("success");
		expect(readFileSync(join(project, "result.txt"), "utf8")).toBe("离线工人实际产物\n");
		expect(git(project, "rev-parse", "HEAD") !== baseline).toBe(committed);
		if (committed) expect(git(project, "show", "HEAD:result.txt")).toBe("离线工人实际产物");
	},
	60_000,
);
