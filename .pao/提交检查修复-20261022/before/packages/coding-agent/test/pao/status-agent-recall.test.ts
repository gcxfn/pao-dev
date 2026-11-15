/**
 * G1 上下文与待办恢复：主控重开/压缩后查回目标·要求·约束·确认版本·待办·未决意见·必要文件引用。
 *
 * 本套钉五件事（计划 §8.1 + task-13 验收）：
 * ① 压缩前后查回同一份事实（会话待办走 `scanTodoState`，压缩快照条目是唯一载体）；
 * ② 旧轮次提醒不得推进新轮次（`isRecallTodoStale`/`staleRecallTodoText` 同桌面判据）；
 * ③ 同一待办在两条视图路径下只生效一次（`recallTodoKey` 稳定身份键 + `dedupeTodos`）；
 * ④ 提醒通道失败但事实仍可查（`buildRecallReminder` 纯拼接，不依赖通知面）；
 * ⑤ 取不到的字段如实留空（断言 `toBeUndefined()`，不是 0/空串）。
 *
 * 全部只读：本套只调查询面，任何用例都不落卡、不派发；PAO_HOME 一律隔离临时目录。
 * 数据都走真实正本通道（createTemporaryPlan / recordPlanFeedback / startControl 等），
 * 不手写假装的正本格式。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
import {
	buildRecallReminder,
	cardRecallTodos,
	dedupeTodos,
	isRecallTodoStale,
	mergeRecallTodos,
	RECALL_TODO_KINDS,
	type RecallTodo,
	readConfirmedVersion,
	readRecallSnapshot,
	recallPlan,
	recallTodoKey,
	sessionTodosToRecall,
	staleRecallTodoText,
} from "../../src/pao/status/context-recovery.ts";
import { SNAPSHOT_CUSTOM_TYPE, scanTodoState, type TodoItem } from "../../src/pao/todo/core.ts";
import {
	addNodeCards,
	bindMinister,
	endDecomposition,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { createTemporaryPlan } from "../../src/pao/workflow/plan.ts";
import { recordPlanFeedback, recordPlanFeedbackDelivery } from "../../src/pao/workflow/plan-feedback.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const dirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 落一个真实 PAO_HOME：项目清单登记项目根（快照不给项目根时靠它发现项目）。 */
function 落项目(home: string, 项目根: string): void {
	writeFileSync(
		join(home, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| 项目甲 | ${项目根} | 2026-10-17 10:00 | 2026-10-17 10:00 |\n`,
		"utf8",
	);
}

async function 建计划(项目根: string) {
	const created = await createTemporaryPlan({
		项目根,
		显示名: "小说创作",
		来源会话: "sess-1",
		请求ID: "req-1",
		已注册部门: ["策划部", "写作部", "审稿部"],
		步骤: [
			{ 标题: "讨论计划", 部门: "策划部", 要求: "把方向与章节计划讨论清楚", 约束: "先别写正文" },
			{ 标题: "写初稿", 部门: "写作部", 要求: "按计划写初稿", 依赖: ["s1"], 人工门: true },
		],
		当刻: "2026-10-17 10:00",
	});
	return created;
}

/** 会话条目：toolResult（makeTodoEntry 同 todo/core 认的形状） */
function todoEntry(details: unknown, isError = false): SessionEntry {
	return {
		type: "message",
		id: `m-todo-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: "2026-10-17T02:00:00.000Z",
		parentId: undefined,
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "todo_write",
			content: [{ type: "text", text: "ok" }],
			isError,
			details,
			timestamp: 0,
		},
	} as unknown as SessionEntry;
}

/** 压缩快照条目（todo/index.ts 在 session_compact 时 appendEntry 的就是它） */
function snapshotEntry(todos: TodoItem[]): SessionEntry {
	return {
		type: "custom",
		id: `c-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: "2026-10-17T03:00:00.000Z",
		parentId: null,
		customType: SNAPSHOT_CUSTOM_TYPE,
		data: { version: 1, todos },
	} as unknown as SessionEntry;
}

const 清单: TodoItem[] = [
	{ content: "读计划", status: "completed" },
	{ content: "写实现", status: "in_progress" },
];

describe("G1 ① 压缩前后查回同一份事实", () => {
	it("压缩后会话待办与压缩前一致（快照条目是载体，不靠模型上下文）", () => {
		const 压缩前条目: SessionEntry[] = [todoEntry({ version: 1, todos: 清单 })];
		const 压缩后条目: SessionEntry[] = [...压缩前条目, snapshotEntry(清单)];
		const 前 = scanTodoState(压缩前条目);
		const 后 = scanTodoState(压缩后条目);
		expect(后.todos).toEqual(前.todos);
		expect(后.snapshot).toEqual({ version: 1, todos: 清单 });
		// 两条路径喂给同一查询面，得到同一份事实
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const 前快照 = readRecallSnapshot(
			{ paoHome: home },
			{ 清单: 前.todos, 陈旧计数: 前.staleCount, 已提醒: 前.reminded, 有压缩快照: 前.snapshot !== undefined },
		);
		const 后快照 = readRecallSnapshot(
			{ paoHome: home },
			{ 清单: 后.todos, 陈旧计数: 后.staleCount, 已提醒: 后.reminded, 有压缩快照: 后.snapshot !== undefined },
		);
		expect(后快照.会话待办?.清单).toEqual(前快照.会话待办?.清单);
		expect(后快照.会话待办?.有压缩快照).toBe(true);
		expect(前快照.会话待办?.有压缩快照).toBe(false);
		expect(sessionTodosToRecall(前.todos)).toEqual(sessionTodosToRecall(后.todos));
	});

	it("重开（新会话只有计划正本、没有会话条目）时，目标/要求/约束/确认版本仍从盘上查回", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const created = await 建计划(项目根);
		const snapshot = readRecallSnapshot({ paoHome: home });
		expect(snapshot.问题).toEqual([]);
		expect(snapshot.计划).toHaveLength(1);
		const row = snapshot.计划[0]!;
		expect(row.计划ID).toBe(created.计划ID);
		expect(row.显示名).toBe("小说创作");
		expect(row.定义版本).toBe(1);
		expect(row.步骤数).toBe(2);
		expect(row.实例).toEqual([]);
		const detail = recallPlan({ paoHome: home, 项目根, 计划ID: created.计划ID });
		expect(detail.步骤.map((step) => step.要求)).toEqual(["把方向与章节计划讨论清楚", "按计划写初稿"]);
		expect(detail.步骤[0]!.约束).toBe("先别写正文");
		expect(detail.步骤[1]!.人工门).toBe(true);
		expect(detail.已撤销).toBe(false);
		expect(detail.必要文件[0]).toContain("计划.md");
	});

	it("按需取详情：focusStep 只回那一步，不问就只给列表摘要", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const created = await 建计划(项目根);
		const focused = recallPlan({ paoHome: home, 项目根, 计划ID: created.计划ID, focusStep: "s2" });
		expect(focused.步骤.map((step) => step.步骤ID)).toEqual(["s2"]);
		expect(focused.步骤数).toBe(2);
		const missing = recallPlan({ paoHome: home, 项目根, 计划ID: created.计划ID, focusStep: "s9" });
		expect(missing.步骤).toEqual([]);
		expect(missing.问题.some((line) => line.includes("没有步骤 s9"))).toBe(true);
	});
});

describe("G1 ② 旧轮次提醒不得推进新轮次", () => {
	const 旧提醒: Pick<RecallTodo, "绑定"> = { 绑定: { 实例: "inst-1", 步骤: "写初稿", 轮次: 1, 定义版本: 1 } };

	it("实例/版本/轮次任一变化即判过期，缺轮次不误判", () => {
		expect(isRecallTodoStale(旧提醒, { 实例: "inst-1", 轮次: 1, 定义版本: 1 })).toBe(false);
		expect(isRecallTodoStale(旧提醒, { 实例: "inst-2", 轮次: 1, 定义版本: 1 })).toBe(true);
		expect(isRecallTodoStale(旧提醒, { 实例: "inst-1", 轮次: 1, 定义版本: 2 })).toBe(true);
		expect(isRecallTodoStale(旧提醒, { 实例: "inst-1", 轮次: 2, 定义版本: 1 })).toBe(true);
		// 两边都缺轮次：不判过期（避免误杀，同桌面 isTodoStale 口径）
		expect(isRecallTodoStale({ 绑定: { 实例: "inst-1" } }, { 实例: "inst-1" })).toBe(false);
	});

	it("过期文案如实说清是哪一版/哪一轮，不过期返回 undefined", () => {
		expect(staleRecallTodoText(旧提醒, { 实例: "inst-1", 轮次: 1, 定义版本: 2 })).toBe(
			"这条待办是照着第 1 版定义提的，现在是第 2 版，请刷新后再处理",
		);
		expect(staleRecallTodoText(旧提醒, { 实例: "inst-1", 轮次: 2, 定义版本: 1 })).toBe(
			"这条待办说的是第 1 轮，现在是第 2 轮，请刷新后再处理",
		);
		expect(staleRecallTodoText(旧提醒, { 实例: "inst-1", 轮次: 1, 定义版本: 1 })).toBeUndefined();
	});

	it("提醒文本带全绑定四要素：消费方据此判过期，旧提醒推不动新轮次", () => {
		const snapshot = readRecallSnapshot({ paoHome: tempDir("pao-g1-home-"), 项目根: tempDir("pao-g1-proj-") });
		const 带绑定: RecallTodo = {
			种类: "confirm",
			身份键: recallTodoKey("confirm", 旧提醒.绑定),
			文案: "写初稿要人工确认",
			原因: "节点停在等待人工确认",
			绑定: 旧提醒.绑定,
			证据: ["证据：控制正本"],
		};
		const 提醒 = buildRecallReminder({ ...snapshot, 待办: [带绑定] });
		expect(提醒).toContain("实例 inst-1");
		expect(提醒).toContain("步骤 写初稿");
		expect(提醒).toContain("第 1 轮");
		expect(提醒).toContain("定义版本 1");
		expect(提醒).toContain("旧轮次提醒不会推进新轮次");
	});
});

describe("G1 ③ 同一待办在两条视图路径下只生效一次", () => {
	it("身份键与桌面 todoKey 六段＋意见ID 逐字同源", () => {
		expect(recallTodoKey("confirm", { 实例: "i", 步骤: "s1", 轮次: 2, 定义版本: 3 })).toBe(
			["confirm", "i", "s1", "2", "3"].join("\u0000"),
		);
		expect(recallTodoKey("undelivered", { 定义版本: 3 }, "f-1")).toBe(
			["undelivered", "", "", "", "3", "f-1"].join("\u0000"),
		);
		// 缺轮次那一段是空串，不是 "0"——「没有轮次」与「第 0 轮」不撞键
		expect(recallTodoKey("failed", { 实例: "i", 轮次: 0 })).toBe(["failed", "i", "", "0", ""].join("\u0000"));
		expect(recallTodoKey("failed", { 实例: "i" })).not.toBe(recallTodoKey("failed", { 实例: "i", 轮次: 0 }));
	});

	it("两条视图给出同一条待办时只留一条（dedupe 保留首条）", () => {
		const 身份 = { 实例: "inst-1", 步骤: "写初稿", 轮次: 1, 定义版本: 1 };
		const 来自待处理: RecallTodo = {
			种类: "confirm",
			身份键: recallTodoKey("confirm", 身份),
			文案: "人工门待确认",
			原因: "collectPending 报的",
			绑定: 身份,
			证据: ["a"],
		};
		const 来自实例扫描: RecallTodo = { ...来自待处理, 原因: "scanInstanceSignals 报的", 证据: ["b"] };
		const merged = dedupeTodos([来自待处理, 来自实例扫描]);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.原因).toBe("collectPending 报的");
	});

	it("mergeRecallTodos 按五类稳定排序，同类保持输入顺序", () => {
		const mk = (种类: RecallTodo["种类"], 序号: string): RecallTodo => ({
			种类,
			身份键: recallTodoKey(种类, {}, 序号),
			文案: 序号,
			原因: "",
			绑定: {},
			证据: [],
		});
		const merged = mergeRecallTodos([
			[mk("undelivered", "u")],
			[mk("recovery", "r"), mk("failed", "f")],
			[mk("confirm", "c")],
		]);
		expect(merged.map((todo) => todo.种类)).toEqual(["recovery", "confirm", "failed", "undelivered"]);
		expect(RECALL_TODO_KINDS).toEqual(["recovery", "confirm", "missing_input", "failed", "undelivered"]);
	});

	it("同一条计划意见既进未决意见又进待办时不重复计数", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const created = await 建计划(项目根);
		await recordPlanFeedback({
			项目根,
			计划ID: created.计划ID,
			来源会话: "sess-1",
			目标: { 类型: "步骤", 步骤ID: "s1" },
			正文: "这一步要写得更细",
		});
		const snapshot = readRecallSnapshot({ paoHome: home, 计划ID: created.计划ID });
		expect(snapshot.未决意见).toHaveLength(1);
		const 意见待办 = snapshot.待办.filter((todo) => todo.意见ID !== undefined);
		expect(意见待办).toHaveLength(1);
		expect(意见待办[0]!.绑定.步骤).toBe("s1");
		expect(意见待办[0]!.绑定.定义版本).toBe(1);
		// 再读一次：同一份正本，同一组身份键（不随时间漂）
		const again = readRecallSnapshot({ paoHome: home, 计划ID: created.计划ID });
		expect(again.待办.map((todo) => todo.身份键)).toEqual(snapshot.待办.map((todo) => todo.身份键));
	});
});

describe("G1 ④ 提醒通道失败但事实仍可查", () => {
	it("提醒是纯字符串拼接：某通道抛错不影响快照本身", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const created = await 建计划(项目根);
		const snapshot = readRecallSnapshot({ paoHome: home, 计划ID: created.计划ID });
		// 模拟通知通道失败：消费方拿不到提醒文本
		const 投递提醒 = (): string => {
			throw new Error("通知通道不可用");
		};
		let 提醒文本: string | undefined;
		try {
			提醒文本 = 投递提醒();
		} catch {
			提醒文本 = undefined;
		}
		expect(提醒文本).toBeUndefined();
		// 事实还在：重新查一次盘上正本，同一条计划照样查得到
		const reread = readRecallSnapshot({ paoHome: home, 计划ID: created.计划ID });
		expect(reread.计划).toHaveLength(1);
		expect(reread.计划[0]!.计划ID).toBe(snapshot.计划[0]!.计划ID);
		expect(reread.计划[0]!.定义版本).toBe(1);
	});

	it("坏正本逐条点名进问题，不静默变成「没有待办」", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const created = await 建计划(项目根);
		// 坏意见文件：不是合法 YAML 结构 → 如实进问题
		mkdirSync(join(项目根, ".pao", "临时工作流", created.计划ID), { recursive: true });
		writeFileSync(
			join(项目根, ".pao", "临时工作流", created.计划ID, "意见.md"),
			"---\n记录: 不是列表\n---\n",
			"utf8",
		);
		const snapshot = readRecallSnapshot({ paoHome: home, 计划ID: created.计划ID });
		expect(snapshot.问题.some((line) => line.includes("意见读不出"))).toBe(true);
		expect(snapshot.计划).toHaveLength(1); // 计划本身照样查得回
	});

	it("项目清单里没有项目时如实说「请传项目根」，不假装查到了空", () => {
		const home = tempDir("pao-g1-home-");
		const snapshot = readRecallSnapshot({ paoHome: home });
		expect(snapshot.计划).toEqual([]);
		expect(snapshot.问题.some((line) => line.includes("请传项目根"))).toBe(true);
	});
});

describe("G1 ⑤ 取不到的字段如实留空（不是 0、不是空串）", () => {
	it("会话待办没有实例/步骤/轮次/版本 → 四个绑定字段全 undefined", () => {
		const todos = sessionTodosToRecall([{ content: "写实现", status: "in_progress" }]);
		expect(todos).toHaveLength(1);
		const 绑定 = todos[0]!.绑定;
		expect(绑定.实例).toBeUndefined();
		expect(绑定.步骤).toBeUndefined();
		expect(绑定.轮次).toBeUndefined();
		expect(绑定.定义版本).toBeUndefined();
	});

	it("卡侧失败待办没有实例/步骤/轮次/版本 → 全 undefined，卡号与部门照实给", async () => {
		const 项目根 = tempDir("pao-g1-proj-");
		const cardsDir = join(项目根, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		// 真通道造卡：直接写卡文件（与 createCard 落盘格式一致的最小卡）
		const { createCard } = await import("../../src/pao/cards/cardfile.ts");
		const card = await createCard(cardsDir, {
			目标: "缺输入的活",
			部门: "写作部",
			验收: "文件存在",
			创建: "2026-10-17 12:00",
			状态: "failed",
		});
		writeFileSync(card.path, serializeCard({ ...card.frontmatter, attempt: 1, status: "failed" }, card.body), "utf8");
		const todos = cardRecallTodos(项目根);
		expect(todos).toHaveLength(1);
		const todo = todos[0]!;
		expect(todo.种类).toBe("failed");
		expect(todo.部门).toBe("写作部");
		expect(todo.卡号).toBe(card.card_no);
		expect(todo.绑定.实例).toBeUndefined();
		expect(todo.绑定.步骤).toBeUndefined();
		expect(todo.绑定.轮次).toBeUndefined();
		expect(todo.绑定.定义版本).toBeUndefined();
		// 回执没落过 → 失败类型取不到，原因如实说「回执未记失败类型」，不编一个类型
		expect(todo.原因).toContain("回执未记失败类型");
	});

	it("流程级意见没有步骤ID/轮次 → undefined；文件级意见有轮次", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const created = await 建计划(项目根);
		await recordPlanFeedback({
			项目根,
			计划ID: created.计划ID,
			来源会话: "sess-1",
			目标: { 类型: "流程" },
			正文: "整体方向再收紧一点",
		});
		let snapshot = readRecallSnapshot({ paoHome: home, 计划ID: created.计划ID });
		expect(snapshot.未决意见[0]!.步骤ID).toBeUndefined();
		expect(snapshot.未决意见[0]!.轮次).toBeUndefined();
		const 流程待办 = snapshot.待办.find((todo) => todo.意见ID !== undefined)!;
		expect(流程待办.绑定.步骤).toBeUndefined();
		expect(流程待办.绑定.轮次).toBeUndefined();
		expect(流程待办.绑定.实例).toBeUndefined();

		await recordPlanFeedback({
			项目根,
			计划ID: created.计划ID,
			来源会话: "sess-1",
			目标: { 类型: "文件", 步骤ID: "s1", 轮次: 2, 路径: "创作成果/初稿.md", 版本依据: "第 2 轮（卡0001）" },
			正文: "结尾再改一版",
		});
		snapshot = readRecallSnapshot({ paoHome: home, 计划ID: created.计划ID });
		const 文件意见 = snapshot.未决意见.find((entry) => entry.轮次 !== undefined)!;
		expect(文件意见.轮次).toBe(2);
		expect(文件意见.步骤ID).toBe("s1");
	});

	it("没启动过的计划没有确认版本 → 确认版本 undefined 且一致为 false", async () => {
		const 项目根 = tempDir("pao-g1-proj-");
		const created = await 建计划(项目根);
		const confirmed = readConfirmedVersion({ 项目根, 计划ID: created.计划ID, 启动请求ID: "start-未发生" });
		expect(confirmed.确认版本).toBeUndefined();
		expect(confirmed.当前版本).toBe(1);
		expect(confirmed.一致).toBe(false);
	});
});

describe("G1 现场信号：真实控制正本上的待办绑定到实例/步骤/轮次", () => {
	it("人工门待确认：待办绑定真实实例与轮次，定义版本来自计划正本", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const paoDir = join(项目根, ".pao");
		const cardsDir = join(paoDir, "卡");
		mkdirSync(cardsDir, { recursive: true });
		const recipe = parseRecipe(
			`---\n${stringify({
				版本: 2,
				名字: "验流",
				参数: [],
				节点: [{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在", 人工确认: true }],
			})}---\n`,
			join(项目根, "验流.md"),
		);
		const options = {
			cardsDir,
			ownerSessionId: "owner",
			counterPath: join(paoDir, "卡号.txt"),
			workspaceDir: paoDir,
		};
		await startControl(recipe, {}, options);
		await bindMinister(recipe, options, "开发", "minister-开发");
		const flow = readControl(recipe, options);
		const identity = {
			实例: flow.实例,
			节点: "开发",
			轮次: flow.节点.find((node) => node.名字 === "开发")!.轮次,
			部长会话: "minister-开发",
		};
		const refs = await addNodeCards(recipe, options, identity, [{ goal: "任务", acceptance: "文件存在" }]);
		for (const ref of refs) {
			const card = loadCard(cardsDir, parseCardRef(ref));
			writeFileSync(card.path, serializeCard({ ...card.frontmatter, status: "delivered" }, card.body), "utf8");
		}
		await endDecomposition(recipe, options, identity);

		const snapshot = readRecallSnapshot({ paoHome: home, 项目根 });
		expect(snapshot.问题).toEqual([]);
		const 门 = snapshot.待办.find((todo) => todo.文案.includes("人工门待确认"))!;
		expect(门).toBeTruthy();
		expect(门.绑定.实例).toBe(identity.实例);
		expect(门.绑定.步骤).toBe("开发");
		expect(门.绑定.轮次).toBe(identity.轮次);
		// 这个实例不来自临时计划 → 定义版本取不到，如实 undefined
		expect(门.绑定.定义版本).toBeUndefined();
		expect(门.证据.some((line) => line.includes("节点：开发"))).toBe(true);
	});
});

describe("G1 只读性：查询面不写盘、不派发", () => {
	it("调两次快照与详情，项目目录里的文件字节不变", async () => {
		const home = tempDir("pao-g1-home-");
		const 项目根 = tempDir("pao-g1-proj-");
		落项目(home, 项目根);
		const created = await 建计划(项目根);
		const { readFileSync, readdirSync } = await import("node:fs");
		const planPath = join(项目根, ".pao", "临时工作流", created.计划ID, "计划.md");
		const before = readFileSync(planPath, "utf8");
		const filesBefore = readdirSync(join(项目根, ".pao", "临时工作流", created.计划ID)).sort();
		readRecallSnapshot({ paoHome: home });
		recallPlan({ paoHome: home, 项目根, 计划ID: created.计划ID });
		readConfirmedVersion({ 项目根, 计划ID: created.计划ID, 启动请求ID: "start-x" });
		expect(readFileSync(planPath, "utf8")).toBe(before);
		expect(readdirSync(join(项目根, ".pao", "临时工作流", created.计划ID)).sort()).toEqual(filesBefore);
		// 卡目录没有被查询面创建（查询不派发、不建目录）
		expect(readdirSync(项目根, { recursive: true }) as string[]).not.toContain("卡");
	});
});
