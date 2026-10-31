import { describe, expect, it } from "vitest";

import type { ExtensionContext, SessionShutdownEvent } from "../../src/core/extensions/types.ts";
import { fireSessionShutdownHandlers } from "./fixtures/session-shutdown.ts";

describe("session_shutdown 测试夹具与 ExtensionRunner 同语义", () => {
	it("按顺序完整调用所有 handler", async () => {
		const order: string[] = [];

		await fireSessionShutdownHandlers([
			() => {
				order.push("handler-1");
			},
			async () => {
				await Promise.resolve();
				order.push("handler-2");
			},
			() => {
				order.push("handler-3");
			},
		]);

		expect(order).toEqual(["handler-1", "handler-2", "handler-3"]);
	});

	it("中间 handler 失败后仍调用后续 handler，零 cleanup，并汇总原错", async () => {
		const middleFailure = new Error("中间处理器失败");
		const tailFailure = new Error("后续处理器仍执行并失败");
		const order: string[] = [];
		let cleanupRuns = 0;

		const actual = fireSessionShutdownHandlers([
			(event: SessionShutdownEvent, context: ExtensionContext) => {
				expect(event.type).toBe("session_shutdown");
				expect(context).toBeDefined();
				event.onConfirmedShutdown?.(() => {
					cleanupRuns++;
				});
				order.push("handler-1");
			},
			() => {
				order.push("handler-2");
				throw middleFailure;
			},
			() => {
				order.push("handler-3");
				throw tailFailure;
			},
		]);

		await expect(actual).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([middleFailure, tailFailure]);
			return true;
		});
		expect(order).toEqual(["handler-1", "handler-2", "handler-3"]);
		expect(cleanupRuns).toBe(0);
	});

	it("全部 handler 成功后才执行 cleanup", async () => {
		const order: string[] = [];

		await fireSessionShutdownHandlers([
			(event) => {
				order.push("handler-1");
				event.onConfirmedShutdown?.(() => {
					order.push("cleanup-1");
				});
			},
			(event) => {
				order.push("handler-2");
				event.onConfirmedShutdown?.(async () => {
					await Promise.resolve();
					order.push("cleanup-2");
				});
			},
		]);

		expect(order).toEqual(["handler-1", "handler-2", "cleanup-1", "cleanup-2"]);
	});

	it("某个 cleanup 失败不妨碍其余 cleanup，并汇总 cleanup 错误", async () => {
		const cleanupFailure = new Error("清理失败");
		const order: string[] = [];

		const actual = fireSessionShutdownHandlers([
			(event) => {
				event.onConfirmedShutdown?.(() => {
					order.push("cleanup-1");
					throw cleanupFailure;
				});
				event.onConfirmedShutdown?.(async () => {
					await Promise.resolve();
					order.push("cleanup-2");
				});
				event.onConfirmedShutdown?.(() => {
					order.push("cleanup-3");
				});
			},
		]);

		await expect(actual).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([cleanupFailure]);
			return true;
		});
		expect(order).toHaveLength(3);
		expect(order).toEqual(expect.arrayContaining(["cleanup-1", "cleanup-2", "cleanup-3"]));
	});
});
