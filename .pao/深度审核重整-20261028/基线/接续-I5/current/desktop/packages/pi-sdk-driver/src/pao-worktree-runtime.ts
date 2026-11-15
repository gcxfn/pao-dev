export interface PaoWorktreeRuntime {
  readonly acquireExecutionRootGuard: typeof import("@earendil-works/pi-coding-agent/pao").acquireExecutionRootGuard;
  readonly detectExecutionOccupancy: typeof import("@earendil-works/pi-coding-agent/pao").detectExecutionOccupancy;
  readonly listReleasedExecutionArtifacts: typeof import("@earendil-works/pi-coding-agent/pao").listReleasedExecutionArtifacts;
  readonly prepareExecutionRootForRemoval: typeof import("@earendil-works/pi-coding-agent/pao").prepareExecutionRootForRemoval;
}

/**
 * 桌面主进程的 electron-vite 产物是 CommonJS，而内核的 ./pao 入口只发布 ESM。
 * 先按 ESM 条件解析到具体文件，再从文件 URL 动态导入，避免构建器把静态导入
 * 改写成包入口不支持的条件式 require。
 */
export async function loadPaoWorktreeRuntime(): Promise<PaoWorktreeRuntime> {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string })
    .resolve;
  if (typeof resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this runtime.");
  }
  const entryUrl = resolve("@earendil-works/pi-coding-agent/pao");
  const module = (await import(entryUrl)) as Partial<PaoWorktreeRuntime>;
  for (const key of [
    "acquireExecutionRootGuard",
    "detectExecutionOccupancy",
    "listReleasedExecutionArtifacts",
    "prepareExecutionRootForRemoval",
  ] as const) {
    if (typeof module[key] !== "function") {
      throw new Error(`PAO build products are missing ${key}.`);
    }
  }
  return module as PaoWorktreeRuntime;
}
