import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createCard, readCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import {
	appendMetricsLine,
	buildMetricsLine,
	countGateConfirms,
	countRejections,
	METRICS_LEDGER_HEADER,
	metricsDurationSeconds,
	metricsLedgerPath,
	sumReceiptCost,
} from "../../src/pao/cards/metrics.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard, Receipt } from "../../src/pao/cards/types.ts";
import { writeFileAtomic } from "../../src/pao/shared/atomic.ts";

/**
 * M2-09 结卡四指标机械摘要：账行 = 卡号\t目标\t终态\t总时长秒\t全角色合计成本\t介入次数。
 * 介入次数 v1 = 人工门确认 + 打回 + 分支裁决（恒 0，未落机制不造数），明标不含用户自由插话。
 * 纯函数（buildMetricsLine/sumReceiptCost/countRejections/metricsDurationSeconds/countGateConfirms）
 * 与薄 IO（appendMetricsLine）分离，账行落盘接线在 statemachine.changeCardStatus（终态生效唯一路径）。
 */

function makeWorkspace(): { root: string; cardsDir: string } {
	// 与任务工作区同构的嵌套布局：卡目录 = root/.pao/任务-20261002/卡，项目 .pao/ = 卡目录上两级
	const root = mkdtempSync(join(tmpdir(), "pao-metrics-"));
	const cardsDir = join(root, ".pao", "任务-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return { root, cardsDir };
}

function fakeCard(overrides?: Partial<ParsedCard>): ParsedCard {
	return {
		path: join("工作区", ".pao", "任务", "卡", "卡0001-测试卡.md"),
		filename: "卡0001-测试卡.md",
		card_no: 1,
		frontmatter: {
			goal: "交付某功能",
			dept: "研发",
			acceptance: "测试全绿",
			attempt: 1,
			created: "2026-10-02 21:00",
			status: "delivered",
		},
		body: "",
		receipts: [],
		...overrides,
	};
}

function receipt(partial: Partial<Receipt>): Receipt {
	return { card_no: 1, attempt: 1, time: "2026-10-02 22:00", ...partial };
}

/** 实例清单 fixture（driver serializeManifest 同构；YAML 缩进用空格） */
function manifestContent(nodeLine: string[]): string {
	return [
		"---",
		"工作流: 侦察流",
		"卡目录: 任务工作区",
		'启动: "2026-10-02 10:00"',
		"状态: 运行中",
		"参数: {}",
		"节点:",
		...nodeLine,
		"---",
		"实例清单正文",
	].join("\n");
}

describe("buildMetricsLine 账行拼装（纯函数）", () => {
	test("六字段 Tab 分隔：卡号四位、总时长秒、成本合计、介入次数", () => {
		const line = buildMetricsLine({
			card: fakeCard(),
			receipts: [
				receipt({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 3 } }),
				receipt({ usage: { cost: 0.25, turns: 2 } }),
				receipt({ archive_flag: "late_receipt" }), // 打回痕迹：无用量计 0，介入 +1
			],
			终态: "delivered",
			终态时刻: "2026-10-02 22:30",
			人工门确认次数: 2,
		});
		expect(line.split("\t")).toEqual(["卡0001", "交付某功能", "delivered", "5400", "0.75", "3"]);
	});

	test("成本口径复用 §15：逐行 usageLineFromEventState → 汇总用量；无用量回执计 0", () => {
		const cardNo = 1;
		expect(sumReceiptCost(cardNo, [receipt({}), receipt({ usage: { cost: 1.5 } })])).toBe(1.5);
		expect(sumReceiptCost(cardNo, [])).toBe(0);
		// 用量坏字段（非数/负数）按 0 计，不猜不抛
		expect(sumReceiptCost(cardNo, [receipt({ usage: { cost: "未知" } })])).toBe(0);
		expect(sumReceiptCost(cardNo, [receipt({ usage: { cost: -3 } })])).toBe(0);
		// 浮点尾只做显示级取整：0.1+0.2 → 0.3
		expect(sumReceiptCost(cardNo, [receipt({ usage: { cost: 0.1 } }), receipt({ usage: { cost: 0.2 } })])).toBe(0.3);
		// 多回执 cost 相加（input/output 等字段走同一条 UsageLine 通道，账行只取 cost）
		expect(
			sumReceiptCost(cardNo, [
				receipt({ usage: { input: 1, output: 2, cost: 1, turns: 2 } }),
				receipt({ usage: { input: 3, output: 4, cost: 2, turns: 3 } }),
			]),
		).toBe(3);
	});

	test("打回次数 = 带留档标记的回执条数；分支裁决 v1 恒 0 不占账", () => {
		const receipts = [
			receipt({}),
			receipt({ archive_flag: "old_attempt" }),
			receipt({ archive_flag: "late_receipt" }),
		];
		expect(countRejections(receipts)).toBe(2);
		const line = buildMetricsLine({
			card: fakeCard(),
			receipts,
			终态: "failed",
			终态时刻: "2026-10-02 22:00",
			人工门确认次数: 0,
		});
		expect(line.split("\t")[5]).toBe("2");
	});

	test("总时长秒：创建→终态时刻；任一端解析不出按 0，时钟回拨收 0 不造负数", () => {
		expect(metricsDurationSeconds("2026-10-02 21:00", "2026-10-02 21:00")).toBe(0);
		expect(metricsDurationSeconds("2026-10-02 22:00", "2026-10-02 21:00")).toBe(0);
		expect(metricsDurationSeconds("创建时间缺失", "2026-10-02 21:00")).toBe(0);
		const line = buildMetricsLine({
			card: fakeCard({
				frontmatter: { goal: "x", dept: "y", acceptance: "z", attempt: 1, created: "坏时间", status: "delivered" },
			}),
			receipts: [],
			终态: "delivered",
			终态时刻: "2026-10-02 22:00",
			人工门确认次数: 0,
		});
		expect(line.split("\t")[3]).toBe("0");
	});

	test("目标里的换行/Tab 压成空格：一行一卡，Tab 只作字段分隔符", () => {
		const card = fakeCard({
			frontmatter: {
				goal: "多行\n目标\t带分隔",
				dept: "研发",
				acceptance: "z",
				attempt: 1,
				created: "2026-10-02 21:00",
				status: "delivered",
			},
		});
		const line = buildMetricsLine({
			card,
			receipts: [],
			终态: "canceled",
			终态时刻: "2026-10-02 21:05",
			人工门确认次数: 0,
		});
		expect(line.split("\t")).toEqual(["卡0001", "多行 目标 带分隔", "canceled", "300", "0", "0"]);
	});
});

describe("countGateConfirms 人工门确认次数（读工作流实例清单）", () => {
	function markerCard(cardsDir: string): ParsedCard {
		return fakeCard({
			path: join(cardsDir, "卡0001-测试卡.md"),
			body: "<!-- pao-workflow:流=侦察流/节点=侦察 -->\n正文",
		});
	}

	test("卡不在任何工作流（无标记）→ 0；标记在而清单缺失 → 0", () => {
		const { cardsDir } = makeWorkspace();
		expect(countGateConfirms(fakeCard())).toBe(0);
		expect(countGateConfirms(markerCard(cardsDir))).toBe(0);
	});

	test("清单里本卡节点已点头 → 1；未点头 → 0；点头记在别的卡上 → 0", () => {
		const { cardsDir } = makeWorkspace();
		const manifestPath = join(cardsDir, "..", "工作流实例-侦察流.md");
		writeFileSync(
			manifestPath,
			manifestContent(["  - 名字: 侦察", "    卡号: 卡0001", '    确认: "2026-10-02 11:00"']),
		);
		expect(countGateConfirms(markerCard(cardsDir))).toBe(1);

		writeFileSync(manifestPath, manifestContent(["  - 名字: 侦察", "    卡号: 卡0001"]));
		expect(countGateConfirms(markerCard(cardsDir))).toBe(0);

		writeFileSync(
			manifestPath,
			manifestContent(["  - 名字: 侦察", "    卡号: 卡0002", '    确认: "2026-10-02 11:00"']),
		);
		expect(countGateConfirms(markerCard(cardsDir))).toBe(0);
	});
});

describe("appendMetricsLine 薄 IO：首行口径注释写死一次，追加不重复", () => {
	test("文件不存在则建：首行口径注释，第二行数据行", () => {
		const { root } = makeWorkspace();
		const ledgerPath = join(root, ".pao", "四指标账.txt");
		appendMetricsLine(ledgerPath, "卡0001\t测试\t已交付\t60\t0\t0");
		const lines = readFileSync(ledgerPath, "utf8").split("\n");
		expect(lines[0]).toBe(METRICS_LEDGER_HEADER);
		expect(lines[0]).toContain("不含用户自由插话");
		expect(lines[1]).toBe("卡0001\t测试\t已交付\t60\t0\t0");
	});

	test("已存在则只追加数据行，口径注释不重复写", () => {
		const { root } = makeWorkspace();
		const ledgerPath = join(root, ".pao", "四指标账.txt");
		appendMetricsLine(ledgerPath, "卡0001\t甲卡\t已交付\t60\t0\t0");
		appendMetricsLine(ledgerPath, "卡0002\t乙卡\t失败\t120\t1.5\t1");
		const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines.filter((l) => l === METRICS_LEDGER_HEADER)).toHaveLength(1);
		expect(lines[2]).toBe("卡0002\t乙卡\t失败\t120\t1.5\t1");
	});

	test("metricsLedgerPath：卡目录上一级（编排区，与基线快照同层；标准布局即 .pao/ 下）", () => {
		const { cardsDir, root } = makeWorkspace();
		expect(metricsLedgerPath(cardsDir)).toBe(join(root, ".pao", "任务-20261002", "四指标账.txt"));
	});

	test("旧格式账本追加兼容：既有机器写账（注释＋数据行,换行结尾）之上追加不重写不丢行", () => {
		const { root } = makeWorkspace();
		const ledgerPath = join(root, ".pao", "四指标账.txt");
		// 模拟旧版写入器留下的账（每行以 \n 结尾的机器格式）
		writeFileAtomic(
			ledgerPath,
			`${METRICS_LEDGER_HEADER}\n${Array.from({ length: 50 }, (_, i) => `卡${String(i + 1).padStart(4, "0")}\t旧卡${i}\t失败\t${i}\t0\t0`).join("\n")}\n`,
		);
		appendMetricsLine(ledgerPath, "卡0051\t新卡\t已交付\t60\t0\t0");
		const lines = readFileSync(ledgerPath, "utf8").split("\n");
		expect(lines).toHaveLength(53); // 50 旧数据行＋1 新行＋注释＋末尾空串
		expect(lines[0]).toBe(METRICS_LEDGER_HEADER);
		expect(lines.filter((l) => l === METRICS_LEDGER_HEADER)).toHaveLength(1);
		expect(lines[51]).toBe("卡0051\t新卡\t已交付\t60\t0\t0");
		expect(lines[1]).toBe("卡0001\t旧卡0\t失败\t0\t0\t0");
	});
});

describe("changeCardStatus 接线：落入已交付/失败/取消才落账", () => {
	test("进行中不落账；失败落一行；打回痕迹计入下一次失败；交付再落一行", async () => {
		const { cardsDir } = makeWorkspace();
		const card = await createCard(cardsDir, {
			目标: "结账卡",
			部门: "研发",
			验收: "可判条件",
			创建: "2026-10-02 21:00",
		});
		const ledgerPath = metricsLedgerPath(cardsDir);
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		expect(existsSync(ledgerPath)).toBe(false); // 非结卡状态不落账

		// worker 交当前尝试回执（成本 1.25），首次失败结一行
		appendReceipt(claimed, { 尝试号: 1, 时间: "2026-10-02 21:20", 摘要: "干完了", 用量: { cost: 1.25, turns: 4 } });
		const failed = changeCardStatus(readCard(card.path), {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-02 21:30",
		});
		expect(existsSync(ledgerPath)).toBe(true);
		const afterFail = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
		expect(afterFail).toHaveLength(2);
		expect(afterFail[0]).toBe(METRICS_LEDGER_HEADER);
		expect(afterFail[1].split("\t")).toEqual(["卡0001", "结账卡", "failed", "1800", "1.25", "0"]);

		// 重派后旧尝试回执迟到 → 旧尝试留档（打回痕迹落卡），再次失败时介入 +1
		const back = changeCardStatus(failed, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:40" });
		const running = changeCardStatus(back, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:50" });
		appendReceipt(running, { 尝试号: 1, 时间: "2026-10-02 21:55", 结果: "补充" });
		changeCardStatus(readCard(card.path), {
			操作者: "部长A",
			to: "failed",
			失败类型: "insufficient_capability",
			时间: "2026-10-02 22:00",
		});
		const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[2].split("\t")).toEqual(["卡0001", "结账卡", "failed", "3600", "1.25", "1"]);

		// 三轮交付：新回执成本并入合计，账是流水逐次落行；口径注释仍只一行
		const back2 = changeCardStatus(readCard(card.path), {
			操作者: "部长A",
			to: "unclaimed",
			时间: "2026-10-02 22:02",
			尝试上限: 3,
		});
		const running2 = changeCardStatus(back2, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 22:04" });
		appendReceipt(running2, { 尝试号: 3, 时间: "2026-10-02 22:06", 摘要: "这回成了", 用量: { cost: 0.75 } });
		changeCardStatus(readCard(card.path), { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:10" });
		const final = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
		expect(final).toHaveLength(4);
		expect(final[3].split("\t")).toEqual(["卡0001", "结账卡", "delivered", "4200", "2", "1"]);
		expect(final.filter((l) => l === METRICS_LEDGER_HEADER)).toHaveLength(1);
	});

	test("工作流卡：人工门已点头计入介入次数", async () => {
		const { cardsDir } = makeWorkspace();
		const card = await createCard(cardsDir, {
			目标: "流程卡",
			部门: "研发",
			验收: "可判条件",
			创建: "2026-10-02 21:00",
		});
		// 落流归属标记（driver 落卡后补写首行的同款形状）+ 实例清单（本卡节点已点头）
		const marker = "<!-- pao-workflow:流=侦察流/节点=侦察 -->";
		writeFileAtomic(card.path, serializeCard(card.frontmatter, `${marker}\n${card.body}`.trim()));
		writeFileSync(
			join(cardsDir, "..", "工作流实例-侦察流.md"),
			manifestContent(["  - 名字: 侦察", "    卡号: 卡0001", '    确认: "2026-10-02 11:00"']),
		);
		const claimed = changeCardStatus(readCard(card.path), {
			操作者: "部长A",
			to: "in_progress",
			时间: "2026-10-02 21:10",
		});
		changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 21:30" });
		const lines = readFileSync(metricsLedgerPath(cardsDir), "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1].split("\t")).toEqual(["卡0001", "流程卡", "delivered", "1800", "0", "1"]);
	});
});
