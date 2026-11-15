import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 复用内核卡读取与项目清单聚合；不在桌面重写解析器。 */
export type PaoKanbanReader = (paoHome: string, currentProject: string) => unknown;

export async function loadPaoKanbanReader(): Promise<PaoKanbanReader> {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/pao"));
  const module = (await import(
    pathToFileURL(join(dirname(entry), "desktop", "read-model.js")).href
  )) as {
    readDesktopPending?: PaoKanbanReader;
  };
  if (typeof module.readDesktopPending !== "function")
    throw new Error("PAO 构建产物缺少卡聚合入口。");
  return module.readDesktopPending;
}
