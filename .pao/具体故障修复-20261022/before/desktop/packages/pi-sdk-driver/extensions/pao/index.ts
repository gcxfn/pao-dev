import { defineFacet } from "@earendil-works/chord";
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readDesktopExecution,
  readDesktopProject,
  readDesktopPending,
  resolvePaoHome,
  runDesktopMemoryCommand,
  readDesktopMinisters,
  readDesktopMinister,
  readDesktopFlows,
  readDesktopDiff,
  readDesktopResults,
  runDesktopFlowCommand,
  readDesktopDeptCatalog,
  readDesktopDeptDetail,
} from "@earendil-works/pi-coding-agent/pao/desktop";
import { registerDesktopView } from "@pi-gui/extension-ui";
import { Pao, PaoPulse, type Identity, type PaoView } from "./contract.ts";
import { registerFlowDesktop } from "./flow-backend.ts";
import { wireValue } from "./wire.ts";

export default function paoDesktop(pi: ExtensionAPI): void {
  let current: ExtensionContext | undefined;
  let busy = false;
  const bind = (_event: unknown, ctx: ExtensionContext) => {
    current = ctx;
  };
  pi.on("session_start", bind);
  pi.on("session_tree", bind);
  pi.on("session_shutdown", () => {
    current = undefined;
  });
  /** 部门详情打开时，本会话每轮结束/代理收尾推一个脉冲；前端节流合并成一次刷新。 */
  let pushPulse: (() => void) | undefined;
  let pulseSerial = 0;
  const notifyPulse = () => {
    pushPulse?.();
  };
  pi.on("turn_end", notifyPulse);
  pi.on("agent_end", notifyPulse);
  function context(identity?: Identity): ExtensionContext {
    if (!current) throw new Error("会话尚未就绪或已关闭");
    if (
      identity &&
      (identity.sessionId !== current.sessionManager.getSessionId() ||
        identity.project !== realpathSync(current.cwd))
    )
      throw new Error("会话或项目已切换，旧动作失效；请刷新后重新决定。");
    return current;
  }
  const backend = () =>
    defineFacet({
      id: "pao.desktop.backend",
      setup(env) {
        env.provide(Pao, {
          async refresh(requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context();
            const project = readDesktopProject(ctx.cwd, ctx.sessionManager.getSessionId());
            const pending = readDesktopPending(resolvePaoHome(), ctx.cwd);
            const result: PaoView = {
              项目: project,
              待处理: pending,
              部长: [],
            };
            try {
              result.部长 = readDesktopMinisters(project.session, ctx.cwd);
            } catch (error) {
              result.部长错误 = `部长读取失败：${String(error)}`;
            }
            return wireValue(result);
          },
          async execution(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context(request);
            return wireValue(
              readDesktopExecution(ctx.cwd, request.sessionId, request.id, request.offset),
            );
          },
          async memory(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context(request);
            if (busy) throw new Error("上一记忆动作尚未返回，请先查状态，不重复发送。");
            busy = true;
            try {
              await runDesktopMemoryCommand(
                request.sessionId,
                ctx.cwd,
                request.args,
                request.revision,
                requestContext.abortSignal,
              );
            } finally {
              busy = false;
            }
          },
          async minister(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context(request);
            return wireValue(
              readDesktopMinister(request.sessionId, ctx.cwd, request.id, request.offset),
            );
          },
          async diff(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context(request);
            let baseline: string | undefined;
            if (request.instance) {
              const flow = readDesktopFlows(ctx.cwd).工作流.find(
                (entry) => entry.控制.实例 === request.instance,
              );
              const node = flow?.控制.节点.find((entry) => entry.名字 === request.node);
              if (!node) throw new Error("节点身份已变化，请刷新");
              if (node.基线 && realpathSync(node.基线.项目根) !== realpathSync(ctx.cwd))
                throw new Error("节点基线越出当前项目");
              baseline = node.基线?.提交;
            }
            const result = await readDesktopDiff(ctx.cwd, baseline);
            context(request);
            return wireValue(result);
          },
          async results(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            // 只读聚合（pao/desktop readDesktopResults）：跨项目按实例四样＋恢复摘要,零动作零落盘
            context(request);
            return wireValue(await readDesktopResults(resolvePaoHome()));
          },
          /**
           * E2b 部门目录（总览/选择器）。只读、不写盘；错误原样抛给前端，
           * 不 catch 成空列表——空列表会让界面把「读不了配置」显示成「没有部门」。
           * project 传 `ctx.cwd` 原样：内核 desktopOwner 走字符串严格比较，不能喂 realpath 归一化的值。
           */
          async deptCatalog(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context(request);
            return wireValue(readDesktopDeptCatalog(request.sessionId, ctx.cwd));
          },
          /** E2b 单部门详情。未登记部门由内核抛错并给「目录在不在」的实话，这里不兜底。 */
          async deptDetail(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context(request);
            return wireValue(readDesktopDeptDetail(request.sessionId, ctx.cwd, request.deptName));
          },
          async flow(request, requestContext) {
            requestContext.abortSignal?.throwIfAborted();
            const ctx = context(request);
            if (busy) throw new Error("已有动作待返回，请先核对状态，不重复发送");
            const flow = readDesktopFlows(ctx.cwd).工作流.find(
              (entry) => entry.控制.实例 === request.instance,
            )?.控制;
            const node = flow?.节点.find((entry) => entry.名字 === request.node);
            if (!flow || !node || node.轮次 !== request.round)
              throw new Error("旧实例/节点/轮次动作已失效，请刷新");
            if (flow.owner !== request.sessionId && request.action !== "resume")
              throw new Error("请跳转原 owner 会话处理");
            busy = true;
            try {
              await runDesktopFlowCommand(
                request.sessionId,
                ctx.cwd,
                {
                  name: flow.工作流,
                  cards_dir: flow.卡目录,
                  action: request.action,
                  instance: flow.实例,
                  node: node.名字,
                  round: node.轮次,
                  prev_owner: flow.owner,
                  reason: request.reason,
                  ...(request.result ? { result: request.result } : {}),
                  ...(request.references ? { references: request.references } : {}),
                  ...(request.target ? { target: request.target } : {}),
                  ...(request.failure_axis ? { failure_axis: request.failure_axis } : {}),
                },
                requestContext.abortSignal,
              );
            } finally {
              busy = false;
            }
          },
        });
        // 键控脉冲：每次会话事件换一个实例推给前端；旧实例随新实例就位即关闭，至多一个存活。
        const spawner = env.provideMany(PaoPulse);
        let lastDisposer: (() => void) | undefined;
        pushPulse = () => {
          const serial = ++pulseSerial;
          const disposer = spawner.spawn(`pulse-${serial}`, { ping: async () => serial });
          try {
            lastDisposer?.();
          } catch {
            /* 旧实例已失效时忽略 */
          }
          lastDisposer = disposer;
        };
      },
    });
  registerDesktopView(pi, {
    id: "pao",
    title: "部门详情",
    source: import.meta.url,
    frontend: new URL("./dist/desktop.js", import.meta.url),
    backend,
  });
  registerFlowDesktop(pi, import.meta.url, backend);
}
