/** 仅保存画布查看偏好，不写入工作流配方或实例清单。 */
export interface CanvasViewPreference {
  libraryCollapsed?: boolean;
  detailOpen?: boolean;
  mode?: "overview" | "detail";
  expandedGroups?: string[];
  viewports?: Partial<Record<"overview" | "detail", { x: number; y: number; zoom: number }>>;
}

export function readCanvasViewPreference(key: string | undefined): CanvasViewPreference {
  if (!key || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const saved = JSON.parse(raw) as CanvasViewPreference;
    if (!saved || typeof saved !== "object") return {};
    const viewports: CanvasViewPreference["viewports"] = {};
    for (const mode of ["overview", "detail"] as const) {
      const viewport = saved.viewports?.[mode];
      if (
        viewport &&
        [viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) &&
        viewport.zoom >= 0.1 &&
        viewport.zoom <= 3
      )
        viewports[mode] = viewport;
    }
    return {
      libraryCollapsed: saved.libraryCollapsed === true,
      detailOpen: saved.detailOpen !== false,
      mode: saved.mode === "detail" ? "detail" : "overview",
      expandedGroups: Array.isArray(saved.expandedGroups)
        ? saved.expandedGroups.filter((id) => typeof id === "string")
        : [],
      viewports,
    };
  } catch (error) {
    console.warn("画布偏好读取失败，使用默认视图", error);
    return {};
  }
}

export function saveCanvasViewPreference(
  key: string | undefined,
  preference: CanvasViewPreference,
): void {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(preference));
  } catch (error) {
    console.warn("画布偏好保存失败，本次查看仍可继续", error);
  }
}
