import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NARROW_VIEWPORT_WIDTH, useNarrowViewport } from "../../ui/narrow-viewport";

/** 窗口级偏好；undefined 表示用户从未手动选择。 */
export const TASK_STATUS_COLLAPSED_STORAGE_KEY = "pi-gui.task-status-collapsed";

function readCollapsed(): boolean | undefined {
  try {
    const value = globalThis.localStorage?.getItem(TASK_STATUS_COLLAPSED_STORAGE_KEY);
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

function writeCollapsed(next: boolean): void {
  try {
    globalThis.localStorage?.setItem(TASK_STATUS_COLLAPSED_STORAGE_KEY, String(next));
  } catch {
    // 记不住偏好时布局照样可用。
  }
}

/**
 * 根据手动偏好、窄窗和当前空间计算是否显示短条。
 *
 * 窄窗或侧栏挤压期间的手动展开只覆盖“这一次约束”。约束解除后清掉临时覆盖，
 * 后续再进入约束仍会自动收起；自动收起从不写偏好。
 */
export function taskStatusCollapseState(input: {
  readonly narrow: boolean;
  readonly availableWidth: number | undefined;
  readonly toolsOpen: boolean;
  readonly toolsWidth: number;
  readonly preference: boolean | undefined;
  readonly expandedDuringConstraint: boolean;
}): {
  readonly constrained: boolean;
  readonly collapsed: boolean;
  readonly nextExpandedDuringConstraint: boolean;
} {
  const constrainedBySpace =
    input.availableWidth !== undefined &&
    input.toolsOpen &&
    input.availableWidth - (input.toolsOpen ? input.toolsWidth : 0) <
      sidePanelBudget.overview + sidePanelBudget.minimumMain;
  const constrained = input.narrow || constrainedBySpace;
  return {
    constrained,
    collapsed: constrained ? !input.expandedDuringConstraint : input.preference === true,
    nextExpandedDuringConstraint: constrained && input.expandedDuringConstraint,
  };
}

/**
 * 右上概况的收起态。显示状态由手动偏好与临时空间条件共同决定：
 *
 * - 用户手动收起或展开会保存为窗口级偏好。
 * - 无手动偏好时，980px 以下默认显示短条。
 * - 主区不足以同时容纳正文与工具面板时显示短条，但当时的手动展开仍有效。
 * - 空间或窗口宽度恢复后，按保存的手动偏好恢复；自动收起从不写偏好。
 */
export function useTaskStatusDockCollapse(layout: {
  readonly toolsOpen: boolean;
  readonly toolsWidth: number;
}) {
  const narrow = useNarrowViewport();
  const [collapsedByUser, setCollapsedByUser] = useState<boolean | undefined>(readCollapsed);
  const [expandedDuringConstraint, setExpandedDuringConstraint] = useState(false);
  const [availableWidth, setAvailableWidth] = useState<number>();
  const [measuredToolsWidth, setMeasuredToolsWidth] = useState<number>();
  const initializedConstraint = useRef(false);
  const previousConstrained = useRef<boolean | undefined>(undefined);
  const dockRef = useRef<HTMLElement | null>(null);

  const collapse = useCallback(() => {
    setCollapsedByUser(true);
    setExpandedDuringConstraint(false);
    writeCollapsed(true);
  }, []);

  const expand = useCallback(() => {
    setCollapsedByUser(false);
    setExpandedDuringConstraint(true);
    writeCollapsed(false);
  }, []);

  const measure = useCallback(() => {
    const parent = dockRef.current?.closest(".main");
    if (!(parent instanceof HTMLElement)) return;
    setAvailableWidth(parent.clientWidth);
    const tools = parent.querySelector(":scope > .task-status-workbench-host");
    setMeasuredToolsWidth(
      tools instanceof HTMLElement && tools.offsetParent !== null ? tools.clientWidth : 0,
    );
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const parent = dockRef.current?.closest(".main");
    if (!(parent instanceof HTMLElement)) return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    const tools = parent.querySelector(":scope > .task-status-workbench-host");
    if (tools instanceof HTMLElement) observer.observe(tools);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const state = taskStatusCollapseState({
    narrow,
    availableWidth,
    toolsOpen: layout.toolsOpen,
    toolsWidth: measuredToolsWidth ?? layout.toolsWidth,
    preference: collapsedByUser,
    expandedDuringConstraint,
  });

  useEffect(() => {
    // 带着“手动展开”偏好启动时，当前约束内仍按偏好展开；只有之后进入新约束才自动收起。
    if (!initializedConstraint.current && availableWidth !== undefined) {
      initializedConstraint.current = true;
      if (state.constrained && collapsedByUser === false) setExpandedDuringConstraint(true);
      previousConstrained.current = state.constrained;
      return;
    }
    if (previousConstrained.current !== state.constrained) {
      previousConstrained.current = state.constrained;
      if (expandedDuringConstraint) setExpandedDuringConstraint(false);
    }
  }, [availableWidth, collapsedByUser, expandedDuringConstraint, state.constrained]);

  return {
    collapsed: state.collapsed,
    collapse,
    expand,
    dockRef,
    constrained: state.constrained,
    collapsedByUser,
    availableWidth,
  } as const;
}

/**
 * 概况列实际占用面板宽和它前方的列间距；再加正文最小宽 320px 才是空间下限。
 * CSS 的概况列总宽为 320 + 24px，因此同时显示至少需要 664px。
 */
export const sidePanelBudget = {
  overview: 320 + 24,
  minimumMain: 320,
  narrowViewport: NARROW_VIEWPORT_WIDTH,
} as const;
