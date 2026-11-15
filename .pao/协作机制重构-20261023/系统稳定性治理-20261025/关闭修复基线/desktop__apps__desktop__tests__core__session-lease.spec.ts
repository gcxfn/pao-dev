import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createSessionViaIpc,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  type DesktopHarness,
} from "../helpers/electron-app";

async function findLeaseFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => entry.endsWith(".jsonl.lease")).map((entry) => join(dir, entry));
}

async function leaseHolderPid(leasePath: string): Promise<number | undefined> {
  try {
    return (JSON.parse(await readFile(leasePath, "utf8")) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
}

/**
 * Two pi-gui processes (separate user-data dirs, so the single-instance lock
 * does not stop the second) share one pi agent dir. The first holds a thread
 * open; the second must refuse to open it until the first quits.
 */
test("a second pi-gui process cannot open a thread the first one holds", async () => {
  test.setTimeout(120_000);
  const agentDir = await makeUserDataDir("pi-gui-shared-agent-");
  const workspacePath = await makeWorkspace("lease-workspace");
  const title = "Shared lease thread";

  const first = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspacePath],
    agentDir,
    testMode: "background",
  });
  let second: DesktopHarness | undefined;
  try {
    const firstWindow = await first.firstWindow();
    await createSessionViaIpc(firstWindow, workspacePath, title);
    await expect.poll(() => findLeaseFiles(agentDir)).toHaveLength(1);

    second = await launchDesktop(await makeUserDataDir(), {
      initialWorkspaces: [workspacePath],
      agentDir,
      testMode: "background",
    });
    const secondWindow = await second.firstWindow();
    const secondRow = secondWindow.locator(".session-row__select", { hasText: title });
    await expect(secondRow).toBeVisible({ timeout: 20_000 });
    await secondRow.click();
    await expect(secondWindow.getByTestId("composer-error-banner")).toContainText(
      "This session is currently open in another pi instance",
    );

    const [leasePath] = await findLeaseFiles(agentDir);
    const firstPid = first.electronApp.process().pid;
    expect(await leaseHolderPid(leasePath)).toBe(firstPid);

    // Once the holder quits its lease is dead, so the thread opens here and
    // this process takes the lease over.
    await first.close();
    await selectSession(secondWindow, title);
    await expect(secondWindow.getByTestId("composer-error-banner")).toHaveCount(0);
    await expect.poll(() => leaseHolderPid(leasePath)).toBe(second.electronApp.process().pid);
  } finally {
    await second?.close();
    await first.close().catch(() => {});
  }
});

/**
 * Pins the host quit stop chain: quitting must dispose every managed session
 * runtime (`before-quit` -> store.disposeSessions() -> driver.disposeAll()),
 * which releases the session lease. Without that wiring Electron's app.quit()
 * delivers no signal, the runtime's session_shutdown never fires, and managed
 * worker/tool process trees survive the app.
 *
 * The session file is located through the app's catalog rather than the
 * launched agentDir: the coding agent resolves the session root from the user
 * home, so the lease can live outside the test's isolated agent dir.
 */
test("quitting releases the session lease of every open thread", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("quit-lease-workspace");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  const sessionLeasePaths = async (): Promise<string[]> => {
    try {
      const catalog = JSON.parse(
        await readFile(join(userDataDir, "catalogs.json"), "utf8"),
      ) as { sessions?: Array<{ sessionFilePath?: string }> };
      return catalog.sessions
        .map((session) => session.sessionFilePath)
        .filter((filePath): filePath is string => Boolean(filePath))
        .map((filePath) => `${filePath}.lease`);
    } catch {
      return [];
    }
  };

  try {
    const window = await app.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Quit lease thread");
    // The lease is claimed when the session's writable runtime binds, which on a
    // cold machine trails the session's first open; do not trust the 5s default.
    await expect.poll(() => sessionLeasePaths().then((paths) => paths.length > 0), {
      timeout: 30_000,
    }).toBe(true);
    const leasePaths = await sessionLeasePaths();
    expect(leasePaths.length).toBeGreaterThanOrEqual(1);

    // app.quit() -> before-quit: drafts flush, store flush, and disposeSessions
    // run together; the quit deadline bounds the whole sequence.
    await app.close();
    await expect
      .poll(async () => {
        const remaining = [];
        for (const leasePath of leasePaths) {
          try {
            remaining.push(await readFile(leasePath, "utf8"));
          } catch {
            // Released leases are deleted from disk.
          }
        }
        return remaining;
      }, { timeout: 15_000 })
      .toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
  }
});
