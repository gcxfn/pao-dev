import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// Unit-lane specs exercise real git against fixture repos; without this the machine's
// system gitconfig (e.g. core.autocrlf=true) leaks into spec-owned git calls and makes
// results machine-dependent. Core/native/live lanes launch the app itself and keep the
// user environment (product code strips GIT_* env anyway, see isolatedGitEnvironment).
const unitLane = process.argv.some((arg) => arg.replace(/\\/g, "/").includes("/tests/unit"));
if (unitLane) {
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
}

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: resolve(__dirname, "tests"),
  // Demo specs record marketing videos on demand; keep them out of default/CI discovery.
  testIgnore: "**/demo/**",
  timeout: 60_000,
  // CI runners are routinely 2-3x slower than dev machines; the default 5s
  // expect timeout flakes on UI convergence that is sub-second locally.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  // Foreground Electron tests need one app to own the OS input loop, and CI sizes its own
  // shards. Local Linux background runs keep windows hidden, so three apps run side by side.
  // PI_APP_TEST_WORKERS overrides either default.
  workers:
    Number(process.env.PI_APP_TEST_WORKERS) ||
    (process.platform === "linux" &&
    process.env.PI_APP_TEST_MODE === "background" &&
    !process.env.CI
      ? 3
      : 1),
  retries: process.env.PI_APP_TEST_MODE === "foreground" ? 1 : 0,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
