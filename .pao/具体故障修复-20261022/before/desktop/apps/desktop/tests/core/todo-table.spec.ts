import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const PROVIDER_ID = "todo-table-test";
const MODEL_ID = "scripted";
const THREAD_TITLE = "Todo table";

// The real Pi loop; only model streaming is scripted. The model issues three TodoWrite
// calls: a mixed-state checklist, an all-done rewrite, and an empty write that must not
// render a table. Each call renders its own snapshot table; a later write never edits
// an earlier one.
const extensionSource = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const CHECKLIST_START = [
  { content: "收集素材", status: "completed" },
  { content: "实现任务表格", status: "in_progress" },
  { content: "验证渲染", status: "pending" },
];
const CHECKLIST_DONE = [
  { content: "收集素材", status: "completed" },
  { content: "实现任务表格", status: "completed" },
  { content: "验证渲染", status: "completed" },
];

export default function todoProbe(pi) {
  pi.registerTool({
    name: "TodoWrite",
    label: "TodoWrite",
    description: "Write the session checklist",
    parameters: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"] },
    async execute(_id, input) {
      return {
        content: [{ type: "text", text: "Checklist updated (" + input.todos.length + " items)" }],
        details: {},
      };
    },
  });
  pi.registerProvider("todo-table-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "todo-table-test",
    models: [{
      id: "scripted",
      name: "Scripted todo writes",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const finished = context.messages.filter((message) => message.role === "toolResult").length;
      let content;
      let stopReason;
      if (finished === 0) {
        content = [{ type: "toolCall", id: "todo-1", name: "TodoWrite", arguments: { todos: CHECKLIST_START } }];
        stopReason = "toolUse";
      } else if (finished === 1) {
        content = [{ type: "toolCall", id: "todo-2", name: "TodoWrite", arguments: { todos: CHECKLIST_DONE } }];
        stopReason = "toolUse";
      } else if (finished === 2) {
        content = [{ type: "toolCall", id: "todo-3", name: "TodoWrite", arguments: { todos: [] } }];
        stopReason = "toolUse";
      } else {
        content = [{ type: "text", text: "任务清单已全部完成。" }];
        stopReason = "stop";
      }
      const message = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        // pi 只把增量（text_delta）累积成可见文本；只发 done 会被当作空回复。
        if (stopReason === "stop") {
          stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    },
  });
}
`;

async function expectTodoTables(window: Page): Promise<void> {
  // 常驻区只呈现最近一次清单；清空后不能复活历史工具卡里的旧任务。
  await expect(window.getByTestId("task-status-todos")).toContainText("清单已清空");
  await expect(window.getByTestId("task-status-todos").locator(".task-status__todo")).toHaveCount(0);
  // Three TodoWrite calls ran; the empty one draws no table.
  await expect(window.locator(".timeline-tool")).toHaveCount(3);
  const tables = window.getByTestId("todo-table");
  await expect(tables).toHaveCount(2);

  // Every table carries the「任务清单」header (zh UI seeded via ui-state.json).
  const headers = window.locator(".todo-table__header");
  await expect(headers).toHaveText(["任务清单", "任务清单"]);

  // First write: mixed states, each rendered with its own marker row.
  const firstRows = tables.nth(0).locator(".todo-table__row");
  await expect(firstRows).toHaveCount(3);
  await expect(firstRows.nth(0)).toContainText("收集素材");
  await expect(firstRows.nth(0)).toHaveClass(/todo-table__row--completed/);
  await expect(firstRows.nth(0).locator(".todo-table__symbol")).toHaveAttribute(
    "aria-label",
    "完成",
  );
  await expect(firstRows.nth(1)).toContainText("实现任务表格");
  await expect(firstRows.nth(1)).toHaveClass(/todo-table__row--in_progress/);
  await expect(firstRows.nth(1).locator(".todo-table__symbol")).toHaveAttribute(
    "aria-label",
    "进行中",
  );
  await expect(firstRows.nth(2)).toContainText("验证渲染");
  await expect(firstRows.nth(2)).toHaveClass(/todo-table__row--pending/);
  await expect(firstRows.nth(2).locator(".todo-table__symbol")).toHaveAttribute(
    "aria-label",
    "待办",
  );

  // Second write: its own table, all rows done — the first table is untouched.
  const secondRows = tables.nth(1).locator(".todo-table__row");
  await expect(secondRows).toHaveCount(3);
  for (const index of [0, 1, 2]) {
    await expect(secondRows.nth(index)).toHaveClass(/todo-table__row--completed/);
    await expect(secondRows.nth(index).locator(".todo-table__symbol")).toHaveAttribute(
      "aria-label",
      "完成",
    );
  }
}

test("TodoWrite tool calls render a task checklist table, live and after restart", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("todo-table");
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
  // 中文界面：预置语言设置，断言表头与状态标签走 zh 词条。
  await writeFile(join(userDataDir, "ui-state.json"), JSON.stringify({ language: "zh" }));
  // 内置 pao 扩展在主控会话发请求前要取 PAO_HOME 会话锁；给一个空现场目录即可。
  await mkdir(join(userDataDir, "pao-home", ".pao"), { recursive: true });
  await writeProjectExtension(workspacePath, "todo-table.ts", extensionSource);
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
      envOverrides: {
        PAO_HOME: join(userDataDir, "pao-home"),
        // 本用例依赖内置 pao 扩展（todo 表格命令），显式关掉 helper 的默认门控。
        PAO_DISABLE_BUILTIN_EXTENSION: "0",
        // pi 的 piConfig.name 是 "pao"，运行时读的 agent 目录环境变量是 PAO_CODING_AGENT_DIR；
        // 不钉住就会读到本机真实 ~/.pi/agent 设置（enabledModels 过滤掉脚本化模型）。
        PAO_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_DIR: agentDir,
      },
    });

  const firstRun = await launch();
  try {
    const window = await firstRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, THREAD_TITLE);
    const composer = window.getByTestId("composer");
    await composer.click();
    await composer.fill("请维护任务清单并完成它们。");
    await composer.press("Enter");
    await expect(window.locator(".timeline-item--assistant")).toContainText("任务清单已全部完成", {
      timeout: 60_000,
    });
    await expectTodoTables(window);
  } finally {
    await firstRun.close();
  }

  // Reopened from the saved session, the tables render again from the persisted calls.
  const secondRun = await launch();
  try {
    const window = await secondRun.firstWindow();
    await selectSession(window, THREAD_TITLE);
    await expectTodoTables(window);
  } finally {
    await secondRun.close();
  }
});
