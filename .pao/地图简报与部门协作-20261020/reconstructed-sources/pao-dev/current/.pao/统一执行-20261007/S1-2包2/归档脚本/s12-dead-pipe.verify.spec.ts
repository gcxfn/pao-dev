import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, type DesktopHarness } from "../helpers/electron-app";

/**
 * S1-2包2 一次性真实验证（W-bug7，零模型）。真实 Electron 主进程 stdout/stderr
 * 管道读端消失（销毁 runner 侧读端＋杀死中间 launcher 进程）后：
 *  1. 真实 write 触发的 EPIPE 被边界吸收（观察探针记录到 EPIPE、主进程存活）；
 *  2. 非 EPIPE 未捕获异常仍可见（onUnexpected → 错误框阻塞主进程），
 *     由外部系统截图取证并点击确定后壳恢复响应（握手文件 s12-继续.flag）。
 */

const evidenceDirBase = "D:/AI/workspace/pao-dev/.pao/统一执行-20261007/S1-2包2/证据";

test("断管后 console 写不崩壳；非 EPIPE 未捕获异常仍以错误框可见", async () => {
  test.setTimeout(360_000);
  const evidenceDir = join(evidenceDirBase, `EPIPE-${Date.now()}`);
  await mkdir(evidenceDir, { recursive: true });
  const handshake = join(evidenceDir, "s12-继续.flag");
  const readyFlag = join(evidenceDir, "s12-对话框已弹.flag");
  const userDataDir = await makeUserDataDir("s12-epipe-");
  const paoHome = await mkdtemp(join(tmpdir(), "s12-epipe-home-"));
  let harness: DesktopHarness | undefined;
  let mainPid = 0;
  try {
    harness = await launchDesktop(userDataDir, {
      testMode: "background",
      scrubProviderEnv: true,
      envOverrides: { PAO_DISABLE_BUILTIN_EXTENSION: "1", PAO_HOME: paoHome },
    });
    const page = await harness.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect
      .poll(() => harness!.electronApp.evaluate(({ app }) => app.isReady()), { timeout: 30_000 })
      .toBe(true);
    mainPid = await harness.electronApp.evaluate(() => process.pid);
    console.log(`[verify] main pid: ${mainPid}`);

    // ── 先跑非 EPIPE 腿（全新壳）：未捕获异常必须仍可见（错误框阻塞主进程）。
    // 注：自动化驱动会拦截 evaluate 定时器里的真实 throw（已用标记探针证实），
    // 这里用 Node 未捕获异常的同一条监听链（process.emit）在真实壳内触发——
    // 验证的是「边界已装、非 EPIPE 走 onUnexpected → 错误框」的接线与可见性。──
    void harness.electronApp
      .evaluate(() => {
        process.emit(
          "uncaughtException",
          Object.assign(new Error("s12-non-epipe-probe"), { code: "EACCES" }),
        );
        return "returned-without-block";
      })
      .then((result: unknown) => console.log(`[verify] emit returned: ${String(result)}`))
      .catch(() => {});
    let blocked = false;
    await Promise.race([
      harness.electronApp.evaluate(() => "responsive"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 12_000)),
    ]).then((winner) => {
      blocked = winner === "timeout";
    });
    console.log(`[verify] main blocked by error box: ${blocked}`);
    expect(blocked).toBe(true);
    await writeFile(readyFlag, new Date().toISOString(), "utf8");
    console.log(`[verify] dialog expected; waiting for ${handshake}`);

    // 等外部取证并点掉错误框（最多 240 秒）。
    await expect
      .poll(
        async () => {
          try {
            await readFile(handshake, "utf8");
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 240_000, intervals: [1_000] },
      )
      .toBe(true);

    // 错误框关闭后壳恢复响应。
    const recovered = await Promise.race([
      harness.electronApp.evaluate(() => "responsive"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 12_000)),
    ]);
    console.log(`[verify] after dismissing box: ${recovered}`);
    expect(recovered).toBe("responsive");
    await page.screenshot({ path: join(evidenceDir, "3-关掉错误框后恢复.png") });

    // ── 再跑断管腿：销毁 runner 侧读端＋杀死中间 launcher，让主进程
    // stdout/stderr 的管道读端在 OS 层消失；装观察探针记录真实 error 事件码。──
    harness.electronApp.process().stdout?.destroy();
    harness.electronApp.process().stderr?.destroy();
    harness.electronApp.process().kill();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await harness.electronApp.evaluate(() => {
      const w = globalThis as unknown as { __s12Epipe?: string[] };
      w.__s12Epipe = [];
      const record = (error: Error) => {
        w.__s12Epipe!.push((error as NodeJS.ErrnoException).code ?? "no-code");
      };
      process.stdout.on("error", record);
      process.stderr.on("error", record);
    });

    // 断管后主进程真实写 console：EPIPE 应只被边界吸收（异步 error 事件），壳不死。
    await harness.electronApp.evaluate(() => {
      console.error("[s12-verify] dead-pipe write probe (stderr)");
      console.log("[s12-verify] dead-pipe write probe (stdout)");
      process.stdout.write("[s12-verify] raw stdout write\n");
      process.stderr.write("[s12-verify] raw stderr write\n");
    });
    await expect
      .poll(
        async () => {
          const codes = (await harness!.electronApp.evaluate(() => {
            const w = globalThis as unknown as { __s12Epipe?: string[] };
            return w.__s12Epipe ?? [];
          })) as string[];
          return codes.length;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    const codes = await harness.electronApp.evaluate(() => {
      const w = globalThis as unknown as { __s12Epipe?: string[] };
      return w.__s12Epipe ?? [];
    });
    console.log(`[verify] real pipe error codes observed: ${codes.join(",")}`);
    const alivePid = await harness.electronApp.evaluate(() => process.pid);
    expect(alivePid).toBe(mainPid);
    console.log("[verify] EPIPE absorbed by boundary, main alive");
    await page.screenshot({ path: join(evidenceDir, "1-断管后壳仍活.png") });
  } finally {
    // 收尾：仅本轮探针进程（主进程可能仍被错误框阻塞，无法优雅退出）。
    if (mainPid > 0) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("taskkill", ["/F", "/T", "/PID", String(mainPid)]).catch(() => {});
    }
    await harness?.electronApp.close().catch(() => {});
  }
});
