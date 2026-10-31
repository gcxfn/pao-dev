import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../../shared/atomic.ts";
import type { PaoLocalWorktreeHostStoredState, PaoLocalWorktreeStateAdapter } from "./adapter.ts";

/** CLI、基准和子进程共用的默认状态适配器。 */
export function createLocalPaoWorktreeStateAdapter(stateRoot: string): PaoLocalWorktreeStateAdapter {
	const root = resolve(stateRoot);
	const statePath = join(root, "pao-worktree-host.json");
	return {
		lockTarget: statePath,
		async load() {
			try {
				return JSON.parse(await readFile(statePath, "utf8")) as unknown;
			} catch (error) {
				if (isMissingFileError(error)) return undefined;
				throw error;
			}
		},
		async save(state: PaoLocalWorktreeHostStoredState) {
			await mkdir(dirname(statePath), { recursive: true });
			writeFileAtomic(statePath, `${JSON.stringify(state)}\n`);
		},
	};
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
