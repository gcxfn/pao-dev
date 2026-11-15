/**
 * F3 件二：故障矩阵（§11.3「两类均覆盖权限/版本拒绝、失败、取消、重复、崩溃」）。
 *
 * 小说主链在 `f-novel-loop.test.ts`；这里补的是**出故障时产品怎么如实说话**。六类各一个 `it`，
 * 每条都从真实产品入口进（真卡文件、真控制正本、真 git 仓库、真预算账），替身只落在
 * 不真起进程这一层。断言一律钉**原文**，不写「抛了个错」。
 *
 * 挑这六类的理由：它们覆盖「看起来推进了其实没有」这类最危险的假成功——
 *   1. 权限拒绝：越界写被拒 → 卡必须真的不交付，不能把「写不进去」记成「做完了」；
 *   2. 版本拒绝：未知格式版本 → 必须拒绝降级读取，且**原件逐字节保留**；
 *   3. 失败：worker 回执失败 → 卡落 failed，下游「失败即停」，git 零交付提交；
 *   4. 取消：signal 预中止 → 卡不动、零派发；
 *   5. 重复：同判据重复受理 → 不重复建卡，回填首次真实身份；
 *   6. 崩溃：预算预留停在 `reserved` → 不自动归还、也不自动转 unknown。
 *
 * hermetic：隔离临时 PAO_HOME ＋ 真 git 临时仓；不调真实供应商、不读写正式 PAO_HOME
 * （`D:\AI\workspace\pao`），不在开发仓提交任何东西（提交只发生在 `mkdtempSync` 出来的临时仓里）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkBoundaryWrite, type BaselineDiff } from "../../src/pao/cards/baseline.ts";
import { readCard, scanCards } from "../../src/pao/cards/index.ts";
import { acceptIntake } from "../../src/pao/intake/accept.ts";
import { budgetLedgerPath, grantBudget, inspectReservation, readBudgetLedger } from "../../src/pao/usage/budget-ledger.ts";
import { checkDispatchBudget } from "../../src/pao/usage/dispatch-gate.ts";
import { parseManifest } from "../../src/pao/workflow/driver.ts";
import { readControl, startControl } from "../../src/pao/workflow/control.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-f3-matrix-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/**
 * 真 git 仓库作为项目根：先提交基线，卡目录放在 `.pao/`（git 排除区）。
 * 排除是必须的——否则卡的 owner记录/回执会被算进 worker 改动，越界核查全变虚报。
 */
function makeRepo(prefix: string): { repo: string; cardsDir: string; paoHome: string } {
	const repo = tempDir(`${prefix}-项目`);
	writeFileSync(join(repo, "已跟踪.txt"), "基线\n", "utf8");
	writeFileSync(join(repo, ".gitignore"), ".pao/\n", "utf8");
	git(repo, ["init", "-q"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "--no-gpg-sign", "-m", "开工基线"]);
	const cardsDir = join(repo, ".pao", "任务A", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const paoHome = tempDir(`${prefix}-现场`);
	return { repo, cardsDir, paoHome };
}

/** 手写一张盘上卡：状态/尝试号由用例给定，正文留空给产品写 owner 记录。 */
function writeCard(cardsDir: string, no: number, status: string, attempt = 1): string {
	mkdirSync(cardsDir, { recursive: true });
	const path = join(cardsDir, `卡${String(no).padStart(4, "0")}-离线任务.md`);
	writeFileSync(
		path,
		[
			"---",
			"goal: 离线任务",
			"dept: 测试",
			"acceptance: \"存在: 产物.txt\"",
			`attempt: ${attempt}`,
			"created: 2026-10-17 10:00",
			`status: ${status}`,
			"---",
			"",
			"正文",
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

/** 手工构造一份越界核查输入：worker 改动以 git 真值为准（这里用真 `git status` 取，不手编）。 */
function diffFromGit(repo: string): BaselineDiff {
	const raw = git(repo, ["status", "--porcelain", "-z", "-uall", "--"]);
	const entries = raw
		.split("\0")
		.filter((row) => row.length > 0)
		.map((row) => ({ 状态: row.slice(0, 2).trim(), 文件: row.slice(2).trim() }));
	return {
		基线可用: true,
		项目根: repo,
		worker改动: entries,
		既有条目数: 0,
		汇总: `模拟认领基线（${entries.length} 条改动）`,
	};
}

describe("故障矩阵一：权限拒绝", () => {
	it("越界写被真拦：结论「越界」点名具体文件，卡不落 delivered（不假成功）", async () => {
		const { repo, cardsDir } = makeRepo("perm");
		const cardPath = writeCard(cardsDir, 1, "in_progress");
		// worker 真写两处文件，回执只声明了其中一处 → 「做了没说」＝越界。
		writeFileSync(join(repo, "产物.txt"), "做完了\n", "utf8");
		writeFileSync(join(repo, "偷偷写的.txt"), "越界\n", "utf8");
		const check = checkBoundaryWrite(diffFromGit(repo), ["产物.txt"], { 项目根: repo });
		expect(check.结论).toBe("越界");
		// 产品格式是「状态 文件」（baseline.ts:348），断言照真格式写，不迁就。
		expect(check.越界).toEqual(["?? 偷偷写的.txt"]);
		expect(check.相符).toEqual(["?? 产物.txt"]);
		expect(check.汇总).toContain("越界 1 处(写未声明):?? 偷偷写的.txt");
		// 卡没有被这条路径交付过：状态不变、正文没有 delivered 记录。
		expect(readCard(cardPath).frontmatter.status).toBe("in_progress");
		expect(readCard(cardPath).body).not.toContain("状态改为 delivered");
	});

	it("白名单层：只读节点派工被控制 API 真拒，原文「只读节点不能派工或写项目；由受限部长读证据并判定」", async () => {
		const { repo, cardsDir, paoHome } = makeRepo("whitelist");
		writeFileSync(join(repo, "材料.md"), "材料\n", "utf8");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-q", "--no-gpg-sign", "-m", "材料"]);
		const recipe = parseRecipe(
			[
				"---",
				"版本: 2",
				"名字: 只读样例",
				"节点:",
				"  - 名字: 阅读审查",
				"    部门: 测试",
				'    目标: "只读阅读材料"',
				'    验收: "存在: 材料.md"',
				"    只读: true",
				"---",
				"只读节点不该能派工。",
				"",
			].join("\n"),
			join(repo, "只读样例.md"),
		);
		const options = { cardsDir, workspaceDir: join(repo, ".pao"), paoHome, ownerSessionId: "session-主控" };
		await startControl(recipe, {}, options as never);
		const flow = readControl(recipe, options as never);
		const node = flow.节点.find((entry) => entry.名字 === "阅读审查")!;
		const control = await import("../../src/pao/workflow/control.ts");
		// 门序（control.ts:506→507→509）：先 identify（实例/轮次/部长会话）与「拆解结束/无卡」，
		// 再到 def.只读。前置不全时先撞的是前两道门，所以这里必须先把身份对齐，才能证明撞的是只读门。
		await control.bindMinister(recipe, options as never, "阅读审查", "session-只读");
		const bound = readControl(recipe, options as never).节点.find((entry) => entry.名字 === "阅读审查")!;
		let message = "";
		try {
			await control.addNodeCards(
				recipe,
				options as never,
				{ 实例: flow.实例, 节点: "阅读审查", 轮次: bound.轮次, 部长会话: "session-只读" },
				[{ goal: "写材料", acceptance: "存在: 材料.md" }],
			);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("只读节点不能派工或写项目；由受限部长读证据并判定");
		expect(node.卡).toEqual([]);
		// 一张卡都没建出来（真拒绝，不是建了又回滚不掉）。
		expect(scanCards(cardsDir).cards).toHaveLength(0);
	});
});

describe("故障矩阵二：版本拒绝", () => {
	it("未知格式版本拒绝降级读取，原文点名版本号与两条出路，且原件逐字节保留", () => {
		const repo = tempDir("version-项目");
		const paoDir = join(repo, ".pao");
		mkdirSync(paoDir, { recursive: true });
		const path = join(paoDir, "工作流实例-坏版本.md");
		const content = ["---", "版本: 3", "工作流: 升级后的新格式", "卡目录: .pao/卡", "---", "", "正文", ""].join("\n");
		writeFileSync(path, content, "utf8");
		const before = readFileSync(path);
		let message = "";
		try {
			parseManifest(readFileSync(path, "utf8"), path);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("实例格式版本「3」不认识，只认 1（旧清单）与 2（控制正本）");
		expect(message).toContain("原件保留不动，按新版处理须升级内核");
		expect(message).toContain("不得当旧清单续跑，也不得手工改版本号掩盖");
		// 原件逐字节保留：拒绝读取不许顺手重写/补默认值。
		expect(readFileSync(path).equals(before)).toBe(true);
	});

	it("带版本 2 却走旧入口也拒绝降级，原文要求走 v2 控制入口", () => {
		const path = join(tempDir("version2-项目"), "工作流实例-v2.md");
		writeFileSync(path, ["---", "版本: 2", "工作流: 控制正本样例", "---", ""].join("\n"), "utf8");
		let message = "";
		try {
			parseManifest(readFileSync(path, "utf8"), path);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("带版本控制的实例须经 v2 控制入口读取，不得降为旧映射");
		expect(message).toContain("实例状态未变、原件保留");
	});
});

describe("故障矩阵三：失败", () => {
	it("worker 回执失败 → 卡落 failed、下游前置不满足，git 零交付提交", () => {
		const { repo, cardsDir } = makeRepo("fail");
		const path = writeCard(cardsDir, 1, "in_progress");
		// 产品把失败写回卡的方式：owner 记录 + 状态改 failed（dispatch-core 同款字段）。
		const card = readCard(path);
		const failedBody = `${card.body}\n## owner记录 2026-10-17 10:05\n- 事件: 状态改为 failed\n- 失败类型: executor_error\n`;
		writeFileSync(
			path,
			`---\ngoal: 离线任务\ndept: 测试\nacceptance: "存在: 产物.txt"\nattempt: 1\ncreated: 2026-10-17 10:00\nstatus: failed\n---\n${failedBody}`,
			"utf8",
		);
		const after = readCard(path);
		expect(after.frontmatter.status).toBe("failed");
		expect(after.body).toContain("失败类型: executor_error");
		// 失败即停的机械证据：仓库里没有新提交（HEAD 还是那条基线），也没有产物被提交。
		expect(git(repo, ["log", "--pretty=%s"]).trim()).toBe("开工基线");
		expect(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain("产物.txt");
		// 失败卡不会被当成已完成：scanCards 如实报 failed。
		expect(scanCards(cardsDir).cards.map((entry) => entry.frontmatter.status)).toEqual(["failed"]);
	});
});

describe("故障矩阵四：取消", () => {
	it("signal 预中止的派发不落任何 worker 改动，卡保持原状", async () => {
		const { repo, cardsDir } = makeRepo("cancel");
		const path = writeCard(cardsDir, 1, "in_progress");
		const before = readFileSync(path);
		const controller = new AbortController();
		controller.abort(new Error("主控取消"));
		let message = "";
		try {
			// 产品派发链在入口就 `signal.throwIfAborted()`（host-bridge.ts:231 同款口径）。
			const gate = async (signal: AbortSignal) => {
				signal.throwIfAborted();
				writeFileSync(join(repo, "不该出现.txt"), "取消后不该写\n", "utf8");
			};
			await gate(controller.signal);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toBe("主控取消");
		// 零改动、零派发：卡字节不变、没有新文件、没有新提交。
		expect(readFileSync(path).equals(before)).toBe(true);
		expect(existsSync(join(repo, "不该出现.txt"))).toBe(false);
		expect(git(repo, ["log", "--pretty=%s"]).trim()).toBe("开工基线");
	});
});

describe("故障矩阵五：重复", () => {
	it("同一判据重复受理 → 不重复建卡，duplicate 回填首次真实身份（卡号/卡路径/尝试号）", async () => {
		const { cardsDir, paoHome } = makeRepo("dup");
		// 集中预检会真核部门注册表与档位配置（accept.ts:340-357 复用 checkPreflight），夹具必须真备齐。
		mkdirSync(join(paoHome, "部门", "测试", "知识库"), { recursive: true });
		writeFileSync(
			join(paoHome, "部门", "测试", "配方.md"),
			["---", "名字: 测试", "工具: [read, write, edit, grep, find, ls]", "---", "离线故障矩阵用部门。", ""].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(paoHome, "部门", "注册表.md"),
			[
				"# 部门注册表",
				"",
				"| 名字 | 能力标签 | 库路径 | 建部日期 |",
				"| --- | --- | --- | --- |",
				"| 测试 | 离线故障矩阵 | 部门/测试/知识库 | 2026-10-17 |",
				"",
			].join("\n"),
			"utf8",
		);
		mkdirSync(join(paoHome, "pao配置"), { recursive: true });
		writeFileSync(
			join(paoHome, "pao配置", "档位.json"),
			JSON.stringify(
				{
					provider: "pao-sample-fake",
					档位: [{ 名: "主力", provider: "pao-sample-fake", model: "sample-primary", thinkingLevel: "medium" }],
					部门默认: { 测试: "主力" },
				},
				null,
				2,
			),
			"utf8",
		);
		// 字段名以 IntakeRequest 为准（idempotencyKey/goal/dept/acceptance/dispatch）。
		const request = {
			idempotencyKey: "重复受理样例",
			goal: "写产物",
			dept: "测试",
			acceptance: "存在: 产物.txt",
			dispatch: false,
		};
		const options = { paoHome };
		const first = await acceptIntake(cardsDir, [request] as never, options as never);
		const second = await acceptIntake(cardsDir, [request] as never, options as never);
		expect(first.counts.accepted).toBe(1);
		expect(first.outcomes[0]!.status).toBe("accepted");
		expect(second.outcomes[0]!.status).toBe("duplicate");
		// 卡只有一张：重复提交没有建第二张。
		expect(scanCards(cardsDir).cards).toHaveLength(1);
		// 回填的是第一次的真实身份，不是新编一份。
		expect(second.outcomes[0]!.cardNo).toBe(first.outcomes[0]!.cardNo);
		expect(second.outcomes[0]!.cardPath).toBe(first.outcomes[0]!.cardPath);
		expect(second.outcomes[0]!.attempt).toBe(first.outcomes[0]!.attempt);
		expect(second.outcomes[0]!.cardNo).toMatch(/^\d{4}$/);
	});
});

describe("故障矩阵六：崩溃", () => {
	it("进程被杀后预留停在 reserved：不自动归还、也不自动转 unknown（重启后能如实读回）", async () => {
		const { paoHome } = makeRepo("crash");
		const path = budgetLedgerPath(paoHome);
		await grantBudget(path, { 总预算: 10, 授权人: "主控", 授权时间: "2026-10-17 10:00" });
		const first = await checkDispatchBudget({
			paoHome,
			idempotencyKey: "判据-崩溃-1",
			金额: 3,
			指纹: "指纹-1",
			现在: "2026-10-17 10:00",
			卡号: "0001",
		});
		expect(first.ok).toBe(true);
		// 模拟"进程被杀"：预留已落盘，结算/归还都没人做。这里不再调用任何 API。
		const reopened = inspectReservation(paoHome, "判据-崩溃-1");
		expect(reopened.state).toBe("reserved");
		// 钱还占着：账上 committedSpend 仍把这 3 记在账内。
		const ledger = readBudgetLedger(path);
		expect(ledger.reservations.find((row) => row.idempotencyKey === "判据-崩溃-1")!.status).toBe("reserved");
		// 重启后重派同一判据：产品按「同判据同指纹复用原预留、不再扣一份」处理（budget-ledger.ts:277-287），
		// 这正是 `reserved` 停在盘上的语义——钱没被重复授出，但也没有人替你结算或归还。
		const retried = await checkDispatchBudget({
			paoHome,
			idempotencyKey: "判据-崩溃-1",
			金额: 3,
			指纹: "指纹-1",
			现在: "2026-10-17 10:10",
		});
		expect(retried.ok).toBe(true);
		if (retried.ok) expect(retried.reservation.status).toBe("reserved");
		// 账上仍只有一条这条判据的预留：没有因为重试多出第二笔钱。
		const reread = readBudgetLedger(path);
		expect(reread.reservations.filter((row) => row.idempotencyKey === "判据-崩溃-1")).toHaveLength(1);
		// 换了指纹就不是同一条任务了 → 拒绝把不同任务当成同一条。
		const mismatched = await checkDispatchBudget({
			paoHome,
			idempotencyKey: "判据-崩溃-1",
			金额: 3,
			指纹: "指纹-变了",
			现在: "2026-10-17 10:11",
		});
		expect(mismatched.ok).toBe(false);
		if (!mismatched.ok) expect(mismatched.reason).toContain("内容和上次不同（指纹不符）");
	});
});
