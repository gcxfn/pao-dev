
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@pao/ai";

const PROVIDER_ID = "packaged-memory-s4-17-offline";
const MODEL_ID = "offline-scripted";
const LOG_PATH = process.env.PACKAGED_MEMORY_PROVIDER_LOG;
const INITIAL_CONCLUSION = "发行验收口令 local-test-token 的初始值为甲。";
const WRITE_PROMPT = "S4-17_WRITE_MEMORY";
const phase = process.env.PACKAGED_MEMORY_PROVIDER_PHASE;

function record(value) {
  if (LOG_PATH) appendFileSync(LOG_PATH, JSON.stringify(value) + "\n");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object") {
      try {
        return JSON.stringify(content);
      } catch {
        return String(content);
      }
    }
    return "";
  }
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function message(model, content, stopReason) {
  return {
    role: "assistant",
    content,
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
    stopReason,
    timestamp: Date.now(),
  };
}

function finishedStream(model, text) {
  const assistant = message(model, [{ type: "text", text }], "stop");
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...assistant, content: [] } });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant });
  stream.push({ type: "done", reason: "stop", message: assistant });
  return stream;
}

function callTools(model, content) {
  const assistant = message(model, content, "toolUse");
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...assistant, content: [] } });
  stream.push({ type: "done", reason: "toolUse", message: assistant });
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
    streamSimple(model, context) {
      const lastUser = context.messages.findLastIndex((entry) => entry.role === "user");
      const currentMessages =
        lastUser === -1 ? context.messages : context.messages.slice(lastUser + 1);
      const currentText =
        lastUser === -1 ? "" : contentText(context.messages[lastUser]?.content);
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
          details: entry.details,
        }));

      record({
        type: "request",
        phase,
        currentText,
        toolCalls,
        toolResults,
        pid: process.pid,
      });

      if (phase === "write" && currentText.includes(WRITE_PROMPT)) {
        const existing = toolResults.find((entry) => entry.toolName === "pao_memory_write");
        if (!existing) {
          return callTools(model, [{
            type: "toolCall",
            id: "s4-17-packaged-write",
            name: "pao_memory_write",
            arguments: {
              content: INITIAL_CONCLUSION,
              tags: ["S4-17", "packaged-memory"],
            },
          }]);
        }
        return finishedStream(model, "离线脚本 provider：打包 CLI 写入工具已返回。");
      }

      return finishedStream(model, "离线脚本 provider：非 S4-17 调用已跳过。");
    },
  });
}
