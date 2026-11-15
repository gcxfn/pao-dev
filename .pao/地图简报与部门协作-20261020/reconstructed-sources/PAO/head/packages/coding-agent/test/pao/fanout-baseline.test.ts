import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { changeCardStatus, createCard, readCard } from "../../src/pao/cards/index.ts";
import {
	executeFanout,
	type FanoutCardResult,
	type FanoutSummary,
	formatFanoutSummary,
} from "../../src/pao/fanout/execute.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

/**
 * R14 扇出接线 + §14 越界核查（架构 §14，摩擦日志 2026-10-02「扇出认领未落R14快照」）：
 * 扇出认领与工具层 pao_change_status 走同一快照入口 snapshotClaimBaseline，交回执时以
 * git 真值（当前 status 减认领基线）比对回执声明产物——虚报/越界结构化亮出。
 * 真实 git 仓库 fixture（makeRepo 参照 baseline-snap.test.ts）+ 假 worker 进程（不依赖模型端点），
 * worker 脚本在工作区真实写文件，回执产物清单经 WorkerRunOptions.产物路径 声明。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-fanout-base-"): string {
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

/** git 仓库:提交基线后制造「用户既有改动」(1 修改 + 1 未跟踪),认领快照应把它们记为既有 */
function makeRepo(prefix = "pao-fanout-base-"): string {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	writeFileSync(join(repo, "已跟踪.txt"), "v2-用户改的\n");
	writeFileSync(join(repo, "用户便签.txt"), "用户自己的\n");
	return repo;
}

/** 假 worker:按环境变量在工作区(cwd)真实写文件,再发 message_end 正常退出 */
const WRITE_SCRIPT = `
const fs = require("node:fs");
const 声明 = (process.env.PAO_FANOUT_DECLARE || "").split("|").filter(Boolean);
const 私货 = (process.env.PAO_FANOUT_EXTRA || "").split("|").filter(Boolean);
for (const f of [...声明, ...私货]) fs.writeFileSync(f, "worker 写入\\n");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({result:"success",artifact_path:JSON.parse(process.env.PAO_FANOUT_RECEIPT || "[]"),summary:"done"}) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
`;

async function makeCards(cardsDir: string, count: number): Promise<void> {
	mkdirSync(cardsDir, { recursive: true });
	// 计数器收在 .pao 内(差分检测面已排除),不落共享上级
	const counterPath = join(cardsDir, "..", "卡号.txt");
	for (let i = 1; i <= count; i++) {
		await createCard(
			cardsDir,
			{ 目标: `任务${i}`, 部门: "测试", 验收: "完成", 创建: "2026-10-02 10:00" },
			{ counterPath },
		);
	}
}

function resultOf(summary: { 结果: FanoutCardResult[] }, cardNo: string): FanoutCardResult {
	const found = summary.结果.find((r) => r.卡号 === cardNo);
	if (!found) throw new Error(`摘要里没有卡${cardNo}`);
	return found;
}

interface Scenario {
	声明环境变量: string;
	私货环境变量: string;
	/** 回执声明的产物清单(经 WorkerRunOptions.产物路径 进回执) */
	产物路径: string[];
}

async function runOne(scenario: Scenario, repo?: string): Promise<FanoutSummary> {
	const root = repo ?? makeRepo();
	const orchestrationArea = join(root, ".pao");
	const cardsDir = join(orchestrationArea, "卡");
	await makeCards(cardsDir, 1);
	const script = join(orchestrationArea, "fake-worker.js");
	writeFileSync(script, WRITE_SCRIPT, "utf8");
	return executeFanout(
		{ 卡号列表: ["1"], 并发上限: 1, cardsDir },
		{
			运行器: new WorkerRunner(),
			公共参数: {
				命令: process.execPath,
				参数: [script],
				cwd: root,
				证据目录: join(orchestrationArea, "证据"),
				产物路径: scenario.产物路径,
			},
			每卡参数: () => ({
				环境变量: {
					PAO_FANOUT_DECLARE: scenario.声明环境变量,
					PAO_FANOUT_EXTRA: scenario.私货环境变量,
					PAO_FANOUT_RECEIPT: JSON.stringify(scenario.产物路径),
				},
			}),
		},
	);
}

describe("扇出认领落 R14 基线快照(与 pao_change_status 同一入口)", () => {
	it("认领快照落盘:既有改动计数如实,摘要文本标注基线位置", async () => {
		const summary = await runOne({ 声明环境变量: "产物.txt", 私货环境变量: "", 产物路径: ["产物.txt"] });
		const r = resultOf(summary, "0001");
		expect(r.终态).toBe("成功");
		expect(r.认领基线?.可用).toBe(true);
		expect(r.认领基线?.既有条目数).toBe(2); // 用户既有:1 修改 + 1 未跟踪
		expect(existsSync(r.认领基线?.快照路径 ?? "")).toBe(true);
		expect(r.认领基线?.快照路径).toContain(join(".pao", "基线"));
		const text = formatFanoutSummary(summary);
		expect(text).toContain("认领基线:快照已落");
		expect(text).toContain("既有 2 条不计 worker 的账");
	}, 30_000);

	it("失败→重派同样是新尝试的认领:重落快照,交回执比对有依据", async () => {
		const root = makeRepo();
		const orchestrationArea = join(root, ".pao");
		const cardsDir = join(orchestrationArea, "卡");
		await makeCards(cardsDir, 1);
		// 上一轮:认领后失败
		const card = readCard(join(cardsDir, "卡0001-任务1.md"));
		changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-02 10:01" });
		changeCardStatus(readCard(card.path), {
			操作者: "主控",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-02 10:02",
		});
		const summary = await runOne({ 声明环境变量: "产物.txt", 私货环境变量: "", 产物路径: ["产物.txt"] }, root);
		const r = resultOf(summary, "0001");
		expect(r.认领基线?.可用).toBe(true);
		expect(existsSync(r.认领基线?.快照路径 ?? "")).toBe(true);
		expect(r.attempt).toBe(2); // 重派递增尝试
	}, 30_000);

	it("非 git 工作区:认领基线如实不可用不阻断执行,摘要标注边界", async () => {
		const root = tempDir(); // 无 git
		const summary = await runOne({ 声明环境变量: "产物.txt", 私货环境变量: "", 产物路径: ["产物.txt"] }, root);
		const r = resultOf(summary, "0001");
		expect(r.终态).toBe("成功"); // 快照不可用不阻断认领执行
		expect(r.认领基线?.可用).toBe(false);
		expect(r.认领基线?.原因).toBeTruthy();
		expect(r.越界核查).toBeUndefined(); // 无基线不硬比
		const text = formatFanoutSummary(summary);
		expect(text).toContain("认领基线:不可用");
		expect(text).toContain("越界比对无基线,边界如实标注");
	}, 30_000);
});

describe("§14 越界核查:git 真值比对回执声明,虚报/越界结构化亮出", () => {
	it("worker 越界写未声明文件:亮出越界,声明内产物相符,用户既有改动不入账", async () => {
		const summary = await runOne({
			声明环境变量: "产物.txt",
			私货环境变量: "私货.txt",
			产物路径: ["产物.txt"],
		});
		const r = resultOf(summary, "0001");
		expect(r.越界核查?.结论).toBe("越界");
		expect(r.越界核查?.越界.join("、")).toContain("私货.txt");
		expect(r.越界核查?.相符.join("、")).toContain("产物.txt");
		// 用户派卡前自己的脏文件不冒领为 worker 产物
		expect(r.越界核查?.越界.join("、")).not.toContain("已跟踪.txt");
		expect(r.越界核查?.越界.join("、")).not.toContain("用户便签.txt");
		const text = formatFanoutSummary(summary);
		expect(text).toContain("越界核查:越界 1 处(写未声明):?? 私货.txt");
	}, 30_000);

	it("worker 只写声明内产物:核查干净", async () => {
		const summary = await runOne({ 声明环境变量: "产物.txt", 私货环境变量: "", 产物路径: ["产物.txt"] });
		const r = resultOf(summary, "0001");
		expect(r.越界核查?.结论).toBe("干净");
		expect(r.越界核查?.相符.length).toBe(1);
		expect(r.越界核查?.越界).toEqual([]);
		expect(formatFanoutSummary(summary)).toContain("越界核查:比对干净:1 项声明与 git 真值相符");
	}, 30_000);

	it("worker 虚报声明未写产物:亮出虚报,不算相符", async () => {
		const summary = await runOne({
			声明环境变量: "",
			私货环境变量: "",
			产物路径: ["产物.txt", "幽灵.txt"],
		});
		const r = resultOf(summary, "0001");
		expect(r.越界核查?.结论).toBe("虚报");
		expect(r.越界核查?.虚报.sort()).toEqual(["产物.txt", "幽灵.txt"]);
		expect(r.越界核查?.越界).toEqual([]);
	}, 30_000);
});
