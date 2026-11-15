import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** While set, model calls wait for it, so a test can send into a running turn. */
let modelGate: Promise<void> | undefined;

const streamFunction: StreamFunction = (model) => {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ANSWER" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  (modelGate ?? Promise.resolve())
    .then(() =>
      setTimeout(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
      }, 10),
    )
    .catch(() => undefined);
  return stream;
};

async function setUp(t: TestContext, extensionFactories: ExtensionFactory[] = []) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-send-flight-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("This test must never use the network");
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "flight-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );

  let runtime!: AgentSessionRuntime;
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      runtime = await createAgentSessionRuntimeWithNpmFallback({
        ...runtimeOptions,
        tools: [],
        resourceLoaderOptions: {
          ...runtimeOptions.resourceLoaderOptions,
          extensionFactories: [
            ...(runtimeOptions.resourceLoaderOptions?.extensionFactories ?? []),
            ...extensionFactories,
          ],
        },
      });
      runtime.session.agent.streamFunction = streamFunction;
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "flight-workspace", path: cwd },
    { initialModel: { provider: "flight-test", modelId: "scripted" } },
  );

  const events: SessionDriverEvent[] = [];
  let lastSnapshot: Extract<SessionDriverEvent, { type: "sessionUpdated" }>["snapshot"] | undefined;
  const unsubscribe = driver.subscribe(ref, async (event) => {
    events.push(event);
    if (event.type === "sessionUpdated") lastSnapshot = event.snapshot;
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });

  const count = (type: SessionDriverEvent["type"]) =>
    events.filter((event) => event.type === type).length;
  return {
    driver,
    ref,
    runtime: () => runtime,
    events,
    lastSnapshot: () => lastSnapshot,
    async waitForRuns(runs: number) {
      const deadline = Date.now() + 5_000;
      while (count("runCompleted") < runs && Date.now() < deadline) {
        await sleep(10);
      }
      await runtime.session.waitForIdle();
      // Anything still on its way would show here.
      await sleep(100);
    },
    statuses: () =>
      events.flatMap((event) => (event.type === "sessionUpdated" ? [event.snapshot.status] : [])),
    turns: () =>
      runtime.session.messages.flatMap((message) =>
        message.role === "user"
          ? [
              typeof message.content === "string"
                ? message.content
                : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
            ]
          : message.role === "assistant"
            ? ["-"]
            : [],
      ),
    count,
  };
}

/** Settles a send into a string, so a rejected send fails the assertions, not the cleanup. */
const outcome = (send: Promise<void>) =>
  send.then(
    () => "sent" as const,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );

await test("a second send while the first turn runs queues instead of failing", async (t) => {
  const app = await setUp(t);
  let openModel!: () => void;
  modelGate = new Promise<void>((resolve) => {
    openModel = resolve;
  });
  t.after(() => {
    modelGate = undefined;
  });
  const first = app.driver.sendUserMessage(app.ref, { text: "first" });
  const streaming = Date.now() + 5_000;
  while (!app.runtime().session.isStreaming && Date.now() < streaming) await sleep(5);
  assert.ok(app.runtime().session.isStreaming, "the first turn started streaming");

  // The store saw the session as idle and sent direct: the driver must queue it,
  // not turn the send into a failed banner.
  const secondOutcome = await outcome(app.driver.sendUserMessage(app.ref, { text: "second" }));
  modelGate = undefined;
  openModel();
  await first.catch(() => undefined);
  await app.waitForRuns(1);

  assert.equal(secondOutcome, "sent");
  assert.deepEqual(app.turns(), ["first", "-", "second", "-"]);
  assert.equal(app.count("runFailed"), 0);
  assert.deepEqual(app.lastSnapshot()?.queuedMessages ?? [], []);
  assert.equal(app.lastSnapshot()?.status, "idle");
  // One run, one settle: no idle flapping in between, never "failed".
  assert.deepEqual(
    [...new Set(app.statuses())].filter((status) => status !== "running"),
    ["idle"],
  );
});

await test("a send arriving during the first prompt's pre-run steps queues and settles once", async (t) => {
  // A slow input handler holds the first prompt in pi's pre-run steps, where
  // isStreaming is still false and the single-flight flag is not up yet.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstReached!: () => void;
  const firstAtInput = new Promise<void>((resolve) => {
    firstReached = resolve;
  });
  const app = await setUp(t, [
    (pi) => {
      pi.on("input", async (event) => {
        if (event.text !== "first") return;
        firstReached();
        await firstHeld;
      });
    },
  ]);
  const first = app.driver.sendUserMessage(app.ref, { text: "first" });
  const reached = Date.now() + 5_000;
  while (firstAtInput.status !== "fulfilled" && Date.now() < reached) await sleep(5);
  await firstAtInput;
  assert.equal(app.runtime().session.isStreaming, false, "first is still in pi's pre-run steps");

  // Arrives in the overlap window: it must queue behind the first send, keeping
  // the order, instead of prompting pi concurrently.
  const secondOutcome = outcome(app.driver.sendUserMessage(app.ref, { text: "second" }));
  releaseFirst();
  await first.catch(() => undefined);
  await app.waitForRuns(1);

  assert.equal(await secondOutcome, "sent");
  assert.deepEqual(app.turns(), ["first", "-", "second", "-"]);
  assert.equal(app.count("runFailed"), 0);
  // Exactly one settle: the second prompt never raced in and settled early.
  assert.equal(app.count("runCompleted"), 1);
  assert.deepEqual(app.lastSnapshot()?.queuedMessages ?? [], []);
  assert.equal(app.lastSnapshot()?.status, "idle");
  assert.deepEqual(
    [...new Set(app.statuses())].filter((status) => status !== "running"),
    ["idle"],
  );
});
