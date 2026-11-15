import type { WorkflowTabRecord } from "../../../contracts/desktop-state";

/** 标签只显示正式元数据；未保存内容仍由当前配方编辑器持有并保护。 */
export function WorkflowTabs({
  tabs,
  activeId,
  dirty,
  disabled,
  onSelect,
  onClose,
  onNew,
}: {
  readonly tabs: readonly WorkflowTabRecord[];
  readonly activeId?: string;
  readonly dirty: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onNew: () => void;
}) {
  return (
    <nav className="workflow-tabs" aria-label="工作流标签" data-testid="workflow-tabs">
      {tabs.map((tab) => (
        <div
          className={`workflow-tab${tab.id === activeId ? " workflow-tab--active" : ""}`}
          key={tab.id}
        >
          <button
            type="button"
            className="workflow-tab__select"
            aria-current={tab.id === activeId ? "page" : undefined}
            disabled={disabled}
            onClick={() => onSelect(tab.id)}
          >
            {tab.title}
            {tab.id === activeId && dirty ? " ●" : ""}
            {tab.mode === "runtime" ? " · 运行记录" : ""}
          </button>
          <button
            type="button"
            className="workflow-tab__close"
            aria-label={`关闭 ${tab.title}`}
            disabled={disabled}
            onClick={() => onClose(tab.id)}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="button" disabled={disabled} onClick={onNew}>
        ＋ 新建工作流
      </button>
    </nav>
  );
}
