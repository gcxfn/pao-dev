import type { ExtensionContext, SessionShutdownEvent } from "../../../src/core/extensions/types.ts";

type ShutdownCleanup = () => void | Promise<void>;
type SessionShutdownHandler = (event: SessionShutdownEvent, context: ExtensionContext) => unknown;

/** 构造与 real extension runner 同形的最小关闭事件。 */
export function sessionShutdownEvent(cleanups: ShutdownCleanup[] = []): SessionShutdownEvent {
	const event: SessionShutdownEvent = {
		type: "session_shutdown",
		reason: "quit",
	};
	Object.defineProperty(event, "onConfirmedShutdown", {
		configurable: true,
		enumerable: false,
		value: (cleanup: ShutdownCleanup) => cleanups.push(cleanup),
	});
	return event;
}

/**
 * 依次触发全部关闭处理器；全部成功后并发执行登记的清理。
 * 与真实 runner 相同：任一处理器失败时不执行任何确认后清理，并汇总全部错误。
 */
export async function fireSessionShutdownHandlers(
	handlers: Iterable<SessionShutdownHandler>,
	context: ExtensionContext = {} as ExtensionContext,
): Promise<void> {
	const cleanups: ShutdownCleanup[] = [];
	const event = sessionShutdownEvent(cleanups);
	const handlerFailures: unknown[] = [];
	for (const handler of handlers) {
		try {
			await handler(event, context);
		} catch (error) {
			handlerFailures.push(error);
		}
	}
	if (handlerFailures.length > 0) {
		throw new AggregateError(handlerFailures, "session_shutdown failed in fixture handlers");
	}

	const cleanupOutcomes = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
	const cleanupFailures = cleanupOutcomes.flatMap((outcome) =>
		outcome.status === "rejected" ? [outcome.reason] : [],
	);
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, "session_shutdown confirmed cleanup failed");
	}
}
