import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, SessionShutdownEvent } from "../../src/core/extensions/types.ts";
import { changeCardStatus, readCard } from "../../src/pao/cards/index.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import { prepareDispatchBrief } from "../../src/pao/dispatch-brief/index.ts";
import { acceptIntake } from "../../src/pao/intake/index.ts";
import * as atomic from "../../src/pao/shared/atomic.ts";
import { buildAutoIntakeKey, formatIntakeOutcome, registerWorkerTools } from "../../src/pao/worker/index.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

/**
 * pao_accept_task（完整任务受理窄工具，计划 §5.2）。
 *
 * 测的是「工具面」：参数映射 + 返回文案 + 与旧入口的关系。
 * 受理业务本身（预检/建卡/幂等账）归 intake/ 的测试，这里不重复验它的内部实现——
 * 只验工具确实把请求交给了唯一入口、并把真实结果如实说出来。
 *
 * 子进程一律不真实拉起：FakeRunner 覆写 run()，只登记进注册表并返回假回执。
 */

const tempDirs: string[] = [];
const shutdowns: ((event: SessionShutdownEvent) => unknown)[] = [];
const envKeys = ["PAO_ROLE", "PAO_DEPT", "PAO_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of envKeys) savedEnv[key] = process.env[key];
	// 派单权限按角色判定：工具面测试固定为主控（非部长），不受开发机环境影响
	process.env.PAO_ROLE = "主控";
	delete process.env.PAO_DEPT;
});

afterEach(async () => {
	const cleanups: (() => void | Promise<void>)[] = [];
	for (const shutdown of shutdowns.splice(0))
		await shutdown({
			type: "session_shutdown",
			reason: "quit",
			onConfirmedShutdown: (cleanup) => cleanups.push(cleanup),
		});
	for (const cleanup of cleanups) await cleanup();
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function fakeReceipt(cardNo: string): WorkerReceipt {
	return {
		card_no: cardNo,
		attempt: 1,
		status: "success",
		artifact_path: [],
		summary: "假回执:做完了",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: join(tempDir("证据"), `卡${cardNo}.jsonl`),
		exitCode: 0,
		command: "fake-runner",
		pid: -1,
		duration_ms: 1,
	};
}

/** 假运行器:不 spawn,登记进真实注册表后返回假回执（与 worker-dispatch.test.ts 同款） */
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];

	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		this.registry.register({
			pid: 900000 + this.runs.length,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		this.registry.markExited(900000 + this.runs.length);
		return fakeReceipt(options.卡号);
	}
}

interface Captured {
	tools: {
		name: string;
		label?: string;
		description?: string;
		execute: (...args: unknown[]) => Promise<{ content: { text?: string }[]; details: unknown; isError?: boolean }>;
	}[];
	handlers: Map<string, (event: unknown) => unknown>;
	pi: ExtensionAPI;
}

function capturePi(): Captured {
	const captured: Captured = { tools: [], handlers: new Map(), pi: undefined as unknown as ExtensionAPI };
	captured.pi = {
		registerTool: (tool: { name: string }) => captured.tools.push(tool as never),
		on: (event: string, handler: (event: unknown) => unknown) => {
			captured.handlers.set(event, handler);
			if (event === "session_shutdown") shutdowns.push(handler as never);
			return () => {};
		},
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	return captured;
}

function textOf(result: { content: { text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("\n");
}

function acceptTool(captured: Captured): Captured["tools"][number] {
	const tool = captured.tools.find((t) => t.name === "pao_accept_task");
	if (!tool) throw new Error(`未注册 pao_accept_task,实际:${captured.tools.map((t) => t.name).join("、")}`);
	return tool;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** 写入最小合法档位配置（与 intake-accept.test.ts 同形：两档、provider 指向假供应商） */
function writeTierConfig(paoHome: string): void {
	mkdirSync(join(paoHome, "pao配置"), { recursive: true });
	writeFileSync(
		join(paoHome, "pao配置", "档位.json"),
		JSON.stringify(
			{
				provider: "pao",
				档位: [
					{ 名: "fast", provider: "fake", model: "fake-fast", thinkingLevel: "low" },
					{ 名: "primary", provider: "fake", model: "fake-primary", thinkingLevel: "medium" },
				],
			},
			null,
			"\t",
		),
		"utf8",
	);
}

/**
 * 受理现场：临时 PAO_HOME（含一个已登记部门）+ 临时 git 仓（卡目录在 `.pao/任务A/卡`）。
 *
 * 为什么要真 git 仓：受理可选派发，派发链会落认领基线快照（读 git status），
 * 不是真仓库的话派发路径会走「基线不可用」分支，测不到真实链路。
 */
async function makeIntakeSite(options: { dept?: string; withTier?: boolean } = {}): Promise<{
	paoHome: string;
	repo: string;
	cardsDir: string;
}> {
	const paoHome = tempDir("intake-home");
	await createDept({ paoHome, 名字: options.dept ?? "后端" });
	// 档位配置是预检的一道闸：缺了会「阻止启动」。工具面测试默认给齐，
	// 让「受理成功」验的是建卡与身份回填，而不是在测预检；要测缺配置时显式 withTier:false。
	if (options.withTier !== false) writeTierConfig(paoHome);
	const repo = tempDir("intake-repo");
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	const cardsDir = join(repo, ".pao", "任务A", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return { paoHome, repo, cardsDir };
}

/** 卡目录里真实存在的卡文件（用来断言「没建卡」/「卡文件数没变」） */
function cardFiles(cardsDir: string): string[] {
	if (!existsSync(cardsDir)) return [];
	return readdirSync(cardsDir).filter((name) => name.startsWith("卡") && name.endsWith(".md"));
}

function setup(site: { paoHome: string; cardsDir: string }): {
	tool: Captured["tools"][number];
	face: ReturnType<typeof registerWorkerTools>;
	captured: Captured;
	runner: FakeRunner;
} {
	const runner = new FakeRunner();
	const captured = capturePi();
	const face = registerWorkerTools(captured.pi, {
		runner,
		signals: false,
		resolveCardsDir: () => site.cardsDir,
		resolvePaoHome: () => site.paoHome,
	});
	return { tool: acceptTool(captured), face, captured, runner };
}

// ── 注册面 ───────────────────────────────────────────────────────────────

describe("pao_accept_task:注册面", () => {
	it("已注册、有中文 label「受理任务」、描述里写清与旧入口的关系", () => {
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner: new FakeRunner(), signals: false });
		const tool = acceptTool(captured);
		expect(tool.label).toBe("受理任务");
		expect(tool.description).toContain("task");
		expect(tool.description).toContain("target/acceptance");
		expect(tool.description).toContain("冲突");
		expect(tool.description).toContain("dispatch 缺省 false");
		expect(tool.description).toContain("dispatch=true 须给 reason");
		expect(tool.description).toContain("不表示 worker 已启动");
		expect(tool.description).toContain("等待结果通知");
		expect(tool.description).not.toContain("每次");
		expect(tool.description).not.toContain("pao_terminate_card");
		expect(tool.description).toContain("重复提交");
	});

	it("旧入口一个都没被改名或撤掉(兼容契约)", () => {
		const captured = capturePi();
		registerWorkerTools(captured.pi, { runner: new FakeRunner(), signals: false });
		const names = captured.tools.map((t) => t.name);
		for (const legacy of ["pao_dispatch_card", "pao_terminate_card", "pao_inventory", "pao_stop_background"]) {
			expect(names, legacy).toContain(legacy);
		}
	});
});

// ── 受理成功 ─────────────────────────────────────────────────────────────

describe("pao_accept_task:受理成功返回真实身份", () => {
	it("只建卡(dispatch 缺省 false):返回卡号并明确尚未派发", async () => {
		const site = await makeIntakeSite();
		const { tool, runner } = setup(site);

		const result = await tool.execute(
			"t",
			{ target: "把登录页的报错文案改清楚", dept: "后端", acceptance: "报错文案能看懂且不再抛栈" },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.isError).toBeUndefined();
		const text = textOf(result);
		// 卡号：真实发号器给的 0001
		expect(text).toContain("已受理");
		expect(text).toContain("卡0001");
		// 尝试号：没派发就没有尝试，如实说「未产生」而不是编一个 0
		expect(text).toContain("尝试号未产生");
		expect(text).toContain("尚未提交后台派发");
		expect(text).toContain("pao_dispatch_card");
		expect(text).not.toContain("pao_terminate_card");

		// 卡真的落在卡目录，且真的没启动
		const files = cardFiles(site.cardsDir);
		expect(files).toHaveLength(1);
		const card = readCard(join(site.cardsDir, files[0] as string));
		expect(card.frontmatter.status).toBe("unclaimed");
		expect(card.frontmatter.attempt).toBe(0);
		expect(card.frontmatter.goal).toBe("把登录页的报错文案改清楚");
		expect(runner.runs).toHaveLength(0);
	});

	it("结构化 task 的真卡 constraints 包含交付物和实施提示,diff 内不再重复手填正文", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);
		const result = await tool.execute(
			"task-book",
			{
				dept: "后端",
				task: {
					goal: "统一报错入口",
					inputs: ["src"],
					boundaries: "只改错误映射",
					acceptance: "存在: src/errors.ts",
					deliverables: ["错误映射与回归测试"],
					implementation_hints: "复用现有错误码",
				},
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBeUndefined();
		const card = readCard(join(site.cardsDir, cardFiles(site.cardsDir)[0] as string));
		expect(card.frontmatter.goal).toBe("统一报错入口");
		expect(card.frontmatter.inputs).toEqual(["src"]);
		expect(card.frontmatter.constraints).toContain("只改错误映射");
		expect(card.frontmatter.constraints).toContain("错误映射与回归测试");
		expect(card.frontmatter.constraints).toContain("复用现有错误码");
		expect(card.frontmatter.constraints?.match(/只改错误映射/g)).toHaveLength(1);
		const brief = await prepareDispatchBrief({
			cardsDir: site.cardsDir,
			cardPath: card.path,
			projectRoot: site.repo,
			executionRoot: site.repo,
		});
		expect(brief.briefMarkdown).toContain("错误映射与回归测试");
		expect(brief.briefMarkdown).toContain("复用现有错误码");
	});

	it("task 与旧字段冲突时明确拒绝且不建卡", async () => {
		const site = await makeIntakeSite();
		const { tool, runner } = setup(site);
		const result = await tool.execute(
			"conflict",
			{
				target: "旧目标",
				acceptance: "同一验收",
				dept: "后端",
				task: {
					goal: "新目标",
					acceptance: "同一验收",
					deliverables: ["产物"],
				},
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("冲突");
		expect(cardFiles(site.cardsDir)).toHaveLength(0);
		expect(runner.runs).toHaveLength(0);
	});

	it("task 的空 inputs/空白可选段归一省略,但缺交付物仍拒绝", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);
		const optionalEmpty = await tool.execute(
			"empty-optionals",
			{
				dept: "后端",
				task: {
					goal: "可选段归一",
					inputs: [],
					boundaries: " ",
					acceptance: "做完",
					deliverables: ["产物"],
					implementation_hints: " ",
				},
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(optionalEmpty.isError).toBeUndefined();
		const card = readCard(join(site.cardsDir, cardFiles(site.cardsDir)[0] as string));
		expect(card.frontmatter.inputs).toEqual([]);
		expect(card.frontmatter.constraints).not.toContain("## 边界\n");
		expect(card.frontmatter.constraints).not.toContain("## 实施提示");

		const missing = await tool.execute(
			"missing-deliverables",
			{
				dept: "后端",
				task: { goal: "缺交付物", acceptance: "做完", deliverables: [] },
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(missing.isError).toBe(true);
		expect(textOf(missing)).toContain("交付物");
		expect(cardFiles(site.cardsDir)).toHaveLength(1);
	});

	it("dispatch=true:建卡并提交后台派发,执行输入保留交付物和实施提示", async () => {
		const site = await makeIntakeSite();
		const { tool, face, captured, runner } = setup(site);

		const result = await tool.execute(
			"t",
			{
				dept: "后端",
				task: {
					goal: "补一个导出接口",
					acceptance: "接口可调用且有测试",
					deliverables: ["导出接口与测试"],
					implementation_hints: "沿用现有模块边界",
				},
				dispatch: true,
				reason: "上游在等这个接口",
			},
			undefined,
			undefined,
			{} as never,
		);
		await face.waitForBackground();
		// 消费一次通知缓冲，让后台链收尾的动作也走完（与 worker-dispatch 测试同款）
		captured.handlers.get("before_agent_start")?.({ systemPromptOptions: { sections: {} } });

		expect(result.isError).toBeUndefined();
		const text = textOf(result);
		expect(text).toContain("卡0001");
		expect(text).toContain("已提交后台派发");
		expect(text).toContain("等待结果通知");
		expect(text).not.toContain("正在运行");
		// 派发链是后台的：认领在后台发生，工具当场可能还拿不到尝试号。
		// 两种情况都是真实结果，但**必须**是其中一种真话，不许含糊。
		const saysNotYet = text.includes("尝试号未产生");
		const saysAttempt = /尝试 \d+/.test(text);
		expect(saysNotYet || saysAttempt, text).toBe(true);

		// 「真派出」的可观察证据：卡从待认领真的走成了进行中，且 FakeRunner 被调用了
		// （FakeRunner 覆写 run 只登记不 spawn，所以这里数的是派发链真的走到执行层）
		expect(runner.runs.length).toBeGreaterThan(0);
		expect(runner.runs[0]?.提示词).toContain("导出接口与测试");
		expect(runner.runs[0]?.提示词).toContain("沿用现有模块边界");
		const dispatched = readCard(join(site.cardsDir, cardFiles(site.cardsDir)[0] as string));
		expect(dispatched.frontmatter.status).toBe("in_progress");
		expect(dispatched.frontmatter.attempt).toBe(1);
	}, 30_000);

	it("派发后受理账补写失败:当前结果明确警告,下次 duplicate 保持未知而不误报未派发", async () => {
		const site = await makeIntakeSite();
		const { tool, face } = setup(site);
		const realWrite = atomic.writeFileAtomic;
		let failDispatchedUpdate = false;
		const writes = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, text) => {
			if (
				failDispatchedUpdate &&
				path === join(site.repo, ".pao", "intake", "受理账.json") &&
				text.includes('"dispatched": true')
			)
				throw new Error("模拟受理账补写失败");
			realWrite(path, text);
		});
		try {
			failDispatchedUpdate = true;
			const first = await tool.execute(
				"first",
				{
					request_key: "dispatch-ledger-write-fail",
					target: "派发后账写失败",
					dept: "后端",
					acceptance: "有结果",
					dispatch: true,
					reason: "验证账写失败",
				},
				undefined,
				undefined,
				{} as never,
			);
			await face.waitForBackground();
			expect(textOf(first)).toContain("已提交后台派发");
			expect(textOf(first)).toContain("受理账补写失败");

			failDispatchedUpdate = false;
			const second = await tool.execute(
				"second",
				{
					request_key: "dispatch-ledger-write-fail",
					target: "派发后账写失败",
					dept: "后端",
					acceptance: "有结果",
					dispatch: true,
					reason: "验证账写失败",
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(textOf(second)).toContain("首次派发状态未记录");
			expect(textOf(second)).not.toContain("首次只建了卡");
			expect(textOf(second)).not.toContain("正在运行");
		} finally {
			writes.mockRestore();
		}
	}, 30_000);
});

// ── 真拒绝 ───────────────────────────────────────────────────────────────

describe("pao_accept_task:拒绝给真实原因且不建卡", () => {
	it("调用已取消时不建卡、不启动后台派发", async () => {
		const site = await makeIntakeSite();
		const { tool, face, runner } = setup(site);
		const controller = new AbortController();
		controller.abort(new Error("用户已取消"));
		const result = await tool.execute(
			"cancelled",
			{ target: "取消后的任务", dept: "后端", acceptance: "完成", dispatch: true, reason: "测试取消" },
			controller.signal,
			undefined,
			{} as never,
		);
		await face.waitForBackground();
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("取消");
		expect(cardFiles(site.cardsDir)).toHaveLength(0);
		expect(runner.runs).toHaveLength(0);
	});

	it("建卡后派发通道拒绝时保留真实卡身份，不声称没有建卡", async () => {
		const site = await makeIntakeSite();
		// 故障注入：模拟宿主同步拒绝受理；建卡和受理账仍运行真实实现。
		const report = await acceptIntake(
			site.cardsDir,
			[
				{
					idempotencyKey: "dispatch-refused",
					goal: "已建卡但派发被拒",
					dept: "后端",
					acceptance: "完成",
					dispatch: true,
					reason: "核对部分成功",
				},
			],
			{
				paoHome: site.paoHome,
				dispatchInBackground: () => {
					throw new Error("宿主已关闭");
				},
			},
		);
		const outcome = report.outcomes[0]!;
		expect(outcome.status).toBe("rejected");
		expect(cardFiles(site.cardsDir)).toHaveLength(1);
		expect(readCard(outcome.cardPath!).frontmatter.status).toBe("unclaimed");
		const text = formatIntakeOutcome(outcome, {
			cardsDir: site.cardsDir,
			autoKey: false,
			requestKey: "dispatch-refused",
		});
		expect(text).toContain("已建卡");
		expect(text).toContain("卡0001");
		expect(text).toContain("宿主已关闭");
		expect(text).not.toContain("没有建卡");
	});

	it("部门不存在:如实拒绝并点名部门,卡目录一个文件都不多", async () => {
		const site = await makeIntakeSite({ dept: "后端" });
		const { tool, runner } = setup(site);

		const result = await tool.execute(
			"t",
			{ target: "随便干点啥", dept: "不存在的部门", acceptance: "做完" },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("未受理");
		// 真实原因里必须点出是哪个部门有问题——不是笼统「预检未通过」
		expect(text).toContain("不存在的部门");
		expect(text).toContain("没有建卡");

		expect(cardFiles(site.cardsDir)).toHaveLength(0);
		expect(runner.runs).toHaveLength(0);
	});

	it("缺必填(目标为空):如实拒绝,不建卡", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);

		const result = await tool.execute(
			"t",
			{ target: "   ", dept: "后端", acceptance: "做完" },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("未受理");
		expect(text).toContain("目标");
		expect(cardFiles(site.cardsDir)).toHaveLength(0);
	});

	it("dispatch=true 但没给理由:如实拒绝(派单理由必填,留痕供审查)", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);

		const result = await tool.execute(
			"t",
			{ target: "派个活", dept: "后端", acceptance: "做完", dispatch: true },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("reason");
		expect(cardFiles(site.cardsDir)).toHaveLength(0);
	});
});

// ── 幂等：重复提交 ───────────────────────────────────────────────────────

describe("pao_accept_task:同一判据重复提交不重复建卡", () => {
	it("显式 request_key 第二次调用返回第一次的身份,卡文件数不变", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);
		const params = {
			target: "写一个迁移脚本",
			dept: "后端",
			acceptance: "脚本能跑通且幂等",
			request_key: "迁移脚本-第一版",
		};

		const first = await tool.execute("t", params, undefined, undefined, {} as never);
		expect(first.isError).toBeUndefined();
		expect(textOf(first)).toContain("卡0001");
		expect(cardFiles(site.cardsDir)).toHaveLength(1);

		const second = await tool.execute("t", params, undefined, undefined, {} as never);
		const secondText = textOf(second);
		// 文案必须明确：重复提交、返回第一次身份、没重复建卡
		expect(secondText).toContain("同一请求的重复提交");
		expect(secondText).toContain("未重复建卡");
		expect(secondText).toContain("卡0001");
		expect(second.isError).toBeUndefined();

		// 关键：卡文件数真的没变
		expect(cardFiles(site.cardsDir)).toHaveLength(1);
	});

	it("未给 request_key:自动生成判据、返回里写明「自动生成」,同内容重提仍判重复", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);
		const params = {
			target: "整理知识库索引",
			dept: "后端",
			acceptance: "索引与实际文件一致",
		};

		const first = await tool.execute("t", params, undefined, undefined, {} as never);
		const firstText = textOf(first);
		expect(first.isError).toBeUndefined();
		// 自动判据要显示出来：带 auto: 前缀，且明说它是自动生成的
		const match = firstText.match(/auto:[0-9a-f]{16}/);
		expect(match, firstText).not.toBeNull();
		expect(firstText).toContain("自动生成");
		expect(cardFiles(site.cardsDir)).toHaveLength(1);

		// 同内容重提 → 落到同一条自动判据 → duplicate
		const second = await tool.execute("t", params, undefined, undefined, {} as never);
		const secondText = textOf(second);
		expect(secondText).toContain("同一请求的重复提交");
		expect(secondText).toContain(match?.[0] as string);
		expect(cardFiles(site.cardsDir)).toHaveLength(1);
	});

	it("自动判据:目标是唯一变量的内容不同即不同判据(不做语义去重,如实各建一卡)", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);

		const a = await tool.execute(
			"t",
			{ target: "任务甲", dept: "后端", acceptance: "做完" },
			undefined,
			undefined,
			{} as never,
		);
		const b = await tool.execute(
			"t",
			{ target: "任务乙", dept: "后端", acceptance: "做完" },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(a)).not.toContain("重复提交");
		expect(textOf(b)).not.toContain("重复提交");
		expect(cardFiles(site.cardsDir)).toHaveLength(2);
	});
});

// ── 自动判据的纯函数契约 ─────────────────────────────────────────────────

describe("buildAutoIntakeKey:稳定判据", () => {
	it("同输入同判据;依赖顺序不影响;任一字段变化即换判据", () => {
		const base = { goal: "做 X", dept: "后端", acceptance: "X 能用" };
		const key = buildAutoIntakeKey(base);
		expect(buildAutoIntakeKey({ ...base, goal: "  做 X  " })).toBe(key); // trim 后同内容
		expect(buildAutoIntakeKey({ ...base, dependsOn: ["卡0002", "卡0001"] })).toBe(
			buildAutoIntakeKey({ ...base, dependsOn: ["卡0001", "卡0002"] }),
		); // 依赖排序后参与
		expect(key).toMatch(/^auto:[0-9a-f]{16}$/);
		expect(buildAutoIntakeKey({ ...base, acceptance: "X 能用且快" })).not.toBe(key);
		expect(buildAutoIntakeKey({ ...base, dept: "前端" })).not.toBe(key);
		expect(buildAutoIntakeKey({ ...base, goal: "做 Y" })).not.toBe(key);
	});
});

// ── 停止后旧结果失效(§5.4) ──────────────────────────────────────────────

describe("pao_accept_task:停止后旧受理结果不能当成功", () => {
	it("卡被改成 canceled 后,同判据重复提交会点明「已被停止/旧结果不再有效」", async () => {
		const site = await makeIntakeSite();
		const { tool } = setup(site);
		const params = { target: "会被停掉的任务", dept: "后端", acceptance: "做完", request_key: "会被停掉-判据" };

		const first = await tool.execute("t", params, undefined, undefined, {} as never);
		expect(first.isError).toBeUndefined();
		const file = cardFiles(site.cardsDir)[0] as string;
		const cardPath = join(site.cardsDir, file);

		// 模拟「用户把这个卡停了」：走真实状态机入口（用户取消不需要 owner 匹配），
		// 不手改 YAML——手改会绕过尝试号/终态等真实字段，验出来的是假现场。
		changeCardStatus(readCard(cardPath), {
			操作者: "用户",
			to: "canceled",
			依据: "测试:用户停止",
			时间: new Date().toISOString(),
		});
		expect(readCard(cardPath).frontmatter.status).toBe("canceled");

		const second = await tool.execute("t", params, undefined, undefined, {} as never);
		const text = textOf(second);
		expect(text).toContain("同一请求的重复提交");
		// §5.4：不能只说「已返回第一次身份」就完事，必须点出旧结果已失效
		expect(text).toContain("已被停止");
		expect(text).not.toContain("等待结果通知");
		// 卡文件数仍然没变（重复提交不建卡）
		expect(cardFiles(site.cardsDir)).toHaveLength(1);
	});
});

describe("formatIntakeOutcome:受理结果文案按事实分支", () => {
	const baseOutcome = {
		idempotencyKey: "result-shape",
		acceptedAt: "2026-10-24 20:00",
		cardNo: "0001",
		cardPath: "D:\\现场\\卡0001.md",
		problems: [],
	};
	const options = { cardsDir: "D:\\现场", autoKey: false, requestKey: "result-shape" };

	it("accepted 只在 dispatched=true 时等待通知；false 与 unknown 分别说明", () => {
		const dispatched = formatIntakeOutcome(
			{ ...baseOutcome, status: "accepted", dispatchRequested: true, dispatched: true },
			options,
		);
		expect(dispatched).toContain("已提交后台派发");
		expect(dispatched).toContain("等待结果通知");
		expect(dispatched).not.toContain("正在运行");

		const notDispatched = formatIntakeOutcome(
			{ ...baseOutcome, status: "accepted", dispatchRequested: false, dispatched: false },
			options,
		);
		expect(notDispatched).toContain("只建了卡");
		expect(notDispatched).not.toContain("等待结果通知");

		const unknown = formatIntakeOutcome({ ...baseOutcome, status: "accepted", dispatchRequested: true }, options);
		expect(unknown).toContain("未记录是否已提交后台派发");
		expect(unknown).toContain("不能据此认定仅建卡");
		expect(unknown).not.toContain("等待结果通知");
	});

	it("stale 优先于派发状态；deferred 说明未派原因和下一步", () => {
		const stale = formatIntakeOutcome(
			{ ...baseOutcome, status: "accepted", dispatchRequested: true, dispatched: true },
			{ ...options, stale: true },
		);
		expect(stale).toContain("旧受理结果不再有效");
		expect(stale).not.toContain("等待结果通知");

		const deferred = formatIntakeOutcome(
			{
				...baseOutcome,
				status: "deferred",
				dispatchRequested: true,
				dispatched: false,
				reason: "依赖未放行",
			},
			options,
		);
		expect(deferred).toContain("没有派发");
		expect(deferred).toContain("依赖未放行");
		expect(deferred).toContain("pao_dispatch_card");
		expect(deferred).not.toContain("等待结果通知");
	});
});

// ── 查回闭环：终态卡分区（E5 补「各模式可查回」） ─────────────────────────

describe("pao_inventory:终态卡分区", () => {
	function inventoryTool(captured: Captured): Captured["tools"][number] {
		const tool = captured.tools.find((t) => t.name === "pao_inventory");
		if (!tool) throw new Error(`未注册 pao_inventory,实际:${captured.tools.map((t) => t.name).join("、")}`);
		return tool;
	}

	/**
	 * 造一张真实的终态卡：走 state machine（`changeCardStatus`）而不是手写 YAML——
	 * 手写的话 `## owner记录` 段、`completed` 字段都可能与生产线型不一致，
	 * 验出来的是假现场（这条纪律与上面 §5.4 用例一致）。
	 *
	 * 只用 canceled/failed 两种终态：`delivered` 要求先从 unclaimed 进 in_progress，
	 * 而本文件里 FakeRunner 的派发是后台异步的，为了用例稳定不去抢那个时序。
	 */
	function settleCard(cardsDir: string, file: string, to: "canceled" | "failed", reason: string, when: string): void {
		changeCardStatus(readCard(join(cardsDir, file)), {
			操作者: "用户",
			to,
			依据: reason,
			时间: when,
			失败类型: to === "failed" ? "transient" : undefined,
		});
	}

	it("受理→停止→盘点能看到该卡、标 canceled、带原因，不再报「未完卡:无」就完事", async () => {
		const site = await makeIntakeSite();
		const { captured } = setup(site);
		const accept = acceptTool(captured);
		const inventory = inventoryTool(captured);

		await accept.execute(
			"t",
			{ target: "会被停止的任务", dept: "后端", acceptance: "做完" },
			undefined,
			undefined,
			{} as never,
		);
		const file = cardFiles(site.cardsDir)[0] as string;
		settleCard(site.cardsDir, file, "canceled", "测试:用户停止", "2026-10-17 11:43");

		const text = textOf(
			await inventory.execute(
				"t",
				{ workspace: join(site.repo, ".pao", "任务A") },
				undefined,
				undefined,
				{} as never,
			),
		);
		// 关键回归：卡被停止后此前对盘点完全消失（只报「未完卡:无」），现在必须留痕
		expect(text).toContain("已终结卡 1 张");
		expect(text).toMatch(/卡0001〔canceled〕/);
		expect(text).toContain("会被停止的任务");
		expect(text).toContain("2026-10-17 11:43");
		expect(text).toContain("测试:用户停止");
		// 未完成卡仍是空的（终态卡不进未完成卡分区，过滤逻辑没被改动）
		expect(text).toContain("未完卡:无");
	});

	it("超过上限只报最近 5 张并明说还有多少没列（不假装全量）", async () => {
		const site = await makeIntakeSite();
		const { captured } = setup(site);
		const accept = acceptTool(captured);
		const inventory = inventoryTool(captured);

		// 7 张卡全部终结，时间递增 → 最近 5 张应被列出，最早 2 张进「未列出」
		for (let i = 1; i <= 7; i++) {
			await accept.execute(
				"t",
				{ target: `批次任务${i}`, dept: "后端", acceptance: "做完" },
				undefined,
				undefined,
				{} as never,
			);
			const prefix = `卡${String(i).padStart(4, "0")}`;
			const file = cardFiles(site.cardsDir).filter((name) => name.startsWith(prefix))[0] as string;
			settleCard(site.cardsDir, file, "canceled", `第${i}张收尾`, `2026-10-1${i} 10:00`);
		}

		const text = textOf(
			await inventory.execute(
				"t",
				{ workspace: join(site.repo, ".pao", "任务A") },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(text).toContain("已终结卡 5 张");
		expect(text).toContain("另有 2 张已终结卡未列出");
		// 最近两张必须在列，最早两张不在列
		expect(text).toMatch(/卡0007〔canceled〕/);
		expect(text).toMatch(/卡0003〔canceled〕/);
		expect(text).not.toMatch(/卡0001〔canceled〕/);
		expect(text).not.toMatch(/卡0002〔canceled〕/);
	});

	it("没有终态卡时整段不输出（不出现「已终结卡:无」这种零信息行）", async () => {
		const site = await makeIntakeSite();
		const { captured } = setup(site);
		const accept = acceptTool(captured);
		const inventory = inventoryTool(captured);

		await accept.execute(
			"t",
			{ target: "还在跑的任务", dept: "后端", acceptance: "做完" },
			undefined,
			undefined,
			{} as never,
		);

		const text = textOf(
			await inventory.execute(
				"t",
				{ workspace: join(site.repo, ".pao", "任务A") },
				undefined,
				undefined,
				{} as never,
			),
		);
		expect(text).toContain("未完卡 1 张");
		expect(text).not.toContain("已终结卡");
	});
});
