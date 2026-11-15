/**
 * Lightweight i18n shared by the renderer and the main process (menus, dialogs,
 * notifications). Zero dependencies: `t` looks a string up in the active
 * language's dictionary and falls back to the key itself, which is the English
 * copy — a missing translation can never render blank or a raw lookup key.
 *
 * Keys are the English source strings. Parameters use `{name}` placeholders in
 * dictionary values, e.g. `"Open {name}"` → `"打开 {name}"`.
 */
import type { AppLanguage } from "./desktop-state";
import { enTranslations } from "./i18n-en";
import { zhTranslations } from "./i18n-zh";

export type TranslationParams = Record<string, string | number>;

const dictionaries: Record<AppLanguage, Record<string, string>> = {
  en: enTranslations,
  zh: zhTranslations,
};

export function translate(
  language: AppLanguage,
  key: string,
  params?: TranslationParams,
): string {
  const text = dictionaries[language][key] ?? key;
  if (!params) {
    return text;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

// Main-process current language. The renderer reads the language from the
// desktop state snapshot instead, so it re-renders when it changes.
let currentLanguage: AppLanguage = "en";

export function setI18nLanguage(language: AppLanguage): void {
  currentLanguage = language;
}

export function getI18nLanguage(): AppLanguage {
  return currentLanguage;
}

/** Translate with the main process's current language. */
export function tMain(key: string, params?: TranslationParams): string {
  return translate(currentLanguage, key, params);
}
