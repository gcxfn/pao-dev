import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { serializeCard } from "../../src/pao/cards/cardfile.ts";
import { addPaoSubcommand } from "../../src/pao/command-router.ts";
import {
	readDesktopMinister,
	readDesktopWorkerActivity,
	registerDesktopOwner,
	runDesktopFlowCommand,
	runDesktopMemoryCommand,
} from "../../src/pao/desktop/index.ts";
import {
	parseLiveJsonl,
	readDesktopExecution,
	readDesktopPending,
	readDesktopProject,
	readDesktopSessionIncrement,
	readDesktopWorkflowMinister,
} from "../../src/pao/desktop/read-model.ts";
import { isStaleEvent } from "../../src/pao/desktop/view-envelope.ts";
import { readDesktopDiff, readDesktopFlows } from "../../src/pao/desktop/workflow.ts";
import { registerMemoryCommand, sessionMemory } from "../../src/pao/memory/session.ts";
import { createWorkerSessionBridge } from "../../src/pao/worker/session-bridge.ts";
import { bindMinister, controlPath, readControl, startControl } from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pao-桌面 空格-"));
	const dir = join(root, ".pao", "卡");
	mkdirSync(dir, { recursive: true });
	const card = join(dir, "卡0001-测试.md");
	writeFileSync(
		card,
		serializeCard(
			{
				goal: "测试",
				dept: "工程",
				acceptance: "测试证据",
				attempt: 1,
				created: "2026-10-04 10:00",
				status: "in_progress",
			},
			"待验收",
		),
	);
	const bridge = createWorkerSessionBridge({ 项目根: root, 卡路径: card, 尝试: 1, 执行标识: "execution" });
	const session = join(bridge.会话目录, "time_execution.jsonl");
	return { root, card, bridge, session };
}
describe("桌面读投影（本地文件集成，不涉及模型）", () => {
	it("读取同一张卡、执行身份和当前尝试，坏卡不伪装空，零写入", () => {
		const f = fixture();
		writeFileSync(join(f.root, ".pao", "卡", "卡0002-坏.md"), "坏卡");
		const before = readFileSync(f.card, "utf8");
		const snapshot = readDesktopProject(f.root, "session-a");
		expect(snapshot.cards[0].frontmatter.goal).toBe("测试");
		expect(snapshot.execution[0].当前尝试).toBe(true);
		expect(snapshot.session).toBe("session-a");
		expect(snapshot.issues[0].说明).toContain("frontmatter");
		expect(snapshot.queue).toContain("in_progress");
		expect(readFileSync(f.card, "utf8")).toBe(before);
	});
	it("视图信封（S6-K4）：publishedAt=读取时间；内容未变 revision 去重；切会话换代际；卡变化 revision 跟随", () => {
		const f = fixture();
		const first = readDesktopProject(f.root, "session-a");
		const second = readDesktopProject(f.root, "session-a");
		expect(first.envelope.version).toBe(1);
		expect(first.envelope.publishedAt).toBe(first.读取时间);
		// 读取时间每次重读都变，但内容未变 → 指纹相同（消费方据此去重不重渲染）
		expect(second.envelope.revision).toBe(first.envelope.revision);
		expect(second.envelope.sessionGeneration).toBe(first.envelope.sessionGeneration);
		// 切会话＝换代际；旧会话代际的事件按拒旧事件判定拒收
		const switched = readDesktopProject(f.root, "session-b");
		expect(switched.envelope.sessionGeneration).not.toBe(first.envelope.sessionGeneration);
		expect(isStaleEvent(first.envelope.sessionGeneration, switched.envelope.sessionGeneration)).toBe(true);
		// 卡状态变化 → 内容指纹变化；作用域未变 → 代际不变（版本是视图信息，不写卡）
		const before = readFileSync(f.card, "utf8");
		writeFileSync(
			f.card,
			serializeCard(
				{
					goal: "测试",
					dept: "工程",
					acceptance: "测试证据",
					attempt: 1,
					created: "2026-10-04 10:00",
					status: "delivered",
				},
				"待验收",
			),
			"utf8",
		);
		const third = readDesktopProject(f.root, "session-a");
		expect(third.envelope.revision).not.toBe(first.envelope.revision);
		expect(third.envelope.sessionGeneration).toBe(first.envelope.sessionGeneration);
		writeFileSync(f.card, before, "utf8");
	});
	it("中文字节增量保留半行，后续补齐只读新行；隐藏推理和凭证不显示", () => {
		const f = fixture();
		const first = JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				provider: "测试供应商",
				model: "测试模型",
				usage: { totalTokens: 12 },
				content: [
					{ type: "thinking", thinking: "隐藏" },
					{ type: "text", text: "中文 api_key=secret-value" },
				],
			},
		});
		const second = JSON.stringify({ type: "message", message: { role: "user", content: "第二行" } });
		writeFileSync(f.session, `${first}\n${second.slice(0, 10)}`);
		const a = readDesktopExecution(f.root, "s", "execution");
		expect(a.下次偏移).toBe(Buffer.byteLength(`${first}\n`));
		expect(a.末行未完).toBe(true);
		expect(a.本段统计).toEqual({ 响应: 1, 工具: 0, token: 12, 未知用量: 0 });
		expect(a.行[0].模型).toBe("测试供应商/测试模型");
		expect(JSON.stringify(a)).not.toContain("隐藏");
		expect(JSON.stringify(a)).not.toContain("secret-value");
		appendFileSync(f.session, `${second.slice(10)}\n`);
		const b = readDesktopExecution(f.root, "s", "execution", a.下次偏移);
		expect(b.行).toHaveLength(1);
		expect(JSON.stringify(b)).toContain("第二行");
		expect(() => readDesktopExecution(f.root, "s", "execution", 3)).toThrow("边界");
		expect(() => readDesktopExecution(f.root, "s", "execution", b.下次偏移 + 1)).toThrow("截短");
	});
	it("用量归一化与内核同源：压缩与分支摘要的用量也计入，未知用量事件另计（审查第 16 项）", () => {
		const f = fixture();
		const usage = (n: number) => ({
			input: n,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: n,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const lines = [
			{ id: "m1", type: "message", message: { role: "assistant", content: [], usage: usage(100) } },
			{ id: "c1", type: "compaction", usage: usage(40) },
			{ id: "b1", type: "branch_summary", usage: usage(30) },
			{ id: "t1", type: "message", message: { role: "toolResult", content: [], usage: usage(5) } },
			{ id: "u1", type: "custom", customType: "pao-native-usage-status", data: { status: "请求未返回用量" } },
		];
		writeFileSync(f.session, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
		const whole = readDesktopExecution(f.root, "s", "execution");
		// 旧实现只看 message/assistant 与 usage 两类：这里会只报 100
		expect(whole.本段统计).toEqual({ 响应: 1, 工具: 0, token: 175, 未知用量: 1 });

		// 分页增量不重复计数：先读半行，再从偏移续读，两段相加与一次读完一致
		writeFileSync(f.session, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
		const head = readDesktopSessionIncrement(f.session, 0);
		const rest = readDesktopSessionIncrement(f.session, head.下次偏移);
		const summed = {
			响应: head.本段统计.响应 + rest.本段统计.响应,
			工具: head.本段统计.工具 + rest.本段统计.工具,
			token: head.本段统计.token + rest.本段统计.token,
			未知用量: head.本段统计.未知用量 + rest.本段统计.未知用量,
		};
		expect(summed.token).toBe(175);
		expect(summed.未知用量).toBe(1);
	});
	it("完整坏JSON、重复会话映射、任意执行ID均显式拒绝", () => {
		expect(() => parseLiveJsonl("{bad}\n")).toThrow();
		expect(parseLiveJsonl("{bad}").pending).toBe(true);
		const f = fixture();
		writeFileSync(f.session, "{}\n");
		writeFileSync(join(f.bridge.会话目录, "other_execution.jsonl"), "{}\n");
		expect(readDesktopProject(f.root, "s").issues[0].说明).toContain("多份会话");
		expect(() => readDesktopExecution(f.root, "s", "../../secret")).toThrow("未找到");
	});
	it("增量读取只认这一份执行（阶段 7 性能候选 2）：别的映射坏掉不影响它，身份检查逐条仍在", () => {
		const f = fixture();
		writeFileSync(
			f.session,
			`${JSON.stringify({ type: "message", message: { role: "user", content: "第一行" } })}\n`,
		);
		// 另一份映射是坏的：整项目重读会把它记进问题清单，增量读取不该去读它。
		writeFileSync(join(f.root, ".pao", "执行映射", "其他执行.jsonl"), "{坏}\n");
		expect(readDesktopProject(f.root, "s").issues.some((issue) => issue.路径.includes("其他执行"))).toBe(true);
		const increment = readDesktopExecution(f.root, "s", "execution");
		expect(increment.行).toHaveLength(1);
		expect(JSON.stringify(increment)).toContain("第一行");
		// 身份检查不省：项目根不符、卡越界、卡不存在、会话多份都拒绝。
		const mapping = f.bridge.映射路径;
		const base = JSON.parse(readFileSync(mapping, "utf8").trim()) as Record<string, unknown>;
		const rewrite = (patch: Record<string, unknown>) =>
			writeFileSync(mapping, `${JSON.stringify({ ...base, ...patch })}\n`);
		const outside = mkdtempSync(join(tmpdir(), "pao-越界卡-"));
		writeFileSync(join(outside, "越界卡.md"), "x");
		rewrite({ 项目根: join(f.root, "别处") });
		expect(() => readDesktopExecution(f.root, "s", "execution")).toThrow("身份或字段不完整");
		rewrite({ 卡路径: join(outside, "越界卡.md") });
		expect(() => readDesktopExecution(f.root, "s", "execution")).toThrow("引用其他项目的卡");
		rewrite({ 卡路径: join(f.root, ".pao", "卡", "不存在.md") });
		expect(() => readDesktopExecution(f.root, "s", "execution")).toThrow("卡不存在或无法读取");
		rewrite({});
		writeFileSync(join(f.bridge.会话目录, "another_execution.jsonl"), "{}\n");
		expect(() => readDesktopExecution(f.root, "s", "execution")).toThrow("多份会话");
	});
	it("以下划线开头的会话文件也能结束索引扫描", () => {
		const f = fixture();
		writeFileSync(f.session, "{}\n");
		writeFileSync(join(f.bridge.会话目录, "_execution.jsonl"), "{}\n");
		const snapshot = readDesktopProject(f.root, "s");
		expect(snapshot.issues.some((issue) => issue.说明.includes("多份会话"))).toBe(true);
	});
	it("从项目清单跨项目聚合，同号卡不合并；失效项目列错误", () => {
		const a = fixture();
		const b = fixture();
		const home = mkdtempSync(join(tmpdir(), "pao-桌面清单-"));
		writeFileSync(
			join(home, "项目清单.md"),
			`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| 乙 | ${b.root} | 今天 | 今天 |\n| 坏 | ${join(home, "不存在")} | 今天 | 今天 |\n`,
		);
		const snapshot = readDesktopPending(home, a.root);
		expect(snapshot.projects).toHaveLength(2);
		expect(snapshot.issues).toHaveLength(1);
		expect(snapshot.projects[0].cards[0].path).not.toBe(snapshot.projects[1].cards[0].path);
	});
});

it("工作看板按项目、节点与当前轮次读取真实部长会话，拒绝旧轮次和其他项目", async () => {
	const f = fixture();
	const recipe = parseRecipe(
		`---\n${stringify({ 版本: 2, 名字: "会话读取", 参数: [], 节点: [{ 名字: "审查", 部门: "工程", 目标: "查看", 验收: "证据" }] })}---\n`,
		join(f.root, "会话读取.md"),
	);
	const options = { cardsDir: join(f.root, ".pao", "卡"), ownerSessionId: "owner" };
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "审查", "minister-test");
	const flow = readControl(recipe, options);
	const directory = join(f.root, ".pao", "部长会话", flow.实例);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "20261018_minister-test.jsonl"),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "部长真实会话记录" }] },
		}) + "\n",
	);
	expect(readDesktopWorkflowMinister(f.root, flow.实例, "审查", 1).行[0].内容).toEqual([
		{ type: "text", text: "部长真实会话记录" },
	]);
	expect(() => readDesktopWorkflowMinister(f.root, flow.实例, "审查", 2)).toThrow("尚无可定位");
	expect(() => readDesktopWorkflowMinister(fixture().root, flow.实例, "审查", 1)).toThrow("唯一发现");
	writeFileSync(join(directory, "duplicate_minister-test.jsonl"), "");
	expect(() => readDesktopWorkflowMinister(f.root, flow.实例, "审查", 1)).toThrow("未唯一定位");
});

it("工作流正本显示人工门、轮次和历史；坏控制清单明确报错", async () => {
	const f = fixture();
	const recipe = parseRecipe(
		`---\n${stringify({ 版本: 2, 名字: "桌面流", 参数: [], 节点: [{ 名字: "审查", 部门: "工程", 目标: "查看", 验收: "证据", 人工确认: true }] })}---\n`,
		join(f.root, "桌面流.md"),
	);
	const options = { cardsDir: join(f.root, ".pao", "卡"), ownerSessionId: "original-owner" };
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "审查", "minister-real-id");
	const before = readFileSync(controlPath(recipe, options), "utf8");
	const snapshot = readDesktopFlows(f.root);
	expect(snapshot.问题).toEqual([]);
	expect(snapshot.工作流[0].控制.owner).toBe("original-owner");
	expect(snapshot.工作流[0].进度.节点[0].人工确认).toBe(true);
	expect(readFileSync(controlPath(recipe, options), "utf8")).toBe(before);
	const flow = readControl(recipe, options);
	flow.节点[0].轮次 = 0;
	writeFileSync(controlPath(recipe, options), `---\n${stringify(flow)}---\n`);
	expect(readDesktopFlows(f.root).问题[0].说明).toContain("节点控制字段损坏");
});

it("实例卡目录缺失（项目内）不炸读面；越出项目的卡目录仍报问题", async () => {
	const f = fixture();
	const recipe = parseRecipe(
		`---\n${stringify({ 版本: 2, 名字: "缺目录流", 参数: [], 节点: [{ 名字: "审查", 部门: "工程", 目标: "查看", 验收: "证据" }] })}---\n`,
		join(f.root, "缺目录流.md"),
	);
	const options = { cardsDir: join(f.root, ".pao", "不存在卡目录"), ownerSessionId: "enoent-owner" };
	await startControl(recipe, {}, options);
	// startControl 已保证卡目录存在；删掉模拟历史实例目录被清空的现场
	rmSync(options.cardsDir, { recursive: true, force: true });
	const snapshot = readDesktopFlows(f.root);
	expect(snapshot.问题.filter((issue) => issue.说明.includes("缺目录流"))).toEqual([]);
	expect(snapshot.工作流.map((entry) => entry.控制.工作流)).toContain("缺目录流");
	// 卡目录越出项目：词法校验仍按原口径报问题
	const flow = readControl(recipe, options);
	flow.卡目录 = join(tmpdir(), "pao-外部卡目录-fixture");
	writeFileSync(controlPath(recipe, options), `---\n${stringify(flow)}---\n`);
	const outside = readDesktopFlows(f.root);
	expect(outside.工作流.map((entry) => entry.控制.工作流)).not.toContain("缺目录流");
	expect(outside.问题.some((issue) => issue.说明.includes("越出项目"))).toBe(true);
});

it("真实 git diff 只读、包含实际改动与未跟踪路径；未提供启动基线时明确边界", async () => {
	const f = fixture();
	const git = (args: string[]) => execFileSync("git", args, { cwd: f.root, encoding: "utf8", windowsHide: true });
	git(["init", "-q"]);
	writeFileSync(join(f.root, "source.txt"), "before\n");
	git(["add", "source.txt"]);
	git(["-c", "user.name=PAO Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture"]);
	const head = git(["rev-parse", "HEAD"]).trim();
	writeFileSync(join(f.root, "source.txt"), "after\n");
	writeFileSync(join(f.root, "new.txt"), "untracked\n");
	const index = readFileSync(join(f.root, ".git", "index"));
	const diff = await readDesktopDiff(f.root, head);
	expect(diff.差异).toContain("+after");
	expect(diff.未跟踪).toContain("new.txt");
	expect(readFileSync(join(f.root, ".git", "index"))).toEqual(index);
	expect((await readDesktopDiff(f.root)).说明).toContain("不能据此证明");
	await expect(readDesktopDiff(f.root, "--output=bad")).rejects.toThrow("不是固定提交");
});

it("内核 owner 闭包隔离；旧记忆版本和切会话动作失效", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI;
	let id = "desktop-owner-test";
	const ctx = {
		cwd: "D:/one",
		sessionManager: { getSessionId: () => id },
		isIdle: () => true,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	registerDesktopOwner(pi);
	registerMemoryCommand(
		pi,
		() => undefined,
		() => "unused",
	);
	addPaoSubcommand(pi, { name: "runtime", label: "控制", description: "测试", run: vi.fn() });
	handlers.get("session_start")!({}, ctx);
	sessionMemory(pi).record([{ 内容: "来源甲", 记忆ID: "id-a" }], "测试");
	// 记忆版本口径与 runDesktopMemoryCommand 的守卫一致：sha256(JSON.stringify(snapshot))
	const revision = () =>
		createHash("sha256")
			.update(JSON.stringify(sessionMemory(pi).snapshot()))
			.digest("hex");
	const stale = revision();
	sessionMemory(pi).record([{ 内容: "来源乙", 记忆ID: "id-b" }], "测试");
	await expect(runDesktopMemoryCommand(id, ctx.cwd, "exclude 1", stale)).rejects.toThrow("来源已变化");
	await runDesktopMemoryCommand(id, ctx.cwd, "exclude 1", revision());
	expect(sessionMemory(pi).injected[0].排除).toBe(true);
	id = "desktop-other";
	handlers.get("session_start")!({}, ctx);
	expect(() => readDesktopMinister("desktop-owner-test", ctx.cwd, "x", 0)).toThrow("owner 不可用");
	handlers.get("session_shutdown")!({}, ctx);
});

it("桌面控制拒绝外项目路径、其他owner部长，确认后切会话或取消不落写", async () => {
	const f = fixture();
	const recipe = parseRecipe(
		`---\n${stringify({ 版本: 2, 名字: "边界流", 参数: [], 节点: [{ 名字: "审查", 部门: "工程", 目标: "查", 验收: "证据", 人工确认: true }] })}---\n`,
		join(f.root, "边界流.md"),
	);
	const options = { cardsDir: join(f.root, ".pao", "卡"), ownerSessionId: "boundary-owner" };
	await startControl(recipe, {}, options);
	await bindMinister(recipe, options, "审查", "other-minister");
	const flow = readControl(recipe, options);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, fn),
	} as unknown as ExtensionAPI;
	let id = "boundary-owner";
	let afterConfirm = () => {};
	const ctx = {
		cwd: f.root,
		sessionManager: { getSessionId: () => id },
		ui: {
			confirm: async () => {
				afterConfirm();
				return true;
			},
		},
		isIdle: () => true,
	} as unknown as ExtensionContext;
	registerDesktopOwner(pi);
	handlers.get("session_start")!({}, ctx);
	addPaoSubcommand(pi, { name: "runtime", label: "控制", description: "测试", run: vi.fn() });
	const written = vi.fn();
	addPaoSubcommand(pi, {
		name: "flow",
		label: "流",
		description: "测试",
		run: async (_pi, _args, commandCtx) => {
			await (commandCtx as ExtensionContext).ui.confirm("确认", "模拟人工等待");
			written();
		},
	});
	const params = {
		name: recipe.名字,
		cards_dir: options.cardsDir,
		instance: flow.实例,
		node: "审查",
		round: 1,
		action: "confirm",
	};
	await expect(
		runDesktopFlowCommand(id, f.root, {
			...params,
			cards_dir: fixture().bridge.会话目录,
			action: "resume",
			prev_owner: id,
		}),
	).rejects.toThrow("卡目录");
	afterConfirm = () => {
		id = "switched";
	};
	await expect(runDesktopFlowCommand("boundary-owner", f.root, params)).rejects.toThrow("owner 不可用");
	expect(written).not.toHaveBeenCalled();
	handlers.get("session_start")!({}, ctx);
	expect(() => readDesktopMinister(id, f.root, "other-minister", 0)).toThrow("另一 owner");
	id = "boundary-owner";
	handlers.get("session_start")!({}, ctx);
	const abort = new AbortController();
	afterConfirm = () => abort.abort(new Error("用户取消"));
	await expect(runDesktopFlowCommand(id, f.root, params, abort.signal)).rejects.toThrow("用户取消");
	expect(written).not.toHaveBeenCalled();
	handlers.get("session_shutdown")!({}, ctx);
});

it("跨进程控制消息内核终审：非owner确认、旧轮次、恢复原owner不符一律拒绝；合规请求带磁盘真值放行", async () => {
	const f = fixture();
	const recipe = parseRecipe(
		`---\n${stringify({ 版本: 2, 名字: "终审流", 参数: [], 节点: [{ 名字: "审查", 部门: "工程", 目标: "查", 验收: "证据", 人工确认: true }] })}---\n`,
		join(f.root, "终审流.md"),
	);
	const options = { cardsDir: join(f.root, ".pao", "卡"), ownerSessionId: "origin-owner" };
	await startControl(recipe, {}, options);
	const flow = readControl(recipe, options);
	const makeSession = (id: string) => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const pi = {
			on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, fn),
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: f.root,
			sessionManager: { getSessionId: () => id },
			ui: { confirm: async () => true },
			isIdle: () => true,
		} as unknown as ExtensionContext;
		registerDesktopOwner(pi);
		handlers.get("session_start")!({}, ctx);
		addPaoSubcommand(pi, { name: "runtime", label: "控制", description: "测试", run: vi.fn() });
		return pi;
	};
	const origin = makeSession("origin-owner");
	const _outsider = makeSession("final-owner");
	const base = { name: recipe.名字, cards_dir: options.cardsDir, instance: flow.实例, node: "审查" };
	// 非 owner 会话提交确认：trusted 终审拒绝，不进入命令执行。
	await expect(
		runDesktopFlowCommand("final-owner", f.root, { ...base, round: flow.节点[0]!.轮次, action: "confirm" }),
	).rejects.toThrow("请跳转原 owner 会话处理");
	// owner 会话但轮次过期（跨进程消息的请求关联在内核侧的最后一道）。
	await expect(
		runDesktopFlowCommand("origin-owner", f.root, { ...base, round: 999, action: "confirm" }),
	).rejects.toThrow("实例/卡目录/节点/轮次已变化，请刷新");
	// 恢复允许任何已注册会话发起，但原owner必须与磁盘现值一致。
	await expect(
		runDesktopFlowCommand("final-owner", f.root, {
			...base,
			round: flow.节点[0]!.轮次,
			action: "resume",
			prev_owner: "someone-else",
		}),
	).rejects.toThrow("原 owner 已变化，请刷新");
	// 合规请求：trusted 放行，磁盘真值原样进入 flow control 命令。
	const seen: string[] = [];
	addPaoSubcommand(origin, {
		name: "flow",
		label: "流",
		description: "测试",
		run: async (_pi, args) => {
			seen.push(args);
		},
	});
	await runDesktopFlowCommand("origin-owner", f.root, { ...base, round: flow.节点[0]!.轮次, action: "confirm" });
	expect(seen).toHaveLength(1);
	expect(JSON.parse(seen[0]!.slice("control ".length))).toEqual({
		name: recipe.名字,
		cards_dir: options.cardsDir,
		instance: flow.实例,
		node: "审查",
		round: flow.节点[0]!.轮次,
		prev_owner: "origin-owner",
		action: "confirm",
	});
});

it("桌面活性只读投影：当前尝试判定、阈值现读、无注入即无信号", () => {
	const f = fixture();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: f.root,
		sessionManager: { getSessionId: () => "desktop-activity-owner" },
	} as unknown as ExtensionContext;
	registerDesktopOwner(pi, {
		getWorkerActivity: () => [
			{
				pid: 11,
				card_no: "0001",
				command: "worker",
				登记时间: "2026-10-05T10:00:00.000Z",
				running: true,
				dept: "工程",
				dispatch_reason: null,
				card_path: f.card,
				attempt: 1,
				run_id: "execution",
				最近输出时间: "2026-10-05T10:05:00.000Z",
			},
			{
				pid: 12,
				card_no: "0001",
				command: "worker",
				登记时间: "2026-10-05T09:00:00.000Z",
				running: false,
				dept: "工程",
				dispatch_reason: null,
				card_path: f.card,
				attempt: 0,
				run_id: "old",
			},
		],
		getSilenceMinutes: () => 30,
	});
	handlers.get("session_start")!({}, ctx);
	const rows = readDesktopWorkerActivity(f.root);
	expect(rows).toHaveLength(2);
	expect(rows[0].会话).toBe("desktop-activity-owner");
	expect(rows[0].静默分钟).toBe(30);
	const snapshot = readDesktopProject(f.root, "session-a");
	expect(snapshot.liveness).toHaveLength(2);
	expect(snapshot.liveness[0].卡路径).toBe(snapshot.cards[0].path);
	expect(snapshot.liveness[0].当前尝试).toBe(true);
	expect(snapshot.liveness[1].当前尝试).toBe(false);
	expect(snapshot.liveness[1].运行中).toBe(false);
	// 未注入活性的 owner 不产生信号：缺省＝无信号，不拿卡时间兜底。
	const other = fixture();
	expect(readDesktopWorkerActivity(other.root)).toEqual([]);
	handlers.get("session_shutdown")!({}, ctx);
	expect(readDesktopWorkerActivity(f.root)).toEqual([]);
});
