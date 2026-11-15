import type { ReactNode } from "react";
import {
  BellIcon,
  ExtensionIcon,
  KeyboardIcon,
  ModelIcon,
  PlugIcon,
  SettingsIcon,
  SkillIcon,
  SunIcon,
} from "../../ui/icons";
import type { TranslationParams } from "../../../contracts/i18n";

export interface SettingsSectionDefinition {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly icon: ReactNode;
  /** Words people search for that are not in the title, such as the page's row titles. */
  readonly keywords: readonly string[];
  /** The page description; `{name}` (if present) is the workspace name. */
  readonly description?: (workspaceName: string) => string;
  /** Pages that read or write one workspace's runtime. */
  readonly needsWorkspace: boolean;
}

/** Nav order: grouped the way Codex groups its settings, one entry per page. */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    title: "General",
    group: "App",
    icon: <SettingsIcon />,
    keywords: ["language", "模型设置", "语言", "技能命令", "终端", "shell", "PAO", "主目录"],
    description: () => "App and runtime defaults.",
    needsWorkspace: false,
  },
  {
    id: "appearance",
    title: "Appearance",
    group: "App",
    icon: <SunIcon />,
    keywords: ["theme", "light", "dark", "system", "preset", "colors", "transparency", "主题"],
    description: () => "Choose light, dark or system mode and a color preset.",
    needsWorkspace: false,
  },
  {
    id: "notifications",
    title: "Notifications",
    group: "App",
    icon: <BellIcon />,
    keywords: ["alerts", "background", "completion", "failures", "approval", "macos", "通知"],
    description: () => "Choose which background events alert you.",
    needsWorkspace: false,
  },
  {
    id: "shortcuts",
    title: "Keyboard shortcuts",
    group: "App",
    icon: <KeyboardIcon />,
    keywords: ["keys", "hotkeys", "keybindings", "快捷键"],
    description: () => "Shortcuts available across the app.",
    needsWorkspace: false,
  },
  {
    id: "providers",
    title: "Providers",
    group: "Agent",
    icon: <PlugIcon />,
    keywords: ["login", "logout", "oauth", "api key", "auth", "custom endpoint", "登录", "提供商"],
    description: () => "Connect providers and manage auth for {name}.",
    needsWorkspace: true,
  },
  {
    id: "models",
    title: "Models",
    group: "Agent",
    icon: <ModelIcon />,
    keywords: ["default model", "reasoning", "thinking", "enabled models", "模型"],
    description: () => "Choose the default model and which models appear in pickers.",
    needsWorkspace: true,
  },
  {
    id: "mcp",
    title: "MCP servers",
    group: "Agent",
    icon: <ExtensionIcon />,
    keywords: ["mcp", "mcp.json", "model context protocol", "servers", "code mode", "codemode"],
    description: () => "Add, remove and switch the MCP servers pi connects in each thread.",
    needsWorkspace: true,
  },
] as const satisfies readonly SettingsSectionDefinition[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Skills and extensions live in the settings nav but are their own app views. */
export const CUSTOMIZE_SECTION_ID = "customize";

export const SETTINGS_NAV_ITEMS = [
  ...SETTINGS_SECTIONS,
  {
    id: CUSTOMIZE_SECTION_ID,
    title: "Skills and extensions",
    group: "Customize",
    icon: <SkillIcon />,
    keywords: ["skills", "extensions", "plugins", "slash commands", "tools", "技能", "扩展"],
  },
] as const;

export function settingsSectionDefinition(section: SettingsSection): SettingsSectionDefinition {
  return SETTINGS_SECTIONS.find((definition) => definition.id === section) ?? SETTINGS_SECTIONS[0];
}

type Translate = (key: string, params?: TranslationParams) => string;

/** The section's title in the UI language (keys are the English copy). */
export function sectionTitle(
  section: SettingsSection,
  t: Translate = (key) => key,
): string {
  return t(settingsSectionDefinition(section).title);
}

/** The section's page description in the UI language, with the workspace name filled in. */
export function sectionDescription(
  definition: SettingsSectionDefinition,
  workspaceName: string,
  t: Translate,
): string {
  return t(definition.description?.(workspaceName) ?? "", { name: workspaceName });
}
