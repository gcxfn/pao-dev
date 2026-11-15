/**
 * 缓存衰减探针测试:全部走注入假件(调用器/时钟都是脚本化 mock),绝不触网、绝不真实计费。
 * 覆盖:缺省不触发、显式参数触发、注入时钟下采样序列、衰减曲线计算、单点失败容错。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import {
	buildFixedContext,
	type CacheProbeParams,
	type CacheSampleRecord,
	cacheHitRate,
	decayVerdict,
	type HealthcheckCaller,
	type HealthcheckCallOptions,
	type HealthcheckReportWithPaths,
	type ProbeClock,
	realClock,
	registerHealthcheck,
	renderCacheProbeReport,
	runCacheProbe,
	runHealthcheck,
	validateCacheProbeParams,
} from "../../src/pao/healthcheck/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** 模型调用全部走注入假件,密钥与网络永不进测试(R10) */
function makeUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0, costTotal = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

function textReply(u: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "OK" }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: u,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolReply(id: string, name: string, args: { 甲: number }): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: makeUsage(12, 8),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const fakeModel = {
	id: "glm-4.7/fake",
	name: "假GLM",
	api: "openai-completions",
	provider: "zhipu-fake",
	baseUrl: "https://fake.example/v1",
	input: ["text"],
	cost: {},
	reasoning: true,
	contextWindow: 1000,
	maxTokens: 4096,
} as unknown as Model<any>;

/** 假时钟:now 只随 sleep 前进;记录每次睡眠时长,睡眠即时兑现 */
function fakeClock() {
	let nowMs = 1_000_000;
	const sleeps: number[] = [];
	const clock: ProbeClock = {
		now: () => nowMs,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			nowMs += ms;
		},
	};
	return { clock, sleeps, 现在: () => nowMs };
}

/** 脚本化调用器:按次序吐用量(或抛错);记录每次收到的消息与选项 */
function scriptedCaller(playbook: (Usage | Error)[]) {
	const received: { 消息: Message[]; 选项?: HealthcheckCallOptions }[] = [];
	let count = 0;
	const caller: HealthcheckCaller = async (messages, options) => {
		received.push({ 消息: messages, 选项: options });
		const step = playbook[count++];
		if (!step) throw new Error(`剧本用尽:第 ${count} 次调用无剧本`);
		if (step instanceof Error) throw step;
		return textReply(step);
	};
	return { caller, received, 已调用: () => count };
}

describe("缓存命中率(纯函数)", () => {
	it("当前 cacheRead / 基线 cacheRead;基线缺失或为 0 时 undefined", () => {
		expect(cacheHitRate(makeUsage(10, 5, 1000), makeUsage(10, 5, 500))).toBe(0.5);
		expect(cacheHitRate(makeUsage(10, 5, 1000), makeUsage(10, 5, 1000))).toBe(1);
		expect(cacheHitRate(undefined, makeUsage(10, 5, 500))).toBeUndefined();
		expect(cacheHitRate(makeUsage(10, 5, 0), makeUsage(10, 5, 500))).toBeUndefined();
	});
});

describe("固定上下文", () => {
	it("填充字符数按给定值截齐,尾部带固定指令", () => {
		const messages = buildFixedContext(400);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		const content = messages[0].content as string;
		expect(content.startsWith("0123456789")).toBe(true);
		expect(content).toContain("请只回答:OK");
		expect(content.length).toBe(400 + "\n\n上面是一段固定内容。请只回答:OK".length);
	});
});

describe("参数校验(必须在任何计费请求之前拦下)", () => {
	const validParams: CacheProbeParams = { context_chars: 400, sample_points: [30] };

	it("合法参数通过", () => {
		expect(() => validateCacheProbeParams(validParams)).not.toThrow();
	});

	it("字符数非正 / 采样点为空 / 负延迟 / 阈值出界 都报错", () => {
		expect(() => validateCacheProbeParams({ ...validParams, context_chars: 0 })).toThrow(/context_chars/);
		expect(() => validateCacheProbeParams({ ...validParams, sample_points: [] })).toThrow(/sample_points/);
		expect(() => validateCacheProbeParams({ ...validParams, sample_points: [30, -1] })).toThrow(/延迟秒/);
		expect(() => validateCacheProbeParams({ ...validParams, decay_threshold: 0 })).toThrow(/decay_threshold/);
		expect(() => validateCacheProbeParams({ ...validParams, decay_threshold: 1.5 })).toThrow(/decay_threshold/);
	});
});

describe("跑缓存探针(注入时钟+调用器)", () => {
	const warmBaseline = (cacheRead: number) => makeUsage(100, 8, cacheRead, 400, 0.001);

	it("采样序列正确:首采样偏移 0,其余按升序延迟重发;每次都发同一份上下文且要 short 缓存", async () => {
		const { clock, sleeps } = fakeClock();
		const { caller, received } = scriptedCaller([warmBaseline(400), warmBaseline(400), warmBaseline(200)]);
		const result = await runCacheProbe(caller, clock, { context_chars: 400, sample_points: [20, 10] });

		expect(result.采样.map((item) => item.偏移秒)).toEqual([0, 10, 20]);
		// 未排序输入按升序执行:先睡到 +10s,再从 +10s 睡到 +20s
		expect(sleeps).toEqual([10_000, 10_000]);
		expect(received).toHaveLength(3);
		expect(JSON.stringify(received[0].消息).length).toBeGreaterThan(400); // 固定上下文确实带填充
		expect(received[1].消息).toEqual(received[0].消息); // 同一对象复用,内容分毫不差
		expect(received[2].消息).toEqual(received[0].消息);
		expect(received[0].选项).toEqual({ maxTokens: 16, cacheRetention: "short" });
	});

	it("冷启动现实:首采样只写不读(命中率 —),基线取首个成功读缓存采样,后续相对它递减", async () => {
		const { clock } = fakeClock();
		const writeUsage = () => makeUsage(100, 8, 0, 400, 0.001); // 冷缓存首采:cacheRead=0,写 400
		const readUsage = (cacheRead: number) => makeUsage(100, 8, cacheRead, 0, 0.001);
		const { caller } = scriptedCaller([writeUsage(), readUsage(400), readUsage(100)]);
		const defaultRun = await runCacheProbe(caller, clock, { context_chars: 400, sample_points: [30, 60] });
		// 首采样 cacheRead=0 不能当基线;+30s 全命中才是参照(=100%),+60s 衰减到 25%
		expect(defaultRun.采样.map((item) => item.命中率)).toEqual([undefined, 1, 0.25]);
		expect(defaultRun.总用量.cacheRead).toBe(0 + 400 + 100);
		expect(defaultRun.总用量.cost.total).toBeCloseTo(0.003, 10);
		expect(defaultRun.衰减阈值).toBe(0.5);
		expect(decayVerdict(defaultRun.采样, defaultRun.衰减阈值)).toContain("首个间隔为 +60s");

		const explicitRun = await runCacheProbe(caller, clock, {
			context_chars: 400,
			sample_points: [30],
			decay_threshold: 0.8,
		});
		expect(explicitRun.衰减阈值).toBe(0.8);
	});
});

describe("衰减曲线渲染与结论(纯函数)", () => {
	const successSample = (offsetSeconds: number, cacheRead: number): CacheSampleRecord => ({
		偏移秒: offsetSeconds,
		状态: "成功",
		用量: makeUsage(100, 8, cacheRead, 400, 0.001),
		命中率: undefined,
	});
	const failureSample = (offsetSeconds: number, description: string): CacheSampleRecord => ({
		偏移秒: offsetSeconds,
		状态: "失败",
		说明: description,
	});

	it("每次采样一行:偏移/cacheRead/cacheWrite/输入输出/成本/命中率都在行上", () => {
		const rendered = renderCacheProbeReport({
			上下文字符数: 400,
			衰减阈值: 0.5,
			采样: [
				{ ...successSample(0, 400), 命中率: 1 },
				{ ...successSample(30, 400), 命中率: 1 },
			],
			总用量: makeUsage(200, 16, 800, 800, 0.003),
		});
		const lines = rendered.split("\n");
		expect(lines[0]).toContain("缓存衰减探针");
		expect(lines[0]).toContain("成功采样 2/2");
		expect(lines[0]).toContain("$0.003000");
		expect(lines[1]).toContain("+0s");
		expect(lines[1]).toContain("cacheRead 400 / cacheWrite 400");
		expect(lines[1]).toContain("命中率 100.0%");
		expect(lines[2]).toContain("+30s");
		expect(lines[2]).toContain("cacheRead 400 / cacheWrite 400");
		expect(lines[2]).toContain("输入 100 / 输出 8");
		expect(lines[2]).toContain("成本 $0.001000");
		expect(lines[2]).toContain("命中率 100.0%");
		expect(lines.at(-1)).toMatch(/^结论:/);
	});

	it("全程无缓存读命中:采样行命中率记 —;结论如实说无法评估", () => {
		const rendered = renderCacheProbeReport({
			上下文字符数: 400,
			衰减阈值: 0.5,
			采样: [
				{ ...successSample(0, 0), 命中率: undefined },
				{ ...successSample(30, 0), 命中率: undefined },
			],
			总用量: makeUsage(200, 16, 0, 800, 0.002),
		});
		expect(rendered.split("\n")[1]).toContain("命中率 —");
		expect(rendered.split("\n").at(-1)).toContain("无法评估衰减");
	});

	it("结论给出跌破阈值的首个间隔;未跌破则如实说", () => {
		const declining = [successSample(0, 400), successSample(30, 320), successSample(60, 160), successSample(90, 40)];
		declining.forEach((item) => {
			item.命中率 = (item.用量?.cacheRead ?? 0) / 400;
		});
		expect(decayVerdict(declining, 0.5)).toContain("首个间隔为 +60s");
		expect(decayVerdict(declining, 0.5)).toContain("空闲预热间隔应短于该值");

		const noBreach = [successSample(0, 400), successSample(30, 320), successSample(60, 240)];
		noBreach.forEach((item) => {
			item.命中率 = (item.用量?.cacheRead ?? 0) / 400;
		});
		expect(decayVerdict(noBreach, 0.5)).toContain("未见衰减");
	});

	it("失败采样不进结论;全失败/空数组如实说无法评估", () => {
		const baseline = { ...successSample(0, 400), 命中率: 1 };
		const errorPoint = failureSample(30, "connect ECONNREFUSED");
		const breach = { ...successSample(60, 160), 命中率: 0.4 };
		expect(decayVerdict([baseline, errorPoint, breach], 0.5)).toContain("首个间隔为 +60s");
		expect(decayVerdict([failureSample(0, "401")], 0.5)).toContain("无法评估衰减");
		expect(decayVerdict([], 0.5)).toContain("无法评估衰减");
	});
});

describe("异常采样点容错(单点失败不炸整份报告)", () => {
	it("中间采样抛错:记失败继续跑,曲线与合计不受牵连", async () => {
		const { clock } = fakeClock();
		const { caller } = scriptedCaller([
			makeUsage(100, 8, 400, 400),
			new Error("connect ETIMEDOUT"),
			makeUsage(100, 8, 100, 0),
		]);
		const result = await runCacheProbe(caller, clock, { context_chars: 400, sample_points: [30, 60] });

		expect(result.采样).toHaveLength(3);
		expect(result.采样[1].状态).toBe("失败");
		expect(result.采样[1].说明).toContain("ETIMEDOUT");
		expect(result.采样[1].命中率).toBeUndefined();
		expect(result.采样[2].命中率).toBe(0.25); // 基线仍是首采样(cacheRead 400)
		expect(result.总用量.cacheRead).toBe(500); // 失败点无用量,不计入合计

		const rendered = renderCacheProbeReport(result);
		expect(rendered).toContain("+30s:采样失败(connect ETIMEDOUT)");
		expect(rendered.split("\n").at(-1)).toContain("首个间隔为 +60s");
	});

	it("首采样也失败:退用首个成功采样当基线,曲线仍有参照", async () => {
		const { clock } = fakeClock();
		const { caller } = scriptedCaller([new Error("401"), makeUsage(100, 8, 400, 0), makeUsage(100, 8, 100, 0)]);
		const result = await runCacheProbe(caller, clock, { context_chars: 400, sample_points: [30, 60] });

		expect(result.采样[0].状态).toBe("失败");
		expect(result.采样[1].命中率).toBe(1); // 首个成功「读缓存」的采样即基线
		expect(result.采样[2].命中率).toBe(0.25);
	});

	it("全部失败:报告不炸,结论如实说无法评估", async () => {
		const { clock } = fakeClock();
		const { caller } = scriptedCaller([new Error("a"), new Error("b")]);
		const result = await runCacheProbe(caller, clock, { context_chars: 400, sample_points: [30] });
		expect(result.采样.every((item) => item.状态 === "失败")).toBe(true);
		expect(renderCacheProbeReport(result)).toContain("无法评估衰减");
	});
});

describe("真实时钟", () => {
	it("sleep 真等且 now 前进;已中止的信号立即拒绝", async () => {
		const clock2 = realClock();
		const startNow = clock2.now();
		await clock2.sleep(15);
		expect(clock2.now() - startNow).toBeGreaterThanOrEqual(10);
		const abortCtl = new AbortController();
		abortCtl.abort();
		await expect(realClock(abortCtl.signal).sleep(1000)).rejects.toThrow(/中止/);
	});
});

function capturePi(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

/** 冒烟四连(对话/工具两跳/思考)+ 之后的探针采样,统一按顺序剧本应答 */
function smokeAndProbeCaller(probeScript: (Usage | Error)[]) {
	let n = 0;
	const caller: HealthcheckCaller = async () => {
		n += 1;
		if (n === 1) return textReply(makeUsage(10, 5));
		if (n === 2) return toolReply("c1", "pao_health_check探针", { 甲: 42 });
		if (n === 3) return textReply(makeUsage(24, 13));
		if (n === 4) return textReply(makeUsage(15, 90));
		const step = probeScript[n - 5];
		if (!step) throw new Error("探针剧本用尽");
		if (step instanceof Error) throw step;
		return textReply(step);
	};
	return { caller, called: () => n };
}

describe("pao_health_check 工具接线", () => {
	it("工具 description 写明缓存探针缺省绝不触发、真实计费", () => {
		const captured = capturePi();
		registerHealthcheck(captured.pi, { resolveOutDir: () => tempDir("pao-probe-out-") });
		const tool = captured.tools.find((item) => item.name === "pao_health_check");
		expect(tool).toBeDefined();
		expect(tool!.description).toContain("缺省绝不触发");
		expect(tool!.description).toContain("真实计费");
	});

	it("缺省(不传 缓存探针)绝不触发:只有冒烟 4 次调用,无探针文本块,details 无缓存探针", async () => {
		const captured = capturePi();
		const { caller, called } = smokeAndProbeCaller([]);
		registerHealthcheck(captured.pi, { resolveCaller: () => caller, resolveOutDir: () => tempDir("pao-probe-out-") });
		const tool = captured.tools.find((item) => item.name === "pao_health_check")!;
		const result = await tool.execute("t1", {}, undefined, undefined, { model: fakeModel } as never);

		expect(called()).toBe(4); // 冒烟固定 4 次,探针零调用
		expect(result.content).toHaveLength(1);
		expect((result.content[0] as { text: string }).text).not.toContain("缓存衰减探针");
		expect((result.details as HealthcheckReportWithPaths).cache_probe).toBeUndefined();
	});

	it("显式传 缓存探针 才触发:探针调用不计入体检报告口径,曲线以第二个文本块返回,不落盘", async () => {
		const captured = capturePi();
		const outDir = tempDir("pao-probe-out-");
		const { caller, called } = smokeAndProbeCaller([
			makeUsage(100, 8, 400, 400, 0.002),
			makeUsage(100, 8, 400, 0, 0.001),
			makeUsage(100, 8, 100, 0, 0.001),
		]);
		const sleeps: number[] = [];
		let currentNow = 0;
		registerHealthcheck(captured.pi, {
			resolveCaller: () => caller,
			resolveOutDir: () => outDir,
			resolve缓存时钟: () => ({
				now: () => currentNow,
				sleep: async (ms: number) => {
					sleeps.push(ms);
					currentNow += ms;
				},
			}),
		});
		const tool = captured.tools.find((item) => item.name === "pao_health_check")!;
		const result = await tool.execute(
			"t2",
			{ cache_probe: { context_chars: 400, sample_points: [30, 60] } },
			undefined,
			undefined,
			{ model: fakeModel } as never,
		);

		expect(called()).toBe(7); // 冒烟 4 + 探针 3
		expect(sleeps).toEqual([30_000, 30_000]);
		const details = result.details as HealthcheckReportWithPaths;
		expect(details.calls).toBe(4); // 体检报告口径不含探针
		expect(details.cache_probe).toBeDefined();
		expect(details.cache_probe?.采样).toHaveLength(3);
		expect(result.content).toHaveLength(2);
		const curve = (result.content[1] as { text: string }).text;
		expect(curve).toContain("缓存衰减探针");
		expect(curve).toContain("+60s");
		expect(curve).toContain("命中率 25.0%");
		expect(curve.split("\n").at(-1)).toContain("首个间隔为 +60s");
		// 落盘的评测条目保持原形态,探针不落盘
		expect(existsSync(details.out_path)).toBe(true);
		const written = readFileSync(details.out_path, "utf8");
		expect(written).not.toContain("缓存衰减探针");
		expect(written).toContain("4 次模型调用");
	});

	it("缓存探针参数不合法:在任何计费请求之前就报错(调用器零调用)", async () => {
		const captured = capturePi();
		const { caller, called } = smokeAndProbeCaller([]);
		registerHealthcheck(captured.pi, { resolveCaller: () => caller, resolveOutDir: () => tempDir("pao-probe-out-") });
		const tool = captured.tools.find((item) => item.name === "pao_health_check")!;
		await expect(
			tool.execute("t3", { cache_probe: { context_chars: 0, sample_points: [30] } }, undefined, undefined, {
				model: fakeModel,
			} as never),
		).rejects.toThrow(/context_chars/);
		expect(called()).toBe(0);
	});
});

describe("与冒烟体检编排互不干扰", () => {
	it("run体检 不感知缓存探针;探针可独立成跑", async () => {
		const smoke = scriptedCaller([makeUsage(10, 5), makeUsage(12, 8), makeUsage(24, 13), makeUsage(15, 90)]);
		const result = await runHealthcheck(smoke.caller, fakeModel);
		expect(result).toHaveLength(4);

		const probeCaller = scriptedCaller([makeUsage(100, 8, 400, 400)]);
		const cacheProbeRun = await runCacheProbe(probeCaller.caller, fakeClock().clock, {
			context_chars: 400,
			sample_points: [30],
		});
		expect(cacheProbeRun.采样).toHaveLength(2);
	});
});
