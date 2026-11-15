/**
 * 卡看板视图 v2（五列＋操作侧）。
 *
 * 结构与信息层级抄改自 Hermes-Agent 的 kanban 看板
 * （apps/desktop/src/plugins/kanban/board.tsx、drawer.tsx、kanban.css），
 * 按 PAO 的 KanbanResult 契约与设计令牌重写：
 * - 五列＝卡状态现读值（待认领/进行中/已交付/失败/取消），列顺序固定；
 * - 搜索与 project/dept 筛选只作用于本地副本，不写状态、不发请求；
 * - 卡片选中后右侧详情展示正文／验收／输入／依赖／回执／执行记录；
 * - 操作侧（S7-B）只绑定一个内核合法动作：以「用户」身份取消。拖放（只认取消列）、
 *   Ctrl+点击多选＋批量取消条、右键菜单都走同一操作桥，逐卡由内核状态机判权，
 *   逐项如实显示成功/失败与原因；操作后全量重读权威数据，不用本地乐观态。
 *   完成必须走验收链（回执→越界核查→验收），看板不提供、拖到已交付列显式拒绝。
 *
 * 上游来源：Hermes-Agent（https://github.com/NousResearch/Hermes-Agent）
 * MIT License
 *
 * Copyright (c) 2025 Nous Research
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  KanbanCard,
  KanbanCardOpResult,
  KanbanCardStatus,
  KanbanResult,
  KanbanWorkflow,
} from "../../../contracts/kanban";
import { useI18n } from "../../i18n/react";
import { formatLocalMinute } from "../../lib/string-utils";
import { kanbanActivitySignal, kanbanLeaseChip, kanbanSilenceMinutes } from "./kanban-activity";
import {
  buildCancelCommand,
  buildTerminateCommand,
  canPrepareCancel,
  canPrepareTerminate,
  cardRefNumber,
  formatCardNumber,
  kanbanDropAction,
} from "./kanban-command";
import "../../styles/kanban.css";

/** 列顺序固定：后端只给状态值，看板自己决定五列怎么排。 */
const COLUMN_ORDER: readonly KanbanCardStatus[] = [
  "unclaimed",
  "in_progress",
  "delivered",
  "failed",
  "canceled",
];

/** 列标题与详情展示用中文标签（值已随内核协议迁英文，用户可见文本保持中文）。 */
const STATUS_LABELS: Record<KanbanCardStatus, string> = {
  unclaimed: "待认领",
  in_progress: "进行中",
  delivered: "已交付",
  failed: "失败",
  canceled: "取消",
};

const NO_CARDS: readonly KanbanCard[] = [];
const NO_ISSUES: readonly { readonly path: string; readonly message: string }[] = [];
const NO_WORKFLOWS: readonly KanbanWorkflow[] = [];

/** 一次卡操作的逐项回执：成败与内核原因原样展示，不合并、不扩大。 */
interface CardOpRow {
  readonly path: string;
  readonly goal: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface KanbanBoardProps {
  /** 主进程读到的卡聚合结果；unavailable 与 issues 都显式展示，不做兜底假数据。 */
  readonly result: KanbanResult;
  readonly loading: boolean;
  readonly onRefresh: () => void;
  /** 当前选中的卡路径（提升到 KanbanPage：部门与待处理入口也能打开同一份卡详情）。 */
  readonly selectedPath: string | null;
  readonly onSelectPath: (path: string | null) => void;
  /**
   * 路径导航（证据/产物/会话）：复用主进程 revealWorkspaceFile 通道——
   * 主进程做存在性＋越界复核后才交系统文件管理器，不裸信渲染层路径；缺省＝纯文本。
   */
  readonly onOpenPath?: (path: string) => Promise<void>;
  /**
   * 卡操作桥（S7-B）：以「用户」身份取消一张卡；缺省＝看板退回纯只读。
   * 逐卡调用，成败由主进程/内核逐卡判定；调用方负责操作后重读权威数据。
   */
  readonly onCardOp?: (card: KanbanCard) => Promise<KanbanCardOpResult>;
}

/**
 * 卡看板：纯展示＋本地筛选；操作动作统一走 runCancel（逐卡串行、逐项回执）。
 */
export function KanbanBoard({
  result,
  loading,
  onRefresh,
  selectedPath,
  onSelectPath,
  onOpenPath,
  onCardOp,
}: KanbanBoardProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("");
  const [department, setDepartment] = useState("");
  // 多选（Ctrl/⌘+点击增减）与批量操作条：只服务「批量取消」，普通点击仍开详情并清空多选。
  const [multiSelected, setMultiSelected] = useState<ReadonlySet<string>>(new Set());
  const [opRunning, setOpRunning] = useState(false);
  const [opResults, setOpResults] = useState<readonly CardOpRow[]>([]);
  // 拖放：拖着的卡与悬停列只存本地状态；drop 裁决统一走 kanbanDropAction。
  const [dragging, setDragging] = useState<KanbanCard | null>(null);
  const [dropHint, setDropHint] = useState<KanbanCardStatus | null>(null);
  // 右键菜单：位置＋目标卡；点空白/Escape 关闭。
  const [menu, setMenu] = useState<{
    readonly x: number;
    readonly y: number;
    readonly card: KanbanCard;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);

  const cards = result.state === "available" ? result.cards : NO_CARDS;
  const issues = result.state === "available" ? result.issues : NO_ISSUES;
  const workflows = result.state === "available" ? result.workflows : NO_WORKFLOWS;

  const projects = useMemo(() => uniqueSorted(cards.map((card) => card.project)), [cards]);
  const departments = useMemo(() => uniqueSorted(cards.map((card) => card.department)), [cards]);

  const filtered = useMemo(
    () => cards.filter((card) => cardMatches(card, { search, project, department })),
    [cards, search, project, department],
  );

  const grouped = useMemo(() => groupByStatus(filtered), [filtered]);

  const selected =
    selectedPath === null ? null : (cards.find((card) => card.path === selectedPath) ?? null);

  const selectedCards = useMemo(
    () => cards.filter((card) => multiSelected.has(card.path)),
    [cards, multiSelected],
  );

  /**
   * 逐卡串行执行取消：每张卡单独过主进程桥（内核状态机逐卡判权），
   * 结果逐项收集展示——一张成功不得整批报成功；完成后全量重读权威数据。
   */
  const runCancel = async (targets: readonly KanbanCard[]) => {
    if (!onCardOp || opRunning || targets.length === 0) return;
    setOpRunning(true);
    setOpResults([]);
    const rows: CardOpRow[] = [];
    for (const card of targets) {
      try {
        const outcome = await onCardOp(card);
        rows.push({ path: card.path, goal: card.goal, ok: outcome.ok, message: outcome.message });
      } catch (error) {
        rows.push({
          path: card.path,
          goal: card.goal,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    setOpResults(rows);
    setMultiSelected(new Set());
    setOpRunning(false);
    onRefresh();
  };

  const reportCancelError = (targets: readonly KanbanCard[], error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setOpRunning(false);
    setOpResults(
      targets.map((card) => ({
        path: card.path,
        goal: card.goal,
        ok: false,
        message,
      })),
    );
  };

  const toggleMulti = (card: KanbanCard) => {
    setMultiSelected((current) => {
      const next = new Set(current);
      if (next.has(card.path)) next.delete(card.path);
      else next.add(card.path);
      return next;
    });
  };

  const dropOn = (target: KanbanCardStatus) => {
    setDropHint(null);
    const card = dragging;
    setDragging(null);
    if (!card) return;
    const verdict = kanbanDropAction(target, card);
    if (verdict.kind === "cancel") {
      runCancel([card]).catch((error: unknown) => reportCancelError([card], error));
      return;
    }
    // 拖放被拒也是操作回执：点名原因（完成须走验收链／只支持取消），不静默不动。
    setOpResults([{ path: card.path, goal: card.goal, ok: false, message: verdict.reason }]);
  };

  const closeMenu = useCallback(() => {
    const trigger = menuTriggerRef.current;
    setMenu(null);
    setCopiedKey(null);
    window.setTimeout(() => {
      if (trigger && document.contains(trigger)) trigger.focus();
    }, 0);
  }, []);

  const copyCommand = (key: string, text: string) => {
    setCopyError(null);
    navigator.clipboard
      .writeText(text)
      .then(() => setCopiedKey(key))
      .catch((error: unknown) => {
        setCopiedKey(null);
        setCopyError(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <section className="kanban-view" data-testid="kanban-view">
      <header className="view-header">
        <div>
          <h1 className="view-header__title">{t("Kanban board")}</h1>
          <p className="view-header__body">
            {t(
              "Cards grouped by their current status. The board can only cancel cards as the user; completion always goes through the acceptance chain.",
            )}
          </p>
        </div>
        <div className="view-header__actions">
          <button
            className="button"
            data-testid="kanban-refresh"
            disabled={loading}
            type="button"
            onClick={onRefresh}
          >
            {t("Refresh")}
          </button>
        </div>
      </header>

      {loading ? (
        <p className="kanban-status" role="status">
          {t("Loading…")}
        </p>
      ) : null}

      {/* 首帧/刷新中只报 loading，不用 role=alert 横幅承载「正在读取」——横幅只留给真实错误。 */}
      {result.state === "unavailable" && !loading ? (
        <p className="error-banner" role="alert" data-testid="kanban-unavailable">
          {result.message}
        </p>
      ) : null}

      {result.state === "available" && issues.length > 0 ? (
        <div className="error-banner kanban-issues" role="alert" data-testid="kanban-issues">
          <p className="kanban-issues__title">{t("Some cards could not be read.")}</p>
          <ul className="kanban-issues__list">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <span className="kanban-issues__path">{issue.path}</span>
                <span className="kanban-issues__message">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.state === "available" ? (
        <>
          {multiSelected.size > 0 ? (
            <div className="kanban-batch" data-testid="kanban-batch-bar" role="toolbar">
              <span className="kanban-batch__count" data-testid="kanban-batch-count">
                {t("{count} cards selected · Ctrl+click to toggle", { count: multiSelected.size })}
              </span>
              {onCardOp ? (
                <button
                  className="button"
                  data-testid="kanban-batch-cancel"
                  disabled={opRunning}
                  type="button"
                  onClick={() => {
                    runCancel(selectedCards).catch((error: unknown) =>
                      reportCancelError(selectedCards, error),
                    );
                  }}
                >
                  {t("Cancel selected cards")}
                </button>
              ) : null}
              <button
                className="button button--ghost"
                data-testid="kanban-batch-clear"
                type="button"
                onClick={() => setMultiSelected(new Set())}
              >
                {t("Clear selection")}
              </button>
            </div>
          ) : null}
          <div className="kanban-selection-tools" role="toolbar">
            <button
              className="button button--ghost"
              data-testid="kanban-selection-toggle"
              aria-pressed={selectionMode}
              type="button"
              onClick={() => {
                setSelectionMode((value) => !value);
                if (selectionMode) setMultiSelected(new Set());
              }}
            >
              {selectionMode ? "退出选择" : "选择卡片"}
            </button>
            {selectionMode ? <span>点击卡片可多选；Ctrl/⌘+点击仍可直接多选。</span> : null}
          </div>
          {copyError ? (
            <p className="error-banner" role="alert" data-testid="kanban-copy-error">
              复制失败：{copyError}。请重试。
            </p>
          ) : null}

          {opResults.length > 0 ? (
            <ul className="kanban-op-results" data-testid="kanban-op-results">
              {opResults.map((row) => (
                <li
                  className={`kanban-op-result${row.ok ? "" : " kanban-op-result--failed"}`}
                  data-ok={row.ok ? "true" : "false"}
                  data-testid="kanban-op-result"
                  key={row.path}
                >
                  <strong>{row.goal}</strong>
                  <span>{row.ok ? t("Succeeded") : t("Failed")}</span>
                  <span className="kanban-op-result__message">{row.message}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="kanban-toolbar">
            <label className="kanban-toolbar__field">
              <span className="kanban-toolbar__label">{t("Search")}</span>
              <input
                className="kanban-search"
                data-testid="kanban-search"
                placeholder={t("Search cards")}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="kanban-toolbar__field">
              <span className="kanban-toolbar__label">{t("Project")}</span>
              <select
                className="kanban-select"
                data-testid="kanban-project"
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="">{t("All")}</option>
                {projects.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="kanban-toolbar__field">
              <span className="kanban-toolbar__label">{t("Dept")}</span>
              <select
                className="kanban-select"
                data-testid="kanban-department"
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
              >
                <option value="">{t("All")}</option>
                {departments.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <span className="kanban-toolbar__count" data-testid="kanban-count">
              {t("{count} cards", { count: filtered.length })}
            </span>
          </div>

          {cards.length === 0 ? (
            <p className="kanban-empty" data-testid="kanban-empty">
              {t("No cards found.")}
            </p>
          ) : (
            <div className={`kanban-layout${selected ? "" : " kanban-layout--single"}`}>
              <div className="kanban-columns" data-testid="kanban-columns">
                {COLUMN_ORDER.map((status) => (
                  <KanbanColumn
                    key={status}
                    cards={grouped.get(status) ?? NO_CARDS}
                    dropHint={dropHint}
                    multiSelected={multiSelected}
                    selectedPath={selectedPath}
                    status={status}
                    onCancelDrag={() => {
                      setDragging(null);
                      setDropHint(null);
                    }}
                    onClickCard={(card, event) => {
                      if (selectionMode || event.ctrlKey || event.metaKey) {
                        toggleMulti(card);
                        return;
                      }
                      if (multiSelected.size > 0) setMultiSelected(new Set());
                      onSelectPath(selectedPath === card.path ? null : card.path);
                    }}
                    onContextMenuCard={(card, event) => {
                      event.preventDefault();
                      const target = event.currentTarget as HTMLElement;
                      menuTriggerRef.current = target.matches('[data-testid="kanban-card-more"]')
                        ? (target as HTMLButtonElement)
                        : (target.parentElement?.querySelector<HTMLButtonElement>(
                            '[data-testid="kanban-card-more"]',
                          ) ?? null);
                      setMenu({
                        x: Math.max(
                          8,
                          Math.min(event.clientX, Math.max(8, window.innerWidth - 288)),
                        ),
                        y: Math.max(
                          8,
                          Math.min(event.clientY, Math.max(8, window.innerHeight - 260)),
                        ),
                        card,
                      });
                    }}
                    onDragStartCard={(card) => setDragging(card)}
                    onDrop={() => dropOn(status)}
                    onHoverDrag={(hovering) => setDropHint(hovering ? status : null)}
                  />
                ))}
              </div>
              {selected ? (
                <KanbanDetail
                  key={selected.path}
                  card={selected}
                  onClose={() => onSelectPath(null)}
                  onOpenPath={onOpenPath}
                />
              ) : null}
            </div>
          )}

          {workflows.length > 0 ? (
            <KanbanWorkflows cards={cards} workflows={workflows} onSelect={onSelectPath} />
          ) : null}
        </>
      ) : null}

      {menu ? (
        <CardContextMenu
          copiedKey={copiedKey}
          menu={menu}
          onCopy={copyCommand}
          onClose={closeMenu}
          onOpenDetail={() => {
            if (multiSelected.size > 0) setMultiSelected(new Set());
            onSelectPath(menu.card.path);
            closeMenu();
          }}
          onRunCancel={
            onCardOp && canPrepareCancel(menu.card)
              ? () => {
                  closeMenu();
                  runCancel([menu.card]).catch((error: unknown) =>
                    reportCancelError([menu.card], error),
                  );
                }
              : undefined
          }
        />
      ) : null}
    </section>
  );
}

/** 卡片右键菜单：入口动作同受「只绑定合法操作」约束；点遮罩/Escape 关闭。 */
function CardContextMenu({
  copiedKey,
  menu,
  onCopy,
  onClose,
  onOpenDetail,
  onRunCancel,
}: {
  readonly copiedKey: string | null;
  readonly menu: { readonly x: number; readonly y: number; readonly card: KanbanCard };
  readonly onCopy: (key: string, text: string) => void;
  readonly onClose: () => void;
  readonly onOpenDetail: () => void;
  readonly onRunCancel?: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const first = document.querySelector<HTMLButtonElement>(
      '[data-testid="kanban-card-menu"] [role="menuitem"]',
    );
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div
      className="kanban-menu-overlay"
      data-testid="kanban-menu-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="kanban-menu"
        data-testid="kanban-card-menu"
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="kanban-menu__title">{menu.card.goal}</p>
        <button
          className="kanban-menu__item"
          data-testid="kanban-menu-open"
          role="menuitem"
          type="button"
          onClick={onOpenDetail}
        >
          {t("Open card details")}
        </button>
        {onRunCancel ? (
          <button
            className="kanban-menu__item"
            data-testid="kanban-menu-cancel"
            role="menuitem"
            type="button"
            onClick={onRunCancel}
          >
            {t("Cancel this card (as user)")}
          </button>
        ) : null}
        {canPrepareCancel(menu.card) ? (
          <button
            className="kanban-menu__item"
            data-testid="kanban-menu-copy-cancel"
            role="menuitem"
            type="button"
            onClick={() => onCopy("cancel", buildCancelCommand(menu.card))}
          >
            {copiedKey === "cancel" ? t("Copied") : t("Copy cancel command")}
          </button>
        ) : null}
        {canPrepareTerminate(menu.card) ? (
          <button
            className="kanban-menu__item"
            data-testid="kanban-menu-copy-terminate"
            role="menuitem"
            type="button"
            onClick={() => onCopy("terminate", buildTerminateCommand(menu.card))}
          >
            {copiedKey === "terminate" ? t("Copied") : t("Copy terminate command")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function KanbanColumn({
  cards,
  dropHint,
  multiSelected,
  status,
  onCancelDrag,
  onClickCard,
  onContextMenuCard,
  onDragStartCard,
  onDrop,
  onHoverDrag,
  selectedPath,
}: {
  readonly cards: readonly KanbanCard[];
  /** 拖放悬停提示：本列是当前悬停列时高亮（是否可落由 drop 时的裁决决定，不预判）。 */
  readonly dropHint: KanbanCardStatus | null;
  readonly multiSelected: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly status: KanbanCardStatus;
  readonly onCancelDrag: () => void;
  readonly onClickCard: (card: KanbanCard, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onContextMenuCard: (card: KanbanCard, event: ReactMouseEvent) => void;
  readonly onDragStartCard: (card: KanbanCard) => void;
  readonly onDrop: () => void;
  readonly onHoverDrag: (hovering: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <section
      className={`kanban-column${dropHint === status ? " kanban-column--drop" : ""}`}
      data-status={status}
      data-testid="kanban-column"
      onDragEnter={() => onHoverDrag(true)}
      onDragLeave={() => onHoverDrag(false)}
      onDragOver={(event) => {
        // 悬停即允许 drop：合法性统一由 drop 时的 kanbanDropAction 裁决（非法目标也给拒绝回执）。
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <header className="kanban-column__head">
        <span aria-hidden className="kanban-column__dot" />
        <h2 className="kanban-column__title">{STATUS_LABELS[status]}</h2>
        <span className="kanban-column__count">{cards.length}</span>
      </header>
      {cards.length === 0 ? (
        <p className="kanban-column__empty">{t("None")}</p>
      ) : (
        <ul className="kanban-column__cards">
          {cards.map((card) => (
            <li
              draggable
              key={card.path}
              onDragEnd={onCancelDrag}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", card.path);
                event.dataTransfer.effectAllowed = "move";
                onDragStartCard(card);
              }}
            >
              <button
                aria-pressed={card.path === selectedPath || multiSelected.has(card.path)}
                className={`kanban-card${card.path === selectedPath ? " kanban-card--selected" : ""}${multiSelected.has(card.path) ? " kanban-card--checked" : ""}`}
                data-path={card.path}
                data-status={card.status}
                data-testid="kanban-card"
                type="button"
                onClick={(event) => onClickCard(card, event)}
                onContextMenu={(event) => onContextMenuCard(card, event)}
              >
                {card.status === "in_progress" ? <span aria-hidden className="kanban-arc" /> : null}
                <span className="kanban-card__goal">{card.goal}</span>
                <span className="kanban-card__meta">
                  <span className="kanban-card__chip">
                    {t("Card")} {card.number}
                  </span>
                  <span className="kanban-card__chip">{card.department}</span>
                  {card.owner ? <span className="kanban-card__chip">{card.owner}</span> : null}
                  <span className="kanban-card__chip">
                    {t("Attempts")} {card.attempts}
                  </span>
                  {card.dependencies.map((dependency) => (
                    <span className="kanban-card__chip" key={dependency} title={dependency}>
                      依赖 {dependency}
                    </span>
                  ))}
                  {card.status === "in_progress" ? <ActivityChip card={card} /> : null}
                </span>
                <span className="kanban-card__foot">
                  <span>{card.priority}</span>
                  <span>{card.created}</span>
                  <span className="kanban-card__project" title={card.project}>
                    {projectShort(card.project)}
                  </span>
                </span>
              </button>
              <button
                className="kanban-card__more"
                data-testid="kanban-card-more"
                data-card-path={card.path}
                aria-label={`更多操作：${card.goal}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onContextMenuCard(card, event);
                }}
              >
                ⋯
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 进行中卡的活性标记（S7-B 接真实租约值）：
 * - 租约芯片三态：已被接管（原 worker 输出仅留档）＞ 租约已到期（待显式接管）＞ 租约未到期（amber）；
 *   字段缺失/不可解析＝如实「未知」原样展示，不推断已到期；
 * - 静默芯片照常并列（租约事实与输出新鲜度是两件事，不互相遮蔽）；
 * - 预警只用同进程现读活性判断，不拿卡时间兜底成「正常」。
 */
function ActivityChip({ card }: { readonly card: KanbanCard }) {
  const { t } = useI18n();
  const now = Date.now();
  const lease = kanbanLeaseChip(card, now);
  const signal = kanbanActivitySignal(card, now);
  return (
    <>
      {lease ? (
        <span
          className={`kanban-card__chip ${
            lease.takenOver
              ? "kanban-card__chip--taken-over"
              : lease.expired
                ? "kanban-card__chip--expired"
                : "kanban-card__chip--stale"
          }`}
          data-lease-state={lease.takenOver ? "taken-over" : lease.expired ? "expired" : "active"}
          data-testid="kanban-lease"
        >
          {lease.takenOver
            ? t("Taken over; original worker output kept as archive")
            : lease.expired
              ? t("Lease expired {time}", { time: lease.leaseExpiresAt })
              : t("Lease until {time}", { time: lease.leaseExpiresAt })}
        </span>
      ) : null}
      {signal === "off" ? (
        <span
          className="kanban-card__chip kanban-card__chip--muted"
          data-testid="kanban-activity-off"
        >
          {t("Silence alert off")}
        </span>
      ) : null}
      {signal === "unknown" ? (
        <span
          className="kanban-card__chip kanban-card__chip--muted"
          data-testid="kanban-activity-unknown"
        >
          {t("No activity signal")}
        </span>
      ) : null}
      {signal === "stale" ? (
        <span className="kanban-card__chip kanban-card__chip--stale" data-testid="kanban-stale">
          {t("Silent {minutes} min · threshold {threshold} min", {
            minutes: kanbanSilenceMinutes(card, now) ?? 0,
            threshold: card.activity?.silenceMinutes ?? 0,
          })}
        </span>
      ) : null}
    </>
  );
}

function KanbanDetail({
  card,
  onClose,
  onOpenPath,
}: {
  readonly card: KanbanCard;
  readonly onClose: () => void;
  readonly onOpenPath?: (path: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [command, setCommand] = useState<string | null>(null);
  const [commandKind, setCommandKind] = useState<"cancel" | "terminate" | null>(null);
  const [copied, setCopied] = useState(false);
  const budgetFields = cardBudgetFields(card.budget, t);
  const budgetUnknown = cardBudgetUnknownKeys(card.budget);
  const prepare = (kind: "cancel" | "terminate") => {
    setCopied(false);
    setCommandKind(kind);
    setCommand(kind === "cancel" ? buildCancelCommand(card) : buildTerminateCommand(card));
  };
  const copy = () => {
    if (command === null) return;
    navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      // 剪贴板不可用不报成功：指令仍留在只读文本框里，用户可手动复制。
      .catch(() => setCopied(false));
  };
  return (
    <aside className="kanban-detail" data-path={card.path} data-testid="kanban-detail">
      <header className="kanban-detail__header">
        <h2 className="kanban-detail__title">{t("Card details")}</h2>
        <button
          className="button button--ghost"
          data-testid="kanban-detail-close"
          type="button"
          onClick={onClose}
        >
          {t("Close")}
        </button>
      </header>

      <p className="kanban-detail__goal">{card.goal}</p>

      <dl className="kanban-detail__fields">
        <DetailField label={t("Status")} value={STATUS_LABELS[card.status]} />
        <DetailField label={t("Project")} value={card.project} />
        <DetailField label={t("Dept")} value={card.department} />
        <DetailField label={t("Card")} value={String(card.number)} />
        <DetailField label={t("Priority")} value={card.priority} />
        <DetailField label={t("Owner")} value={card.owner ?? t("None")} />
        <DetailField label={t("Tier")} value={card.tier ?? t("None")} />
        <DetailField label={t("Parent")} value={card.parent ?? t("None")} />
        <DetailField label={t("Attempts")} value={String(card.attempts)} />
        {budgetFields.length > 0 ? (
          budgetFields.map((field) => (
            <DetailField key={field.label} label={field.label} value={field.value} />
          ))
        ) : (
          <DetailField label={t("Budget")} value={t("None")} />
        )}
        {budgetUnknown ? (
          <div className="kanban-detail__field">
            <dt>{t("Other budget keys")}</dt>
            <dd>
              <details>
                <summary>{t("Show raw values")}</summary>
                <pre className="kanban-detail__raw">{JSON.stringify(budgetUnknown, null, 2)}</pre>
              </details>
            </dd>
          </div>
        ) : null}
        <DetailField label={t("Created")} value={card.created} />
        <DetailField label={t("Completed")} value={card.completed ?? t("None")} />
        <DetailField label={t("Path")} value={card.path} />
      </dl>

      <DetailProse empty={t("None")} label={t("Body")} text={card.body} />
      <DetailProse empty={t("None")} label={t("Acceptance")} text={card.acceptance} />
      {card.constraints ? (
        <DetailProse empty={t("None")} label={t("Constraints")} text={card.constraints} />
      ) : null}
      <DetailList empty={t("None")} items={card.inputs} label={t("Inputs")} />
      <DetailList empty={t("None")} items={card.dependencies} label={t("Dependencies")} />

      <h3 className="kanban-detail__section">{t("Receipt rounds")}</h3>
      {card.receipts.length === 0 ? (
        <p className="kanban-detail__note">{t("None")}</p>
      ) : (
        <ul className="kanban-detail__records" data-testid="kanban-detail-receipts">
          {card.receipts.map((receipt, index) => (
            <ReceiptRow
              key={textField(receipt, "attempt") ?? index}
              receipt={receipt}
              onOpenPath={onOpenPath}
            />
          ))}
        </ul>
      )}

      <h3 className="kanban-detail__section">{t("Executions")}</h3>
      {card.executions.length === 0 ? (
        <p className="kanban-detail__note">{t("None")}</p>
      ) : (
        <ul className="kanban-detail__records" data-testid="kanban-detail-executions">
          {card.executions.map((execution, index) => (
            <ExecutionRow
              execution={execution}
              key={textField(execution, "执行标识") ?? index}
              onOpenPath={onOpenPath}
            />
          ))}
        </ul>
      )}

      <h3 className="kanban-detail__section">{t("Worker activity")}</h3>
      {card.activity ? (
        <dl className="kanban-detail__fields" data-testid="kanban-detail-activity">
          <DetailField label={t("Owner")} value={card.activity.owner || t("None")} />
          <DetailField label={t("Execution")} value={card.activity.executionId || t("None")} />
          <DetailField label={t("Attempt")} value={String(card.activity.attempt)} />
          <DetailField
            label={t("Current attempt")}
            value={card.activity.current ? t("Current") : t("History")}
          />
          <DetailField
            label={t("Running")}
            value={card.activity.running ? t("Running") : t("Stopped")}
          />
          <DetailField
            label={t("Registered")}
            value={formatLocalMinute(card.activity.registeredAt)}
            title={card.activity.registeredAt}
          />
          <DetailField
            label={t("Last output")}
            value={
              card.activity.lastOutputAt ? formatLocalMinute(card.activity.lastOutputAt) : t("None")
            }
            title={card.activity.lastOutputAt}
          />
          <DetailField
            label={t("Silence threshold")}
            value={
              card.activity.silenceMinutes > 0
                ? t("{minutes} min", { minutes: card.activity.silenceMinutes })
                : t("Off")
            }
          />
          {/* S5 包3 租约四字段占位：旧登记没有＝「未知」，不编造；到期只报事实。 */}
          <DetailField
            label={t("Claim time")}
            value={card.activity.claimAt ? formatLocalMinute(card.activity.claimAt) : t("Unknown")}
            title={card.activity.claimAt}
          />
          <DetailField
            label={t("Lease expiry")}
            value={
              card.activity.leaseExpiresAt
                ? formatLocalMinute(card.activity.leaseExpiresAt)
                : t("Unknown")
            }
            title={card.activity.leaseExpiresAt}
          />
          <DetailField
            label={t("Claim generation")}
            value={
              card.activity.claimGeneration === undefined
                ? t("Unknown")
                : String(card.activity.claimGeneration)
            }
          />
          <DetailField
            label={t("Taken over")}
            value={
              card.activity.takenOver === undefined
                ? t("Unknown")
                : card.activity.takenOver
                  ? t("Yes")
                  : t("No")
            }
          />
        </dl>
      ) : (
        <p className="kanban-detail__note" data-testid="kanban-detail-activity-none">
          {t("No activity signal")}
        </p>
      )}

      <h3 className="kanban-detail__section">{t("Master actions (command only)")}</h3>
      <p className="kanban-detail__note">
        {t(
          "Review in the original master session, then run it. The board never changes card status and sends nothing.",
        )}
      </p>
      <div className="kanban-detail__actions">
        {canPrepareCancel(card) ? (
          <button
            className="button button--ghost"
            data-testid="kanban-prepare-cancel"
            type="button"
            onClick={() => prepare("cancel")}
          >
            {t("Prepare cancel request")}
          </button>
        ) : null}
        {canPrepareTerminate(card) ? (
          <button
            className="button button--ghost"
            data-testid="kanban-prepare-terminate"
            type="button"
            onClick={() => prepare("terminate")}
          >
            {t("Prepare terminate request")}
          </button>
        ) : null}
      </div>
      {command === null ? null : (
        <div className="kanban-detail__command">
          <p className="kanban-detail__note" data-testid="kanban-command-intent">
            {commandKind === "terminate"
              ? t(
                  "Intent: ask the master session to terminate the running worker of {card}, and only this card.",
                  {
                    card: formatCardNumber(card.number),
                  },
                )
              : t("Intent: ask the master session to cancel {card}, and only this card.", {
                  card: formatCardNumber(card.number),
                })}
          </p>
          <p className="kanban-detail__note" data-testid="kanban-command-scope">
            {t(
              "The board itself changes nothing; until the master session reports a real tool result, nothing is cancelled or terminated.",
            )}
          </p>
          <details open>
            <summary>{t("Technical parameters (expand to copy)")}</summary>
            <textarea
              className="kanban-detail__command-text"
              data-testid="kanban-command"
              readOnly
              rows={8}
              value={command}
            />
            <div className="kanban-detail__command-actions">
              <button
                className="button"
                data-testid="kanban-copy-command"
                type="button"
                onClick={copy}
              >
                {copied ? t("Copied") : t("Copy")}
              </button>
            </div>
          </details>
        </div>
      )}
    </aside>
  );
}

/** 预算分项：单位与内核 `CardBudget` 契约一致（turns/toolCalls/cost/collab_quota），未配置的项不显示、不填假 0。 */
function cardBudgetFields(
  budget: Readonly<Record<string, unknown>> | undefined,
  t: (key: string) => string,
): readonly { readonly label: string; readonly value: string }[] {
  if (!budget) return [];
  const fields: { label: string; value: string }[] = [];
  const push = (key: string, label: string) => {
    const raw = budget[key];
    if (raw === undefined || raw === null) return;
    fields.push({ label, value: String(raw) });
  };
  push("turns", t("Budget turns"));
  push("toolCalls", t("Budget tool calls"));
  push("cost", t("Budget cost"));
  push("collab_quota", t("Budget collaboration quota"));
  return fields;
}

/** 预算里不认识的键：不丢，收进可展开的原始值，不默认铺在普通详情里。 */
function cardBudgetUnknownKeys(
  budget: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!budget) return undefined;
  const known = new Set(["turns", "toolCalls", "cost", "collab_quota"]);
  const rest = Object.fromEntries(Object.entries(budget).filter(([key]) => !known.has(key)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function DetailField({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  /** 原始值（如 UTC ISO 时刻）挂在 title 上：给人看本地时间，原始值仍可查看。 */
  readonly title?: string;
}) {
  return (
    <div className="kanban-detail__field">
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </div>
  );
}

function DetailProse({
  empty,
  label,
  text,
}: {
  readonly empty: string;
  readonly label: string;
  readonly text: string;
}) {
  return (
    <>
      <h3 className="kanban-detail__section">{label}</h3>
      <p className="kanban-detail__prose">{text.trim() ? text : empty}</p>
    </>
  );
}

function DetailList({
  empty,
  items,
  label,
}: {
  readonly empty: string;
  readonly items: readonly string[];
  readonly label: string;
}) {
  return (
    <>
      <h3 className="kanban-detail__section">{label}</h3>
      {items.length === 0 ? (
        <p className="kanban-detail__note">{empty}</p>
      ) : (
        <ul className="kanban-detail__list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 回执行：卡面回执原样带出（结果/失败类型/摘要/证据/产物路径/用量），不推断结论。 */
function ReceiptRow({
  receipt,
  onOpenPath,
}: {
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly onOpenPath?: (path: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const parts: string[] = [];
  const attempt = textField(receipt, "attempt");
  if (attempt) parts.push(`${t("Attempt")} ${attempt}`);
  const time = textField(receipt, "time");
  if (time) parts.push(time);
  const result = textField(receipt, "result");
  if (result) parts.push(result);
  const failure = textField(receipt, "failure_type");
  if (failure) parts.push(`${t("Failure type")} ${failure}`);
  const archived = textField(receipt, "archive_flag");
  if (archived) parts.push(archived);
  const summary = textField(receipt, "summary");
  const evidence = listField(receipt, "evidence");
  const artifacts = listField(receipt, "artifact_path");
  const usage = usageParts(receipt, t);
  return (
    <li className="kanban-detail__record">
      <div className="kanban-detail__record-head">{parts.join(" · ")}</div>
      {summary ? <p className="kanban-detail__note">{summary}</p> : null}
      {/* 用量：worker 没自报（旧回执/手工回执）＝如实「未知」，不填 0 冒充。 */}
      <p className="kanban-detail__note" data-testid="kanban-receipt-usage">
        {usage.length > 0 ? `${t("Usage")} ${usage.join(" · ")}` : t("Usage unknown")}
      </p>
      <EvidenceLines lines={evidence} onOpenPath={onOpenPath} />
      <EvidenceLines lines={artifacts} onOpenPath={onOpenPath} />
    </li>
  );
}

/** 用量分项：Token 计数与费用分开、各带单位；不认识的扩展键原样留在同一行，不丢也不冒充已知。 */
const USAGE_TOKEN_KEYS: readonly (readonly [string, string])[] = [
  ["input", "Usage input tokens"],
  ["output", "Usage output tokens"],
  ["cacheRead", "Usage cache read tokens"],
  ["cacheWrite", "Usage cache write tokens"],
];
const USAGE_KNOWN_KEYS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "turns",
  "cost",
]);

function usageParts(
  receipt: Readonly<Record<string, unknown>>,
  t: (key: string) => string,
): string[] {
  const value = receipt["usage"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const usage = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, label] of USAGE_TOKEN_KEYS) {
    const raw = usage[key];
    if (typeof raw === "number") parts.push(`${t(label)} ${raw}`);
  }
  if (typeof usage["totalTokens"] === "number") {
    parts.push(`${t("Usage total tokens")} ${usage["totalTokens"]}`);
  }
  if (typeof usage["turns"] === "number") parts.push(`${t("Usage turns")} ${usage["turns"]}`);
  if (typeof usage["cost"] === "number") parts.push(`${t("Usage cost")} ${usage["cost"]}`);
  // 部分记录：接口有轮次没回 usage 时如实说明这是下界，不把缺口当 0。
  const missing = receipt["missing_usage_rounds"];
  if (typeof missing === "number" && missing > 0) {
    parts.push(t("Usage missing rounds").replace("{rounds}", String(missing)));
  }
  // 扩展键：原样保留，不因不认识就丢掉。
  for (const [key, entry] of Object.entries(usage)) {
    if (USAGE_KNOWN_KEYS.has(key)) continue;
    if (typeof entry === "number" || typeof entry === "string" || typeof entry === "boolean") {
      parts.push(`${key} ${entry}`);
    }
  }
  return parts;
}

/** 执行映射行：执行标识＋尝试/状态/时间＋当前或历史，映射与会话路径原样列出。 */
function ExecutionRow({
  execution,
  onOpenPath,
}: {
  readonly execution: Readonly<Record<string, unknown>>;
  readonly onOpenPath?: (path: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const parts: string[] = [];
  const attempt = textField(execution, "尝试");
  if (attempt) parts.push(`${t("Attempt")} ${attempt}`);
  const status = textField(execution, "状态");
  if (status) parts.push(status);
  const time = textField(execution, "时间");
  if (time) parts.push(time);
  parts.push(flagField(execution, "当前尝试") ? t("Current") : t("History"));
  const mapping = textField(execution, "映射路径");
  const session = textField(execution, "会话路径");
  return (
    <li className="kanban-detail__record">
      <div className="kanban-detail__record-head">
        <span className="kanban-detail__record-id">
          {textField(execution, "执行标识") ?? t("None")}
        </span>
        <span>{parts.join(" · ")}</span>
      </div>
      {mapping ? <p className="kanban-detail__note">{mapping}</p> : null}
      {session ? (
        <ul className="kanban-detail__evidence">
          <PathLine line={session} onOpenPath={onOpenPath} />
        </ul>
      ) : null}
    </li>
  );
}

/**
 * 证据/产物/会话路径行：文本原样＋可选「定位」按钮。
 * 导航走主进程复核通道；失败（路径不存在/越出工作区/自由文本）显式报错，不静默成功。
 */
function PathLine({
  line,
  onOpenPath,
}: {
  readonly line: string;
  readonly onOpenPath?: (path: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const reveal = () => {
    if (!onOpenPath) return;
    setError(null);
    onOpenPath(line).catch((cause: unknown) => {
      setError(
        `${t("Could not reveal the path.")} ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  };
  return (
    <li className="kanban-evidence-line" data-testid="kanban-evidence-line">
      <span>{line}</span>
      {onOpenPath ? (
        <button
          className="kanban-evidence-reveal"
          data-testid="kanban-reveal-path"
          type="button"
          onClick={reveal}
        >
          {t("Reveal")}
        </button>
      ) : null}
      {error ? (
        <span className="kanban-evidence-error" role="alert" data-testid="kanban-reveal-error">
          {error}
        </span>
      ) : null}
    </li>
  );
}

function EvidenceLines({
  lines,
  onOpenPath,
}: {
  readonly lines: readonly string[];
  readonly onOpenPath?: (path: string) => Promise<void>;
}) {
  if (lines.length === 0) return null;
  return (
    <ul className="kanban-detail__evidence">
      {lines.map((line) => (
        <PathLine key={line} line={line} onOpenPath={onOpenPath} />
      ))}
    </ul>
  );
}

function textField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function listField(record: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  const items = value as readonly unknown[];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

function flagField(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return record[key] === true;
}

function uniqueSorted(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort();
}

/** 项目根路径太长，卡面只显示末段；完整路径在详情与筛选下拉里。 */
function projectShort(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

interface Filters {
  readonly search: string;
  readonly project: string;
  readonly department: string;
}

function cardMatches(card: KanbanCard, filters: Filters): boolean {
  if (filters.project && card.project !== filters.project) return false;
  if (filters.department && card.department !== filters.department) return false;
  const needle = filters.search.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    card.goal,
    card.body,
    card.acceptance,
    card.constraints ?? "",
    card.path,
    card.project,
    card.department,
    card.owner ?? "",
    card.parent ?? "",
    String(card.number),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

function groupByStatus(cards: readonly KanbanCard[]): Map<KanbanCardStatus, KanbanCard[]> {
  const map = new Map<KanbanCardStatus, KanbanCard[]>();
  for (const status of COLUMN_ORDER) map.set(status, []);
  for (const card of cards) {
    const bucket = map.get(card.status);
    if (bucket) bucket.push(card);
  }
  return map;
}

/**
 * 工作流节点全卡查看（S7 条 2 路径 b）：消费已送达的 节点→卡号 映射，
 * 卡号在节点自己的卡目录内联接（与项目 .pao/卡 同号不冲突）；
 * 映射里有号但卡读不到＝显式「缺卡」，不静默跳过。点卡开与列区同一份详情。
 */
function KanbanWorkflows({
  cards,
  workflows,
  onSelect,
}: {
  readonly cards: readonly KanbanCard[];
  readonly workflows: readonly KanbanWorkflow[];
  readonly onSelect: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="kanban-workflows" data-testid="kanban-workflows">
      <h2 className="kanban-detail__section">{t("Workflow nodes")}</h2>
      {workflows.map((flow) => (
        <div className="kanban-workflow" data-testid="kanban-workflow" key={flow.path}>
          <p className="kanban-workflow__head">
            <strong>{flow.instance}</strong>
            <span>{flow.workflow}</span>
            <span>{flow.status}</span>
            <span className="kanban-card__project" title={flow.path}>
              {projectShort(flow.project)}
            </span>
          </p>
          <ul className="kanban-workflow__nodes">
            {flow.nodes.map((node) => (
              <li className="kanban-workflow__node" key={node.name}>
                <span className="kanban-workflow__node-name">{node.name}</span>
                <span className="kanban-workflow__node-round">
                  {t("Round {round}", { round: node.round })}
                </span>
                {node.cardRefs.map((ref) => {
                  const card = findNodeCard(cards, node.cardsDir, ref);
                  return card ? (
                    <button
                      className="kanban-workflow__card"
                      data-path={card.path}
                      data-testid="kanban-workflow-card"
                      key={ref}
                      type="button"
                      onClick={() => onSelect(card.path)}
                    >
                      {ref} {card.goal} · {STATUS_LABELS[card.status]}
                    </button>
                  ) : (
                    <span
                      className="kanban-workflow__card kanban-workflow__card--missing"
                      data-testid="kanban-workflow-card-missing"
                      key={ref}
                    >
                      {ref} · {t("Card missing")}
                    </span>
                  );
                })}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** 卡目录比较：分隔符归一＋大小写不敏感（Windows 路径格式/大小写不保证一致）。 */
function sameDir(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .replace(/[\\/]+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

function dirName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  parts.pop();
  return parts.join("/");
}

function findNodeCard(
  cards: readonly KanbanCard[],
  cardsDir: string,
  ref: string,
): KanbanCard | undefined {
  const number = cardRefNumber(ref);
  if (number === undefined) return undefined;
  return cards.find((card) => card.number === number && sameDir(dirName(card.path), cardsDir));
}
