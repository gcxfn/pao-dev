/**
 * 配方库（工作流重构阶段 2）：左侧面板，筛选 全部／我的／模板／最近。
 *
 * 数据全部来自只读快照与目录，不额外编造作者、来源或最后访问时间：
 * - 全部＝配方＋实例（沿用旧 CanvasListPanel 的只读列表、错误行与异常行）；
 * - 我的＝快照里的配方条目（就是用户工作流目录里已保存的配方）；
 * - 模板＝目录里的真实起步模板，安装走 onInstallTemplate 回调；
 * - 最近＝当前项目仍存在的已打开工作流标签，当前标签优先。
 *
 * 组件不发起任何 API 调用：选中与安装都交给父层回调。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { CanvasSnapshot } from "../../../contracts/canvas";
import type { WorkflowTabRecord } from "../../../contracts/desktop-state";
import type { WorkflowCatalogSnapshot } from "../../../contracts/workflow-wizard";
import type { CanvasSelection } from "./canvas-page";
import { instanceFailedNodes } from "./canvas-model";

/** 配方库筛选页签。 */
export type RecipeLibraryFilter = "all" | "mine" | "templates" | "recent";

/**
 * 配方库行右键菜单：「删除工作流」交父层处理——守卫链（requestAction）、确认弹窗（内核
 * ui.confirm，含 .bak 与冻结运行记录说明）与关闭标签都在父层接线；「在新标签中打开」
 * （S4-1⑤）走同标签表整表写，同配方多标签各自独立（不共享主控）。
 */
export function RecipeRowContextMenu({
  name,
  onRemove,
  onClose,
  onOpenInNewTab,
}: {
  readonly name: string;
  readonly onRemove: () => void;
  readonly onClose: () => void;
  /** 提供时显示「在新标签中打开」；未提供（如受控组件测试）不显示。 */
  readonly onOpenInNewTab?: (name: string) => void;
}) {
  return (
    <div
      className="canvas-context-menu"
      data-testid="recipe-row-context-menu"
      role="menu"
      aria-label={`${name} 操作`}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {onOpenInNewTab ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onOpenInNewTab(name);
            onClose();
          }}
        >
          在新标签中打开
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRemove();
          onClose();
        }}
      >
        删除工作流
      </button>
    </div>
  );
}

const FILTERS: readonly { readonly id: RecipeLibraryFilter; readonly label: string }[] = [
  { id: "all", label: "全部" },
  { id: "mine", label: "我的" },
  { id: "templates", label: "模板" },
  { id: "recent", label: "最近" },
];

export interface RecipeLibraryProps {
  readonly snapshot: CanvasSnapshot;
  /** 目录快照（起步模板来源）；未加载时模板页提示不可用。 */
  readonly catalog?: WorkflowCatalogSnapshot;
  /** 当前项目的工作流标签（最近页数据源）。 */
  readonly projectTabs: readonly WorkflowTabRecord[];
  /** 当前激活标签；最近页把它排在最前。 */
  readonly activeTab?: WorkflowTabRecord;
  /** 当前选中项，用于高亮（可选）。 */
  readonly selection?: CanvasSelection | null;
  readonly onSelect: (selection: CanvasSelection) => void;
  /** 安装起步模板；父层负责调用 installWorkflowTemplate 与既有确认。 */
  readonly onInstallTemplate: (templateId: string, templateName?: string) => void;
  /** 删除配方（S3-3）；父层负责守卫、确认与成功后的刷新/关标签。 */
  readonly onDeleteRecipe?: (name: string) => void;
  /** 「在新标签中打开」（S4-1⑤）；父层负责守卫与标签表写入。 */
  readonly onOpenInNewTab?: (name: string) => void;
  readonly onCollapse?: () => void;
  /** 主控会话已建立＝true；false 时模板安装禁用并提示。 */
  readonly canInstallTemplate?: boolean;
  /** 安装／刷新进行中，禁用交互。 */
  readonly busy?: boolean;
  /** 初始筛选页签（缺省「全部」）；用于深链或组件测试。 */
  readonly initialFilter?: RecipeLibraryFilter;
}

export function RecipeLibrary({
  snapshot,
  catalog,
  projectTabs,
  activeTab,
  selection,
  onSelect,
  onInstallTemplate,
  onDeleteRecipe,
  onOpenInNewTab,
  onCollapse,
  canInstallTemplate = true,
  busy = false,
  initialFilter = "all",
}: RecipeLibraryProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RecipeLibraryFilter>(initialFilter);
  const [rowMenu, setRowMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLElement>(null);
  // 点菜单外任意处关闭行菜单（菜单自身 mousedown 已 stopPropagation）。
  useEffect(() => {
    if (!rowMenu) return;
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
    function close() {
      setRowMenu(null);
    }
  }, [rowMenu]);
  const openRowMenu = (event: ReactMouseEvent, name: string) => {
    event.preventDefault();
    openRowMenuAt(name, event.clientX, event.clientY);
  };
  const openRowMenuAt = (name: string, clientX: number, clientY: number) => {
    const rect = listRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const menuWidth = 220;
    const menuHeight = 90;
    setRowMenu({
      name,
      x: Math.max(8, Math.min(clientX - (rect?.left ?? 0), Math.max(8, width - menuWidth - 8))),
      y: Math.max(8, Math.min(clientY - (rect?.top ?? 0), Math.max(8, height - menuHeight - 8))),
    });
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (...texts: readonly string[]): boolean =>
    texts.some((text) => text.toLocaleLowerCase().includes(normalizedQuery));

  const recipes = snapshot.recipes.filter((entry) =>
    matches(
      entry.name,
      ...(entry.available ? entry.recipe.nodes.flatMap((node) => [node.name, node.dept]) : []),
    ),
  );
  const instances = snapshot.instances.filter((instance) =>
    matches(instance.name, instance.workflow),
  );
  const templates = (catalog?.templates ?? []).filter((template) =>
    matches(template.name, template.description),
  );
  const recent = useMemo(() => {
    const rows = projectTabs.flatMap(
      (tab): { readonly tab: WorkflowTabRecord; readonly selection: CanvasSelection }[] => {
        if (tab.instanceName) {
          const matches = snapshot.instances.filter((row) =>
            tab.instancePath ? row.path === tab.instancePath : row.name === tab.instanceName,
          );
          const instance = matches.length === 1 ? matches[0] : undefined;
          if (instance) {
            return [
              { tab, selection: { kind: "instance", name: instance.name, path: instance.path } },
            ];
          }
        }
        if (tab.recipeName) {
          const recipe = snapshot.recipes.find((row) => row.name === tab.recipeName);
          if (recipe) return [{ tab, selection: { kind: "recipe", name: recipe.name } }];
        }
        return [];
      },
    );
    const activeId = activeTab?.id;
    return rows.sort((a, b) => (a.tab.id === activeId ? -1 : b.tab.id === activeId ? 1 : 0));
  }, [projectTabs, activeTab, snapshot]);
  const recentVisible = recent.filter((row) => matches(row.selection.name));

  const renderRecipeRows = () =>
    recipes.length === 0 ? (
      <p className="canvas-empty">暂无工作流</p>
    ) : (
      <ul className="canvas-rows">
        {recipes.map((entry) =>
          entry.available ? (
            <li className="canvas-row-item" key={entry.name}>
              <button
                className={`canvas-row${isSelected(selection, "recipe", entry.name) ? " canvas-row--active" : ""}`}
                type="button"
                data-testid="canvas-recipe-row"
                onClick={() => onSelect({ kind: "recipe", name: entry.name })}
                onContextMenu={(event) => openRowMenu(event, entry.name)}
              >
                <strong>{entry.name}</strong>
                <span className="canvas-row__meta">
                  版本 {entry.recipe.version} · {entry.recipe.nodes.length} 个节点
                  {entry.recipe.autoExecute ? " · 自动执行" : ""}
                </span>
              </button>
              <button
                type="button"
                className="canvas-row__more"
                aria-label={`${entry.name} 更多操作`}
                data-testid="canvas-recipe-more"
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  openRowMenuAt(entry.name, rect.right, rect.bottom);
                }}
              >
                ⋯
              </button>
            </li>
          ) : (
            <li
              className="canvas-row canvas-row--bad"
              data-testid="canvas-recipe-error"
              key={entry.name}
            >
              <strong>{entry.name}</strong>
              <span className="canvas-row__meta canvas-row__meta--error">
                工作流校验失败 · {entry.error.code}
              </span>
              <span className="canvas-row__meta">{entry.error.detail}</span>
            </li>
          ),
        )}
      </ul>
    );

  const renderInstanceRows = () =>
    instances.length === 0 ? (
      <p className="canvas-empty">暂无运行记录</p>
    ) : (
      <ul className="canvas-rows">
        {instances.map((instance) => {
          // 实例失败要可见（S6-D1）：实例级状态不点名失败，行上点名失败节点数，不静默。
          const failed = instanceFailedNodes(instance);
          return (
            <li key={instance.path}>
              <button
                className={`canvas-row${isSelected(selection, "instance", instance.name, instance.path) ? " canvas-row--active" : ""}`}
                type="button"
                data-testid="canvas-instance-row"
                data-instance-path={instance.path}
                data-failed={failed.length > 0 ? "true" : undefined}
                onClick={() =>
                  onSelect({ kind: "instance", name: instance.name, path: instance.path })
                }
              >
                <strong>{instance.name}</strong>
                {/* 在途 badge（波3 §2c）：会话列表数据面无工作流关联，降级为实例行点名。 */}
                {instance.status === "运行中" ? (
                  <span
                    className="canvas-row__running-badge"
                    data-testid="canvas-instance-running-badge"
                  >
                    工作流运行中
                  </span>
                ) : null}
                <span className="canvas-row__meta">
                  {instance.workflow} · {instance.status} · {instance.startedAt}
                </span>
                {failed.length > 0 ? (
                  <span className="canvas-row__meta canvas-row__meta--error">
                    失败节点 {failed.length} 个（{failed.join("、")}）
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    );

  const renderTemplates = () => {
    if (!catalog) return <p className="canvas-empty">模板目录不可用。</p>;
    return (
      <>
        {!canInstallTemplate ? (
          <p className="canvas-status" data-testid="recipe-library-template-hint">
            安装模板需要先建立主控会话，请先打开一个主控会话。
          </p>
        ) : null}
        {templates.length === 0 ? (
          <p className="canvas-empty">暂无起步模板</p>
        ) : (
          <ul className="canvas-rows">
            {templates.map((template) => (
              <li key={template.id}>
                <button
                  className="canvas-row"
                  type="button"
                  data-testid="recipe-library-template-row"
                  disabled={busy || !canInstallTemplate}
                  onClick={() => onInstallTemplate(template.id, template.name)}
                >
                  <strong>{template.name}</strong>
                  <span className="canvas-row__meta">{template.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  };

  const renderRecent = () => (
    <>
      <p className="canvas-status" data-testid="recipe-library-recent-note">
        已打开的标签，当前标签优先。
      </p>
      {recentVisible.length === 0 ? (
        <p className="canvas-empty">暂无已打开的标签</p>
      ) : (
        <ul className="canvas-rows">
          {recentVisible.map(({ tab, selection: row }) => (
            <li key={tab.id}>
              <button
                className={`canvas-row${isSelected(selection, row.kind, row.name, row.path) ? " canvas-row--active" : ""}`}
                type="button"
                data-testid={row.kind === "instance" ? "canvas-instance-row" : "canvas-recipe-row"}
                data-instance-path={row.kind === "instance" ? row.path : undefined}
                onClick={() => onSelect(row)}
              >
                <strong>{tab.title}</strong>
                <span className="canvas-row__meta">
                  {row.kind === "instance" ? "运行记录" : "工作流"} · {row.name}
                  {tab.id === activeTab?.id ? " · 当前标签" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  return (
    <aside className="canvas-list" data-testid="canvas-list" ref={listRef}>
      <div className="canvas-library-heading">
        <h2 className="canvas-panel__title">工作流库</h2>
        {onCollapse ? (
          <button className="button" type="button" aria-label="折叠工作流库" onClick={onCollapse}>
            ‹
          </button>
        ) : null}
      </div>
      <input
        className="canvas-search"
        aria-label="搜索工作流、节点或部门"
        placeholder="搜索工作流、节点或部门…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="recipe-library__filters" role="tablist" aria-label="工作流库筛选">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={`recipe-library__filter${filter === id ? " recipe-library__filter--active" : ""}`}
            data-testid={`recipe-library-filter-${id}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {filter === "all" ? (
        <>
          <h2 className="canvas-panel__title">工作流</h2>
          {renderRecipeRows()}
          <h2 className="canvas-panel__title">运行记录</h2>
          {renderInstanceRows()}
        </>
      ) : null}
      {filter === "mine" ? (
        <>
          <h2 className="canvas-panel__title">我的工作流</h2>
          {renderRecipeRows()}
        </>
      ) : null}
      {filter === "templates" ? (
        <>
          <h2 className="canvas-panel__title">起步模板</h2>
          {renderTemplates()}
        </>
      ) : null}
      {filter === "recent" ? (
        <>
          <h2 className="canvas-panel__title">最近</h2>
          {renderRecent()}
        </>
      ) : null}

      {filter !== "templates" && snapshot.anomalies.length > 0 ? (
        <>
          <h2 className="canvas-panel__title">运行记录异常</h2>
          <ul className="canvas-rows">
            {snapshot.anomalies.map((row) => (
              <li
                className="canvas-row canvas-row--bad"
                data-testid="canvas-anomaly-row"
                key={row.path}
              >
                <span className="canvas-row__meta canvas-row__meta--error">{row.reason}</span>
                <span className="canvas-row__meta">{row.path}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {rowMenu ? (
        <div style={{ position: "absolute", left: rowMenu.x, top: rowMenu.y }}>
          <RecipeRowContextMenu
            name={rowMenu.name}
            onRemove={() => (onDeleteRecipe ?? (() => {}))(rowMenu.name)}
            onOpenInNewTab={onOpenInNewTab}
            onClose={() => setRowMenu(null)}
          />
        </div>
      ) : null}
    </aside>
  );
}

function isSelected(
  selection: CanvasSelection | null | undefined,
  kind: CanvasSelection["kind"],
  name: string,
  path?: string,
): boolean {
  return (
    selection?.kind === kind &&
    selection.name === name &&
    (!selection.path || selection.path === path)
  );
}
