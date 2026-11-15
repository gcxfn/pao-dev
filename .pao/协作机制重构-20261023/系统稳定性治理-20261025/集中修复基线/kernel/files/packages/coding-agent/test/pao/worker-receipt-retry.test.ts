import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineSnapshotPath, checkBoundaryWrite, diffAgainstBaseline } from "../../src/pao/cards/baseline.ts";
import { changeCardStatus, createCard, readCard } from "../../src/pao/cards/index.ts";
import { appendDispatchReceipt, claimCardForDispatch, executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const roots: string[] = [];
const runners: WorkerRunner[] = [];

afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stopAll();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), `pao-${prefix}-`));
	roots.push(root);
	return root;
}

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function retryFixture() {
	const root = tempRoot("receipt-retry");
	const evidenceDir = join(root, ".pao", "证据");
	const promptPath = join(root, ".pao", "prompt.txt");
	writeFileSync(join(root, "已跟踪.txt"), "v1\n");
	git(root, ["init"]);
	git(root, ["add", "-A"]);
	git(root, ["commit", "--no-gpg-sign", "-qm", "基线"]);
	const cardsDir = join(root, ".pao", "任务", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const card = await createCard(
		cardsDir,
		{
			目标: "重试只报本次写入",
			部门: "测试",
			验收: "完成",
			创建: "2026-10-22 10:00",
			档位: "primary",
		},
		{ counterPath: join(cardsDir, "..", "卡号.txt") },
	);
	const first = await claimCardForDispatch({
		cardsDir,
		card_no: String(card.card_no),
		operator: "主控",
		time: "2026-10-22 10:01",
	});
	expect(first.可派).toBe(true);
	if (!first.可派) expect.unreachable();
	expect(first.claimBaseline?.attempt).toBe(1);
	writeFileSync(join(root, "旧成果.txt"), "上次尝试已经写好的成果\n");
	changeCardStatus(first.card, {
		操作者: "主控",
		to: "failed",
		失败类型: "transient",
		依据: "第一次尝试失败，保留既有成果后重试",
		时间: "2026-10-22 10:02",
	});
	return { root, cardsDir, card, evidenceDir, promptPath };
}

describe("worker 重试回执：本次尝试与整卡累计成果分开", () => {
	it("真实第二次认领使用独立基线，只读旧成果留在证据，候选差异只列本次新写入", async () => {
		const { root, cardsDir, card, evidenceDir, promptPath } = await retryFixture();
		const scriptPath = join(root, "worker-success.cjs");
		writeFileSync(
			scriptPath,
			[
				'const fs = require("node:fs");',
				`const root = ${JSON.stringify(root)};`,
				`fs.writeFileSync(${JSON.stringify(promptPath)}, process.argv.at(-1), "utf8");`,
				'const old = fs.readFileSync(root + "/旧成果.txt", "utf8");',
				'fs.writeFileSync(root + "/本次修改.txt", "第二次尝试实际写入\\n");',
				"const receipt = {",
				'  result: "success",',
				"  artifact_path: [],",
				'  summary: "本次修改已完成；旧成果只读复验通过",',
				'  任务态: "completed",',
				"  verification: [{",
				'    条件: "复验上次成果仍然可读",',
				'    结论: "pass",',
				'    证据: "只读复验 " + root + "/旧成果.txt，内容 " + JSON.stringify(old.trim())',
				"  }],",
				'  changes: [{ 路径: "本次修改.txt", 类型: "created", 说明: "第二次尝试新写入" }]',
				"};",
				'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify(receipt)}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0},stopReason:"end"}}));',
			].join("\n"),
			"utf8",
		);
		const home = join(root, "home");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(
			join(home, "pao配置", "档位.json"),
			JSON.stringify({
				provider: "pao",
				档位: [{ 名: "primary", provider: "offline", model: "offline", thinkingLevel: "off" }],
			}),
		);
		const runner = new WorkerRunner({ 证据目录: evidenceDir });
		runners.push(runner);
		let received: Awaited<ReturnType<WorkerRunner["run"]>> | undefined;
		const result = await executeDispatch(
			{
				cardsDir,
				card_no: String(card.card_no),
				operator: "主控",
				time: "2026-10-22 10:03",
			},
			{
				运行器: runner,
				paoHome: home,
				workflowCheck: () => undefined,
				公共参数: {
					命令: process.execPath,
					参数: [scriptPath],
					证据目录: evidenceDir,
				},
			},
			async (claimed, receipt) => {
				received = receipt;
				await appendDispatchReceipt(claimed.card, receipt);
				return receipt;
			},
		);
		expect(result).toMatchObject({ 可派: true, result: { status: "success", attempt: 2 } });
		expect(received).toBeDefined();
		if (!received) expect.unreachable();

		const attemptTwoBaseline = baselineSnapshotPath(cardsDir, card.card_no, 2);
		expect(existsSync(baselineSnapshotPath(cardsDir, card.card_no, 1))).toBe(true);
		expect(existsSync(attemptTwoBaseline)).toBe(true);
		const prompt = readFileSync(promptPath, "utf8");
		expect(prompt).toContain("尝试 2");
		expect(prompt).toContain(`本次尝试的认领基线：${attemptTwoBaseline}`);
		expect(prompt).toMatch(/认领时已有 \d+ 条改动/);
		expect(prompt).toContain("只声明本次尝试真正发生的写操作");
		expect(prompt).toContain("读取旧文件不要写 changes");
		expect(prompt).toContain("整卡此前尝试留下的成果属于累计背景");

		expect(received.artifact_path).toEqual([]);
		expect(received.changes).toEqual([{ 路径: "本次修改.txt", 类型: "created", 说明: "第二次尝试新写入" }]);
		const candidate = received.verification?.find((item) =>
			item.条件.includes("本次尝试 2 相对认领基线的程序候选改动"),
		);
		expect(candidate).toMatchObject({ 结论: "pass" });
		expect(candidate?.证据).toContain("?? 本次修改.txt");
		expect(candidate?.证据).not.toContain("旧成果.txt");
		const oldReadEvidence = received.verification?.find((item) => item.条件 === "复验上次成果仍然可读");
		expect(oldReadEvidence?.证据).toContain("只读复验");
		expect(oldReadEvidence?.证据).toContain("旧成果.txt");

		const diff = await diffAgainstBaseline(attemptTwoBaseline);
		expect(diff.worker改动).toEqual([{ 状态: "??", 文件: "本次修改.txt" }]);
		const check = checkBoundaryWrite(diff, received.changes?.map((change) => change.路径) ?? []);
		expect(check.结论).toBe("干净");
		expect(check.越界).toEqual([]);
		expect(checkBoundaryWrite(diff, []).越界).toEqual(["?? 本次修改.txt"]);
		expect(checkBoundaryWrite(diff, ["幽灵.txt"]).虚报).toEqual(["幽灵.txt"]);

		const diskReceipt = readCard(join(cardsDir, card.filename)).receipts.at(-1);
		expect(diskReceipt).toMatchObject({ attempt: 2 });
		expect(diskReceipt?.changes).toEqual(received.changes);
		expect(diskReceipt?.verification).toEqual(received.verification);
	}, 30_000);

	it("worker 改写认领基线时，程序候选证据失败，不能靠重写基线绕过核查", async () => {
		const { root, cardsDir, card, evidenceDir } = await retryFixture();
		const scriptPath = join(root, "worker-tamper.cjs");
		writeFileSync(
			scriptPath,
			[
				'const fs = require("node:fs");',
				`const baseline = ${JSON.stringify(baselineSnapshotPath(cardsDir, card.card_no, 2))};`,
				'const body = JSON.parse(fs.readFileSync(baseline, "utf8"));',
				'body.tree = "0".repeat(40);',
				"fs.writeFileSync(baseline, JSON.stringify(body));",
				'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify({result:"failed",failure_type:"unknown_outcome",artifact_path:[],summary:"失败时也试图重写基线",verification:[{条件:"原有复验",结论:"pass",证据:"旧引用"}]})}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0},stopReason:"end"}}));',
				"process.exitCode = 1;",
			].join("\n"),
			"utf8",
		);
		const home = join(root, "home");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(
			join(home, "pao配置", "档位.json"),
			JSON.stringify({
				provider: "pao",
				档位: [{ 名: "primary", provider: "offline", model: "offline", thinkingLevel: "off" }],
			}),
		);
		const runner = new WorkerRunner({ 证据目录: evidenceDir });
		runners.push(runner);
		let received: Awaited<ReturnType<WorkerRunner["run"]>> | undefined;
		await executeDispatch(
			{
				cardsDir,
				card_no: String(card.card_no),
				operator: "主控",
				time: "2026-10-22 10:03",
			},
			{
				运行器: runner,
				paoHome: home,
				workflowCheck: () => undefined,
				公共参数: {
					命令: process.execPath,
					参数: [scriptPath],
					证据目录: evidenceDir,
				},
			},
			async (_claimed, receipt) => {
				received = receipt;
				return receipt;
			},
		);
		expect(received).toBeDefined();
		if (!received) expect.unreachable();
		expect(received).toMatchObject({ status: "failed", attempt: 2 });
		expect(
			received.verification?.find((item) => item.条件.includes("本次尝试 2 相对认领基线的程序候选改动")),
		).toMatchObject({
			结论: "fail",
			证据: expect.stringContaining("认领基线在工人执行期间被修改"),
		});
	}, 30_000);
});
