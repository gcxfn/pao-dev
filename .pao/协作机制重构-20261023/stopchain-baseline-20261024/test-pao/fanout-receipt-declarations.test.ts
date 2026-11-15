import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCard } from "../../src/pao/cards/cardfile.ts";
import { executeFanout, type FanoutCardResult } from "../../src/pao/fanout/execute.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const roots: string[] = [];
const runners: WorkerRunner[] = [];

afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pao-fanout-declarations-"));
	roots.push(root);
	return root;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

async function runScenario(receipt: Record<string, unknown>): Promise<FanoutCardResult> {
	const root = tempRoot();
	writeFileSync(join(root, "已跟踪.txt"), "v1\n");
	git(root, ["init"]);
	git(root, ["add", "-A"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "基线"]);
	const cardsDir = join(root, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	await createCard(
		cardsDir,
		{ 目标: "扇出声明", 部门: "测试", 验收: "完成", 创建: "2026-10-23 03:00" },
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
	const script = join(root, ".pao", "worker.cjs");
	writeFileSync(
		script,
		[
			'const fs = require("node:fs");',
			'fs.writeFileSync("源码.txt", "worker 写入\\n");',
			`const receipt = ${JSON.stringify(receipt)};`,
			'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(receipt)}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0},stopReason:"end"}}));',
		].join("\n"),
	);
	const runner = new WorkerRunner();
	runners.push(runner);
	const summary = await executeFanout(
		{ 卡号列表: ["1"], 并发上限: 1, cardsDir },
		{
			运行器: runner,
			公共参数: {
				命令: process.execPath,
				参数: [script],
				cwd: root,
				证据目录: join(root, ".pao", "证据"),
			},
		},
	);
	const result = summary.结果[0];
	if (!result) throw new Error("扇出结果缺失");
	return result;
}

describe("扇出边界核查的声明选择", () => {
	it("changes 显式为空时优先于 artifact_path，不把 artifact_path 当本次改动", async () => {
		const result = await runScenario({
			result: "success",
			artifact_path: ["源码.txt"],
			summary: "只读复验，没有本次改动",
			changes: [],
		});
		expect(result.越界核查).toMatchObject({
			结论: "越界",
			越界: ["?? 源码.txt"],
		});
	});

	it("changes 非空时按 changes 核查，忽略不一致的 artifact_path", async () => {
		const result = await runScenario({
			result: "success",
			artifact_path: [],
			summary: "本次改动已声明",
			changes: [{ 路径: "源码.txt", 类型: "created", 说明: "源码写入" }],
		});
		expect(result.越界核查).toMatchObject({
			结论: "干净",
			相符: ["?? 源码.txt"],
		});
	});

	it("changes 缺省时回落到 artifact_path", async () => {
		const result = await runScenario({
			result: "success",
			artifact_path: ["源码.txt"],
			summary: "旧式回执",
		});
		expect(result.越界核查).toMatchObject({
			结论: "干净",
			相符: ["?? 源码.txt"],
		});
	});
});
