import { useCallback, useEffect, useRef, useState } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import type { WorkboardSessionInput, WorkboardSessionResult } from "../../../contracts/kanban";
import { sessionContentText } from "./department-board-model";

type SessionLine = Extract<WorkboardSessionResult, { state: "ok" }>["lines"][number];

/** 执行会话只读，继续发言须回原主控，避免开启第二个执行者。 */
export function ExecutionSessionView({
  api,
  input,
  title,
  onBack,
}: {
  readonly api: PiDesktopApi;
  readonly input: WorkboardSessionInput;
  readonly title: string;
  readonly onBack: () => void;
}) {
  const [lines, setLines] = useState<readonly SessionLine[]>([]);
  const [result, setResult] = useState<Extract<WorkboardSessionResult, { state: "ok" }>>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const read = useCallback(
    (offset: number) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(undefined);
      api
        .getWorkboardSession({ ...input, offset })
        .then((value) => {
          if (id !== requestId.current) return;
          if (value.state === "failed") {
            setError(value.message);
            return;
          }
          setLines((previous) => (offset === 0 ? value.lines : [...previous, ...value.lines]));
          setResult(value);
        })
        .catch((cause: unknown) => {
          if (id === requestId.current)
            setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    },
    [api, input],
  );
  useEffect(() => {
    setLines([]);
    setResult(undefined);
    read(0);
    return () => {
      requestId.current++;
    };
  }, [read]);
  return (
    <section className="department-session" data-testid="workboard-session">
      <button
        type="button"
        className="department-board__back"
        aria-label="返回部门卡"
        onClick={onBack}
      >
        <span aria-hidden="true">←</span> 返回部门卡
      </button>
      <header className="department-board__header">
        <div>
          <h1>{title}</h1>
          <p>执行会话 · 只读记录</p>
        </div>
        <button type="button" className="button" disabled={loading} onClick={() => read(0)}>
          刷新会话
        </button>
      </header>
      {loading ? <p role="status">正在读取会话…</p> : null}
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
      <div className="department-session__messages">
        {lines.map((line, index) => {
          const text = sessionContentText(line.content);
          return text ? (
            <article key={index} className="department-session__message">
              <div className="department-session__role">
                {(
                  {
                    user: "任务要求",
                    assistant: "执行者",
                    toolResult: "工具结果",
                    system: "系统记录",
                  } as Record<string, string>
                )[line.role ?? ""] ??
                  line.role ??
                  line.type}
                {line.model ? ` · ${line.model}` : ""}
              </div>
              <div className="department-session__text">{text}</div>
            </article>
          ) : null;
        })}
        {!loading && !error && lines.length === 0 ? (
          <p className="department-board__muted">会话尚无可显示的消息。</p>
        ) : null}
      </div>
      {result?.incomplete ? (
        <p className="department-board__muted">末行仍在写入，刷新后继续读取，不把它当成已完成。</p>
      ) : null}
      {result?.more ? (
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => read(result.nextOffset)}
        >
          继续读取
        </button>
      ) : null}
    </section>
  );
}
