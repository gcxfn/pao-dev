/**
 * S6-K4 视图信封纯函数单测：代际指纹（切会话/工作流即换值）、内容指纹（去重）、
 * 拒旧事件判定、信封组装。信封是传输/视图信息，不替代卡状态——真相仍在卡与控制正本。
 */
import { describe, expect, it } from "vitest";
import {
	buildEnvelope,
	contentRevisionOf,
	isStaleEvent,
	sessionGenerationOf,
} from "../../src/pao/desktop/view-envelope.ts";

describe("视图信封纯函数（S6-K4）", () => {
	it("代际指纹：同作用域稳定；切会话/工作流即换值；64 位十六进制", () => {
		const sessionA = sessionGenerationOf({ 会话: "session-a", 项目根: "D:/proj" });
		expect(sessionA).toBe(sessionGenerationOf({ 会话: "session-a", 项目根: "D:/proj" }));
		expect(sessionA).toMatch(/^[0-9a-f]{64}$/);
		expect(sessionGenerationOf({ 会话: "session-b", 项目根: "D:/proj" })).not.toBe(sessionA);
		expect(sessionGenerationOf({ 会话: "session-a", 工作流实例: "D:/proj/.pao/工作流实例-x.md" })).not.toBe(sessionA);
	});
	it("内容指纹：同内容稳定；内容变化即换值", () => {
		expect(contentRevisionOf({ 卡: [{ 状态: "进行中" }] })).toBe(contentRevisionOf({ 卡: [{ 状态: "进行中" }] }));
		expect(contentRevisionOf({ 卡: [{ 状态: "已交付" }] })).not.toBe(contentRevisionOf({ 卡: [{ 状态: "进行中" }] }));
	});
	it("拒旧事件：事件代际≠当前代际＝旧作用域事件拒收；一致＝可应用", () => {
		const current = sessionGenerationOf({ 会话: "session-a" });
		expect(isStaleEvent(sessionGenerationOf({ 会话: "session-b" }), current)).toBe(true);
		expect(isStaleEvent(current, current)).toBe(false);
	});
	it("信封组装：version=1、publishedAt 原样、revision=内容指纹、代际=作用域指纹", () => {
		const envelope = buildEnvelope({ 会话: "s" }, { a: 1 }, "2026-10-07T00:00:00.000Z");
		expect(envelope).toEqual({
			version: 1,
			sessionGeneration: sessionGenerationOf({ 会话: "s" }),
			revision: contentRevisionOf({ a: 1 }),
			publishedAt: "2026-10-07T00:00:00.000Z",
		});
	});
});
