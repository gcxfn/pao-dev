import { useCallback, useEffect, useState } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type {
  WorkflowControlAction,
  WorkflowControlIdentity,
} from "../../../contracts/workflow-control";
import { cardStatusLabel } from "./canvas-model";

/** 控制数据现读；按钮只提交意图，主进程与内核复核身份和轮次。 */
export function WorkflowRuntimeControls({
  api,
  workspaceId,
  instanceName,
  instancePath,
  sessionId,
  onChanged,
  onOpenOwner,
  onEdit,
}: {
  readonly api: PiDesktopApi;
  readonly workspaceId: string;
  readonly instanceName: string;
  readonly instancePath?: string;
  readonly sessionId?: string;
  readonly onChanged: () => void;
  readonly onOpenOwner: (sessionId: string) => Promise<void>;
  readonly onEdit: (recipeName: string) => void;
}) {
  const [control, setControl] = useState<WorkflowControlIdentity>();
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [busy, setBusy] = useState(false);
  const read = useCallback(async () => {
    const result = await api.getWorkflowControl({ workspaceId, instanceName, instancePath });
    if (result.state === "failed") throw new Error(result.message);
    return result.control;
  }, [api, workspaceId, instanceName, instancePath]);
  useEffect(() => {
    let cancelled = false;
    void read()
      .then((value) => {
        if (!cancelled) {
          setControl(value);
          setNodeName(value.nodes[0]?.name ?? "");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [read]);
  const node = control?.nodes.find((row) => row.name === nodeName);
  const owns = !!sessionId && control?.ownerSessionId === sessionId;
  const run = async (action: WorkflowControlAction) => {
    if (!control || !node || !sessionId || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await api.controlWorkflow({
        workspaceId,
        sessionId,
        instanceId: control.instanceId,
        nodeName: node.name,
        round: node.round,
        action,
        reason,
      });
      if (result.state === "error") throw new Error(result.message);
      setControl(await read());
      onChanged();
      setMessage("操作已完成，状态已重新读取。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workflow-runtime-controls" data-testid="workflow-runtime-controls">
      <strong>运行记录控制{control ? ` · ${control.status}` : ""}</strong>
      <p>暂停推进只阻止后续启动，在途任务会继续。完成状态仍由执行和验收决定。</p>
      {control ? (
        <>
          <p>
            主控：{control.ownerSessionId}
            {control.pauseReason ? ` · 暂停原因：${control.pauseReason}` : ""}
          </p>
          {!owns ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onOpenOwner(control.ownerSessionId)
                  .then(() => setMessage("已激活原主控会话。"))
                  .catch((error: unknown) =>
                    setMessage(error instanceof Error ? error.message : String(error)),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              打开原主控
            </button>
          ) : null}
          <label>
            控制节点
            <select
              aria-label="控制节点"
              value={nodeName}
              disabled={busy}
              onChange={(event) => setNodeName(event.target.value)}
            >
              {control.nodes.map((row) => (
                <option key={row.name} value={row.name}>
                  {row.name} · 第 {row.round} 轮 · {row.hold ?? cardStatusLabel(row.status)}
                </option>
              ))}
            </select>
          </label>
          <label>
            操作说明
            <input
              aria-label="操作说明"
              value={reason}
              disabled={busy}
              placeholder="暂停理由或恢复前的现场核查说明"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="view-header__actions">
            <button
              className="button"
              type="button"
              disabled={busy || !owns || !node?.requiresConfirmation || !!node.confirmed}
              onClick={() => {
                run("confirm").catch((error: unknown) => setMessage(String(error)));
              }}
            >
              确认放行
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || !owns || !node || !reason.trim() || control.status === "已完成"}
              onClick={() => {
                run("pause").catch((error: unknown) => setMessage(String(error)));
              }}
            >
              暂停推进
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || !sessionId || !node || !reason.trim() || control.status !== "挂起"}
              onClick={() => {
                run("resume").catch((error: unknown) => setMessage(String(error)));
              }}
            >
              人工恢复
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || control.status === "运行中"}
              onClick={() => onEdit(control.recipeName)}
            >
              返回工作流编辑
            </button>
          </div>
          {!sessionId ? <p>请打开原主控，或建立新主控后执行人工恢复。</p> : null}
        </>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
