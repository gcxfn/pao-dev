import { useEffect, useState } from "react";
import type { DesktopAppState, WorkspaceSessionTarget } from "../../../contracts/desktop-state";
import { WorkflowCardsView, type WorkflowCardsViewProps } from "./workflow-cards-view";
import { TemporaryPlansView } from "../plans/temporary-plans-view";
import { CanvasSurface } from "../canvas/canvas-surface";

/** 工作流一个入口；计划历史与旧运行保留在同一页面内。 */
export function WorkflowSurface(
  props: WorkflowCardsViewProps & {
    readonly onSnapshot: (state: DesktopAppState) => void;
    readonly onSelectSession: (target: WorkspaceSessionTarget) => void;
  },
) {
  const [view, setView] = useState<"cards" | "history" | "templates">("cards");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (props.snapshot.activeView !== "plans") return;
    props.api
      .setActiveView("canvas")
      .then(props.onSnapshot)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [props.api, props.snapshot.activeView, props.onSnapshot]);
  return (
    <div className="workflow-surface">
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
      <nav className="workflow-surface__nav" aria-label="工作流内容">
        <button
          className="button button--ghost"
          type="button"
          aria-pressed={view === "cards"}
          onClick={() => setView("cards")}
        >
          步骤工作台
        </button>
        <button
          className="button button--ghost"
          type="button"
          aria-pressed={view === "history"}
          onClick={() => setView("history")}
        >
          计划历史
        </button>
        <button
          className="button button--ghost"
          type="button"
          aria-pressed={view === "templates"}
          onClick={() => setView("templates")}
        >
          模板与旧运行
        </button>
      </nav>
      <div className="workflow-surface__body" hidden={view !== "cards"}>
        <WorkflowCardsView {...props} />
      </div>
      {view === "history" ? (
        <TemporaryPlansView api={props.api} workspaceId={props.snapshot.selectedWorkspaceId} />
      ) : null}
      {view === "templates" ? (
        <CanvasSurface
          api={props.api}
          snapshot={props.snapshot}
          onSnapshot={props.onSnapshot}
          onSelectSession={props.onSelectSession}
          embeddedChat={props.embeddedChat}
        />
      ) : null}
    </div>
  );
}
