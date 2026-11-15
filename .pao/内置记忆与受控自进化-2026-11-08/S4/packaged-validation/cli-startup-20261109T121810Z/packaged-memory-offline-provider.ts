
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@pao/ai";

const PROVIDER_ID = "packaged-memory-s4-17-offline";
const MODEL_ID = "offline-scripted";
const LOG_PATH = process.env.PACKAGED_MEMORY_PROVIDER_LOG;
const phase = process.env.PACKAGED_MEMORY_PROVIDER_PHASE;

function record(value) {
  if (LOG_PATH) appendFileSync(LOG_PATH, JSON.stringify(value) + "\n");
}

function finishedStream(model, text) {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

export default function packagedMemoryOfflineProvider(pi) {
  record({ type: "provider_factory", phase, pid: process.pid });
  pi.on("session_start", (_event, ctx) => {
    record({
      type: "session_start",
      phase,
      pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
  });
  pi.on("session_shutdown", (event) => {
    record({ type: "session_shutdown", phase, pid: process.pid, reason: event.reason });
  });
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "http://127.0.0.1:9/offline-scripted-never-contact",
    apiKey: "LOCAL_TEST_ZERO_COST",
    api: PROVIDER_ID,
    models: [{
      id: MODEL_ID,
      name: "S4-17 startup diagnostic provider",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
    streamSimple(model) {
      record({ type: "request", phase, pid: process.pid });
      return finishedStream(model, "S4-17_STARTUP_PROBE_OK");
    },
  });
}
