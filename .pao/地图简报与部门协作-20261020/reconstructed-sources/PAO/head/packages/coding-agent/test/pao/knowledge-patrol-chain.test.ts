/**
 * M2-05 巡库卡链闭环（§6.7，测试库覆盖触发规则，全程临时夹具库、不碰真实库）：
 * 巡检 ⚠️ 过阈值 → 巡库卡落本部队列（afterInspect 钩子）→ 该卡作为普通卡可被派发（认领）
 * → worker 只写初判文件与回执（红线：条目正文零差异断言）→ 部长终审三选一机械支撑
 * （更新＝改写新日期复检摘 ⚠️；退役＝retireEntry；打回待验证＝demoteToPending）→ 结卡。
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendReceipt, listCards, loadCard } from "../../src/pao/cards/index.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import {
	appendPatrolJudgment,
	demoteToPending,
	type PatrolJudgment,
	retireEntry,
} from "../../src/pao/knowledge/index.ts";
import { inspectLibrary } from "../../src/pao/knowledge/inspect.ts";
import { loadPatrolJudgments } from "../../src/pao/knowledge/judgment.ts";
import { PATROL_CONSTRAINT } from "../../src/pao/patrol/draft.ts";
import { createPatrolHook } from "../../src/pao/patrol/hook.ts";

let root: string;
let libRoot: string;
let cardsDir: string;
const NOW = new Date("2026-10-02T10:00:00");
const STALE_DAYS = 90;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pao-kb-patrol-chain-"));
	cardsDir = join(root, ".pao", "卡");
	libRoot = join(root, "部门", "后端", "知识库");
	mkdirSync(cardsDir, { recursive: true });
	for (const dir of ["教训", "导览", "做法", "评测", "待验证", "归档"]) {
		mkdirSync(join(libRoot, dir), { recursive: true });
	}
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** 超期夹具条目（首行日期 2026-01-01，相对 NOW=2026-10-02 稳定超 90 天阈值）。 */
function writeStale(relPath: string): void {
	const abs = join(libRoot, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, "超期条目 2026-01-01 版本:v2\n正文\n适用范围: demo-proj", "utf8");
}

/** 库内全部条目正文的字节快照（红线断言用：worker 阶段必须零差异）。 */
function entrySnapshot(): Map<string, string> {
	const snapshot = new Map<string, string>();
	for (const area of ["教训", "导览", "做法", "评测"]) {
		const dir = join(libRoot, area);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "子索引.md")) {
			snapshot.set(`${area}/${file}`, readFileSync(join(dir, file), "utf8"));
		}
	}
	return snapshot;
}

function hook() {
	return createPatrolHook({
		部门: "后端",
		resolveCardsDir: () => cardsDir,
		counterPath: join(root, "卡号.txt"),
		知识库路径: libRoot,
		now: () => NOW,
	});
}

function judgmentOf(cardNo: number, relPath: string, initialJudgement: PatrolJudgment["初判"]): PatrolJudgment {
	return { time: NOW.toISOString(), 卡号: cardNo, relPath, 初判: initialJudgement, 理由: `初判：${initialJudgement}` };
}

describe("M2-05：巡库卡链闭环（夹具库）", () => {
	test("⚠️ 过阈值落卡 → 普通卡派发 → worker 初判（正文零差异）→ 终审三选一 → 结卡", async () => {
		// —— 1. 夹具库：5 条超期（=默认阈值 5）——
		for (const rel of ["教训/甲.md", "教训/乙.md", "做法/丙.md", "做法/丁.md", "导览/戊.md"]) {
			writeStale(rel);
		}
		const snapshotBeforeWorker = entrySnapshot();

		// —— 2. 机械巡检：⚠️ 同步进子索引，过阈值 → 巡库卡落本部队列 ——
		const report = await inspectLibrary(libRoot, { staleDays: STALE_DAYS, now: NOW });
		expect(report.flaggedCount).toBe(5);
		const hint = await hook()(report);
		expect(hint).toContain("已落巡库卡");
		expect(hint).toContain("不准动条目正文");

		// 幂等：同部门已有未终态巡库卡，复检不重复落卡
		const again = await hook()(report);
		expect(again).toContain("不重复落卡");
		expect(readdirSync(cardsDir).filter((f) => f.endsWith(".md"))).toHaveLength(1);

		// —— 3. 巡库卡作为普通卡可被派发：认领（待认领→进行中）——
		const cardFiles = listCards(cardsDir);
		expect(cardFiles).toHaveLength(1);
		const card = loadCard(cardsDir, cardFiles[0]!.card_no);
		expect(card.frontmatter.status).toBe("unclaimed");
		expect(card.frontmatter.constraints).toBe(PATROL_CONSTRAINT); // 红线随卡走
		expect(card.frontmatter.inputs).toContain(`知识库根:${libRoot}`);
		expect(card.frontmatter.inputs).toContain("教训/甲.md");
		const claimed = changeCardStatus(card, {
			操作者: "巡库-worker",
			to: "in_progress",
			时间: "2026-10-02 10:05",
		});
		expect(claimed.frontmatter.status).toBe("in_progress");
		expect(claimed.frontmatter.owner).toBe("巡库-worker");

		// —— 4. worker 阶段：只准写初判文件与回执，条目正文零差异（红线断言）——
		for (const rel of report.findings.filter((f) => f.flagged).map((f) => f.relPath)) {
			appendPatrolJudgment(libRoot, judgmentOf(claimed.card_no, rel, "更新"));
		}
		// 五条初判可按卡号取回（初判走结果文件的约定落点）
		expect(readFileSync(join(libRoot, ".pao-巡库初判.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(5);
		expect(entrySnapshot()).toEqual(snapshotBeforeWorker); // 红线：条目正文一字不动

		// 回执回本部队列（worker 只追加回执，不改状态不改信封）
		const outcome = appendReceipt(claimed, {
			尝试号: claimed.frontmatter.attempt,
			时间: "2026-10-02 10:20",
			结果: "五条 ⚠️ 已附初判",
			摘要: "初判落 .pao-巡库初判.jsonl；未动任何条目正文；待部长终审",
		});
		expect(outcome.kind).toBe("已记录");

		// —— 5. 部长终审三选一（机械支撑）：更新 / 退役 / 打回待验证 ——
		// 更新：部长改写条目新日期（内容行为归部长），复检后 ⚠️ 摘除
		writeStale("教训/甲.md");
		writeFileSync(
			join(libRoot, "教训/甲.md"),
			"超期条目 2026-10-02 版本:v2\n正文（部长已更新）\n适用范围: demo-proj",
			"utf8",
		);
		// 退役：移归档＋子索引同批摘行，只归档不删除
		const retired = await retireEntry({ libRoot, relPath: "教训/乙.md" });
		expect(existsSync(join(libRoot, "归档/乙.md"))).toBe(true);
		expect(retired.actions.join("\n")).toContain("子索引已摘行");
		// 打回待验证：存疑内容不冒充有效货
		const demoted = await demoteToPending({ libRoot, relPath: "做法/丙.md" });
		expect(existsSync(join(libRoot, "待验证/丙.md"))).toBe(true);
		expect(demoted.actions.join("\n")).toContain("子索引已摘行");

		// 复检：⚠️ 只剩未消化的 丁/戊；终审三向都对子索引做了同批维护
		const final = await inspectLibrary(libRoot, { staleDays: STALE_DAYS, now: NOW });
		expect(final.flaggedCount).toBe(2);
		expect(
			final.findings
				.filter((f) => f.flagged)
				.map((f) => f.relPath)
				.sort(),
		).toEqual(["做法/丁.md", "导览/戊.md"]);
		const lessonRows = readFileSync(join(libRoot, "教训", "子索引.md"), "utf8");
		expect(lessonRows).not.toContain("乙.md"); // 退役同批摘行
		expect(lessonRows).toContain("甲.md"); // 更新后保留且不带 ⚠️
		expect(
			lessonRows
				.split("\n")
				.find((l) => l.includes("甲.md"))!
				.includes("⚠️"),
		).toBe(false);
		// 门面/子索引一致性：终审后两向清零
		expect(final.consistency?.entriesWithoutRow).toEqual([]);
		expect(final.consistency?.rowsWithoutEntry).toEqual([]);

		// —— 6. 结卡：初判被终审消化，巡库卡落终态（先重读卡面，保住盘上回执不被覆盖）——
		const onDisk = loadCard(cardsDir, cardFiles[0]!.card_no);
		expect(onDisk.body).toContain("初判落"); // 回执在卡上
		const closed = changeCardStatus(onDisk, {
			操作者: "巡库-worker",
			to: "delivered",
			时间: "2026-10-02 11:00",
		});
		expect(closed.frontmatter.status).toBe("delivered");
		// 终态迁移不覆盖回执：卡上仍有 worker 回执段
		expect(loadCard(cardsDir, cardFiles[0]!.card_no).body).toContain("初判落");
	});

	test("不过阈值不落卡；阈值默认 5（§6.7），条目不足时只留 ⚠️ 待积累", async () => {
		for (const rel of ["教训/甲.md", "教训/乙.md", "做法/丙.md", "做法/丁.md"]) {
			writeStale(rel);
		}
		const report = await inspectLibrary(libRoot, { staleDays: STALE_DAYS, now: NOW });
		expect(report.flaggedCount).toBe(4);
		const hint = await hook()(report);
		expect(hint).toBeUndefined();
		expect(readdirSync(cardsDir).filter((f) => f.endsWith(".md"))).toHaveLength(0);
	});
});

describe("M2-05：初判记录文件约定", () => {
	test("worker 初判必须是三选一；坏行跳过不阻断终审读取", () => {
		writeStale("教训/甲.md");
		appendPatrolJudgment(libRoot, judgmentOf(7, "教训/甲.md", "退役"));
		expect(() => appendPatrolJudgment(libRoot, judgmentOf(7, "教训/甲.md", "直接删除" as never))).toThrow("三选一");
		// 一条坏行 + 两条好行：读取只出好行
		appendFileSync(join(libRoot, ".pao-巡库初判.jsonl"), "{半截JSON\n", "utf8");
		appendPatrolJudgment(libRoot, judgmentOf(7, "教训/甲.md", "更新"));
		const judgments = loadPatrolJudgments(libRoot, { 卡号: 7 });
		expect(judgments).toHaveLength(2);
		expect(judgments.map((j) => j.初判).sort()).toEqual(["更新", "退役"]);
	});

	test("合法 JSON 但形状不对的行同样按坏行跳过（行守卫，不裸断言）", () => {
		writeStale("教训/乙.md");
		appendPatrolJudgment(libRoot, judgmentOf(8, "教训/乙.md", "打回待验证"));
		// 非对象行 / 卡号非数 / 初判越出三选一：都不许混进初判列表
		appendFileSync(
			join(libRoot, ".pao-巡库初判.jsonl"),
			[
				"42",
				JSON.stringify({ time: NOW.toISOString(), 卡号: "8", relPath: "教训/乙.md", 初判: "更新" }),
				JSON.stringify({ time: NOW.toISOString(), 卡号: 8, relPath: "教训/乙.md", 初判: "乱写" }),
				"",
			].join("\n"),
			"utf8",
		);
		const all = loadPatrolJudgments(libRoot);
		expect(all).toHaveLength(1);
		expect(all[0]?.卡号).toBe(8);
		expect(all[0]?.初判).toBe("打回待验证");
	});
});
