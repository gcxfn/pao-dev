/** 始终执行清理，同时保留测试本身和清理过程的失败。 */
export async function withTestCleanup<T>(run: () => Promise<T>, cleanup: () => void | Promise<void>): Promise<T> {
	let outcome: { ok: true; value: T } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, value: await run() };
	} catch (error) {
		outcome = { ok: false, error };
	}
	try {
		await cleanup();
	} catch (error) {
		if (!outcome.ok) throw new AggregateError([outcome.error, error], "测试与清理均失败");
		throw error;
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
