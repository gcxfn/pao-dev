/**
 * 结晶判定显式化（genericagent 借鉴①）＋写入决策树（No Execution No Memory）单测：
 * 候选只从既有账面（卡回执「值得沉淀」字段）抽；无候选也显式出声；
 * 决策树三问任一不过不写，全过也要求带验证出处（借鉴③口径）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cardFileName, serializeCard, serializeReceipt } from "../../src/pao/cards/cardfile.ts";
import { listCards } from "../../src/pao/cards/index.ts";
import type { CardFrontmatter } from "../../src/pao/cards/types.ts";
import {
	collectCrystallizeCandidates,
	judgeCrystallizeWrite,
	renderCrystallizeSection,
	WRITE_DECISION_TREE,
} from "../../src/pao/knowledge/crystallize.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-crystallize-"));
	tempDirs.push(dir);
	return dir;
}

function writeCard(cardsDir: string, cardNo: number, goal: string, body: string): void {
	const frontmatter: Partial<CardFrontmatter> &
		Pick<CardFrontmatter, "goal" | "dept" | "acceptance" | "attempt" | "created" | "status"> = {
		goal: goal,
		dept: "前端",
		acceptance: "包含: x",
		attempt: 1,
		created: "2026-10-04 09:00",
		status: "delivered",
	};
	writeFileSync(join(cardsDir, cardFileName(cardNo, goal)), serializeCard(frontmatter, body), "utf8");
}

describe("结晶候选（只从既有账面抽）", () => {
	it("回执「值得沉淀」非空才算候选,出处带卡号与回执时间", () => {
		const cardsDir = makeDir();
		writeCard(
			cardsDir,
			7,
			"沉淀甲",
			serializeReceipt({
				card_no: 7,
				attempt: 1,
				time: "2026-10-04 10:00",
				result: "成功",
				summary: "做了甲",
				worth_distilling: "先跑定向再跑全量省一半时间",
			}),
		);
		writeCard(
			cardsDir,
			8,
			"无沉淀",
			serializeReceipt({ card_no: 8, attempt: 1, time: "2026-10-04 11:00", result: "成功", summary: "做了乙" }),
		);
		const candidate = collectCrystallizeCandidates(listCards(cardsDir));
		expect(candidate).toHaveLength(1);
		expect(candidate[0]?.卡号).toBe(7);
		expect(candidate[0]?.值得沉淀).toContain("先跑定向");
		expect(candidate[0]?.出处).toBe("卡0007 回执 2026-10-04 10:00");
	});

	it("空白「值得沉淀」不算候选（没内容不等于有沉淀）", () => {
		const cardsDir = makeDir();
		writeCard(
			cardsDir,
			9,
			"空沉淀",
			serializeReceipt({
				card_no: 9,
				attempt: 1,
				time: "2026-10-04 12:00",
				result: "成功",
				worth_distilling: "   ",
			}),
		);
		expect(collectCrystallizeCandidates(listCards(cardsDir))).toEqual([]);
	});
});

describe("写入决策树（No Execution No Memory）", () => {
	it("没真实执行过不写（只推理/只计划不产生记忆）", () => {
		const ruling = judgeCrystallizeWrite({ 执行过: false, 可定位: true, 验证出处: "卡0007" });
		expect(ruling.允许).toBe(false);
		expect(ruling.原因).toContain("No Execution No Memory");
		expect(ruling.要求).toEqual([]);
	});

	it("与存量重复不写:先去重,存量可订正", () => {
		const ruling = judgeCrystallizeWrite({ 执行过: true, 可定位: true, 重复于: "做法/先跑定向再跑全量.md" });
		expect(ruling.允许).toBe(false);
		expect(ruling.原因).toContain("做法/先跑定向再跑全量.md");
		expect(ruling.原因).toContain("先去重");
	});

	it("不可定位不写（检索不到等于没写）", () => {
		const ruling = judgeCrystallizeWrite({ 执行过: true, 可定位: false });
		expect(ruling.允许).toBe(false);
		expect(ruling.原因).toContain("检索不到等于没写");
	});

	it("三问全过：有出处则要求落出处行,没出处只能挂待验证", () => {
		const hasProvenance = judgeCrystallizeWrite({
			执行过: true,
			可定位: true,
			验证出处: "卡0007 2026-10-04 真机验收",
		});
		expect(hasProvenance.允许).toBe(true);
		expect(hasProvenance.要求[0]).toContain("验证出处: 卡0007 2026-10-04 真机验收");

		const noProvenance = judgeCrystallizeWrite({ 执行过: true, 可定位: true });
		expect(noProvenance.允许).toBe(true);
		expect(noProvenance.要求[0]).toContain("只能挂「待验证」");
	});

	it("决策树三问顺序固定（护栏口径可测）", () => {
		expect(WRITE_DECISION_TREE).toHaveLength(3);
		expect(WRITE_DECISION_TREE[0]).toContain("真实执行过");
		expect(WRITE_DECISION_TREE[2]).toContain("可定位");
	});
});

describe("结晶判定渲染（复盘/验收环节显式出声）", () => {
	it("无候选也显式出声:判定为未结晶出做法,不是漏看", () => {
		const text = renderCrystallizeSection([]);
		expect(text).toContain("结晶候选 0 条");
		expect(text).toContain("未结晶出做法");
		expect(text).toContain("静默丢弃＝违规");
	});

	it("有候选逐条列出＋三选一＋决策树护栏＋L1指针纪律", () => {
		const text = renderCrystallizeSection([
			{ 卡号: 7, 节点: "开发", 值得沉淀: "先跑定向再跑全量", 出处: "卡0007 回执 2026-10-04 10:00" },
			{ 卡号: 9, 值得沉淀: "验收前先冻结配方", 出处: "卡0009 回执 2026-10-04 12:00" },
		]);
		expect(text).toContain("结晶候选 2 条");
		expect(text).toContain("卡0007·开发：先跑定向再跑全量");
		expect(text).toContain("卡0009：验收前先冻结配方");
		expect(text).toContain("① 入库「做法」区");
		expect(text).toContain("③ 拒绝并写理由");
		expect(text).toContain("是否真实执行过");
		expect(text).toContain("L1 只放指针与触发词,正文在 L2");
	});
});
