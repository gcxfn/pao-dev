import { useCallback, useEffect, useRef, useState } from "react";
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
  refreshToken,
  selectedNode,
  onSelectNode,
}: {
  readonly api: PiDesktopApi;
  readonly workspaceId: string;
  readonly instanceName: string;
  readonly instancePath?: string;
  readonly sessionId?: string;
  readonly onChanged: () => void;
  readonly onOpenOwner: (sessionId: string) => Promise<void>;
  readonly onEdit: (recipeName: string) => void;
  readonly refreshToken?: number;
  readonly selectedNode?: string;
  readonly onSelectNode?: (name: string) => void;
}) {
  const [control, setControl] = useState<WorkflowControlIdentity>();
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [busy, setBusy] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [readAt, setReadAt] = useState<string>();
  const [readNonce, setReadNonce] = useState(0);
  const [submittedTarget, setSubmittedTarget] = useState<{ name: string; round: number }>();
  const actionId = useRef(0);
  const previousSelectedNode = useRef(selectedNode);
  const read = useCallback(async () => {
    const result = await api.getWorkflowControl({ workspaceId, instanceName, instancePath });
    if (result.state === "failed") throw new Error(result.message);
    return result.control;
  }, [api, workspaceId, instanceName, instancePath]);
  useEffect(() => {
    let cancelled = false;
    setReadBusy(true);
    setReadError(undefined);
    void read()
      .then((value) => {
        if (!cancelled) {
          setControl(value);
          setReadAt(new Date().toLocaleTimeString());
          setNodeName((current) => {
            if (selectedNode && value.nodes.some((row) => row.name === selectedNode)) {
              return selectedNode;
            }
            if (current && value.nodes.some((row) => row.name === current)) return current;
            return value.nodes[0]?.name ?? "";
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setReadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setReadBusy(false);
      });
    return () => {
      cancelled = true;
      actionId.current += 1;
    };
  }, [read, refreshToken, readNonce, selectedNode]);
  useEffect(() => {
    if (selectedNode === previousSelectedNode.current) return;
    previousSelectedNode.current = selectedNode;
    if (!selectedNode || !control?.nodes.some((row) => row.name === selectedNode)) return;
    setNodeName(selectedNode);
    setReason("");
  }, [control, selectedNode]);
  const node = control?.nodes.find((row) => row.name === nodeName);
  const owns = !!sessionId && control?.ownerSessionId === sessionId;
  const run = async (action: WorkflowControlAction) => {
    if (!control || !node || !sessionId || busy) return;
    setBusy(true);
    const currentActionId = ++actionId.current;
    const target = { name: node.name, round: node.round };
    setSubmittedTarget(target);
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
      const next = await read();
      if (currentActionId !== actionId.current) return;
      setControl(next);
      setReadAt(new Date().toLocaleTimeString());
      setReadError(undefined);
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
      <p
        className="workflow-runtime-controls__read-status"
        data-testid="workflow-control-read-status"
      >
        {readAt ? `最近读取：${readAt}` : "尚未读取控制状态"}
        {readBusy ? " · 正在读取…" : ""}
        {readError ? (
          <>
            {` · 读取失败：${readError}。当前状态可能已过期。`}
            <button
              className="button"
              type="button"
              disabled={readBusy || busy}
              onClick={() => setReadNonce((value) => value + 1)}
            >
              重新读取
            </button>
          </>
        ) : null}
      </p>
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
              onChange={(event) => {
                setNodeName(event.target.value);
                onSelectNode?.(event.target.value);
                setReason("");
              }}
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
              title={
                !owns
                  ? "请先打开原主控"
                  : !node?.requiresConfirmation
                    ? "该节点无需人工确认"
                    : node.confirmed
                      ? "该节点已经确认"
                      : undefined
              }
              aria-describedby="workflow-control-hints"
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
              title={
                !owns
                  ? "请先打开原主控"
                  : !reason.trim()
                    ? "请填写操作说明"
                    : control.status === "已完成"
                      ? "运行记录已完成"
                      : undefined
              }
              aria-describedby="workflow-control-hints"
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
              title={
                !sessionId
                  ? "请先打开原主控"
                  : !reason.trim()
                    ? "请填写操作说明"
                    : control.status !== "挂起"
                      ? "运行记录当前未挂起"
                      : undefined
              }
              aria-describedby="workflow-control-hints"
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
          <p id="workflow-control-hints" data-testid="workflow-control-hints">
            {submittedTarget
              ? `上次提交对象：${submittedTarget.name}（第 ${submittedTarget.round} 轮）。`
              : "操作会针对当前选中的节点和轮次提交，内核仍会复核权限。"}
            {!owns ? " 请先打开原主控。" : !reason.trim() ? " 需要填写操作说明。" : ""}
            {owns
              ? " 确认放行只对待确认节点可用；暂停和恢复都需要填写说明，恢复仅在挂起状态可用。"
              : ""}
          </p>
          {!sessionId ? <p>请打开原主控，或建立新主控后执行人工恢复。</p> : null}
        </>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
