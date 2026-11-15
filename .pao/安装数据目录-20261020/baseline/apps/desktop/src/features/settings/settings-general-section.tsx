import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type {
  AppLanguage,
  CloseWindowBehavior,
  ModelSettingsScopeMode,
} from "../../../contracts/desktop-state";
import { SettingsSelect, SettingsSegmented, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { useI18n } from "../../i18n/react";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly paoHome: string;
  /** 当前实际生效的 PAO 主目录（空串＝未配置）；只读派生值，不落盘。 */
  readonly paoHomeEffective?: string;
  readonly language: AppLanguage;
  readonly closeWindowBehavior: CloseWindowBehavior;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onSetPaoHome: (paoHome: string) => void;
  readonly onSetCloseWindowBehavior: (behavior: CloseWindowBehavior) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
  readonly onSetLanguage: (language: AppLanguage) => void;
}

const LANGUAGE_OPTIONS: readonly {
  readonly value: AppLanguage;
  /** Language names stay in their own language so people can find theirs. */
  readonly label: string;
}[] = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
];

export function SettingsGeneralSection({
  runtime,
  modelSettingsScopeMode,
  integratedTerminalShell,
  paoHome,
  paoHomeEffective,
  language,
  closeWindowBehavior,
  onSetModelSettingsScopeMode,
  onSetIntegratedTerminalShell,
  onSetPaoHome,
  onSetCloseWindowBehavior,
  onToggleSkillCommands,
  onSetLanguage,
}: SettingsGeneralSectionProps) {
  const { t } = useI18n();
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);
  const [paoHomeDraft, setPaoHomeDraft] = useState(paoHome);

  useEffect(() => {
    setTerminalShellDraft(integratedTerminalShell);
  }, [integratedTerminalShell]);

  useEffect(() => {
    setPaoHomeDraft(paoHome);
  }, [paoHome]);

  const commitTerminalShellDraft = () => {
    if (terminalShellDraft !== integratedTerminalShell) {
      onSetIntegratedTerminalShell(terminalShellDraft);
    }
  };

  const commitPaoHomeDraft = () => {
    if (paoHomeDraft !== paoHome) {
      onSetPaoHome(paoHomeDraft);
    }
  };

  return (
    <>
      <SettingsGroup title={t("Agent")}>
        <SettingsRow title={t("Language")} description={t("UI language for menus and dialogs.")}>
          <SettingsSelect
            label={t("Language")}
            options={LANGUAGE_OPTIONS}
            value={language}
            onChange={onSetLanguage}
          />
        </SettingsRow>
        <SettingsRow
          title={t("Model settings scope")}
          description={t(
            "Apply the default model and enabled models everywhere, or set them per repo.",
          )}
        >
          <SettingsSegmented
            label={t("Model settings scope")}
            options={[
              { value: "app-global", label: t("App global") },
              { value: "per-repo", label: t("Per repo") },
            ]}
            value={modelSettingsScopeMode}
            onChange={onSetModelSettingsScopeMode}
          />
        </SettingsRow>
        <SettingsRow
          title={t("Skill slash commands")}
          description={t("Offer each skill as a slash command in the composer.")}
        >
          <SettingsSwitch
            checked={runtime?.settings.enableSkillCommands ?? true}
            label={t("Enable skill slash commands")}
            onChange={onToggleSkillCommands}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Window")}>
        <SettingsRow
          title={t("When closing the window")}
          description={t("Quit the app, or keep it running in the system tray.")}
        >
          <SettingsSegmented
            label={t("When closing the window")}
            options={[
              { value: "quit", label: t("Quit") },
              { value: "tray", label: t("Minimize to tray") },
            ]}
            value={closeWindowBehavior}
            onChange={onSetCloseWindowBehavior}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("PAO")}>
        <SettingsRow
          title={t("PAO home directory")}
          description={t(
            "Points to your PAO data folder. Leave blank to use the PAO_HOME environment variable.",
          )}
        >
          <input
            aria-label={t("PAO home directory")}
            className="settings-text-input"
            placeholder="D:\PAO"
            spellCheck={false}
            type="text"
            value={paoHomeDraft}
            onBlur={commitPaoHomeDraft}
            onChange={(event) => setPaoHomeDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow
          title={t("PAO home in use")}
          description={t(
            "The folder this session actually reads and writes: the PAO_HOME environment variable wins over this setting.",
          )}
        >
          <span className="settings-value-text" data-testid="settings-pao-home-effective">
            {paoHomeEffective ? paoHomeEffective : t("Not configured")}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Terminal")}>
        <SettingsRow
          title={t("Shell")}
          description={t(
            "The shell the integrated terminal starts. Leave blank to use your login shell.",
          )}
        >
          <input
            aria-label={t("Shell of integrated terminal")}
            className="settings-text-input"
            placeholder="/bin/zsh"
            spellCheck={false}
            type="text"
            value={terminalShellDraft}
            onBlur={commitTerminalShellDraft}
            onChange={(event) => setTerminalShellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
