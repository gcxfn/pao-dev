import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getRealAuthConfig,
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  resolvePackagedAppExecutable,
} from "../helpers/electron-app";

/**
 * S12 正式现场真模型冒烟（2026-10-09）：打包发行物 + 正式 PAO_HOME + 真凭证，
 * 发一条最便宜请求验证端到端。仅当显式设置 PI_APP_REAL_AUTH=1、
 * PI_APP_REAL_AUTH_SOURCE_DIR 与 PI_APP_PAO_SMOKE_HOME 时才运行——常规车道一律 skip，
 * 防止意外打真请求。
 */
const smokeHome = process.env.PI_APP_PAO_SMOKE_HOME?.trim();

test("packaged app talks to the real model through the production PAO home", async () => {
  const realAuth = getRealAuthConfig();
  test.skip(
    !realAuth.enabled || !smokeHome,
    !realAuth.enabled
      ? realAuth.skipReason
      : "Set PI_APP_PAO_SMOKE_HOME to the production PAO home to run this smoke test.",
  );
  test.setTimeout(180_000);

  const userDataDir = await makeUserDataDir("pao-live-smoke-");
  const workspacePath = await makeWorkspace("pao-live-smoke-workspace");
  const executablePath = await resolvePackagedAppExecutable();
  const harness = await launchDesktopByExecutable(executablePath, userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
    envOverrides: {
      // 正式现场（档位.json 决定默认模型＝快档 glm-5.3-flash，最便宜）
      PAO_HOME: smokeHome,
      // 真实产品形态：带 pao 内置扩展（车道默认禁用是为上游 core 断言面）
      PAO_DISABLE_BUILTIN_EXTENSION: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "现场冒烟");

    const composer = window.getByTestId("composer");
    await composer.fill(
      "这是一次端到端冒烟测试。请只回复 SMOKE_OK，不要调用任何工具。",
    );
    await composer.press("Enter");

    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("SMOKE_OK", { timeout: 120_000 });
  } finally {
    await harness.close();
  }
});
