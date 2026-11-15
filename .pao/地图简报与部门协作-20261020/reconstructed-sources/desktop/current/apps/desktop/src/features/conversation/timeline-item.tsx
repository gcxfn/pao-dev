import { useMemo, useRef, useState } from "react";
import type {
  SessionTranscriptCustomMessage,
  SessionTranscriptMessage,
} from "@pi-gui/session-driver";
import type {
  DisplayTimelineItem,
  TimelineActivity,
  TimelineToolCall,
  TimelineSummary,
  TimelineTurnMarker,
} from "../../../contracts/timeline-types";
import type { ScheduledTaskOrigin } from "../../../contracts/scheduled-tasks";
import { extensionToolRowLabel } from "../../../contracts/tool-labels";
import {
  parseResidualSessionLockToken,
  sessionLockTakeoverCommand,
} from "../../../contracts/session-lock-notice";
import { useExtensionToolLabel } from "../extensions/extension-tool-labels";
import {
  AnnotationMarkers,
  type AnnotationMarker,
  type OpenAnnotation,
} from "./annotations/annotation-markers";
import { parseAnnotatedPrompt } from "./annotations/annotation-prompt";
import { SentAnnotations } from "./annotations/sent-annotations";
import { ExtensionCardItem, type RunExtensionAction } from "./extension-card";
import { ImageAttachmentThumb } from "./image-attachment-thumb";
import { MessageMarkdown } from "./message-markdown";
import { stringifyToolValue, toolOutputImageSrc, toolOutputImages } from "./tool-output-images";
import { isTodoToolCall, parseTodoList, TodoTable } from "./todo-table";
import { TurnChangesCard, type OpenTurnChange } from "./turn-changes-card";
import type { WorkspaceFileLine } from "./workspace-file-line";
import { InlineDiff, extractDiffFromOutput } from "../../ui/diff-inline";
import {
  ChevronRightIcon,
  CopyIcon,
  DiffIcon,
  FileIcon,
  ForkIcon,
  SparkIcon,
  TerminalIcon,
} from "../../ui/icons";
import { extensionToLanguage } from "../../ui/syntax-highlight";
import { useI18n } from "../../i18n/react";

/**
 * W-bug9：接管按钮一次点击的策略（纯函数，便于单测钉定取消/连点分支）：
 * 弹窗取消或已提交过则不动；确认后提交一次接管命令并返回 true。
 * window.confirm 与 submit 接线留在组件侧。
 */
export function handleSessionTakeoverClick(input: {
  readonly confirmed: boolean;
  readonly token: string;
  readonly alreadySubmitted: boolean;
  readonly submit: (command: string) => void;
}): boolean {
  if (!input.confirmed || input.alreadySubmitted) {
    return false;
  }
  input.submit(sessionLockTakeoverCommand(input.token));
  return true;
}

export function TimelineItem({
  item,
  expandedToolCallIds,
  onToggleToolCall,
  onViewFileInDiff,
  sourceMessageIndex,
  onForkFromMessage,
  onOpenTurnChange,
  scheduledOrigin,
  workspacePath,
  onOpenWorkspaceFileLine,
  onExtensionAction,
  annotationMarkers,
  onOpenAnnotation,
}: {
  readonly item: DisplayTimelineItem;
  readonly expandedToolCallIds?: ReadonlySet<string>;
  readonly onToggleToolCall?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly onExtensionAction?: RunExtensionAction;
  readonly annotationMarkers?: readonly AnnotationMarker[];
  readonly onOpenAnnotation?: OpenAnnotation;
}) {
  switch (item.kind) {
    case "turn-marker":
      return <TimelineTurnMarkerItem item={item} />;
    case "turn-changes":
      return <TurnChangesCard turn={item.turn} onOpen={onOpenTurnChange} />;
    case "message":
      return (
        <TimelineMessage
          item={item}
          sourceMessageIndex={sourceMessageIndex}
          onForkFromMessage={onForkFromMessage}
          onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
          scheduledOrigin={scheduledOrigin}
          workspacePath={workspacePath}
          annotationMarkers={annotationMarkers}
          onOpenAnnotation={onOpenAnnotation}
        />
      );
    case "activity":
      return <TimelineActivityItem item={item} />;
    case "tool":
      return (
        <TimelineToolCallItem
          item={item}
          expanded={expandedToolCallIds?.has(item.callId) ?? false}
          onToggle={onToggleToolCall}
          onViewFileInDiff={onViewFileInDiff}
        />
      );
    case "summary":
      return <TimelineSummaryItem item={item} />;
    case "custom":
      return <TimelineCustomMessage item={item} />;
    case "card":
      return <ExtensionCardItem card={item.card} onAction={onExtensionAction} />;
    default:
      return unhandledTimelineItem(item);
  }
}

function unhandledTimelineItem(item: never): null {
  console.warn("[timeline] unhandled item kind", item);
  return null;
}

/** An extension message, drawn like terminal pi: its customType labels the markdown. */
function TimelineCustomMessage({ item }: { readonly item: SessionTranscriptCustomMessage }) {
  const { t } = useI18n();
  if (item.customType === "pao-firstrun") {
    return (
      <article
        className="timeline-item timeline-item--custom timeline-item--firstrun"
        data-testid="timeline-first-run"
      >
        <div className="timeline-item__custom-type">{t("First-run checklist")}</div>
        <div className="timeline-item__checklist">
          {item.text.replace(/^── 首跑清单[^\n]*\n/, "")}
        </div>
      </article>
    );
  }
  return (
    <article className="timeline-item timeline-item--custom" data-testid="timeline-custom-message">
      <div className="timeline-item__custom-type">{item.customType}</div>
      <MessageMarkdown text={item.text} />
    </article>
  );
}

function TimelineMessage({
  item,
  sourceMessageIndex,
  onForkFromMessage,
  scheduledOrigin,
  workspacePath,
  onOpenWorkspaceFileLine,
  annotationMarkers,
  onOpenAnnotation,
}: {
  readonly item: SessionTranscriptMessage;
  readonly sourceMessageIndex?: number;
  readonly onForkFromMessage?: (messageIndex: number, preview?: string) => void;
  readonly scheduledOrigin?: ScheduledTaskOrigin;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
  readonly annotationMarkers?: readonly AnnotationMarker[];
  readonly onOpenAnnotation?: OpenAnnotation;
}) {
  const { t } = useI18n();
  const articleRef = useRef<HTMLElement | null>(null);
  const annotated = useMemo(
    () => (item.role === "user" ? parseAnnotatedPrompt(item.text) : null),
    [item.role, item.text],
  );
  const markers =
    annotationMarkers?.length && onOpenAnnotation ? (
      <AnnotationMarkers
        articleRef={articleRef}
        markers={annotationMarkers}
        messageId={item.id}
        onOpen={onOpenAnnotation}
      />
    ) : null;

  if (item.role === "user") {
    const body = annotated ? annotated.body : item.text;
    return (
      <article className="timeline-item timeline-item--user" ref={articleRef}>
        <div className="timeline-item__user-stack">
          {scheduledOrigin ? (
            <div className="timeline-item__scheduled-origin" data-testid="sent-by-scheduled-task">
              Sent by scheduled task
            </div>
          ) : null}
          <div className="timeline-item__bubble">
            {item.attachments?.length ? (
              <div className="timeline-item__attachments">
                {item.attachments.map((attachment, index) =>
                  attachment.kind === "image" ? (
                    <ImageAttachmentThumb
                      className="timeline-item__attachment timeline-item__attachment--image"
                      key={`${item.id}:${index}`}
                      name={attachment.name ?? `Attachment ${index + 1}`}
                      src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    />
                  ) : (
                    <div
                      className="timeline-item__attachment timeline-item__attachment--file"
                      key={`${item.id}:${index}`}
                      title={attachment.fsPath}
                    >
                      <span className="timeline-item__attachment-icon" aria-hidden="true">
                        <FileIcon />
                      </span>
                      <span className="timeline-item__attachment-name">{attachment.name}</span>
                    </div>
                  ),
                )}
              </div>
            ) : null}
            {annotated ? <SentAnnotations annotations={annotated.annotations} /> : null}
            {annotated && !body.trim() ? null : <MessageMarkdown annotationRoot text={body} />}
          </div>
        </div>
        {markers}
      </article>
    );
  }

  if (item.role === "branchSummary" || item.role === "compactionSummary") {
    return (
      <article className="timeline-item timeline-item--summary-card">
        <div className="timeline-item__summary-eyebrow">
          {t(item.role === "branchSummary" ? "Branch summary" : "Compaction summary")}
        </div>
        <MessageMarkdown text={item.text} />
      </article>
    );
  }

  // The row stays while a run streams (Fork is disabled then), so the transcript never
  // shifts by the row's height when a run starts or ends.
  const forkable = sourceMessageIndex !== undefined;
  return (
    <article className="timeline-item timeline-item--assistant" ref={articleRef}>
      <MessageMarkdown
        annotationRoot
        onOpenWorkspaceFileLine={onOpenWorkspaceFileLine}
        text={item.text}
        workspacePath={workspacePath}
      />
      {forkable ? (
        <div className="timeline-item__actions">
          <button
            type="button"
            className="timeline-item__action"
            title={
              onForkFromMessage
                ? t("Fork conversation from this point")
                : t("Fork is available when the run finishes")
            }
            aria-label={t("Fork conversation from this point")}
            data-testid="fork-from-message"
            disabled={!onForkFromMessage}
            onClick={() => onForkFromMessage?.(sourceMessageIndex, item.text)}
          >
            <ForkIcon />
            <span className="timeline-item__action-label">Fork</span>
          </button>
        </div>
      ) : null}
      {markers}
    </article>
  );
}

function TimelineActivityItem({ item }: { readonly item: TimelineActivity }) {
  const { t } = useI18n();
  // W-bug9：残留会话锁报错就地提供一键显式接管（复用内核 /pao runtime takeover 同链路）；
  // 提交后禁用按钮（F8）：token 已轮换，重复提交只会多出一条旧 token 拒绝行。
  const [takeoverSubmitted, setTakeoverSubmitted] = useState(false);
  const takeoverToken = parseResidualSessionLockToken(item.label);
  const takeOver = (token: string) => {
    const confirmed = window.confirm(
      t(
        "The previous owner will lose control; its further requests are refused. Take over this session's control?\n\n{details}",
        { details: item.label },
      ),
    );
    const submitted = handleSessionTakeoverClick({
      confirmed,
      token,
      alreadySubmitted: takeoverSubmitted,
      submit: (command) => {
        void window.piApp?.submitComposer(command).catch((error: unknown) => {
          console.error("[renderer] session takeover submit failed", error);
        });
      },
    });
    if (submitted) {
      setTakeoverSubmitted(true);
    }
  };
  return (
    <div className={`timeline-activity timeline-activity--${item.tone ?? "neutral"}`}>
      <span className="timeline-activity__label">{item.label}</span>
      {item.detail ? <span className="timeline-activity__detail">{item.detail}</span> : null}
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
      {takeoverToken ? (
        <button
          type="button"
          className="timeline-activity__takeover"
          disabled={takeoverSubmitted}
          onClick={() => takeOver(takeoverToken)}
        >
          {t("Take over session control")}
        </button>
      ) : null}
    </div>
  );
}

function TimelineToolCallItem({
  item,
  expanded,
  onToggle,
  onViewFileInDiff,
}: {
  readonly item: TimelineToolCall;
  readonly expanded: boolean;
  readonly onToggle?: (callId: string) => void;
  readonly onViewFileInDiff?: (path: string) => void;
}) {
  const { t } = useI18n();
  const hasContent = item.input !== undefined || item.output !== undefined;
  // An extension's tool shows the label it registered instead of a guess from its name.
  const extensionLabel = useExtensionToolLabel(item.toolName);
  const writeTool = isWriteTool(item.toolName);
  const diffText = writeTool ? extractDiffFromOutput(item.output) : undefined;
  const diffStats = diffText ? countDiffStats(diffText) : undefined;
  const compactLabel =
    extensionLabel === undefined
      ? buildCompactLabel(item, diffStats, t)
      : extensionToolRowLabel(extensionLabel, item.input);
  const filePath = writeTool ? extractFilename(item.input) || undefined : undefined;
  const diffLanguage = diffText && filePath ? extensionToLanguage(filePath) : undefined;
  const inlineDetail = item.status === "error" ? item.detail : undefined;
  const images = toolOutputImages(item.output);
  const todos =
    isTodoToolCall(item.toolName) && item.status !== "error"
      ? parseTodoList(item.input)
      : undefined;

  const handleCopy = () => {
    const text = diffText ?? formatToolContent(item.input, item.output);
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      console.error("[renderer] navigator.clipboard.writeText failed", error);
    });
  };

  return (
    <article className={`timeline-tool timeline-tool--${item.status}`}>
      <div className="timeline-tool__header-row">
        <span className="timeline-tool__glyph" aria-hidden="true">
          {extensionLabel === undefined || diffText ? toolGlyph(item.toolName) : <SparkIcon />}
        </span>
        <button
          className="timeline-tool__header"
          type="button"
          aria-expanded={expanded}
          disabled={!hasContent}
          onClick={() => onToggle?.(item.callId)}
        >
          {hasContent ? (
            <span
              className={`timeline-tool__chevron ${expanded ? "timeline-tool__chevron--expanded" : ""}`}
            >
              <ChevronRightIcon />
            </span>
          ) : null}
          <span className="timeline-tool__label">{compactLabel}</span>
          {inlineDetail ? <span className="timeline-tool__detail">{inlineDetail}</span> : null}
          {diffStats ? (
            <span className="timeline-tool__diff-stats">
              <span className="timeline-tool__stat-add">+{diffStats.added}</span>{" "}
              <span className="timeline-tool__stat-del">-{diffStats.removed}</span>
            </span>
          ) : null}
          <span className="timeline-tool__meta-inline" title={toolTimeTitle(item)}>
            <span className="timeline-tool__status-pip" aria-hidden="true" />
            {`${item.toolName} \u00b7 ${statusLabel(item.status, t)}`}
            {toolDurationText(item, t) ? ` \u00b7 ${toolDurationText(item, t)}` : ""}
          </span>
        </button>
        {filePath && onViewFileInDiff ? (
          <button
            aria-label={`View ${filePath} in changes`}
            className="icon-button timeline-tool__view-in-diff"
            data-testid="timeline-tool-view-in-diff"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onViewFileInDiff(filePath);
            }}
          >
            <DiffIcon />
          </button>
        ) : null}
      </div>
      {todos && todos.length > 0 ? (
        // Shown while collapsed too: the checklist is the result of a todo write.
        <TodoTable todos={todos} />
      ) : null}
      {images.length > 0 ? (
        // Shown while collapsed too: an image a tool made is a result in itself.
        <div className="timeline-tool__images" data-testid="timeline-tool-images">
          {images.map((image, index) => (
            <ImageAttachmentThumb
              className="timeline-tool__image"
              key={`${item.callId}:${index}`}
              name={`${item.toolName} image ${index + 1}`}
              src={toolOutputImageSrc(image)}
            />
          ))}
        </div>
      ) : null}
      {expanded && hasContent ? (
        <div className="timeline-tool__body">
          {diffText ? (
            <>
              <div className="timeline-tool__diff-header">
                <span className="timeline-tool__diff-filename">
                  {extractFilename(item.input)}
                  {diffStats ? (
                    <span className="timeline-tool__diff-stats">
                      {" "}
                      <span className="timeline-tool__stat-add">+{diffStats.added}</span>{" "}
                      <span className="timeline-tool__stat-del">-{diffStats.removed}</span>
                    </span>
                  ) : null}
                </span>
                <button
                  className="icon-button timeline-tool__copy"
                  type="button"
                  onClick={handleCopy}
                  aria-label={t("Copy")}
                >
                  <CopyIcon />
                </button>
              </div>
              <InlineDiff diff={diffText} language={diffLanguage} />
            </>
          ) : (
            <>
              <div className="timeline-tool__body-actions">
                <button
                  className="icon-button timeline-tool__copy"
                  type="button"
                  onClick={handleCopy}
                  aria-label={t("Copy")}
                >
                  <CopyIcon />
                </button>
              </div>
              {/* 输入与结果分开：普通阅读先看这两块，原始记录仍可整段复制。 */}
              <div className="timeline-tool__record" data-testid="timeline-tool-record">
                <p className="timeline-tool__record-label">{t("Input")}</p>
                <pre className="timeline-tool__pre" data-testid="timeline-tool-input">
                  {formatToolSide(item.input)}
                </pre>
                <p className="timeline-tool__record-label">{t("Result")}</p>
                <pre className="timeline-tool__pre" data-testid="timeline-tool-output">
                  {formatToolSide(item.output)}
                </pre>
              </div>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function isWriteTool(toolName: string): boolean {
  return /write|edit|patch|apply/i.test(toolName);
}

function toolGlyph(toolName: string) {
  if (isWriteTool(toolName)) {
    return <DiffIcon />;
  }
  if (/bash|shell|exec|terminal|command|run/i.test(toolName)) {
    return <TerminalIcon />;
  }
  if (/read|view|cat|open|file|glob|grep|search|ls/i.test(toolName)) {
    return <FileIcon />;
  }
  return <SparkIcon />;
}

function buildCompactLabel(
  item: TimelineToolCall,
  diffStats: { added: number; removed: number } | undefined,
  t: (key: string) => string,
): string {
  // PAO 已知工具先说中文名；未知工具保持主进程给的原文（安全文本回退，不猜）。
  if (PAO_TOOL_NAMES.has(item.toolName)) {
    const label = t(item.toolName);
    if (label !== item.toolName) return label;
  }
  if (isWriteTool(item.toolName)) {
    const filename = extractFilename(item.input);
    if (filename) {
      return t("Edited {path}").replace("{path}", shortenPath(filename));
    }
  }
  return item.label;
}

/** PAO 自己注册的工具名（与内核注册名一致；改了内核名字要同批更新）。 */
const PAO_TOOL_NAMES = new Set([
  "pao_breakdown_done",
  "pao_change_status",
  "pao_check_overreach",
  "pao_collab_relay",
  "pao_confirm_flow",
  "pao_control_node",
  "pao_create_card",
  "pao_create_dept",
  "pao_decision_pack",
  "pao_deliver_card",
  "pao_dismiss_minister",
  "pao_dispatch_card",
  "pao_fanout",
  "pao_handoff",
  "pao_health_check",
  "pao_ingest_kb",
  "pao_inspect_kb",
  "pao_inventory",
  "pao_memory_forget",
  "pao_memory_recall",
  "pao_memory_write",
  "pao_minister_decision_pack",
  "pao_minister_submit_cards",
  "pao_plan_create",
  "pao_plan_feedback",
  "pao_plan_query",
  "pao_plan_save_template",
  "pao_plan_start",
  "pao_plan_update",
  "pao_push_flow",
  "pao_query_flow",
  "pao_query_kb",
  "pao_query_queue",
  "pao_request_ruling",
  "pao_restricted_query",
  "pao_review_flow",
  "pao_save_flow",
  "pao_spawn_minister",
  "pao_start_flow",
  "pao_stop_background",
  "pao_submit_decision",
  "pao_submit_receipt",
  "pao_terminate_card",
  "pao_verify_card",
  "pao_write_recipe",
]);

function extractFilename(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const path = record.file_path ?? record.filePath ?? record.path ?? record.filename;
    if (typeof path === "string") {
      return path;
    }
  }
  return "";
}

function shortenPath(filePath: string): string {
  // Show last 2-3 path segments for readability
  const parts = filePath.split("/");
  if (parts.length <= 3) {
    return filePath;
  }
  return parts.slice(-3).join("/");
}

function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function formatToolContent(input: unknown, output: unknown): string {
  const parts: string[] = [];
  if (input !== undefined) {
    parts.push(typeof input === "string" ? input : stringifyToolValue(input));
  }
  if (output !== undefined) {
    parts.push(typeof output === "string" ? output : stringifyToolValue(output));
  }
  return parts.join("\n\n");
}

/** 单侧内容：没有就是「无」，不拿另一侧顶上，也不编造。 */
function formatToolSide(value: unknown): string {
  if (value === undefined || value === null) return "—";
  return typeof value === "string" ? value : stringifyToolValue(value);
}

/** 中文状态：已失败不显示「完成」，未知状态原样显示。 */
function statusLabel(status: TimelineToolCall["status"], t: (key: string) => string): string {
  if (status === "running") return t("Running");
  if (status === "success") return t("Done");
  if (status === "error") return t("Failed");
  return status;
}

/** 可读耗时：一头一尾都有真实时刻才算，缺任一头＝不显示，不猜。 */
function toolDurationText(item: TimelineToolCall, t: (key: string) => string): string | undefined {
  if (!item.finishedAt) return undefined;
  const started = Date.parse(item.createdAt);
  const finished = Date.parse(item.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return undefined;
  }
  return t("Took {duration}").replace("{duration}", formatWorkedDuration(finished - started));
}

/** 原始时间与技术名留在悬停标题里，随时可查。 */
function toolTimeTitle(item: TimelineToolCall): string {
  return item.finishedAt ? `${item.createdAt} → ${item.finishedAt}` : item.createdAt;
}

function TimelineTurnMarkerItem({ item }: { readonly item: TimelineTurnMarker }) {
  const { t } = useI18n();
  return (
    <div className="timeline-turn-marker" data-testid="timeline-turn-marker">
      <span className="timeline-turn-marker__label">
        {t("Worked for {duration}").replace("{duration}", formatWorkedDuration(item.durationMs))}
      </span>
    </div>
  );
}

/** 可读耗时（中文单位）：秒/分/时，最小 1 秒。 */
function formatWorkedDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours} 小时 ${remMinutes} 分` : `${hours} 小时`;
}

function TimelineSummaryItem({ item }: { readonly item: TimelineSummary }) {
  if (item.presentation === "divider") {
    return (
      <div className="timeline-summary">
        <span>{item.label}</span>
        {item.metadata ? <span className="timeline-summary__meta">{item.metadata}</span> : null}
      </div>
    );
  }

  return (
    <div className="timeline-activity timeline-activity--summary">
      <span className="timeline-activity__label">{item.label}</span>
      {item.metadata ? <span className="timeline-activity__meta">{item.metadata}</span> : null}
    </div>
  );
}
