import { expect, it } from "vitest";
import { withTestCleanup } from "./with-test-cleanup.ts";

it("清理成功时保留返回值", async () => {
	let cleaned = false;
	expect(
		await withTestCleanup(
			async () => 42,
			() => {
				cleaned = true;
			},
		),
	).toBe(42);
	expect(cleaned).toBe(true);
});

it("测试和清理都失败时保留两个原错误", async () => {
	const original = new Error("原测试失败");
	const cleanup = new Error("清理失败");
	await expect(
		withTestCleanup(
			async () => {
				throw original;
			},
			() => {
				throw cleanup;
			},
		),
	).rejects.toMatchObject({
		name: "AggregateError",
		errors: [original, cleanup],
	});
});

it("测试单独失败时原样抛出，包括undefined", async () => {
	await expect(
		withTestCleanup(
			async () => {
				throw undefined;
			},
			() => {},
		),
	).rejects.toBeUndefined();
});

it("清理单独失败时不能伪装成功", async () => {
	const cleanup = new Error("清理失败");
	await expect(
		withTestCleanup(
			async () => 42,
			() => {
				throw cleanup;
			},
		),
	).rejects.toBe(cleanup);
});
