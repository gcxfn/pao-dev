import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  type Context,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { SessionRef } from "@pi-gui/session-driver";
import { SideChatSupervisor } from "./dist/side-chat.js";
import type {
  SessionSupervisor,
  SideChatSourceSnapshot,
} from "./dist/session-supervisor.js";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<{ agentDir: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "p4-side-chat-probe-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspace);
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  return { agentDir, workspace };
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

test("failed partial response is persisted as complete", async () => {
  const { agentDir, workspace } = await makeRoot();
  const ref: SessionRef = { workspaceId: "probe-workspace", sessionId: "probe-session" };
  const fakeSession = {
    messages: [] as unknown[],
    getActiveToolNames: () => ["read"],
    getCallableToolNames: () => ["read"],
    async prompt() {
      this.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "PARTIAL_ANSWER_SAVED_AS_SUCCESS" }],
        api: "faux",
        provider: "faux",
        model: "probe",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "PROVIDER_FAILED_AFTER_PARTIAL",
        timestamp: Date.now(),
      });
    },
  };
  const source: SideChatSourceSnapshot = {
    ref,
    workspacePath: workspace,
    status: "idle",
    boundaryId: "leaf-probe",
    capturedAt: new Date().toISOString(),
    sourceBusy: false,
    messages: [],
    modelRuntime: {} as SideChatSourceSnapshot["modelRuntime"],
    modelSelection: { provider: "faux", modelId: "probe" },
    limitations: [],
  };
  const supervisor = new SideChatSupervisor({
    supervisor: {} as SessionSupervisor,
    agentDir,
    createSideChatSource: async () => source,
    runtimeFactory: async () => ({
      session: fakeSession as unknown as AgentSession,
      dispose() {},
    }),
  });

  const snapshot = await supervisor.sendSideChatMessage({
    source: ref,
    text: "PROBE_FAILED_QUESTION",
  });
  const message = snapshot.messages.find(
    (item) => item.role === "assistant" && item.text === "PARTIAL_ANSWER_SAVED_AS_SUCCESS",
  );
  assert.ok(message);
  console.log(JSON.stringify({
    probe: "failed_partial",
    status: message.status,
    hasError: Boolean(message.error),
    snapshotError: snapshot.error ?? null,
  }));
  assert.equal(message.status, "complete");
  assert.equal(message.error, undefined);
  assert.equal(snapshot.error, undefined);
});

test("invalid image is omitted while contextComplete remains true", async () => {
  const { agentDir, workspace } = await makeRoot();
  const workspaceRealPath = await realpath(workspace);
  const ref: SessionRef = { workspaceId: "probe-workspace", sessionId: "probe-image-session" };
  const faux = fauxProvider({ models: [{ id: "probe-image-model", input: ["text", "image"] }] });
  const contexts: Context[] = [];
  const response = (context: Context) => {
    contexts.push(context);
    return fauxAssistantMessage("IMAGE_PROBE_ANSWER");
  };
  faux.setResponses([response, response, response, response]);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  const model = faux.getModel();
  modelRuntime.registerNativeProvider(faux.provider);
  const source: SideChatSourceSnapshot = {
    ref,
    workspacePath: workspace,
    status: "idle",
    boundaryId: "leaf-image",
    capturedAt: new Date().toISOString(),
    sourceBusy: false,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "SOURCE_HAS_INVALID_IMAGE" },
        { type: "image", data: "bm90LWEtcG5n", mimeType: "image/tiff" },
      ],
      timestamp: Date.now(),
    }],
    modelRuntime,
    modelSelection: { provider: model.provider, modelId: model.id },
    limitations: [],
  };
  const supervisor = new SideChatSupervisor({
    supervisor: {} as SessionSupervisor,
    agentDir,
    createSideChatSource: async () => source,
    runtimeFactory: async ({ manager }) => {
      const created = await createAgentSession({
        cwd: workspaceRealPath,
        agentDir,
        modelRuntime,
        model,
        sessionManager: manager,
        tools: [],
      });
      return {
        session: created.session,
        dispose: () => created.session.dispose(),
      };
    },
  });

  const snapshot = await supervisor.sendSideChatMessage({
    source: ref,
    text: "PROBE_BAD_IMAGE",
  });
  const context = contexts.find((item) =>
    item.messages.some((message) => textOf(message.content).includes("PROBE_BAD_IMAGE")),
  );
  assert.ok(context);
  const contextText = context.messages.map((message) => textOf(message.content)).join("\n");
  const actualImages = context.messages.reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "image").length
        : 0),
    0,
  );
  console.log(JSON.stringify({
    probe: "invalid_image",
    contextComplete: snapshot.sync.contextComplete,
    limitations: snapshot.sync.limitations,
    actualImages,
    omittedHint: contextText.includes("[Image omitted"),
  }));
  assert.equal(snapshot.sync.contextComplete, true);
  assert.equal(actualImages, 0);
  assert.equal(contextText.includes("[Image omitted"), true);
});
