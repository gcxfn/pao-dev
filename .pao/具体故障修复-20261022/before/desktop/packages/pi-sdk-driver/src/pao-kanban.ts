import type { PaoDesktopSessionIncrement } from "./pao-canvas.js";
import { loadPaoDesktopModule } from "./pao-desktop-module.js";

/** 复用内核卡读取与项目清单聚合；不在桌面重写解析器。 */
export type PaoKanbanReader = (paoHome: string, currentProject: string) => unknown;

export async function loadPaoKanbanReader(): Promise<PaoKanbanReader> {
  const module = await loadPaoDesktopModule();
  if (typeof module.readDesktopPending !== "function")
    throw new Error("PAO 构建产物缺少卡聚合入口。");
  return module.readDesktopPending;
}

export interface PaoWorkboardSessionReader {
  readDesktopExecution(
    project: string,
    owner: string,
    executionId: string,
    offset: number,
  ): PaoDesktopSessionIncrement;
  readDesktopWorkflowMinister(
    project: string,
    instanceId: string,
    nodeName: string,
    round: number,
    offset: number,
  ): PaoDesktopSessionIncrement;
}

export async function loadPaoWorkboardSessionReader(): Promise<PaoWorkboardSessionReader> {
  const module = await loadPaoDesktopModule();
  const { readDesktopExecution, readDesktopWorkflowMinister } = module;
  if (typeof readDesktopExecution !== "function" || typeof readDesktopWorkflowMinister !== "function")
    throw new Error("PAO 构建产物缺少执行会话读取入口。");
  return { readDesktopExecution, readDesktopWorkflowMinister };
}
