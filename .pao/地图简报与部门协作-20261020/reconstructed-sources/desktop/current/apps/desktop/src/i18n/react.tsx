import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { AppLanguage } from "../../contracts/desktop-state";
import { translate, type TranslationParams } from "../../contracts/i18n";

export interface I18n {
  readonly language: AppLanguage;
  /** Translate `key` (the English copy) in the UI's current language. */
  readonly t: (key: string, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18n>({
  language: "en",
  t: (key, params) => translate("en", key, params),
});

/**
 * Provides the UI language from the desktop state snapshot, so every consumer
 * re-renders the moment the language setting changes.
 */
export function I18nProvider({
  language,
  children,
}: {
  readonly language: AppLanguage;
  readonly children: ReactNode;
}) {
  const t = useCallback(
    (key: string, params?: TranslationParams) => translate(language, key, params),
    [language],
  );
  const value = useMemo<I18n>(() => ({ language, t }), [language, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
