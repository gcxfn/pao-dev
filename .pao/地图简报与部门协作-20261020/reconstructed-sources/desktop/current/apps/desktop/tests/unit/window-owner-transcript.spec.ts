/** 审查修复轮 R7：页面 reload 后增量基线必须清零，下次发布回落全量记录；
 * 否则重载后的渲染端只会收到它无法应用的尾部增量。伪窗口沿 workflow-leave-guard 先例。 */
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { expect, test } from "@playwright/test";
import { WindowOwner, type WindowStateOwner } from "../../electron/windows/window-owner";
import { desktopIpc } from "../../contracts/ipc";
import type {
  DesktopAppState,
  DesktopAppViewState,
  SelectedTranscriptRecord,
} from "../../contracts/desktop-state";

function windowFixture(id: number) {
  const sent: { channel: string; payload: unknown }[] = [];
  const contents = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    isCrashed: () => false,
    send(channel: string, payload: unknown) {
      sent.push({ channel, payload });
    },
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents,
  }) as unknown as BrowserWindow;
  return { contents, window, sent };
}

function stateOwnerFixture(payload: () => SelectedTranscriptRecord | null) {
  const state = {
    selectedWorkspaceId: "ws",
    selectedSessionId: "a",
    activeView: "threads",
    sidebarCollapsed: false,
  } as unknown as DesktopAppState;
  const transcriptListeners: (() => void)[] = [];
  const owner = {
    snapshot: () => state,
    projectStateForView: (_view: DesktopAppViewState, current: DesktopAppState) => current,
    getSelectedTranscriptForView: async () => payload(),
    subscribeToSelectedTranscript: (listener: () => void) => {
      transcriptListeners.push(listener);
      return () => transcriptListeners.splice(transcriptListeners.indexOf(listener), 1);
    },
    subscribe: () => () => {},
  } as unknown as WindowStateOwner;
  return { owner, notifyTranscript: () => transcriptListeners.forEach((listener) => listener()) };
}

const message = (id: string, text: string) => ({
  kind: "message" as const,
  id,
  role: "assistant" as const,
  text,
  createdAt: `2026-10-10T00:00:0${id.slice(1)}.000Z`,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("did-start-loading clears the incremental baseline so the next publish is full", async () => {
  const first: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "a",
    transcript: [message("m1", "第一条")],
  };
  const grown: SelectedTranscriptRecord = {
    workspaceId: "ws",
    sessionId: "a",
    transcript: [...first.transcript, message("m2", "第二条")],
  };
  let current: SelectedTranscriptRecord | null = first;
  const { owner, notifyTranscript } = stateOwnerFixture(() => current);
  const { contents, window, sent } = windowFixture(1);
  new WindowOwner(owner).add(window);

  notifyTranscript();
  await flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ channel: desktopIpc.selectedTranscriptChanged, payload: first });

  // 同前缀追加一条：可增量，发布尾部 append。
  current = grown;
  notifyTranscript();
  await flush();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.channel).toBe(desktopIpc.selectedTranscriptChanged);
  expect(sent[1]?.payload).toMatchObject({ kind: "transcript-tail-update", mode: "append" });

  // reload 清基线后，同样的载荷必须重发全量记录。
  contents.emit("did-start-loading");
  notifyTranscript();
  await flush();
  expect(sent).toHaveLength(3);
  expect(sent[2]).toEqual({ channel: desktopIpc.selectedTranscriptChanged, payload: grown });
});
