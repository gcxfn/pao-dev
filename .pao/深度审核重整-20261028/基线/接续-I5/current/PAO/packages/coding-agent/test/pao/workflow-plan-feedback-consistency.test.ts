import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTemporaryPlan,
	listPlanHistory,
	modifyTemporaryPlan,
	readTemporaryPlan,
} from "../../src/pao/workflow/plan.ts";
import {
	listPlanFeedback,
	markPlanFeedbackApplied,
	recordPlanFeedback,
	recordPlanFeedbackDelivery,
} from "../../src/pao/workflow/plan-feedback.ts";

const dirs: string[] = [];
const departments = ["策划部", "写作部"];
const owner = "owner-a";

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-plan-feedback-consistency-"));
	dirs.push(dir);
	return dir;
}

function steps() {
	return [
		{
			步骤ID: "s1",
			标题: "讨论计划",
			部门: "策划部",
			要求: "把方向与章节计划讨论清楚",
		},
		{
			步骤ID: "s2",
			标题: "写初稿",
			部门: "写作部",
			要求: "按计划写初稿",
		},
	];
}

async function createPlan(projectRoot: string) {
	return createTemporaryPlan({
		项目根: projectRoot,
		显示名: "一致性计划",
		来源会话: owner,
		步骤: steps(),
		请求ID: "create-consistency-plan",
		已注册部门: departments,
		当刻: "2026-10-26 10:00",
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("临时计划与意见一致性", () => {
	it("计划改版且目标步骤已不存在时，同一投递请求仍按首次记录回放", async () => {
		const projectRoot = tempDir();
		const created = await createPlan(projectRoot);
		const first = await recordPlanFeedback({
			项目根: projectRoot,
			计划ID: created.计划ID,
			期望定义版本: 1,
			目标: { 类型: "步骤", 步骤ID: "s1" },
			正文: "保留人物小传这一版",
			投递请求ID: "deliver-replay-1",
			来源会话: owner,
			当刻: "2026-10-26 10:01",
		});

		await modifyTemporaryPlan({
			项目根: projectRoot,
			计划ID: created.计划ID,
			请求ID: "modify-after-feedback",
			预期定义版本: 1,
			步骤: steps().filter((step) => step.步骤ID !== "s1"),
			已注册部门: departments,
			来源会话: owner,
			当刻: "2026-10-26 10:02",
		});

		const replay = await recordPlanFeedback({
			项目根: projectRoot,
			计划ID: created.计划ID,
			期望定义版本: 1,
			目标: { 类型: "步骤", 步骤ID: "s1" },
			正文: "保留人物小传这一版",
			投递请求ID: "deliver-replay-1",
			来源会话: owner,
		});
		expect(replay).toMatchObject({ 回放: true, entry: { 意见ID: first.entry.意见ID, 定义版本: 1 } });
		expect(listPlanFeedback(projectRoot, created.计划ID)).toHaveLength(1);

		for (const changed of [
			{ 正文: "换了内容", 目标: { 类型: "步骤" as const, 步骤ID: "s1" }, 期望定义版本: 1 },
			{ 正文: "保留人物小传这一版", 目标: { 类型: "步骤" as const, 步骤ID: "s2" }, 期望定义版本: 1 },
			{ 正文: "保留人物小传这一版", 目标: { 类型: "步骤" as const, 步骤ID: "s1" }, 期望定义版本: 2 },
		]) {
			await expect(
				recordPlanFeedback({
					项目根: projectRoot,
					计划ID: created.计划ID,
					...changed,
					投递请求ID: "deliver-replay-1",
					来源会话: owner,
				}),
			).rejects.toMatchObject({ code: "PLAN_REQUEST_CONFLICT" });
		}
		expect(listPlanFeedback(projectRoot, created.计划ID)).toHaveLength(1);
	});

	it("并发修改持有计划锁时，意见不会拿着旧版本落在新计划上", async () => {
		const projectRoot = tempDir();
		const created = await createPlan(projectRoot);
		let releaseModify!: () => void;
		let markInLock!: () => void;
		const modifyCanFinish = new Promise<void>((resolve) => {
			releaseModify = resolve;
		});
		const modifyIsInLock = new Promise<void>((resolve) => {
			markInLock = resolve;
		});

		const modifying = modifyTemporaryPlan({
			项目根: projectRoot,
			计划ID: created.计划ID,
			请求ID: "modify-during-feedback",
			预期定义版本: 1,
			步骤: steps(),
			已注册部门: departments,
			来源会话: owner,
			当刻: "2026-10-26 10:03",
			beforeWrite: async () => {
				markInLock();
				await modifyCanFinish;
			},
		});
		await modifyIsInLock;
		const recordingWithOldVersion = recordPlanFeedback({
			项目根: projectRoot,
			计划ID: created.计划ID,
			期望定义版本: 1,
			目标: { 类型: "流程" },
			正文: "使用了旧版定义",
			来源会话: owner,
		});
		releaseModify();
		await modifying;
		await expect(recordingWithOldVersion).rejects.toMatchObject({ code: "PLAN_VERSION_CONFLICT" });
		expect(listPlanFeedback(projectRoot, created.计划ID)).toHaveLength(0);

		const recorded = await recordPlanFeedback({
			项目根: projectRoot,
			计划ID: created.计划ID,
			期望定义版本: 2,
			目标: { 类型: "流程" },
			正文: "按最终定义记录",
			来源会话: owner,
		});
		expect(recorded.entry.定义版本).toBe(readTemporaryPlan(projectRoot, created.计划ID).定义版本);
		expect(listPlanFeedback(projectRoot, created.计划ID)).toHaveLength(1);
		expect(listPlanHistory(projectRoot, created.计划ID)).toHaveLength(1);
		expect(readTemporaryPlan(projectRoot, created.计划ID).定义版本).toBe(2);
	});

	it("已应用不被迟到失败降级，已送达后的矛盾失败回执保持原记录", async () => {
		const projectRoot = tempDir();
		const created = await createPlan(projectRoot);
		const first = await recordPlanFeedback({
			项目根: projectRoot,
			计划ID: created.计划ID,
			目标: { 类型: "步骤", 步骤ID: "s1" },
			正文: "需要修订",
			投递请求ID: "deliver-state-1",
			来源会话: owner,
		});
		await recordPlanFeedbackDelivery({
			项目根: projectRoot,
			计划ID: created.计划ID,
			意见ID: first.entry.意见ID,
			送达: true,
			结果: "queued",
			投递请求ID: "deliver-state-1",
			来源会话: owner,
		});
		const applied = await markPlanFeedbackApplied({
			项目根: projectRoot,
			计划ID: created.计划ID,
			意见ID: first.entry.意见ID,
			依据: "修订 2 已采用",
			来源会话: owner,
		});
		const lateFailure = await recordPlanFeedbackDelivery({
			项目根: projectRoot,
			计划ID: created.计划ID,
			意见ID: first.entry.意见ID,
			送达: false,
			结果: "迟到失败",
			投递请求ID: "deliver-state-1",
			来源会话: owner,
		});
		expect(lateFailure).toEqual(applied);
		expect(lateFailure).toMatchObject({ 状态: "已应用", 投递: { 送达: true, 结果: "queued" } });

		const second = await recordPlanFeedback({
			项目根: projectRoot,
			计划ID: created.计划ID,
			目标: { 类型: "步骤", 步骤ID: "s2" },
			正文: "需要投递",
			投递请求ID: "deliver-state-2",
			来源会话: owner,
		});
		const delivered = await recordPlanFeedbackDelivery({
			项目根: projectRoot,
			计划ID: created.计划ID,
			意见ID: second.entry.意见ID,
			送达: true,
			结果: "accepted",
			投递请求ID: "deliver-state-2",
			来源会话: owner,
			部长: "写作部长",
			实例: "instance-2",
		});
		expect(
			await recordPlanFeedbackDelivery({
				项目根: projectRoot,
				计划ID: created.计划ID,
				意见ID: second.entry.意见ID,
				送达: true,
				结果: "accepted",
				投递请求ID: "deliver-state-2",
				来源会话: owner,
				部长: "写作部长",
				实例: "instance-2",
			}),
		).toEqual(delivered);
		await expect(
			recordPlanFeedbackDelivery({
				项目根: projectRoot,
				计划ID: created.计划ID,
				意见ID: second.entry.意见ID,
				送达: true,
				结果: "accepted",
				投递请求ID: "deliver-state-2",
				来源会话: owner,
				部长: "另一个部长",
				实例: "instance-2",
			}),
		).rejects.toMatchObject({ code: "PLAN_REQUEST_CONFLICT" });
		await expect(
			recordPlanFeedbackDelivery({
				项目根: projectRoot,
				计划ID: created.计划ID,
				意见ID: second.entry.意见ID,
				送达: false,
				结果: "矛盾失败",
				投递请求ID: "deliver-state-2",
				来源会话: owner,
				部长: "写作部长",
				实例: "instance-2",
			}),
		).rejects.toMatchObject({ code: "PLAN_REQUEST_CONFLICT" });
		expect(
			listPlanFeedback(projectRoot, created.计划ID).find((entry) => entry.意见ID === second.entry.意见ID),
		).toEqual(delivered);
	});
});
