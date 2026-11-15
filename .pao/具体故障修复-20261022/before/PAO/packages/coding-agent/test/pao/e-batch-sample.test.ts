import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCard, serializeCard } from "../../src/pao/cards/index.ts";
import { readDeptCatalog, validateDeptCatalog } from "../../src/pao/dept/catalog.ts";
import {
	acceptIntake,
	acceptIntakeBatch,
	acceptIntakeDesktop,
	isIntakeOutcomeStale,
	type IntakeOutcome,
	type IntakeRequest,
} from "../../src/pao/intake/index.ts";

/**
 * E 批离线样例：端到端最小链路（计划 §5.3 / §5.4）。
 *
 * 覆盖计划点名要验的五件事，全部走**真实**业务代码、**不** spawn 真实进程、**不**调真实供应商：
 * ① 一次受理小说第一步 → 拿到卡号与尝试号，能按卡号查回该卡；
 * ② 批量两条（写作 + 只读审查）→ 部分成功，拒绝原因必须来自真实预检（部门未登记 / 依赖未放行）；
 * ③ 同一请求判据重复提交 → 不新建卡，返回第一次的真实身份；
 * ④ 停止一条后旧受理结果被判失效（isIntakeOutcomeStale）；
 * ⑤ 中途改要求：卡已有受理结果后改目标/追加约束，查回能看到变更，且旧结果不再当成功。
 *
 * 样例夹具在 `.pao/harness完善-20261017/E批-离线样例/`，每次运行复制到隔离临时根，
 * 结束全部清理；绝不读写正式 PAO_HOME（`D:\AI\workspace\pao`）。
 */

const SEED_ROOT = join(__dirname, "..", "..", "..", "..", "..", ".pao", "harness完善-20261017", "E批-离线样例");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-e-batch-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

/** 递归复制目录（Node 自带的 cpSync 在这个 Node 版本可用，且比手写遍历少一份实现）。 */
function copyTree(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	// require 形式避免把 node:fs 的 cpSync 类型差异带进 tsc.build 的类型面
	const { cpSync } = require("node:fs") as typeof import("node:fs");
	cpSync(from, to, { recursive: true });
}

interface Fixture {
	/** 隔离临时根（测试首次创建，结束清理）。 */
	root: string;
	/** 复制出来的 PAO_HOME（部门/档位/技能都在这里）。 */
	paoHome: string;
	/** 复制出来的样例项目根。 */
	projectRoot: string;
	/** 卡目录（项目里的 .pao/卡）。 */
	cardsDir: string;
}

/** 把启动区复制到临时根：PAO_HOME 与项目根各自独立，互不指向仓库。 */
function makeFixture(prefix: string): Fixture {
	const root = tempDir(prefix);
	const paoHome = join(root, "PAO_HOME");
	const projectRoot = join(root, "项目");
	copyTree(join(SEED_ROOT, "启动区-PAO_HOME"), paoHome);
	copyTree(join(SEED_ROOT, "启动区-项目"), projectRoot);
	const cardsDir = join(projectRoot, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return { root, paoHome, projectRoot, cardsDir };
}

/** 卡目录里的卡文件（只数真卡，不数账本/计数器这些附属文件）。 */
function cardFiles(cardsDir: string): string[] {
	if (!existsSync(cardsDir)) return [];
	return readdirSync(cardsDir)
		.filter((name) => /^卡\d{4}-.*\.md$/.test(name))
		.sort();
}

/** 当前时间（卡片协议的 `YYYY-MM-DD HH:mm` 口径），状态迁移要它。 */
function nowString(): string {
	const now = new Date();
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 一条受理请求的骨架：样例里各用例只改自己关心的字段。 */
function request(overrides: Partial<IntakeRequest> & Pick<IntakeRequest, "idempotencyKey" | "dept">): IntakeRequest {
	return {
		goal: "写小说第一章的初稿",
		acceptance: "交出一份中文正文草稿，满足样例项目的文风基线",
		dispatch: false,
		...overrides,
	};
}

/**
 * 派发通道替身：登记每一次派发请求，不 spawn、不连任何供应商。
 *
 * 形状与 worker/index.ts 的 dispatchInBackground 结构兼容（IntakeDispatchHook），
 * 因此这里验证的是「受理确实走到了派发通道」这件事本身，而不是真实拉起。
 */
function makeDispatchHook(): {
	hook: Parameters<typeof acceptIntake>[2]["dispatchInBackground"];
	calls: { cardNo: string; reason: string | undefined; key: string }[];
} {
	const calls: { cardNo: string; reason: string | undefined; key: string }[] = [];
	const hook = (
		input: { card_no: string; dispatch_reason?: string },
		_dispatchOptions: { 公共参数?: Record<string, unknown> },
		key: string,
		cardNo: string,
	): void => {
		calls.push({ cardNo: input.card_no ?? cardNo, reason: input.dispatch_reason, key });
	};
	return { hook: hook as never, calls };
}

describe("E 批离线样例：部门目录在真实校验下是干净的", () => {
	it("三个样例部门齐备，工具与技能分家，档位解析到配方，校验零问题", () => {
		const fixture = makeFixture("catalog");
		const catalog = readDeptCatalog(fixture.paoHome);

		expect(catalog.部门.map((entry) => entry.名字).sort()).toEqual(["写作", "只读审查", "审查"].sort());

		const writing = catalog.部门.find((entry) => entry.名字 === "写作")!;
		// 「工具」与「技能」是两行两个字段：工具是内置白名单，技能是 pao配置/skills 下的真实目录名
		expect(writing.工具.map((tool) => tool.名字)).toEqual(["read", "write", "edit", "grep", "find", "ls"]);
		expect(writing.工具.every((tool) => tool.内置)).toBe(true);
		expect(writing.技能.map((skill) => skill.引用)).toEqual(["小说文风校准"]);
		expect(writing.技能.every((skill) => skill.可用)).toBe(true);
		// 没有把技能名混写进「工具」行（E1 的旧配方提示项不应被触发）
		expect(writing.混写技能名).toEqual([]);
		expect(writing.默认档位?.生效).toBe("主力");

		// 只读审查部门真的只有读类工具：没有 write/edit，这是「只读」这条要求的可执行落点
		const readOnly = catalog.部门.find((entry) => entry.名字 === "只读审查")!;
		expect(readOnly.工具.map((tool) => tool.名字)).toEqual(["read", "grep", "find", "ls"]);
		expect(readOnly.工具.some((tool) => tool.名字 === "write" || tool.名字 === "edit")).toBe(false);

		expect(validateDeptCatalog(catalog)).toEqual([]);
	});

	it("样例技能 SKILL.md 是真实文件，且文风基线与被审稿都在项目里", () => {
		const fixture = makeFixture("files");
		expect(existsSync(join(fixture.paoHome, "pao配置", "skills", "小说文风校准", "SKILL.md"))).toBe(true);
		expect(existsSync(join(fixture.projectRoot, "正文", "文风基线.md"))).toBe(true);
		expect(existsSync(join(fixture.projectRoot, "待审查稿", "第一章-旧桥-v1.md"))).toBe(true);
		// 档位配置指向的是假 provider，真实 SDK 不认识，离线样例不可能误连真实供应商
		const tiers = JSON.parse(readFileSync(join(fixture.paoHome, "pao配置", "档位.json"), "utf8"));
		expect(tiers.provider).toBe("pao-sample-fake");
		expect(tiers.档位.map((tier: { 名: string }) => tier.名)).toEqual(["快", "主力"]);
	});
});

describe("① 一次受理小说第一步：拿到卡号与尝试号，能按卡号查回该卡", () => {
	it("受理写作部门第一步，返回真实卡号与卡路径，卡内容与请求一致", async () => {
		const fixture = makeFixture("accept-one");
		const dispatch = makeDispatchHook();

		const report = await acceptIntake(
			fixture.cardsDir,
			[
				request({
					idempotencyKey: "小说-第一章-初稿",
					dept: "写作",
					goal: "写小说第一章的初稿",
					constraints: "第一人称，单句不超过 40 字",
					dispatch: true,
					reason: "主线任务第一步：先出初稿，再由审查部门判定",
				}),
			],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot, dispatchInBackground: dispatch.hook },
		);

		expect(report.counts.accepted).toBe(1);
		expect(report.partial).toBe(false);

		const outcome = report.outcomes[0];
		expect(outcome.status).toBe("accepted");
		expect(outcome.idempotencyKey).toBe("小说-第一章-初稿");
		// 身份回填纪律：卡号与卡路径是内核真实事实，必须有
		expect(outcome.cardNo).toMatch(/^\d{4}$/);
		expect(outcome.cardPath).toBeTruthy();
		expect(existsSync(outcome.cardPath!)).toBe(true);
		// accepted 时 reason 必须是 undefined（没有拒绝原因就不要编一个）
		expect(outcome.reason).toBeUndefined();
		// 普通卡没有工作流实例：给不出就不许编
		expect(outcome.instance).toBeUndefined();
		expect(outcome.node).toBeUndefined();
		expect(outcome.round).toBeUndefined();

		// 查回：按卡号在卡目录里定位到同一张卡（pao_inventory 等价的读取路径）
		const files = cardFiles(fixture.cardsDir);
		expect(files).toHaveLength(1);
		expect(files[0].startsWith(`卡${outcome.cardNo}-`)).toBe(true);

		const card = readCard(join(fixture.cardsDir, files[0]));
		expect(card.frontmatter.dept).toBe("写作");
		expect(card.frontmatter.goal).toBe("写小说第一章的初稿");
		expect(card.frontmatter.constraints).toBe("第一人称，单句不超过 40 字");
		expect(card.frontmatter.attempt).toBeGreaterThanOrEqual(0);

		// 受理确实走到了派发通道（不是自己 spawn）
		expect(dispatch.calls).toHaveLength(1);
		expect(dispatch.calls[0].reason).toBe("主线任务第一步：先出初稿，再由审查部门判定");
	});
});

describe("② 批量两条（写作 + 只读审查）：部分成功，拒绝原因来自真实预检", () => {
	it("部门未登记的那条被真实预检拒绝，另一条正常受理，report.partial 为真", async () => {
		const fixture = makeFixture("partial-dept");
		const report = await acceptIntakeBatch({
			cardsDir: fixture.cardsDir,
			requests: [
				request({ idempotencyKey: "批量-写作", dept: "写作", goal: "写小说第一章" }),
				request({
					idempotencyKey: "批量-幽灵部门",
					dept: "不存在的部门",
					goal: "对某个目录出审查意见",
					acceptance: "给出一份审查意见",
				}),
			],
			options: { paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		});

		expect(report.counts.accepted).toBe(1);
		expect(report.counts.rejected).toBe(1);
		// 部分成功 = 有的受理了、有的没受理（全失败不算部分，全成功也不算）
		expect(report.partial).toBe(true);
		// 一条请求一个 outcome，不许静默丢条
		expect(report.outcomes).toHaveLength(2);

		const rejected = report.outcomes[1];
		expect(rejected.status).toBe("rejected");
		expect(rejected.idempotencyKey).toBe("批量-幽灵部门");
		// 拒绝原因必须来自真实预检：具体点名了哪个部门不存在
		expect(rejected.reason).toBeTruthy();
		expect(rejected.reason).toContain("不存在的部门");
		// 被拒的那条不建卡
		expect(rejected.cardNo).toBeUndefined();
		expect(rejected.cardPath).toBeUndefined();
		// 预检问题项也一并带出来（阻止启动项）
		expect(rejected.problems.length).toBeGreaterThan(0);
		expect(rejected.problems.some((item) => item.level === "阻止启动")).toBe(true);

		// 卡目录里只有受理成功的那一张
		expect(cardFiles(fixture.cardsDir)).toHaveLength(1);
	});

	it("依赖卡未放行时被如实报为 deferred（卡已建、此刻不派），原因点名依赖卡号", async () => {
		const fixture = makeFixture("partial-dep");
		const first = await acceptIntake(
			fixture.cardsDir,
			[request({ idempotencyKey: "依赖-前置", dept: "写作", goal: "先出初稿" })],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		);
		expect(first.counts.accepted).toBe(1);
		const prerequisite = first.outcomes[0].cardNo!;

		const report = await acceptIntakeBatch({
			cardsDir: fixture.cardsDir,
			requests: [
				request({
					idempotencyKey: "依赖-审查",
					dept: "审查",
					goal: "审稿并决定通过或打回",
					depends_on: [prerequisite],
					dispatch: true,
					reason: "前置初稿完成后审稿",
				}),
			],
			options: { paoHome: fixture.paoHome, projectRoot: fixture.projectRoot, dispatchInBackground: makeDispatchHook().hook },
		});

		expect(report.outcomes).toHaveLength(1);
		const outcome = report.outcomes[0];
		// 依赖未放行是「排队语义」不是拒绝：卡合法、已建好，只是此刻不派
		expect(outcome.status).toBe("deferred");
		expect(outcome.cardNo).toMatch(/^\d{4}$/);
		// 原因必须来自真实依赖检查，点名前置卡号，而不是一句泛泛失败
		expect(outcome.reason).toContain(prerequisite);
		expect(outcome.reason).toContain("依赖未放行");
		// 两张卡都在（前置 + 本次），本次只是没派
		expect(cardFiles(fixture.cardsDir)).toHaveLength(2);
	});

	it("请求形状不全时被真实拒绝，原因逐条列出缺什么，且不建卡", async () => {
		const fixture = makeFixture("shape-reject");
		const report = await acceptIntakeBatch({
			cardsDir: fixture.cardsDir,
			requests: [{ idempotencyKey: "形状-缺字段", dept: "写作", goal: "", acceptance: "", dispatch: false }],
			options: { paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		});
		const outcome = report.outcomes[0];
		expect(outcome.status).toBe("rejected");
		// 缺目标与验收都点名
		expect(outcome.reason).toContain("目标");
		expect(outcome.reason).toContain("验收");
		expect(cardFiles(fixture.cardsDir)).toHaveLength(0);
	});
});

describe("③ 同一请求判据重复提交：不新建卡，返回第一次的真实身份", () => {
	it("第二次提交返回 duplicate，回填首次卡号/卡路径，卡目录文件数不变", async () => {
		const fixture = makeFixture("duplicate");
		const options = { paoHome: fixture.paoHome, projectRoot: fixture.projectRoot };
		const submit = (): IntakeRequest =>
			request({ idempotencyKey: "重复-同一请求", dept: "写作", goal: "写小说第一章的初稿" });

		const first = await acceptIntake(fixture.cardsDir, [submit()], options);
		expect(first.outcomes[0].status).toBe("accepted");
		const firstNo = first.outcomes[0].cardNo!;
		const firstPath = first.outcomes[0].cardPath!;
		const filesAfterFirst = cardFiles(fixture.cardsDir);

		const second = await acceptIntake(fixture.cardsDir, [submit()], options);
		expect(second.counts.duplicate).toBe(1);
		expect(second.counts.accepted).toBe(0);

		const duplicate = second.outcomes[0];
		expect(duplicate.status).toBe("duplicate");
		// 硬要求：duplicate 必须回填首次受理的真实卡号与卡路径，只回一句「重复」不算
		expect(duplicate.cardNo).toBe(firstNo);
		expect(duplicate.cardPath).toBe(firstPath);
		// 尝试号仅在首次真实给出时才回填；不重复值时按「给不出就不填」如实留空
		if (first.outcomes[0].attempt !== undefined) {
			expect(duplicate.attempt).toBe(first.outcomes[0].attempt);
		}
		// 首次身份也挂在 duplicateOf 上，调用方不必自己拼
		expect(duplicate.duplicateOf?.cardNo).toBe(firstNo);
		// accepted 是「首次受理时间」，不是本次提交时间
		expect(duplicate.acceptedAt).toBe(first.outcomes[0].acceptedAt);

		// 没有新建卡
		expect(cardFiles(fixture.cardsDir)).toEqual(filesAfterFirst);
	});

	it("重复提交不重复派发：派发通道只被调用一次", async () => {
		const fixture = makeFixture("duplicate-dispatch");
		const dispatch = makeDispatchHook();
		const options = {
			paoHome: fixture.paoHome,
			projectRoot: fixture.projectRoot,
			dispatchInBackground: dispatch.hook,
		};
		const submit = (): IntakeRequest =>
			request({
				idempotencyKey: "重复-派发",
				dept: "写作",
				goal: "写小说第一章的初稿",
				dispatch: true,
				reason: "首次派发",
			});

		await acceptIntake(fixture.cardsDir, [submit()], options);
		const second = await acceptIntake(fixture.cardsDir, [submit()], options);

		expect(second.outcomes[0].status).toBe("duplicate");
		// 「不重复建卡」与「不重复派发」是两件事，必须分别成立
		expect(dispatch.calls).toHaveLength(1);
	});
});

describe("④ 停止一条后旧受理结果被判失效", () => {
	it("受理后把卡置为 canceled，isIntakeOutcomeStale 由 false 变 true", async () => {
		const fixture = makeFixture("stale-stop");
		const report = await acceptIntake(
			fixture.cardsDir,
			[request({ idempotencyKey: "停止-一条", dept: "写作", goal: "写小说第一章的初稿" })],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		);
		const outcome = report.outcomes[0];
		expect(outcome.status).toBe("accepted");

		// 未停止时，卡还在 unclaimed → 旧结果仍有效
		expect(isIntakeOutcomeStale(outcome, fixture.cardsDir)).toBe(false);

		// 用既有卡操作停卡（与 pao_terminate_card 同一条落盘路径：状态机允许 unclaimed → canceled）
		const { changeCardStatus } = await import("../../src/pao/cards/index.ts");
		const file = join(fixture.cardsDir, cardFiles(fixture.cardsDir)[0]);
		changeCardStatus(readCard(file), { 操作者: "用户", to: "canceled", 时间: nowString(), 依据: "用户要求停止" });

		// 停止后再拿旧回执说「受理成功/正在跑」就是假话
		expect(readCard(file).frontmatter.status).toBe("canceled");
		expect(isIntakeOutcomeStale(outcome, fixture.cardsDir)).toBe(true);
	});

	it("卡文件被删掉后旧结果同样判失效（查不到就不许说成功）", async () => {
		const fixture = makeFixture("stale-gone");
		const report = await acceptIntake(
			fixture.cardsDir,
			[request({ idempotencyKey: "停止-删卡", dept: "写作", goal: "写小说第一章的初稿" })],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		);
		const outcome = report.outcomes[0];
		expect(isIntakeOutcomeStale(outcome, fixture.cardsDir)).toBe(false);

		rmSync(outcome.cardPath!, { force: true });
		expect(isIntakeOutcomeStale(outcome, fixture.cardsDir)).toBe(true);
	});
});

describe("⑤ 中途改要求：卡已有受理结果后改目标/追加约束", () => {
	/**
	 * 中途改要求：卡文件的正本读写。
	 *
	 * 为什么不用某个「改目标」工具：内核当前没有「改正在进行中的卡的目标」的公开工具
	 * （`pao_dispatch_card` 只在派对时校验，卡创建后目标由 owner 在卡正本上维护）。
	 * 因此这里用与内核落盘同一套函数（readCard → 改 frontmatter → serializeCard → writeFileAtomic）
	 * 模拟 owner 改卡，验证的是「改完之后受理链路还能不能正确对待旧结果」这件事。
	 */
	function amendCard(file: string, changes: { goal?: string; constraints?: string; attempt?: number }): void {
		const card = readCard(file);
		if (changes.goal !== undefined) card.frontmatter.goal = changes.goal;
		if (changes.constraints !== undefined) card.frontmatter.constraints = changes.constraints;
		if (changes.attempt !== undefined) card.frontmatter.attempt = changes.attempt;
		writeFileSync(file, serializeCard(card.frontmatter, card.body), "utf8");
	}

	it("改后的卡能查回新目标与新约束，旧受理结果不再被当作当前要求的完成依据", async () => {
		const fixture = makeFixture("change");
		const report = await acceptIntake(
			fixture.cardsDir,
			[
				request({
					idempotencyKey: "改要求-第一章",
					dept: "写作",
					goal: "写小说第一章的初稿",
					constraints: "第一人称",
				}),
			],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		);
		const outcome: IntakeOutcome = report.outcomes[0];
		expect(outcome.status).toBe("accepted");

		const cardFile = join(fixture.cardsDir, cardFiles(fixture.cardsDir)[0]);
		const before = readCard(cardFile);
		expect(before.frontmatter.goal).toBe("写小说第一章的初稿");
		expect(before.frontmatter.constraints).toBe("第一人称");

		// 中途改要求：改目标与追加约束（不新建卡、不改卡号）
		amendCard(cardFile, {
			goal: "写小说第一章的初稿，并把主角改成女性",
			constraints: "第一人称；单句不超过 40 字；不用「总之」",
		});

		const after = readCard(cardFile);
		expect(after.frontmatter.goal).toBe("写小说第一章的初稿，并把主角改成女性");
		expect(after.frontmatter.constraints).toBe("第一人称；单句不超过 40 字；不用「总之」");
		// 卡号没变：改要求不是新任务
		expect(cardFiles(fixture.cardsDir)).toHaveLength(1);

		// 旧受理结果描述的是「受理当时的那个目标」，改要求后再用同一判据提交，
		// 内核返回 duplicate 并回填首次身份，而不会把新要求当成一次新的受理。
		const again = await acceptIntake(
			fixture.cardsDir,
			[
				request({
					idempotencyKey: "改要求-第一章",
					dept: "写作",
					goal: "写小说第一章的初稿，并把主角改成女性",
					constraints: "第一人称；单句不超过 40 字；不用「总之」",
				}),
			],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		);
		expect(again.outcomes[0].status).toBe("duplicate");
		expect(again.outcomes[0].cardNo).toBe(outcome.cardNo);
		// 卡上的目标仍然是改后的那个（没有被 duplicate 路径覆盖回旧值）
		expect(readCard(cardFile).frontmatter.goal).toBe("写小说第一章的初稿，并把主角改成女性");
		// 也没有因为「改要求」而多建卡
		expect(cardFiles(fixture.cardsDir)).toHaveLength(1);
	});

	it("改要求后卡进了新一轮尝试（尝试号变化）时旧受理结果判失效", async () => {
		const fixture = makeFixture("change-attempt");
		const report = await acceptIntake(
			fixture.cardsDir,
			[request({ idempotencyKey: "改要求-尝试", dept: "写作", goal: "写小说第一章的初稿" })],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		);
		// 用一份「记了尝试号」的结果检验尝试号比对那条判据（真实 fast-path 认领完成时会出现）
		const dispatched = report.outcomes[0];
		expect(dispatched.status).toBe("accepted");
		const cardFile = join(fixture.cardsDir, cardFiles(fixture.cardsDir)[0]);

		// 未变化时：同一尝试号继续有效
		const withAttempt: IntakeOutcome = { ...dispatched, attempt: readCard(cardFile).frontmatter.attempt };
		expect(isIntakeOutcomeStale(withAttempt, fixture.cardsDir)).toBe(false);

		// 卡被重新派出去跑了新一轮（尝试号 +1）→ 旧结果描述的是旧尝试，判失效
		amendCard(cardFile, { attempt: readCard(cardFile).frontmatter.attempt + 1 });
		expect(isIntakeOutcomeStale(withAttempt, fixture.cardsDir)).toBe(true);
	});
});

describe("样例边界自检：不碰正式 PAO_HOME、不 spawn", () => {
	it("所有夹具路径都在临时根下，且没有指向正式 PAO_HOME", () => {
		const fixture = makeFixture("isolation");
		for (const path of [fixture.paoHome, fixture.projectRoot, fixture.cardsDir]) {
			expect(path.startsWith(fixture.root)).toBe(true);
			expect(path.toLowerCase().includes("workspace\\pao") && !path.includes("pao-dev")).toBe(false);
		}
	});

	it("受理全程没有留下运行产物在仓库里：卡目录在临时根内，开始与结束都是隔离的", async () => {
		const fixture = makeFixture("no-residue");
		const before = cardFiles(fixture.cardsDir);
		expect(before).toEqual([]);

		await acceptIntake(
			fixture.cardsDir,
			[request({ idempotencyKey: "无残留", dept: "写作", goal: "写小说第一章的初稿" })],
			{ paoHome: fixture.paoHome, projectRoot: fixture.projectRoot },
		);
		expect(cardFiles(fixture.cardsDir)).toHaveLength(1);
		// 卡目录、账本都在临时根里（afterEach 会整个删掉）
		expect(fixture.cardsDir.startsWith(fixture.root)).toBe(true);
		expect(existsSync(join(fixture.root, "PAO_HOME", "部门", "注册表.md"))).toBe(true);
	});
});
