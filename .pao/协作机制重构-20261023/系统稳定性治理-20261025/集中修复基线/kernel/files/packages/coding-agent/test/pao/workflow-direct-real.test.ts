/** 真实 Git/Node 进程验证直接跨部门推进；模型输出为固定离线夹具，不调用供应商。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listCards } from "../../src/pao/cards/index.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { runAutoChain } from "../../src/pao/workflow/auto.ts";
import {
	bindMinister,
	decideNode,
	endDecomposition,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { emitRecipeMarkdown } from "../../src/pao/workflow/distill.ts";
import { WorkflowHostBridge } from "../../src/pao/workflow/host-bridge.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
	vi.stubEnv("PAO_ROLE", "主控");
	vi.stubEnv("PAO_DEPT", "");
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllEnvs();
});
function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-c", "user.name=offline", "-c", "user.email=offline@example.invalid", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

it.each(["交付", "人工门", "机械失败", "返修"])(
	"直接跨部链：%s，正常交接不打开部长",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "pao-direct-flow-"));
		const project = join(root, "project"),
			paoHome = join(root, "home"),
			cardsDir = join(project, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		mkdirSync(join(paoHome, "pao配置"), { recursive: true });
		await createDept({ paoHome, 名字: "实施" });
		await createDept({ paoHome, 名字: "整理" });
		writeFileSync(
			join(paoHome, "pao配置", "档位.json"),
			JSON.stringify({
				provider: "pao",
				档位: [{ 名: "primary", provider: "offline", model: "offline", thinkingLevel: "off" }],
			}),
		);
		writeFileSync(join(project, "input.txt"), "original\n");
		git(project, "init", "--quiet");
		git(project, "add", "input.txt");
		git(project, "commit", "--no-gpg-sign", "-qm", "baseline");
		const script = join(root, "worker.cjs");
		writeFileSync(
			script,
			`const fs = require("node:fs");
const repair = ${JSON.stringify(mode === "返修")};
const second = fs.existsSync("first.txt");
const name = second && !repair ? "second.txt" : "first.txt";
if (second && fs.readFileSync("first.txt", "utf8") !== "first") throw Error("上游成果不符");
fs.writeFileSync(name, second ? "second" : "first");
const receipt = {result:"success",任务态:"completed",summary:"固定离线回执",artifact_path:[name],changes:[{类型:second && repair ? "modified" : "created",路径:name,说明:"实际工人写入"}]};
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(receipt)}],stopReason:"end"}}));`,
		);
		class OfflineRunner extends WorkerRunner {
			override run(options: WorkerRunOptions) {
				return super.run({ ...options, 命令: process.execPath, 参数: [script] });
			}
		}
		const runner = new OfflineRunner({ 证据目录: join(root, "evidence") });
		const host = new MinisterHost();
		const spawn = vi.spyOn(host, "spawn");
		const bridge = new WorkflowHostBridge(host);
		cleanups.push(async () => {
			await bridge.shutdown();
			await runner.stopAll();
			rmSync(root, { recursive: true, force: true });
		});
		const recipe = parseRecipe(
			`---
版本: 2
名字: 直接跨部
自动执行: true
参数: []
节点:
${
	mode === "返修"
		? `  - 名字: 审查
    部门: 整理
    目标: 核查 first.txt
    验收: 内容正确
    执行方式: 拆解
    只读: true
    审核: true
    部门标准: 核查实际文件
    depends_on: [上游]
    回边: [{目标: 上游, 上限: 3, 超限动作: 停滞}]
`
		: `  - 名字: 下游
    部门: 整理
    目标: 读取 first.txt 并写 second.txt
    验收: '存在: second.txt'
    执行方式: 直接
    depends_on: [上游]
`
}
  - 名字: 上游
    部门: 实施
    目标: 写 first.txt
    验收: '存在: ${mode === "机械失败" ? "missing.txt" : "first.txt"}'
    执行方式: 直接
    人工确认: ${mode === "人工门"}
---`,
			join(root, "直接跨部.md"),
		);
		expect(
			parseRecipe(emitRecipeMarkdown({ ...recipe }), recipe.文件路径).节点.find((node) => node.名字 === "上游")!
				.执行方式,
		).toBe("直接");
		const options = { cardsDir, paoHome, ownerSessionId: "owner", 运行器: runner };
		await startControl(recipe, {}, options);
		if (mode === "返修") {
			// 审核判断为显式离线夹具；两次实际写入、认领、回执和交卷均走生产链。
			await runAutoChain(recipe, options);
			const original = listCards(cardsDir)[0];
			expect(original.frontmatter.status).toBe("delivered");
			await bindMinister(recipe, options, "审查", "offline-review");
			let flow = readControl(recipe, options);
			const identity = { 实例: flow.实例, 节点: "审查", 轮次: 1, 部长会话: "offline-review" };
			await endDecomposition(recipe, options, identity, "离线读取实际成果，不派工人");
			await decideNode(recipe, options, identity, {
				结果: "change",
				理由: "范围内修改为 second",
				失败轴: "card",
				目标: "上游",
				引用: ["first.txt:1"],
			});
			expect(listCards(cardsDir)[0].frontmatter.attempt).toBe(1);
			await runAutoChain(recipe, options);
			const repaired = listCards(cardsDir);
			expect(repaired).toHaveLength(1);
			expect(repaired[0].path).toBe(original.path);
			expect(repaired[0].frontmatter.attempt).toBe(2);
			expect(repaired[0].frontmatter.status).toBe("delivered");
			expect(repaired[0].receipts.map((receipt) => receipt.attempt)).toEqual([1, 2]);
			expect(git(project, "show", "HEAD:first.txt")).toBe("second");
			flow = readControl(recipe, options);
			expect(flow.节点.find((node) => node.名字 === "上游")!.历史).toHaveLength(1);
			expect(spawn).not.toHaveBeenCalled();
			return;
		}
		const result = await bridge.drive(recipe, options);
		expect(spawn).not.toHaveBeenCalled();
		const cards = listCards(cardsDir);
		expect(cards).toHaveLength(mode === "交付" ? 2 : 1);
		expect(cards.every((card) => card.frontmatter.attempt === 1 && card.receipts.length === 1)).toBe(true);
		expect(readFileSync(join(project, "first.txt"), "utf8")).toBe("first");
		const flow = readControl(recipe, options);
		expect(flow.节点.every((node) => node.部长会话 === undefined)).toBe(true);
		if (mode === "交付") {
			expect(result.report.status).toBe("completed");
			expect(cards.every((card) => card.frontmatter.status === "delivered")).toBe(true);
			expect(git(project, "show", "HEAD:second.txt")).toBe("second");
			const repeat = await bridge.drive(recipe, options);
			expect(repeat.report.status).toBe("completed");
			expect(listCards(cardsDir)).toHaveLength(2);
		} else {
			expect(result.report.status).not.toBe("completed");
			expect(cards[0].frontmatter.status).toBe(mode === "人工门" ? "delivered" : "failed");
			expect(flow.节点.find((node) => node.名字 === "下游")!.卡).toHaveLength(0);
		}
	},
	120_000,
);

it("旧配方不被直接默认改写，非法直接审核不能消失", () => {
	const old = `---\n版本: 2\n名字: 旧配方\n节点:\n  - 名字: 旧节点\n    部门: 实施\n    目标: 目标\n    验收: 验收\n`;
	expect(parseRecipe(`${old}---`, "旧配方.md").节点[0].执行方式).toBeUndefined();
	expect(() =>
		parseRecipe(`${old}    执行方式: 直接\n    只读: true\n    审核: true\n    部门标准: 标准\n---`, "旧配方.md"),
	).toThrow("独立审核");
});
