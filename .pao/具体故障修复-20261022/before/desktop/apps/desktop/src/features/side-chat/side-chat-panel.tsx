import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type { SideChatSnapshot } from "@pi-gui/session-driver";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { MessageMarkdown } from "../conversation/message-markdown";
import "../../styles/side-chat.css";

type DraftResult = { readonly ok: boolean; readonly message: string };
type DraftPreparer = (source: SessionRef, text: string) => Promise<DraftResult>;
type LoadMode = "explicit" | "background";
type RequestToken = {
  readonly source: string;
  readonly id: number;
  readonly snapshotGeneration: number;
};

/**
 * 读写请求各自递增。发送成功会推进快照代次，使发送开始前取得、发送完成后才返回的
 * 同步结果失效；读取不会被发送序号取消，因此供应商长时间回答时仍可安全同步。
 */
export class SideChatRequestTracker {
  private loadId = 0;
  private explicitLoadId = 0;
  private explicitLoadingSource: string | undefined;
  private sendId = 0;
  private snapshotGeneration = 0;
  private sendingSource: string | undefined;

  beginLoad(source: string, mode: LoadMode = "explicit"): RequestToken | undefined {
    // 后台同步只能在显式读取结束后运行，避免它推进读序号后抢走 loading 的清理权。
    if (mode === "background" && this.explicitLoadingSource !== undefined) return undefined;
    const id = ++this.loadId;
    if (mode === "explicit") {
      this.explicitLoadId = id;
      this.explicitLoadingSource = source;
    }
    return { source, id, snapshotGeneration: this.snapshotGeneration };
  }

  acceptsLoad(token: RequestToken, currentSource: string): boolean {
    return (
      token.source === currentSource &&
      token.id === this.loadId &&
      token.snapshotGeneration === this.snapshotGeneration
    );
  }

  finishesLoad(token: RequestToken, currentSource: string): boolean {
    if (
      token.source !== currentSource ||
      token.id !== this.loadId ||
      token.id !== this.explicitLoadId
    )
      return false;
    this.explicitLoadingSource = undefined;
    return true;
  }

  beginSend(source: string): RequestToken | undefined {
    if (this.sendingSource) return undefined;
    this.sendingSource = source;
    return { source, id: ++this.sendId, snapshotGeneration: this.snapshotGeneration };
  }

  acceptsSend(token: RequestToken, currentSource: string): boolean {
    return token.source === currentSource && token.id === this.sendId;
  }

  commitSend(token: RequestToken, currentSource: string): boolean {
    if (!this.acceptsSend(token, currentSource)) return false;
    this.snapshotGeneration++;
    this.sendingSource = undefined;
    return true;
  }

  finishSend(token: RequestToken, currentSource: string): boolean {
    if (!this.acceptsSend(token, currentSource)) return false;
    this.sendingSource = undefined;
    return true;
  }

  isSending(): boolean {
    return this.sendingSource !== undefined;
  }

  reset(): void {
    this.loadId++;
    this.explicitLoadId++;
    this.explicitLoadingSource = undefined;
    this.sendId++;
    this.snapshotGeneration++;
    this.sendingSource = undefined;
  }
}

export function displayedSideChat(
  snapshot: SideChatSnapshot | undefined,
  source: SessionRef,
): SideChatSnapshot | undefined {
  return snapshot && sameSource(snapshot.source, source) ? snapshot : undefined;
}

export const sideChatIsBusy = (snapshot: SideChatSnapshot | undefined, sending: boolean): boolean =>
  sending || snapshot?.busy === true;

/** busy 表示宿主仍有辅助回答在生成；快照文本只包含已经落盘的记录。 */
export const sideChatBusyNotice = (snapshot: SideChatSnapshot | undefined): string | undefined =>
  snapshot?.busy
    ? "辅助回答仍在生成，完成前不能再次发送。这里只显示已写入记录的内容；可按“同步进展”读取新落盘的进度。"
    : undefined;

/** 同步结果按更新时间和消息身份去重，不用墙钟截止时间。 */
export function preferNewerSideChat(
  current: SideChatSnapshot | undefined,
  incoming: SideChatSnapshot,
): SideChatSnapshot {
  if (!current) return incoming;
  if (incoming.updatedAt !== current.updatedAt) {
    return incoming.updatedAt > current.updatedAt ? incoming : current;
  }
  const currentIds = new Set(current.messages.map((message) => message.id));
  const sameMessages =
    incoming.messages.length === current.messages.length &&
    incoming.messages.every((message, index) => message.id === current.messages[index]?.id);
  if (sameMessages) return incoming.busy !== current.busy ? incoming : current;
  return incoming.messages.some((message) => currentIds.has(message.id)) ? current : incoming;
}

const sourceKey = (source: SessionRef) => `${source.workspaceId}\u0000${source.sessionId}`;
const sameSource = (left: SessionRef, right: SessionRef) =>
  left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
};

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function selectionInside(element: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  const ancestor =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  if (!ancestor || !element.contains(ancestor)) return "";
  return selection.toString().trim();
}

/** 辅助会话只读：发送的是这个独立问答，不会触发主控工具或写入主对话。 */
export function SideChatPanel({
  api,
  source,
  onPrepareSourceDraft,
}: {
  readonly api: PiDesktopApi;
  readonly source: SessionRef;
  readonly onPrepareSourceDraft: DraftPreparer;
}) {
  const key = sourceKey(source);
  const [snapshot, setSnapshot] = useState<SideChatSnapshot>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [selectedText, setSelectedText] = useState("");
  const [draftPreparing, setDraftPreparing] = useState(false);
  const [draftResult, setDraftResult] = useState<DraftResult>();
  const requests = useRef<SideChatRequestTracker>(undefined);
  if (!requests.current) requests.current = new SideChatRequestTracker();
  const draftRequestId = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const cancelPending = useCallback(() => {
    requests.current?.reset();
    ++draftRequestId.current;
    setSending(false);
    setDraftPreparing(false);
  }, []);

  const load = useCallback(
    (target: SessionRef, quiet = false) => {
      const expectedKey = sourceKey(target);
      const token = requests.current!.beginLoad(expectedKey, quiet ? "background" : "explicit");
      if (!token) return;
      if (!quiet) {
        setLoading(true);
        setLoadError(undefined);
      }
      setRefreshError(undefined);
      api
        .getSideChat(target)
        .then((value) => {
          if (!requests.current!.acceptsLoad(token, sourceKey(sourceRef.current))) return;
          if (!sameSource(value.source, target)) {
            const message = "返回的辅助会话来源与当前主对话不一致，已拒绝显示。";
            if (quiet) setRefreshError(message);
            else setLoadError(message);
            return;
          }
          setSnapshot((current) => preferNewerSideChat(current, value));
        })
        .catch((cause: unknown) => {
          if (requests.current!.acceptsLoad(token, sourceKey(sourceRef.current))) {
            if (quiet) setRefreshError(errorMessage(cause));
            else setLoadError(errorMessage(cause));
          }
        })
        .finally(() => {
          if (!quiet && requests.current!.finishesLoad(token, sourceKey(sourceRef.current)))
            setLoading(false);
        });
    },
    [api],
  );

  useEffect(() => {
    setSnapshot(undefined);
    setLoadError(undefined);
    setRefreshError(undefined);
    setInput("");
    setSending(false);
    setSendError(undefined);
    setSelectedText("");
    setDraftPreparing(false);
    setDraftResult(undefined);
    cancelPending();
    load(source);
    return () => {
      cancelPending();
    };
  }, [cancelPending, load, source.sessionId, source.workspaceId]);

  useEffect(() => {
    const timer = window.setInterval(() => load(sourceRef.current, true), 30_000);
    return () => window.clearInterval(timer);
  }, [load, key]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    const target = sourceRef.current;
    const expectedKey = sourceKey(target);
    const visible = displayedSideChat(snapshot, target);
    if (sideChatIsBusy(visible, sending)) return;
    const token = requests.current!.beginSend(expectedKey);
    if (!token) return;
    setSending(true);
    setSendError(undefined);
    try {
      const value = await api.sendSideChatMessage({ ...target, text });
      if (!requests.current!.acceptsSend(token, sourceKey(sourceRef.current))) return;
      if (!sameSource(value.source, target)) {
        setSendError("返回的辅助会话来源与当前主对话不一致，已拒绝更新。");
        return;
      }
      requests.current!.commitSend(token, sourceKey(sourceRef.current));
      setSnapshot((current) => preferNewerSideChat(current, value));
      setInput((current) => (current.trim() === text ? "" : current));
    } catch (cause) {
      if (requests.current!.acceptsSend(token, sourceKey(sourceRef.current)))
        setSendError(errorMessage(cause));
    } finally {
      if (requests.current!.finishSend(token, sourceKey(sourceRef.current))) setSending(false);
    }
  };

  const prepareDraft = async () => {
    const target = sourceRef.current;
    const expectedKey = sourceKey(target);
    const id = ++draftRequestId.current;
    setDraftPreparing(true);
    setDraftResult(undefined);
    try {
      const result = await onPrepareSourceDraft(target, selectedText);
      if (draftRequestId.current !== id || sourceKey(sourceRef.current) !== expectedKey) return;
      setDraftResult(result);
    } catch (cause) {
      if (draftRequestId.current === id && sourceKey(sourceRef.current) === expectedKey)
        setDraftResult({ ok: false, message: errorMessage(cause) });
    } finally {
      if (draftRequestId.current === id && sourceKey(sourceRef.current) === expectedKey)
        setDraftPreparing(false);
    }
  };

  const visibleSnapshot = displayedSideChat(snapshot, source);
  const messages = visibleSnapshot?.messages ?? [];
  const busy = sideChatIsBusy(visibleSnapshot, sending);
  return (
    <section
      key={key}
      className="side-chat"
      data-testid="side-chat-panel"
      data-source-session={source.sessionId}
      data-busy={busy}
      aria-busy={busy}
      aria-label="辅助对话"
    >
      <header className="side-chat__header">
        <div>
          <p className="side-chat__eyebrow">当前主对话的只读旁支</p>
          <h1>辅助对话</h1>
          <p className="side-chat__source" title={source.sessionId}>
            来源会话：{source.sessionId}
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => load(sourceRef.current, true)}
        >
          {loading ? "正在同步…" : "同步进展"}
        </button>
      </header>

      <div className="side-chat__readonly" role="note">
        只读问答与分析。不会修改文件、运行命令、派发任务、审批、停止或改变主对话状态。
      </div>

      {visibleSnapshot ? (
        <dl className="side-chat__sync">
          <div>
            <dt>主控状态</dt>
            <dd data-status={visibleSnapshot.sync.sourceStatus}>
              {
                {
                  idle: "空闲",
                  running: "运行中（可以继续提问）",
                  failed: "失败",
                  stopping: "正在停止",
                }[visibleSnapshot.sync.sourceStatus]
              }
            </dd>
          </div>
          <div>
            <dt>同步时间</dt>
            <dd>{formatTime(visibleSnapshot.sync.capturedAt)}</dd>
          </div>
          <div>
            <dt>会话边界</dt>
            <dd title={visibleSnapshot.sync.boundaryId ?? "未记录边界"}>
              {visibleSnapshot.sync.boundaryId ?? "未记录"}
            </dd>
          </div>
          <div>
            <dt>上下文</dt>
            <dd data-complete={visibleSnapshot.sync.contextComplete}>
              {visibleSnapshot.sync.contextComplete ? "完整" : "有限制"}
            </dd>
          </div>
        </dl>
      ) : null}

      {visibleSnapshot?.sync.contextComplete === false ? (
        <div className="side-chat__warning" role="status">
          <strong>上下文不完整</strong>
          {visibleSnapshot.sync.limitations.length > 0 ? (
            <ul>
              {visibleSnapshot.sync.limitations.map((limitation, index) => (
                <li key={`${limitation}:${index}`}>{limitation}</li>
              ))}
            </ul>
          ) : (
            <p>宿主没有提供具体限制原因，不能宣称已获得完整上下文。</p>
          )}
        </div>
      ) : null}
      {visibleSnapshot?.sync.sourceStatus === "running" ? (
        <p className="side-chat__notice" role="status">
          主控仍在运行；这份辅助记录截至同步时间和边界，之后的新输出尚未包含。
        </p>
      ) : null}
      {sideChatBusyNotice(visibleSnapshot) ? (
        <p className="side-chat__notice" data-testid="side-chat-detached-busy" role="status">
          {sideChatBusyNotice(visibleSnapshot)}
        </p>
      ) : null}
      {visibleSnapshot?.error ? (
        <p className="side-chat__error" role="alert">
          辅助会话报告：{visibleSnapshot.error.message}
          {visibleSnapshot.error.code ? `（${visibleSnapshot.error.code}）` : ""}
        </p>
      ) : null}
      {loadError ? (
        <div className="side-chat__error" role="alert">
          <p>辅助会话读取失败：{loadError}</p>
          <button type="button" className="button" onClick={() => load(sourceRef.current)}>
            重新同步
          </button>
        </div>
      ) : null}
      {refreshError ? (
        <p className="side-chat__error" role="alert">
          同步失败：{refreshError}。仍显示上一份可读记录。
        </p>
      ) : null}

      <div className="side-chat__messages" aria-label="辅助对话记录">
        {loading && !visibleSnapshot ? (
          <p className="side-chat__empty" role="status">
            正在读取独立问答记录…
          </p>
        ) : null}
        {!loading && !loadError && messages.length === 0 ? (
          <p className="side-chat__empty">
            还没有辅助问答。提问只会更新这栏自己的记录，不会自动回传到主对话。
          </p>
        ) : null}
        {messages.map((message) => (
          <article
            key={message.id}
            className="side-chat__message"
            data-role={message.role}
            data-status={message.status}
            onMouseUp={(event) => {
              if (message.role !== "assistant") return;
              setSelectedText(selectionInside(event.currentTarget));
            }}
            onKeyUp={(event) => {
              if (message.role !== "assistant") return;
              setSelectedText(selectionInside(event.currentTarget));
            }}
            tabIndex={message.role === "assistant" ? 0 : undefined}
          >
            <header>
              <strong>{message.role === "user" ? "你的追问" : "辅助分析"}</strong>
              <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
            </header>
            {message.role === "assistant" ? (
              <MessageMarkdown text={message.text} />
            ) : (
              <p className="side-chat__plain">{message.text}</p>
            )}
            {message.status === "error" ? (
              <p className="side-chat__message-error" role="alert">
                这条回复未完成：{message.error?.message ?? "宿主未提供失败原因"}
              </p>
            ) : null}
          </article>
        ))}
      </div>

      <div className="side-chat__selection" data-visible={selectedText.length > 0}>
        <p title={selectedText}>
          {selectedText
            ? `已选 ${selectedText.length} 个字符，将填入来源主对话草稿`
            : "在辅助分析中选中文字，可带回来源主对话草稿。"}
        </p>
        <button
          type="button"
          className="button"
          disabled={!selectedText || draftPreparing}
          onClick={() => {
            prepareDraft().catch((cause: unknown) => {
              setDraftResult({ ok: false, message: errorMessage(cause) });
            });
          }}
        >
          {draftPreparing ? "正在准备…" : "带入主对话草稿"}
        </button>
      </div>
      {draftResult ? (
        <p
          className={draftResult.ok ? "side-chat__notice" : "side-chat__error"}
          role={draftResult.ok ? "status" : "alert"}
        >
          {draftResult.message}
        </p>
      ) : null}

      <form
        className="side-chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          send().catch((cause: unknown) => {
            setSendError(errorMessage(cause));
          });
        }}
      >
        <label htmlFor={`side-chat-input-${key}`}>继续这个只读问答</label>
        <textarea
          id={`side-chat-input-${key}`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !(event.nativeEvent as KeyboardEvent).isComposing &&
              !busy
            ) {
              event.preventDefault();
              send().catch((cause: unknown) => {
                setSendError(errorMessage(cause));
              });
            }
          }}
          placeholder="例如：结合最新执行记录，说明当前风险。Enter 发送，Shift+Enter 换行。"
          disabled={busy}
          rows={3}
        />
        {sendError ? (
          <p className="side-chat__error" role="alert">
            发送失败，输入已保留：{sendError}
          </p>
        ) : null}
        <div className="side-chat__composer-footer">
          <span>写文件、终端执行、派发、停止、审批和提交等请求请回来源主对话。</span>
          <button type="submit" className="button" disabled={!input.trim() || busy}>
            {sending ? "等待回复…" : visibleSnapshot?.busy ? "上一轮仍在生成…" : "发送"}
          </button>
        </div>
      </form>
    </section>
  );
}
