// 用途：新构建后的真实Electron机械维护关闭验收；输入已有隔离profile；输出明确fixture和真实生命周期证据。
// 不调用模型，不注册测试hook，不直接调用调度API；任务文件经正式main读取。
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  launchDesktop,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";
const run = promisify(execFile);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function mechanicalChild(parent: number): Promise<number | null> {
  const { stdout } = await run("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parent}' | Where-Object { $_.CommandLine -like '*maintenance-worker.mjs*' } | Select-Object -ExpandProperty ProcessId`,
  ]);
  const value = Number(stdout.trim());
  return value > 0 ? value : null;
}
for (const mode of ["正常关最后窗口", "强杀桌面主进程"] as const) {
  test(`真实机械维护：${mode}停止活任务且不误杀独立进程`, async () => {
    test.setTimeout(120_000);
    if (process.env.PAO_G3_NEW_BUILD_CONFIRMED !== "1")
      throw new Error("必须先由主代理确认新PAO/driver/Electron构建；不拿旧dist验新实现");
    const root = process.env.PAO_BOARD_PRIVATE_ROOT!;
    const evidence = join(process.env.PI_GUI_PROOF_DIR!, mode);
    if (!root || !process.env.PI_GUI_PROOF_DIR) throw new Error("缺隔离profile或证据目录");
    await mkdir(evidence, { recursive: true });
    const home = join(root, `机械维护夹具-${mode}-${Date.now()}`);
    const old = join(home, "定时", "留档", "明确归档夹具");
    await mkdir(old, { recursive: true });
    // 大量明确成功夹具使正式归档有可观察的在途工作；并不冒充真实历史成功。
    for (let i = 0; i < 6000; i++)
      await writeFile(
        join(old, `${new Date(1e12 + i * 1000).toISOString().replace(/:/g, "-")}.md`),
        '明确测试夹具，无模型成果\n<!-- PAO机械结算:{"taskId":"明确归档夹具","success":true} -->\n',
      );
    const state = JSON.parse(await readFile(join(root, "profile", "ui-state.json"), "utf8"));
    let harness: DesktopHarness | undefined;
    const independent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      harness = await launchDesktop(join(root, "profile"), {
        agentDir: join(root, "agent"),
        initialWorkspaces: [state.selectedWorkspaceId],
        scrubProviderEnv: true,
        envOverrides: {
          PI_APP_TEST_MODE: undefined,
          PAO_HOME: home,
          PAO_CODING_AGENT_DIR: join(root, "agent"),
          PAO_SESSION_BUDGET: '{"turns":0}',
        },
      });
      await harness.focusWindow();
      const page = await harness.firstWindow();
      await expect(page.getByTestId("composer")).toBeVisible();
      const doctor = await harness.electronApp.evaluate(({ BrowserWindow }) => ({
        pid: process.pid,
        visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
        testMode: process.env.PI_APP_TEST_MODE ?? null,
        testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
      }));
      expect(doctor).toMatchObject({ visible: true, testMode: null, testHooks: false });
      // 到这一步才放enabled任务，防启动阶段已跑完。没有改正式PAO_HOME。
      await writeFile(
        join(home, "定时", "关闭测试.json"),
        JSON.stringify({
          id: "关闭测试",
          名: "明确机械关闭验收夹具",
          prompt: "仅做白名单归档；非模型任务",
          cron: "* * * * * *",
          工作目录: home,
          工具白名单: ["归档"],
          repeat: true,
          enabled: true,
        }),
      );
      let child: number | null = null;
      await expect
        .poll(
          async () => {
            child = await mechanicalChild(doctor.pid);
            return child;
          },
          { timeout: 20_000, intervals: [100, 200] },
        )
        .not.toBeNull();
      expect(alive(child!)).toBe(true);
      const runDir = join(home, "定时", "留档", "关闭测试");
      const receipts = await readdir(runDir);
      const receipt = join(runDir, receipts.at(-1)!);
      expect(await readFile(receipt, "utf8")).not.toContain('"success":true');
      await page.screenshot({ path: join(evidence, "活机械任务时真实窗口.png") });
      if (mode === "正常关最后窗口") await page.close();
      else process.kill(doctor.pid);
      await expect.poll(() => alive(child!), { timeout: 10_000 }).toBe(false);
      await expect.poll(() => alive(doctor.pid), { timeout: 10_000 }).toBe(false);
      expect(alive(independent.pid!)).toBe(true);
      const count = (await readdir(old)).length;
      // 已启动任务必须确实中断，若已正常完成则不伪称验到在途停止。
      expect(count).toBeGreaterThan(30);
      await new Promise((r) => setTimeout(r, 1200));
      expect((await readdir(old)).length).toBe(count);
      expect(await readdir(runDir)).toEqual(receipts);
      await writeFile(
        join(evidence, "result.json"),
        JSON.stringify(
          {
            doctor,
            child,
            independent: independent.pid,
            remaining: count,
            home,
            receipt,
            passed: [
              "真实窗口无test hooks",
              "正式main读取任务并启动真实worker",
              mode,
              "活任务停止且无继续删除/新增执行",
              "独立进程仍存活",
            ],
            boundary: "明确文件夹具，无模型调用；不代替部长/worker真实图形任务验收",
          },
          null,
          2,
        ),
      );
    } finally {
      independent.kill();
      try {
        await harness?.close();
      } catch (error) {
        await writeFile(join(evidence, "关闭观察.txt"), String(error));
      }
    }
  });
}
