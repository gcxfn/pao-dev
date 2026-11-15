// 真实 CLI 的离线模型夹具：仅替换模型回应，加载当前构建的原生 faux provider。
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, getCurrentTools } from "../../../ai/dist/index.js";
import paoExtension from "../../dist/pao/index.js";

export default function lifecycleProvider(pi) {
  const record = (value) => appendFileSync(process.env.PAO_CLI_TEST_LOG, JSON.stringify(value) + "\n");
  const slow = process.env.PAO_CLI_TEST_CASE === "abort";
  const faux = fauxProvider({ tokensPerSecond: slow ? 2 : 1_000_000 });
  faux.setResponses([(context) => {
    record({ type: "request", messages: context.messages,
      systemPrompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages) });
    return fauxAssistantMessage(slow ? "等待主动停止".repeat(100) : "离线回应完成", {
      ...(process.env.PAO_CLI_TEST_CASE === "error"
        ? { stopReason: "error", errorMessage: "离线供应商故障" }
        : {}),
    });
  }]);
  pi.registerProvider(faux.provider);
  if (process.env.PAO_CLI_TEST_CASE === "role") paoExtension(pi);
  pi.on("session_start", (_event, ctx) => {
    record({ type: "start", id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() });
  });
  pi.on("session_shutdown", (event) => record({ type: "shutdown", reason: event.reason }));
}
