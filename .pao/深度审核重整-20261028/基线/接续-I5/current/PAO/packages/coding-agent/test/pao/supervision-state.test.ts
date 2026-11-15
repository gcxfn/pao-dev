import { describe, expect, it } from "vitest";

import { SupervisionState } from "../../src/pao/supervision/index.ts";

function state(clock: { now: number }, workerMinutes = 15, departmentMinutes = 30): SupervisionState {
	return new SupervisionState({
		clock: () => clock.now,
		workerMinutes: () => workerMinutes,
		departmentMinutes: () => departmentMinutes,
	});
}

const progress = {
	goal: "修好登录回跳",
	recentProgress: "已定位回调参数",
	changes: ["src/login.ts"],
	verification: ["pnpm test login"],
	blocker: "等待真实环境日志",
	evidence: [".pao/evidence/login.log"],
};

describe("分层监督状态", () => {
	it("工人 15 分钟和部门 30 分钟各自到期,摘要包含目标、进展和证据入口", () => {
		const clock = { now: 0 };
		const supervision = state(clock);
		supervision.track({
			key: "worker:1",
			kind: "worker",
			department: "前端",
			projectRoot: "D:/p",
			progress,
		});
		supervision.track({
			key: "department:1",
			kind: "department",
			department: "前端",
			projectRoot: "D:/p",
			ownerSessionId: "owner-1",
			progress,
		});

		clock.now = 15 * 60_000;
		const workerWakes = supervision.due();
		expect(workerWakes).toHaveLength(1);
		expect(workerWakes[0]).toMatchObject({ kind: "worker", target: "minister", intervalMinutes: 15 });
		expect(workerWakes[0]!.text).toContain("目标:修好登录回跳");
		expect(workerWakes[0]!.text).toContain("近期进展:已定位回调参数");
		expect(workerWakes[0]!.text).toContain("证据入口: .pao/evidence/login.log");
		supervision.noticeInjected(workerWakes[0]!.works[0]!.key, workerWakes[0]!.noticeKey);

		clock.now = 30 * 60_000;
		const both = supervision.due();
		expect(both.map((wake) => wake.kind)).toEqual(["department"]);
		const department = both.find((wake) => wake.kind === "department")!;
		expect(department).toMatchObject({ target: "main", intervalMinutes: 30 });
	});

	it("pending 不重复到期,显式处理后才从处理时刻重新计时", () => {
		const clock = { now: 0 };
		const supervision = state(clock);
		supervision.track({ key: "worker:1", kind: "worker", department: "前端", projectRoot: "D:/p" });
		clock.now = 15 * 60_000;
		const first = supervision.due();
		expect(first).toHaveLength(1);
		supervision.noticeInjected("worker:1", first[0]!.noticeKey);
		clock.now = 45 * 60_000;
		expect(supervision.due()).toEqual([]);

		supervision.noticeRejected("worker:1");
		clock.now = 46 * 60_000;
		expect(supervision.due()).toHaveLength(1);
		supervision.noticeInjected("worker:1", "supervision-retry");
		expect(supervision.markHandled("worker:1")).toBe(true);
		clock.now = 59 * 60_000;
		expect(supervision.due()).toEqual([]);
		clock.now = 61 * 60_000;
		expect(supervision.due()).toHaveLength(1);
	});

	it("同一 owner 的多个部门合并成一条;不同 owner 不串组", () => {
		const clock = { now: 0 };
		const supervision = state(clock);
		for (const department of ["前端", "后端", "测试"]) {
			supervision.track({
				key: `department:${department}`,
				kind: "department",
				department,
				projectRoot: "D:/p",
				ownerSessionId: department === "测试" ? "owner-2" : "owner-1",
			});
		}
		clock.now = 30 * 60_000;
		const wakes = supervision.due();
		expect(wakes).toHaveLength(2);
		expect(wakes.find((wake) => wake.ownerSessionId === "owner-1")?.works).toHaveLength(2);
		expect(wakes.find((wake) => wake.ownerSessionId === "owner-2")?.works).toHaveLength(1);
	});

	it("只读分析仍监督;停审和待人工明确排除", () => {
		const clock = { now: 0 };
		const supervision = state(clock);
		supervision.track({
			key: "department:readonly",
			kind: "department",
			department: "规划",
			projectRoot: "D:/p",
			readonly: true,
		});
		supervision.track({
			key: "department:waiting",
			kind: "department",
			department: "验收",
			projectRoot: "D:/p",
			waitingForHuman: true,
		});
		clock.now = 30 * 60_000;
		const wakes = supervision.due();
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.works.map((work) => work.key)).toEqual(["department:readonly"]);
	});

	it("完成、失败、待裁决和取消都退出周期监督", () => {
		const clock = { now: 0 };
		const supervision = state(clock);
		for (const outcome of ["completed", "failed", "needs_ruling", "canceled"]) {
			const key = `worker:${outcome}`;
			supervision.track({ key, kind: "worker", department: "前端", projectRoot: "D:/p" });
			expect(supervision.finish(key)).toMatchObject({ key });
		}
		clock.now = 15 * 60_000;
		expect(supervision.due()).toEqual([]);
	});

	it("分钟显式 0 关闭;外部活动 getter 的 0 不会被 ?? 覆盖", () => {
		const clock = { now: 10 * 60_000 };
		const supervision = state(clock, 0, 0);
		supervision.track({ key: "worker:1", kind: "worker", department: "前端", projectRoot: "D:/p" });
		supervision.track({ key: "department:1", kind: "department", department: "前端", projectRoot: "D:/p" });
		expect(supervision.due()).toEqual([]);
	});

	it("retainOnly 只删除已消失外部活动,不清除手动登记对象", () => {
		const clock = { now: 0 };
		const supervision = state(clock);
		supervision.track({ key: "worker:external", kind: "worker", department: "前端", projectRoot: "D:/p" });
		supervision.track({ key: "worker:manual", kind: "worker", department: "前端", projectRoot: "D:/p" });
		supervision.retainOnly(new Set(["worker:manual"]));
		expect(supervision.keys()).toEqual(["worker:manual"]);
	});
});
