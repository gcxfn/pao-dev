import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendReceipt,
	createCard,
	type ParsedCard,
	type ReceiptOutcome,
	readCard,
} from "../../src/pao/cards/index.ts";
import { executeFanout, type FanoutCardResult, formatFanoutSummary } from "../../src/pao/fanout/execute.ts";
import type { WorkerReceipt } from "../../src/pao/worker/index.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
const runners: WorkerRunner[] = [];

afterEach(async () => {
	await Promise.all(runners.splice(0).map((runner) => runner.stopAll()));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * 假 worker(不依赖模型端点):向共享日志写 start/end 两行(带时间戳与卡号),
 * 睡 PAO_FANOUT_SLEEP 毫秒后发一条 message_end 事件再退出;发事件后可用挂住脚本模拟长任务。
 */
const TIMED_SCRIPT = `
const fs = require("node:fs");
const log = process.env.PAO_FANOUT_LOG;
const card = process.env.PAO_FANOUT_CARD;
const ms = Number(process.env.PAO_FANOUT_SLEEP || "0");
const hang = process.env.PAO_FANOUT_HANG === "1";
fs.appendFileSync(log, "start " + Date.now() + " " + card + "\\n");
setTimeout(() => {
	if (!hang) fs.appendFileSync(log, "end " + Date.now() + " " + card + "\\n");
	console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({result:"success",artifact_path:[],summary:"done " + card}) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
	if (hang) setInterval(() => {}, 1000);
}, ms);
`;

const FAIL_SCRIPT = `
console.error("boom:测试用假失败");
process.exit(3);
`;

interface LogEntry {
	事件: "start" | "end";
	时间: number;
	卡号: string;
}

function parseLog(file: string): LogEntry[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [event, time, cardNo] = line.split(" ");
			return { 事件: event as LogEntry["事件"], 时间: Number(time), 卡号: cardNo };
		});
}

function maxConcurrent(entries: LogEntry[]): number {
	const events = entries
		.flatMap((e) => [{ 时间: e.时间, 增量: e.事件 === "start" ? 1 : -1 }])
		.sort((a, b) => a.时间 - b.时间 || a.增量 - b.增量);
	let live = 0;
	let max = 0;
	for (const e of events) {
		live += e.增量;
		max = Math.max(max, live);
	}
	return max;
}

async function makeCards(cardsDir: string, count: number): Promise<void> {
	mkdirSync(cardsDir, { recursive: true });
	// 计数器显式放本任务临时目录:缺省会落到 Temp 根,跨测试共用会串号
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

describe("扇出执行(假 worker 进程,不依赖模型端点)", () => {
	it("同一执行目录保留长锁串行，批次名额不使同目录重叠；每卡恰好启动一次", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 6);
		const runner = new WorkerRunner();
		runners.push(runner);
		const log = join(dir, "进程日志.txt");
		const script = join(dir, "fake-timed.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");

		const summary = await executeFanout(
			{ 卡号列表: ["1", "2", "3", "4", "5", "6"], 并发上限: 2, cardsDir },
			{
				运行器: runner,
				公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
				每卡参数: (card) => ({
					参数: [script],
					环境变量: {
						PAO_FANOUT_LOG: log,
						PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"),
						// 各卡耗时不同，确认目录长锁不会因批次并发名额而放开。
						PAO_FANOUT_SLEEP: card.card_no === 1 ? "150" : card.card_no === 2 ? "900" : "300",
					},
				}),
			},
		);

		expect(summary.count.成功).toBe(6);
		expect(summary.全部完成).toBe(true);
		const entries = parseLog(log);
		// 无遗漏无重复:每卡恰好启动一次
		expect(
			entries
				.filter((e) => e.事件 === "start")
				.map((e) => e.卡号)
				.sort(),
		).toEqual(["0001", "0002", "0003", "0004", "0005", "0006"]);
		// 同一 primary 根必须互斥；独立 managed 根真实重叠另由
		// worker-dispatch-managed-real.test.ts 通过受保护入口验证。
		expect(maxConcurrent(entries)).toBe(1);
		expect(entries.filter((entry) => entry.事件 === "end")).toHaveLength(6);
	}, 30_000);

	it("回执逐卡落卡(卡号+尝试号,不混批),失败带缺省分型与路由建议", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 3);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-ok.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");
		const failScript = join(dir, "fake-fail.js");
		writeFileSync(failScript, FAIL_SCRIPT, "utf8");

		const summary = await executeFanout(
			{ 卡号列表: ["卡#1", "卡0002", "3"], 并发上限: 3, cardsDir },
			{
				运行器: runner,
				公共参数: { 工具白名单: ["read"], 命令: process.execPath, 证据目录: join(dir, "证据") },
				每卡参数: (card) => ({
					参数: [card.card_no === 3 ? failScript : script],
					环境变量: {
						PAO_FANOUT_LOG: join(dir, "进程日志.txt"),
						PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"),
					},
				}),
			},
		);

		expect(summary.count).toEqual({ 成功: 2, 失败: 1, 结果未知: 0, 取消: 0, 未拉起: 0 });
		// 逐卡落卡:每张卡各一条自己的回执
		for (const cardNo of [1, 2, 3]) {
			const card = readCard(join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-任务${cardNo}.md`));
			expect(card.frontmatter.status).toBe("in_progress"); // worker 交回执只是待审,不推终态
			expect(card.frontmatter.attempt).toBe(1); // 认领即真实启动,尝试 +1
			expect(card.receipts.length).toBe(1);
			expect(card.receipts[0].card_no).toBe(cardNo);
			expect(card.receipts[0].attempt).toBe(1);
			expect(card.receipts[0].evidence?.[0]).toBeTruthy();
			expect(existsSync(card.receipts[0].evidence?.[0] ?? "")).toBe(true);
		}
		// 失败卡:缺省分型瞬时故障,路由建议与 cards 的 routeFailure 同口径
		const failed = resultOf(summary, "0003");
		expect(failed.终态).toBe("失败");
		expect(failed.失败类型).toBe("transient");
		expect(failed.路由建议?.建议动作).toBe("重试");
		expect(failed.回执落卡).toBe("已记录");
		const failCardText = readFileSync(join(cardsDir, "卡0003-任务3.md"), "utf8");
		expect(failCardText).toContain("failure_type: transient");
		// 聚合摘要文本:总数、终态、路由建议都在
		const text = formatFanoutSummary(summary);
		expect(text).toContain("扇出完成:3 张卡(并发上限 3)");
		expect(text).toContain("成功 2,失败 1");
		expect(text).toContain("路由建议:transient → 重试");
	}, 30_000);

	it("卡状态把关:进行中/已终态不重复拉起,缺卡与坏引用记未拉起不炸整批", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 2);
		// 把卡2 手工推到已交付
		const { changeCardStatus } = await import("../../src/pao/cards/index.ts");
		changeCardStatus(readCard(join(cardsDir, "卡0002-任务2.md")), {
			操作者: "用户",
			to: "canceled",
			时间: "2026-10-02 10:01",
		});
		const runner = new WorkerRunner();
		runners.push(runner);
		const summary = await executeFanout(
			{ 卡号列表: ["1", "2", "99"], 并发上限: 2, cardsDir },
			{ 运行器: runner, 公共参数: { 工具白名单: ["read"], 命令: process.execPath, 参数: [join(dir, "不存在.js")] } },
		);
		expect(resultOf(summary, "0002").终态).toBe("未拉起");
		expect(resultOf(summary, "0002").未拉起原因).toContain("已终态");
		expect(resultOf(summary, "0099").终态).toBe("未拉起");
		expect(resultOf(summary, "0099").未拉起原因).toContain("找不到卡0099");
		// 卡1 不受影响,照常认领拉起(spawn 失败也如实记)
		expect(resultOf(summary, "0001").终态).not.toBe("未拉起");
		expect(readCard(join(cardsDir, "卡0001-任务1.md")).frontmatter.attempt).toBe(1);
	}, 30_000);
});

describe("扇出停止(复用 runner 的 cancel/stopAll,零自建进程管理)", () => {
	const HANG_ENV = { PAO_FANOUT_HANG: "1", PAO_FANOUT_SLEEP: "0" };

	function waitUntil(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const tick = (): void => {
				if (fn()) resolve();
				else if (Date.now() - start > timeoutMs) reject(new Error("等待超时"));
				else setTimeout(tick, 50);
			};
			tick();
		});
	}

	it("单卡 cancel:在跑进程树杀确认,该卡终态取消,其余照常完成;取消后同卡拒绝再派", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 3);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-hang.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");
		const env = (card: { card_no: number }): Record<string, string> => ({
			PAO_FANOUT_LOG: join(dir, "进程日志.txt"),
			PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"),
			// 只让卡2 挂住,其余快速正常退出
			...(card.card_no === 2 ? HANG_ENV : { PAO_FANOUT_SLEEP: "100" }),
		});
		const summaryPromise = executeFanout(
			{ 卡号列表: ["1", "2", "3"], 并发上限: 3, cardsDir },
			{
				运行器: runner,
				公共参数: { 工具白名单: ["read"], 命令: process.execPath, 参数: [script], 证据目录: join(dir, "证据") },
				每卡参数: (card) => ({ 环境变量: env(card) }),
			},
		);
		// 同目录串行：等目标卡真正启动，不能等被它挡在锁外的第三张卡。
		await waitUntil(
			() =>
				runner.isRunning("0002") &&
				parseLog(join(dir, "进程日志.txt")).some((entry) => entry.事件 === "start" && entry.卡号 === "0002"),
		);
		const proof = await runner.cancel("0002");
		const summary = await summaryPromise;

		expect(proof.stoppedProcesses.length).toBe(1);
		expect(proof.stoppedProcesses[0].卡号).toBe("0002");
		expect(resultOf(summary, "0002").终态).toBe("取消");
		expect(resultOf(summary, "0001").终态).toBe("成功");
		expect(resultOf(summary, "0003").终态).toBe("成功");
		// 取消契约第一步:被取消的卡本轮拒绝再派
		await expect(
			runner.run({ 卡号: "0002", 提示词: "再派", 命令: process.execPath, 参数: [script] }),
		).rejects.toThrow(/取消/);
		// 全部进程已退出
		for (const entry of runner.registry.list()) expect(entry.running).toBe(false);
	}, 30_000);

	it("批次信号中止:先阻新卡(排队卡不再拉起)再树杀在跑进程,全部终态取消", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 4);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-hang.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");
		const log = join(dir, "进程日志.txt");
		const controller = new AbortController();
		const summaryPromise = executeFanout(
			{ 卡号列表: ["1", "2", "3", "4"], 并发上限: 2, cardsDir },
			{
				运行器: runner,
				公共参数: { 工具白名单: ["read"], 命令: process.execPath, 参数: [script], 证据目录: join(dir, "证据") },
				// 每卡参数与公共参数浅合并:环境变量整组覆盖,需自带日志路径
				每卡参数: (card) => ({
					环境变量: { PAO_FANOUT_LOG: log, PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"), ...HANG_ENV },
				}),
				信号: controller.signal,
			},
		);
		await waitUntil(
			() => runner.registry.list().length === 1 && parseLog(log).some((entry) => entry.事件 === "start"),
		);
		controller.abort();
		const summary = await summaryPromise;

		expect(summary.已停止).toBe(true);
		expect(summary.count.取消).toBe(4);
		// 同目录长锁只允许一张真正启动；第二车道正在等锁，另外两张仍未取出。
		const entries = parseLog(log);
		expect(entries.filter((e) => e.事件 === "start").length).toBe(1);
		expect(resultOf(summary, "0003").未拉起原因).toContain("排队");
		expect(resultOf(summary, "0004").未拉起原因).toContain("排队");
		// 在跑进程真停了:没有任何 end 记录(挂住脚本被树杀),登记册全部退出
		expect(entries.filter((e) => e.事件 === "end").length).toBe(0);
		for (const entry of runner.registry.list()) expect(entry.running).toBe(false);
	}, 30_000);

	it("外部 stopAll(主会话退出路径):排队卡不再拉起,在跑进程全停,批次照常收口", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 3);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-hang.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");
		const log = join(dir, "进程日志.txt");
		const summaryPromise = executeFanout(
			{ 卡号列表: ["1", "2", "3"], 并发上限: 1, cardsDir },
			{
				运行器: runner,
				公共参数: { 工具白名单: ["read"], 命令: process.execPath, 参数: [script], 证据目录: join(dir, "证据") },
				每卡参数: (card) => ({
					环境变量: { PAO_FANOUT_LOG: log, PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"), ...HANG_ENV },
				}),
			},
		);
		await waitUntil(
			() => runner.registry.list().length === 1 && parseLog(log).some((entry) => entry.事件 === "start"),
		);
		await runner.stopAll();
		const summary = await summaryPromise;

		expect(summary.count.取消).toBe(3);
		// 上限 1:stopAll 后排队卡不再产生新进程
		expect(parseLog(log).filter((e) => e.事件 === "start").length).toBe(1);
		expect(resultOf(summary, "0002").未拉起原因).toContain("排队");
		expect(resultOf(summary, "0003").未拉起原因).toContain("排队");
		for (const entry of runner.registry.list()) expect(entry.running).toBe(false);
	}, 30_000);

	it("批次中止收尾:被认领卡(在跑+排队)磁盘上落「取消」终态且不双写", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 4);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-hang.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");
		const log = join(dir, "进程日志.txt");
		const controller = new AbortController();
		const summaryPromise = executeFanout(
			{ 卡号列表: ["1", "2", "3", "4"], 并发上限: 2, cardsDir },
			{
				运行器: runner,
				公共参数: { 工具白名单: ["read"], 命令: process.execPath, 参数: [script], 证据目录: join(dir, "证据") },
				每卡参数: (card) => ({
					环境变量: { PAO_FANOUT_LOG: log, PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"), ...HANG_ENV },
				}),
				信号: controller.signal,
			},
		);
		await waitUntil(
			() => runner.registry.list().length === 1 && parseLog(log).some((entry) => entry.事件 === "start"),
		);
		controller.abort();
		const summary = await summaryPromise;

		expect(summary.已停止).toBe(true);
		expect(summary.count.取消).toBe(4);
		const startedCards = new Set(
			parseLog(log)
				.filter((entry) => entry.事件 === "start")
				.map((entry) => Number(entry.卡号)),
		);
		expect(startedCards.size).toBe(1);
		// 只认真实取得锁的卡，不假设异步准备的两个车道谁先到；等锁卡不制造尝试。
		for (const cardNo of [1, 2, 3, 4]) {
			const card = readCard(join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-任务${cardNo}.md`));
			expect(card.frontmatter.status).toBe("canceled");
			expect(card.frontmatter.attempt).toBe(startedCards.has(cardNo) ? 1 : 0);
			// 两段 owner 记录:认领(进行中)+ 收尾(取消);取消收尾恰好一次,不重复写
			expect(card.body.split("## owner记录").length - 1).toBe(startedCards.has(cardNo) ? 2 : 1);
			expect(card.body.split("状态改为 canceled").length - 1).toBe(1);
			expect(card.body).toContain("扇出被中途停止");
		}
		// 不双写:在跑被杀的卡只有 runner 落的一条「结果:取消」回执(runner 对取消是 resolve 非 catch);
		// 排队卡从未拉起,一条回执都没有
		for (const cardNo of startedCards) {
			const card = readCard(join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-任务${cardNo}.md`));
			expect(card.receipts.length).toBe(1);
			expect(card.receipts[0].result).toBe("canceled");
		}
		for (const cardNo of [1, 2, 3, 4].filter((cardNo) => !startedCards.has(cardNo))) {
			const card = readCard(join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-任务${cardNo}.md`));
			expect(card.receipts.length).toBe(0);
		}
	}, 30_000);

	it("中止边界刚好成功的卡不被误杀:回执已落,保持进行中待审", async () => {
		const dir = tempDir("pao-fanout-run-");
		const cardsDir = join(dir, "卡");
		await makeCards(cardsDir, 2);
		const runner = new WorkerRunner();
		runners.push(runner);
		const script = join(dir, "fake-hang.js");
		writeFileSync(script, TIMED_SCRIPT, "utf8");
		const log = join(dir, "进程日志.txt");
		const controller = new AbortController();
		// 交回执注入:与缺省同口径落卡(重读卡 + appendReceipt),行为等价,便于观察落卡时机
		const returnReceipt = (card: ParsedCard, receipt: WorkerReceipt): ReceiptOutcome =>
			appendReceipt(readCard(card.path), {
				尝试号: card.frontmatter.attempt,
				时间: "2026-10-02 10:05",
				结果: receipt.status,
				摘要: receipt.summary,
			});
		const summaryPromise = executeFanout(
			{ 卡号列表: ["1", "2"], 并发上限: 1, cardsDir },
			{
				运行器: runner,
				公共参数: { 工具白名单: ["read"], 命令: process.execPath, 参数: [script], 证据目录: join(dir, "证据") },
				交回执: returnReceipt,
				每卡参数: (card) => ({
					环境变量: {
						PAO_FANOUT_LOG: log,
						PAO_FANOUT_CARD: String(card.card_no).padStart(4, "0"),
						// 卡1 快速正常结束,卡2 挂住
						...(card.card_no === 1 ? { PAO_FANOUT_SLEEP: "120" } : HANG_ENV),
					},
				}),
				信号: controller.signal,
			},
		);
		// 等卡1 的回执真正落上卡(轮询读卡,落卡时机确定的才中止)
		await waitUntil(() => readCard(join(cardsDir, "卡0001-任务1.md")).receipts.length > 0);
		// 等另一张真正进入执行后中止，同时保留第一张已经落盘的成功。
		await waitUntil(
			() =>
				runner.isRunning("0002") && parseLog(log).some((entry) => entry.事件 === "start" && entry.卡号 === "0002"),
		);
		controller.abort();
		const summary = await summaryPromise;

		expect(summary.已停止).toBe(true);
		const card1 = readCard(join(cardsDir, "卡0001-任务1.md"));
		expect(card1.frontmatter.status).toBe("in_progress"); // 回执已落:待审语义不变
		expect(card1.receipts.length).toBe(1);
		expect(card1.body).not.toContain("状态改为 取消");
		const card2 = readCard(join(cardsDir, "卡0002-任务2.md"));
		expect(card2.frontmatter.status).toBe("canceled");
		expect(summary.count).toEqual({ 成功: 1, 失败: 0, 结果未知: 0, 取消: 1, 未拉起: 0 });
	}, 30_000);
});
