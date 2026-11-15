import type { ComponentType, ReactNode } from "react";
import {
  BUILTIN_TOOL_KINDS,
  type BuiltinToolKind,
  type ToolRef,
} from "../../../contracts/workbench";
import { ChatIcon, DiffIcon, FileIcon, TerminalIcon } from "../../ui/icons";

interface BuiltinToolDefinition {
  readonly label: string;
  /** Shown in the tool chooser. */
  readonly description: string;
  readonly Icon: ComponentType;
  /** Key that toggles the tool with the platform modifier, when it has one. */
  readonly shortcutKey?: string;
}

/** Presentation for every built-in tool; a missing kind fails the build. */
export const BUILTIN_TOOLS = {
  files: { label: "Files", description: "Browse files in this checkout", Icon: FileIcon },
  changes: {
    label: "Review",
    description: "Review uncommitted, branch or turn changes",
    Icon: DiffIcon,
    shortcutKey: "R",
  },
  terminal: {
    label: "Terminal",
    description: "Run commands in this task's checkout",
    Icon: TerminalIcon,
    shortcutKey: "J",
  },
  "side-chat": {
    label: "Side chat",
    description: "Ask read-only questions about this task",
    Icon: ChatIcon,
  },
} as const satisfies Record<BuiltinToolKind, BuiltinToolDefinition>;

/** Chooser order follows the contract's kind list. */
export const BUILTIN_TOOL_ENTRIES = BUILTIN_TOOL_KINDS.map(
  (kind): BuiltinToolDefinition & { readonly kind: BuiltinToolKind } => ({
    kind,
    ...BUILTIN_TOOLS[kind],
  }),
);

/** Dock 直接装配的内建面板；辅助对话由独立组件提供，不进入这张通用表。 */
type BuiltinToolPanels = Record<BuiltinToolKind, () => ReactNode>;
export type ComposedBuiltinToolKind = Exclude<BuiltinToolKind, "side-chat">;

export function isComposedBuiltinToolKind(value: ToolRef): value is {
  readonly kind: ComposedBuiltinToolKind;
} {
  return value.kind !== "extension" && value.kind !== "department" && value.kind !== "side-chat";
}

/** 每个通用内建工具都必须提供面板；以后新增类型时由类型检查强制补全。 */
export function renderBuiltinToolPanel(
  kind: ComposedBuiltinToolKind,
  panels: Pick<BuiltinToolPanels, ComposedBuiltinToolKind>,
): ReactNode {
  return panels[kind]();
}
