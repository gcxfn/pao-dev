import { realpathSync } from "node:fs";
import { defineFacet, type Facet } from "@earendil-works/chord";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readDesktopEditor,
  readDesktopProject,
  previewDesktopWorkflow,
  saveDesktopRecipe,
  startDesktopWorkflow,
  sendDesktopChat,
  runDesktopFlowCommand,
  resolvePaoHome,
  installDesktopTemplate,
} from "@earendil-works/pi-coding-agent/pao/desktop";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { Flow } from "./flow-contract.ts";
import type { Identity } from "./contract.ts";
import { wireValue } from "./wire.ts";

export function registerFlowDesktop(
  pi: ExtensionAPI,
  source: string,
  boardBackend: () => Facet,
): void {
  let current: ExtensionContext | undefined;
  let pending = false;
  const bind = (_event: unknown, ctx: ExtensionContext) => {
    current = ctx;
  };
  pi.on("session_start", bind);
  pi.on("session_tree", bind);
  pi.on("session_shutdown", () => {
    current = undefined;
  });
  const context = (identity?: Identity) => {
    if (!current) throw new Error("主控会话尚未就绪");
    if (
      identity &&
      (identity.sessionId !== current.sessionManager.getSessionId() ||
        realpathSync(identity.project) !== realpathSync(current.cwd))
    )
      throw new Error("原会话已切换，请刷新后重新决定");
    return current;
  };
  const mutate = async (identity: Identity, fn: (ctx: ExtensionContext) => Promise<void>) => {
    const ctx = context(identity);
    if (pending) throw new Error("已有操作等待结果；先核对状态，不重复发送");
    pending = true;
    try {
      await fn(ctx);
    } finally {
      pending = false;
    }
  };
  registerDesktopView(pi, {
    id: "pao-flow",
    title: "PAO 工作流",
    source,
    frontend: new URL("./dist/flow-desktop.js", import.meta.url),
    backend: () =>
      defineFacet({
        id: "pao.desktop.flow.backend",
        setup(env) {
          // 每个视图具有独立服务目录；共享实现需在本视图明确提供，不能借另一视图的授权。
          boardBackend().setup(env);
          env.provide(Flow, {
            async refresh(requestContext) {
              requestContext.abortSignal?.throwIfAborted();
              const ctx = context();
              const id = ctx.sessionManager.getSessionId();
              return wireValue({
                ...readDesktopEditor(id, ctx.cwd),
                snapshot: readDesktopProject(ctx.cwd, id),
              });
            },
            async preview(request, requestContext) {
              requestContext.abortSignal?.throwIfAborted();
              const ctx = context(request);
              return wireValue(
                previewDesktopWorkflow(
                  resolvePaoHome(),
                  ctx.cwd,
                  request.recipe,
                  request.parameters,
                ),
              );
            },
            async save(request, requestContext) {
              requestContext.abortSignal?.throwIfAborted();
              await mutate(request, (ctx) =>
                saveDesktopRecipe(
                  request.sessionId,
                  ctx.cwd,
                  request.recipe,
                  request.revision,
                  requestContext.abortSignal,
                ),
              );
            },
            async start(request, requestContext) {
              requestContext.abortSignal?.throwIfAborted();
              await mutate(request, (ctx) =>
                startDesktopWorkflow(
                  request.sessionId,
                  ctx.cwd,
                  request.recipe,
                  request.revision,
                  request.parameters,
                  request.masterTier,
                  request.thinking,
                  requestContext.abortSignal,
                ),
              );
            },
            async chat(request, requestContext) {
              requestContext.abortSignal?.throwIfAborted();
              await mutate(request, (ctx) =>
                sendDesktopChat(
                  request.sessionId,
                  ctx.cwd,
                  request.text,
                  requestContext.abortSignal,
                ),
              );
            },
            async control(request, requestContext) {
              requestContext.abortSignal?.throwIfAborted();
              await mutate(request, (ctx) =>
                runDesktopFlowCommand(
                  request.sessionId,
                  ctx.cwd,
                  request.params,
                  requestContext.abortSignal,
                ),
              );
            },
            async template(request, requestContext) {
              requestContext.abortSignal?.throwIfAborted();
              await mutate(request, (ctx) =>
                installDesktopTemplate(
                  request.sessionId,
                  ctx.cwd,
                  request.id,
                  request.name,
                  requestContext.abortSignal,
                ),
              );
            },
          });
        },
      }),
  });
}
