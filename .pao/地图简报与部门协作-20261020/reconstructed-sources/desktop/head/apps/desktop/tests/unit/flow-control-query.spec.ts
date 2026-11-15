import { expect, test } from "@playwright/test";
import type { PaoDesktopFlow, PaoDesktopFlowControlModule } from "@pi-gui/pi-sdk-driver";
import {
  WORKFLOW_CONTROL_ACTION_LABELS,
  WORKFLOW_CONTROL_ACTIONS,
  type WorkflowControlCommandInput,
} from "../../contracts/workflow-control";
import {
  createFlowControlQuery,
  normalizeFlowControl,
} from "../../electron/platform/pao/flow-control-query";

interface RunCall {
  readonly sessionId: string;
  readonly project: string;
  readonly params: Record<string, unknown>;
}

function desktopFlow(control: Partial<PaoDesktopFlow["控制"]> = {}): PaoDesktopFlow {
  return {
    路径: "/project/.pao/工作流实例-安装.md",
    控制: {
      实例: "ins-1",
      owner: "session-owner",
      工作流: "安装",
      卡目录: "/project/.pao/卡",
      状态: "挂起",
      暂停: "等人工核查后再推进",
      节点: [{ 名字: "拆解", 轮次: 2 }],
      ...control,
    },
    进度: {
      工作流: "安装",
      状态: "挂起",
      新建卡: [],
      节点: [
        {
          名字: "拆解",
          轮次: 2,
          状态: "in_progress",
          人工确认: true,
          挂起: "等人工核查后再推进",
        },
      ],
    },
  };
}

function moduleWith(
  flows: readonly PaoDesktopFlow[],
  issues: readonly { readonly 路径: string; readonly 说明: string }[] = [],
  onRun?: (call: RunCall) => void,
): PaoDesktopFlowControlModule {
  return {
    readDesktopFlows: () => ({ 工作流: [...flows], 问题: [...issues] }),
    runDesktopFlowCommand: async (sessionId, project, params) => {
      onRun?.({ sessionId, project, params: { ...params } });
    },
  };
}

const baseCommand = {
  workspaceId: "ws-a",
  sessionId: "session-other",
  instanceId: "ins-1",
  nodeName: "拆解",
  round: 2,
} as const;

test("动作集合只有内核支持的三类，暂停文案是暂停推进", () => {
  expect(WORKFLOW_CONTROL_ACTIONS).toEqual(["confirm", "pause", "resume"]);
  expect(WORKFLOW_CONTROL_ACTION_LABELS["pause"]).toBe("暂停推进");
  expect(Object.values(WORKFLOW_CONTROL_ACTION_LABELS).join("")).not.toContain("停止");
});

test("normalizeFlowControl 整形真值行，缺字段显式失败", () => {
  expect(normalizeFlowControl(desktopFlow())).toEqual({
    instanceId: "ins-1",
    ownerSessionId: "session-owner",
    recipeName: "安装",
    cardDir: "/project/.pao/卡",
    path: "/project/.pao/工作流实例-安装.md",
    status: "挂起",
    pauseReason: "等人工核查后再推进",
    nodes: [
      {
        name: "拆解",
        round: 2,
        requiresConfirmation: true,
        confirmed: undefined,
        hold: "等人工核查后再推进",
        status: "in_progress",
      },
    ],
  });
  expect(normalizeFlowControl(desktopFlow({ 暂停: undefined })).pauseReason).toBeUndefined();
  expect(() => normalizeFlowControl(desktopFlow({ 实例: "" }))).toThrow("实例缺失或为空");
  const noStatus = {
    ...desktopFlow(),
    进度: { ...desktopFlow().进度, 状态: "" },
  } as unknown as PaoDesktopFlow;
  expect(() => normalizeFlowControl(noStatus)).toThrow("控制进度状态缺失或为空");
  const noRound = {
    ...desktopFlow(),
    进度: { ...desktopFlow().进度, 节点: [{ ...desktopFlow().进度.节点[0], 轮次: 0 }] },
  } as unknown as PaoDesktopFlow;
  expect(() => normalizeFlowControl(noRound)).toThrow("控制节点轮次不是正整数");
});

test("collect 找不到、坏清单或不唯一都显式 failed，不谎报空实例", async () => {
  const missing = createFlowControlQuery({ loadModule: async () => moduleWith([]) });
  expect(await missing.collect("/project", "安装")).toEqual({
    state: "failed",
    message: "运行记录不在当前项目：安装",
  });

  const broken = createFlowControlQuery({
    loadModule: async () =>
      moduleWith([], [{ 路径: "/project/.pao/工作流实例-安装.md", 说明: "冻结配方缺失" }]),
  });
  expect(await broken.collect("/project", "安装")).toEqual({
    state: "failed",
    message: "控制清单不可读：冻结配方缺失",
  });

  const duplicated = createFlowControlQuery({
    loadModule: async () => moduleWith([desktopFlow(), desktopFlow({ 实例: "ins-2" })]),
  });
  expect(await duplicated.collect("/project", "安装")).toEqual({
    state: "failed",
    message: "运行记录不唯一，拒绝猜测：安装",
  });

  const unavailable = createFlowControlQuery({
    loadModule: async () => {
      throw new Error("缺少构建产物");
    },
  });
  expect(await unavailable.collect("/project", "安装")).toEqual({
    state: "failed",
    message: "缺少构建产物",
  });

  const malformed = createFlowControlQuery({
    loadModule: async () =>
      ({ readDesktopFlows: () => ({ 工作流: "坏", 问题: [] }) }) as unknown as PaoDesktopFlowControlModule,
  });
  expect((await malformed.collect("/project", "安装")).message).toContain("列表字段缺失");
});

test("同名多实例：带 instancePath 精确选择，缺省或路径不符显式拒绝", async () => {
  const first: PaoDesktopFlow = {
    ...desktopFlow(),
    路径: "/project/.pao/工作流-安装-1/工作流实例-安装.md",
  };
  const second: PaoDesktopFlow = {
    ...desktopFlow({ 实例: "ins-2" }),
    路径: "/project/.pao/工作流-安装-2/工作流实例-安装.md",
  };
  const query = createFlowControlQuery({ loadModule: async () => moduleWith([first, second]) });

  // 缺路径且同名多匹配：不猜，显式拒绝。
  expect(await query.collect("/project", "安装")).toEqual({
    state: "failed",
    message: "运行记录不唯一，拒绝猜测：安装",
  });
  // 带路径：只与磁盘发现行比对，精确选中同名实例中的第二个。
  const picked = await query.collect(
    "/project",
    "安装",
    "/project/.pao/工作流-安装-2/工作流实例-安装.md",
  );
  expect(picked.state).toBe("ok");
  if (picked.state !== "ok") throw new Error("unreachable");
  expect(picked.control.instanceId).toBe("ins-2");
  // 路径存在但清单坏：如实报原因，不谎报「不在当前项目」。
  const broken = createFlowControlQuery({
    loadModule: async () =>
      moduleWith(
        [first],
        [{ 路径: "/project/.pao/工作流-安装-3/工作流实例-安装.md", 说明: "冻结配方缺失" }],
      ),
  });
  expect(
    (await broken.collect("/project", "安装", "/project/.pao/工作流-安装-3/工作流实例-安装.md"))
      .message,
  ).toBe("控制清单不可读：冻结配方缺失");
  // 路径不匹配任何发现行：显式拒绝，不回退猜测。
  expect(
    (await query.collect("/project", "安装", "/project/.pao/工作流-安装-9/工作流实例-安装.md"))
      .message,
  ).toBe("运行记录路径不在当前项目：/project/.pao/工作流-安装-9/工作流实例-安装.md");
});
test("run 把 owner 与理由的业务判定交给内核，本桥只核请求关联并如实透传内核拒绝", async () => {
  const calls: RunCall[] = [];
  const query = createFlowControlQuery({
    loadModule: async () => moduleWith([desktopFlow()], [], (call) => calls.push(call)),
  });

  // 非 owner 的确认不在桌面层拦截：带磁盘真值原样转交，owner 校验由内核执行（T08 共用业务）。
  expect(await query.run("/project", { ...baseCommand, action: "confirm" })).toEqual({ state: "ok" });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.sessionId).toBe("session-other");
  expect(calls[0]?.params).toMatchObject({ action: "confirm", prev_owner: "session-owner" });

  // 内核拒绝（owner 校验、在途卡等）如实落成 error，不抛顶层。
  const rejecting = createFlowControlQuery({
    loadModule: async () =>
      moduleWith([desktopFlow()], [], () => {
        throw new Error("请跳转原 owner 会话处理");
      }),
  });
  expect(await rejecting.run("/project", { ...baseCommand, action: "confirm" })).toEqual({
    state: "error",
    message: "请跳转原 owner 会话处理",
  });

  // 恢复缺现场核查说明同样交内核判定（resumeControl 拒「恢复身份不符或缺现场核查说明」），
  // 桌面层不预判理由规则；空理由不携带 reason 键。
  calls.length = 0;
  expect(await query.run("/project", { ...baseCommand, action: "resume" })).toEqual({ state: "ok" });
  expect(calls[0]?.params).toMatchObject({ action: "resume" });
  expect(calls[0]?.params).not.toHaveProperty("reason");

  expect(
    await query.run("/project", {
      ...baseCommand,
      action: "resume",
      reason: "已确认在途卡处理完，人工接管",
    }),
  ).toEqual({ state: "ok" });
  expect(calls[1]?.params).toEqual({
    name: "安装",
    cards_dir: "/project/.pao/卡",
    instance: "ins-1",
    node: "拆解",
    round: 2,
    action: "resume",
    reason: "已确认在途卡处理完，人工接管",
    prev_owner: "session-owner",
  });
});

test("run 复核节点与轮次（请求关联：提交的动作必须是用户所见状态），过期即拒绝", async () => {
  const calls: RunCall[] = [];
  const ownerCommand = { ...baseCommand, sessionId: "session-owner", action: "pause" as const };
  const query = createFlowControlQuery({
    loadModule: async () => moduleWith([desktopFlow()], [], (call) => calls.push(call)),
  });

  expect(await query.run("/project", { ...ownerCommand, nodeName: "旧节点" })).toEqual({
    state: "error",
    message: "节点或轮次已变化，请刷新后重试。",
  });
  expect(await query.run("/project", { ...ownerCommand, round: 3 })).toEqual({
    state: "error",
    message: "节点或轮次已变化，请刷新后重试。",
  });
  expect(calls).toHaveLength(0);

  expect(await query.run("/project", ownerCommand)).toEqual({ state: "ok" });
  expect(calls[0]?.params).toEqual({
    name: "安装",
    cards_dir: "/project/.pao/卡",
    instance: "ins-1",
    node: "拆解",
    round: 2,
    action: "pause",
    prev_owner: "session-owner",
  });
  expect(calls[0]?.params).not.toHaveProperty("reason");
});

test("run 只把磁盘真值写进内核参数，渲染层多余字段不入参", async () => {
  const calls: RunCall[] = [];
  const query = createFlowControlQuery({
    loadModule: async () => moduleWith([desktopFlow()], [], (call) => calls.push(call)),
  });
  const forged = {
    ...baseCommand,
    sessionId: "session-owner",
    action: "pause",
    reason: "暂停推进待核查",
    name: "伪造配方",
    cards_dir: "/伪造/卡",
    prev_owner: "伪造 owner",
    rule: "裁定",
    result: "pass",
    references: ["伪造证据"],
  } as unknown as WorkflowControlCommandInput;

  expect(await query.run("/project", forged)).toEqual({ state: "ok" });
  expect(calls[0]?.params).toEqual({
    name: "安装",
    cards_dir: "/project/.pao/卡",
    instance: "ins-1",
    node: "拆解",
    round: 2,
    action: "pause",
    reason: "暂停推进待核查",
    prev_owner: "session-owner",
  });
});

test("run 把内核拒绝如实落成 error，不抛顶层", async () => {
  const query = createFlowControlQuery({
    loadModule: async () =>
      moduleWith([desktopFlow()], [], () => {
        throw new Error("仍有在途卡，先确认停止及卡状态");
      }),
  });
  expect(
    await query.run("/project", {
      ...baseCommand,
      sessionId: "session-owner",
      action: "resume",
      reason: "人工接管",
    }),
  ).toEqual({ state: "error", message: "仍有在途卡，先确认停止及卡状态" });
});
