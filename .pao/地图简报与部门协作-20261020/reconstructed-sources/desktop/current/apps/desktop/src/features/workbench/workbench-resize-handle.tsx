import { PaneResizeHandle, type PaneWidthBounds } from "../../ui/pane-resize-handle";
import { NARROW_VIEWPORT_WIDTH } from "../../ui/narrow-viewport";

/**
 * 工作台上限按 `.main` 容器的 55% 算，与 task-status 布局的工具列约束一致。
 *
 * 窄窗手动三列时工具列由 CSS 的 33% 分配，面板实际宽度是唯一真值；手柄读取当前盒宽并
 * 固定在该值，保持不能拖，同时不让键盘或拖拽把偏好写成看不见的宽度。
 */
function workbenchBounds(panel: HTMLElement, container: HTMLElement): PaneWidthBounds {
  if (window.innerWidth <= NARROW_VIEWPORT_WIDTH) {
    const width = Math.round(panel.getBoundingClientRect().width);
    return { min: width, max: width };
  }
  const layout = container.closest(".main") ?? container;
  const max = Math.floor(Math.min(1200, layout.clientWidth * 0.55));
  return { min: 320, max };
}

export function WorkbenchResizeHandle({
  onResize,
}: {
  readonly onResize: (width: number) => void;
}) {
  return (
    <PaneResizeHandle
      className="workbench__resize-handle"
      label="Side panel width"
      controls="task-workbench"
      edge="left"
      bounds={workbenchBounds}
      onResize={onResize}
    />
  );
}
