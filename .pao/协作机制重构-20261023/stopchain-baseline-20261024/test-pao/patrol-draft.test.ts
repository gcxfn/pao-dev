/**
 * 卡0006 验收 1：阈值判定纯函数——⚠️ 数 < 阈值 → 不落卡返回 null；
 * ≥ 阈值 → 产出巡库卡草稿（目标/部门/输入指针/约束/档位=快，与 §6.7 一致）。
 */
import { describe, expect, test } from "vitest";
import type { InspectionReport } from "../../src/pao/knowledge/inspect.ts";
import {
	buildPatrolCardDraft,
	DEFAULT_PATROL_THRESHOLD,
	isPatrolGoal,
	PATROL_CONSTRAINT,
	PATROL_GOAL_PREFIX,
} from "../../src/pao/patrol/draft.ts";

function reportOf(flaggedPaths: string[]): InspectionReport {
	return {
		findings: flaggedPaths.map((relPath) => ({ flagged: true, problems: ["超期未核"], relPath })),
		flaggedCount: flaggedPaths.length,
	};
}

const DEPT = { 部门: "后端" };

describe("卡0006：阈值判定与草稿", () => {
	test("⚠️ 数 < 阈值（默认 5）→ 返回 null，绝不落卡", () => {
		expect(buildPatrolCardDraft(reportOf(["教训/a.md", "教训/b.md", "做法/c.md"]), DEPT)).toBeNull();
		expect(buildPatrolCardDraft(reportOf([]), DEPT)).toBeNull();
	});

	test("⚠️ 数 = 阈值（边界）→ 落卡；阈值可参数覆写（上下界）", () => {
		const four = reportOf(["教训/a.md", "教训/b.md", "做法/c.md", "导览/d.md"]);
		const five = reportOf([...four.findings.map((f) => f.relPath), "评测/e.md"]);
		// 4 < 5 不落，5 = 5 落
		expect(buildPatrolCardDraft(four, DEPT)).toBeNull();
		expect(buildPatrolCardDraft(five, DEPT)).not.toBeNull();
		// 覆写阈值：同样的 4 条，阈值降到 4 → 落；升到 5 → 不落
		expect(buildPatrolCardDraft(four, { ...DEPT, 阈值: 4 })).not.toBeNull();
		expect(buildPatrolCardDraft(four, { ...DEPT, 阈值: 5 })).toBeNull();
	});

	test("草稿字段与 §6.7 一致：目标固定前缀/部门/输入指针/约束红线/档位=快", () => {
		const draft = buildPatrolCardDraft(reportOf(["教训/超期.md", "做法/版本不符.md"]), {
			...DEPT,
			阈值: 2,
			知识库路径: "D:/pao/部门/后端/知识库",
		});
		expect(draft).not.toBeNull();
		expect(draft!.目标.startsWith(PATROL_GOAL_PREFIX)).toBe(true);
		expect(draft!.目标).toContain("2 条");
		expect(draft!.部门).toBe("后端");
		// 输入只装指针：首条知识库根，其余为 ⚠️ 条目相对路径；不含任何正文
		expect(draft!.输入).toEqual(["知识库根:D:/pao/部门/后端/知识库", "教训/超期.md", "做法/版本不符.md"]);
		// 约束写死红线：只准写 ⚠️ 标记与初判，不准动条目正文
		expect(draft!.约束).toBe(PATROL_CONSTRAINT);
		expect(draft!.约束).toContain("不准动条目正文");
		expect(draft!.档位).toBe("fast");
	});

	test("未提供知识库路径时 输入 只有 ⚠️ 条目相对路径", () => {
		const draft = buildPatrolCardDraft(reportOf(["教训/a.md"]), { ...DEPT, 阈值: 1 });
		expect(draft!.输入).toEqual(["教训/a.md"]);
	});

	test("默认阈值为 5；识别约定：目标前缀判定", () => {
		expect(DEFAULT_PATROL_THRESHOLD).toBe(5);
		expect(isPatrolGoal("巡库：消化 5 条 ⚠️ 标记")).toBe(true);
		expect(isPatrolGoal("修复登录页")).toBe(false);
		// 前缀必须从头匹配，中间出现不算
		expect(isPatrolGoal("帮忙巡库：看看")).toBe(false);
	});
});
