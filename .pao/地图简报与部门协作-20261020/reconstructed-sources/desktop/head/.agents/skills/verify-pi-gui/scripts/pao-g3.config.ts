import { defineConfig } from "@playwright/test";
import base from "../../../../apps/desktop/playwright.config";
export default defineConfig({
  ...base,
  outputDir: process.env.PI_GUI_PROOF_DIR
    ? `${process.env.PI_GUI_PROOF_DIR}/test-results`
    : "test-results-pao-g3",
  testDir: ".",
  testMatch: "pao-g3.spec.ts",
  retries: 0,
  workers: 1,
});
