import { pathToFileURL } from "node:url";
import type { createLocalPaoWorktreeHost } from "../../../src/pao/worktrees/local-host/index.ts";

const [factoryModule, stateRoot, projectRoot, requestId] = process.argv.slice(2);
if (!factoryModule || !stateRoot || !projectRoot || !requestId) {
	throw new Error("用法：local-worktree-process.ts <factoryModule> <stateRoot> <projectRoot> <requestId>");
}

const factory = (await import(pathToFileURL(factoryModule).href)) as {
	readonly createLocalPaoWorktreeHost: typeof createLocalPaoWorktreeHost;
};
const host = factory.createLocalPaoWorktreeHost({ stateRoot, projectRoot });
const binding = await host.create({ requestId, projectRoot });
process.stdout.write(`${JSON.stringify(binding)}\n`);
