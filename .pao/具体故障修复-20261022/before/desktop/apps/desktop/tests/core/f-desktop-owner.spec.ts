import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

/**
 * F 批 · T15：活 owner 会话的控制动作（暂停真成功 / 人工门确认真放行 / 确认被拒如实报错）。
 *
 * 三个动作分别验什么：
 * - **暂停**（pause）在内核里只走 `pauseControl`，不经过 `ctx.ui.confirm`——
 *   PAO/packages/coding-agent/src/pao/workflow/tools.ts:544 的确认守卫只拦 `["confirm","resume"]`。
 *   这条验「点了真的改变控制正本」。
 * - **确认放行**（confirm）要过 `ctx.ui.confirm`。桌面 driver 的 `createDialogPromise` 原先在调用方
 *   不传 `opts.timeout` 时直接返回默认值 false（`desktop/packages/pi-sdk-driver/src/session-supervisor.ts:2282-2284`
 *   的提前返回），而内核五处 `ui.confirm` 全都没传 timeout，所以确认在桌面上**曾经恒失败**。
 *   该缺陷已由 lead 修复（删掉那个提前返回），本文件据此改验**成功路径**：发起 → 从快照读 pendingDialogs →
 *   是真的点确认 → 内核放行 → 控制正本落时间戳。
 * - **确认被拒**：用户点取消时内核必须拒放行、控制正本逐字节不变——「用户拒绝 ≠ 成功」的实证。
 *
 * 交互式 IPC 的取证模式（本批踩坑所得）：`controlWorkflow` 是「请求-响应 + 期间需要用户介入」的调用，
 * **不能先 await 它**再去找对话框，否则永久挂起到超时。正确姿势：先拿 promise 不 await →
 * 轮询快照 `sessionExtensionUiBySession["<ws>:<sid>"].pendingDialogs` 读 `requestId` →
 * 调 `piApp.respondToHostUiRequest` 回答 → 再 await 结果。
 */

/** 部门注册表：夹具脚本建计划前要先过部门校验。 */
const REGISTRY = `# 部门注册表

| 名字 | 能力标签 | 库路径 | 建部日期 |
| --- | --- | --- | --- |
| 策划部 | 策划 | 部门/策划部/知识库 | 2026-10-14 |
`;

/**
 * 夹具：造一份真实临时计划 + 实例，并把控制正本的 owner 写成**真实桌面会话 id**。
 *
 * owner 必须是真的桌面会话，否则内核 `desktopOwner()`（PAO/packages/coding-agent/src/pao/desktop/owners.ts:60-65）
 * 会以「原会话 owner 不可用或已切换」拒掉，那验到的就不是控制链路而是身份校验。
 * 两个步骤：s1 带人工门（供确认用），s2 是普通可运行步骤（供暂停用）。
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
  显示名: "F15 控制场景",
  来源会话: ownerSessionId,
  请求ID: "req-f15-1",
  已注册部门: ["策划部"],
  步骤: [
    { 标题: "讨论计划", 部门: "策划部", 要求: "讨论清楚", 人工门: true },
    { 标题: "照计划干活", 部门: "策划部", 要求: "按计划产出" },
  ],
  当刻: "2026-10-16 10:00",
});
const execution = plan.resolvePlanExecution({
  项目根: project,
  计划ID: created.计划ID,
  启动请求ID: "start-f15-1",
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
  启动请求ID: "start-f15-1",
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  卡目录: execution.卡目录,
  控制清单: execution.控制清单,
  owner会话: ownerSessionId,
  受理时刻: "2026-10-16 10:01",
});

// 让 s1 真的够格被确认：confirmControl（workflow/control.ts:677-685）要求
// 节点定义有人工确认、轮次匹配、拆解结束、**每张卡都 delivered**。
// 只标「人工门: true」不建卡是不够的——那样点击确认只会得到「旧确认或节点尚未满足确认条件」。
const options = { cardsDir: execution.卡目录, workspaceDir: execution.工作区, ownerSessionId };
const identityOf = { 实例: identity.实例, 节点: "s1", 轮次: 1, 部长会话: ownerSessionId };
await control.bindMinister(execution.配方, options, "s1", ownerSessionId);
const [s1Card] = await control.addNodeCards(execution.配方, options, identityOf, [
  { goal: "讨论清楚", acceptance: "讨论到位" },
]);
const card = () => cards.loadCard(execution.卡目录, cards.parseCardRef(s1Card));
cards.changeCardStatus(card(), { 操作者: ownerSessionId, to: "in_progress", 时间: "2026-10-16 10:05" });
cards.changeCardStatus(card(), { 操作者: ownerSessionId, to: "delivered", 时间: "2026-10-16 10:20" });
await control.endDecomposition(execution.配方, options, identityOf);

console.log(JSON.stringify({
  实例: identity.实例,
  配方名: execution.配方名,
  工作区: execution.工作区,
  控制清单: execution.控制清单,
}));
`;

interface ControlFixture {
  readonly 实例: string;
  readonly 配方名: string;
  readonly 工作区: string;
  readonly 控制清单: string;
}

/**
 * 起夹具：先开桌面、建真实会话拿 sessionId，再用该 id 造计划。
 * `PAO_DISABLE_BUILTIN_EXTENSION` 必须是 "0"——helper 默认给 "1"，那样内置 pao 扩展不加载、
 * `registerDesktopOwner` 不执行，控制动作只会在身份校验上失败（详见本批踩坑记录）。
 */
async function launchControlFixture(prefix: string) {
  const home = await makeWorkspace(`${prefix}-home`);
  const project = await makeWorkspace(`${prefix}-project`);
  await mkdir(join(home, "部门"), { recursive: true });
  await writeFile(join(home, "部门", "注册表.md"), REGISTRY, "utf8");

  const userDataDir = await makeUserDataDir();
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }), "utf8");
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [project],
    testMode: "foreground",
    scrubProviderEnv: true,
    envOverrides: { PAO_HOME: home, PAO_DISABLE_BUILTIN_EXTENSION: "0" },
  });

  const page = await app.firstWindow();
  await createNamedThread(page, `${prefix} 会话`);
  const state = await getDesktopState(page);
  const workspace = state.workspaces.find((entry) => entry.path === project);
  const sessionId = workspace?.sessions[0]?.id;
  if (!workspace || !sessionId) {
    await app.close();
    throw new Error("拿不到夹具工作区或会话 id");
  }

  const kernelDist = join(__dirname, "../../node_modules/@earendil-works/pi-coding-agent/dist/pao");
  const scriptPath = join(home, "make-f15-fixture.mjs");
  await writeFile(scriptPath, FIXTURE_SCRIPT, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, kernelDist, project, sessionId], {
    windowsHide: true,
  });
  const fixture = JSON.parse(stdout.trim().split("\n").at(-1)!) as ControlFixture;

  await page.getByTestId("task-status-open-workflow").click();
  await expect(page.getByTestId("workflow-cards-title")).toContainText("F15 控制场景", {
    timeout: 20_000,
  });
  return { app, page, project, workspaceId: workspace.id, sessionId, fixture };
}

/** 读控制正本：判断动作到底有没有真的写盘，这是「真成功」与「嘴上成功」的分水岭。 */
async function readControl(fixture: ControlFixture): Promise<string> {
  return readFile(fixture.控制清单, "utf8");
}

/** 经真实 IPC 打一个控制动作，返回内核原文。 */
async function controlWorkflow(
  page: Page,
  options: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly instanceId: string;
    readonly node: string;
    readonly round: number;
    readonly action: string;
    readonly reason?: string;
  },
): Promise<{ state?: string; message?: string }> {
  return page.evaluate(
    async ({ workspaceId, sessionId, instanceId, node, round, action, reason }) => {
      const api = globalThis.window.piApp;
      if (!api) throw new Error("piApp IPC 不可用");
      return api.controlWorkflow({
        workspaceId,
        sessionId,
        instanceId,
        nodeName: node,
        round,
        action,
        ...(reason === undefined ? {} : { reason }),
      });
    },
    options,
  );
}

test("T15 暂停经界面真受理：控制正本落挂起原因，界面按回执显示而不是自己编", async () => {
  const { app, page, workspaceId, sessionId, fixture } = await launchControlFixture("f15-pause");
  try {
    const before = await readControl(fixture);
    // 前置：暂停前控制正本里没有这条挂起原因，避免「本来就有」的假通过。
    expect(before).not.toContain("F 批验证挂起原因");

    // 暂停必须有理由，否则界面当场拦下（workflow-cards-view.tsx:396-431）。
    const result = await controlWorkflow(page, {
      workspaceId,
      sessionId,
      instanceId: fixture.实例,
      node: "s2",
      round: 1,
      action: "pause",
      reason: "F 批验证挂起原因",
    });

    // 真受理：内核返回 ok（不是 error），这是「真成功」而不是「点了没报错」。
    expect(result.state, `内核没受理暂停：${JSON.stringify(result)}`).toBe("ok");

    // 关键断言：控制正本真的写了这条理由——回执不是界面编的。
    const after = await readControl(fixture);
    expect(after).not.toBe(before);
    expect(after).toContain("F 批验证挂起原因");
  } finally {
    await app.close();
  }
});

test("T15 人工门确认经界面真受理：点确认后内核放行，控制正本真的落确认记录", async () => {
  const { app, page, workspaceId, sessionId, fixture } = await launchControlFixture("f15-confirm");
  try {
    const before = await readControl(fixture);
    // 前置：确认前控制正本里没有这条确认时间戳，避免「本来就有」的假通过。
    // 注意格式：`确认:` 是节点下的缩进子字段（`  确认: 2026-10-17T...`），不是行首，所以不能用 ^ 锚定。
    expect(before).not.toMatch(/\n\s*确认:/);

    // 关键姿势：controlWorkflow 会一直等人工门对话框被回答，所以**不能先 await 它**。
    // 先发起，再把对话框答掉，最后收结果（见 f-desktop-owner 交付记录里的时序坑）。
    const pending = controlWorkflow(page, {
      workspaceId,
      sessionId,
      instanceId: fixture.实例,
      node: "s1",
      round: 1,
      action: "confirm",
    });

    // 等内核真的把确认请求送到宿主：主进程快照里的 pendingDialogs 挂着这条 confirm。
    let requestId = "";
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(page);
          const dialogs =
            state.sessionExtensionUiBySession?.[`${workspaceId}:${sessionId}`]?.pendingDialogs;
          requestId = dialogs?.find((entry) => entry.kind === "confirm")?.requestId ?? "";
          return requestId;
        },
        { timeout: 20_000, message: "内核没把人工门确认请求送到宿主" },
      )
      .not.toBe("");

    // 真人点「确认」：把回答交回内核。
    await page.evaluate(
      async ({ workspaceId, sessionId, requestId }) => {
        const api = globalThis.window.piApp;
        if (!api) throw new Error("piApp IPC 不可用");
        await api.respondToHostUiRequest(workspaceId, sessionId, { requestId, confirmed: true });
      },
      { workspaceId, sessionId, requestId },
    );

    const result = await pending;

    // 真受理：内核放行，不是在界面上假装通过。
    expect(result.state, `内核没放行确认：${JSON.stringify(result)}`).toBe("ok");

    // 关键断言：控制正本真的落了确认记录——成功有真实凭据，不是界面自己编的。
    const after = await readControl(fixture);
    expect(after).not.toBe(before);
    expect(after).toMatch(/\n\s*确认: \d{4}-\d{2}-\d{2}T/);
  } finally {
    await app.close();
  }
});

test("T15 确认被拒绝时如实报错、不动控制正本，不显示成成功", async () => {
  const { app, page, workspaceId, sessionId, fixture } = await launchControlFixture("f15-reject");
  try {
    const before = await readControl(fixture);

    const pending = controlWorkflow(page, {
      workspaceId,
      sessionId,
      instanceId: fixture.实例,
      node: "s1",
      round: 1,
      action: "confirm",
    });

    // 等到对话框出现，然后点「取消」——用户主动拒绝必须如实反映。
    let dialogRequestId = "";
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(page);
          const dialogs =
            state.sessionExtensionUiBySession?.[`${workspaceId}:${sessionId}`]?.pendingDialogs;
          const found = dialogs?.find((entry) => entry.kind === "confirm");
          dialogRequestId = found?.requestId ?? "";
          return dialogRequestId;
        },
        { timeout: 20_000, message: "内核没把人工门确认请求送到宿主" },
      )
      .not.toBe("");

    await page.evaluate(
      async ({ workspaceId, sessionId, requestId }) => {
        const api = globalThis.window.piApp;
        if (!api) throw new Error("piApp IPC 不可用");
        await api.respondToHostUiRequest(workspaceId, sessionId, { requestId, confirmed: false });
      },
      { workspaceId, sessionId, requestId: dialogRequestId },
    );

    const result = await pending;

    // 拒绝 → 内核拒绝放行，界面必须如实报错（不能把「没点确认」当成「确认过了」）。
    expect(result.state).toBe("error");
    expect(result.message ?? "").toContain("须用户在界面显式确认");

    // 无论如何，没成功就不能动控制正本——「未知不译成成功」的最后一道实证。
    const after = await readControl(fixture);
    expect(after).toBe(before);
  } finally {
    await app.close();
  }
});

