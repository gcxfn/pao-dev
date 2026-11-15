import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { captureTaskSnapshot, renderTaskSnapshot } from "../../src/pao/memory/compaction-state.ts";

describe("任务压缩原文快照（离线）", () => {
	it("保留最新纠正、原始约束、错误、待办与待确认；不包含隐藏推理", () => {
		const entries = [
			{ type: "message", id: "1", message: { role: "user", content: [{ type: "text", text: "只能改甲目录" }] } },
			{
				type: "message",
				id: "2",
				message: { role: "toolResult", isError: true, content: [{ type: "text", text: "权限不足 exit 1" }] },
			},
			{
				type: "message",
				id: "3",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "内部推理" },
						{ type: "text", text: "待确认：是否继续\n- [ ] 修复错误" },
					],
				},
			},
			{ type: "message", id: "4", message: { role: "user", content: [{ type: "text", text: "纠正：只改乙目录" }] } },
		] as unknown as SessionEntry[];
		const snapshot = captureTaskSnapshot(entries);
		const view = renderTaskSnapshot(snapshot);
		expect(view).toContain("只能改甲目录");
		expect(view).toContain("只改乙目录");
		expect(view).toContain("权限不足 exit 1");
		expect(view).toContain("待确认");
		expect(view).not.toContain("内部推理");
		expect(captureTaskSnapshot(entries, snapshot)).toEqual(snapshot);
	});
});
