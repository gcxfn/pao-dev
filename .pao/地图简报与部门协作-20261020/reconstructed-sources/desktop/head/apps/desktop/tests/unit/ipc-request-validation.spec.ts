import { expect, test } from "@playwright/test";
import {
  expectAppView,
  expectCreateScheduledTaskInput,
  expectCreateWorkflowControllerInput,
  expectCustomProviderConfig,
  expectForkThreadInput,
  expectHostUiResponse,
  expectMcpServerScope,
  expectModelSettingsScopeMode,
  expectNewMcpServerInput,
  expectNoInput,
  expectNotificationPreferences,
  expectOptionalDeliverOptions,
  expectSessionTarget,
  expectSetChildSupervisionLoopInput,
  expectSetWorkflowTabsInput,
  expectStartThreadInput,
  expectStringArray,
  expectTerminalSize,
  expectThemeMode,
  expectThemePresetId,
  expectThinkingLevel,
  expectKanbanCardOpInput,
  expectWorkflowControlCommandInput,
  expectWorkflowControlQueryInput,
  expectWorkflowPreflightInput,
  expectWorkflowRecipeDeleteInput,
  expectWorkflowRecipeSaveInput,
  expectWorkflowStartInput,
} from "../../electron/ipc/request-validation";

test("删除配方输入校验：名字非空＋revision null 或非空（照保存口径，深度终判在内核）", () => {
  const input = { sessionId: "master", project: "/project", name: "旧流", revision: null };
  const parsed = expectWorkflowRecipeDeleteInput(input);
  expect(parsed.name).toBe("旧流");
  expect(parsed.revision).toBeNull();
  expect(expectWorkflowRecipeDeleteInput({ ...input, revision: "r1" }).revision).toBe("r1");
  expect(() => expectWorkflowRecipeDeleteInput({ ...input, revision: undefined })).toThrow();
  expect(() => expectWorkflowRecipeDeleteInput({ ...input, revision: "" })).toThrow();
  expect(() => expectWorkflowRecipeDeleteInput({ ...input, name: " " })).toThrow();
  expect(() => expectWorkflowRecipeDeleteInput({ ...input, sessionId: "" })).toThrow();
  expect(() => expectWorkflowRecipeDeleteInput({ ...input, project: "" })).toThrow();
});

test("新建配方使用显式 null，漏传或空版本仍拒绝", () => {
  const input = {
    sessionId: "master",
    project: "/project",
    recipe: { 名字: "新配方", 参数: [], 节点: [] },
    revision: null,
  };
  expect(expectWorkflowRecipeSaveInput(input).revision).toBeNull();
  expect(() => expectWorkflowRecipeSaveInput({ ...input, revision: undefined })).toThrow();
  expect(() => expectWorkflowRecipeSaveInput({ ...input, revision: "" })).toThrow();
});

test("向导配方骨架预检：节点行须为对象，三入口 IPC 层快速失败（透传口径，深度契约单源＝内核 parseRecipe）", () => {
  const base = { sessionId: "master", project: "/project" };
  const badRecipe = { 名字: "坏行配方", 参数: [], 节点: [{ 名字: "开发", 部门: "工程" }, 42] };
  expect(() =>
    expectWorkflowRecipeSaveInput({ ...base, recipe: badRecipe, revision: null }),
  ).toThrow("node objects");
  expect(() =>
    expectWorkflowPreflightInput({ project: "/project", recipe: badRecipe, parameters: {} }),
  ).toThrow("node objects");
  expect(() =>
    expectWorkflowStartInput({
      ...base,
      recipe: badRecipe,
      revision: "r1",
      masterTier: "主力",
      thinking: "high",
    }),
  ).toThrow("node objects");
  // 合法骨架按透传口径放行：字段内容不在本层校验，由内核终判。
  const ok = expectWorkflowPreflightInput({
    project: "/p",
    recipe: { 名字: "x", 参数: [], 节点: [] },
    parameters: {},
  });
  expect(ok.recipe).toEqual({ 名字: "x", 参数: [], 节点: [] });
});

test("IPC request validation returns a fresh trusted session target", () => {
  const request = { workspaceId: " workspace-a ", sessionId: " session-a " };

  const target = expectSessionTarget(request);

  expect(target).toEqual({ workspaceId: "workspace-a", sessionId: "session-a" });
  expect(target).not.toBe(request);
});

test("IPC request validation rejects malformed targets and string lists", () => {
  expect(() => expectSessionTarget({ workspaceId: "workspace-a" })).toThrow(
    "target.sessionId must be a string",
  );
  expect(() => expectSessionTarget({ workspaceId: "", sessionId: "session-a" })).toThrow(
    "target.workspaceId must not be empty",
  );
  expect(() => expectStringArray(["safe", 4], "order")).toThrow(
    "order must be an array of strings",
  );
});

test("IPC request validation allowlists composer delivery modes", () => {
  expect(expectOptionalDeliverOptions(undefined)).toBeUndefined();
  expect(expectOptionalDeliverOptions({ deliverAs: "steer" })).toEqual({ deliverAs: "steer" });
  expect(expectOptionalDeliverOptions({ deliverAs: "followUp" })).toEqual({
    deliverAs: "followUp",
  });
  expect(() => expectOptionalDeliverOptions({ deliverAs: "immediate" })).toThrow(
    "options.deliverAs must be steer or followUp",
  );
});

test("IPC request validation rejects unknown enum values", () => {
  expect(expectAppView("new-thread")).toBe("new-thread");
  expect(expectAppView("scheduled")).toBe("scheduled");
  expect(expectAppView("workboard")).toBe("workboard");
  expect(expectNoInput(undefined)).toBeUndefined();
  expect(() => expectNoInput({})).toThrow("This request takes no input");
  expect(expectThemeMode("dark")).toBe("dark");
  expect(expectThemePresetId("tokyo-night")).toBe("tokyo-night");
  expect(expectModelSettingsScopeMode("per-repo")).toBe("per-repo");
  expect(expectThinkingLevel("xhigh")).toBe("xhigh");

  expect(() => expectAppView("terminal")).toThrow("view must be a supported app view");
  expect(() => expectThemeMode("auto")).toThrow("mode must be system, light, or dark");
  expect(() => expectThemePresetId("solarized")).toThrow(
    "presetId must be a supported theme preset",
  );
  expect(() => expectModelSettingsScopeMode("workspace")).toThrow(
    "mode must be app-global or per-repo",
  );
  expect(() => expectThinkingLevel("ultra")).toThrow(
    "thinkingLevel must be a supported thinking level",
  );
});

test("IPC request validation decodes persisted settings records", () => {
  expect(
    expectNotificationPreferences({
      backgroundCompletion: true,
      backgroundFailure: false,
      attentionNeeded: true,
    }),
  ).toEqual({
    backgroundCompletion: true,
    backgroundFailure: false,
    attentionNeeded: true,
  });
  expect(() =>
    expectNotificationPreferences({
      backgroundCompletion: "yes",
      backgroundFailure: false,
      attentionNeeded: true,
    }),
  ).toThrow("preferences.backgroundCompletion must be a boolean");

  expect(
    expectCustomProviderConfig({
      providerId: "local",
      baseUrl: "http://localhost:8080",
      models: [{ id: "model-a", contextWindow: 32_000 }],
    }),
  ).toEqual({
    providerId: "local",
    baseUrl: "http://localhost:8080",
    apiKey: undefined,
    models: [{ id: "model-a", contextWindow: 32_000 }],
  });
  expect(() =>
    expectCustomProviderConfig({
      providerId: "local",
      baseUrl: "http://localhost:8080",
      models: [{ id: "model-a", contextWindow: -1 }],
    }),
  ).toThrow("config.models[0].contextWindow must be a positive integer");
});

test("IPC request validation checks discriminated command records", () => {
  expect(expectHostUiResponse({ requestId: "request-a", confirmed: false })).toEqual({
    requestId: "request-a",
    confirmed: false,
  });
  expect(() =>
    expectHostUiResponse({ requestId: "request-a", confirmed: true, cancelled: true }),
  ).toThrow("response must contain exactly one of value, confirmed, or cancelled");

  expect(
    expectForkThreadInput({
      sourceWorkspaceId: "workspace-a",
      sourceSessionId: "session-a",
      rootWorkspaceId: "workspace-a",
      environment: "local",
      position: "after",
      sourceMessageIndex: 3,
    }),
  ).toMatchObject({ environment: "local", position: "after", sourceMessageIndex: 3 });
  expect(() =>
    expectForkThreadInput({
      sourceWorkspaceId: "workspace-a",
      sourceSessionId: "session-a",
      rootWorkspaceId: "workspace-a",
      environment: "cloud",
    }),
  ).toThrow("input.environment must be local or worktree");

  expect(() =>
    expectSetChildSupervisionLoopInput({ childThreadId: "child-a", gate: "wake" }),
  ).toThrow("input.gate must be continue or stop");
  expect(() => expectTerminalSize({ cols: 0, rows: 24 })).toThrow(
    "size.cols must be a positive integer",
  );
});

test("notification checkbox patches validate only provided fields", () => {
  for (const key of ["backgroundCompletion", "backgroundFailure", "attentionNeeded"] as const) {
    expect(expectNotificationPreferences({ [key]: false })).toEqual({ [key]: false });
    expect(() => expectNotificationPreferences({ [key]: "false" })).toThrow(
      `preferences.${key} must be a boolean`,
    );
    expect(() => expectNotificationPreferences({ [key]: undefined })).toThrow(
      `preferences.${key} must be a boolean`,
    );
  }
  expect(expectNotificationPreferences({})).toEqual({});
});

test("IPC request validation rejects malformed scheduled tasks", () => {
  const target = { kind: "new-thread", workspaceId: "ws" };
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "",
      instruction: "do it",
      schedule: { kind: "once", at: "2026-09-21T12:00:00.000Z" },
      target,
    }),
  ).toThrow("input.title must not be empty");
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "   ",
      schedule: { kind: "once", at: "2026-09-21T12:00:00.000Z" },
      target,
    }),
  ).toThrow("input.instruction must not be empty");
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "do it",
      schedule: { kind: "interval", everyMs: 1_000 },
      target,
    }),
  ).toThrow(/everyMs/);
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "do it",
      schedule: { kind: "weekly", days: [], hour: 9, minute: 0, timeZone: "UTC" },
      target,
    }),
  ).toThrow(/days/);
  expect(() =>
    expectCreateScheduledTaskInput({
      title: "Ping",
      instruction: "do it",
      schedule: { kind: "daily", hour: 9, minute: 0, timeZone: "Not/A_Zone" },
      target,
    }),
  ).toThrow(/timeZone/);
});

test("IPC request validation passes new-thread extension flags through as booleans and strings", () => {
  const base = { rootWorkspaceId: "workspace-a", environment: "local" };

  expect(expectStartThreadInput(base).extensionFlags).toBeUndefined();
  expect(
    expectStartThreadInput({
      ...base,
      extensionFlags: { plan: true, "dry-run": false, env: "staging", preset: "" },
    }).extensionFlags,
  ).toEqual({ plan: true, "dry-run": false, env: "staging", preset: "" });

  expect(() => expectStartThreadInput({ ...base, extensionFlags: ["plan"] })).toThrow(
    "input.extensionFlags must be an object",
  );
  expect(() => expectStartThreadInput({ ...base, extensionFlags: { retries: 3 } })).toThrow(
    "input.extensionFlags.retries must be a boolean or string",
  );
  expect(() => expectStartThreadInput({ ...base, extensionFlags: { plan: null } })).toThrow(
    "input.extensionFlags.plan must be a boolean or string",
  );
  expect(() => expectStartThreadInput({ ...base, extensionFlags: { " ": true } })).toThrow(
    "flag names must be non-empty",
  );
});

test("IPC request validation accepts one MCP server shape and a known scope", () => {
  expect(expectNewMcpServerInput({ name: " docs ", command: "npx", args: ["-y", "a b"] })).toEqual({
    name: "docs",
    command: "npx",
    args: ["-y", "a b"],
  });
  expect(expectNewMcpServerInput({ name: "docs", command: "npx" })).toEqual({
    name: "docs",
    command: "npx",
    args: [],
  });
  expect(expectNewMcpServerInput({ name: "docs", url: "https://example.com/mcp" })).toEqual({
    name: "docs",
    url: "https://example.com/mcp",
  });
  expect(
    expectNewMcpServerInput({ name: "docs", description: "Team docs", url: "https://x.dev/mcp" }),
  ).toEqual({ name: "docs", description: "Team docs", url: "https://x.dev/mcp" });
  expect(() => expectNewMcpServerInput({ name: "docs", description: 1, command: "npx" })).toThrow(
    "server.description",
  );
  expect(() =>
    expectNewMcpServerInput({ name: "docs", url: "https://example.com/mcp", command: "npx" }),
  ).toThrow("either a url or a command");
  expect(() => expectNewMcpServerInput({ name: "", command: "npx" })).toThrow(
    "server.name must not be empty",
  );
  expect(() => expectNewMcpServerInput({ name: "docs", command: "npx", args: [1] })).toThrow(
    "server.args must be an array of strings",
  );
  for (const name of ["my docs", "docs.v2", "docs/api", "dócs"]) {
    expect(() => expectNewMcpServerInput({ name, command: "npx" })).toThrow(
      'server.name may only use letters, digits, "_" and "-"',
    );
  }
  expect(expectNewMcpServerInput({ name: "Docs_v2-beta", command: "npx" }).name).toBe(
    "Docs_v2-beta",
  );
  expect(expectMcpServerScope("project")).toBe("project");
  expect(() => expectMcpServerScope("extension")).toThrow("scope must be global or project");
});

test("实例路径字段：空白视为未提供，有值限长并拒绝 NUL", () => {
  expect(
    expectWorkflowControlQueryInput({
      workspaceId: "ws-a",
      instanceName: "安装",
      instancePath: "  /p/.pao/工作流-安装-1/工作流实例-安装.md  ",
    }),
  ).toEqual({
    workspaceId: "ws-a",
    instanceName: "安装",
    instancePath: "/p/.pao/工作流-安装-1/工作流实例-安装.md",
  });
  expect(
    expectWorkflowControlQueryInput({
      workspaceId: "ws-a",
      instanceName: "安装",
      instancePath: "  ",
    }),
  ).toEqual({ workspaceId: "ws-a", instanceName: "安装" });
  expect(() =>
    expectWorkflowControlQueryInput({
      workspaceId: "ws-a",
      instanceName: "安装",
      instancePath: `a${"b".repeat(4096)}`,
    }),
  ).toThrow("input.instancePath must be a filesystem path of at most 4096 characters");

  const parsed = expectSetWorkflowTabsInput({
    workflowTabs: [
      {
        id: "tab-run",
        workspaceId: "ws-a",
        title: "运行",
        mode: "runtime",
        instanceName: "安装",
        instancePath: "/p/.pao/工作流-安装-1/工作流实例-安装.md",
      },
    ],
    activeWorkflowTabId: "",
  });
  expect(parsed.workflowTabs[0]!.instancePath).toBe("/p/.pao/工作流-安装-1/工作流实例-安装.md");
});
test("画布页签元数据整表校验，重复 id 与悬空激活项拒绝", () => {
  const input = {
    workflowTabs: [
      {
        id: "tab-1",
        workspaceId: "ws-a",
        title: "安装",
        mode: "edit",
        recipeName: "安装",
        selectedElementId: `edge:${JSON.stringify(["开发", "审查", true])}`,
      },
      {
        id: "tab-2",
        workspaceId: "ws-a",
        title: "运行",
        mode: "runtime",
        controller: { workspaceId: "ws-a", sessionId: "s-1" },
      },
    ],
    activeWorkflowTabId: "tab-2",
  };

  const parsed = expectSetWorkflowTabsInput(input);
  expect(parsed).toEqual(input);
  expect(parsed.workflowTabs).not.toBe(input.workflowTabs);
  expect(parsed.workflowTabs[0]!.controller).toBeUndefined();

  expect(() => expectSetWorkflowTabsInput({ ...input, activeWorkflowTabId: "tab-9" })).toThrow(
    "input.activeWorkflowTabId must match one of input.workflowTabs",
  );
  expect(() => expectSetWorkflowTabsInput({ ...input, activeWorkflowTabId: "" })).not.toThrow();
  expect(() =>
    expectSetWorkflowTabsInput({
      ...input,
      workflowTabs: [{ id: "tab-1", workspaceId: "ws-a", title: "t", mode: "flow" }],
    }),
  ).toThrow("input.workflowTabs[0].mode must be edit or runtime");
  expect(() =>
    expectSetWorkflowTabsInput({
      ...input,
      workflowTabs: [input.workflowTabs[0], input.workflowTabs[0]],
    }),
  ).toThrow("input.workflowTabs[1].id is duplicated");
  expect(() =>
    expectSetWorkflowTabsInput({
      workflowTabs: [
        {
          id: "tab-1",
          workspaceId: "ws-a",
          title: "t",
          mode: "edit",
          controller: { workspaceId: "ws-a" },
        },
      ],
      activeWorkflowTabId: "tab-1",
    }),
  ).toThrow("input.workflowTabs[0].controller.sessionId must be a string");
  expect(() =>
    expectSetWorkflowTabsInput({ workflowTabs: [], activeWorkflowTabId: "", extra: 1 }),
  ).toThrow("input contains an unsupported field: extra");
});

test("新建 controller 保留可选 tabId，缺省时不带绑定", () => {
  const withTab = expectCreateWorkflowControllerInput({
    workspaceId: " ws-a ",
    title: "运行",
    tabId: " tab-1 ",
  });
  expect(withTab.workspaceId).toBe("ws-a");
  expect(withTab.title).toBe("运行");
  expect(withTab.tabId).toBe("tab-1");

  expect(expectCreateWorkflowControllerInput({ workspaceId: "ws-a" }).tabId).toBeUndefined();
  expect(() => expectCreateWorkflowControllerInput({ workspaceId: "ws-a", tabId: "" })).toThrow(
    "input.tabId must not be empty",
  );
});

test("运行控制入参只放行确认/暂停/恢复，轮次必须正整数且多余字段丢弃", () => {
  expect(
    expectWorkflowControlQueryInput({ workspaceId: " ws-a ", instanceName: " 安装 ", extra: 1 }),
  ).toEqual({ workspaceId: "ws-a", instanceName: "安装" });
  expect(() => expectWorkflowControlQueryInput({ workspaceId: "ws-a", instanceName: " " })).toThrow(
    "input.instanceName must not be empty",
  );

  const command = {
    workspaceId: "ws-a",
    sessionId: "s-1",
    instanceId: "ins-1",
    nodeName: "拆解",
    round: 2,
    action: "pause",
  };
  expect(
    expectWorkflowControlCommandInput({ ...command, reason: "等待人工检查", 名字: "伪造" }),
  ).toEqual({ ...command, reason: "等待人工检查" });
  expect(expectWorkflowControlCommandInput({ ...command, action: "confirm" })).toEqual({
    ...command,
    action: "confirm",
  });

  expect(() => expectWorkflowControlCommandInput({ ...command, action: "rule" })).toThrow(
    "input.action must be confirm, pause or resume",
  );
  expect(() => expectWorkflowControlCommandInput({ ...command, action: "stop" })).toThrow(
    "input.action must be confirm, pause or resume",
  );
  expect(() => expectWorkflowControlCommandInput({ ...command, round: 0 })).toThrow(
    "input.round must be a positive integer",
  );
  expect(() => expectWorkflowControlCommandInput({ ...command, round: 1.5 })).toThrow(
    "input.round must be a positive integer",
  );
  expect(() => expectWorkflowControlCommandInput({ ...command, nodeName: "" })).toThrow(
    "input.nodeName must not be empty",
  );
  expect(() => expectWorkflowControlCommandInput({ ...command, reason: 7 })).toThrow(
    "input.reason must be a string",
  );
});

test("看板卡操作入参：只收取消＋工作区/卡路径/卡号，多余字段丢弃，坏形状拒绝", () => {
  const input = {
    workspaceId: "ws-1",
    cardPath: "D:/项目/.pao/卡/卡0002-乙卡.md",
    cardNumber: 2,
    action: "取消",
    reason: "看板取消",
    extra: "多余字段",
  };
  const parsed = expectKanbanCardOpInput(input);
  expect(parsed).toEqual({
    workspaceId: "ws-1",
    cardPath: "D:/项目/.pao/卡/卡0002-乙卡.md",
    cardNumber: 2,
    action: "取消",
    reason: "看板取消",
  });
  expect(expectKanbanCardOpInput({ ...input, reason: undefined }).reason).toBeUndefined();
  // 桌面只代用户执行取消：其他动作（含完成）在入口即拒，不透传内核。
  expect(() => expectKanbanCardOpInput({ ...input, action: "已交付" })).toThrow();
  expect(() => expectKanbanCardOpInput({ ...input, action: "进行中" })).toThrow();
  expect(() => expectKanbanCardOpInput({ ...input, cardNumber: 1.5 })).toThrow();
  expect(() => expectKanbanCardOpInput({ ...input, cardNumber: -1 })).toThrow();
  expect(() => expectKanbanCardOpInput({ ...input, cardPath: "" })).toThrow();
  expect(() => expectKanbanCardOpInput({ ...input, workspaceId: "" })).toThrow();
  expect(() => expectKanbanCardOpInput({ ...input, reason: 42 })).toThrow();
});
