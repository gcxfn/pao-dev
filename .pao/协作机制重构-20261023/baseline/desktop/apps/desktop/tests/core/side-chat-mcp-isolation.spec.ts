import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { PiDesktopApi } from "../../contracts/ipc";
import {
  type PiAppWindow,
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

const MCP_SERVER_FIXTURE = resolve(
  __dirname,
  "../../../../packages/pi-sdk-driver/test/fixtures/mcp-stdio-server.mjs",
);
const PROVIDER_ID = "side-chat-mcp-isolation";
const MODEL_ID = "offline-scripted";
const THREAD_TITLE = "辅助对话 MCP 隔离";
const SOURCE_QUESTION = "SOURCE_MCP_PROBE：调用真实 MCP 工具一次";
const SIDE_QUESTION = "SIDE_MCP_ISOLATION：请求同一个真实 MCP 工具";
const SOURCE_MARKER_TEXT = "SOURCE_MCP_ONCE";
const SIDE_MARKER_TEXT = "SIDE_MUST_NOT_WRITE";
const MCP_TOOL_NAME = "mcp__fixture__write_marker";
const EXTENSION_TOOL_NAME = "isolated_extension_tool";
const SIDE_CHAT_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

const scriptedProviderSource = (options: { readonly modelLogPath: string }) => String.raw`
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const MODEL_LOG_PATH = ${JSON.stringify(options.modelLogPath)};
const SOURCE_QUESTION = ${JSON.stringify(SOURCE_QUESTION)};
const SIDE_QUESTION = ${JSON.stringify(SIDE_QUESTION)};
const SOURCE_MARKER_TEXT = ${JSON.stringify(SOURCE_MARKER_TEXT)};
const SIDE_MARKER_TEXT = ${JSON.stringify(SIDE_MARKER_TEXT)};
const MCP_TOOL_NAME = ${JSON.stringify(MCP_TOOL_NAME)};
const EXTENSION_TOOL_NAME = ${JSON.stringify(EXTENSION_TOOL_NAME)};
const PROVIDER_ID = ${JSON.stringify(PROVIDER_ID)};
const MODEL_ID = ${JSON.stringify(MODEL_ID)};

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function message(request) {
  return {
    role: "assistant",
    content: request.content,
    api: request.model.api,
    provider: request.model.provider,
    model: request.model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: request.stopReason,
    timestamp: Date.now(),
  };
}

function finish(model, text) {
  const result = message({
    model,
    content: [{ type: "text", text }],
    stopReason: "stop",
  });
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...result, content: [] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: result });
  stream.push({ type: "done", reason: "stop", message: result });
  return stream;
}

function callTool(model, id, name, args) {
  const result = message({
    model,
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "toolUse",
  });
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...result, content: [] } });
  stream.push({ type: "done", reason: "toolUse", message: result });
  return stream;
}

export default function sideChatMcpIsolationProvider(pi) {
  pi.registerTool({
    name: EXTENSION_TOOL_NAME,
    label: "Source-only extension tool",
    description: "Remains inert and proves project extensions are source-session only.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return {
        content: [{ type: "text", text: "must not run" }],
        details: {},
      };
    },
  });
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_ONLY",
    api: "side-chat-mcp-isolation",
    models: [{
      id: MODEL_ID,
      name: "Offline scripted side-chat MCP isolation",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model, context) {
      const serialized = JSON.stringify(context.messages);
      const lastUser = context.messages.findLastIndex((entry) => entry.role === "user");
      const currentMessages =
        lastUser === -1 ? context.messages : context.messages.slice(lastUser + 1);
      const currentText = JSON.stringify(context.messages[lastUser] ?? {});
      const toolCalls = currentMessages.flatMap((entry) =>
        entry.role === "assistant" && Array.isArray(entry.content)
          ? entry.content
              .filter((part) => part.type === "toolCall")
              .map((part) => ({
                id: part.id,
                name: part.name,
                arguments: part.arguments,
              }))
          : [],
      );
      const toolResults = currentMessages
        .filter((entry) => entry.role === "toolResult")
        .map((entry) => ({
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          isError: Boolean(entry.isError),
          text: contentText(entry.content),
        }));
      const toolNames = context.messages.flatMap((entry) =>
        entry.role === "system" && Array.isArray(entry.toolsAdded)
          ? entry.toolsAdded.map((tool) => tool.name)
          : [],
      );

      appendFileSync(
        MODEL_LOG_PATH,
        JSON.stringify({
          currentText,
          sourceQuestionOccurrences: serialized.split(SOURCE_QUESTION).length - 1,
          sideQuestionOccurrences: serialized.split(SIDE_QUESTION).length - 1,
          toolNames,
          toolCalls,
          toolResults,
        }) + "\n",
      );

      if (currentText.includes(SIDE_QUESTION)) {
        const attempted = toolCalls.some((call) => call.id === "side-mcp-denied");
        if (!attempted) {
          return callTool(
            model,
            "side-mcp-denied",
            MCP_TOOL_NAME,
            { text: SIDE_MARKER_TEXT },
          );
        }
        return finish(model, "SIDE_MCP_REJECTED");
      }

      if (currentText.includes(SOURCE_QUESTION)) {
        const completed = toolResults.some(
          (result) => result.toolCallId === "source-mcp-call",
        );
        if (!completed) {
          return callTool(
            model,
            "source-mcp-call",
            MCP_TOOL_NAME,
            { text: SOURCE_MARKER_TEXT },
          );
        }
        return finish(model, "SOURCE_MCP_OK");
      }

      return finish(model, "OFFLINE_SCRIPT_UNMATCHED");
    },
  });
}
`;

interface ModelCallLog {
  readonly currentText: string;
  readonly sourceQuestionOccurrences: number;
  readonly sideQuestionOccurrences: number;
  readonly toolNames: readonly string[];
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
  }[];
  readonly toolResults: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly isError: boolean;
    readonly text: string;
  }[];
}

async function modelCalls(logPath: string): Promise<readonly ModelCallLog[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ModelCallLog);
}

async function gitSnapshot(workspacePath: string): Promise<{
  readonly head: string;
  readonly status: string;
  readonly diff: string;
}> {
  const run = async (...args: string[]) =>
    (await execFileAsync("git", ["-C", workspacePath, ...args])).stdout.trim();
  return {
    head: await run("rev-parse", "HEAD"),
    status: await run("status", "--porcelain=v1"),
    diff: await run("diff", "--no-ext-diff", "--binary"),
  };
}

test("来源主会话的真实 MCP 工具不会进入只读辅助会话", async () => {
  test.setTimeout(180_000);

  // 这是零费用的离线脚本模型。Electron IPC、来源会话装配、stdio MCP 进程和工具分发
  // 都是真实的；本用例不证明真实供应商的回答质量。
  const userDataDir = await makeUserDataDir("pao-side-chat-mcp-isolation-");
  const agentDir = join(userDataDir, "agent");
  const paoHome = join(userDataDir, "pao-home");
  const markerDir = join(userDataDir, "mcp-markers");
  const modelLogPath = join(userDataDir, "offline-model-calls.jsonl");
  const initializedPath = join(markerDir, "initialized.txt");
  const calledPath = join(markerDir, "called.txt");
  const controlPath = join(paoHome, "执行记录", "control.json");
  const workspacePath = await makeGitWorkspace("side-chat-mcp-isolation");
  const protectedPath = join(workspacePath, "isolated-project-file.txt");
  const protectedContent = "PROJECT_CONTENT_MUST_NOT_CHANGE\n";
  const controlContent = '{"status":"waiting","revision":9}\n';

  await mkdir(join(paoHome, "执行记录"), { recursive: true });
  await writeFile(controlPath, controlContent, "utf8");
  await writeFile(protectedPath, protectedContent, "utf8");
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
    "utf8",
  );
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [MCP_SERVER_FIXTURE, markerDir],
          description: "MCP isolation test server",
          enabled: true,
          exposure: "direct",
        },
      },
    }),
    "utf8",
  );
  await writeProjectExtension(
    workspacePath,
    "side-chat-mcp-isolation.ts",
    scriptedProviderSource({ modelLogPath }),
  );
  await execFileAsync("git", ["-C", workspacePath, "add", "-A"]);
  await execFileAsync("git", ["-C", workspacePath, "commit", "-m", "mcp isolation fixture"]);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: {
      PAO_HOME: paoHome,
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    expect((await getDesktopState(window)).paoHomeEffective).toBe(paoHome);
    await createNamedThread(window, THREAD_TITLE);

    const composer = window.getByTestId("composer");
    await composer.fill(SOURCE_QUESTION);
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText("SOURCE_MCP_OK");

    const state = await getDesktopState(window);
    if (!state.selectedWorkspaceId || !state.selectedSessionId) {
      throw new Error("No source session is selected");
    }
    const source = {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };

    const initializedBefore = await readFile(initializedPath, "utf8");
    expect(initializedBefore.trim().split(/\r?\n/)).toHaveLength(1);
    expect(await readFile(calledPath, "utf8")).toBe(`${SOURCE_MARKER_TEXT}\n`);
    const gitBefore = await gitSnapshot(workspacePath);

    const initial = await window.evaluate(async (target) => {
      const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      return app.getSideChat(target);
    }, source);
    expect(initial.source).toEqual(source);
    expect(initial.readOnly).toBe(true);
    expect(initial.toolNames).toEqual(SIDE_CHAT_TOOL_NAMES);

    const snapshot = await window.evaluate(
      async ({ target, text }) => {
        const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        return app.sendSideChatMessage({ ...target, text });
      },
      { target: source, text: SIDE_QUESTION },
    );
    expect(snapshot.source).toEqual(source);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.toolNames).toEqual(SIDE_CHAT_TOOL_NAMES);
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages.at(-1)?.text).toContain("SIDE_MCP_REJECTED");

    expect(await readFile(initializedPath, "utf8")).toBe(initializedBefore);
    expect(await readFile(calledPath, "utf8")).toBe(`${SOURCE_MARKER_TEXT}\n`);
    expect(await readFile(protectedPath, "utf8")).toBe(protectedContent);
    expect(await readFile(controlPath, "utf8")).toBe(controlContent);
    expect(await gitSnapshot(workspacePath)).toEqual(gitBefore);

    const calls = await modelCalls(modelLogPath);
    const sourceCall = calls.find(
      (call) =>
        call.currentText.includes(SOURCE_QUESTION) &&
        call.toolResults.some((result) => result.toolCallId === "source-mcp-call"),
    );
    expect(sourceCall, "来源会话必须真实装配并调用本地 MCP 工具").toBeDefined();
    expect(sourceCall?.toolNames).toEqual(
      expect.arrayContaining([MCP_TOOL_NAME, EXTENSION_TOOL_NAME]),
    );
    expect(
      sourceCall?.toolResults.find((result) => result.toolCallId === "source-mcp-call"),
    ).toMatchObject({
      toolName: MCP_TOOL_NAME,
      isError: false,
    });

    const sideCall = calls.find(
      (call) =>
        call.currentText.includes(SIDE_QUESTION) &&
        call.toolResults.some((result) => result.toolCallId === "side-mcp-denied"),
    );
    expect(sideCall, "辅助会话必须经真实工具入口处理同名调用").toBeDefined();
    expect(sideCall?.toolNames).toEqual(SIDE_CHAT_TOOL_NAMES);
    expect(sideCall?.toolNames).not.toContain(MCP_TOOL_NAME);
    expect(sideCall?.toolNames).not.toContain(EXTENSION_TOOL_NAME);
    expect(
      sideCall?.toolResults.find((result) => result.toolCallId === "side-mcp-denied"),
    ).toMatchObject({
      toolName: MCP_TOOL_NAME,
      isError: true,
    });

    // write_marker 只证明 MCP 工具隔离；产品写文件由 project_write_canary 真例覆盖。
  } finally {
    await harness.close();
  }
});
