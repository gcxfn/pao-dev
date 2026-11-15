import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	cardFileName,
	cardNumberFromFileName,
	createCard,
	listCards,
	loadCard,
	parseReceipts,
	readCard,
	serializeCard,
	serializeReceipt,
	slugifyGoal,
	validateFrontmatter,
} from "../../src/pao/cards/cardfile.ts";
import { isPaoCardError, PaoCardError } from "../../src/pao/cards/errors.ts";
import type { Receipt } from "../../src/pao/cards/types.ts";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";

function makeCardsDir(): string {
	// 模拟任务工作区布局：<临时根>/.pao/<任务名>/卡，默认计数器落在 <临时根>/.pao/卡号.txt
	const dir = mkdtempSync(join(tmpdir(), "pao-cards-"));
	const cardsDir = join(dir, ".pao", "任务-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

// validateFrontmatter 面向英文卡面；createCard 输入面保留中文（内部建卡入参，非磁盘协议）
const validInput = {
	goal: "实现发号器",
	dept: "核心机制",
	acceptance: "并发发号不重号",
	created: "2026-10-02 21:00",
};
const createInput = {
	目标: "实现发号器",
	部门: "核心机制",
	验收: "并发发号不重号",
	创建: "2026-10-02 21:00",
};

describe("validateFrontmatter 结构化校验", () => {
	test("缺必需字段时报 INVALID_CARD 并列出缺失字段", () => {
		try {
			validateFrontmatter({ goal: "只有目标" });
			expect.unreachable("应当抛错");
		} catch (error) {
			expect(isPaoCardError(error)).toBe(true);
			const cardError = error as PaoCardError;
			expect(cardError.code).toBe("INVALID_CARD");
			expect(cardError.details.missing).toEqual(["dept", "acceptance", "attempt", "created", "status"]);
		}
	});

	test("状态五值之外的值报错", () => {
		const fm = { ...validInput, attempt: 0, status: "暂停中" };
		expect(() => validateFrontmatter(fm)).toThrow(/状态非法/);
	});

	test("尝试负数报错；创建时间格式不对报错", () => {
		expect(() => validateFrontmatter({ ...validInput, attempt: -1, status: "unclaimed" })).toThrow(/尝试/);
		expect(() =>
			validateFrontmatter({ ...validInput, attempt: 0, status: "unclaimed", created: "今天下午" }),
		).toThrow(/创建时间格式/);
	});

	test("合法 frontmatter 通过", () => {
		const fm = validateFrontmatter({
			...validInput,
			attempt: 1,
			status: "in_progress",
			priority: "high",
			tier: "primary",
			owner: "主控",
		});
		expect(fm.priority).toBe("high");
	});

	test("手工预算按正确单位读取：零有效，负数和非整数计数明确报错", () => {
		const fm = { ...validInput, attempt: 0, status: "unclaimed" };
		expect(validateFrontmatter({ ...fm, budget: { turns: 0, toolCalls: 0, cost: 0.25 } }).budget).toEqual({
			turns: 0,
			toolCalls: 0,
			cost: 0.25,
		});
		expect(() => validateFrontmatter({ ...fm, budget: { toolCalls: -1 } })).toThrow("toolCalls");
		expect(() => validateFrontmatter({ ...fm, budget: { turns: 1.5 } })).toThrow("turns");
		expect(() => validateFrontmatter({ ...fm, budget: "100/1000" })).toThrow("预算须为对象");
	});
});

describe("卡文件命名", () => {
	test("命名 = 卡NNNN-目标简述.md；非法字符与空白被清除", () => {
		expect(cardFileName(1, "实现发号器")).toBe("卡0001-实现发号器.md");
		expect(cardFileName(23, "  修 bug: 小心 / 与 * ")).toBe("卡0023-修bug小心与.md");
		expect(slugifyGoal("")).toBe("未命名");
	});

	test("cardNumberFromFileName 解析卡号", () => {
		expect(cardNumberFromFileName("卡0007-随便.md")).toBe(7);
		expect(cardNumberFromFileName("README.md")).toBeUndefined();
	});
});

describe("createCard 建卡", () => {
	test("任务工作区默认计数器落在项目 .pao/ 下，发号唯一递增", async () => {
		const cardsDir = makeCardsDir();
		const first = await createCard(cardsDir, createInput);
		const second = await createCard(cardsDir, { ...createInput, 目标: "第二张卡" });
		expect(first.filename).toBe("卡0001-实现发号器.md");
		expect(second.filename).toBe("卡0002-第二张卡.md");
		const counterPath = join(cardsDir, "..", "..", "卡号.txt");
		expect(existsSync(counterPath)).toBe(true);
		expect(readFileSync(counterPath, "utf8").trim()).toBe("2");
	});

	test("同一项目平铺和两个任务目录共用 .pao/卡号.txt 连续发号", async () => {
		const project = mkdtempSync(join(tmpdir(), "pao-card-layouts-"));
		const directories = [
			join(project, ".pao", "卡"),
			join(project, ".pao", "任务甲", "卡"),
			join(project, ".pao", "任务乙", "卡"),
		];
		const numbers: number[] = [];
		for (const directory of directories) {
			mkdirSync(directory, { recursive: true });
			numbers.push((await createCard(directory, createInput)).card_no);
		}
		expect(numbers).toEqual([1, 2, 3]);
		expect(readFileSync(join(project, ".pao", "卡号.txt"), "utf8").trim()).toBe("3");
		expect(existsSync(join(project, "卡号.txt"))).toBe(false);
		for (const task of ["任务甲", "任务乙"]) expect(existsSync(join(project, ".pao", task, "卡号.txt"))).toBe(false);
	});

	test.each([
		[9, 4],
		[4, 9],
	])("统一布局兼容旧计数器，旧值 %i 与 .pao 值 %i 取较大值", async (oldCount, paoCount) => {
		const project = mkdtempSync(join(tmpdir(), "pao-card-legacy-"));
		mkdirSync(join(project, ".pao"), { recursive: true });
		writeFileSync(join(project, "卡号.txt"), `${oldCount}\n`);
		writeFileSync(join(project, ".pao", "卡号.txt"), `${paoCount}\n`);
		const numbers: number[] = [];
		for (const directory of [
			join(project, ".pao", "卡"),
			join(project, ".pao", "任务甲", "卡"),
			join(project, ".pao", "任务乙", "卡"),
		]) {
			mkdirSync(directory, { recursive: true });
			numbers.push((await createCard(directory, createInput)).card_no);
		}
		expect(numbers).toEqual([10, 11, 12]);
		expect(readFileSync(join(project, ".pao", "卡号.txt"), "utf8").trim()).toBe("12");
		expect(readFileSync(join(project, "卡号.txt"), "utf8").trim()).toBe(String(oldCount));
	});

	test("显式 counterPath 生效", async () => {
		const cardsDir = makeCardsDir();
		const counterPath = join(mkdtempSync(join(tmpdir(), "pao-ctr-")), "custom-counter.txt");
		const card = await createCard(cardsDir, createInput, { counterPath });
		expect(card.card_no).toBe(1);
	});

	test("新卡字段完整：状态待认领、尝试 0、优先级缺省中", async () => {
		const cardsDir = makeCardsDir();
		const card = await createCard(cardsDir, {
			...createInput,
			输入: ["plans/v2-ARCHITECTURE.md §2", "卡#3"],
			depends_on: ["卡#3"],
			预算: { turns: 40 },
			档位: "primary",
		});
		expect(card.frontmatter.status).toBe("unclaimed");
		expect(card.frontmatter.attempt).toBe(0);
		expect(card.frontmatter.priority).toBe("medium");
		expect(card.frontmatter.depends_on).toEqual(["卡#3"]);
		expect(card.frontmatter.budget).toEqual({ turns: 40 });
	});
});

describe("卡文件往返", () => {
	test("写出的卡文件可原样回读，frontmatter 字段不丢", async () => {
		const cardsDir = makeCardsDir();
		const created = await createCard(cardsDir, { ...createInput, depends_on: ["卡#9"], parent: "卡#1" });
		const receipt: Receipt = {
			card_no: created.card_no,
			attempt: 1,
			time: "2026-10-02 21:30",
			result: "完成",
			summary: "三行摘要之内",
			artifact_path: ["产物/报告.md"],
			evidence: ["npx vitest run x.test.ts 全绿"],
			usage: { turns: 5 },
			worth_distilling: "无",
		};
		const body = `${serializeReceipt(receipt)}\n`;
		writeFileAtomic(created.path, serializeCard(created.frontmatter, body));

		const reread = readCard(created.path);
		expect(reread.frontmatter.goal).toBe(createInput.目标);
		expect(reread.frontmatter.depends_on).toEqual(["卡#9"]);
		expect(reread.frontmatter.parent).toBe("卡#1");
		expect(reread.receipts).toHaveLength(1);
		expect(reread.receipts[0].attempt).toBe(1);
		expect(reread.receipts[0].usage).toEqual({ turns: 5 });
		expect(reread.receipts[0].artifact_path).toEqual(["产物/报告.md"]);
	});
});

describe("parseReceipts 解析", () => {
	test("多段回执按序解析；无回执正文返回空", () => {
		const body = [
			"## 回执 尝试1 2026-10-02 21:30",
			"- result: failed",
			"- failure_type: transient",
			"",
			"## 回执 尝试2 2026-10-02 22:00",
			"- result: success",
			"- archive_flag: old_attempt",
		].join("\n");
		const receipts = parseReceipts(body, 7);
		expect(receipts).toHaveLength(2);
		expect(receipts[0].card_no).toBe(7);
		expect(receipts[0].failure_type).toBe("transient");
		expect(receipts[1].result).toBe("success");
		expect(receipts[1].archive_flag).toBe("old_attempt");
		expect(parseReceipts("没有回执", 1)).toEqual([]);
	});
});

describe("listCards 与 loadCard", () => {
	test("按卡号升序；坏卡跳过不炸整队", async () => {
		const cardsDir = makeCardsDir();
		await createCard(cardsDir, { ...createInput, 目标: "甲" });
		await createCard(cardsDir, { ...createInput, 目标: "乙" });
		// 手工写一张坏卡（缺状态）
		writeFileSync(join(cardsDir, "卡0009-坏卡.md"), "---\n目标: 坏卡\n---\n正文\n", "utf8");

		const cards = listCards(cardsDir);
		expect(cards.map((c) => c.card_no)).toEqual([1, 2]);
		const loaded = loadCard(cardsDir, 2);
		expect(loaded.filename).toContain("乙");
		expect(() => loadCard(cardsDir, 9)).toThrow(PaoCardError);
		expect(() => loadCard(cardsDir, 99)).toThrow(/找不到/);
	});
});
