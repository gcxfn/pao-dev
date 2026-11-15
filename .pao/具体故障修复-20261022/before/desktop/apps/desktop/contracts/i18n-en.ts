/**
 * English resource dictionary. English strings are the translation keys
 * themselves (see contracts/i18n.ts), so this map stays empty: `translate`
 * falls back to the key, which is the English copy. It exists so every
 * language has a resource file and per-language overrides stay possible.
 */
export const enTranslations: Record<string, string> = {
  "Workflow canvas": "Workflow",
  "The recipe for this instance could not be read; nodes are listed without edges.":
    "This run record has no readable frozen workflow. Card mappings are shown; original edges and positions are unknown.",
};
