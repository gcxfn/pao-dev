import { useState, type ReactNode } from "react";

/**
 * 画布内嵌对话容器：折叠／展开 App 级构造的「当前真实会话」UI。
 *
 * 只渲染传入的真实会话节点，不新建消息系统、也不复制会话状态；折叠时卸载内容，
 * 展开时才挂载时间线与输入框（草稿与附件状态住在 App 级 hook，折叠不会丢）。
 * 布局走 .embedded-chat* 类名，父级可覆盖；这里只保留最小内联 flex 布局。
 */
export function EmbeddedChat({
  title = "主控对话",
  children,
  emptyHint = "当前没有可显示的真实会话。",
  defaultOpen = true,
  open,
  onOpenChange,
}: {
  /** 折叠条标题，通常是当前主控或会话名。 */
  readonly title?: string;
  /** App 级构造的真实会话节点；为空时显示 emptyHint，不伪造会话。 */
  readonly children?: ReactNode;
  readonly emptyHint?: string;
  readonly defaultOpen?: boolean;
  /** 传入即为受控展开态；不传则由组件自持。 */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const expanded = open ?? internalOpen;
  const toggle = () => {
    const next = !expanded;
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <section
      className="embedded-chat"
      data-testid="embedded-chat"
      data-state={expanded ? "open" : "closed"}
      style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <button
        type="button"
        className="button embedded-chat__toggle"
        data-testid="embedded-chat-toggle"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span className="embedded-chat__title">{title}</span>
        <span className="embedded-chat__chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded ? (
        <div
          className="embedded-chat__body"
          data-testid="embedded-chat-body"
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          {children ?? <p className="embedded-chat__empty">{emptyHint}</p>}
        </div>
      ) : null}
    </section>
  );
}