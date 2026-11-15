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
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZK2kAAAAASUVORK5CYII=";
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
}

async function makePiDriverFixture(t: TestContext): Promise<PiDriverFixture> {
  const { root, agentDir, workspace } = await makeRoot(t);
  const faux = fauxProvider({ models: [{ id: "side-model", input: ["text", "image"] }] });
  const contexts: Context[] = [];
  const response = (context: Context) => {
    contexts.push(context);
    return fauxAssistantMessage("离线替身回答");
  };
  // 会话装配和缓存预热可能先消费模型响应；重复队列让专项请求仍命中
  // 同一离线替身，而不是让测试依赖前序内部消费次数。
  faux.setResponses([response, response, response, response]);
  let runtime!: AgentSessionRuntime;
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
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
  t.after(async () => {
    await driver.disposeAll();
  });
  return { driver, ref, runtime: runtime!, agentDir, root, workspace, contexts };
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
    driver: new PiSdkDriver({ agentDir, catalogFilePath: catalogPath }),
    supervisor,
    ref,
    file,
    bytes,
    hash: sha256(bytes),
  };
}

await test("P4 failed partial probe", async (t) => {
  const app = await makePiDriverFixture(t);
  const originalFactory = app.driver["sideChatSupervisor"]["runtimeFactory"];
  app.driver["sideChatSupervisor"]["runtimeFactory"] = async (options: any) => {
    const runtime = await originalFactory(options);
    runtime.session.prompt = async () => {
      options.manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "PARTIAL_ANSWER_SAVED_AS_SUCCESS" }],
        api: "faux",
        provider: "faux",
        model: "side-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: "PROVIDER_FAILED_AFTER_PARTIAL",
        timestamp: Date.now(),
      });
    };
    return runtime;
  };
  const snap = await app.driver.sendSideChatMessage({ source: app.ref, text: "PROBE_FAILED_QUESTION" });
  const msg = snap.messages.find((m) => m.role === "assistant" && m.text.includes("PARTIAL_ANSWER_SAVED_AS_SUCCESS"));
  assert.ok(msg);
  console.log(JSON.stringify({ probe: "failed_partial", status: msg.status, hasError: Boolean(msg.error), snapshotError: snap.error ?? null, text: msg.text }));
});

await test("P4 bad image probe", async (t) => {
  const app = await makePiDriverFixture(t);
  const manager = app.runtime.session.sessionManager;
  manager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "SOURCE_HAS_INVALID_IMAGE" },
      { type: "image", data: "bm90LWEtcG5n", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });
  app.runtime.session.refreshContext();
  forcePersistPiSession(manager);
  const snap = await app.driver.sendSideChatMessage({ source: app.ref, text: "PROBE_BAD_IMAGE" });
  const context = app.contexts.find((item) => allContextText(item).includes("PROBE_BAD_IMAGE"));
  assert.ok(context);
  const text = allContextText(context);
  console.log(JSON.stringify({
    probe: "bad_image",
    contextComplete: snap.sync.contextComplete,
    limitations: snap.sync.limitations,
    actualImages: context.messages.flatMap((m) => "content" in m && Array.isArray(m.content) ? m.content.filter((p) => p.type === "image") : []).length,
    omittedHint: text.includes("[Image omitted"),
  }));
});

await test("P4 invalid closed session probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-side-chat-bad-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspace);
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: [] }));
  const supervisor = new SessionSupervisor({ agentDir, catalogFilePath: join(root, "catalogs.json") });
  const workspaceRef = await supervisor.registerWorkspace(workspace);
  const file = join(workspace, "bad.jsonl");
  const sessionId = "bad-session";
  const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace };
  await writeFile(file, `${JSON.stringify(header)}\nnot-json\n`);
  const sessionRef = { workspaceId: workspaceRef.workspaceId, sessionId };
  await supervisor["catalogs"].replaceWorkspaceSessions(
    workspaceRef.workspaceId,
    [{ sessionRef, workspaceId: workspaceRef.workspaceId, title: "bad", updatedAt: "2026-01-01T00:00:00.000Z", status: "idle" }],
    { [sessionKey(sessionRef)]: file },
  );
  console.log(JSON.stringify({ probe: "invalid_closed", rejected: await supervisor.getSideChatSource(sessionRef).then(() => false).catch((e) => /不是有效 JSON/.test(String(e))) }));
});

