/**
 * 完整任务受理（intake）的行为钉：计划 §5.2「一次调用返回受理身份或真实拒绝原因」。
 *
 * 覆盖（任务卡 ⑧）：
 * - 单条成功：返回**真实卡号**，卡文件真的落在卡目录（不是回显入参）；
 * - 三入口共用同一函数：CLI/桌面/批量三个适配层结果与 acceptIntake 完全一致（同一业务入口的证明：
 *   只传 options 差异不改变判断，且三者的 reject 原因文案同源）；
 * - 部分受理：一批里有部门不存在的条 → 该条 rejected 且原因是预检的真实原因（部门未登记），
 *   其余条照常受理，partial=true；
 * - 重复提交：同判据再交一次 → duplicate，卡目录文件数不变、卡号计数器不推进，
 *   且回填**第一次**的真实身份（卡号/卡路径/受理时间）；
 * - 停止后失效：卡被停止（取消）后 isIntakeOutcomeStale 返回 true（§5.4 不得再用旧回执判成功）。
 *
 * 纪律：不调真实模型供应商、不碰正式 PAO_HOME——一律隔离临时 PAO_HOME + 真 git 临时仓；
 * 派发用假通道（记录调用，不 spawn），派发链本身的行为由 worker-dispatch*.test.ts 覆盖。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeCardStatus, readCard } from "../../src/pao/cards/index.ts";
import {
	acceptIntake,
	acceptIntakeBatch,
	acceptIntakeCli,
	acceptIntakeDesktop,
	type IntakeOptions,
	type IntakeRequest,
	intakeLedgerPath,
	isIntakeOutcomeStale,
} from "../../src/pao/intake/index.ts";

const tempDirs: string[] = [];
const envKeys = ["PAO_ROLE", "PAO_DEPT", "PAO_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of envKeys) savedEnv[key] = process.env[key];
	// 派单权限按角色判定：测试里固定为主控（非部长），不受开发机环境影响
	process.env.PAO_ROLE = "主控";
	delete process.env.PAO_DEPT;
});

afterEach(() => {
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

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** 隔离 PAO_HOME：注册表里登记「测试」部门（含配方），档位配置齐备——预检能真的过。 */
function makePaoHome(depts: string[] = ["测试"]): string {
	const home = tempDir("home");
	mkdirSync(join(home, "部门"), { recursive: true });
	const rows = depts.map((dept) => `| ${dept} | 编码 | 知识库/${dept} | 2026-10-01 |`).join("\n");
	writeFileSync(
		join(home, "部门", "注册表.md"),
		["# 部门注册表", "", "| 名字 | 能力标签 | 库路径 | 建部日期 |", "| --- | --- | --- | --- |", rows, ""].join("\n"),
		"utf8",
	);
	for (const dept of depts) {
		mkdirSync(join(home, "部门", dept), { recursive: true });
		writeFileSync(join(home, "部门", dept, "配方.md"), `# ${dept} 配方\n\n离线测试用配方。\n`, "utf8");
	}
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(
		join(home, "pao配置", "档位.json"),
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
	return home;
}

/** 真 git 临时仓：仓库根即任务工作区上级，提交干净基线供认领快照。 */
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

/** 假派发通道：只记录调用，不拉起任何进程。 */
function fakeDispatch(): {
	calls: { cardNo: string; operator: string; key: string; reason?: string }[];
	hook: NonNullable<IntakeOptions["dispatchInBackground"]>;
} {
	const calls: { cardNo: string; operator: string; key: string; reason?: string }[] = [];
	const hook: NonNullable<IntakeOptions["dispatchInBackground"]> = (input, _dispatchOptions, key, cardNo) => {
		calls.push({ cardNo, operator: input.operator, key, reason: input.dispatch_reason });
	};
	return { calls, hook };
}

function request(overrides: Partial<IntakeRequest> = {}): IntakeRequest {
	return {
		idempotencyKey: "k-1",
		goal: "离线受理测试任务",
		dept: "测试",
		acceptance: "契约齐备且卡文件落盘",
		dispatch: false,
		...overrides,
	};
}

/** 卡目录里的卡文件数（不含锁目录/临时文件）。 */
function cardFileCount(cardsDir: string): number {
	if (!existsSync(cardsDir)) return 0;
	return readdirSync(cardsDir).filter((name) => /^卡\d{4}-.*\.md$/.test(name)).length;
}

function counterValue(repo: string): string | undefined {
	// createCard 的缺省计数器在最近 .pao/ 下（卡目录是 .pao/任务A/卡 → .pao/卡号.txt）
	const path = join(repo, ".pao", "卡号.txt");
	return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

describe("acceptIntake:单条成功返回真实卡号（不是回显入参）", () => {
	it("建卡落盘、返回四位卡号与真实路径、账内记下首次身份", async () => {
		const { repo, cardsDir } = makeRepo("intake-ok");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;

		const report = await acceptIntake(cardsDir, [request()], { paoHome });
		expect(report.counts.accepted).toBe(1);
		expect(report.counts.rejected).toBe(0);
		expect(report.partial).toBe(false);
		expect(report.outcomes).toHaveLength(1);

		const outcome = report.outcomes[0];
		expect(outcome.idempotencyKey).toBe("k-1");
		expect(outcome.status).toBe("accepted");
		// 真实卡号：与卡目录里实际存在的文件名一致
		expect(outcome.cardNo).toBe("0001");
		expect(cardFileCount(cardsDir)).toBe(1);
		expect(existsSync(outcome.cardPath ?? "")).toBe(true);
		expect(outcome.cardPath?.endsWith("卡0001-离线受理测试任务.md")).toBe(true);
		// dispatch=false：没派发就没有尝试号（未启动就没有尝试，不编 0）
		expect(outcome.attempt).toBeUndefined();
		// 实例/节点/轮次是工作流身份，普通卡没有，如实留空
		expect(outcome.instance).toBeUndefined();
		expect(outcome.node).toBeUndefined();
		expect(outcome.round).toBeUndefined();
		// 卡面事实与返回一致
		const card = readCard(outcome.cardPath ?? join(cardsDir, "卡0001-离线受理测试任务.md"));
		expect(card.frontmatter.goal).toBe("离线受理测试任务");
		expect(card.frontmatter.dept).toBe("测试");
		expect(card.frontmatter.status).toBe("unclaimed");
		expect(card.frontmatter.attempt).toBe(0);
		// 幂等账已落盘，记的是真实身份
		const ledger = JSON.parse(readFileSync(intakeLedgerPath(cardsDir), "utf8"));
		expect(ledger.version).toBe(1);
		expect(ledger.entries).toHaveLength(1);
		expect(ledger.entries[0]).toMatchObject({ idempotencyKey: "k-1", cardNo: "0001" });
		expect(ledger.entries[0].pending).toBeUndefined();
		expect(counterValue(repo)).toBe("1");
	});

	it("预检问题按级别带进 problems；预算缺省时带「未验证」项", async () => {
		const { cardsDir } = makeRepo("intake-problems");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;

		const report = await acceptIntake(cardsDir, [request({ idempotencyKey: "k-prob" })], { paoHome });
		const [outcome] = report.outcomes;
		expect(outcome.status).toBe("accepted");
		// 受理成功但风险如实带出：预算未提供 + 动态条件等都是「未验证」级别
		expect(outcome.problems.length).toBeGreaterThan(0);
		expect(outcome.problems.every((item) => item.level !== "阻止启动")).toBe(true);
		expect(outcome.problems.some((item) => item.subject === "预算")).toBe(true);
	});
});

describe("acceptIntake:三入口共用同一函数（只做参数适配）", () => {
	it("同一批请求经 CLI/桌面/批量三条入口与直调 acceptIntake 结果一致", async () => {
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;
		const direct = makeRepo("intake-direct");
		const cli = makeRepo("intake-cli");
		const desktop = makeRepo("intake-desktop");
		const batch = makeRepo("intake-batch");

		const reports = await Promise.all([
			acceptIntake(direct.cardsDir, [request({ idempotencyKey: "same" })], { paoHome }),
			acceptIntakeCli({
				cardsDir: cli.cardsDir,
				requests: [request({ idempotencyKey: "same" })],
				options: { paoHome },
			}),
			acceptIntakeDesktop({
				cardsDir: desktop.cardsDir,
				requests: [request({ idempotencyKey: "same" })],
				options: { paoHome },
				sessionId: "会话-1",
			}),
			acceptIntakeBatch({
				cardsDir: batch.cardsDir,
				requests: [request({ idempotencyKey: "same" })],
				options: { paoHome },
			}),
		]);

		const shape = (report: (typeof reports)[number]) =>
			report.outcomes.map((outcome) => ({
				idempotencyKey: outcome.idempotencyKey,
				status: outcome.status,
				cardNo: outcome.cardNo,
				problemSubjects: outcome.problems.map((item) => item.subject),
			}));
		expect(reports.map(shape)).toEqual([shape(reports[0]), shape(reports[0]), shape(reports[0]), shape(reports[0])]);
		// 三条适配入口都真的建了卡（走的是同一个 createCard），卡号各自从 1 开始
		for (const repo of [direct, cli, desktop, batch]) {
			expect(cardFileCount(repo.cardsDir)).toBe(1);
			expect(counterValue(repo.repo)).toBe("1");
		}
	});

	it("缺 PAO_HOME 时三入口给同一条真实拒绝文案（同一出口一个真相）", async () => {
		const { cardsDir } = makeRepo("intake-nohome");
		const reports = await Promise.all([
			acceptIntake(cardsDir, [request()], { paoHome: "" }),
			acceptIntakeCli({ cardsDir, requests: [request()], options: { paoHome: "" } }),
			acceptIntakeDesktop({ cardsDir, requests: [request()], options: { paoHome: "" } }),
			acceptIntakeBatch({ cardsDir, requests: [request()], options: { paoHome: "" } }),
		]);
		for (const report of reports) {
			expect(report.counts.rejected).toBe(1);
			expect(report.outcomes[0].reason).toContain("缺 PAO_HOME");
		}
		// 没受理就不建卡
		expect(cardFileCount(cardsDir)).toBe(0);
	});
});

describe("acceptIntake:部分受理（单条失败不拖垮整批，原因是预检真实原因）", () => {
	it("部门不存在的条被拒且写明「部门未登记或名称非法」，其余条照常受理", async () => {
		const { cardsDir } = makeRepo("intake-partial");
		const paoHome = makePaoHome(["测试"]);
		process.env.PAO_HOME = paoHome;

		const report = await acceptIntake(
			cardsDir,
			[
				request({ idempotencyKey: "good", goal: "好任务" }),
				request({ idempotencyKey: "bad", goal: "坏任务", dept: "不存在的部门" }),
				request({ idempotencyKey: "good2", goal: "另一个好任务" }),
			],
			{ paoHome },
		);

		expect(report.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "rejected", "accepted"]);
		expect(report.counts).toEqual({ accepted: 2, rejected: 1, duplicate: 0, deferred: 0 });
		expect(report.partial).toBe(true);

		const rejected = report.outcomes[1];
		// 真实拒绝原因来自预检（部门未登记），不是「受理失败」这种无信息的话
		expect(rejected.reason).toContain("部门未登记或名称非法：不存在的部门");
		// 拒绝的条目不建卡，也没有卡号
		expect(rejected.cardNo).toBeUndefined();
		expect(rejected.cardPath).toBeUndefined();
		expect(rejected.problems.some((item) => item.level === "阻止启动" && item.subject === "部门")).toBe(true);

		// 只有两条被受理建了卡，卡号连续
		expect(cardFileCount(cardsDir)).toBe(2);
		expect(report.outcomes[0].cardNo).toBe("0001");
		expect(report.outcomes[2].cardNo).toBe("0002");
		// 失败条目的占位必须撤掉（否则该判据被永久锁死）
		const ledger = JSON.parse(readFileSync(intakeLedgerPath(cardsDir), "utf8"));
		expect(ledger.entries.map((entry: { idempotencyKey: string }) => entry.idempotencyKey)).toEqual([
			"good",
			"good2",
		]);
	});

	it("失败后同判据重试能成功受理（占位已撤回，判据没被锁死）", async () => {
		const { cardsDir } = makeRepo("intake-retry");
		const paoHome = makePaoHome(["测试"]);
		process.env.PAO_HOME = paoHome;

		const first = await acceptIntake(cardsDir, [request({ idempotencyKey: "retry", dept: "不存在的部门" })], {
			paoHome,
		});
		expect(first.outcomes[0].status).toBe("rejected");
		expect(cardFileCount(cardsDir)).toBe(0);

		// 用户改好部门后同一判据重试：必须真的受理，不能判成 duplicate 却查无此卡
		const second = await acceptIntake(cardsDir, [request({ idempotencyKey: "retry", dept: "测试" })], { paoHome });
		expect(second.outcomes[0].status).toBe("accepted");
		expect(second.outcomes[0].cardNo).toBe("0001");
		expect(cardFileCount(cardsDir)).toBe(1);
	});
});

describe("acceptIntake:重复提交不重复建卡（幂等，回填第一次身份）", () => {
	it("同判据再交一次：duplicate、卡文件数不变、计数器不推进、身份与首次一致", async () => {
		const { repo, cardsDir } = makeRepo("intake-dup");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;

		const first = await acceptIntake(cardsDir, [request({ idempotencyKey: "dup-key" })], { paoHome });
		expect(first.outcomes[0].status).toBe("accepted");
		const firstOutcome = first.outcomes[0];
		const filesAfterFirst = cardFileCount(cardsDir);
		const counterAfterFirst = counterValue(repo);
		const ledgerRawAfterFirst = readFileSync(intakeLedgerPath(cardsDir), "utf8");

		// 第二次提交：改了目标也不影响——判据相同即同一次受理
		const second = await acceptIntake(cardsDir, [request({ idempotencyKey: "dup-key", goal: "改过的目标" })], {
			paoHome,
		});
		const dup = second.outcomes[0];
		expect(dup.status).toBe("duplicate");
		expect(second.counts).toEqual({ accepted: 0, rejected: 0, duplicate: 1, deferred: 0 });
		expect(second.partial).toBe(false);

		// 不重复建卡、不发新号
		expect(cardFileCount(cardsDir)).toBe(filesAfterFirst);
		expect(counterValue(repo)).toBe(counterAfterFirst);
		// 身份回填的是第一次的真实值
		expect(dup.cardNo).toBe(firstOutcome.cardNo);
		expect(dup.cardPath).toBe(firstOutcome.cardPath);
		expect(dup.acceptedAt).toBe(firstOutcome.acceptedAt);
		// 首次受理快照也在，下游不必再查一遍账
		expect(dup.duplicateOf?.status).toBe("accepted");
		expect(dup.duplicateOf?.cardNo).toBe(firstOutcome.cardNo);
		expect(dup.duplicateOf?.cardPath).toBe(firstOutcome.cardPath);
		// 账未被重复提交污染：条目仍是一条，身份未变
		expect(readFileSync(intakeLedgerPath(cardsDir), "utf8")).toBe(ledgerRawAfterFirst);

		// 第三、四次也一样（幂等要能反复成立，不是一次性的）
		const third = await acceptIntake(cardsDir, [request({ idempotencyKey: "dup-key" })], { paoHome });
		expect(third.outcomes[0].status).toBe("duplicate");
		expect(third.outcomes[0].cardNo).toBe(firstOutcome.cardNo);
		expect(cardFileCount(cardsDir)).toBe(1);
	});

	it("同一批里出现两次同判据：先到者建卡，后者判 duplicate", async () => {
		const { cardsDir } = makeRepo("intake-dup-batch");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;

		const report = await acceptIntake(
			cardsDir,
			[
				request({ idempotencyKey: "same-in-batch", goal: "第一次" }),
				request({ idempotencyKey: "same-in-batch", goal: "第二次" }),
			],
			{ paoHome },
		);
		expect(report.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "duplicate"]);
		expect(report.outcomes[1].cardNo).toBe(report.outcomes[0].cardNo);
		expect(cardFileCount(cardsDir)).toBe(1);
	});

	it("dispatch=true 的同判据重交不会重复派发", async () => {
		const { cardsDir } = makeRepo("intake-dup-dispatch");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;
		const dispatch = fakeDispatch();

		const first = await acceptIntake(
			cardsDir,
			[request({ idempotencyKey: "dup-dispatch", dispatch: true, reason: "首次派单" })],
			{ paoHome, dispatchInBackground: dispatch.hook },
		);
		expect(first.outcomes[0].status).toBe("accepted");
		expect(dispatch.calls).toHaveLength(1);
		expect(dispatch.calls[0]).toMatchObject({ cardNo: first.outcomes[0].cardNo, reason: "首次派单" });

		const second = await acceptIntake(
			cardsDir,
			[request({ idempotencyKey: "dup-dispatch", dispatch: true, reason: "再派一次" })],
			{ paoHome, dispatchInBackground: dispatch.hook },
		);
		expect(second.outcomes[0].status).toBe("duplicate");
		// 关键：重复提交不重复派发
		expect(dispatch.calls).toHaveLength(1);
		expect(second.outcomes[0].cardNo).toBe(first.outcomes[0].cardNo);
	});
});

describe("acceptIntake:派发与推迟（经注入通道，不自己 spawn）", () => {
	it("dispatch=true 且装配了通道：卡被受理后经通道派出，理由进派遣输入", async () => {
		const { cardsDir } = makeRepo("intake-dispatch");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;
		const dispatch = fakeDispatch();

		const report = await acceptIntake(
			cardsDir,
			[request({ idempotencyKey: "d-1", dispatch: true, reason: "离线派单理由" })],
			{ paoHome, dispatchInBackground: dispatch.hook },
		);
		const outcome = report.outcomes[0];
		expect(outcome.status).toBe("accepted");
		expect(dispatch.calls).toHaveLength(1);
		expect(dispatch.calls[0].cardNo).toBe(outcome.cardNo);
		expect(dispatch.calls[0].key).toContain(`卡${outcome.cardNo}`);
		expect(dispatch.calls[0].operator).toBe("主控");
		// 后台链认领尚未发生 → 尝试号如实留空
		expect(outcome.attempt).toBeUndefined();
	});

	it("dispatch=true 但宿主没装通道：卡建好、状态 deferred 且说明原因", async () => {
		const { cardsDir } = makeRepo("intake-nohook");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;

		const report = await acceptIntake(
			cardsDir,
			[request({ idempotencyKey: "nh-1", dispatch: true, reason: "要派" })],
			{ paoHome },
		);
		const outcome = report.outcomes[0];
		expect(outcome.status).toBe("deferred");
		expect(outcome.cardNo).toBe("0001");
		expect(outcome.reason).toContain("宿主未装配派发通道");
		expect(cardFileCount(cardsDir)).toBe(1);
	});

	it("dispatch=true 但缺派单理由：拒绝且不建卡", async () => {
		const { cardsDir } = makeRepo("intake-noreason");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;
		const dispatch = fakeDispatch();

		const report = await acceptIntake(cardsDir, [request({ idempotencyKey: "nr-1", dispatch: true })], {
			paoHome,
			dispatchInBackground: dispatch.hook,
		});
		expect(report.outcomes[0].status).toBe("rejected");
		expect(report.outcomes[0].reason).toContain("派单理由");
		expect(cardFileCount(cardsDir)).toBe(0);
		expect(dispatch.calls).toHaveLength(0);
	});

	it("依赖未放行：卡建好但 deferred，说明等哪张卡", async () => {
		const { cardsDir } = makeRepo("intake-deps");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;
		const dispatch = fakeDispatch();

		const report = await acceptIntake(
			cardsDir,
			[request({ idempotencyKey: "dep-1", depends_on: ["0009"], dispatch: true, reason: "等前序" })],
			{ paoHome, dispatchInBackground: dispatch.hook },
		);
		const outcome = report.outcomes[0];
		expect(outcome.status).toBe("deferred");
		expect(outcome.reason).toContain("依赖未放行");
		expect(outcome.reason).toContain("卡0009");
		expect(dispatch.calls).toHaveLength(0);
	});
});

describe("isIntakeOutcomeStale:停止后旧结果不得当成功（§5.4）", () => {
	it("受理成功后卡被停止（取消）→ 旧 outcome 失效", async () => {
		const { cardsDir } = makeRepo("intake-stale");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;

		const report = await acceptIntake(cardsDir, [request({ idempotencyKey: "stale-1" })], { paoHome });
		const outcome = report.outcomes[0];
		expect(outcome.status).toBe("accepted");
		// 刚受理、卡还在待认领 → 未失效
		expect(isIntakeOutcomeStale(outcome, cardsDir)).toBe(false);

		// 用户停止：卡落取消（终态）
		const card = readCard(outcome.cardPath ?? "");
		changeCardStatus(card, { 操作者: "用户", to: "canceled", 依据: "用户停止", 时间: "2026-10-03 10:00" });
		expect(readCard(card.path).frontmatter.status).toBe("canceled");

		expect(isIntakeOutcomeStale(outcome, cardsDir)).toBe(true);
	});

	it("卡被删除 → 失效；重派开了新尝试 → 失效；尝试号一致且未终结 → 未失效", async () => {
		const { cardsDir } = makeRepo("intake-stale2");
		const paoHome = makePaoHome();
		process.env.PAO_HOME = paoHome;

		const report = await acceptIntake(cardsDir, [request({ idempotencyKey: "stale-2" })], { paoHome });
		const outcome = report.outcomes[0];
		const cardPath = outcome.cardPath ?? "";

		// 尝试号记录与卡面一致 → 未失效
		const withAttempt = { ...outcome, attempt: 1 };
		const card = readCard(cardPath);
		changeCardStatus(card, {
			操作者: "主控",
			to: "in_progress",
			依据: "认领",
			时间: "2026-10-22 10:00",
		});
		expect(readCard(cardPath).frontmatter.attempt).toBe(1);
		expect(isIntakeOutcomeStale(withAttempt, cardsDir)).toBe(false);

		// 尝试号已不是当时那个（重派开了新尝试）→ 失效
		expect(isIntakeOutcomeStale({ ...outcome, attempt: 0 }, cardsDir)).toBe(true);

		// 卡文件被删 → 失效（查不到就不许说成功）
		rmSync(cardPath, { force: true });
		expect(isIntakeOutcomeStale(outcome, cardsDir)).toBe(true);
	});
});
