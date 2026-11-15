import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { createCard, listCards } from "../../src/pao/cards/index.ts";
import { registerCollab } from "../../src/pao/collab/index.ts";
import type { CollabReviewResult } from "../../src/pao/collab/review.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { type DeptRegistryRow, formatRegistry, readRegistry } from "../../src/pao/dept/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 极简注册口:截获工具/命令/发出消息,供直接调用(不接真实会话) */
function capturePi() {
	const tools: ToolDefinition[] = [];
	const commands: { name: string; description?: string; handler: (args: string, ctx: never) => Promise<void> }[] = [];
	const messages: { customType: string; text: string }[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: (
			name: string,
			options: { description?: string; handler: (args: string, ctx: never) => Promise<void> },
		) => commands.push({ name, description: options.description, handler: options.handler }),
		sendMessage: (message: { customType: string; content: { type: string; text: string }[] }) =>
			messages.push({ customType: message.customType, text: message.content[0].text }),
	} as unknown as ExtensionAPI;
	resetPaoSubcommandsForTest();
	const runSub = async (name: string, args = "", ctx: unknown = {}) => {
		const sub = listPaoSubcommands(pi).find((entry) => entry.name === name);
		if (!sub) throw new Error(`子命令 ${name} 未注册`);
		await sub.run(pi, args, ctx);
	};
	return { tools, commands, messages, pi, runSub };
}

/** 临时任务工作区:pao/task-20261002/卡/ 的三层布局(计数器缺省推导落在 pao/ 下) */
function tempWorkspace(): { root: string; cardsDir: string; registryPath: string } {
	const root = mkdtempSync(join(tmpdir(), "pao-collab-"));
	tempDirs.push(root);
	const cardsDir = join(root, "pao", "task-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const registryPath = join(root, "pao", "部门", "注册表.md");
	mkdirSync(join(root, "pao", "部门"), { recursive: true });
	const rows: DeptRegistryRow[] = [
		{ 名字: "后端", 标签: ["api"], 库路径: "部门/后端/知识库" },
		{ 名字: "测试", 标签: ["qa"], 库路径: "部门/测试/知识库" },
	];
	writeFileSync(registryPath, formatRegistry(rows), "utf8");
	return { root, cardsDir, registryPath };
}

/** 在卡目录里落一张普通父卡(卡#1,部门 前端) */
async function seedParentCard(cardsDir: string): Promise<void> {
	await createCard(cardsDir, { 目标: "登录页改版", 部门: "前端", 验收: "页面渲染并测试绿", 创建: "2026-10-02 09:00" });
}

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { type: string; text: string }).text;
}

describe("pao_collab_relay 工具", () => {
	it("注册工具与 collab 子命令;工具名与子命令名正确", () => {
		const captured = capturePi();
		registerCollab(captured.pi, {});
		expect(captured.tools.map((t) => t.name)).toContain("pao_collab_relay");
		expect(listPaoSubcommands(captured.pi).map((sub) => sub.name)).toContain("collab");
		expect(captured.tools[0].description).toContain("协作卡");
	});

	it("放行:落目标部门队列,留审计(缺省审计路径=工作区根 协作审计.jsonl)", async () => {
		const { root, cardsDir, registryPath } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;

		const result = await tool.execute(
			"t1",
			{ goal: "帮忙压测登录接口", dept: "后端", acceptance: "压测报告落产物", parent: "卡#1", source_dept: "前端" },
			undefined,
			undefined,
			{} as never,
		);
		const text = textOf(result);
		expect(text).toContain("已落目标部门队列");
		expect((result.details as CollabReviewResult).裁决).toBe("放行");

		// 卡落盘:parent 写入、状态 待认领
		const cards = listCards(cardsDir);
		expect(cards).toHaveLength(2);
		const collab = cards.find((c) => c.card_no === 2)!;
		expect(collab.frontmatter.parent).toBe("卡#1");
		expect(collab.frontmatter.status).toBe("unclaimed");
		expect(collab.frontmatter.dept).toBe("后端");

		// 审计:缺省 <卡目录>/../协作审计.jsonl
		const auditText = readFileSync(join(root, "pao", "task-20261002", "协作审计.jsonl"), "utf8").trim();
		const record = JSON.parse(auditText) as Record<string, unknown>;
		expect(record).toMatchObject({
			来源部门: "前端",
			目标部门: "后端",
			卡号: 2,
			校验结果: "放行",
		});
	});

	it("拒绝:不落卡、审计记拒绝与结构化原因", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		const auditPath = join(cardsDir, "..", "协作审计.jsonl");
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveRegistryPath: () => registryPath,
			resolveAuditPath: () => auditPath,
		});
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;

		const result = await tool.execute(
			"t1",
			{ goal: "做一件不存在部门的事", dept: "幽灵部", acceptance: "x", parent: "卡#1" },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(result)).toContain("已拒绝");
		expect((result.details as CollabReviewResult).原因[0].类型).toBe("部门不存在");
		expect(listCards(cardsDir)).toHaveLength(1); // 只有父卡,未落新卡
		const record = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
		expect(record.校验结果).toBe("拒绝");
		expect(record.卡号).toBeNull();
		expect(record.原因).toEqual(["[部门不存在] 部门「幽灵部」不在注册表中（现有：后端、测试）"]);
	});

	it("待主控裁决:带裁决标记不落队列,返回裁决摘要,审计留痕", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;

		const result = await tool.execute(
			"t1",
			{ goal: "帮忙压测", dept: "后端", acceptance: "报告落产物", parent: "卡#1", jump_queue: "用户在线等" },
			undefined,
			undefined,
			{} as never,
		);
		const text = textOf(result);
		expect(text).toContain("待主控裁决");
		expect(text).toContain("插队");
		expect(text).toContain("用户在线等");
		expect((result.details as CollabReviewResult).裁决).toBe("待主控裁决");
		expect(listCards(cardsDir)).toHaveLength(1); // 未落卡
	});

	it("幂等:同 parent 同目标部门重复递交返回已有卡号,不重复落卡", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;
		const params = { goal: "帮忙压测", dept: "后端", acceptance: "报告落产物", parent: "卡#1" };

		await tool.execute("t1", params, undefined, undefined, {} as never);
		const again = await tool.execute("t2", params, undefined, undefined, {} as never);
		expect(textOf(again)).toContain("重复落卡");
		expect((again.details as CollabReviewResult).已有卡号).toBe(2);
		expect(listCards(cardsDir)).toHaveLength(2); // 父卡 + 第一次的协作卡
	});

	it("resolveDeptCardsDir 注入:落卡进目标部门卡目录;既有卡合并校验", async () => {
		const { cardsDir, registryPath, root } = tempWorkspace();
		await seedParentCard(cardsDir);
		const deptDir = join(root, "pao", "dept-queue-后端", "卡");
		mkdirSync(deptDir, { recursive: true });
		const captured = capturePi();
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveRegistryPath: () => registryPath,
			resolveDeptCardsDir: (dept: string) => (dept === "后端" ? deptDir : cardsDir),
		});
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;

		const result = await tool.execute(
			"t1",
			{ goal: "帮忙压测", dept: "后端", acceptance: "报告落产物", parent: "卡#1" },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(result)).toContain(deptDir);
		expect(listCards(deptDir)).toHaveLength(1);
		expect(existsSync(join(deptDir, "..", "协作审计.jsonl"))).toBe(false); // 审计仍随工作区
	});

	it("有色卡读不出来时,放行结论要披露查重不完整（审查第 5 项）", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedParentCard(cardsDir);
		writeFileSync(join(cardsDir, "卡0009-坏卡.md"), "---\n目标: 坏卡\n---\n正文\n", "utf8");
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;

		const result = await tool.execute(
			"t1",
			{ goal: "帮忙压测", dept: "后端", acceptance: "报告落产物", parent: "卡#1" },
			undefined,
			undefined,
			{} as never,
		);
		const text = textOf(result);
		// 查重结论不完整必须说清,别让「放行」看着像查过全部卡
		expect(text).toContain("1 张卡读不出来，本次查重未包含它们");
		expect(text).toContain("卡0009-坏卡.md");
	});

	it("没有坏卡时放行结论不多余披露（保持原样）", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedParentCard(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;

		const result = await tool.execute(
			"t1",
			{ goal: "帮忙压测", dept: "后端", acceptance: "报告落产物", parent: "卡#1" },
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(result)).not.toContain("读不出来");
	});

	it("卡目录与默认卡目录都缺 → 报错不静默", async () => {
		const captured = capturePi();
		registerCollab(captured.pi, {});
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;
		await expect(
			tool.execute(
				"t1",
				{ goal: "x", dept: "后端", acceptance: "y", parent: "卡#1" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/卡目录/);
	});
});

describe("/pao collab 子命令", () => {
	it("三段参数:直接落卡到当前任务工作区卡目录,主控零参与(不走注册表校验)", async () => {
		const { cardsDir } = tempWorkspace(); // 注册表里没有「文档」部,/派 也不该拒绝
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir });
		await captured.runSub("collab", "整理 v2 架构速查 | 文档 | 架构速查页落产物且含 §8 全节");
		expect(captured.messages).toHaveLength(1);
		expect(captured.messages[0].customType).toBe("pao-dispatch");
		expect(captured.messages[0].text).toContain("已派卡");
		const cards = listCards(cardsDir);
		expect(cards).toHaveLength(1);
		expect(cards[0].frontmatter.dept).toBe("文档");
		expect(cards[0].frontmatter.status).toBe("unclaimed");
		expect(cards[0].frontmatter.parent).toBeUndefined();
	});

	it("四段参数:输入指针按顿号拆分写进卡", async () => {
		const { cardsDir } = tempWorkspace();
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir });
		await captured.runSub("collab", "修超时 | 后端 | docs/api.md#L10、src/login.ts | 登录测试全绿");
		const cards = listCards(cardsDir);
		expect(cards[0].frontmatter.inputs).toEqual(["docs/api.md#L10", "src/login.ts"]);
		expect(cards[0].frontmatter.acceptance).toBe("登录测试全绿");
	});

	it("参数不全:给中文用法提示,不落半残卡", async () => {
		const { cardsDir } = tempWorkspace();
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir });
		await captured.runSub("collab", "只有目标 | 后端");
		await captured.runSub("collab", "");
		await captured.runSub("collab", "目标 | | 验收");
		expect(captured.messages).toHaveLength(3);
		for (const message of captured.messages) {
			expect(message.text).toContain("用法");
			expect(message.text).toContain("未落卡");
		}
		expect(listCards(cardsDir)).toHaveLength(0);
	});

	it("未注入 resolveCardsDir:提示配置缺失,不抛错", async () => {
		const captured = capturePi();
		registerCollab(captured.pi, {});
		await captured.runSub("collab", "目标 | 后端 | 验收");
		expect(captured.messages[0].text).toContain("未配置默认卡目录");
	});
});

describe("注册表读取", () => {
	it("缺省注册表路径 = $PAO_HOME/部门/注册表.md(可注入覆写)", () => {
		const { registryPath } = tempWorkspace();
		const rows = readRegistry(registryPath);
		expect(rows.map((row) => row.名字)).toEqual(["后端", "测试"]);
	});
});

describe("协作并发与审计部分成功(审查第 8、15 项)", () => {
	/** 父卡带协作配额 1:同 parent 同部门只允许一张子卡 */
	async function seedQuotaOneParent(cardsDir: string): Promise<void> {
		await createCard(cardsDir, {
			目标: "登录页改版",
			部门: "前端",
			验收: "页面渲染并测试绿",
			创建: "2026-10-02 09:00",
			预算: { collab_quota: 1 },
		});
	}

	it("同进程并发递交:配额 1 只落一张有效子卡,另一张明确拒绝", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedQuotaOneParent(cardsDir);
		const captured = capturePi();
		registerCollab(captured.pi, { resolveCardsDir: () => cardsDir, resolveRegistryPath: () => registryPath });
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;
		const 递交 = () =>
			tool.execute(
				"t1",
				{
					goal: "帮忙压测登录接口",
					dept: "后端",
					acceptance: "压测报告落产物",
					parent: "卡#1",
					source_dept: "前端",
				},
				undefined,
				undefined,
				{} as never,
			);

		const [a, b] = await Promise.all([递交(), 递交()]);
		const verdicts = [a, b].map((r) => (r.details as CollabReviewResult).裁决).sort();
		expect(verdicts).toEqual(["拒绝", "放行"]);
		const 拒绝文本 = [a, b].find((r) => (r.details as CollabReviewResult).裁决 === "拒绝")!;
		expect(textOf(拒绝文本)).toContain("重复落卡");
		// 只有父卡 + 一张子卡:配额 1 没有被并发绕过
		const cards = listCards(cardsDir);
		expect(cards).toHaveLength(2);
		expect(cards.filter((c) => c.frontmatter.parent === "卡#1")).toHaveLength(1);
	});

	it("两个隔离进程争抢同一配额:跨进程临界区只放行一张", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedQuotaOneParent(cardsDir);
		const child = fileURLToPath(new URL("./collab-concurrency-child.ts", import.meta.url));
		// 两个子进程同一时刻起跑:不设起跑线就会一前一后完成,测不出并发争抢
		const 起跑时刻 = String(Date.now() + 2000);
		const 起一个 = (goal: string) =>
			new Promise<{ 裁决: string; text: string }>((resolve, reject) => {
				const proc = spawn(
					process.execPath,
					["--experimental-strip-types", child, cardsDir, registryPath, goal, 起跑时刻],
					{
						cwd: process.cwd(),
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let out = "";
				let err = "";
				proc.stdout.on("data", (chunk) => {
					out += String(chunk);
				});
				proc.stderr.on("data", (chunk) => {
					err += String(chunk);
				});
				proc.on("close", (code) => {
					if (code !== 0) reject(new Error(`子进程退出码 ${code}:${err}`));
					else resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}") as { 裁决: string; text: string });
				});
			});

		const results = await Promise.all([起一个("并发递交 A"), 起一个("并发递交 B")]);
		const verdicts = results.map((r) => r.裁决).sort();
		expect(verdicts).toEqual(["拒绝", "放行"]);
		expect(listCards(cardsDir).filter((c) => c.frontmatter.parent === "卡#1")).toHaveLength(1);
	}, 60_000);

	it("审计写入失败:卡已创建如实报出,不让调用方误以为该重试(审查第 15 项)", async () => {
		const { cardsDir, registryPath } = tempWorkspace();
		await seedParentCard(cardsDir);
		// 审计路径指向一个目录:open/append 必然 EISDIR
		const auditAsDir = join(cardsDir, "..", "审计目录");
		mkdirSync(auditAsDir, { recursive: true });
		const captured = capturePi();
		registerCollab(captured.pi, {
			resolveCardsDir: () => cardsDir,
			resolveRegistryPath: () => registryPath,
			resolveAuditPath: () => auditAsDir,
		});
		const tool = captured.tools.find((t) => t.name === "pao_collab_relay")!;

		const result = await tool.execute(
			"t1",
			{ goal: "帮忙压测登录接口", dept: "后端", acceptance: "压测报告落产物", parent: "卡#1", source_dept: "前端" },
			undefined,
			undefined,
			{} as never,
		);
		const text = textOf(result);
		// 不许只报笼统失败:必须给出真实卡号与「已创建」事实 + 审计失败原因
		expect(text).toContain("已落目标部门队列");
		expect(text).toContain("审计写入失败");
		expect(text).toContain("已创建，不要重复派卡");
		const cards = listCards(cardsDir);
		expect(cards).toHaveLength(2);
		expect(cards.find((c) => c.card_no === 2)?.frontmatter.parent).toBe("卡#1");
	});
});
