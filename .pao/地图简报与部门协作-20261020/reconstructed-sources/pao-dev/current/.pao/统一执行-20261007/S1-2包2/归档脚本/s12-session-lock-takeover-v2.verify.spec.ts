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
 * S1-2包2 V2 真实验证（W-bug9，零模型）：
 * ① 确认弹窗取消腿（M2）：dismiss 后不提交接管命令（无新报错行、锁文件不变）；
 * ② 成功腿（对抗式 P3-4）：accept 后锁 token 轮换、成功 info 提示可见、按钮转禁用（F8）。
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

test("接管按钮：确认取消不提交；确认成功后提示可见且按钮禁用", async () => {
  test.setTimeout(300_000);
  const evidenceDir = join(
    "D:/AI/workspace/pao-dev/.pao/统一执行-20261007/S1-2包2/证据",
    `接管V2-${Date.now()}`,
  );
  const paoHome = await mkdtemp(join(tmpdir(), "s12v2-pao-home-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "s12v2-workspace-"));
  const userDataDir = await makeUserDataDir("s12v2-takeover-");
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
  await harness.close();

  // ── 第二段：优雅退出后伪造异主残留锁 ──
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
  await writeFile(
    lockFile,
    JSON.stringify({
      token: foreignToken,
      sessionId: ownLock.sessionId,
      pid: FOREIGN_PID,
      surface: "terminal",
      acquiredAt: new Date().toISOString(),
    }),
    "utf8",
  );

  // ── 第三段：重启恢复会话 → 残留锁报错＋旧 owner 富化详情 ──
  harness = await launchIsolated(userDataDir, paoHome, workspaceDir);
  const page2 = await harness.firstWindow();
  await page2.evaluate(() => window.piApp?.setLanguage("zh"));
  // 无任何 provider 凭证（scrubProviderEnv），发消息本地失败即触发 runtime 惰性启动报错。
  const composer2 = page2.getByTestId("composer");
  await expect(composer2).toBeVisible({ timeout: 30_000 });
  await composer2.fill("s12v2 强制启动 runtime（无凭证，本地失败）");
  await composer2.press("Enter");
  const residualRows = page2.getByText("残留会话锁须显式接管", { exact: false });
  await expect(residualRows.first()).toBeVisible({ timeout: 60_000 });
  await expect(page2.getByText(`pid ${FOREIGN_PID}`, { exact: false }).first()).toBeVisible();
  await expect(page2.getByText("宿主面 terminal", { exact: false }).first()).toBeVisible();
  await page2.screenshot({ path: join(evidenceDir, "1-残留锁富化报错.png") });

  const takeoverButton = page2.getByRole("button", {
    name: /接管会话控制权|Take over session control/,
  });
  await expect(takeoverButton.first()).toBeVisible();

  // ── 第四段（M2 取消腿）：确认弹窗 dismiss → 不提交接管命令 ──
  page2.once("dialog", (dialog) => {
    void dialog
      .dismiss()
      .catch((error: unknown) => console.error("[verify] confirm dismiss failed", error));
  });
  await takeoverButton.first().click();
  // 若误提交，内核会在数秒内以第二条残留锁报错行回显；等足窗口再断言无新行。
  await page2.waitForTimeout(8_000);
  expect(await residualRows.count()).toBe(1);
  expect(JSON.parse(await readFile(lockFile, "utf8")).token).toBe(foreignToken);
  // 未提交 → 按钮仍可再次点击（不禁用）。
  await expect(takeoverButton.first()).toBeEnabled();
  await page2.screenshot({ path: join(evidenceDir, "2-取消腿-无新提交.png") });

  // ── 第五段（P3-4 成功腿）：确认接受 → token 轮换＋成功提示可见＋按钮禁用 ──
  page2.once("dialog", (dialog) => {
    void dialog
      .accept()
      .catch((error: unknown) => console.error("[verify] confirm accept failed", error));
  });
  await takeoverButton.first().click();
  await expect
    .poll(async () => JSON.parse(await readFile(lockFile, "utf8")).token, { timeout: 30_000 })
    .not.toBe(foreignToken);
  // 内核 /pao runtime takeover 成功路径的 info 通知（runtime/index.ts notify「本会话控制权有效」）。
  await expect(page2.getByText("本会话控制权有效").first()).toBeVisible({ timeout: 30_000 });
  // F8：提交后按钮禁用（重复点击不再发旧 token 命令）。
  await expect(takeoverButton.first()).toBeDisabled();
  await page2.screenshot({ path: join(evidenceDir, "3-成功腿-提示可见按钮禁用.png") });

  await harness.close();
});
