import type { WorkboardSessionInput, WorkboardSessionResult } from "../../../contracts/kanban";
import type { PaoWorkboardSessionReader } from "@pi-gui/pi-sdk-driver";
import { loadDriver, reasonOf } from "./bridge-common";

/** 路径与执行身份均由共享内核复核；桥只整形可展示的增量。 */
export function createWorkboardSessionQuery(
  options: { readonly loadReader?: () => Promise<PaoWorkboardSessionReader> } = {},
) {
  return {
    async read(project: string, input: WorkboardSessionInput): Promise<WorkboardSessionResult> {
      try {
        const reader = options.loadReader
          ? await options.loadReader()
          : await (
              await loadDriver("loadPaoWorkboardSessionReader")
            )();
        const result =
          input.kind === "worker"
            ? reader.readDesktopExecution(project, "", input.executionId, input.offset ?? 0)
            : reader.readDesktopWorkflowMinister(
                project,
                input.instanceId,
                input.nodeName,
                input.round,
                input.offset ?? 0,
              );
        return {
          state: "ok",
          nextOffset: result.下次偏移,
          more: result.还有更多,
          incomplete: result.末行未完,
          lines: result.行.map((row) => ({
            type: typeof row.类型 === "string" ? row.类型 : "unknown",
            role: typeof row.角色 === "string" ? row.角色 : undefined,
            content: row.内容,
            model: typeof row.模型 === "string" ? row.模型 : undefined,
          })),
        };
      } catch (error) {
        return { state: "failed", message: reasonOf(error) };
      }
    },
  };
}
