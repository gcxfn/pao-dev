/**
 * §18.1 事实层门面单测：常驻索引（注入/首建模板/超长截断）、每轮自动召回 top3
 * （默认关/降级一次性/外发门/无命中降噪）、压缩交接（默认关/定长封顶/外发门）、
 * 角色门控接线（主控装/worker·部长不装）与零行为硬约束。
 * 不起子进程——供应商用可数假货；真实供应商验收在 mnemosyne-lifecycle.test.ts。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { projectFromCwd } from "../../src/pao/knowledge/outbound.ts";
import {
	AUTO_RECALL_SECTION,
	AUTO_RECALL_TOP,
	boundHandoff,
	loadMemoryVendorConfig,
	loadResidentMemory,
	type MemoryHit,
	type MemoryVendor,
	MemoryVendorManager,
	pruneResidentIndex,
	RESIDENT_INDEX_LINE_LIMIT,
	RESIDENT_MEMORY_LIMIT,
	RESIDENT_MEMORY_RELATIVE_PATH,
	RESIDENT_MEMORY_SECTION,
	RESIDENT_TEMPLATE,
	recallSeed,
	registerMemoryVendor,
	registerResidentMemory,
	renderResidentSection,
	residentMemoryPath,
} from "../../src/pao/memory/index.ts";
import { SessionMemory, sessionMemory } from "../../src/pao/memory/session.ts";
import { PAO_ROLE_ENV } from "../../src/pao/role.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-resident-"));
	tempDirs.push(dir);
	return dir;
}

// ============================================================================
// 假供应商（可数,不起进程）：文件级单例,工厂引用它——manager 惰性获取时才实例化
// ============================================================================

let currentFake: ReturnType<typeof fakeVendor>;
registerMemoryVendor("假供应商", () => currentFake.vendor);

interface FakeBehavior {
	hits?: MemoryHit[];
	启动失败?: string;
	召回抛错?: string;
	写入抛错?: string;
}

function fakeVendor(behavior: FakeBehavior = {}) {
	const calls = {
		启动: 0,
		召回: [] as { 检索词: string; 上限?: number }[],
		写入: [] as { 内容: string; 标签?: readonly string[] }[],
	};
	const vendor: MemoryVendor = {
		vendorName: "假供应商",
		capabilities: { 语义检索: true, 需嵌入端点: false, 忘却: false },
		start: async () => {
			calls.启动++;
			if (behavior.启动失败) throw new Error(behavior.启动失败);
		},
		close: async () => {},
		write: async (content: string, label?: readonly string[]) => {
			calls.写入.push({ 内容: content, 标签: label });
			if (behavior.写入抛错) throw new Error(behavior.写入抛错);
		},
		recall: async (searchQuery: string, limit?: number) => {
			calls.召回.push({ 检索词: searchQuery, 上限: limit });
			if (behavior.召回抛错) throw new Error(behavior.召回抛错);
			return behavior.hits ?? [];
		},
	};
	return { vendor, calls };
}

// ============================================================================
// 假 pi＋事件触发
// ============================================================================

type AnyHandler = (event: never, ctx: unknown) => unknown;

function capturePi() {
	const handlers = new Map<string, AnyHandler[]>();
	const pi = {
		on: (event: string, handler: AnyHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerVirtualModel: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
	};
	return { handlers, pi: pi as unknown as ExtensionAPI };
}

/** 跑一轮:before_agent_start 全部处理器按注册序执行,返回本轮 sections 快照 */
async function fireTurn(captured: ReturnType<typeof capturePi>, prompt: string): Promise<Record<string, string>> {
	const sections: Record<string, string> = {};
	const event = { type: "before_agent_start", prompt, systemPromptOptions: { sections } };
	let recallMessage: string | undefined;
	for (const handler of captured.handlers.get("before_agent_start") ?? []) {
		const result = (await handler(event as never, { cwd: process.cwd() })) as
			| { message?: { customType: string; content: string } }
			| undefined;
		// 动态召回必须走追加消息，不得重写系统前缀。
		expect(event.systemPromptOptions.sections[AUTO_RECALL_SECTION]).toBeUndefined();
		if (result?.message?.customType === AUTO_RECALL_SECTION) recallMessage = result.message.content;
	}
	return { ...sections, ...(recallMessage ? { [AUTO_RECALL_SECTION]: recallMessage } : {}) };
}

async function fireCompact(captured: ReturnType<typeof capturePi>, summary: string): Promise<void> {
	const event = { type: "session_compact", compactionEntry: { summary } };
	for (const handler of captured.handlers.get("session_compact") ?? []) {
		await handler(event as never, {});
	}
}

interface TestContext {
	cwd: string;
	signal: undefined;
	projectionCalls?: { count: number };
	sessionManager: {
		getSessionId(): string;
		getBranch(): unknown[];
		buildSessionProjection(): {
			messages: unknown[];
			thinkingLevel: string;
			model: { provider: string; modelId: string } | null;
		};
	};
}

function testContext(messages: unknown[] = [], sessionId = "test", projectionCalls?: { count: number }): TestContext {
	return {
		cwd: process.cwd(),
		signal: undefined,
		projectionCalls,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
			buildSessionProjection: () => {
				if (projectionCalls) projectionCalls.count++;
				return { messages, thinkingLevel: "off", model: null };
			},
		},
	};
}

async function fireTurnWithContext(
	captured: ReturnType<typeof capturePi>,
	prompt: string,
	ctx: TestContext,
): Promise<{ sections: Record<string, string>; message?: Record<string, unknown> }> {
	const sections: Record<string, string> = {};
	const event = { type: "before_agent_start", prompt, systemPromptOptions: { sections } };
	let message: Record<string, unknown> | undefined;
	for (const handler of captured.handlers.get("before_agent_start") ?? []) {
		const result = (await handler(event as never, ctx)) as { message?: Record<string, unknown> } | undefined;
		if (result?.message) message = result.message;
	}
	return { sections, message };
}

async function fireContext(
	captured: ReturnType<typeof capturePi>,
	messages: unknown[],
	ctx: TestContext,
): Promise<unknown[]> {
	let current = messages;
	for (const handler of captured.handlers.get("context") ?? []) {
		const event = { type: "context", messages: current };
		const result = (await handler(event as never, ctx)) as { messages?: unknown[] } | undefined;
		if (result?.messages) current = result.messages;
	}
	return current;
}

// ============================================================================
// 现场：临时 PAO_HOME（配置/外发许可/常驻索引按需落盘）
// ============================================================================

/** 测试进程 cwd 的项目名（git 根目录名,与 resident.ts 运行期取法一致） */
const currentProject = projectFromCwd(process.cwd());

function tempHome(setup: { 记忆供应商?: unknown; 外发项目?: string[]; 常驻?: string } = {}): string {
	const home = tempDir();
	mkdirSync(join(home, "pao配置"), { recursive: true });
	if (setup.记忆供应商 !== undefined) {
		writeFileSync(join(home, "pao配置", "记忆供应商.json"), JSON.stringify(setup.记忆供应商), "utf8");
	}
	if (setup.外发项目 !== undefined) {
		mkdirSync(join(home, "知识库配置"), { recursive: true });
		const projects: Record<string, { allowed: boolean; asOf: string }> = {};
		for (const name of setup.外发项目) projects[name] = { allowed: true, asOf: "2999-01-01" };
		writeFileSync(join(home, "知识库配置", "外发许可.json"), JSON.stringify({ projects }), "utf8");
	}
	if (setup.常驻 !== undefined) {
		mkdirSync(join(home, "主控记忆"), { recursive: true });
		writeFileSync(join(home, "主控记忆", "MEMORY.md"), setup.常驻, "utf8");
	}
	return home;
}

/** 装一个 manager（不经 registerMemory,配置合法性由 memory-vendor.test.ts 覆盖） */
function makeManager(warnings: string[]): MemoryVendorManager {
	return new MemoryVendorManager({ 供应商: "假供应商", 参数: {} }, (m) => void warnings.push(m));
}

function registerResident(pi: ExtensionAPI, home: string, getManager: () => MemoryVendorManager | undefined): void {
	registerResidentMemory(pi, { resolvePaoHome: () => home, getManager });
}

const exampleHit: MemoryHit[] = [
	{ 内容: "用户偏好简洁汇报", 记忆ID: "m-1", 相关度: 0.92, 来源: "假供应商" },
	{ 内容: "环境:git 走 127.0.0.1:7897", 记忆ID: "m-2", 相关度: 0.81, 来源: "假供应商" },
];

// ============================================================================
// 纯函数
// ============================================================================

describe("常驻索引纯函数", () => {
	it("渲染注入段:引导行＋原文", () => {
		const section = renderResidentSection("- 用户契约:推送须逐次批准");
		expect(section).toContain("以下为常驻记忆索引");
		expect(section).toContain("- 用户契约:推送须逐次批准");
	});

	it("超长截断标注(码点计):2000 字上限,标注原文长度,催精简不静默丢尾", () => {
		const lastSentence = "尾部这句会被截掉";
		const longText = `${"记".repeat(RESIDENT_MEMORY_LIMIT)}${lastSentence}`;
		const section = renderResidentSection(longText);
		expect(section).toContain(
			`注入截断:常驻索引 ${RESIDENT_MEMORY_LIMIT + Array.from(lastSentence).length} 字超 ${RESIDENT_MEMORY_LIMIT} 上限`,
		);
		expect(section).toContain("请提醒用户精简");
		expect(section).not.toContain(lastSentence);
		expect(Array.from(section).length).toBeLessThan(RESIDENT_MEMORY_LIMIT + 300);
	});

	it("常驻索引超 30 行按最短标识修剪:留前 30 行＋一行指针,详情留 L2", () => {
		const originalText = Array.from({ length: 34 }, (_, i) => `- 事实${i + 1}:触发词${i + 1}`).join("\n");
		const { text, trimmedLineCount } = pruneResidentIndex(originalText);
		expect(trimmedLineCount).toBe(4);
		expect(text.split("\n")).toHaveLength(RESIDENT_INDEX_LINE_LIMIT + 1);
		expect(text).toContain("- 事实30:触发词30");
		expect(text).not.toContain("事实31");
		expect(text).toContain("另有 4 行未常驻");
		expect(text).toContain(RESIDENT_MEMORY_RELATIVE_PATH); // 指针指向 L2 全量文件
	});

	it("常驻索引不超上限:零行为,原文逐字节不变", () => {
		const originalText = Array.from({ length: RESIDENT_INDEX_LINE_LIMIT }, (_, i) => `- 事实${i + 1}`).join("\n");
		const { text, trimmedLineCount } = pruneResidentIndex(originalText);
		expect(trimmedLineCount).toBe(0);
		expect(text).toBe(originalText);
	});

	it("渲染侧:修剪后带修剪注（被剪能看见,不静默丢尾）", () => {
		const originalText = Array.from({ length: 33 }, (_, i) => `- 事实${i + 1}`).join("\n");
		const section = renderResidentSection(originalText);
		expect(section).toContain("另有 3 行未常驻");
		expect(section).toContain(`[已修剪:常驻索引超 ${RESIDENT_INDEX_LINE_LIMIT} 行`);
	});

	it("loadResidentMemory:文件在→渲染注入段;文件缺→首建模板并注入模板本身", () => {
		const home = tempHome({ 常驻: "- 偏好:夜里自动跑,白天只汇报" });
		expect(loadResidentMemory(home)).toContain("夜里自动跑,白天只汇报");
		const fresh = tempHome();
		const section = loadResidentMemory(fresh);
		expect(section).toContain("任务状态不入");
		expect(readFileSync(residentMemoryPath(fresh), "utf8")).toBe(RESIDENT_TEMPLATE);
	});
});

describe("检索词与交接封顶纯函数", () => {
	it("recallSeed:去空白＋前 200 字封顶(码点计)", () => {
		expect(recallSeed("  你好世界  ")).toBe("你好世界");
		const longPrompt = "查".repeat(500);
		expect(Array.from(recallSeed(longPrompt))).toHaveLength(200);
	});

	it("boundHandoff:短摘要带时间戳前缀;超 4000 字截断并标注原文长度", () => {
		const short = boundHandoff("未结事实:三仓待推");
		expect(short).toContain("[压缩交接 ");
		expect(short).toContain("未结事实:三仓待推");
		const long = boundHandoff("事".repeat(4500));
		expect(long).toContain("已截断:原文 4500 字超 4000 上限");
		expect(Array.from(long).length).toBeLessThan(4600);
	});
});

describe("记忆供应商配置开关:自动召回/自动交接", () => {
	it("布尔合法解析;缺省不带字段;非布尔报错指明字段", () => {
		const dir = tempDir();
		const file = join(dir, "记忆供应商.json");
		writeFileSync(file, JSON.stringify({ 供应商: "mnemosyne", 自动召回: true, 自动交接: false }), "utf8");
		expect(loadMemoryVendorConfig(file)).toEqual({
			供应商: "mnemosyne",
			参数: {},
			自动召回: true,
			自动交接: false,
		});
		const file2 = join(tempDir(), "记忆供应商.json");
		writeFileSync(file2, JSON.stringify({ 供应商: "mnemosyne" }), "utf8");
		expect(loadMemoryVendorConfig(file2)).toEqual({ 供应商: "mnemosyne", 参数: {} });
		const file3 = join(tempDir(), "记忆供应商.json");
		writeFileSync(file3, JSON.stringify({ 供应商: "mnemosyne", 自动召回: "true" }), "utf8");
		expect(() => loadMemoryVendorConfig(file3)).toThrow(/「自动召回」应为布尔值/);
	});
});

// ============================================================================
// before_agent_start:常驻索引＋自动召回
// ============================================================================

describe("每轮注入(before_agent_start)", () => {
	it("按当前投影身份去重：同 ID 再召回不重复，上下文已经不含时可重新补充", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const first = await fireTurnWithContext(captured, "第一轮", testContext());
		expect(first.message?.content).toContain("用户偏好简洁汇报");
		const visibleRecall = {
			role: "custom",
			customType: AUTO_RECALL_SECTION,
			content: String(first.message?.content),
			details: first.message?.details,
		};
		const second = await fireTurnWithContext(captured, "第二轮", testContext([visibleRecall]));
		expect(second.message).toBeUndefined();
		const third = await fireTurnWithContext(captured, "压缩后的第三轮", testContext([]));
		expect(third.message?.content).toContain("用户偏好简洁汇报");
		expect(sessionMemory(captured.pi).injected).toHaveLength(4); // 两轮各 2 条；未建永久已见
	});
	it("召回期间会话关闭，迟到结果不得进入新会话", async () => {
		currentFake = fakeVendor();
		let release!: (hits: MemoryHit[]) => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = new Promise<MemoryHit[]>((resolve) => {
			release = resolve;
		});
		currentFake.vendor.recall = async () => {
			entered();
			return pending;
		};
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		const manager = makeManager([]);
		registerResident(captured.pi, home, () => manager);
		const turn = fireTurn(captured, "旧会话请求");
		await started;
		for (const handler of captured.handlers.get("session_shutdown") ?? []) await handler({} as never, {});
		release(exampleHit);
		expect((await turn)[AUTO_RECALL_SECTION]).toBeUndefined();
		expect(sessionMemory(captured.pi).injected).toHaveLength(0);
	});
	it("宿主 cwd 获准不能代替另一个会话项目的外发许可", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const event = { prompt: "不应外发", systemPromptOptions: { sections: {} } };
		await captured.handlers.get("before_agent_start")?.[0](event as never, { cwd: join(home, "未授权项目") });
		expect(currentFake.calls.召回).toHaveLength(0);
	});
	it("零行为硬约束:开关全缺省时只有常驻索引段,不碰供应商", async () => {
		currentFake = fakeVendor();
		const home = tempHome({ 记忆供应商: { 供应商: "假供应商" }, 常驻: "- 事实A" });
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const sections = await fireTurn(captured, "继续干活");
		expect(Object.keys(sections)).toEqual([RESIDENT_MEMORY_SECTION]);
		expect(sections[RESIDENT_MEMORY_SECTION]).toContain("- 事实A");
		expect(currentFake.calls.召回).toHaveLength(0);
	});

	it("文件缺失首建模板并注入模板;第二次轮不再重复写文件", async () => {
		currentFake = fakeVendor();
		const home = tempHome();
		const captured = capturePi();
		registerResident(captured.pi, home, () => undefined);
		const sections = await fireTurn(captured, "你好");
		expect(sections[RESIDENT_MEMORY_SECTION]).toContain("任务状态不入");
		expect(existsSync(residentMemoryPath(home))).toBe(true);
		await fireTurn(captured, "再来一轮");
		expect(readFileSync(residentMemoryPath(home), "utf8")).toBe(RESIDENT_TEMPLATE);
	});

	it("自动召回开:top3 命中带防污染标注注入,检索词=本轮输入,上限=3", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
			常驻: "- 事实A",
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const sections = await fireTurn(captured, "用户要我汇报什么风格");
		expect(sections[AUTO_RECALL_SECTION]).toContain("非用户输入");
		expect(sections[AUTO_RECALL_SECTION]).toContain("1. 用户偏好简洁汇报");
		expect(sections[AUTO_RECALL_SECTION]).toContain("记忆ID m-1");
		expect(currentFake.calls.召回).toEqual([{ 检索词: "用户要我汇报什么风格", 上限: AUTO_RECALL_TOP }]);
	});

	it("自动召回成功只构建一次会话投影", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const projectionCalls = { count: 0 };
		await fireTurnWithContext(captured, "复用投影", testContext([], "test", projectionCalls));
		expect(projectionCalls.count).toBe(1);
	});

	it("前缀缓存:检索词逐轮变化,静态段逐字节不变——召回只追加消息", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
			常驻: "- 事实A",
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		// 静态前缀快照:段名、顺序、内容全量(剔除消息层召回)——逐轮相等＝上游前缀缓存可命中
		const staticSnapshot = (sections: Record<string, string>) =>
			JSON.stringify(Object.entries(sections).filter(([sectionName]) => sectionName !== AUTO_RECALL_SECTION));
		const round1 = await fireTurn(captured, "第一轮的检索词");
		const round2 = await fireTurn(captured, "第二轮完全不同的检索词，含标点与更长尾巴");
		const round3 = await fireTurn(captured, "第三轮");
		expect(staticSnapshot(round2)).toBe(staticSnapshot(round1));
		expect(staticSnapshot(round3)).toBe(staticSnapshot(round1));
		// 检索词逐轮变化且召回真的发生(排除「其实没跑所以当然不变」)
		expect(currentFake.calls.召回.map((call) => call.检索词)).toEqual([
			"第一轮的检索词",
			"第二轮完全不同的检索词，含标点与更长尾巴",
			"第三轮",
		]);
		// 召回内容只出现在消息层,静态段里没有它
		expect(round1[RESIDENT_MEMORY_SECTION]).not.toContain("用户偏好简洁汇报");
		expect(round1[AUTO_RECALL_SECTION]).toContain("用户偏好简洁汇报");
	});

	it("无命中不注入(降噪;手动召回工具有完整语义),供应商确实被查", async () => {
		currentFake = fakeVendor({ hits: [] });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const sections = await fireTurn(captured, "查无相关的输入");
		expect(sections[AUTO_RECALL_SECTION]).toBeUndefined();
		expect(currentFake.calls.召回).toHaveLength(1);
	});

	it("空输入(如纯图片轮)没检索词:不打供应商,也不算降级", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const sections = await fireTurn(captured, "   ");
		expect(sections[AUTO_RECALL_SECTION]).toBeUndefined();
		expect(currentFake.calls.召回).toHaveLength(0);
	});

	it("供应商未启用:首轮一次性如实标注,后续轮静默", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({ 记忆供应商: { 供应商: "假供应商", 自动召回: true } });
		const captured = capturePi();
		registerResident(captured.pi, home, () => undefined);
		const first = await fireTurn(captured, "第一轮");
		expect(first[AUTO_RECALL_SECTION]).toContain("本会话不可用");
		expect(first[AUTO_RECALL_SECTION]).toContain("未启用");
		const second = await fireTurn(captured, "第二轮");
		expect(second[AUTO_RECALL_SECTION]).toBeUndefined();
	});

	it("外发许可未覆盖当前项目:不查供应商,首轮一次性标注,后续静默", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const first = await fireTurn(captured, "第一轮");
		expect(first[AUTO_RECALL_SECTION]).toContain("外发许可未覆盖");
		expect(currentFake.calls.召回).toHaveLength(0);
		const second = await fireTurn(captured, "第二轮");
		expect(second[AUTO_RECALL_SECTION]).toBeUndefined();
	});

	it("供应商启动失败降级:首轮标注带降级原因,后续轮静默", async () => {
		currentFake = fakeVendor({ 启动失败: "端口被占" });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		const warnings: string[] = [];
		registerResident(captured.pi, home, () => makeManager(warnings));
		const first = await fireTurn(captured, "第一轮");
		expect(first[AUTO_RECALL_SECTION]).toContain("启动失败");
		expect(first[AUTO_RECALL_SECTION]).toContain("端口被占");
		const second = await fireTurn(captured, "第二轮");
		expect(second[AUTO_RECALL_SECTION]).toBeUndefined();
	});

	it("召回抛错:首轮一次性标注失败,不影响常驻索引段", async () => {
		currentFake = fakeVendor({ 召回抛错: "网络断" });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
			常驻: "- 事实A",
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const first = await fireTurn(captured, "第一轮");
		expect(first[AUTO_RECALL_SECTION]).toContain("自动召回失败");
		expect(first[RESIDENT_MEMORY_SECTION]).toContain("- 事实A");
	});
	it("召回抛错后仍读取本轮投影供可见消息过滤", async () => {
		currentFake = fakeVendor({ 召回抛错: "网络断" });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const projectionCalls = { count: 0 };
		const context = testContext([], "test", projectionCalls);
		const turn = await fireTurnWithContext(captured, "失败后仍有纠正", context);
		expect(turn.message?.content).toContain("自动召回失败");
		expect(projectionCalls.count).toBe(1);
	});
	it("本轮召回与常驻索引同内容时只留常驻正文，不重复追加", async () => {
		currentFake = fakeVendor({ hits: [{ 内容: "用户偏好简洁汇报", 记忆ID: "resident-1" }] });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
			常驻: "- 用户偏好简洁汇报",
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const turn = await fireTurnWithContext(captured, "汇报风格", testContext());
		expect(turn.sections[RESIDENT_MEMORY_SECTION]).toContain("用户偏好简洁汇报");
		expect(turn.message).toBeUndefined();
		expect(sessionMemory(captured.pi).injected).toEqual([]);
	});
});

// ============================================================================
// session_compact:压缩交接
// ============================================================================

describe("压缩交接(session_compact)", () => {
	it("旧自动交接开关开启也不能把任务摘要写入共享事实库", async () => {
		currentFake = fakeVendor();
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动交接: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		await fireCompact(captured, "未结:三仓待推;B 线收尾中");
		expect(currentFake.calls.写入).toHaveLength(0);
		expect(currentFake.calls.启动).toBe(0);
	});

	it("开关缺省关:压缩发生也不写供应商(零行为硬约束)", async () => {
		currentFake = fakeVendor();
		const home = tempHome({ 记忆供应商: { 供应商: "假供应商" } });
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		await fireCompact(captured, "未结:三仓待推");
		expect(currentFake.calls.写入).toHaveLength(0);
	});

	it("自动召回开但自动交接关:两开关互不串", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		await fireCompact(captured, "未结:三仓待推");
		expect(currentFake.calls.写入).toHaveLength(0);
	});

	it("压缩交接不外发，也不需要供应商许可", async () => {
		currentFake = fakeVendor();
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动交接: true },
			外发项目: [],
		});
		const captured = capturePi();
		const warnings: string[] = [];
		registerResidentMemory(captured.pi, {
			resolvePaoHome: () => home,
			getManager: () => makeManager([]),
			onWarn: (m) => void warnings.push(m),
		});
		await fireCompact(captured, "未结:三仓待推");
		await fireCompact(captured, "又压缩一次");
		expect(currentFake.calls.写入).toHaveLength(0);
		expect(warnings).toHaveLength(0);
		expect(currentFake.calls.启动).toBe(0);
	});

	it("供应商启动失败:静默不写不崩(压缩本身已完成,交接是纯增益)", async () => {
		currentFake = fakeVendor({ 启动失败: "端口被占" });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动交接: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		const warnings: string[] = [];
		registerResidentMemory(captured.pi, {
			resolvePaoHome: () => home,
			getManager: () => makeManager(warnings),
			onWarn: (m) => void warnings.push(m),
		});
		await fireCompact(captured, "未结:三仓待推");
		expect(currentFake.calls.写入).toHaveLength(0);
		expect(warnings).toHaveLength(0);
		expect(currentFake.calls.启动).toBe(0);
	});
});

// ============================================================================
// 接线:paoExtension 端到端(memory→resident 共享管理器闭包)＋角色门控
// ============================================================================

describe("接线与角色门控", () => {
	it("V16：真实会话投影压缩后过滤旧召回，保留新事实和原始历史", async () => {
		const old = { 内容: "旧目录是甲", 记忆ID: "old" };
		const current = { 内容: "目录是乙", 记忆ID: "new" };
		currentFake = fakeVendor({ hits: [old, current] });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));

		const session = SessionManager.inMemory(process.cwd(), { id: "v16-real-projection" });
		const state = sessionMemory(captured.pi);
		state.record([old, current], "假供应商");
		state.exclude(state.injected[0], current.内容);
		const recallEntryId = session.appendCustomMessageEntry(
			AUTO_RECALL_SECTION,
			`[pao 自动召回]\n1. ${old.内容}\n2. ${current.内容}`,
			false,
			{ hits: [old, current], vendor: "假供应商" },
		);
		session.appendMessage({ role: "user", content: "后续压缩任务", timestamp: Date.now() });
		session.appendCompaction("保留新事实来源与纠正状态", recallEntryId, 100);
		expect(session.buildSessionProjection().messages.some((message) => message.role === "compactionSummary")).toBe(
			true,
		);

		const ctx = { ...testContext(), sessionManager: session };
		const filtered = await fireContext(captured, session.buildSessionProjection().messages, ctx);
		expect(filtered.some((message) => (message as { content?: unknown }).content === "旧目录是甲")).toBe(false);
		const custom = filtered.find(
			(message) =>
				(message as { role?: unknown; customType?: unknown }).role === "custom" &&
				(message as { customType?: unknown }).customType === AUTO_RECALL_SECTION,
		);
		expect((custom as { content?: unknown } | undefined)?.content).toContain(current.内容);
		expect(session.getEntries().some((entry) => entry.type === "custom_message")).toBe(true);

		const row = {
			role: "custom",
			customType: AUTO_RECALL_SECTION,
			content: `[pao 自动召回]\n1. ${old.内容}\n2. ${current.内容}`,
			display: false,
			details: { hits: [old, current], vendor: "假供应商" },
			timestamp: Date.now(),
		};
		await fireContext(captured, [row], ctx);
		expect(row.content).toContain(old.内容);
	});
	it("V16：纠正后过滤模型副本不删历史；压缩与恢复后旧事实仍排除，纠正提示不重复", async () => {
		const old = { 内容: "旧目录是甲", 记忆ID: "old" };
		const current = { 内容: "目录是乙", 记忆ID: "new" };
		currentFake = fakeVendor({ hits: [old, current] });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
		});
		const captured = capturePi();
		registerResident(captured.pi, home, () => makeManager([]));
		const first = await fireTurnWithContext(captured, "改哪个目录", testContext());
		expect(first.message?.content).toContain(old.内容);

		// 模拟历史中原样保存的自动召回消息；纠正不能删除这条历史。
		const history = {
			role: "custom",
			customType: AUTO_RECALL_SECTION,
			content: String(first.message?.content),
			details: first.message?.details,
		};
		sessionMemory(captured.pi).exclude(sessionMemory(captured.pi).injected[0], current.内容);
		const filtered = await fireContext(captured, [history], testContext([history]));
		expect(filtered).toHaveLength(1);
		expect((filtered[0] as { content: string }).content).not.toContain(old.内容);
		expect((filtered[0] as { content: string }).content).toContain(current.内容);
		expect(history.content).toContain(old.内容);

		// 纠正提示进入消息；下一请求已包含它时不重复。
		const correctionTurn = await fireTurnWithContext(captured, "继续", testContext([history]));
		expect(correctionTurn.message?.content).toContain("用户纠正为：目录是乙");
		const correctionMessage = {
			role: "custom",
			customType: AUTO_RECALL_SECTION,
			content: String(correctionTurn.message?.content),
			details: correctionTurn.message?.details,
		};
		const noDuplicate = await fireTurnWithContext(captured, "继续", testContext([history, correctionMessage]));
		expect(noDuplicate.message).toBeUndefined();

		// 压缩后旧召回与提示都不在可见上下文时，提示可重建，但旧事实仍不会再召回。
		const afterCompact = await fireTurnWithContext(captured, "压缩后继续", testContext([]));
		expect(afterCompact.message?.content).toContain("用户纠正为：目录是乙");
		const afterCompactRecall = String(afterCompact.message?.content).split("\n\n").slice(1).join("\n\n");
		expect(afterCompactRecall).not.toContain(old.内容);

		// 新会话恢复从不继承旧会话纠正。
		const restored = new SessionMemory();
		restored.restore(JSON.parse(JSON.stringify(sessionMemory(captured.pi).snapshot())));
		expect(restored.record([old], "假供应商")).toEqual([]);
		const independent = new SessionMemory();
		expect(independent.record([old], "假供应商")).toHaveLength(1);
	});
	it("主控:registerMemory 建的管理器被 resident 复用——召回段与常驻段同轮注入", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
			常驻: "- 用户偏好:夜里自动跑",
		});
		const captured = capturePi();
		const { default: paoExtension } = await import("../../src/pao/index.ts");
		paoExtension(captured.pi, { resolvePaoHome: () => home });
		const sections = await fireTurn(captured, "汇报风格是什么");
		expect(sections[RESIDENT_MEMORY_SECTION]).toContain("夜里自动跑");
		expect(sections[AUTO_RECALL_SECTION]).toContain("用户偏好简洁汇报");
		// 共享同一实例:整个接线只拉起一次供应商
		expect(currentFake.calls.启动).toBe(1);
	});

	it("worker:resident 不注册——无注入段,也不首建模板文件", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
			常驻: "- 用户偏好:夜里自动跑",
		});
		vi.stubEnv(PAO_ROLE_ENV, "worker");
		const captured = capturePi();
		const { default: paoExtension } = await import("../../src/pao/index.ts");
		paoExtension(captured.pi, { resolvePaoHome: () => home });
		const sections = await fireTurn(captured, "干活");
		expect(sections[RESIDENT_MEMORY_SECTION]).toBeUndefined();
		expect(sections[AUTO_RECALL_SECTION]).toBeUndefined();
		expect(currentFake.calls.召回).toHaveLength(0);
		const freshHome = tempHome({ 记忆供应商: { 供应商: "假供应商", 自动召回: true } });
		const captured2 = capturePi();
		paoExtension(captured2.pi, { resolvePaoHome: () => freshHome });
		await fireTurn(captured2, "干活");
		expect(existsSync(residentMemoryPath(freshHome))).toBe(false);
	});

	it("部长:resident 不注册(记忆三工具保留,§18.1 注入面是主控门面)", async () => {
		currentFake = fakeVendor({ hits: exampleHit });
		const home = tempHome({
			记忆供应商: { 供应商: "假供应商", 自动召回: true },
			外发项目: [currentProject ?? "未知"],
			常驻: "- 事实A",
		});
		vi.stubEnv(PAO_ROLE_ENV, "部长");
		const captured = capturePi();
		const { default: paoExtension } = await import("../../src/pao/index.ts");
		paoExtension(captured.pi, { resolvePaoHome: () => home });
		const sections = await fireTurn(captured, "审卡");
		expect(sections[RESIDENT_MEMORY_SECTION]).toBeUndefined();
		expect(sections[AUTO_RECALL_SECTION]).toBeUndefined();
		expect(currentFake.calls.召回).toHaveLength(0);
	});
});
