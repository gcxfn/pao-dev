import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  startThreadViaIpc,
  type DesktopHarness,
} from "../helpers/electron-app";

/**
 * S1-2包2 一次性真实验证（W-bug9，零模型）：
 * 残留会话锁报错展示旧 owner 详情（pid/宿主面/持有时间）＋一键显式接管
 * （复用内核 /pao runtime takeover 同链路）；错误 owner 手敲接管仍被拒绝。
 * 隔离 PAO_HOME 与 userDataDir；不发任何模型请求。
 */

const FOREIGN_PID = 424242;

async function launchIsolated(
  userDataDir: string,
  paoHome: string,
  workspaceDir: string,
): Promise<DesktopHarness> {
  return launchDesktop(userDataDir, {
    testMode: "background",
    scrubProviderEnv: true,
    initialWorkspaces: [workspaceDir],
    envOverrides: { PAO_DISABLE_BUILTIN_EXTENSION: "0", PAO_HOME: paoHome },
  });
}

test("残留锁报错展示旧 owner 并可一键显式接管；错误 owner 仍拒绝", async () => {
  test.setTimeout(300_000);
  const evidenceDir = join(
    "D:/AI/workspace/pao-dev/.pao/统一执行-20261007/S1-2包2/证据",
    `接管-${Date.now()}`,
  );
  const paoHome = await mkdtemp(join(tmpdir(), "s12-pao-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "s12-workspace-"));
  const userDataDir = await makeUserDataDir("s12-takeover-");
  const foreignToken = randomUUID();

  // ── 第一段：建会话（主控锁落盘），不发送任何模型请求 ──
  let harness = await launchIsolated(userDataDir, paoHome, workspaceDir);
  const page = await harness.firstWindow();
  await startThreadViaIpc(page, { prompt: "" });
  const lockDir = join(paoHome, ".pao", "运行时锁");
  let lockFile = "";
  await expect
    .poll(
      async () => {
        try {
          const names = (await readdir(lockDir)).filter((name) => name.endsWith(".json"));
          if (names.length === 1) {
            lockFile = join(lockDir, names[0]);
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const ownLock = JSON.parse(await readFile(lockFile, "utf8")) as {
    token: string;
    sessionId: string;
    pid: number;
    surface: string;
  };
  expect(ownLock.token).toBeTruthy();
  await page.screenshot({ path: join(evidenceDir, "1-首启锁落盘.png") });

  // ── 第二段：优雅退出（session_shutdown 放锁），伪造残留 foreign owner ──
  await harness.close();
  await expect
    .poll(
      async () => {
        try {
          await readFile(lockFile, "utf8");
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await mkdir(lockDir, { recursive: true });
  const residual = {
    token: foreignToken,
    sessionId: ownLock.sessionId,
    pid: FOREIGN_PID,
    surface: "terminal",
    acquiredAt: new Date().toISOString(),
  };
  await writeFile(lockFile, JSON.stringify(residual), "utf8");

  // ── 第三段：重启恢复会话 → 残留锁报错＋旧 owner 富化详情 ──
  harness = await launchIsolated(userDataDir, paoHome, workspaceDir);
  const page2 = await harness.firstWindow();
  // 语言切中文，验证中文文案（设置持久化，重启后仍生效）。
  await page2.evaluate(() => window.piApp?.setLanguage("zh"));
  // 内核 runtime 在重开后惰性启动：发一条消息逼 session_start 执行。
  // 无任何 provider 凭证（scrubProviderEnv），该消息本地必然失败，零模型请求。
  const composer2 = page2.getByTestId("composer");
  await expect(composer2).toBeVisible({ timeout: 30_000 });
  await composer2.fill("s12 强制启动 runtime（无凭证，本地失败）");
  await composer2.press("Enter");
  const residualMark = page2.getByText("残留会话锁须显式接管", { exact: false }).first();
  await expect(residualMark).toBeVisible({ timeout: 60_000 });
  await expect(page2.getByText(`pid ${FOREIGN_PID}`, { exact: false }).first()).toBeVisible();
  await expect(page2.getByText("宿主面 terminal", { exact: false }).first()).toBeVisible();
  await expect(page2.getByText("原控制方：", { exact: false }).first()).toBeVisible();
  await page2.screenshot({ path: join(evidenceDir, "2-残留锁富化报错.png") });

  // ── 第四段：错误 owner 手敲接管 → 仍拒绝 ──
  await composer2.fill(`/pao runtime takeover ${randomUUID()}`);
  await composer2.press("Enter");
  await expect
    .poll(
      async () => (await page2.getByText("残留会话锁须显式接管", { exact: false }).count()) >= 2,
      { timeout: 30_000 },
    )
    .toBe(true);
  await page2.screenshot({ path: join(evidenceDir, "3-错误owner被拒.png") });
  // 锁文件未被错误 owner 改写。
  expect(JSON.parse(await readFile(lockFile, "utf8")).token).toBe(foreignToken);

  // ── 第五段：一键显式接管（确认弹窗展示旧 owner 与影响）→ 成功换发 ──
  page2.once("dialog", (dialog) => {
    void dialog
      .accept()
      .catch((error: unknown) => console.error("[verify] confirm accept failed", error));
  });
  await page2
    .getByRole("button", { name: /接管会话控制权|Take over session control/ })
    .first()
    .click();
  await expect
    .poll(async () => JSON.parse(await readFile(lockFile, "utf8")).token, { timeout: 30_000 })
    .not.toBe(foreignToken);
  await page2.screenshot({ path: join(evidenceDir, "4-一键接管成功.png") });

  await harness.close();
});
