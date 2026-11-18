import { defineConfig } from "../../../desktop/node_modules/@playwright/test";
export default defineConfig({
  testDir: __dirname,
  testMatch: /d0[56]-.*\.spec\.ts/,
  timeout: 240_000,
  workers: 1,
  retries: 0,
  outputDir: "../checks/runtime-results",
});
