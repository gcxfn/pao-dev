import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { PaoCardError } from "../../src/pao/cards/errors.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import {
	changeCardStatus,
	checkTransition,
	checkWriterAuthority,
	DEFAULT_ATTEMPT_LIMIT,
} from "../../src/pao/cards/statemachine.ts";

function makeCardsDir(): string {
	// 与任务工作区同构的嵌套布局，避免默认计数器落到共享上级目录
	const dir = mkdtempSync(join(tmpdir(), "pao-sm-"));
	const cardsDir = join(dir, ".pao", "任务-20261002", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return cardsDir;
}

async function makeCard(goal = "测试卡") {
	return createCard(makeCardsDir(), {
		目标: goal,
		部门: "核心机制",
		验收: "可判条件",
		创建: "2026-10-02 21:00",
	});
}

describe("checkTransition 迁移规则（模板 §2 表）", () => {
	test("合法迁移放行", () => {
		expect(() => checkTransition({ from: "unclaimed", to: "in_progress", 尝试: 0 })).not.toThrow();
		expect(() => checkTransition({ from: "in_progress", to: "delivered", 尝试: 1 })).not.toThrow();
		expect(() => checkTransition({ from: "in_progress", to: "failed", 尝试: 1 })).not.toThrow();
		expect(() => checkTransition({ from: "failed", to: "unclaimed", 尝试: 1 })).not.toThrow();
		expect(() => checkTransition({ from: "in_progress", to: "canceled", 尝试: 1 })).not.toThrow();
		expect(() => checkTransition({ from: "failed", to: "canceled", 尝试: 1 })).not.toThrow();
	});

	test("非法迁移拒绝：已交付/取消为终态，无出边", () => {
		expect(() => checkTransition({ from: "delivered", to: "in_progress", 尝试: 1 })).toThrow(PaoCardError);
		expect(() => checkTransition({ from: "canceled", to: "unclaimed", 尝试: 1 })).toThrow(PaoCardError);
		expect(() => checkTransition({ from: "unclaimed", to: "delivered", 尝试: 0 })).toThrow(PaoCardError);
		expect(() => checkTransition({ from: "unclaimed", to: "failed", 尝试: 0 })).toThrow(PaoCardError);
	});

	test("重试门：失败→待认领须尝试数 < 上限（默认 2），到顶报 ATTEMPT_EXCEEDED", () => {
		expect(() => checkTransition({ from: "failed", to: "unclaimed", 尝试: 1 })).not.toThrow();
		try {
			checkTransition({ from: "failed", to: "unclaimed", 尝试: 2 });
			expect.unreachable("应当抛错");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("ATTEMPT_EXCEEDED");
		}
		// owner 显式提高上限可放行
		expect(() => checkTransition({ from: "failed", to: "unclaimed", 尝试: 2, 尝试上限: 3 })).not.toThrow();
		expect(DEFAULT_ATTEMPT_LIMIT).toBe(2);
	});
});

describe("changeCardStatus 单写者与字段效果", () => {
	test("认领（待认领→进行中）：写 owner、递增尝试、落审计段", async () => {
		const card = await makeCard("认领流程卡");
		const updated = changeCardStatus(card, {
			操作者: "部长A",
			to: "in_progress",
			时间: "2026-10-02 21:10",
		});
		expect(updated.frontmatter.status).toBe("in_progress");
		expect(updated.frontmatter.owner).toBe("部长A");
		expect(updated.frontmatter.attempt).toBe(1);

		const reread = readCard(updated.path);
		expect(reread.frontmatter.attempt).toBe(1);
		expect(reread.body).toContain("状态改为 in_progress");
	});

	test("非 owner 改状态被拒（FORBIDDEN_WRITER），文件未被改动", async () => {
		const card = await makeCard("越权卡");
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		try {
			changeCardStatus(claimed, { 操作者: "部长B", to: "delivered", 时间: "2026-10-02 21:20" });
			expect.unreachable("应当抛错");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("FORBIDDEN_WRITER");
		}
		const reread = readCard(claimed.path);
		expect(reread.frontmatter.status).toBe("in_progress");
	});

	test("已认领卡重试回队后被第二人认领被拒（双开识别）", async () => {
		const card = await makeCard("双开卡");
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		const failed = changeCardStatus(claimed, {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-02 21:12",
		});
		// 回到待认领，owner 仍是 部长A
		const back = changeCardStatus(failed, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:14" });
		expect(back.frontmatter.owner).toBe("部长A");
		expect(() => changeCardStatus(back, { 操作者: "部长B", to: "in_progress", 时间: "2026-10-02 21:15" })).toThrow(
			/已被 部长A 认领/,
		);
	});

	test("进行中→已交付：写完成时间；失败必带失败类型", async () => {
		const card = await makeCard("交付卡");
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		const delivered = changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:00" });
		expect(delivered.frontmatter.completed).toBe("2026-10-02 22:00");

		const card2 = await makeCard("失败缺类型卡");
		const claimed2 = changeCardStatus(card2, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		expect(() => changeCardStatus(claimed2, { 操作者: "部长A", to: "failed", 时间: "2026-10-02 21:15" })).toThrow(
			/失败类型/,
		);
	});

	test("重试链：失败→待认领不递增尝试、再次启动才递增；历史留审计段；无完成时间残留", async () => {
		const card = await makeCard("重试卡");
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		const failed = changeCardStatus(claimed, {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			依据: "网络超时",
			时间: "2026-10-02 21:15",
		});
		expect(failed.frontmatter.attempt).toBe(1);

		const retried = changeCardStatus(failed, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:16" });
		expect(retried.frontmatter.attempt).toBe(1); // 重试回队不递增
		expect(retried.frontmatter.completed).toBeUndefined();

		const reclaimed = changeCardStatus(retried, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:20" });
		expect(reclaimed.frontmatter.attempt).toBe(2); // 实际启动才递增

		const body = readCard(reclaimed.path).body;
		expect(body).toContain("失败类型: transient");
		expect(body).toContain("状态改为 unclaimed");
	});

	test("重试到上限被拒，须 owner 显式提高上限", async () => {
		const card = await makeCard("到顶卡");
		let current = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		current = changeCardStatus(current, {
			操作者: "部长A",
			to: "failed",
			失败类型: "missing_input",
			时间: "2026-10-02 21:12",
		});
		current = changeCardStatus(current, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:14" });
		current = changeCardStatus(current, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:15" });
		current = changeCardStatus(current, {
			操作者: "部长A",
			to: "failed",
			失败类型: "insufficient_capability",
			时间: "2026-10-02 21:18",
		});
		try {
			changeCardStatus(current, { 操作者: "部长A", to: "unclaimed", 时间: "2026-10-02 21:19" });
			expect.unreachable("应当抛错");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("ATTEMPT_EXCEEDED");
		}
		// 显式上限 3 允许第三轮
		const third = changeCardStatus(current, {
			操作者: "部长A",
			to: "unclaimed",
			时间: "2026-10-02 21:20",
			尝试上限: 3,
		});
		expect(third.frontmatter.status).toBe("unclaimed");
	});

	test("取消：owner 可取消；用户可取消无主卡；终态卡不可再迁移", async () => {
		const card = await makeCard("用户取消卡");
		const cancelled = changeCardStatus(card, {
			操作者: "用户",
			to: "canceled",
			依据: "用户决定",
			时间: "2026-10-02 21:05",
		});
		expect(cancelled.frontmatter.status).toBe("canceled");

		const owned = await makeCard("owner取消卡");
		const claimed = changeCardStatus(owned, { 操作者: "部长C", to: "in_progress", 时间: "2026-10-02 21:10" });
		const cancelled2 = changeCardStatus(claimed, { 操作者: "部长C", to: "canceled", 时间: "2026-10-02 21:12" });
		expect(cancelled2.frontmatter.status).toBe("canceled");
		expect(() =>
			changeCardStatus(cancelled2, { 操作者: "部长C", to: "in_progress", 时间: "2026-10-02 21:13" }),
		).toThrow(PaoCardError);
	});
});

describe("changeCardStatus 读-合并-写（不覆盖并发追加的回执）", () => {
	test("载入卡后盘上追加新回执，状态变更落盘保留回执且状态已更新", async () => {
		const card = await makeCard("并发回执卡");
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		// 验收跑命令期间 worker 按生产路径（重读卡→appendReceipt）落回执，owner 手里的卡对象不感知
		appendReceipt(readCard(claimed.path), {
			尝试号: claimed.frontmatter.attempt,
			时间: "2026-10-02 21:40",
			结果: "过",
			摘要: "验收命令全过",
		});

		const delivered = changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:00" });
		expect(delivered.frontmatter.status).toBe("delivered");
		expect(delivered.frontmatter.completed).toBe("2026-10-02 22:00");
		expect(delivered.receipts).toHaveLength(1);

		const reread = readCard(delivered.path);
		expect(reread.frontmatter.status).toBe("delivered");
		expect(reread.receipts).toHaveLength(1);
		expect(reread.receipts[0]?.summary).toBe("验收命令全过");
		expect(reread.body).toContain("## 回执 尝试1 2026-10-02 21:40");
		expect(reread.body).toContain("状态改为 delivered");
	});

	test("盘上状态已被并发变更时中止（INVALID_TRANSITION），盘上内容不被覆盖", async () => {
		const card = await makeCard("并发状态卡");
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		// 另一 owner 会话已把盘上卡落成取消
		changeCardStatus(readCard(claimed.path), { 操作者: "部长A", to: "canceled", 时间: "2026-10-02 21:30" });

		try {
			changeCardStatus(claimed, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:00" });
			expect.unreachable("应当抛错");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("INVALID_TRANSITION");
			expect((error as Error).message).toContain("已中止");
		}
		const reread = readCard(claimed.path);
		expect(reread.frontmatter.status).toBe("canceled");
		expect(reread.frontmatter.completed).toBeUndefined();
	});

	test("落盘前重读失败（卡被删/损坏）结构化报错且不覆盖盘上内容", async () => {
		const card = await makeCard("重读失败卡");
		const claimed = changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });

		const gone = readCard(claimed.path);
		unlinkSync(claimed.path);
		try {
			changeCardStatus(gone, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 21:20" });
			expect.unreachable("应当抛错");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("CARD_NOT_FOUND");
			expect((error as Error).message).toContain("已中止状态变更");
		}

		const corrupt = await makeCard("重读损坏卡");
		const corrupted = changeCardStatus(corrupt, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 21:10" });
		writeFileSync(corrupted.path, "损坏的内容", "utf8");
		try {
			changeCardStatus(corrupted, { 操作者: "部长A", to: "delivered", 时间: "2026-10-02 22:00" });
			expect.unreachable("应当抛错");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("INVALID_CARD");
			expect((error as Error).message).toContain("已中止状态变更");
		}
		expect(readFileSync(corrupted.path, "utf8")).toBe("损坏的内容");
	});
});

describe("checkWriterAuthority 单写者校验（纯函数直测，S11-B1 补面）", () => {
	const baseFrontmatter = {
		goal: "直测卡",
		dept: "核心机制",
		acceptance: "可判条件",
		attempt: 0,
		created: "2026-10-08 10:00",
		status: "unclaimed" as const,
	};

	test("无 owner 时非认领写被拒（只有认领或用户取消可写）", () => {
		try {
			checkWriterAuthority({ ...baseFrontmatter }, "部长A", "delivered");
			expect.unreachable("应当抛错");
		} catch (error) {
			expect((error as PaoCardError).code).toBe("FORBIDDEN_WRITER");
		}
	});

	test("owner 卡被「用户」做非取消迁移被拒，取消仍豁免", () => {
		const owned = { ...baseFrontmatter, status: "in_progress" as const, owner: "部长A" };
		expect(() => checkWriterAuthority(owned, "用户", "delivered")).toThrow(/只有 owner（部长A）可改状态/);
		expect(() => checkWriterAuthority(owned, "用户", "canceled")).not.toThrow();
	});
});
