import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import type { PiDesktopApi } from "../../contracts/ipc";
import {
  type PiAppWindow,
  createNamedThread,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

const PROVIDER_ID = "side-chat-host-fast";
const MODEL_ID = "offline-scripted";
const THREAD_TITLE = "辅助问答宿主快速验证";
const MAIN_QUESTION_1 = "MAIN_SOURCE_V1：记录第一轮主控事实";
const MAIN_QUESTION_2 = "MAIN_SOURCE_V2：记录第二轮主控事实";
const SIDE_QUESTION_1 = "SIDE_Q1：读取外部证据，并尝试写入受保护文件";
const SIDE_QUESTION_2 = "SIDE_Q2：检查最新主控材料是否已经同步";
const SIDE_QUESTION_PERMISSIONS = "SIDE_PERMISSIONS：验证全部写入与控制工具均被拒绝";
const OUTSIDE_READ_TOKEN = "OUTSIDE_READ_OK_20261019";
const WRITE_CONTENT = "SIDE_CHAT_MUST_NOT_WRITE_20261019";
const DRAFT_SENTINEL = "主对话未发送草稿哨兵";
const PROJECT_CANARY_TOOL = "project_write_canary";
const PROJECT_CANARY_CONTENT = "SOURCE_EXTENSION_CANARY_WRITTEN_ONCE";
const PUBLIC_PAO_TOOL_NAMES = [
  "pao_dispatch_card",
  "pao_stop_background",
  "pao_terminate_card",
  "pao_confirm_flow",
  "pao_control_node",
] as const;
const DENIED_PUBLIC_PAO_TOOL_NAMES = [...PUBLIC_PAO_TOOL_NAMES, "pao_submit_decision"] as const;

const scriptedProviderSource = (options: {
  readonly modelLogPath: string;
  readonly outsideEvidencePath: string;
  readonly protectedPath: string;
  readonly canaryPath: string;
}) => String.raw`
import { appendFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const MODEL_LOG_PATH = ${JSON.stringify(options.modelLogPath)};
const OUTSIDE_EVIDENCE_PATH = ${JSON.stringify(options.outsideEvidencePath)};
const PROTECTED_PATH = ${JSON.stringify(options.protectedPath)};
const CANARY_PATH = ${JSON.stringify(options.canaryPath)};
const MAIN_QUESTION_1 = ${JSON.stringify(MAIN_QUESTION_1)};
const MAIN_QUESTION_2 = ${JSON.stringify(MAIN_QUESTION_2)};
const SIDE_QUESTION_1 = ${JSON.stringify(SIDE_QUESTION_1)};
const SIDE_QUESTION_2 = ${JSON.stringify(SIDE_QUESTION_2)};
const SIDE_QUESTION_PERMISSIONS = ${JSON.stringify(SIDE_QUESTION_PERMISSIONS)};
const PROJECT_CANARY_TOOL = ${JSON.stringify(PROJECT_CANARY_TOOL)};
const PROJECT_CANARY_CONTENT = ${JSON.stringify(PROJECT_CANARY_CONTENT)};
const DENIED_TOOL_NAMES = [
  "write",
  "edit",
  "bash",
  "powershell",
  PROJECT_CANARY_TOOL,
  ...${JSON.stringify(DENIED_PUBLIC_PAO_TOOL_NAMES)},
];

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
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

function callTools(model, content) {
  const result = message({ model, content, stopReason: "toolUse" });
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...result, content: [] } });
  stream.push({ type: "done", reason: "toolUse", message: result });
  return stream;
}

export default function sideChatHostFastProvider(pi) {
  pi.registerTool({
    name: PROJECT_CANARY_TOOL,
    label: "Project write canary",
    description: "Writes an isolated canary file to prove project extensions are loaded.",
    parameters: { type: "object", properties: {} },
    async execute() {
      writeFileSync(CANARY_PATH, PROJECT_CANARY_CONTENT + "\n", "utf8");
      return {
        content: [{ type: "text", text: "project canary written" }],
        details: {},
      };
    },
  });
  pi.registerProvider(${JSON.stringify(PROVIDER_ID)}, {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "side-chat-host-fast",
    models: [{
      id: ${JSON.stringify(MODEL_ID)},
      name: "Offline scripted side-chat host fast path",
      reasoning: false,
      input: ["text", "image"],
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
      const imageParts = context.messages.flatMap((entry) =>
        Array.isArray(entry.content)
          ? entry.content.filter((part) => part.type === "image")
          : [],
      );
      const toolNames = context.messages.flatMap((entry) =>
        entry.role === "system" && Array.isArray(entry.toolsAdded)
          ? entry.toolsAdded.map((tool) => tool.name)
          : [],
      );

      appendFileSync(
        MODEL_LOG_PATH,
        JSON.stringify({
          currentText,
          sourceV1: serialized.includes(MAIN_QUESTION_1),
          sourceV2: serialized.includes(MAIN_QUESTION_2),
          sideQuestion1: currentText.includes(SIDE_QUESTION_1),
          sideQuestion2: currentText.includes(SIDE_QUESTION_2),
          sideQuestionPermissions: currentText.includes(SIDE_QUESTION_PERMISSIONS),
          mainV1Occurrences: countOccurrences(serialized, MAIN_QUESTION_1),
          mainV2Occurrences: countOccurrences(serialized, MAIN_QUESTION_2),
          sideQuestion1Occurrences: countOccurrences(serialized, SIDE_QUESTION_1),
          sideQuestion2Occurrences: countOccurrences(serialized, SIDE_QUESTION_2),
          sideQuestionPermissionsOccurrences: countOccurrences(
            serialized,
            SIDE_QUESTION_PERMISSIONS,
          ),
          imageCount: imageParts.length,
          toolNames,
          toolCalls,
          toolResults,
        }) + "\n",
      );

      if (currentText.includes(SIDE_QUESTION_1)) {
        const started = toolCalls.some((call) => call.id === "side-chat-read-outside");
        if (!started) {
          return callTools(model, [
            {
              type: "toolCall",
              id: "side-chat-read-outside",
              name: "read",
              arguments: { path: OUTSIDE_EVIDENCE_PATH },
            },
            {
              type: "toolCall",
              id: "side-chat-write-denied",
              name: "write",
              arguments: { path: PROTECTED_PATH, content: ${JSON.stringify(WRITE_CONTENT)} },
            },
          ]);
        }
        return finish(model, "外部证据已读取；单独写入请求由宿主拒绝。");
      }

      if (currentText.includes(SIDE_QUESTION_PERMISSIONS)) {
        const started = toolCalls.some((call) => call.name === "write");
        if (!started) {
          return callTools(
            model,
            DENIED_TOOL_NAMES.map((name, index) => ({
              type: "toolCall",
              id: "side-chat-denied-" + index,
              name,
              arguments: {},
            })),
          );
        }
        return finish(model, "全部写入、注册扩展和 PAO 控制工具均由宿主拒绝。");
      }

      if (currentText.includes(SIDE_QUESTION_2)) {
        return finish(
          model,
          serialized.includes(MAIN_QUESTION_2)
            ? "最新主控材料已同步：SOURCE_V2。"
            : "最新主控材料缺失第二轮标记。",
        );
      }
      if (currentText.includes(MAIN_QUESTION_1)) {
        const canaryResult = toolResults.find(
          (result) => result.toolName === PROJECT_CANARY_TOOL,
        );
        if (!canaryResult) {
          return callTools(model, [
            {
              type: "toolCall",
              id: "source-project-canary",
              name: PROJECT_CANARY_TOOL,
              arguments: {},
            },
          ]);
        }
        return finish(model, "主控第一轮完成：SOURCE_V1。");
      }
      if (currentText.includes(MAIN_QUESTION_2)) {
        return finish(model, "主控第二轮完成：SOURCE_V2。");
      }
      return finish(model, "离线脚本没有匹配到问题。");
    },
  });
}
`;

interface ModelCallLog {
  readonly currentText: string;
  readonly sourceV1: boolean;
  readonly sourceV2: boolean;
  readonly sideQuestion1: boolean;
  readonly sideQuestion2: boolean;
  readonly sideQuestionPermissions: boolean;
  readonly mainV1Occurrences: number;
  readonly mainV2Occurrences: number;
  readonly sideQuestion1Occurrences: number;
  readonly sideQuestion2Occurrences: number;
  readonly sideQuestionPermissionsOccurrences: number;
  readonly imageCount: number;
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

async function selectedSource(
  window: Page,
): Promise<{ readonly workspaceId: string; readonly sessionId: string }> {
  const source = await window.evaluate(async () => {
    const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
    if (!app) throw new Error("piApp IPC bridge is unavailable");
    const state = await app.getState();
    if (!state.selectedWorkspaceId || !state.selectedSessionId) {
      throw new Error("No main session is selected");
    }
    return {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    };
  });
  return source;
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

async function transcriptMessages(window: Page): Promise<readonly string[]> {
  return (
    (await getSelectedTranscript(window))?.transcript.flatMap((item) =>
      item.kind === "message" ? [`${item.role}:${item.text}`] : [],
    ) ?? []
  );
}

test("真实宿主通过离线脚本验证辅助问答、read、write 拒绝和来源刷新", async () => {
  test.setTimeout(180_000);

  // 这是零费用的离线脚本模型。会话循环、Electron IPC 和工具分发是真实的，
  // 但此用例不证明真实供应商的回答质量。
  const userDataDir = await makeUserDataDir("pao-side-chat-host-fast-");
  const agentDir = join(userDataDir, "agent");
  const paoHome = join(userDataDir, "pao-home");
  const modelLogPath = join(userDataDir, "offline-model-calls.jsonl");
  const outsideEvidencePath = join(userDataDir, "source-attachment-outside-workspace.txt");
  const canaryPath = join(userDataDir, "source-extension-canary.txt");
  const paoRecordPath = join(paoHome, "执行记录", "control.json");
  const workspacePath = await makeGitWorkspace("side-chat-host-fast");
  const protectedPath = join(workspacePath, "must-not-change.txt");

  await mkdir(join(paoHome, "执行记录"), { recursive: true });
  await writeFile(outsideEvidencePath, OUTSIDE_READ_TOKEN, "utf8");
  await writeFile(paoRecordPath, '{"status":"waiting","revision":7}\n', "utf8");
  await writeFile(protectedPath, "ORIGINAL_PROTECTED_CONTENT\n", "utf8");
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
  await writeProjectExtension(
    workspacePath,
    "side-chat-host-fast.ts",
    scriptedProviderSource({
      modelLogPath,
      outsideEvidencePath,
      protectedPath,
      canaryPath,
    }),
  );
  await execFileAsync("git", ["-C", workspacePath, "add", "-A"]);
  await execFileAsync("git", ["-C", workspacePath, "commit", "-m", "side-chat fixture"]);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
    envOverrides: {
      PAO_HOME: paoHome,
      // V09 要验证真实注册扩展与真实 PAO 公开控制工具在来源会话存在、在辅助会话消失。
      PAO_DISABLE_BUILTIN_EXTENSION: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    expect((await getDesktopState(window)).paoHomeEffective).toBe(paoHome);
    await createNamedThread(window, THREAD_TITLE);

    const composer = window.getByTestId("composer");
    await composer.fill(MAIN_QUESTION_1);
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText("主控第一轮完成");
    expect(await readFile(canaryPath, "utf8")).toBe(`${PROJECT_CANARY_CONTENT}\n`);
    const canaryAfterSourceCall = await readFile(canaryPath, "utf8");

    const source = await selectedSource(window);
    const initial = await window.evaluate(async (target) => {
      const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
      if (!app) throw new Error("piApp IPC bridge is unavailable");
      return app.getSideChat(target);
    }, source);
    expect(initial.source).toEqual(source);
    expect(initial.messages).toEqual([]);
    expect(initial.readOnly).toBe(true);
    expect(initial.toolNames).toEqual(["read", "grep", "find", "ls"]);

    const afterFirstQuestion = await window.evaluate(
      async ({ target, text }) => {
        const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        return app.sendSideChatMessage({ ...target, text });
      },
      { target: source, text: SIDE_QUESTION_1 },
    );
    expect(afterFirstQuestion.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(afterFirstQuestion.messages[1]?.text).toContain("写入请求由宿主拒绝");
    expect(afterFirstQuestion.readOnly).toBe(true);
    expect(await readFile(protectedPath, "utf8")).toBe("ORIGINAL_PROTECTED_CONTENT\n");

    // 第一轮辅助问答后推进主控。第二轮辅助问题的模型输入必须看到这份新来源材料。
    await composer.fill(MAIN_QUESTION_2);
    await composer.press("Enter");
    await expect(window.getByTestId("transcript")).toContainText("主控第二轮完成");
    await composer.fill(DRAFT_SENTINEL);
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe(DRAFT_SENTINEL);

    const gitBefore = await gitSnapshot(workspacePath);
    const paoRecordBefore = await readFile(paoRecordPath, "utf8");
    const transcriptBefore = await transcriptMessages(window);

    const afterSecondQuestion = await window.evaluate(
      async ({ target, text }) => {
        const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        return app.sendSideChatMessage({ ...target, text });
      },
      { target: source, text: SIDE_QUESTION_2 },
    );
    expect(afterSecondQuestion.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(afterSecondQuestion.messages.at(-1)?.text).toContain("SOURCE_V2");

    const afterPermissionQuestion = await window.evaluate(
      async ({ target, text }) => {
        const app = (globalThis.window as PiAppWindow).piApp as PiDesktopApi | undefined;
        if (!app) throw new Error("piApp IPC bridge is unavailable");
        return app.sendSideChatMessage({ ...target, text });
      },
      { target: source, text: SIDE_QUESTION_PERMISSIONS },
    );
    expect(afterPermissionQuestion.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(afterPermissionQuestion.messages.at(-1)?.text).toContain(
      "全部写入、注册扩展和 PAO 控制工具",
    );

    expect(await readFile(protectedPath, "utf8")).toBe("ORIGINAL_PROTECTED_CONTENT\n");
    expect(await readFile(canaryPath, "utf8")).toBe(canaryAfterSourceCall);
    expect(await gitSnapshot(workspacePath)).toEqual(gitBefore);
    expect(await readFile(paoRecordPath, "utf8")).toBe(paoRecordBefore);
    expect((await getDesktopState(window)).composerDraft).toBe(DRAFT_SENTINEL);
    expect(await transcriptMessages(window)).toEqual(transcriptBefore);

    const calls = await modelCalls(modelLogPath);
    const sourceCanaryCall = calls.find(
      (call) =>
        call.currentText.includes(MAIN_QUESTION_1) &&
        call.toolResults.some((result) => result.toolCallId === "source-project-canary"),
    );
    expect(sourceCanaryCall, "来源运行时必须真实装配可写项目扩展").toBeDefined();
    expect(sourceCanaryCall?.toolNames).toEqual(
      expect.arrayContaining([PROJECT_CANARY_TOOL, ...PUBLIC_PAO_TOOL_NAMES]),
    );
    expect(
      sourceCanaryCall?.toolResults.find((result) => result.toolCallId === "source-project-canary"),
    ).toMatchObject({
      toolName: PROJECT_CANARY_TOOL,
      isError: false,
    });

    const firstToolCall = calls.find(
      (call) =>
        call.sideQuestion1 &&
        call.toolResults.some((result) => result.toolCallId === "side-chat-read-outside"),
    );
    expect(firstToolCall, "第一轮辅助问答应真实执行工具调用").toBeDefined();
    const readResult = firstToolCall?.toolResults.find(
      (result) => result.toolCallId === "side-chat-read-outside",
    );
    const deniedWrite = firstToolCall?.toolResults.find(
      (result) => result.toolCallId === "side-chat-write-denied",
    );
    expect(readResult).toMatchObject({
      toolName: "read",
      isError: false,
    });
    expect(readResult?.text).toContain(OUTSIDE_READ_TOKEN);
    expect(deniedWrite).toMatchObject({
      toolName: "write",
      isError: true,
    });

    const permissionsCall = calls.find(
      (call) => call.sideQuestionPermissions && call.toolResults.length >= 11,
    );
    expect(permissionsCall, "权限反例应经真实工具入口返回结果").toBeDefined();
    expect(permissionsCall?.toolNames).toEqual(["read", "grep", "find", "ls"]);
    expect(permissionsCall?.toolNames).not.toEqual(
      expect.arrayContaining([PROJECT_CANARY_TOOL, ...PUBLIC_PAO_TOOL_NAMES]),
    );
    expect(
      Object.fromEntries(
        permissionsCall!.toolResults.map((result) => [
          result.toolName,
          { isError: result.isError, text: result.text },
        ]),
      ),
    ).toMatchObject({
      write: { isError: true },
      edit: { isError: true },
      bash: { isError: true },
      powershell: { isError: true },
      [PROJECT_CANARY_TOOL]: { isError: true },
      pao_dispatch_card: { isError: true },
      pao_stop_background: { isError: true },
      pao_terminate_card: { isError: true },
      pao_confirm_flow: { isError: true },
      pao_control_node: { isError: true },
      pao_submit_decision: { isError: true },
    });

    const secondSourceCall = calls.find((call) => call.sideQuestion2);
    expect(secondSourceCall, "第二轮辅助问答应把最新主控材料送入模型").toMatchObject({
      sourceV1: true,
      sourceV2: true,
      mainV1Occurrences: 1,
      mainV2Occurrences: 1,
      sideQuestion1Occurrences: 1,
      sideQuestion2Occurrences: 1,
    });
    expect(calls.find((call) => call.sideQuestionPermissions)).toMatchObject({
      sideQuestionPermissionsOccurrences: 1,
    });
  } finally {
    await harness.close();
  }
});
