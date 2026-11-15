import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCardNumber } from "../../src/pao/cards/counter.ts";
import type { CardFrontmatter, ParsedCard } from "../../src/pao/cards/types.ts";
import { auditAppend, type CollabAuditRecord } from "../../src/pao/collab/audit.ts";
import { writeCollabCard } from "../../src/pao/collab/dispatch.ts";
import {
	type CollabCardDraft,
	DEFAULT_COLLAB_QUOTA,
	RULING_FLAGS,
	validateCollabCard,
} from "../../src/pao/collab/review.ts";
import type { DeptRegistryRow } from "../../src/pao/dept/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let cardNoSeq = 0;

/** 造既有卡夹具（不落盘，校验器只读内存视图） */
function makeCard(overrides: Partial<CardFrontmatter> & { card_no?: number } = {}): ParsedCard {
	cardNoSeq += 1;
	const cardNo = overrides.card_no ?? cardNoSeq;
	const frontmatter: CardFrontmatter = {
		goal: `目标${cardNo}`,
		dept: "前端",
		acceptance: "可判验收",
		attempt: 0,
		created: "2026-10-02 09:00",
		status: "in_progress",
		...overrides,
	};
	delete (frontmatter as { card_no?: number }).card_no;
	return {
		path: join("虚拟", "卡", `${formatCardNumber(cardNo)}-x.md`),
		filename: `${formatCardNumber(cardNo)}-x.md`,
		card_no: cardNo,
		frontmatter,
		body: "",
		receipts: [],
	};
}

const registry: DeptRegistryRow[] = [
	{ 名字: "后端", 标签: ["api"], 库路径: "部门/后端/知识库" },
	{ 名字: "测试", 标签: ["qa"], 库路径: "部门/测试/知识库" },
];

/** 合法草稿：parent=卡#1（普通卡） */
function makeDraft(overrides: Partial<CollabCardDraft> = {}): CollabCardDraft {
	return { 目标: "帮忙压测登录接口", 部门: "后端", 验收: "压测报告落产物目录", parent: "卡#1", ...overrides };
}

const parentCard = () => makeCard({ card_no: 1, dept: "前端", status: "in_progress" });

describe("机械校验器:放行", () => {
	it("部门存在、字段齐全、parent 已填、配额未超、依赖满足 → 放行", () => {
		const result = validateCollabCard(makeDraft({ depends_on: [] }), registry, [parentCard()]);
		expect(result.裁决).toBe("放行");
		expect(result.原因).toEqual([]);
		expect(result.裁决声明).toEqual({});
		expect(result.裁决摘要).toBeUndefined();
	});

	it("依赖前置卡已交付时依赖门放行", () => {
		const existing = [parentCard(), makeCard({ card_no: 3, dept: "后端", status: "delivered" })];
		const result = validateCollabCard(makeDraft({ depends_on: ["卡#3"] }), registry, existing);
		expect(result.裁决).toBe("放行");
	});
});

describe("机械校验器:拒绝(程序可判,逐项结构化原因)", () => {
	it("必需字段缺失逐项列出(目标/部门/验收/parent)", () => {
		const result = validateCollabCard({ 目标: "", 部门: "后端", 验收: "", parent: "" }, registry, [parentCard()]);
		expect(result.裁决).toBe("拒绝");
		const field = result.原因.filter((r) => r.类型 === "字段缺失").map((r) => r.字段);
		expect(field).toEqual(["目标", "验收", "parent"]);
	});

	it("档位/优先级非法 → 字段非法", () => {
		const result = validateCollabCard(makeDraft({ 档位: "极速" as never, 优先级: "最高" as never }), registry, [
			parentCard(),
		]);
		expect(result.原因.map((r) => r.类型)).toEqual(["字段非法", "字段非法"]);
		expect(result.原因[0].字段).toBe("档位");
		expect(result.原因[1].字段).toBe("优先级");
	});

	it("parent 引用无法解析 → 字段非法", () => {
		const result = validateCollabCard(makeDraft({ parent: "不是卡号" }), registry, [parentCard()]);
		expect(result.裁决).toBe("拒绝");
		expect(result.原因[0]).toMatchObject({ 类型: "字段非法", 字段: "parent" });
	});

	it("parent 在既有卡中找不到 → parent 不存在", () => {
		const result = validateCollabCard(makeDraft({ parent: "卡#9" }), registry, [parentCard()]);
		expect(result.裁决).toBe("拒绝");
		expect(result.原因[0]).toMatchObject({ 类型: "parent 不存在", 卡号: 9 });
	});

	it("协作卡不得再生协作卡:父卡自身带 parent → 深度封顶拒绝", () => {
		const existing = [makeCard({ card_no: 1, dept: "前端", parent: "卡#0" })];
		const result = validateCollabCard(makeDraft(), registry, existing);
		expect(result.裁决).toBe("拒绝");
		expect(result.原因[0]).toMatchObject({ 类型: "深度封顶", 卡号: 1 });
		expect(result.原因[0].说明).toContain("不得再生协作卡");
	});

	it("部门不在注册表 → 部门不存在(注册表为空同样拒绝)", () => {
		const result = validateCollabCard(makeDraft({ 部门: "不存在的部" }), registry, [parentCard()]);
		expect(result.裁决).toBe("拒绝");
		expect(result.原因[0].类型).toBe("部门不存在");
		const empty = validateCollabCard(makeDraft(), [], [parentCard()]);
		expect(empty.原因[0].类型).toBe("部门不存在");
	});

	it("同 parent 同目标部门已有活卡 → 重复落卡并返回已有卡号", () => {
		const existing = [parentCard(), makeCard({ card_no: 2, dept: "后端", parent: "卡#1", status: "unclaimed" })];
		const result = validateCollabCard(makeDraft(), registry, existing);
		expect(result.裁决).toBe("拒绝");
		expect(result.原因[0]).toMatchObject({ 类型: "重复落卡", 卡号: 2 });
		expect(result.已有卡号).toBe(2);
	});

	it("幂等只看活卡:同目标部门卡已交付/失败/取消不算重复", () => {
		for (const status of ["delivered", "failed", "canceled"] as const) {
			const existing = [parentCard(), makeCard({ card_no: 2, dept: "后端", parent: "卡#1", status: status })];
			const result = validateCollabCard(makeDraft(), registry, existing);
			expect(
				result.原因.some((r) => r.类型 === "重复落卡"),
				status,
			).toBe(false);
		}
	});

	it("同 parent 协作卡数达配额(默认 2)→ 配额超;父卡覆写配额可放宽", () => {
		const existing = [
			parentCard(),
			makeCard({ card_no: 2, dept: "测试", parent: "卡#1", status: "delivered" }),
			makeCard({ card_no: 3, dept: "测试", parent: "卡#1", status: "failed" }),
		];
		const result = validateCollabCard(makeDraft(), registry, existing);
		expect(result.原因[0]).toMatchObject({ 类型: "配额超", 卡号: 1 });
		expect(result.原因[0].说明).toContain(`协作配额 ${DEFAULT_COLLAB_QUOTA}`);

		const wideParentCard = makeCard({ card_no: 1, dept: "前端", budget: { collab_quota: 3 } });
		const relaxed = validateCollabCard(makeDraft(), registry, [wideParentCard, ...existing.slice(1)]);
		expect(relaxed.裁决).toBe("放行");
	});

	it("依赖前置卡未全部已交付 → 依赖未满足并附阻塞明细", () => {
		const existing = [parentCard(), makeCard({ card_no: 3, dept: "后端", status: "in_progress" })];
		const result = validateCollabCard(makeDraft({ depends_on: ["卡#3", "卡#4"] }), registry, existing);
		expect(result.裁决).toBe("拒绝");
		const reason = result.原因.find((r) => r.类型 === "依赖未满足");
		expect(reason).toBeDefined();
		expect(reason!.阻塞).toEqual([
			{ 卡号: 3, 状态: "in_progress" },
			{ 卡号: 4, 状态: "不存在" },
		]);
	});

	it("多项问题一次给全:字段缺失与部门不存在并存", () => {
		const result = validateCollabCard({ 目标: "x", 部门: "幽灵部", 验收: "y", parent: "" }, registry, [parentCard()]);
		const type = result.原因.map((r) => r.类型);
		expect(type).toContain("字段缺失");
		expect(type).toContain("部门不存在");
	});
});

describe("机械校验器:待主控裁决(机械全过但带裁决标记)", () => {
	it("四类裁决标记逐一带声明 → 待主控裁决,摘要含声明内容,不判拒绝", () => {
		for (const flag of RULING_FLAGS) {
			const result = validateCollabCard(makeDraft({ [flag]: "理由说明" } as Partial<CollabCardDraft>), registry, [
				parentCard(),
			]);
			expect(result.裁决, flag).toBe("待主控裁决");
			expect(result.原因).toEqual([]);
			expect(result.裁决声明[flag]).toBe("理由说明");
			expect(result.裁决摘要).toContain(flag);
			expect(result.裁决摘要).toContain("理由说明");
			expect(result.裁决摘要).toContain(formatCardNumber(1));
		}
	});

	it("多项声明同时给出时全部进入裁决声明", () => {
		const result = validateCollabCard(makeDraft({ 插队: "用户在等", 超预算覆写: "需 20 turns,超父卡池" }), registry, [
			parentCard(),
		]);
		expect(result.裁决).toBe("待主控裁决");
		expect(Object.keys(result.裁决声明).sort()).toEqual(["超预算覆写", "插队"].sort());
	});

	it("声明留空白不算声明,仍放行", () => {
		const result = validateCollabCard(makeDraft({ 插队: "   " }), registry, [parentCard()]);
		expect(result.裁决).toBe("放行");
	});

	it("机械未全过时拒绝优先于裁决标记", () => {
		const result = validateCollabCard(makeDraft({ 部门: "幽灵部", 插队: "理由" }), registry, [parentCard()]);
		expect(result.裁决).toBe("拒绝");
		expect(result.原因[0].类型).toBe("部门不存在");
	});
});

describe("落协作卡与审计", () => {
	it("落协作卡经 createCard 正门落盘:协议字段齐全、parent 写入、声明字段不落盘", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-collab-"));
		tempDirs.push(root);
		const cardsDir = join(root, "pao", "task-20261002", "卡");
		mkdirSync(cardsDir, { recursive: true });

		const draft = makeDraft({ 输入: ["docs/api.md#L10"], 约束: "引用 plans/约束.md", 插队: "不落盘的字段" });
		const created = await writeCollabCard(cardsDir, draft, "2026-10-02 11:00", {
			counterPath: join(root, "pao", "卡号.txt"),
		});

		expect(created.frontmatter.parent).toBe("卡#1");
		expect(created.frontmatter.status).toBe("unclaimed");
		expect(created.frontmatter.attempt).toBe(0);
		expect(created.frontmatter.inputs).toEqual(["docs/api.md#L10"]);
		const raw = readFileSync(created.path, "utf8");
		expect(raw).toContain("parent");
		expect(raw).toContain("卡#1");
		expect(raw).not.toContain("插队"); // 协议零新增:声明字段不落盘
	});

	it("审计追加:JSONL 一行一条,目录自动创建,逐条可解析", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-collab-"));
		tempDirs.push(root);
		const auditPath = join(root, "嵌套", "协作审计.jsonl");
		const record: CollabAuditRecord = {
			时间: "2026-10-02 11:00",
			来源部门: "前端",
			目标部门: "后端",
			卡号: 2,
			校验结果: "放行",
			目标: "帮忙压测",
		};
		await auditAppend(auditPath, record);
		await auditAppend(auditPath, { ...record, 卡号: null, 校验结果: "拒绝", 原因: ["[部门不存在] 不在注册表"] });

		const lines = readFileSync(auditPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]) as CollabAuditRecord;
		expect(first).toMatchObject({ 来源部门: "前端", 目标部门: "后端", 卡号: 2, 校验结果: "放行" });
		const second = JSON.parse(lines[1]) as CollabAuditRecord;
		expect(second.卡号).toBeNull();
		expect(second.原因).toEqual(["[部门不存在] 不在注册表"]);
		expect(existsSync(auditPath)).toBe(true);
	});
});
