import { dirname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { writePersistedUiState } from "../../electron/persistence/app-store-persistence";
import {
  desktopShortcut,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  resolvePackagedAppExecutable,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

// 仅运行在明确指定的隔离发行目录，不能借正式安装目录验证默认数据写入。
test.beforeEach(() => {
  if (!process.env.PI_APP_TEST_RELEASE_DIR) throw new Error("需要隔离 PI_APP_TEST_RELEASE_DIR");
});

for (const portable of [false, true]) {
  test(`packaged PAO home uses ${portable ? "the portable launcher" : "the install directory"}/data`, async () => {
    const userDataDir = await makeUserDataDir("pao-home-packaged-");
    const workspacePath = await makeWorkspace("pao-home-packaged-workspace-");
    const portableDir = portable ? await makeWorkspace("pao-home-portable-") : undefined;
    const exePath = await resolvePackagedAppExecutable(
      resolve(process.env.PI_APP_TEST_RELEASE_DIR!),
    );
    const expectedHome = join(portableDir ?? dirname(exePath), "data");
    const harness = await launchPackagedDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
      envOverrides: { PAO_HOME: undefined, PORTABLE_EXECUTABLE_DIR: portableDir },
    });
    try {
      expect(await harness.electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true);
      const window = await harness.firstWindow();
      await waitForWorkspaceByPath(window, workspacePath);
      await window.keyboard.press(desktopShortcut(","));
      await window.getByRole("button", { name: "General", exact: true }).click();
      const effective = window.getByTestId("settings-pao-home-effective");
      const setting = window.getByLabel("PAO home directory");
      await expect(effective).toHaveText(expectedHome);
      await expect(setting).toHaveValue("");
      const customHome = await makeWorkspace("pao-home-custom-");
      await setting.fill(customHome);
      await setting.press("Enter");
      await expect(effective).toHaveText(customHome);
      await setting.fill("");
      await setting.press("Enter");
      await expect(effective).toHaveText(expectedHome);
    } finally {
      await harness.close();
    }
  });
}

test("packaged startup preserves a previously configured PAO home", async () => {
  const userDataDir = await makeUserDataDir("pao-home-existing-setting-");
  const workspacePath = await makeWorkspace("pao-home-existing-workspace-");
  const existingHome = await makeWorkspace("pao-home-existing-data-");
  await writePersistedUiState(join(userDataDir, "ui-state.json"), { paoHome: existingHome });
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PAO_HOME: undefined, PORTABLE_EXECUTABLE_DIR: undefined },
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "General", exact: true }).click();
    await expect(window.getByLabel("PAO home directory")).toHaveValue(existingHome);
    await expect(window.getByTestId("settings-pao-home-effective")).toHaveText(existingHome);
  } finally {
    await harness.close();
  }
});
