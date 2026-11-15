import { expect, test } from "@playwright/test";
import { createEmptyDesktopAppState } from "../../contracts/desktop-state";
import type { SideChatSnapshot } from "@pi-gui/session-driver";
import type { KanbanCard, KanbanResult } from "../../contracts/kanban";
import {
  activeSessionForPanel,
  deliveryRecords,
  identityForDepartment,
  selectCurrentDepartmentGroup,
} from "../../src/features/workboard/department-execution-panel";
import {
  displayedSideChat,
  preferNewerSideChat,
  SideChatRequestTracker,
  sideChatBusyNotice,
  sideChatIsBusy,
} from "../../src/features/side-chat/side-chat-panel";

const baseResult: Extract<KanbanResult, { state: "available" }> = {
  state: "available",
  cards: [],
  issues: [],
  workflows: [
    {
      path: "D:/项目/.pao/工作流实例-a.md",
      project: "D:/项目",
      instance: "instance-a",
      workflow: "发布",
      status: "运行中",
      ownerSessionId: "source",
      nodes: [
        {
          name: "review",
          round: 2,
          cardsDir: "D:/项目/.pao/卡",
          cardRefs: [],
          department: "研发部",
          status: "no_card",
        },
      ],
    },
  ],
};

const groupA = "d:/项目/.pao/工作流实例-a.md:instance-a:review:2";

test("部门详情只选择项目、来源主控、实例和轮次同时匹配的执行组", () => {
  expect(selectCurrentDepartmentGroup(baseResult, "d:\\项目", "source", groupA)).toMatchObject({
    id: groupA,
    project: "D:/项目",
    ownerSessionId: "source",
    department: "研发部",
  });
  expect(selectCurrentDepartmentGroup(baseResult, "D:/项目", "other", groupA)).toBeUndefined();
  expect(
    selectCurrentDepartmentGroup(baseResult, "D:/项目", "source", `${groupA.slice(0, -1)}1`),
  ).toBeUndefined();
});

test("同实例的节点和轮次不能互相冒充", () => {
  const otherRound: KanbanResult = {
    ...baseResult,
    workflows: [
      {
        ...baseResult.workflows[0]!,
        nodes: [
          ...baseResult.workflows[0]!.nodes,
          { ...baseResult.workflows[0]!.nodes[0]!, round: 3 },
        ],
      },
    ],
  };
  expect(selectCurrentDepartmentGroup(otherRound, "D:/项目", "source", groupA)).toMatchObject({
    id: groupA,
  });
  expect(
    selectCurrentDepartmentGroup(otherRound, "D:/项目", "source", groupA.replace(":2", ":3")),
  ).toMatchObject({ id: groupA.replace(":2", ":3") });
});

test("共享卡目录的不同工作流实例不能串组", () => {
  const secondInstance: KanbanResult = {
    ...baseResult,
    workflows: [
      ...baseResult.workflows,
      {
        ...baseResult.workflows[0]!,
        path: "D:/项目/.pao/工作流实例-b.md",
        instance: "instance-b",
      },
    ],
  };
  const groupB = groupA.replace("工作流实例-a.md:instance-a", "工作流实例-b.md:instance-b");
  expect(selectCurrentDepartmentGroup(secondInstance, "D:/项目", "source", groupA)).toMatchObject({
    id: groupA,
  });
  expect(selectCurrentDepartmentGroup(secondInstance, "D:/项目", "source", groupB)).toMatchObject({
    id: groupB,
  });
  expect(
    selectCurrentDepartmentGroup(secondInstance, "D:/项目", "source", groupB.replace(":2", ":3")),
  ).toBeUndefined();
});

test("看板不可用时不构造空部门", () => {
  expect(
    selectCurrentDepartmentGroup(
      { state: "unavailable", message: "读取失败" },
      "D:/项目",
      "source",
      groupA,
    ),
  ).toBeUndefined();
});

test("部门身份按工作区与来源主控精确读取，现场缺失不冒充加载中", () => {
  const empty = createEmptyDesktopAppState();
  expect(identityForDepartment({ phase: "loading" }, "workspace-a", "session-a")).toMatchObject({
    state: { phase: "loading" },
    workspace: undefined,
    session: undefined,
  });
  expect(
    identityForDepartment({ phase: "ready", snapshot: empty }, "workspace-a", "session-a"),
  ).toMatchObject({
    state: { phase: "ready" },
    workspace: undefined,
    session: undefined,
  });
  const workspaceWithoutSource = {
    ...empty,
    workspaces: [
      {
        id: "workspace-a",
        name: "项目",
        path: "D:/项目",
        lastOpenedAt: "2026-10-19T06:00:00Z",
        kind: "primary" as const,
        sessions: [
          {
            id: "another-session",
            title: "另一个主控",
            updatedAt: "2026-10-19T06:00:00Z",
            preview: "",
            status: "idle" as const,
            hasUnseenUpdate: false,
          },
        ],
      },
    ],
  };
  expect(
    identityForDepartment(
      { phase: "ready", snapshot: workspaceWithoutSource },
      "workspace-a",
      "session-a",
    ),
  ).toMatchObject({
    state: { phase: "ready" },
    workspace: { id: "workspace-a", path: "D:/项目" },
    session: undefined,
  });
});

test("辅助会话快照的异步返回不能串到另一个来源会话", () => {
  const source = { workspaceId: "workspace-a", sessionId: "session-a" };
  const snapshot: SideChatSnapshot = {
    source,
    messages: [],
    updatedAt: "2026-10-19T06:00:00Z",
    sync: {
      boundaryId: "boundary",
      sourceStatus: "idle",
      capturedAt: "2026-10-19T06:00:00Z",
      contextComplete: true,
      limitations: [],
    },
    readOnly: true,
    toolNames: [],
  };
  expect(displayedSideChat(snapshot, source)).toBe(snapshot);
  expect(displayedSideChat(snapshot, { ...source, sessionId: "session-b" })).toBeUndefined();
  expect(displayedSideChat(snapshot, { ...source, workspaceId: "workspace-b" })).toBeUndefined();
});

test("同步只覆盖更旧快照，相同消息身份不会因轮询重复落地", () => {
  const source = { workspaceId: "workspace-a", sessionId: "session-a" };
  const older: SideChatSnapshot = {
    source,
    messages: [],
    updatedAt: "2026-10-19T06:00:00Z",
    sync: {
      boundaryId: "boundary",
      sourceStatus: "running",
      capturedAt: "2026-10-19T06:00:00Z",
      contextComplete: true,
      limitations: [],
    },
    busy: true,
    readOnly: true,
    toolNames: [],
  };
  const newer: SideChatSnapshot = {
    ...older,
    messages: [
      {
        id: "answer-1",
        role: "assistant",
        text: "已落盘的回答",
        createdAt: "2026-10-19T06:00:01Z",
        status: "complete",
      },
    ],
    updatedAt: "2026-10-19T06:00:01Z",
    busy: false,
  };
  expect(preferNewerSideChat(undefined, older)).toBe(older);
  expect(preferNewerSideChat(newer, older)).toBe(newer);
  expect(preferNewerSideChat(older, newer)).toBe(newer);
  expect(preferNewerSideChat(newer, { ...newer })).toBe(newer);
});

test("部门面板的回执夹具保留磁盘记录原值，不补造成功状态", () => {
  const result: KanbanResult = {
    ...baseResult,
    cards: [
      {
        path: "D:/项目/.pao/卡/卡0001-任务.md",
        project: "D:/项目",
        number: 1,
        goal: "整理报告",
        department: "研发部",
        status: "delivered",
        acceptance: "通过检查",
        inputs: [],
        dependencies: [],
        priority: "medium",
        attempts: 1,
        created: "2026-10-19",
        body: "正文",
        receipts: [
          {
            attempt: 1,
            summary: "报告已完成",
            artifact_path: ["报告.md"],
            evidence: ["检查输出"],
          },
        ],
        executions: [],
      } satisfies KanbanCard,
    ],
  };
  expect(result.state).toBe("available");
  expect(result.cards[0]?.receipts[0]).toEqual({
    attempt: 1,
    summary: "报告已完成",
    artifact_path: ["报告.md"],
    evidence: ["检查输出"],
  });
  const receipt = deliveryRecords(result.cards[0]!)[0];
  expect(receipt).toMatchObject({
    attempt: "1",
    summary: "报告已完成",
    artifacts: ["报告.md"],
    evidence: ["检查输出"],
  });
  expect(receipt?.status).toBeUndefined();
  expect(receipt?.result).toBeUndefined();
});

test("可控延迟请求跨一次同步周期：发送完成、迟到同步失效、发送状态仍能清理", async () => {
  let resolveLoad!: (value: string) => void;
  let resolveSend!: (value: string) => void;
  const loadValue = new Promise<string>((resolve) => {
    resolveLoad = resolve;
  });
  const sendValue = new Promise<string>((resolve) => {
    resolveSend = resolve;
  });
  const tracker = new SideChatRequestTracker();
  const source = "workspace-a\u0000session-a";
  const load = tracker.beginLoad(source);
  const send = tracker.beginSend(source);
  expect(send).toBeDefined();
  expect(tracker.beginSend(source)).toBeUndefined();
  expect(tracker.acceptsLoad(load, source)).toBe(true);
  const nextLoad = tracker.beginLoad(source);
  expect(tracker.acceptsLoad(load, source)).toBe(false);
  expect(tracker.finishesLoad(load, source)).toBe(false);
  expect(tracker.acceptsLoad(nextLoad, source)).toBe(true);
  resolveSend("发送完成");
  expect(await sendValue).toBe("发送完成");
  expect(tracker.commitSend(send!, source)).toBe(true);
  resolveLoad("迟到的同步快照");
  expect(await loadValue).toBe("迟到的同步快照");
  expect(tracker.acceptsLoad(load, source)).toBe(false);
  expect(tracker.acceptsLoad(nextLoad, source)).toBe(false);
  expect(tracker.isSending()).toBe(false);
  const afterSend = tracker.beginLoad(source);
  expect(tracker.acceptsLoad(afterSend, source)).toBe(true);
  expect(tracker.finishesLoad(afterSend, source)).toBe(true);
});

test("显式读取跨过一次轮询周期时独占加载，完成后才允许背景同步", async () => {
  const source = "workspace-a\u0000session-a";
  const tracker = new SideChatRequestTracker();
  let resolveLoad!: () => void;
  const slowLoad = new Promise<void>((resolve) => {
    resolveLoad = resolve;
  });
  let loading = true;
  const explicit = tracker.beginLoad(source, "explicit")!;
  const completion = slowLoad.finally(() => {
    if (tracker.finishesLoad(explicit, source)) loading = false;
  });

  expect(explicit).toBeDefined();
  expect(tracker.beginLoad(source, "background")).toBeUndefined();
  expect(tracker.acceptsLoad(explicit, source)).toBe(true);

  resolveLoad();
  await completion;
  expect(loading).toBe(false);

  const background = tracker.beginLoad(source, "background");
  expect(background).toBeDefined();
  expect(tracker.acceptsLoad(background, source)).toBe(true);
  expect(tracker.finishesLoad(background, source)).toBe(false);
});

test("显式读取失败或来源切换时都会释放加载所有权", async () => {
  const source = "workspace-a\u0000session-a";
  let tracker = new SideChatRequestTracker();
  let rejectLoad!: (reason: unknown) => void;
  const slowLoad = new Promise<void>((_resolve, reject) => {
    rejectLoad = reject;
  });
  let loading = true;
  const explicit = tracker.beginLoad(source, "explicit")!;
  const completion = slowLoad.finally(() => {
    if (tracker.finishesLoad(explicit, source)) loading = false;
  });

  expect(tracker.beginLoad(source, "background")).toBeUndefined();
  rejectLoad(new Error("慢读取失败"));
  await expect(completion).rejects.toThrow("慢读取失败");
  expect(loading).toBe(false);
  expect(tracker.beginLoad(source, "background")).toBeDefined();

  tracker = new SideChatRequestTracker();
  const switching = tracker.beginLoad(source, "explicit")!;
  tracker.reset();
  expect(tracker.finishesLoad(switching, source)).toBe(false);
  expect(tracker.beginLoad(source, "background")).toBeDefined();
});

test("部门已打开的会话只在项目、主控和部门身份完全一致时显示", () => {
  const identity = {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    groupId: groupA,
  };
  const bound = {
    input: {
      workspaceId: "workspace-a",
      kind: "worker" as const,
      executionId: "execution-a",
    },
    title: "研发部工人执行会话",
    panelIdentity: identity,
  };

  expect(activeSessionForPanel(bound, identity)).toBe(bound);
  expect(
    activeSessionForPanel(bound, {
      ...identity,
      workspaceId: "workspace-b",
    }),
  ).toBeUndefined();
  expect(
    activeSessionForPanel(bound, {
      ...identity,
      sessionId: "session-b",
    }),
  ).toBeUndefined();
  expect(
    activeSessionForPanel(bound, {
      ...identity,
      groupId: groupA.replace(":2", ":3"),
    }),
  ).toBeUndefined();
});

test("发送的完成清理只接受自己的 source 与发送序号", () => {
  const tracker = new SideChatRequestTracker();
  const source = "workspace-a\u0000session-a";
  const send = tracker.beginSend(source)!;
  expect(tracker.acceptsSend(send, "workspace-b\u0000session-a")).toBe(false);
  expect(tracker.finishSend(send, "workspace-b\u0000session-a")).toBe(false);
  expect(tracker.isSending()).toBe(true);
  expect(tracker.finishSend(send, source)).toBe(true);
  expect(tracker.isSending()).toBe(false);
});

test("隐藏后重开时宿主快照的 busy 能阻止重复发送并要求同步结果", () => {
  const source = { workspaceId: "workspace-a", sessionId: "session-a" };
  const snapshot: SideChatSnapshot = {
    source,
    messages: [],
    updatedAt: "2026-10-19T06:00:00Z",
    sync: {
      boundaryId: "boundary",
      sourceStatus: "idle",
      capturedAt: "2026-10-19T06:00:00Z",
      contextComplete: true,
      limitations: [],
    },
    busy: true,
    readOnly: true,
    toolNames: [],
  };
  expect(sideChatIsBusy(snapshot, false)).toBe(true);
  expect(sideChatBusyNotice(snapshot)).toContain("不能再次发送");
  expect(
    sideChatIsBusy(
      {
        ...snapshot,
        busy: false,
      },
      false,
    ),
  ).toBe(false);
});
