import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  type Context,
} from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSessionRuntime,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  SessionRef,
  SideChatSnapshot,
} from "@pi-gui/session-driver";
import { sessionKey } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { SideChatSupervisor } from "../dist/side-chat.js";
import {
  SessionSupervisor,
  type SideChatSourceSnapshot,
} from "../dist/session-supervisor.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";
import { forcePersistPiSession } from "../dist/compat/pi-session-persistence.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const BROKEN_PNG_BASE64 = Buffer.from("not-a-png").toString("base64");
const BUSY_LIMITATION =
  "主对话仍在运行；已读取当前可用的已完成边界，不包含尚未结束的模型输出或工具结果，也无需等待、暂停或取消主控。";

const assistantText = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: Date.now(),
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function allContextText(context: Context): string {
  return context.messages.map((message) => textOf(message.content)).join("\n");
}

async function makeRoot(t: TestContext): Promise<{
  root: string;
  agentDir: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-side-chat-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspace);
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  return { root, agentDir, workspace };
}

async function sessionFileFrom(runtime: AgentSessionRuntime): Promise<string> {
  await runtime.session.waitForIdle();
  const sessionFile = runtime.session.sessionFile;
  assert.ok(sessionFile, "fixture runtime must use a persisted session file");
  return sessionFile;
}

async function makeStoreTarget(
  app: PiDriverFixture,
): Promise<{ directory: string; original: string }> {
  const root = join(app.agentDir, "aux", "side-chat");
  await mkdir(root, { recursive: true });
  const createSource = app.driver.sideChatSupervisor["createSource"];
  const source = await createSource(app.ref);
  const workspaceRealPath = await realpath(source.workspacePath);
  const key = createHash("sha256")
    .update(`${app.ref.workspaceId}\0${app.ref.sessionId}\0${workspaceRealPath}`)
    .digest("hex");
  return { directory: root, original: join(root, `${key}.json`) };
}

interface PiDriverFixture {
  readonly driver: PiSdkDriver;
  readonly ref: SessionRef;
  readonly runtime: AgentSessionRuntime;
  readonly agentDir: string;
  readonly root: string;
  readonly workspace: string;
  readonly contexts: Context[];
  readonly faux: ReturnType<typeof fauxProvider>;
}

type FauxModelInput = ("text" | "image")[];

async function makePiDriverFixture(
  t: TestContext,
  options: { readonly modelInput?: FauxModelInput } = {},
): Promise<PiDriverFixture> {
  const { root, agentDir, workspace } = await makeRoot(t);
  const faux = fauxProvider({
    models: [{ id: "side-model", input: options.modelInput ?? ["text", "image"] }],
  });
  const contexts: Context[] = [];
  const response = (context: Context) => {
    contexts.push(context);
    return fauxAssistantMessage("离线替身回答");
  };
  // 会话装配和缓存预热可能先消费模型响应；重复队列让专项请求仍命中
  // 同一离线替身，而不是让测试依赖前序内部消费次数。
  faux.setResponses([response, response, response, response, response, response, response, response]);
  let runtime!: AgentSessionRuntime;
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    piAddons: [],
    builtinExtensions: [],
    includePaoBuiltinExtension: false,
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      const modelRuntime = await (await import("@earendil-works/pi-coding-agent")).ModelRuntime.create({
        modelsPath: join(agentDir, "models.json"),
        authPath: join(agentDir, "auth.json"),
        refreshOnCreate: false,
      });
      const model = faux.getModel();
      modelRuntime.registerNativeProvider(faux.provider);
      runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        modelRuntime,
        model,
        tools: [],
      });
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "side-workspace", path: workspace },
    { initialModel: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
  );
  faux.setResponses([response, response, response, response]);
  t.after(async () => {
    await driver.disposeAll();
  });
  return { driver, ref, runtime: runtime!, agentDir, root, workspace, contexts, faux };
}

async function appendSource(
  runtimeFixture: PiDriverFixture,
): Promise<void> {
  const manager = runtimeFixture.runtime.session.sessionManager;
  manager.appendMessage({
    role: "system",
    content: "历史系统基础",
    sections: {
      git: "<git_context>原始 Git 材料</git_context>",
      identity: "<identity>历史主身份 SOURCE_ONLY</identity>",
    },
    timestamp: 1,
  });
  const imageUser = manager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "主对话需求 SOURCE_USER_ONCE" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ],
    timestamp: 2,
  });
  const editableUser = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "上下文编辑目标 SOURCE_EDIT_TARGET" }],
    timestamp: 3,
  });
  manager.appendContextEdit(editableUser, {
    content: [{ type: "text", text: "上下文编辑 CONTEXT_EDIT_VISIBLE" }],
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-image",
    toolName: "read",
    content: [
      { type: "text", text: "工具结果 TOOL_RESULT_VISIBLE" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 4,
  });
  const call = assistantText("");
  manager.appendMessage({
    ...call,
    content: [
      { type: "toolCall", id: "orphan-call", name: "write", arguments: { path: "blocked.txt" } },
    ],
  });
  manager.appendCompaction("压缩摘要 COMPACTION_VISIBLE", imageUser, 100);
  runtimeFixture.runtime.session.refreshContext();
  forcePersistPiSession(manager);
}

async function oldSessionFixture(
  t: TestContext,
  version: 1 | 2,
): Promise<{
  driver: PiSdkDriver;
  supervisor: SessionSupervisor;
  ref: SessionRef;
  file: string;
  bytes: Buffer;
  hash: string;
}> {
  const { root, agentDir, workspace } = await makeRoot(t);
  const supervisor = new SessionSupervisor({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
  });
  const workspaceRef = await supervisor.registerWorkspace(workspace);
  const ref: SessionRef = {
    workspaceId: workspaceRef.workspaceId,
    sessionId: `old-v${version}-session`,
  };
  const file = join(workspace, `old-v${version}.jsonl`);
  const header = {
    type: "session" as const,
    ...(version === 1 ? {} : { version: 2 }),
    id: ref.sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: workspace,
  };
  const user: Record<string, unknown> = {
    type: "message",
    ...(version === 1 ? {} : { id: "user-old", parentId: null }),
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "旧日志来源材料", timestamp: 1 },
  };
  await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
  const bytes = await readFile(file);
  const catalogPath = join(root, "catalogs.json");
  return {
    driver: new PiSdkDriver({
      agentDir,
      catalogFilePath: catalogPath,
      piAddons: [],
      builtinExtensions: [],
      includePaoBuiltinExtension: false,
    }),
    supervisor,
    ref,
    file,
    bytes,
    hash: sha256(bytes),
  };
}

async function catalogSession(
  supervisor: SessionSupervisor,
  ref: SessionRef,
) {
  return supervisor["catalogs"].sessions.getSession(ref);
}

await test("主投影材料、真实图片和 system sections 进入辅助 prompt，且问答不重复", async (t) => {
  const app = await makePiDriverFixture(t);
  await appendSource(app);
  const first = await app.driver.sendSideChatMessage({ source: app.ref, text: "SIDE_QUESTION_ONCE" });
  const context = app.contexts.find((item) =>
    allContextText(item).includes("SIDE_QUESTION_ONCE"),
  );
  assert.ok(context, "应捕获包含本次辅助问题的模型上下文");
  const text = allContextText(context);
  assert.match(text, /上下文编辑 CONTEXT_EDIT_VISIBLE/);
  assert.match(text, /压缩摘要 COMPACTION_VISIBLE/);
  assert.match(text, /原始 Git 材料/);
  assert.match(text, /SOURCE_ONLY/);
  assert.match(text, /TOOL_RESULT_VISIBLE/);
  assert.match(text, /source_material role="historical_only"/);
  assert.ok(text.includes("SIDE_QUESTION_ONCE"));
  assert.equal(text.split("SIDE_QUESTION_ONCE").length - 1, 1);

  const images = context.messages.flatMap((message) =>
    "content" in message && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image")
      : [],
  );
  assert.equal(
    images.length,
    2,
    `source user and toolResult images must both reach the provider; messages=${JSON.stringify(
      context.messages.map((message) => ({
        role: message.role,
        keys: Object.keys(message),
        parts:
          "content" in message && Array.isArray(message.content)
            ? message.content.map((part) => part.type)
            : typeof message.content,
      })),
    )}`,
  );
  assert.ok(images.every((image) => image.data === PNG_BASE64));
  assert.equal(first.busy, false);
  assert.ok(first.messages.some((message) => message.text === "离线替身回答"));
  assert.ok(first.sync.limitations.some((item) => /write \(orphan-call\)/.test(item)));
  assert.equal(first.readOnly, true);
  assert.deepEqual(first.toolNames, ["read", "grep", "find", "ls"]);
});

await test("损坏的辅助记录不静默清空；修好后同一 runtime 可再次发送", async (t) => {
  const app = await makePiDriverFixture(t);
  const target = await makeStoreTarget(app);
  await writeFile(target.original, "{broken");
  await assert.rejects(
    app.driver.sendSideChatMessage({ source: app.ref, text: "first" }),
    /读取辅助对话记录失败/,
  );
  await writeFile(
    target.original,
    JSON.stringify({
      version: 1,
      source: { workspaceId: app.ref.workspaceId, sessionId: app.ref.sessionId },
      workspaceRealPath: app.workspace,
      messages: [],
      updatedAt: new Date().toISOString(),
    }),
  );
  const recovered = await app.driver.sendSideChatMessage({ source: app.ref, text: "retry" });
  assert.ok(recovered.messages.some((message) => message.text === "离线替身回答"));
  assert.equal(recovered.busy, false);
});

await test("旧 v1/v2 闭会话日志只读加载，字节和哈希不变", async (t) => {
  for (const version of [1, 2] as const) {
    const root = await mkdtemp(join(tmpdir(), "pi-gui-side-chat-old-"));
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "sessions"), { recursive: true });
    await mkdir(agentDir);
    await writeFile(join(agentDir, "auth.json"), "{}");
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
    const header = {
      type: "session",
      ...(version === 1 ? {} : { version: 2 }),
      id: `v${version}-source`,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: workspace,
    };
    const message = {
      type: "message",
      ...(version === 1 ? {} : { id: "user-entry", parentId: null }),
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: `旧日志 v${version}`, timestamp: 1 },
    };
    const file = join(workspace, "sessions", `v${version}.jsonl`);
    await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
    const before = await readFile(file);
    const supervisor = new SessionSupervisor({
      agentDir,
      catalogFilePath: join(root, "catalogs.json"),
    });
    const workspaceRef = await supervisor.registerWorkspace(workspace);
    const catalogStorage = supervisor["catalogs"];
    const sessionRef = { workspaceId: workspaceRef.workspaceId, sessionId: header.id };
    await catalogStorage.sessions.upsertSession({
      sessionRef,
      workspaceId: workspaceRef.workspaceId,
      status: "idle",
      updatedAt: "2026-01-01T00:00:01.000Z",
      messageCount: 1,
      firstMessage: `旧日志 v${version}`,
      title: `旧日志 v${version}`,
      sessionFilePath: file,
    });
    const source = await supervisor.getSideChatSource(sessionRef);
    assert.match(JSON.stringify(source.messages), new RegExp(`旧日志 v${version}`));
    const after = await readFile(file);
    assert.equal(sha256(after), sha256(before));
    assert.deepEqual(after, before);
  }
});

await test("空和损坏的主会话日志显式失败，不变成新空会话", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-side-chat-bad-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspace);
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  const supervisor = new SessionSupervisor({ agentDir, catalogFilePath: join(root, "catalogs.json") });
  const workspaceRef = await supervisor.registerWorkspace(workspace);
  for (const [name, content, pattern] of [
    ["empty", "", /日志为空/],
    ["broken", '{"type":"session"}\nnot-json\n', /不是有效 JSON/],
  ] as const) {
    const file = join(workspace, `${name}.jsonl`);
    await writeFile(file, content);
    const sessionId = `${name}-session`;
    const sessionRef = { workspaceId: workspaceRef.workspaceId, sessionId };
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: workspace,
    };
    await writeFile(file, name === "empty" ? "" : `${JSON.stringify(header)}\nnot-json\n`);
    const catalogStorage = supervisor["catalogs"];
    await catalogStorage.replaceWorkspaceSessions(
      workspaceRef.workspaceId,
      [
        {
          sessionRef,
          workspaceId: workspaceRef.workspaceId,
          title: name,
          updatedAt: "2026-01-01T00:00:00.000Z",
          status: "idle",
        },
      ],
      { [sessionKey(sessionRef)]: file },
    );
    await assert.rejects(supervisor.getSideChatSource(sessionRef), pattern);
    assert.equal((await readFile(file, "utf8")).includes("not-json"), name === "broken");
  }
});

await test("主控忙时读取标出完成边界，不阻断辅助问答", async (t) => {
  const app = await makePiDriverFixture(t);
  let sourceBusy = true;
  const sourceFor = (): SideChatSourceSnapshot => ({
    ref: app.ref,
    workspacePath: app.workspace,
    status: sourceBusy ? "running" : "idle",
    boundaryId: sourceBusy ? "leaf-1" : "leaf-2",
    capturedAt: new Date().toISOString(),
    sourceBusy,
    messages: [],
    modelRuntime: app.runtime.session.modelRuntime,
    modelSelection: {
      provider: app.runtime.session.model!.provider,
      modelId: app.runtime.session.model!.id,
    },
    limitations: sourceBusy ? [BUSY_LIMITATION] : [],
    blockImages: false,
  });
  const supervisor = new SideChatSupervisor({
    supervisor: new SessionSupervisor({
      agentDir: app.agentDir,
      catalogFilePath: join(app.root, "busy-catalogs.json"),
      piAddons: [],
      builtinExtensions: [],
      includePaoBuiltinExtension: false,
    }),
    agentDir: app.agentDir,
    createSideChatSource: async () => sourceFor(),
  });
  const running = await supervisor.getSideChat(app.ref);
  assert.equal(running.sync.contextComplete, false);
  assert.equal(running.sync.sourceStatus, "running");
  assert.ok(running.sync.limitations.includes(BUSY_LIMITATION));

  sourceBusy = false;
  const idle = await supervisor.getSideChat(app.ref);
  assert.equal(idle.sync.sourceStatus, "idle");
  assert.equal(idle.sync.contextComplete, true);
  assert.deepEqual(idle.sync.limitations, []);
});

for (const stopReason of ["error", "aborted"] as const) {
  await test(`P4-04 ${stopReason} 的部分回答保留但不作为成功历史`, async (t) => {
    const app = await makePiDriverFixture(t);
    const partialText = `P4_PARTIAL_${stopReason.toUpperCase()}`;
    app.faux.setResponses([
      fauxAssistantMessage(partialText, {
        stopReason,
        errorMessage: `P4_${stopReason.toUpperCase()}_FAILED`,
      }),
    ]);
    const failed = await app.driver.sendSideChatMessage({
      source: app.ref,
      text: "P4_FAILED_QUESTION",
    });
    const failedAnswer = failed.messages.find(
      (message) => message.text === partialText,
    );
    assert.equal(failedAnswer?.status, "error");
    assert.equal(failedAnswer?.error?.code, stopReason.toUpperCase());
    assert.match(failedAnswer?.error?.message ?? "", new RegExp(`P4_${stopReason.toUpperCase()}_FAILED`));

    app.faux.setResponses([
      (context) => {
        app.contexts.push(context);
        return fauxAssistantMessage("P4_RECOVERY_COMPLETE");
      },
    ]);
    const recovered = await app.driver.sendSideChatMessage({
      source: app.ref,
      text: "P4_RECOVERY_QUESTION",
    });
    assert.ok(recovered.messages.some((message) => message.text === "P4_RECOVERY_COMPLETE"));
    const recoveryContext = app.contexts.find((context) =>
      allContextText(context).includes("P4_RECOVERY_QUESTION"),
    );
    assert.ok(recoveryContext);
    assert.doesNotMatch(allContextText(recoveryContext), new RegExp(partialText));
  });
}

await test("P4-04 连续三次失败后健康回答不受错误历史计数影响", async (t) => {
  const app = await makePiDriverFixture(t);
  const failures = [
    ["error", "P4_CHAIN_PARTIAL_ERROR"],
    ["aborted", "P4_CHAIN_PARTIAL_ABORTED"],
    ["error", "P4_CHAIN_PARTIAL_ERROR_AGAIN"],
  ] as const;
  for (const [stopReason, text] of failures) {
    app.faux.setResponses([
      fauxAssistantMessage(text, {
        stopReason,
        errorMessage: `P4_CHAIN_${stopReason.toUpperCase()}_FAILED`,
      }),
    ]);
    const failed = await app.driver.sendSideChatMessage({
      source: app.ref,
      text: `P4_CHAIN_QUESTION_${text}`,
    });
    assert.equal(
      failed.messages.find((message) => message.text === text)?.status,
      "error",
    );
  }

  app.faux.setResponses([fauxAssistantMessage("P4_CHAIN_RECOVERY_COMPLETE")]);
  const recovered = await app.driver.sendSideChatMessage({
    source: app.ref,
    text: "P4_CHAIN_RECOVERY_QUESTION",
  });
  assert.equal(
    recovered.messages.filter(
      (message) => message.text === "P4_CHAIN_RECOVERY_COMPLETE",
    ).length,
    1,
  );
  assert.equal(
    recovered.messages.filter(
      (message) => message.text === "离线替身回答",
    ).length,
    0,
  );
  for (const [, text] of failures) {
    assert.equal(
      recovered.messages.filter((message) => message.text === text).length,
      1,
    );
  }
});

await test("P4-05 坏图与正常图并存时只报告坏图，并在重开和再次同步时保持限制", async (t) => {
  const app = await makePiDriverFixture(t);
  const imageMessage = app.runtime.session.sessionManager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "P4_IMAGES_SOURCE" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: BROKEN_PNG_BASE64, mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });
  app.runtime.session.refreshContext();
  forcePersistPiSession(app.runtime.session.sessionManager);

  const first = await app.driver.sendSideChatMessage({
    source: app.ref,
    text: "P4_IMAGE_QUESTION",
  });
  assert.equal(first.sync.contextComplete, false);
  assert.equal(first.sync.limitations.filter((item) => item.includes("图片附件未被模型接收")).length, 1);
  const imageContext = app.contexts.find((context) =>
    allContextText(context).includes("P4_IMAGE_QUESTION"),
  );
  assert.ok(imageContext);
  const imageContextText = allContextText(imageContext);
  assert.match(imageContextText, /complete=false/);
  for (const limitation of first.sync.limitations) {
    assert.ok(
      imageContextText.includes(`limitation=${limitation}`),
      `faux provider 收到的同步段应包含 UI snapshot 的限制：${limitation}`,
    );
  }
  const deliveredImages = imageContext.messages.flatMap((message) =>
    "content" in message && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image")
      : [],
  );
  assert.equal(deliveredImages.length, 1);
  assert.equal(deliveredImages[0]?.data, PNG_BASE64);

  const restored = await app.driver.getSideChat(app.ref);
  assert.equal(restored.sync.contextComplete, false);
  assert.ok(restored.sync.limitations.some((item) => item.includes("图片附件未被模型接收")));

  app.runtime.session.sessionManager.appendContextEdit(imageMessage, {
    content: [{ type: "text", text: "P4_BROKEN_IMAGE_REMOVED" }],
  });
  app.runtime.session.refreshContext();
  const repaired = await app.driver.getSideChat(app.ref);
  assert.equal(repaired.sync.contextComplete, true);
  assert.deepEqual(repaired.sync.limitations, []);
});

for (const blockedBy of ["source setting", "model capability"] as const) {
  await test(`P4-05 ${blockedBy} 不绕过来源图片策略，也不声称附件完整`, async (t) => {
    const app = await makePiDriverFixture(t, {
      modelInput: blockedBy === "model capability" ? ["text"] : ["text", "image"],
    });
    if (blockedBy === "source setting") {
      app.runtime.session.settingsManager.setBlockImages(true);
    }
    app.runtime.session.sessionManager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: `P4_IMAGE_POLICY_${blockedBy}` },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    });
    app.runtime.session.refreshContext();
    forcePersistPiSession(app.runtime.session.sessionManager);

    const snapshot = await app.driver.sendSideChatMessage({
      source: app.ref,
      text: "P4_IMAGE_POLICY_QUESTION",
    });
    assert.equal(snapshot.sync.contextComplete, false);
    const policyLimitations = snapshot.sync.limitations.filter(
      (item) =>
        item.includes("禁止图片输入") ||
        item.includes("不支持图片输入"),
    );
    assert.equal(policyLimitations.length, 1);
    const providerContext = app.contexts.find((context) =>
      allContextText(context).includes("P4_IMAGE_POLICY_QUESTION"),
    );
    assert.ok(providerContext);
    const providerContextText = allContextText(providerContext);
    assert.match(providerContextText, /complete=false/);
    for (const limitation of snapshot.sync.limitations) {
      assert.ok(
        providerContextText.includes(`limitation=${limitation}`),
        `faux provider 收到的同步段应包含 UI snapshot 的限制：${limitation}`,
      );
    }
    const providerImages = providerContext.messages.flatMap((message) =>
      "content" in message && Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "image")
        : [],
    );
    assert.equal(
      providerImages.length,
      blockedBy === "model capability" ? 1 : 0,
      blockedBy === "model capability"
        ? "pi 的转换层还会读取图片块，Provider 必须按模型能力省略图片"
        : "来源禁图设置应在交给模型前移除图片块",
    );
    if (blockedBy === "model capability") {
      assert.equal(app.faux.state.callCount > 0, true);
      assert.match(allContextText(providerContext), /P4_IMAGE_POLICY_model capability/);
    } else {
      assert.match(allContextText(providerContext), /Image reading is disabled/);
    }

    const restored = await app.driver.getSideChat(app.ref);
    assert.equal(restored.sync.contextComplete, false);
    assert.ok(
      restored.sync.limitations.some(
        (item) =>
          item.includes("禁止图片输入") ||
          item.includes("不支持图片输入"),
      ),
    );
  });
}
