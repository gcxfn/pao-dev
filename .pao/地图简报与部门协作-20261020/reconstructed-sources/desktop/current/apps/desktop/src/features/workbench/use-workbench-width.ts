import type { CSSProperties } from "react";
import { usePersistedPaneWidth } from "../../ui/use-persisted-pane-width";

/** A window layout preference shared by all tools and tasks, independent of their contents. */
export function useWorkbenchWidth() {
  const [width, setWidth] = usePersistedPaneWidth("pi-gui.workbench-width", {
    min: 320,
    max: 1200,
  });
  const style: CSSProperties & { "--workbench-width": string } = {
    "--workbench-width": `${width ?? 360}px`,
  };
  return { style, setWidth };
}

/** 当前保存的工作台宽度；没有偏好时使用界面默认 360px。 */
export function workbenchWidthPixels(style: CSSProperties): number {
  const value = style["--workbench-width" as keyof CSSProperties];
  if (typeof value !== "string") return 360;
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) ? pixels : 360;
}
