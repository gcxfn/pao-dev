import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  expectSendSideChatMessageRequest,
  expectSideChatRequest,
} from "../../electron/ipc/request-validation";
import { requireSideChatSource } from "../../electron/ipc/side-chat-source";
import type { WorkspaceRecord } from "../../contracts/desktop-state";

test("辅助对话渠道只通过主框架处理器注册", async () => {
  const source = await readFile(
    join(__dirname, "../../electron/ipc/register-desktop-ipc.ts"),
    "utf8",
  );

  expect(source).toMatch(/handleMainFrame\(\s*desktopIpc\.getSideChat,\s*expectSideChatRequest,/);
  expect(source).toMatch(
    /handleMainFrame\(\s*desktopIpc\.sendSideChatMessage,\s*expectSendSideChatMessageRequest,/,
  );
});

test("辅助对话读取只接受规范化的来源会话标识", () => {
  const source = expectSideChatRequest({
    workspaceId: " workspace-a ",
    sessionId: " session-a ",
  });

  expect(source).toEqual({ workspaceId: "workspace-a", sessionId: "session-a" });
  expect(source).not.toHaveProperty("path");
});

test("辅助对话消息保留正文，但拒绝空来源、空白、过长和未知字段", () => {
  expect(
    expectSendSideChatMessageRequest({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      text: "  请分析当前进度  ",
    }),
  ).toEqual({
    source: { workspaceId: "workspace-a", sessionId: "session-a" },
    text: "  请分析当前进度  ",
  });

  expect(() =>
    expectSendSideChatMessageRequest({
      workspaceId: "",
      sessionId: "session-a",
      text: "问题",
    }),
  ).toThrow("side chat message.workspaceId must not be empty");
  expect(() =>
    expectSendSideChatMessageRequest({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      text: " \n ",
    }),
  ).toThrow("side chat message.text must not be empty");
  expect(() =>
    expectSendSideChatMessageRequest({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      text: "a".repeat(100_001),
    }),
  ).toThrow("side chat message.text must be at most 100000 characters");
  expect(() =>
    expectSendSideChatMessageRequest({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      text: "问题",
      command: "rm",
    }),
  ).toThrow("side chat message contains an unsupported field: command");
});

test("辅助对话来源必须同时属于窗口选择和已登记工作区", () => {
  const workspaces = [
    {
      id: "workspace-a",
      sessions: [{ id: "session-a" }],
    },
  ] as unknown as readonly WorkspaceRecord[];
  const source = { workspaceId: "workspace-a", sessionId: "session-a" };
  const selected = { selectedWorkspaceId: "workspace-a", selectedSessionId: "session-a" };

  expect(() => requireSideChatSource(source, selected, workspaces)).not.toThrow();
  expect(() =>
    requireSideChatSource(
      source,
      { selectedWorkspaceId: "workspace-a", selectedSessionId: "session-b" },
      workspaces,
    ),
  ).toThrow("Side chat source must be the selected session in this window.");
  expect(() => requireSideChatSource(source, selected, workspaces.slice(1))).toThrow(
    "Unknown side chat source: workspace-a:session-a",
  );
  expect(() =>
    requireSideChatSource(
      { workspaceId: "workspace-a", sessionId: "session-b" },
      { selectedWorkspaceId: "workspace-a", selectedSessionId: "session-b" },
      workspaces,
    ),
  ).toThrow("Unknown side chat source: workspace-a:session-b");
});
