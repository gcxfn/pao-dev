import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { diffAgainstBaseline, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, findCardFile, loadCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { deliverCard, deliverCards, registerDeliveryTools } from "../../src/pao/cards/delivery.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";
import type { TodoItem } from "../../src/pao/todo/index.ts";

/**
 * §13 交卷自动化：stage 范围＝认领基线比对本卡差异清单（逐路径 add、禁 add -A、R15）、
 * 提交信息机械生成、幂等（无改动不空提交）、只 commit 不 push、
 * 验收未过/状态非已交付的拒交行为、批量串行、pao_deliver_card 工具接线。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-delivery-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** 干净基线仓库：单次提交后工作树全净（用户脏工作树场景在「清单外不碰」用例单独制造）。 */
function makeRepo(prefix = "pao-delivery-"): string {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	return repo;
}

async function makeDeliverableCard(repo: string, goal = "巡库卡"): Promise<{ cardDir: string; cardNo: number }> {
	const cardDir = join(repo, ".pao", "卡");
	mkdirSync(cardDir, { recursive: true });
	const card = await createCard(cardDir, {
		目标: goal,
		部门: "核心机制",
		验收: "存在: 产物.txt",
		创建: "2026-10-02 10:00",
	});
	changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
	// R14：认领时落基线快照（pao_change_status 工具里的接线动作，此处直接调同一入口）
	await snapshotClaimBaseline(cardDir, card.card_no, { owner: "部长A", 时间: "2026-10-02 10:01" });
	// 模拟 worker 产物
	writeFileSync(join(repo, "产物.txt"), "+worker 产物\n");
	// 模拟机械验收全过：状态落已交付 + 卡上落验收记录（§12→§13 衔接面）
	const claimed = loadCard(cardDir, card.card_no);
	changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30", 依据: "机械验收全部通过" });
	appendVerdictRaw(cardDir, card.card_no, "- 结论: 全过自动交付");
	return { cardDir: cardDir, cardNo: card.card_no };
}

/** 直写一段验收记录（模拟 pao_verify_card 落卡后的派生数据，供交卷侧衔接读取）。 */
function appendVerdictRaw(cardDir: string, cardNo: number, verdictLine: string): void {
	const card = readCardByNumber(cardDir, cardNo);
	const section = `## 机械验收 2026-10-02 10:29\n${verdictLine}`;
	const body = card.body.trim().length > 0 ? `${card.body.trimEnd()}\n\n${section}\n` : `${section}\n`;
	writeFileAtomic(card.path, serializeCard(card.frontmatter, body));
}

function readCardByNumber(cardDir: string, cardNo: number): ParsedCard {
	return readCard(join(cardDir, findCardFile(cardDir, cardNo)!));
}

function commitCount(repo: string): number {
	return Number.parseInt(git(repo, ["rev-list", "--count", "HEAD"]).trim(), 10);
}

describe("pao_deliver_card：stage 范围与提交", () => {
	it("已交付卡：按基线差异逐路径 stage 并 commit，提交信息机械生成（卡NNNN 目标 · 已交付 · 机械验收通过）", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		const before = commitCount(repo);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(r.提交哈希).toBeTruthy();
		expect(r.提交信息).toBe(`卡${String(cardNo).padStart(4, "0")} 巡库卡 · delivered · 机械验收通过`);
		expect(r.暂存文件).toEqual(["产物.txt"]);
		expect(commitCount(repo)).toBe(before + 1);
		expect(git(repo, ["log", "-1", "--pretty=%B"]).trim()).toBe(r.提交信息);
		// 提交后工作树对本卡差异清零（.pao 编排区在差分面外）
		const diff = await diffAgainstBaseline(
			join(repo, ".pao", "基线", `卡${String(cardNo).padStart(4, "0")}-基线.txt`),
		);
		expect(diff.worker改动).toEqual([]);
		// 卡文件状态不被交卷改动
		expect(loadCard(cardDir, cardNo).frontmatter.status).toBe("delivered");
	}, 20000);

	it("逐路径 add 不裹挟：worker 增改之外的既有脏文件不进提交（R15）", async () => {
		const repo = makeRepo();
		// 用户派卡前自己的脏改动
		writeFileSync(join(repo, "已跟踪.txt"), "v2-用户改的\n");
		writeFileSync(join(repo, "用户便签.txt"), "用户的\n");
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, { 目标: "范围卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:00" });
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		await snapshotClaimBaseline(cardDir, card.card_no, { owner: "部长A" });
		// worker 只写自己的产物
		writeFileSync(join(repo, "产物.txt"), "worker 的\n");
		const delivered = loadCard(cardDir, card.card_no);
		changeCardStatus(delivered, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		appendVerdictRaw(cardDir, card.card_no, "- 结论: 全过自动交付");

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(true);
		expect(r.暂存文件).toEqual(["产物.txt"]);
		// 用户既有改动仍未暂存、未被提交
		const status = git(repo, ["status", "--porcelain"]);
		expect(status).toContain("已跟踪.txt");
		expect(status).toContain("用户便签.txt");
		expect(status).not.toContain("产物.txt");
	}, 20000);

	it("幂等：无基线外改动不创建空提交", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		await deliverCard(cardDir, cardNo);
		const before = commitCount(repo);

		const r2 = await deliverCard(cardDir, cardNo);

		expect(r2.交卷).toBe(false);
		expect(r2.消息).toContain("幂等");
		expect(commitCount(repo)).toBe(before);
	}, 20000);

	it("用户认领前已暂存的文件保持暂存，只提交本卡路径（R30）", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "已跟踪.txt"), "用户已暂存\n");
		git(repo, ["add", "--", "已跟踪.txt"]);
		const beforeIndex = git(repo, ["diff", "--cached", "--binary"]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim()).toBe("产物.txt");
		expect(git(repo, ["diff", "--cached", "--binary"])).toBe(beforeIndex);
		expect(git(repo, ["show", "HEAD:已跟踪.txt"])).toBe("v1\n");
	}, 20000);

	it("既有暂存文件后来变成 MM，也不冒认成本卡路径（R30 文件级边界）", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "已跟踪.txt"), "用户已暂存\n");
		git(repo, ["add", "--", "已跟踪.txt"]);
		const beforeIndex = git(repo, ["diff", "--cached", "--binary"]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		writeFileSync(join(repo, "已跟踪.txt"), "同文件后续改动\n");

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(r.暂存文件).toEqual(["产物.txt"]);
		expect(git(repo, ["diff", "--cached", "--binary"])).toBe(beforeIndex);
		expect(git(repo, ["status", "--porcelain"])).toContain("MM 已跟踪.txt");
	}, 20000);

	it("本卡重命名同时提交旧路径删除和新路径，用户暂存仍保留", async () => {
		const repo = makeRepo();
		writeFileSync(join(repo, "用户.txt"), "用户\n");
		git(repo, ["add", "--", "用户.txt"]);
		const beforeIndex = git(repo, ["diff", "--cached", "--binary"]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		git(repo, ["mv", "--", "已跟踪.txt", "改名 文件.txt"]);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(git(repo, ["show", "HEAD:改名 文件.txt"])).toBe("v1\n");
		expect(git(repo, ["ls-tree", "--name-only", "HEAD"])).not.toContain("已跟踪.txt");
		expect(git(repo, ["diff", "--cached", "--binary"])).toBe(beforeIndex);
	}, 20000);

	it("读取 git status 失败时拒绝交卷，不能当成无改动幂等（R30）", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		writeFileSync(join(repo, ".git", "index"), "损坏的测试夹具索引\n");

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("基线不可用");
		expect(r.消息).toContain("git 状态不可用");
		expect(r.消息).not.toContain("幂等");
	}, 20000);

	it("只 commit 不 push：配了远端也不推（远端引用保持为空）", async () => {
		const repo = makeRepo();
		const remote = tempDir("pao-delivery-remote-");
		git(remote, ["init", "--bare"]);
		git(repo, ["remote", "add", "origin", remote]);
		const { cardDir, cardNo } = await makeDeliverableCard(repo);

		const r = await deliverCard(cardDir, cardNo);

		expect(r.交卷).toBe(true);
		expect(git(repo, ["ls-remote", "origin"]).trim()).toBe(""); // 远端零引用：没有任何 push 发生
		expect(r.消息).toContain("未 push");
	}, 20000);
});

describe("pao_deliver_card：与验收员的输出衔接（§12→§13）", () => {
	it("机械验收未过 → 拒绝交卷，不产生提交", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, { 目标: "未过卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:00" });
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		await snapshotClaimBaseline(cardDir, card.card_no);
		writeFileSync(join(repo, "产物.txt"), "x\n");
		const claimed = loadCard(cardDir, card.card_no);
		// owner 强行人工落已交付（绕过机械验收），但卡上验收记录为未过
		changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		appendVerdictRaw(cardDir, card.card_no, "- 结论: 未过");
		const before = commitCount(repo);

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("机械验收未过");
		expect(r.消息).toContain("拒绝交卷");
		expect(r.消息).toContain("复核验收结果");
		expect(commitCount(repo)).toBe(before);
	}, 20000);

	it("状态非已交付 → 拒绝交卷（回执≠终态纪律）", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "进行中卡",
			部门: "核心机制",
			验收: "x",
			创建: "2026-10-02 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		const before = commitCount(repo);

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("状态非已交付");
		expect(r.消息).toContain("pao_verify_card");
		expect(commitCount(repo)).toBe(before);
	}, 20000);

	it("基线快照不可用 → 拒绝交卷，禁 add -A 不猜", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "无基线卡",
			部门: "核心机制",
			验收: "x",
			创建: "2026-10-02 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		changeCardStatus(loadCard(cardDir, card.card_no), { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		writeFileSync(join(repo, "产物.txt"), "x\n");

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(false);
		expect(r.原因).toBe("基线不可用");
		expect(r.消息).toContain("add -A");
		expect(commitCount(repo)).toBe(1); // 只有开工基线提交
	}, 20000);
});

interface ToolDef {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { text: string }[] }>;
}

function setup(cardDir?: string): Map<string, ToolDef> {
	const tools = new Map<string, ToolDef>();
	const pi = {
		registerTool: (def: { name: string; execute: ToolDef["execute"] }) =>
			tools.set(def.name, { execute: def.execute }),
		registerCommand: () => {},
		sendMessage: () => {},
		on: () => {},
	};
	registerDeliveryTools(pi as never, cardDir ? { resolveCardsDir: () => cardDir } : undefined);
	return tools;
}

describe("pao_deliver_card：批量与工具接线", () => {
	it.skipIf(process.platform !== "win32")(
		"正式工具在真实git hook父孙进程运行时取消，批量直接抛出且不提交",
		async () => {
			const repo = makeRepo();
			const a = await makeDeliverableCard(repo, "取消交卷");
			const hooks = join(repo, ".git", "hooks");
			writeFileSync(
				join(hooks, "cancel.cjs"),
				`const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',"require('node:fs').writeFileSync('.git/hooks/ready','yes');setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync('.git/hooks/pids',JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`,
			);
			writeFileSync(
				join(hooks, "pre-commit"),
				`#!/bin/sh\nexec '${process.execPath.replaceAll("\\", "/")}' '.git/hooks/cancel.cjs'\n`,
			);
			const controller = new AbortController();
			const independent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
			const operation = setup(a.cardDir)
				.get("pao_deliver_card")!
				.execute("cancel", { card_ref: [a.cardNo, 999] }, controller.signal);
			const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
			try {
				const deadline = Date.now() + 10000;
				while (!existsSync(join(hooks, "ready"))) {
					if (Date.now() > deadline) throw new Error("真实git hook未启动");
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				const pids = JSON.parse(readFileSync(join(hooks, "pids"), "utf8")) as number[];
				controller.abort();
				await rejected;
				for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
				expect(() => process.kill(independent.pid!, 0)).not.toThrow();
				expect(commitCount(repo)).toBe(1);
				expect(existsSync(join(repo, "产物.txt"))).toBe(true);
			} finally {
				controller.abort();
				await operation.catch(() => {});
				independent.kill();
			}
		},
		20000,
	);

	it("deliverCards 串行逐卡，单卡被拒不中断其余", async () => {
		const repo = makeRepo();
		const a = await makeDeliverableCard(repo, "甲卡");
		// 乙卡停在待认领，必被拒
		const cardDir = a.cardDir;
		const b = await createCard(cardDir, { 目标: "乙卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:05" });
		const before = commitCount(repo);

		const results = await deliverCards(cardDir, [a.cardNo, b.card_no]);

		expect(results).toHaveLength(2);
		expect(results[0]?.交卷).toBe(true);
		expect(results[1]?.交卷).toBe(false);
		expect(results[1]?.原因).toBe("状态非已交付");
		expect(commitCount(repo)).toBe(before + 1);
	}, 20000);

	it("pao_deliver_card 工具：卡号数组批量、文本带逐卡结果与未推送提示", async () => {
		const repo = makeRepo();
		const a = await makeDeliverableCard(repo, "甲卡");
		const b = await createCard(a.cardDir, { 目标: "乙卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:05" });
		const cardDir = a.cardDir;
		const tools = setup(cardDir);

		const out = await tools.get("pao_deliver_card")!.execute("t1", { card_ref: [a.cardNo, b.card_no] });
		const text = out.content[0].text;
		expect(text).toContain("已交卷");
		expect(text).toContain(`卡${String(a.cardNo).padStart(4, "0")} 甲卡 · delivered · 机械验收通过`);
		expect(text).toContain("拒绝交卷"); // 乙卡待认领被拒
		expect(text).toContain("未推送");
		// 未提供卡目录且未配置默认目录 → 结构化报错
		const bare = setup();
		await expect(bare.get("pao_deliver_card")!.execute("t2", { card_ref: 1 })).rejects.toThrow(/卡目录/);
	}, 20000);
});

// ── S8-内核2（回执对账）：worker 交付回执增「未完成 todo」面 ──────────────────
// 权威清单来自 scanTodoState(getBranch())（todo/index.ts 纯函数），delivery 只做对账呈现；
// 语义红线：todo 全勾≠卡验收通过——验收衔接门判定零改动，todo 数据只是对账信息。

/** 假会话分支：单条成功 todo_write toolResult（权威清单的重建载体，同 todo-write.test.ts 口径） */
function todoBranch(todos: TodoItem[]): SessionEntry[] {
	return [
		{
			type: "message",
			id: `m-todo-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: new Date().toISOString(),
			parentId: undefined,
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "todo_write",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: { version: 1, todos },
				timestamp: Date.now(),
			},
		} as unknown as SessionEntry,
	];
}

describe("pao_deliver_card：回执未完成待办对账（S8-内核2）", () => {
	it("有未完成待办 → 回执附对账段：未开始/进行中分列，已取消单列标注语义，已完成项不上榜", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		const branch = todoBranch([
			{ content: "写报告", status: "completed" },
			{ content: "补证据", status: "pending" },
			{ content: "跑长测", status: "in_progress" },
			{ content: "试方案A", status: "cancelled" },
		]);

		const r = await deliverCard(cardDir, cardNo, { 会话分支: branch });

		expect(r.交卷).toBe(true);
		expect(r.消息).toContain("未完成待办对账");
		expect(r.消息).toContain("不参与验收判定"); // 信息面声明（对账≠验收）
		expect(r.消息).toContain("未开始");
		expect(r.消息).toContain("补证据");
		expect(r.消息).toContain("进行中");
		expect(r.消息).toContain("跑长测");
		expect(r.消息).toContain("已取消");
		expect(r.消息).toContain("试方案A");
		expect(r.消息).toContain("不计未完成"); // cancelled 语义单列标注
		expect(r.消息).not.toContain("写报告"); // 已完成项不进对账段
		// 交卷本体行为不变
		expect(r.提交哈希).toBeTruthy();
		expect(commitCount(repo)).toBe(2);
	}, 20000);

	it("全勾 → 回执正常无对账段；验收衔接判定不变：未过仍拒交，全勾不解锁交卷", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);
		const done = todoBranch([
			{ content: "写报告", status: "completed" },
			{ content: "跑测试", status: "completed" },
		]);
		const r = await deliverCard(cardDir, cardNo, { 会话分支: done });
		expect(r.交卷).toBe(true);
		expect(r.提交哈希).toBeTruthy();
		expect(r.消息).toContain("已交卷"); // 回执正常
		expect(r.消息).not.toContain("待办对账"); // 全勾无对账段

		// 验收红线：机械验收未过 + todo 全勾 → 依旧拒绝交卷（todo 数据不参与验收判定）
		const repo2 = makeRepo();
		const dir2 = join(repo2, ".pao", "卡");
		mkdirSync(dir2, { recursive: true });
		const card = await createCard(dir2, { 目标: "未过卡", 部门: "核心机制", 验收: "x", 创建: "2026-10-02 10:00" });
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
		await snapshotClaimBaseline(dir2, card.card_no);
		writeFileSync(join(repo2, "产物.txt"), "x\n");
		const claimed = loadCard(dir2, card.card_no);
		changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 10:30" });
		appendVerdictRaw(dir2, card.card_no, "- 结论: 未过");
		const before = commitCount(repo2);

		const r2 = await deliverCard(dir2, card.card_no, {
			会话分支: todoBranch([{ content: "全做完", status: "completed" }]),
		});

		expect(r2.交卷).toBe(false);
		expect(r2.原因).toBe("机械验收未过");
		expect(r2.消息).toContain("拒绝交卷");
		expect(commitCount(repo2)).toBe(before);
	}, 20000);

	it("无 todo 历史/空清单/仅剩已取消 → 回执不添对账段", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo);

		const noHistory = await deliverCard(cardDir, cardNo, { 会话分支: [] });
		expect(noHistory.交卷).toBe(true);
		expect(noHistory.消息).not.toContain("待办对账");

		// 首交后无改动，后续两次走幂等路径（回执照出，依旧不添段）
		const emptied = todoBranch([]);
		const r2 = await deliverCard(cardDir, cardNo, { 会话分支: emptied });
		expect(r2.消息).toContain("幂等");
		expect(r2.消息).not.toContain("待办对账");

		const onlyCancelled = todoBranch([{ content: "试方案B", status: "cancelled" }]);
		const r3 = await deliverCard(cardDir, cardNo, { 会话分支: onlyCancelled });
		expect(r3.消息).toContain("幂等");
		expect(r3.消息).not.toContain("待办对账");
	}, 20000);

	it("工具接线：pao_deliver_card 从 ctx.sessionManager.getBranch() 取权威清单组装回执", async () => {
		const repo = makeRepo();
		const { cardDir, cardNo } = await makeDeliverableCard(repo, "接线卡");
		const tools = setup(cardDir);
		const ctx = { sessionManager: { getBranch: () => todoBranch([{ content: "清尾巴", status: "pending" }]) } };

		const out = await tools.get("pao_deliver_card")!.execute("t9", { card_ref: cardNo }, undefined, undefined, ctx);

		expect(out.content[0].text).toContain("已交卷");
		expect(out.content[0].text).toContain("未完成待办对账");
		expect(out.content[0].text).toContain("清尾巴");
	}, 20000);
});
describe("pao_deliver_card：产物提交只含 worker 真实产出", () => {
	it("自定布局下基线快照/黑板.md/四指标账.txt 不进交卷 commit（豁免清单兜底）", async () => {
		const repo = makeRepo();
		// 自定布局：卡目录在仓库根的 卡/，派发链自写文件落在仓库根（不在 .pao 内）
		const cardDir = join(repo, "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "豁免卡",
			部门: "核心机制",
			验收: "存在: 产出/hello.txt",
			创建: "2026-10-05 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-05 10:01" });
		await snapshotClaimBaseline(cardDir, card.card_no, { owner: "部长A", 时间: "2026-10-05 10:01" });
		// worker 真实产出 + 派发链自写文件（黑板/账；基线快照认领时已自动落 repo/基线/）
		mkdirSync(join(repo, "产出"), { recursive: true });
		writeFileSync(join(repo, "产出", "hello.txt"), "hello\n");
		writeFileSync(join(repo, "黑板.md"), "# 任务黑板\n");
		writeFileSync(join(repo, "四指标账.txt"), "# 四指标账\n");
		const delivered = loadCard(cardDir, card.card_no);
		changeCardStatus(delivered, { 操作者: "部长A", to: "delivered", 时间: "2026-10-05 10:30" });
		appendVerdictRaw(cardDir, card.card_no, "- 结论: 全过自动交付");

		const r = await deliverCard(cardDir, card.card_no);

		expect(r.交卷).toBe(true);
		expect(r.暂存文件).toEqual(["产出/hello.txt"]);
		// commit 内容核对：只有 worker 真实产出，系统文件一个不进
		const committed = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
			.trim()
			.split(/\r?\n/)
			.filter(Boolean);
		expect(committed).toEqual(["产出/hello.txt"]);
		// 系统文件仍留在工作树（不被提交也不被清除）
		const status = git(repo, ["status", "--porcelain", "-uall"]);
		expect(status).toContain("黑板.md");
		expect(status).toContain("四指标账.txt");
	}, 20000);
});
