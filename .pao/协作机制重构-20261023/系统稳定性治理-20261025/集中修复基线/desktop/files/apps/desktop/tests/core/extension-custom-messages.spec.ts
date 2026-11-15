import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  getSelectedTranscript,
  getDesktopState,
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "custom-message-test";
const MODEL_ID = "scripted";

// A real pi extension on the real Pi loop; only model streaming is scripted. The first
// reply steers a displayed custom message into the run and sends a hidden one, the way
// a CI or review extension reports back while the agent works.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function customMessageExtension(pi) {
  let calls = 0;
  pi.registerProvider("custom-message-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "custom-message-test",
    models: [{
      id: "scripted",
      name: "Scripted custom messages",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, _context) {
      calls += 1;
      const text = calls === 1 ? "Checking the build before I continue." : "The build is green, carrying on.";
      if (calls === 1) {
        pi.sendMessage({
          customType: "ci-status",
          content: "**Build passed** on main\n\n- 12 tests\n- 0 failures",
          display: true,
        });
        pi.sendMessage(
          { customType: "ci-status", content: "HIDDEN MODEL ONLY NOTE", display: false },
          { triggerTurn: false },
        );
      }
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      const words = text.split(" ");
      let index = 0;
      const tick = () => {
        if (index < words.length) {
          const delta = (index === 0 ? "" : " ") + words[index];
          index += 1;
          stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
          setTimeout(tick, 120);
          return;
        }
        stream.push({ type: "done", reason: "stop", message });
      };
      setTimeout(tick, 120);
      return stream;
    },
  });

  pi.registerCommand("ci-note", {
    description: "Post a CI note into the transcript",
    handler: async () => {
      pi.sendMessage({ customType: "ci-note", content: "Deploy preview is **ready**", display: true });
    },
  });
}
`;

const assistantRows = (window: Page) =>
  window.locator(".timeline-item--assistant .message__content");
const customRows = (window: Page) => window.getByTestId("timeline-custom-message");

async function expectConversation(window: Page): Promise<void> {
  await expect(customRows(window)).toHaveCount(2);
  await expect(customRows(window).nth(0).locator(".timeline-item__custom-type")).toHaveText(
    "ci-status",
  );
  await expect(customRows(window).nth(0).locator("strong")).toHaveText("Build passed");
  await expect(customRows(window).nth(0).locator("li")).toHaveText(["12 tests", "0 failures"]);
  await expect(customRows(window).nth(1).locator(".timeline-item__custom-type")).toHaveText(
    "ci-note",
  );
  await expect(customRows(window).nth(1)).toContainText("Deploy preview is ready");
  await expect(window.locator(".timeline")).not.toContainText("HIDDEN MODEL ONLY NOTE");
  // Transcript order: the steered note sits between the two replies, the command's note last.
  const order = (await getSelectedTranscript(window))?.transcript.flatMap((item) =>
    item.kind === "custom"
      ? [item.customType]
      : item.kind === "message" && item.role === "assistant"
        ? ["assistant"]
        : [],
  );
  expect(order).toEqual(["assistant", "ci-status", "assistant", "ci-note"]);
}

test("extension custom messages show like terminal pi, live and after relaunch", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("extension-custom-messages");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER_ID,
      defaultModel: MODEL_ID,
      enabledModels: [`${PROVIDER_ID}/${MODEL_ID}`],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspacePath, "custom-messages.ts", extensionSource);

  const firstRun = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
  });
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("Check CI, then continue.");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();

    // The steered note arrives while the run is still going and leaves the reply intact.
    await expect(customRows(window)).toHaveCount(1);
    await expect(assistantRows(window).first()).toHaveText("Checking the build before I continue.");
    await expect(assistantRows(window)).toHaveText([
      "Checking the build before I continue.",
      "The build is green, carrying on.",
    ]);
    await expect(window.locator(".session-row--active")).toHaveAttribute(
      "data-sidebar-indicator",
      "none",
    );

    const composer = window.getByTestId("composer");
    await composer.fill("/ci-note ");
    await composer.press("Enter");
    await expect(customRows(window)).toHaveCount(2);
    await expectConversation(window);
  } finally {
    await firstRun.close();
  }

  // A second process reads the rows back from pi's session file, once each.
  const secondRun = await launchDesktop(userDataDir, { agentDir, scrubProviderEnv: true });
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, "New thread");
    await expectConversation(window);
  } finally {
    await secondRun.close();
  }
});

test("first-run checklist refreshes one row across live updates, session switches and relaunch", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("first-run-refresh");
  await seedAgentDir(agentDir);
  // 真扩展、真会话日志；清单内容由夹具生成，不请求外部模型。
  await writeProjectExtension(
    workspacePath,
    "first-run.ts",
    String.raw`
export default function firstRunFixture(pi) {
  let refresh = 0;
  const send = () => pi.sendMessage({ customType: "pao-firstrun", content: "── 首跑清单（§16.1）──\n今日待办：" + refresh + "\n第二行：保留换行", display: true });
  pi.on("session_start", send);
  pi.registerCommand("refresh-checklist", { description: "Refresh fixture checklist", handler: async () => {
    refresh += 1;
    send();
    pi.sendMessage({ customType: "note", content: "普通记录 " + refresh, display: true });
  }});
}
`,
  );
  const firstRun = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
  });
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Checklist A");
    // 新建空会话按需启动内核；第一次命令触发 session_start 与随后的清单刷新。
    await window.getByTestId("composer").fill("/refresh-checklist ");
    await window.getByTestId("composer").press("Enter");
    const row = window.getByTestId("timeline-first-run");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("今日待办：1");
    const rowId = await row
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .getAttribute("data-message-id");
    for (const value of [2, 3]) {
      await window.getByTestId("composer").fill("/refresh-checklist ");
      await window.getByTestId("composer").press("Enter");
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("今日待办：" + value);
    }
    expect(
      await row.locator("xpath=ancestor::*[@data-message-id][1]").getAttribute("data-message-id"),
    ).toBe(rowId);
    await expect(customRows(window)).toHaveCount(3);
    expect(
      await row
        .locator(".timeline-item__checklist")
        .evaluate((element) => getComputedStyle(element).whiteSpace),
    ).toBe("pre-wrap");
    // 原始日志保留三次快照，显示层只保留最新一条。
    const transcript = await getSelectedTranscript(window);
    expect(
      transcript?.transcript.filter(
        (item) => item.kind === "custom" && item.customType === "pao-firstrun",
      ),
    ).toHaveLength(3);
    await createNamedThread(window, "Checklist B");
    await window.getByTestId("composer").fill("/refresh-checklist ");
    await window.getByTestId("composer").press("Enter");
    await expect(row).toContainText("今日待办：1");
    await selectSession(window, "Checklist A");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("今日待办：3");
    await firstRun.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      if (win.isMinimized()) win.restore();
      win.showInactive();
    });
    await window.screenshot({
      path: testInfo.outputPath("checklist-and-sidebar.png"),
      animations: "disabled",
    });
  } finally {
    await firstRun.close();
  }
  const secondRun = await launchDesktop(userDataDir, { agentDir, scrubProviderEnv: true });
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, "Checklist A");
    await expect(window.getByTestId("timeline-first-run")).toHaveCount(1);
    // 重开会话触发 session_start，新快照为 0，并覆盖上次运行的 3。
    await expect(window.getByTestId("timeline-first-run")).toContainText("今日待办：0");
    // 恢复出的历史先显示，扩展命令随后就绪；等命令注册后才提交。
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const key = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
        return (
          state.sessionCommandsBySession[key]?.some(
            (command) => command.name === "refresh-checklist",
          ) ?? false
        );
      })
      .toBe(true);
    await window.getByTestId("composer").fill("/refresh-checklist ");
    await window.getByTestId("composer").press("Enter");
    await expect(window.getByTestId("timeline-first-run")).toHaveCount(1);
    await expect(window.getByTestId("timeline-first-run")).toContainText("今日待办：1");
    await expect(customRows(window)).toHaveCount(4);
  } finally {
    await secondRun.close();
  }
});
