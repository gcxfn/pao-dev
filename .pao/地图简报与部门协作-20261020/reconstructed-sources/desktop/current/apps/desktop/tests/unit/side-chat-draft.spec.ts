import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver/types";
import type {
  DesktopAppState,
  SessionRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";
import { sideChatSourceError } from "../../src/app/side-chat-draft";

const source: SessionRef = { workspaceId: "workspace-a", sessionId: "session-a" };

function session(id: string): SessionRecord {
  return {
    id,
    title: id,
    updatedAt: "2026-10-19T00:00:00.000Z",
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
  };
}

function workspace(id: string, sessionIds: readonly string[]): WorkspaceRecord {
  return {
    id,
    name: id,
    path: `D:/${id}`,
    lastOpenedAt: "2026-10-19T00:00:00.000Z",
    kind: "primary",
    sessions: sessionIds.map(session),
  };
}

function state(workspaces: readonly WorkspaceRecord[]): DesktopAppState {
  return { workspaces } as DesktopAppState;
}

test("辅助问答草稿拒绝已关闭的来源并给出准确原因", () => {
  expect(
    sideChatSourceError(state([workspace("workspace-a", ["session-b"])]), source, source, ""),
  ).toBe("来源主对话已不存在，草稿未写入。");
});

test("同 sessionId 出现在不同 workspace 或切换主控时拒绝草稿", () => {
  const registered = state([
    workspace("workspace-a", ["session-a"]),
    workspace("workspace-b", ["session-a", "session-b"]),
  ]);

  expect(
    sideChatSourceError(
      registered,
      { workspaceId: "workspace-b", sessionId: "session-a" },
      source,
      "",
    ),
  ).toBe("来源主对话已切换，草稿未写入。");
  expect(
    sideChatSourceError(
      registered,
      { workspaceId: "workspace-a", sessionId: "session-b" },
      source,
      "",
    ),
  ).toBe("来源主对话已切换，草稿未写入。");
});

test("当前 target 为空时拒绝草稿", () => {
  const registered = state([workspace("workspace-a", ["session-a"])]);

  expect(sideChatSourceError(registered, null, source, "")).toBe("来源主对话已切换，草稿未写入。");
});

test("来源仍存在但已有非空草稿时拒绝覆盖并说明原因", () => {
  const registered = state([workspace("workspace-a", ["session-a"])]);

  expect(sideChatSourceError(registered, source, source, "用户正在写的内容")).toBe(
    "来源主对话已有草稿，未覆盖；请先手动处理现有内容。",
  );
  expect(sideChatSourceError(registered, source, source, " \n\t ")).toBeUndefined();
});

test("来源仍存在且草稿为空时允许回填", () => {
  const registered = state([workspace("workspace-a", ["session-a"])]);

  expect(sideChatSourceError(registered, source, source, "")).toBeUndefined();
});
