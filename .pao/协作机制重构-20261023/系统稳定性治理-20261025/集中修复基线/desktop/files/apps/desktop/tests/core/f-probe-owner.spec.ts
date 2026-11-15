import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

const REGISTRY = `# 部门注册表

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-14 |
`;

/**
 * 临时探针（F2 取证用）：owner 会话 id 由环境变量 OMIT 后由本文件回填。
 * 先建桌面会话拿到 sessionId，再生成控制正本并把 owner 写成该 sessionId，
 * 最后点确认按钮，看内核给的是「成功」还是「owner 不可用」。
 */
const FIXTURE_SCRIPT = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDist, project, ownerSessionId] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(join(kernelDist, relative)).href);

const plan = await load("workflow/plan.js");
const driver = await load("workflow/driver.js");
const control = await load("workflow/control.js");
const cards = await load("cards/index.js");

const created = await plan.createTemporaryPlan({
  项目根: project,
  显示名: "owner 探针",
  来源会话: ownerSessionId,
  请求ID: "req-probe-1",
  已注册部门: ["策划部"],
  步骤: [{ 标题: "讨论计划", 部门: "策划部", 要求: "讨论清楚", 人工门: true }],
  当刻: "2026-10-16 10:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-probe-1",
  定义版本: 1,
  来源会话: ownerSessionId,
});
await driver.startWorkflow(execution.配方, {}, {
  cardsDir: execution.卡目录,
  workspaceDir: execution.工作区,
  ownerSessionId,
});
const identity = plan.readPlanInstanceIdentity(execution.工作区, execution.配方名);
if (!identity) throw new Error("实例身份读不出来");
plan.recordPlanStart(execution.关联路径, {
  计划ID: created.计划ID,
  定义版本: 1,
  启动请求ID: "start-probe-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: ownerSessionId,
  受理时刻: "2026-10-16 10:01",
});

const options = { cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId };
const identityOf = { 实例: identity.实例, 节点: "s1", 轮次: 1, 部长会话: ownerSessionId };
await control.bindMinister(execution.配方, options, "s1", ownerSessionId);
const [card] = await control.addNodeCards(execution.配方, options, identityOf, [
  { goal: "讨论清楚", acceptance: "讨论到位" },
]);
cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(card)), {
  操作者: ownerSessionId, to: "in_progress", 时间: "2026-10-16 10:05",
});
cards.changeCardStatus(cards.loadCard(execution.卡目录, cards.parseCardRef(card)), {
  操作者: ownerSessionId, to: "delivered", 时间: "2026-10-16 10:20",
});
await control.endDecomposition(execution.配方, options, identityOf);
console.log(JSON.stringify({
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  控制清单: execution.控制清单,
}));
`;

test("probe: does a desktop session act as a real control owner", async () => {
  test.setTimeout(180_000);
  const home = await makeWorkspace("f-probe2-home");
  const project = await makeWorkspace("f-probe2-project");
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");

  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    // 关键：只有加载内置 pao 扩展，内核才会 registerDesktopOwner（owners.ts:27-52 由内核主扩展注册）。
    // 首次探针用的是 "1"，等于自己把 owner 关掉了，结论只能是「owner 不可用」——那是自造的。
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });

  try {
    const page = await app.firstWindow();
    await createNamedThread(page, "owner 探针会话");
    const state = await getDesktopState(page);
    const workspace = state.workspaces.find((entry) => entry.path === project);
    const sessionId = workspace?.sessions[0]?.id;
    expect(sessionId, "拿不到会话 id").toBeTruthy();
    console.log("PROBE2-SESSION", sessionId);

    const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
    const scriptPath = join(home, "make-probe2-fixture.mjs");
    await writeFile(scriptPath, FIXTURE_SCRIPT, "utf8");
    const { stdout } = await execFileAsync(
      process.execPath,
      [scriptPath, kernelDist, project, sessionId!],
      { windowsHide: true },
    );
    const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      实例: string;
      配方名: string;
      工作区: string;
      控制清单: string;
    };
    console.log("PROBE2-FIXTURE", JSON.stringify(fixture));
    const controlBefore = await readFile(fixture.控制清单, "utf8");
    console.log("PROBE2-CONTROL-BEFORE-LEN", controlBefore.length);

    await page.getByTestId("task-status-open-workflow").click();
    await expect(page.getByTestId("workflow-cards-title")).toContainText("owner 探针", {
      timeout: 20_000,
    });
    console.log("PROBE2-RENDERED");

    // 直接打真实 IPC 的确认动作，看内核 owner 校验的原文。
    const result = await page.evaluate(
      async ({ workspaceId, sessionId: ownerId, instanceId, node, round }) => {
        const api = globalThis.window.piApp;
        if (!api) return { error: "no piApp" };
        try {
          const value = await api.controlWorkflow({
            workspaceId,
            sessionId: ownerId,
            instanceId,
            nodeName: node,
            round,
            action: "confirm",
          });
          return { value };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
      {
        workspaceId: workspace!.id,
        sessionId: sessionId!,
        instanceId: fixture.实例,
        node: "s1",
        round: 1,
      },
    );
    console.log("PROBE2-CONTROL-RESULT", JSON.stringify(result));
    const controlAfter = await readFile(fixture.控制清单, "utf8");
    console.log("PROBE2-CONTROL-CHANGED", controlAfter !== controlBefore);
  } finally {
    await app.close();
  }
});
