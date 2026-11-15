/**
 * F1 件一：T19 重开不重派 / 强杀停在 reserved / 坏文件与未知格式各自可诊断且原件保留 /
 * 坏账本报 BAD_LEDGER 不静默重置。
 *
 * 本文件补的是**恢复期**的口径——G3（`format-version-boundary.test.ts`）证过"读得出就报对"，
 * 但没证过三件事，正是线上最容易出事的：
 *
 * 1. **重开不重派**：`worker/index.ts:700` 的 `inFlight` 是会话级内存 Map（同文件 :697 注释
 *    「会话级内存态,R25 重启归零;卡文件状态与回执是真相」）。所以"重开不重派"绝不能靠它，
 *    只能靠盘上事实——这里把桥/模块状态整个重建一遍再派，看是否真的不重放。
 * 2. **强杀停在 reserved**：进程被杀时预算预留没人结算。它必须**停在** reserved：
 *    不自动归还（钱可能真花了）、不自动转 unknown（unknown 是"知道出了问题"的判定，
 *    得有人查清才配得上这个结论）。这两个"不"是本卡最容易被"好心清理"改坏的地方。
 * 3. **坏文件/未知格式各自文案带文件名与原因，原件逐字节保留，且同目录好对象照常可读**——
 *    不能因为一个坏文件把整段读穿。
 *
 * hermetic：临时 PAO_HOME + 临时项目根（真 git 仓库，交卷走真 commit），FakeRunner 替身
 * 不出真进程，不调真实供应商，不读写正式 PAO_HOME。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { readCard, scanCards } from "../../src/pao/cards/index.ts";
import {
	desktopOwner,
	desktopOwnerEntry,
	readDesktopWorkerActivity,
	registerDesktopOwner,
} from "../../src/pao/desktop/owners.ts";
import { intakeLedgerPath, readIntakeLedger } from "../../src/pao/intake/ledger.ts";
import {
	budgetLedgerPath,
	committedSpend,
	grantBudget,
	inspectReservation,
	readBudgetLedger,
} from "../../src/pao/usage/budget-ledger.ts";
import { checkDispatchBudget } from "../../src/pao/usage/dispatch-gate.ts";
import { registerWorkerTools } from "../../src/pao/worker/index.ts";
import { DISPATCH_NOTIFY_SECTION } from "../../src/pao/worker/notify.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";
import { fireSessionShutdownHandlers } from "./fixtures/session-shutdown.ts";

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PAO_HOME", "PAO_ROLE", "PAO_DEPT"] as const;
const shutdowns: (() => unknown)[] = [];

afterEach(async () => {
	await fireSessionShutdownHandlers(shutdowns.splice(0));
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-f19-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** git 仓库 fixture：仓库根即项目根；卡目录在 .pao/任务A/卡（git 排除区,不污染差分）。 */
function makeRepo(prefix: string): { repo: string; cardsDir: string } {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	const cardsDir = join(repo, ".pao", "任务A", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return { repo, cardsDir };
}

interface Captured {
	tools: ReturnType<typeof wrapToolDefinition>[];
	pi: ExtensionAPI;
	fireBeforeAgentStart(): Record<string, string>;
	/** 派卡通知面（宿主在 before_agent_start 注入的那段）。 */
	dispatchNotice(): string;
}

/**
 * 假宿主：只实现 registerWorkerTools 用到的三个面（registerTool/on/sendMessage）。
 * 每次调用＝一个"全新进程"的全部模块内存态——重开测试靠它，不靠 mock 清缓存。
 */
function capturePi(): Captured {
	const captured: Captured = {
		tools: [],
		pi: undefined as unknown as ExtensionAPI,
		fireBeforeAgentStart: () => ({}),
		dispatchNotice: () => "",
	};
	const handlers = new Map<string, ((event: unknown) => void)[]>();
	captured.fireBeforeAgentStart = () => {
		const sections: Record<string, string> = {};
		for (const handler of handlers.get("before_agent_start") ?? []) handler({ systemPromptOptions: { sections } });
		return sections;
	};
	captured.dispatchNotice = () => captured.fireBeforeAgentStart()[DISPATCH_NOTIFY_SECTION] ?? "";
	captured.pi = {
		registerTool: (tool: ToolDefinition) => captured.tools.push(wrapToolDefinition(tool)),
		on: (event: string, handler: (event: unknown) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			if (event === "session_shutdown") shutdowns.push(handler as () => unknown);
			return () => {};
		},
		registerCommand: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	return captured;
}

function toolOf(captured: Captured, name: string): Captured["tools"][number] {
	const tool = captured.tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`未注册 ${name}，实际:${captured.tools.map((entry) => entry.name).join("、")}`);
	return tool;
}

function textOf(result: AgentToolResult): string {
	const content = result.content;
	return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** 假运行器：登记进真实注册表→跑注入脚本→返回回执。可控"卡住不返回"用于强杀场景。 */
class FakeRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	script: ((options: WorkerRunOptions) => Promise<WorkerReceipt> | WorkerReceipt) | undefined;
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		this.registry.register({
			pid: 920000 + this.runs.length,
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号,
			command: "fake-runner",
			dept: options.部门 ?? null,
			dispatch_reason: options.派单理由 ?? null,
		});
		if (!this.script) throw new Error("FakeRunner 未配置脚本");
		const receipt = await this.script(options);
		this.registry.markExited(920000 + this.runs.length);
		return receipt;
	}
}

interface Fixture {
	repo: string;
	cardsDir: string;
	paoHome: string;
	runner: FakeRunner;
	/** 每次调用＝重建一套全新的工具注册（模拟重开进程），共用同一个 runner 以便数 runs。 */
	boot(): { captured: Captured; face: ReturnType<typeof registerWorkerTools> };
}

function setup(prefix: string): Fixture {
	const { repo, cardsDir } = makeRepo(prefix);
	const paoHome = tempDir(`${prefix}-现场`);
	const runner = new FakeRunner();
	const fixture: Fixture = {
		repo,
		cardsDir,
		paoHome,
		runner,
		boot() {
			const captured = capturePi();
			const face = registerWorkerTools(captured.pi, {
				resolvePaoHome: () => paoHome,
				resolveCardsDir: () => cardsDir,
				runner,
				signals: false,
			});
			return { captured, face };
		},
	};
	return fixture;
}

/** 在卡目录里手写一张卡（不派发，只作为盘上已有状态）。created 必须是 "YYYY-MM-DD HH:mm"。 */
function writeCard(cardsDir: string, no: number, status: string, attempt: number): string {
	mkdirSync(cardsDir, { recursive: true });
	const path = join(cardsDir, `卡${String(no).padStart(4, "0")}-离线任务.md`);
	const lines = [
		"---",
		"goal: 离线任务",
		"dept: 测试",
		'acceptance: "存在: 产物.txt"',
		`attempt: ${attempt}`,
		"created: 2026-10-17 10:00",
		`status: ${status}`,
		"---",
		"正文",
		"",
	];
	writeFileSync(path, lines.join("\n"), "utf8");
	return path;
}

// ── T19-1 重开不重派 ──────────────────────────────────────────────────────
describe("T19-1 重开不重派", () => {
	it("在途卡重开后：卡仍 in_progress、不再拉起、拒因说的是结果未知而不是重放", async () => {
		const f = setup("重开在途");
		const cardPath = writeCard(f.cardsDir, 1, "in_progress", 1);
		const before = readFileSync(cardPath);

		// 第一次启动：卡已在 in_progress（模拟上一进程认领后被杀），派它应当被同步面拒
		const first = f.boot();
		const firstOut = textOf(
			(await toolOf(first.captured, "pao_dispatch_card").execute("t1", {
				card_ref: "1",
				reason: "重启后试着再派一次",
			})) as never,
		);
		expect(firstOut).toContain("派单未执行");
		// 原文案用 (in_progress)：说"在先前的尝试手中、不双跑"，且给出 owner 的下一步
		expect(firstOut).toContain("in_progress");
		expect(firstOut).toContain("不双跑");
		// 关键文案：说"结果未知，先查现场，重启后不盲重放"，而不是含糊的"已派出"
		expect(firstOut).toContain("结果未知");
		expect(firstOut).toContain("重启后不盲重放");
		expect(f.runner.runs).toHaveLength(0);

		// 重开：全新一套工具注册（全新 inFlight Map），同一个进程里的"重开"最像真实重启的部分
		const second = f.boot();
		const secondOut = textOf(
			(await toolOf(second.captured, "pao_dispatch_card").execute("t2", {
				card_ref: "1",
				reason: "重开后再派一次",
			})) as never,
		);
		expect(secondOut).toContain("派单未执行");
		expect(secondOut).toContain("重启后不盲重放");

		// ① 一次都没拉起（这是"不重派"的硬证据）
		expect(f.runner.runs).toHaveLength(0);
		// ② 卡文件逐字节不变：重开没有把在途卡"重写"成别的状态
		expect(readFileSync(cardPath).equals(before)).toBe(true);
		expect(readCard(cardPath).frontmatter.status).toBe("in_progress");
	});

	it("已有回执的在途卡重开后：按回执处理、同号不重派，且回执仍在盘上", async () => {
		const f = setup("重开有回执");
		writeCard(f.cardsDir, 2, "in_progress", 1);
		// 手写一份当前尝试的回执（模拟上一进程已落回执但没来得及落终态就被杀）。
		// 段标题格式是冻结契约：`## 回执 尝试N YYYY-MM-DD HH:mm`（cardfile.ts:464 RECEIPT_HEADING_PATTERN），
		// 字段写成 `- result:` 平铺行——写成嵌套 YAML 的话 readCard 解析不出回执，会走成"无回执"分支。
		const cardPath = join(f.cardsDir, "卡0002-离线任务.md");
		const original = readFileSync(cardPath, "utf8");
		const withReceipt = `${original.trimEnd()}\n\n## 回执 尝试1 2026-10-17 10:05\n- result: success\n- summary: 上一进程已完成\n`;
		writeFileSync(cardPath, withReceipt, "utf8");
		const before = readFileSync(cardPath);
		// 先自证夹具成立：回执确实被解析出来了，当前尝试确有回执
		const parsed = readCard(cardPath);
		expect(parsed.receipts.filter((receipt) => receipt.attempt === 1 && !receipt.archive_flag)).toHaveLength(1);

		const booted = f.boot();
		const out = textOf(
			(await toolOf(booted.captured, "pao_dispatch_card").execute("t1", {
				card_ref: "2",
				reason: "重开后按回执收尾",
			})) as never,
		);

		expect(out).toContain("派单未执行");
		// 有回执分支的专属文案：说"同号不重派、按回执处理"，而不是"结果未知"
		expect(out).toContain("in_progress");
		expect(out).toContain("同号不重派");
		expect(out).toContain("按回执处理");
		expect(out).not.toContain("重启后不盲重放");
		expect(f.runner.runs).toHaveLength(0);
		expect(readFileSync(cardPath).equals(before)).toBe(true);
	});

	it("重开后正常对象仍可展示：已终态卡照常读出、坏卡被单独报出而不是拖垮整批", async () => {
		const f = setup("重开展示");
		writeCard(f.cardsDir, 3, "delivered", 1);
		// 造一张坏卡（frontmatter 不合法）：必须进 problems，不能污染好卡
		writeFileSync(join(f.cardsDir, "卡0004-坏卡.md"), "---\ngoal: 缺必填\n---\n", "utf8");

		const scan = scanCards(f.cardsDir);
		expect(scan.cards.map((card) => card.card_no)).toContain(3);
		expect(scan.problems).toHaveLength(1);
		expect(scan.problems[0]!.path).toContain("卡0004-坏卡.md");
		expect(scan.problems[0]!.reason.length).toBeGreaterThan(0);
	});
});

// ── T19-2 强杀停在 reserved ──────────────────────────────────────────────
describe("T19-2 强杀后预算预留停在 reserved", () => {
	it("预留后无人结算 → inspectReservation 仍 reserved，不自动归还也不自动转 unknown", async () => {
		const home = tempDir("强杀现场");
		await grantBudget(budgetLedgerPath(home), {
			总预算: 10,
			授权人: "测试用户",
			授权时间: "2026-10-17T10:00:00.000Z",
		});
		const 判据 = "派发:卡0001:尝试1";
		const verdict = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: 判据,
			金额: 4,
			指纹: "fp",
			现在: "2026-10-17T10:00:00.000Z",
		});
		expect(verdict.ok).toBe(true);

		// 强杀＝此后没有任何代码再动这笔账。模拟时间过去很久后再读。
		const 状态 = inspectReservation(home, 判据);
		expect(状态.state).toBe("reserved"); // 不是 released（不自动归还）
		expect(状态.state).not.toBe("unknown"); // 也不是 unknown（不自动下"结果不明"的结论）
		if (状态.state !== "missing") {
			expect(状态.reservation.预留额).toBe(4);
			expect(状态.reservation.已结算费用).toBeUndefined();
			expect(状态.reservation.结算时间).toBeUndefined();
		}

		// 钱继续占着：committedSpend 计 reserved 的预留额
		expect(committedSpend(readBudgetLedger(budgetLedgerPath(home)))).toBe(4);

		// 同一判据再来一次：复用那条预留，不再扣一份（不因为"可能已经死了"就重新授额）
		const again = await checkDispatchBudget({
			paoHome: home,
			idempotencyKey: 判据,
			金额: 4,
			指纹: "fp",
			现在: "2027-10-17T10:00:00.000Z",
		});
		expect(again.ok).toBe(true);
		const after = readBudgetLedger(budgetLedgerPath(home));
		expect(after.reservations).toHaveLength(1);
		expect(committedSpend(after)).toBe(4);
	});
});

// ── T19-3 坏文件与未知格式：可诊断 + 原件保留 ─────────────────────────────
describe("T19-3 坏文件与未知格式各自可诊断且原件逐字节保留", () => {
	it("预算账是未知版本 → BAD_LEDGER，消息带文件名与版本号，原文一字不动", async () => {
		const home = tempDir("坏账版本");
		mkdirSync(home, { recursive: true });
		const path = budgetLedgerPath(home);
		const 原文 = `${JSON.stringify({ version: 7, grants: [], reservations: [] }, null, 2)}\n`;
		writeFileSync(path, 原文, "utf8");
		const before = readFileSync(path);

		let error: Error | undefined;
		try {
			readBudgetLedger(path);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error).toBeDefined();
		expect((error as { code?: string }).code).toBe("BAD_LEDGER");
		// 文案三要素：哪来的（文件名/路径）、为什么（版本不认识）、下一步（不许手工猜）
		expect(error!.message).toContain("总预算账");
		expect(error!.message).toContain(path);
		expect(error!.message).toMatch(/版本|形状/);

		// 原件逐字节保留：读坏账不会顺手"修"它
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("预算账不是 JSON → BAD_LEDGER 且拒绝猜额度，原文一字不动", async () => {
		const home = tempDir("坏账JSON");
		mkdirSync(home, { recursive: true });
		const path = budgetLedgerPath(home);
		writeFileSync(path, "{ 这不是 JSON 而是垃圾", "utf8");
		const before = readFileSync(path);

		let error: Error | undefined;
		try {
			readBudgetLedger(path);
		} catch (caught) {
			error = caught as Error;
		}
		expect((error as { code?: string }).code).toBe("BAD_LEDGER");
		expect(error!.message).toContain("拒绝猜到额度");
		expect(error!.message).toContain(path);
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("受理账是未知版本 → 版本不认识、不自动迁移，原文一字不动", async () => {
		const repo = tempDir("受理账");
		const cardsDir = join(repo, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		const path = intakeLedgerPath(cardsDir);
		mkdirSync(join(path, ".."), { recursive: true });
		const 原文 = `${JSON.stringify({ version: 9, entries: [] }, null, 2)}\n`;
		writeFileSync(path, 原文, "utf8");
		const before = readFileSync(path);

		let error: Error | undefined;
		try {
			readIntakeLedger(path);
		} catch (caught) {
			error = caught as Error;
		}
		expect((error as { code?: string }).code).toBe("BAD_LEDGER");
		expect(error!.message).toContain("版本不认识");
		expect(error!.message).toContain("不自动迁移");
		expect(error!.message).toContain("9");
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("受理账 entries 形状不对 → 报形状而不是静默重置成空账", async () => {
		const repo = tempDir("受理账形状");
		const cardsDir = join(repo, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		const path = intakeLedgerPath(cardsDir);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ version: 1, entries: "不是数组" })}\n`, "utf8");
		const before = readFileSync(path);

		let error: Error | undefined;
		try {
			readIntakeLedger(path);
		} catch (caught) {
			error = caught as Error;
		}
		expect((error as { code?: string }).code).toBe("BAD_LEDGER");
		expect(error!.message).toContain("entries 须为数组");
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("受理账不存在 → 空账（不是错误），且不顺手创建文件", async () => {
		const repo = tempDir("受理账缺");
		const cardsDir = join(repo, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		const path = intakeLedgerPath(cardsDir);
		const ledger = readIntakeLedger(path);
		expect(ledger.version).toBe(1);
		expect(ledger.entries).toHaveLength(0);
		expect(existsSync(path)).toBe(false); // 只读不建档
	});
});

// ── T19-4 源主控关闭后旧动作失效（T14 内核侧另一半）────────────────────────
/**
 * `desktop/owners.ts` 的登记全靠 `pi.on(...)` 事件驱动真实生命周期：
 * `registerDesktopOwner`（:27）里 `session_start`/`session_tree` 走 `bind`（:36）登记、
 * `session_shutdown`（:49-51）注销。所以本组**不碰 owners 内部 Map**，
 * 只造一个能 fire 这三个事件的假宿主，让真实登记/注销逻辑自己跑。
 */
interface OwnerHost {
	pi: ExtensionAPI;
	fire(event: "session_start" | "session_tree" | "session_shutdown", sessionId: string, cwd: string): void;
}

/** 最小 ExtensionContext：owners.ts 只用到 `ctx.sessionManager.getSessionId()` 与 `ctx.cwd`（:38/:62）。 */
function ownerHost(): OwnerHost {
	const handlers = new Map<string, ((event: unknown, ctx: never) => void)[]>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: never) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		fire(event, sessionId, cwd) {
			const ctx = { sessionManager: { getSessionId: () => sessionId }, cwd } as never;
			for (const handler of handlers.get(event) ?? []) handler({}, ctx);
		},
	};
}

/** owners 是模块级 Map，用例之间会互相污染：每个用例用互不相同的 sessionId 与项目路径隔离。 */
describe("T19-4 源主控关闭后旧动作失效", () => {
	it("错 sessionId / 错项目路径 → 取不到，且拒因说的是「不能重放旧动作」", () => {
		const host = ownerHost();
		registerDesktopOwner(host.pi);
		const project = tempDir("owner项目");
		const sessionId = "会话-A";
		host.fire("session_start", sessionId, project);

		// 正路：会话与项目都对，取得到
		expect(desktopOwner(sessionId, project).ctx.sessionManager.getSessionId()).toBe(sessionId);

		// ① 换一个没登记过的 sessionId
		expect(() => desktopOwner("会话-没登记过", project)).toThrow("原会话 owner 不可用或已切换");
		expect(() => desktopOwner("会话-没登记过", project)).toThrow("请回到对应会话重新查看，不能重放旧动作");

		// ② 同一 sessionId 但项目路径不符（模拟旧动作被拿到另一个项目的视图上重放）
		const 别的项目 = tempDir("owner项目-别的");
		expect(() => desktopOwner(sessionId, 别的项目)).toThrow("原会话 owner 不可用或已切换");
		expect(() => desktopOwner(sessionId, 别的项目)).toThrow("不能重放旧动作");

		// getSessionId 不一致（同 key 但底层会话已切换）也要拒——owners.ts:62 的第二重校验
		const 换过底的 = ownerHost();
		registerDesktopOwner(换过底的.pi);
		换过底的.fire("session_start", "会话-B", project);
		const entry = desktopOwnerEntry("会话-B")!;
		// 不改 entry 本身，只从读入口确认它确实登记上了（不串到 会话-A）
		expect(entry.ctx.sessionManager.getSessionId()).toBe("会话-B");
	});

	it("源主控关闭（session_shutdown）→ owner 条目消失，取不到也不返回别人的数据", () => {
		const host = ownerHost();
		registerDesktopOwner(host.pi);
		const project = tempDir("owner关闭项目");
		const sessionId = "会话-要关的";
		host.fire("session_start", sessionId, project);
		expect(desktopOwnerEntry(sessionId)).toBeDefined();
		expect(desktopOwner(sessionId, project).ctx.cwd).toBe(project);

		// 源主控关闭：走真实 session_shutdown 处理器
		host.fire("session_shutdown", sessionId, project);

		// ① 条目真没了（不是残留）
		expect(desktopOwnerEntry(sessionId)).toBeUndefined();
		// ② 再取直接抛「不可用或已切换」，而不是返回某个别人的 entry
		expect(() => desktopOwner(sessionId, project)).toThrow("原会话 owner 不可用或已切换");
		expect(() => desktopOwner(sessionId, project)).toThrow("不能重放旧动作");
	});

	it("同项目多会话依次登记：先登记的一个都不丢（不互相顶替）", () => {
		const host = ownerHost();
		registerDesktopOwner(host.pi);
		const project = tempDir("owner多会话");
		host.fire("session_start", "会话-一号", project);
		expect(desktopOwner("会话-一号", project).ctx.sessionManager.getSessionId()).toBe("会话-一号");

		host.fire("session_start", "会话-二号", project);
		// 修复前：一号在这里被顶掉（owners.ts 旧实现用一个闭包变量 id 记「当前该删哪条」）
		expect(desktopOwnerEntry("会话-一号")).toBeDefined();
		expect(desktopOwnerEntry("会话-二号")).toBeDefined();

		host.fire("session_start", "会话-三号", project);
		// 三个都在，且各指自己——同项目不等于可以互相顶替
		expect(desktopOwner("会话-一号", project).ctx.sessionManager.getSessionId()).toBe("会话-一号");
		expect(desktopOwner("会话-二号", project).ctx.sessionManager.getSessionId()).toBe("会话-二号");
		expect(desktopOwner("会话-三号", project).ctx.sessionManager.getSessionId()).toBe("会话-三号");
	});
});

describe("T19-4b owner 注册按会话精确增删（缺陷修复后的回归）", () => {
	it("关掉其中一个会话：只清它自己，其余会话的 owner 与读投影都还在", () => {
		const host = ownerHost();
		registerDesktopOwner(host.pi);
		const project = tempDir("owner关一个");
		host.fire("session_start", "会话-A", project);
		host.fire("session_start", "会话-B", project);

		// 关 B：A 必须活着（修复前旧实现的 shutdown 只删「最后登记的那个 id」，这里会连 A 一起删）
		host.fire("session_shutdown", "会话-B", project);
		expect(desktopOwnerEntry("会话-B")).toBeUndefined();
		expect(desktopOwnerEntry("会话-A")).toBeDefined();
		expect(desktopOwner("会话-A", project).ctx.sessionManager.getSessionId()).toBe("会话-A");
		// 关掉的 B 再取照样被闸门拦住
		expect(() => desktopOwner("会话-B", project)).toThrow("不能重放旧动作");
	});

	it("session_tree 切分支：同会话原地刷新，不丢同 pi 的其他会话", () => {
		const host = ownerHost();
		registerDesktopOwner(host.pi);
		const project = tempDir("owner切分支");
		host.fire("session_start", "会话-A", project);
		host.fire("session_start", "会话-B", project);

		// 切 A 的分支（sessionId 不变）——这是单窗口就能复现的路径，修复前 B 会在这里被丢掉
		host.fire("session_tree", "会话-A", project);
		expect(desktopOwnerEntry("会话-A")).toBeDefined();
		expect(desktopOwnerEntry("会话-B")).toBeDefined();
		expect(desktopOwner("会话-A", project).ctx.sessionManager.getSessionId()).toBe("会话-A");
		expect(desktopOwner("会话-B", project).ctx.sessionManager.getSessionId()).toBe("会话-B");
	});

	it("不同 pi 互不干扰：两个宿主各管各的会话集", () => {
		const 宿主甲 = ownerHost();
		const 宿主乙 = ownerHost();
		registerDesktopOwner(宿主甲.pi);
		registerDesktopOwner(宿主乙.pi);
		const project = tempDir("owner双宿主");
		宿主甲.fire("session_start", "甲-会话", project);
		宿主乙.fire("session_start", "乙-会话", project);
		expect(desktopOwnerEntry("甲-会话")).toBeDefined();
		expect(desktopOwnerEntry("乙-会话")).toBeDefined();

		// 乙关掉自己的会话，不许碰到甲的
		宿主乙.fire("session_shutdown", "乙-会话", project);
		expect(desktopOwnerEntry("乙-会话")).toBeUndefined();
		expect(desktopOwnerEntry("甲-会话")).toBeDefined();
		expect(desktopOwner("甲-会话", project).ctx.sessionManager.getSessionId()).toBe("甲-会话");
	});

	it("三会话同项目登记后：readDesktopWorkerActivity 统计到全部三行（活性不漏人）", () => {
		const project = tempDir("owner活性");
		const cardPath = join(project, ".pao", "卡", "卡0001-甲.md");
		mkdirSync(join(project, ".pao", "卡"), { recursive: true });
		writeFileSync(cardPath, "---\ngoal: x\n---\n", "utf8");

		const host = ownerHost();
		// 三会话同项目，各自登记一条在跑的 worker（卡路径落在项目根内才会计入）
		registerDesktopOwner(host.pi, {
			getWorkerActivity: () => [
				{
					pid: 1,
					card_no: "0001",
					command: "fixture-worker",
					card_path: cardPath,
					run_id: "run-1",
					登记时间: "2026-10-17T00:00:00.000Z",
					running: true,
					dept: null,
					dispatch_reason: null,
				},
			],
			getSilenceMinutes: () => 5,
		});
		host.fire("session_start", "会话-甲", project);
		host.fire("session_start", "会话-乙", project);
		host.fire("session_start", "会话-丙", project);

		const rows = readDesktopWorkerActivity(project);
		// 修复前 owners 里只剩最后一个会话，只能统计到 1 行——活性统计漏人
		expect(rows).toHaveLength(3);
		expect(rows.map((row) => row.会话).sort()).toEqual(["会话-丙", "会话-乙", "会话-甲"].sort());
		expect(rows.every((row) => row.运行中)).toBe(true);
		expect(rows.every((row) => row.静默分钟 === 5)).toBe(true);
	});
});
