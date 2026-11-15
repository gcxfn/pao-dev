import { defineConfig } from "@playwright/test";
import base from "../../../../apps/desktop/playwright.config";
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "pao-g3-controls.spec.ts",
  retries: 0,
  workers: 1,
  outputDir: `${process.env.PI_GUI_PROOF_DIR ?? "test-results-pao-g3-controls"}/test-results`,
});
