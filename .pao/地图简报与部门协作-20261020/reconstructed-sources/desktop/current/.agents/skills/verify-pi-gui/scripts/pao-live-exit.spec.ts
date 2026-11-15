// 待主代理明确放行后才执行；真实composer→flow→部长/worker，无内部spawn测试hook。
import { test, expect } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  launchDesktop,
  startThreadFromSurface,
  type DesktopHarness,
} from "../../../../apps/desktop/tests/helpers/electron-app";
import { expectExtensionViewReady } from "../../../../apps/desktop/tests/helpers/desktop-extension-fixture";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const completeLines = (text: string) =>
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function ownedProcesses(root: number): Promise<{ProcessId:number;ParentProcessId:number;CreationDate:string;CommandLine:string}[]> {
  const { stdout } = await promisify(execFile)(
    "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine | ConvertTo-Json -Compress",
    ],
  );
  const rows = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; CreationDate:string; CommandLine:string }[];
  if (root === 0) return rows;
  const ids = new Set([root]);
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size;
    for (const row of rows) if (ids.has(row.ParentProcessId)) ids.add(row.ProcessId);
  }
  return rows.filter(row=>ids.has(row.ProcessId));
}
async function ownedTree(root:number):Promise<number[]>{return (await ownedProcesses(root)).map(row=>row.ProcessId);}

test("真实flow活部长和worker随本壳退出，独立实际对照继续", async () => {
  test.setTimeout(180_000);
  if (process.env.PAO_G3_LIVE_APPROVED !== "1")
    throw new Error("尚未获主代理放行本轮真实请求；只允许--list准备检查");
  const config = JSON.parse(await readFile(process.env.PAO_G3_LIVE_CONFIG!, "utf8")) as {
    project: string;
    profile: string;
    agentDir: string;
    home: string;
    evidence: string;
    command: { 名字: string; 卡目录: string; 参数?: Record<string, string> };
    mode: "正常关窗" | "强杀main";
    budgetPath: string;
    baselineUsed: number;
    independentPid: number;
    independentProgressPath: string;
    buildIdentity?: {path:string;sha256:string}[];
  };
  if (config.buildIdentity) {
    const { createHash } = await import("node:crypto");
    for (const file of config.buildIdentity)
      expect(createHash("sha256").update(await readFile(file.path)).digest("hex")).toBe(file.sha256);
  }
  if (!["正常关窗", "强杀main"].includes(config.mode)) throw new Error("未知关闭方式");
  if (!resolve(config.command.卡目录).startsWith(resolve(config.project) + sep))
    throw new Error("卡目录必须属于本轮隔离项目");
  const budget = async () => JSON.parse(await readFile(config.budgetPath, "utf8"));
  const before = await budget();
  expect(before).toMatchObject({ requests: 600, concurrency: 2 });
  expect(before.used - config.baselineUsed).toBeLessThan(12);
  expect(alive(config.independentPid)).toBe(true);
  await stat(config.independentProgressPath);
  await mkdir(config.evidence, { recursive: true });
  let harness: DesktopHarness | undefined;
  let mainPid = 0;
  let cutoff = false;
  let observerError: unknown;
  let primaryError: unknown;
  let capturedIds: number[] = [];
  // 同一600/2账本，12次停止留4次在途余量；最终仍严格核两场总增量≤16。
  const observer = setInterval(() => {
    void budget()
      .then((current) => {
        if (current.used - config.baselineUsed >= 12 && mainPid && alive(mainPid)) {
          cutoff = true;
          process.kill(mainPid);
        }
      })
      .catch((error) => {
        observerError = error;
        if (mainPid && alive(mainPid)) process.kill(mainPid);
      });
  }, 100);
  try {
    harness = await launchDesktop(config.profile, {
      agentDir: config.agentDir,
      initialWorkspaces: [config.project],
      scrubProviderEnv: true,
      envOverrides: {
        PI_APP_TEST_MODE: undefined,
        PAO_HOME: config.home,
        PAO_CODING_AGENT_DIR: config.agentDir,
        PAO_REQUEST_BUDGET: JSON.stringify({
          path: config.budgetPath,
          requests: 600,
          concurrency: 2,
        }),
        PAO_SESSION_BUDGET: '{"turns":3,"toolCalls":12}',
      },
    });
    await harness.focusWindow();
    const page = await harness.firstWindow();
    const doctor = await harness.electronApp.evaluate(({ BrowserWindow }) => ({
      pid: process.pid,
      visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
      testMode: process.env.PI_APP_TEST_MODE ?? null,
      testHooks: "__PI_APP_TEST_HOOKS" in globalThis,
    }));
    mainPid = doctor.pid;
    expect(doctor).toMatchObject({ visible: true, testMode: null, testHooks: false });
    const composer = page.getByTestId("composer");
    if (!(await composer.isVisible()))
      await startThreadFromSurface(page, { prompt: "/pao runtime" });
    await expect(composer).toBeVisible();
    await composer.fill(`/pao flow start ${JSON.stringify(config.command)}`);
    await composer.press("Enter");
    if (!(await page.getByTestId("workbench").isVisible()))
      await page.getByTestId("toggle-side-panel").click();
    await page.getByTestId("workbench-add-tab").click();
    await page
      .getByTestId("workbench-chooser")
      .getByRole("button", { name: "PAO 工作看板", exact: true })
      .click();
    await expectExtensionViewReady(page);
    const frame = page.frameLocator('[data-testid="extension-view-frame"]');
    let minister = 0;
    let worker = 0;
    let execution: Record<string, any> | undefined;
    let assistantSeen = false;
    await expect
      .poll(
        async () => {
          if (observerError) throw observerError;
          if (cutoff) throw new Error("本轮观察额度到12，已停止，禁止自动重跑");
          await frame.getByRole("button", { name: "刷新正本", exact: true }).click();
          const body = await frame.locator("main").innerText();
          minister = Number(/PID (\d+)/.exec(body)?.[1] ?? 0);
          try {
            for (const file of await readdir(join(config.project, ".pao", "执行映射"))) {
              const text = await readFile(join(config.project, ".pao", "执行映射", file), "utf8");
              const entries = completeLines(text);
              const entry = entries.find((item) => item.状态 === "运行中" && alive(item.pid));
              if (!entry || !resolve(entry.卡路径).startsWith(resolve(config.command.卡目录) + sep))
                continue;
              const session = (await readdir(entry.会话目录)).find((name) =>
                name.endsWith(`_${entry.执行标识}.jsonl`),
              );
              if (!session) continue;
              const messages = completeLines(await readFile(join(entry.会话目录, session), "utf8"));
              assistantSeen = messages.some(
                (item) =>
                  item.message?.role === "assistant" &&
                  item.message?.content?.some((part: { type: string }) => part.type === "toolCall"),
              );
              if (assistantSeen) {
                execution = entry;
                worker = entry.pid;
                break;
              }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (!(minister > 0 && worker > 0 && alive(minister) && alive(worker) && assistantSeen)) return false;
          try {
            const actual = await readFile(join(config.project, "校验结果.jsonl"), "utf8");
            return completeLines(actual).length > 0 && (await ownedTree(worker)).length > 1;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return false;
          }
        },
        { timeout: 120_000, intervals: [300] },
      )
      .toBe(true);
    expect((await budget()).used).toBeGreaterThan(before.used);
    const processIdentities = await ownedProcesses(mainPid);
    const tree = processIdentities.map(row=>row.ProcessId);
    capturedIds = tree;
    expect(tree).toContain(minister);
    expect(tree).toContain(worker);
    expect(tree).not.toContain(config.independentPid);
    const independentBefore = (await stat(config.independentProgressPath)).mtimeMs;
    await page.screenshot({ path: join(config.evidence, "真实活部长与worker.png") });
    await writeFile(
      join(config.evidence, "关闭前.json"),
      JSON.stringify({ doctor, minister, worker, execution, before, assistantSeen, tree, processIdentities, closingAt:new Date().toISOString() }, null, 2),
    );
    if (config.mode === "正常关窗") await page.close();
    else process.kill(mainPid);
    await expect.poll(() => tree.filter(alive), { timeout: 15_000 }).toEqual([]);
    await writeFile(join(config.evidence,"退出后身份核查.json"),JSON.stringify({at:new Date().toISOString(),remaining:(await ownedProcesses(0)).filter(row=>tree.includes(row.ProcessId))},null,2));
    expect(alive(config.independentPid)).toBe(true);
    await expect
      .poll(async () => (await stat(config.independentProgressPath)).mtimeMs, { timeout: 10_000 })
      .toBeGreaterThan(independentBefore);
    const after = await budget();
    expect(after.used - config.baselineUsed).toBeLessThanOrEqual(16);
    const outputAfterExit = await readFile(join(config.project, "校验结果.jsonl"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await readFile(join(config.project, "校验结果.jsonl"), "utf8")).toBe(outputAfterExit);
    expect((await budget()).used).toBe(after.used);
    await writeFile(
      join(config.evidence, "退出结果.json"),
      JSON.stringify(
        {
          mode: config.mode,
          mainPid,
          minister,
          worker,
          exited: true,
          independentPid: config.independentPid,
          independentProgressed: true,
          before,
          after,
          cutoff,
          outputStableAfterExit: true,
          requestsStableAfterExit: true,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    primaryError = error;
    await writeFile(join(config.evidence,"失败后身份核查.json"),JSON.stringify({at:new Date().toISOString(),remaining:(await ownedProcesses(0)).filter(row=>capturedIds.includes(row.ProcessId))},null,2));
    await writeFile(join(config.evidence,"主错误.json"),JSON.stringify({at:new Date().toISOString(),error:String(error),stack:error instanceof Error?error.stack:undefined},null,2));
    throw error;
  } finally {
    clearInterval(observer);
    try { await harness?.close(); }
    catch (error) {
      await writeFile(join(config.evidence,"清理错误.json"),JSON.stringify({at:new Date().toISOString(),error:String(error)},null,2));
      if (!primaryError) throw error;
    }
  }
});
