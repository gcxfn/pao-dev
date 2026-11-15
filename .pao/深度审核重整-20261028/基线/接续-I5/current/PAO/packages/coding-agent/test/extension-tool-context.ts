import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

/** 通过真实装配入口构造工具上下文，避免手写夹具随接口变化而失效。 */
export async function createTestExtensionToolContext(root: string): Promise<ExtensionToolContext> {
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner([], createExtensionRuntime(), root, SessionManager.inMemory(root), modelRegistry);
	return runner.createToolContext("test-tool-call", undefined);
}
