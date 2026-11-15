import { useState } from "react";
import type { DesktopAppState, SessionRecord } from "../../contracts/desktop-state";
import { useI18n } from "../i18n/react";

/**
 * 侧栏首屏摘要（计划 §7.3「侧栏首屏突出进度、待办、最新成果，日志按需展开」）。
 *
 * 只报**当前快照里真实存在**的东西，不推测、不凑数：
 * - 进度：正在跑的会话数直接数 `SessionRecord.status === "running"`。
 * - 待办：不在跑却有未读更新的会话算「等你确认」；`status === "failed"` 单独列，不当成功也不藏。
 * - 最新成果：按 `lastInteractedAt ?? updatedAt` 取最新的那条会话，标题直接取会话标题。
 * - 日志：默认收起，点开才渲染明细；纯快照推导，不写盘、不发请求。
 *
 * 这里不读画布/工作流的步骤与卡片：那些数据要按项目经主控接口取，侧栏不嵌完整主页面，
 * 也不该为了一个摘要另开数据通道（计划 §7.3 / §5.2 第 8 条）。
 */
export interface SidebarSummaryModel {
  readonly runningCount: number;
  readonly unseenCount: number;
  /**
   * 提示性计数：快照能给的最接近口径（不在跑但有未读更新的会话数），**不是契约真值**。
   * 真待确认数以步骤卡的人工门为准，精确值需在快照契约补字段；不要用它做门禁判断。
   */
  readonly needsConfirmationCount: number;
  readonly failedCount: number;
  readonly latest: SessionRecord | undefined;
}

/**
 * 从快照与会话列表推导首屏摘要。
 * `sessions` 传侧栏已算好的非归档会话，避免为了摘要再遍历一遍全量状态。
 */
export function buildSidebarSummary(
  state: DesktopAppState | null,
  sessions: readonly SessionRecord[],
): SidebarSummaryModel {
  // 没有快照就没有事实可报，返回全零，界面据此不显示摘要（而不是显示一排 0 冒充有数据）。
  if (!state || sessions.length === 0) {
    return {
      runningCount: 0,
      unseenCount: 0,
      needsConfirmationCount: 0,
      failedCount: 0,
      latest: undefined,
    };
  }
  let runningCount = 0;
  let unseenCount = 0;
  let needsConfirmationCount = 0;
  let failedCount = 0;
  let latest: SessionRecord | undefined;
  let latestAt = "";
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    if (session.status === "running") {
      runningCount += 1;
    }
    if (session.hasUnseenUpdate) {
      unseenCount += 1;
      // 不在跑却有未读：这一条在等你看，归到「等你确认」，不冒充成还在执行。
      //
      // 注意：`hasUnseenUpdate && status !== "running"` 是**快照能给的最接近口径，不是契约真值**。
      // 真正的「待人工确认」以步骤卡的人工门为准（哪张卡在等哪个门、等谁批），快照里没有这个字段。
      // 所以这里的数字只能用来提示「有东西在等你」，不能当权威计数引用，也不据此做任何门禁判断。
      // 将来若要精确值，需要在桌面快照契约里补待确认字段，再改这里读真实值；
      // 契约是否有现成可用字段以 D3 的核查结论为准，在它回报前**不要**改动契约。
      if (session.status !== "running") needsConfirmationCount += 1;
    }
    if (session.status === "failed") {
      failedCount += 1;
    }
    const at = session.lastInteractedAt ?? session.updatedAt;
    if (at && at > latestAt) {
      latestAt = at;
      latest = session;
    }
  }
  return { runningCount, unseenCount, needsConfirmationCount, failedCount, latest };
}

export interface SidebarSummaryProps {
  readonly summary: SidebarSummaryModel;
  readonly onSelectSession?: (session: SessionRecord) => void;
}

/**
 * 首屏摘要：三个数字 + 一条最新成果；明细日志默认收起。
 * 数字为 0 的项照实显示，不隐藏——「这里没有」也是要报的事实。
 */
export function SidebarSummary({ summary, onSelectSession }: SidebarSummaryProps) {
  const { t } = useI18n();
  const [logOpen, setLogOpen] = useState(false);
  const hasActivity =
    summary.runningCount > 0 ||
    summary.unseenCount > 0 ||
    summary.failedCount > 0 ||
    summary.latest !== undefined;
  if (!hasActivity) {
    return null;
  }
  const latest = summary.latest;
  return (
    <div className="sidebar__summary" data-testid="sidebar-summary">
      <div className="sidebar__summary-head">{t("Progress")}</div>
      <div className="sidebar__summary-figures" role="list">
        <div className="sidebar__summary-figure" role="listitem" data-testid="sidebar-summary-running">
          <span className="sidebar__summary-value">{summary.runningCount}</span>
          <span className="sidebar__summary-label">{t("Running")}</span>
        </div>
        <div
          className="sidebar__summary-figure"
          role="listitem"
          data-testid="sidebar-summary-waiting"
        >
          <span className="sidebar__summary-value">{summary.needsConfirmationCount}</span>
          <span className="sidebar__summary-label">{t("Needs your confirmation")}</span>
        </div>
        <div className="sidebar__summary-figure" role="listitem" data-testid="sidebar-summary-failed">
          <span className="sidebar__summary-value">{summary.failedCount}</span>
          <span className="sidebar__summary-label">{t("Failed")}</span>
        </div>
      </div>
      {latest ? (
        <button
          className="sidebar__summary-latest"
          type="button"
          data-testid="sidebar-summary-latest"
          onClick={() => onSelectSession?.(latest)}
        >
          <span className="sidebar__summary-label">{t("Latest result")}</span>
          <span className="sidebar__summary-latest-title">{latest.title}</span>
        </button>
      ) : null}
      <button
        aria-expanded={logOpen}
        className="sidebar__summary-toggle"
        type="button"
        data-testid="sidebar-summary-log-toggle"
        onClick={() => setLogOpen((open) => !open)}
      >
        {logOpen ? t("Hide detail") : t("Show detail")}
      </button>
      {logOpen ? (
        <ul className="sidebar__summary-log" data-testid="sidebar-summary-log">
          <li>
            {t("Running")}: {summary.runningCount}
          </li>
          <li>
            {t("Unread updates")}: {summary.unseenCount}
          </li>
          <li>
            {t("Needs your confirmation")}: {summary.needsConfirmationCount}
          </li>
          <li>
            {t("Failed")}: {summary.failedCount}
          </li>
        </ul>
      ) : null}
    </div>
  );
}
