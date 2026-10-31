// 用途：向真实 PAO 子进程提供只监听回环地址的 OpenAI Compatible 脚本模型。
// 输入：场景 JSON、证据目录、可选端口；输出：确定性文本/工具调用，以及脱敏请求和响应日志。
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const SYNTHETIC_USAGE_NOTE =
  "固定模拟用量：1 个输入单位、1 个输出单位、合计 2，仅用于验证协议和日志形状，不是真实 token、费用或性能数据。";
const SYNTHETIC_USAGE = Object.freeze({
  prompt_tokens: 1,
  completion_tokens: 1,
  total_tokens: 2,
  synthetic: true,
  note: SYNTHETIC_USAGE_NOTE,
});
const ROLE_TOOLS = Object.freeze({
  main: new Set([
    "pao_start_flow",
    "pao_push_flow",
    "pao_query_flow",
    "pao_confirm_flow",
    "pao_cancel_flow",
  ]),
  minister: new Set([
    "pao_minister_submit_cards",
    "pao_minister_save_node_map",
    "pao_minister_rework_cards",
    "pao_minister_review_worker",
    "pao_breakdown_done",
    "pao_submit_decision",
    "pao_minister_decision_pack",
    "pao_request_ruling",
    "pao_ack_supervision",
  ]),
  worker: new Set([
    "pao_submit_receipt",
    "pao_save_dispatch_recon",
    "pao_accept_task",
    "write",
    "edit",
    "bash",
    "powershell",
  ]),
});

class ScriptedRequestError extends Error {
  constructor(type, message, details = {}) {
    super(message);
    this.name = "ScriptedRequestError";
    this.type = type;
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function redacted(value) {
  if (Array.isArray(value)) return value.map(redacted);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|api[-_]?key|token|secret|credential|cookie|password/i.test(key)) {
      result[key] = item ? "[REDACTED]" : item;
      continue;
    }
    result[key] = redacted(item);
  }
  return result;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolNames(body) {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

function inferRole(body) {
  const names = new Set(toolNames(body));
  const prompt = (body.messages ?? []).map((message) => contentText(message.content)).join("\n");
  for (const role of ["main", "minister", "worker"]) {
    const name = [...ROLE_TOOLS[role]].find((toolName) => names.has(toolName));
    if (name) return { role, evidence: { kind: "tool", name } };
  }

  const identityRules = [
    {
      role: "main",
      label: "主控",
      pattern:
        /(?:你是|当前角色(?:是|为)|本会话角色(?:是|为))[:：\s]*(?:当前|工作流)?\s*(?:主控|main)(?![a-z]|会话|角色|节点)/i,
    },
    {
      role: "minister",
      label: "部长",
      pattern:
        /(?:你是|当前角色(?:是|为)|本会话角色(?:是|为))[:：\s]*(?:当前|工作流)?\s*(?:部长|minister)(?![a-z]|会话|角色|节点)/i,
    },
    {
      role: "worker",
      label: "worker",
      pattern:
        /(?:你是|当前角色(?:是|为)|本会话角色(?:是|为))[:：\s]*(?:当前)?\s*(?:工人|worker)(?![a-z]|会话|角色|节点)/i,
    },
  ];
  for (const rule of identityRules) {
    if (rule.pattern.test(prompt)) {
      return { role: rule.role, evidence: { kind: "text", name: rule.label } };
    }
  }
  return {
    role: "worker",
    evidence: { kind: "default", name: "无角色专用工具或明确身份文本" },
  };
}

function stageFromPrompt(prompt) {
  const chinese = prompt.match(/阶段\s*[:：]\s*(侦察|规划|实施|审核)/);
  if (chinese) return chinese[1];
  const ascii = prompt.match(/stage\s*=\s*(recon|plan|impl|review)\b/i);
  if (!ascii) return null;
  return {
    recon: "侦察",
    plan: "规划",
    impl: "实施",
    review: "审核",
  }[ascii[1].toLowerCase()];
}

function inferStage(body) {
  for (let index = (body.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message?.role !== "user" && message?.role !== "system") continue;
    const stage = stageFromPrompt(contentText(message.content));
    if (stage) return stage;
  }
  return null;
}

function latestTool(body) {
  for (let index = (body.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (message?.role !== "tool") continue;
    const toolCallId =
      typeof message.tool_call_id === "string" && message.tool_call_id.length > 0
        ? message.tool_call_id
        : "";
    if (!toolCallId) {
      throw new ScriptedRequestError(
        "scripted_model_tool_result_missing_call_id",
        "tool 消息缺少字符串 tool_call_id，无法反查工具名",
      );
    }

    let resolvedName = "";
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = body.messages[previousIndex];
      if (previous?.role !== "assistant" || !Array.isArray(previous.tool_calls)) continue;
      const call = previous.tool_calls.find((candidate) => candidate?.id === toolCallId);
      const functionName = call?.function?.name;
      if (typeof functionName === "string" && functionName.length > 0) {
        resolvedName = functionName;
        break;
      }
    }
    if (!resolvedName) {
      throw new ScriptedRequestError(
        "scripted_model_tool_result_unknown_call",
        `tool 消息的 tool_call_id=${toolCallId} 无法反查之前的 assistant.tool_calls`,
        { tool_call_id: toolCallId },
      );
    }

    const explicitName =
      typeof message.name === "string" && message.name.length > 0 ? message.name : "";
    if (explicitName && explicitName !== resolvedName) {
      throw new ScriptedRequestError(
        "scripted_model_tool_result_name_mismatch",
        `tool 消息 name=${explicitName} 与 tool_call_id=${toolCallId} 反查出的 ${resolvedName} 不一致`,
        {
          tool_call_id: toolCallId,
          explicit_name: explicitName,
          resolved_name: resolvedName,
        },
      );
    }
    return {
      name: resolvedName,
      toolCallId,
      content: contentText(message.content),
    };
  }
  return { name: "", toolCallId: "", content: "" };
}

function latestUserAndAssistant(body) {
  let user = "";
  let assistantText = "";
  let toolCalls = 0;
  for (let index = (body.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!user && message?.role === "user") user = contentText(message.content);
    if (message?.role === "assistant") {
      assistantText += `${contentText(message.content)}\n`;
      toolCalls += Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
    }
    if (user) break;
  }
  return { user, assistantText: assistantText.trim(), toolCalls };
}

function matches(rule, facts, includeSequence = true) {
  const match = rule.match ?? {};
  if (match.role && match.role !== facts.role) return false;
  if (match.stage && match.stage !== facts.stage) return false;
  if (
    Object.hasOwn(match, "latestToolName") &&
    match.latestToolName !== facts.latestTool.name
  ) {
    return false;
  }
  if (
    match.latestToolResultIncludes &&
    !facts.latestTool.content.includes(match.latestToolResultIncludes)
  ) {
    return false;
  }
  if (match.promptIncludes && !facts.prompt.includes(match.promptIncludes)) return false;
  if (match.promptExcludes && facts.prompt.includes(match.promptExcludes)) return false;
  if (match.tool && !facts.tools.includes(match.tool)) return false;
  if (match.noTool && facts.tools.includes(match.noTool)) return false;
  if (includeSequence) {
    if (match.afterRule && (facts.ruleCounts.get(match.afterRule) ?? 0) === 0) return false;
    if (
      Array.isArray(match.afterRules) &&
      match.afterRules.some((ruleId) => (facts.ruleCounts.get(ruleId) ?? 0) === 0)
    ) {
      return false;
    }
  }
  return true;
}

function missingPrerequisite(rule, facts) {
  const match = rule.match ?? {};
  const required = [
    ...(match.afterRule ? [match.afterRule] : []),
    ...(Array.isArray(match.afterRules) ? match.afterRules : []),
  ];
  return required.filter((ruleId) => (facts.ruleCounts.get(ruleId) ?? 0) === 0);
}

function completionId() {
  return `chatcmpl-scripted-${randomUUID()}`;
}

function textResponse(body, text) {
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: null,
  };
}

function toolResponse(body, call, text = "") {
  const id = `call-scripted-${randomUUID()}`;
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: call.name,
                arguments:
                  typeof call.arguments === "string"
                    ? call.arguments
                    : JSON.stringify(call.arguments ?? {}),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: null,
  };
}

function streamPacket(body, chunkId, delta, finishReason = null) {
  const choice = { index: 0, delta };
  if (finishReason !== null) choice.finish_reason = finishReason;
  return {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [choice],
  };
}

function writeSse(res, packet) {
  res.write(`data: ${JSON.stringify(packet)}\n\n`);
}

export function loadScenario(path) {
  const scenario = JSON.parse(readFileSync(path, "utf8"));
  if (scenario.schemaVersion !== 1) throw new Error("脚本场景 schemaVersion 必须为 1");
  if (!Array.isArray(scenario.rules) || scenario.rules.length === 0) {
    throw new Error("脚本场景必须至少包含一条规则");
  }
  const ids = new Set();
  for (const rule of scenario.rules) {
    if (!rule.id || ids.has(rule.id)) throw new Error("脚本规则 id 必须唯一且非空");
    ids.add(rule.id);
    if (!rule.respond || !["text", "tool_call", "disconnect", "http_error"].includes(rule.respond.kind)) {
      throw new Error(`脚本规则 ${rule.id} 的 respond.kind 非法`);
    }
    for (const required of [
      ...(rule.match?.afterRule ? [rule.match.afterRule] : []),
      ...(Array.isArray(rule.match?.afterRules) ? rule.match.afterRules : []),
    ]) {
      if (!ids.has(required)) throw new Error(`脚本规则 ${rule.id} 引用了不存在的前置规则 ${required}`);
    }
  }
  if (scenario.unmatched !== "fail" && scenario.fallback) {
    throw new Error("场景必须默认对未匹配请求失败；只有显式 unmatched=fail 才允许报告缺口");
  }
  return scenario;
}

export async function createScriptedModelServer({ scenarioPath, evidenceDir, host = "127.0.0.1", port = 0 }) {
  if (host !== "127.0.0.1") throw new Error("脚本模型只允许监听 127.0.0.1");
  const scenario = loadScenario(scenarioPath);
  mkdirSync(evidenceDir, { recursive: true });
  const requestsPath = resolve(evidenceDir, "requests.jsonl");
  const responsesPath = resolve(evidenceDir, "responses.jsonl");
  writeFileSync(requestsPath, "", "utf8");
  writeFileSync(responsesPath, "", "utf8");

  const counters = new Map();
  const server = createServer(async (req, res) => {
    if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::1") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "脚本模型只接受回环连接" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, host, port: server.address().port, scenario: scenario.name }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: scenario.model?.id ?? "scripted-model", object: "model" }],
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "request too large" } }));
        return;
      }
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }

    const requestId = randomUUID();
    const prompt = (body.messages ?? []).map((message) => contentText(message.content)).join("\n");
    const roleInfo = inferRole(body);
    const role = roleInfo.role;
    const stage = inferStage(body);
    let latest;
    try {
      latest = latestTool(body);
    } catch (error) {
      if (!(error instanceof ScriptedRequestError)) throw error;
      const responseError = {
        message: error.message,
        type: error.type,
        ...error.details,
        request_id: requestId,
      };
      jsonLine(requestsPath, {
        at: new Date().toISOString(),
        requestId,
        model: body.model,
        stream: body.stream === true,
        role,
        roleEvidence: roleInfo.evidence,
        stage,
        toolNames: body.tools
          ?.map((tool) => tool?.function?.name)
          .filter((name) => typeof name === "string" && name.length > 0) ?? [],
        latestTool: null,
        promptSha256: sha256(prompt),
        bodySha256: sha256(raw),
        matchedRule: null,
        outOfOrderRule: null,
        error: responseError,
        messages: redacted(body.messages ?? []),
      });
      jsonLine(responsesPath, {
        at: new Date().toISOString(),
        requestId,
        rule: null,
        error: responseError,
        usage: SYNTHETIC_USAGE,
      });
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: responseError }));
      return;
    }
    const rounds = latestUserAndAssistant(body);
    const facts = {
      role,
      stage,
      tools: toolNames(body),
      prompt,
      latestTool: latest,
      user: rounds.user,
      assistantText: rounds.assistantText,
      toolCalls: rounds.toolCalls,
    };
    facts.ruleCounts = counters;
    const rule = scenario.rules.find((candidate) => matches(candidate, facts));
    const outOfOrderRule = rule
      ? undefined
      : scenario.rules.find((candidate) => matches(candidate, facts, false));
    const requestRecord = {
      at: new Date().toISOString(),
      requestId,
      model: body.model,
      stream: body.stream === true,
      role,
      roleEvidence: roleInfo.evidence,
      stage,
      toolNames: facts.tools,
      latestTool: latest,
      promptSha256: sha256(prompt),
      bodySha256: sha256(raw),
      matchedRule: rule?.id ?? null,
      outOfOrderRule: outOfOrderRule?.id ?? null,
      messages: redacted(body.messages ?? []),
    };
    jsonLine(requestsPath, requestRecord);

    if (body.model !== scenario.model?.id) {
      const error = {
        error: {
          message: `模型不匹配：请求=${String(body.model)}，场景=${String(scenario.model?.id)}`,
          type: "scripted_model_mismatch",
          request_id: requestRecord.requestId,
        },
      };
      jsonLine(responsesPath, {
        at: new Date().toISOString(),
        requestId: requestRecord.requestId,
        rule: null,
        error: error.error,
        usage: SYNTHETIC_USAGE,
      });
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify(error));
      return;
    }

    if (!rule && outOfOrderRule) {
      const missing = missingPrerequisite(outOfOrderRule, facts);
      const error = {
        error: {
          message: `规则乱序：${outOfOrderRule.id} 需要前置规则 ${missing.join(", ")} 先成功命中`,
          type: "scripted_model_out_of_order",
          rule: outOfOrderRule.id,
          missing_prerequisites: missing,
          request_id: requestRecord.requestId,
        },
      };
      jsonLine(responsesPath, {
        at: new Date().toISOString(),
        requestId: requestRecord.requestId,
        rule: outOfOrderRule.id,
        error: error.error,
        usage: SYNTHETIC_USAGE,
      });
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify(error));
      return;
    }

    if (!rule) {
      const error = {
        error: {
          message: `未匹配脚本规则：role=${role}, stage=${stage ?? "(none)"}, latestTool=${latest.name || "(none)"}`,
          type: "scripted_model_unmatched",
          request_id: requestRecord.requestId,
        },
      };
      jsonLine(responsesPath, {
        at: new Date().toISOString(),
        requestId: requestRecord.requestId,
        rule: null,
        error: error.error,
        usage: { synthetic: true, note: SYNTHETIC_USAGE_NOTE },
      });
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify(error));
      return;
    }

    const matchCount = (counters.get(rule.id) ?? 0) + 1;
    counters.set(rule.id, matchCount);
    const responseSpec = rule.respond;
    if (responseSpec.kind === "http_error") {
      const status = responseSpec.status ?? 500;
      jsonLine(responsesPath, {
        at: new Date().toISOString(),
        requestId: requestRecord.requestId,
        rule: rule.id,
        matchCount,
        httpStatus: status,
        usage: { synthetic: true, note: SYNTHETIC_USAGE_NOTE },
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: responseSpec.message ?? "scripted HTTP fault" } }));
      return;
    }

    if (responseSpec.kind === "disconnect") {
      jsonLine(responsesPath, {
        at: new Date().toISOString(),
        requestId: requestRecord.requestId,
        rule: rule.id,
        matchCount,
        fault: "disconnect_without_finish_reason",
        usage: { synthetic: true, note: SYNTHETIC_USAGE_NOTE },
      });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      writeSse(
        res,
        streamPacket(body, completionId(), {
          role: "assistant",
          content: responseSpec.text ?? "脚本流已开始，但没有 finish_reason。",
        }),
      );
      res.end();
      return;
    }

    if (responseSpec.kind === "tool_call" && !facts.tools.includes(responseSpec.call?.name)) {
      const error = {
        error: {
          message: `未知工具：${String(responseSpec.call?.name)} 不在本请求可用工具 ${facts.tools.join(", ") || "(none)"} 中`,
          type: "scripted_model_unknown_tool",
          rule: rule.id,
          tool: String(responseSpec.call?.name),
          available_tools: facts.tools,
          request_id: requestRecord.requestId,
        },
      };
      jsonLine(responsesPath, {
        at: new Date().toISOString(),
        requestId: requestRecord.requestId,
        rule: rule.id,
        matchCount,
        error: error.error,
        usage: SYNTHETIC_USAGE,
      });
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify(error));
      return;
    }

    const response =
      responseSpec.kind === "tool_call"
        ? toolResponse(body, responseSpec.call, responseSpec.text ?? "")
        : textResponse(body, responseSpec.text ?? "");
    const usage = SYNTHETIC_USAGE;
    response.usage = usage;
    jsonLine(responsesPath, {
      at: new Date().toISOString(),
      requestId: requestRecord.requestId,
      rule: rule.id,
      matchCount,
      response,
      usage,
    });

    if (body.stream !== true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-scripted-usage-synthetic": "true",
      "x-scripted-usage-fixed": "1/1/2",
    });
    const chunkId = completionId();
    const message = response.choices[0].message;
    if (message.content) {
      writeSse(res, streamPacket(body, chunkId, { role: "assistant", content: message.content }));
    }
    if (Array.isArray(message.tool_calls)) {
      writeSse(
        res,
        streamPacket(body, chunkId, {
          role: "assistant",
          tool_calls: message.tool_calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: call.function,
          })),
        }),
      );
    }
    writeSse(res, streamPacket(body, chunkId, {}, response.choices[0].finish_reason));
    res.write(
      `data: ${JSON.stringify({
        id: chunkId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [],
        usage,
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("脚本模型未取得监听地址");
  }

  return {
    server,
    scenario,
    scenarioPath: resolve(scenarioPath),
    scenarioSha256: sha256(readFileSync(scenarioPath)),
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}/v1`,
    evidenceDir: resolve(evidenceDir),
    syntheticUsageNote: SYNTHETIC_USAGE_NOTE,
    close: () =>
      new Promise((resolvePromise, reject) => {
        if (!server.listening) {
          resolvePromise();
          return;
        }
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      evidence: { type: "string" },
      port: { type: "string", default: "0" },
    },
  });
  if (!values.scenario || !values.evidence) {
    throw new Error("用法：node scripted-model-server.mjs --scenario <json> --evidence <dir> [--port 0]");
  }
  const modelServer = await createScriptedModelServer({
    scenarioPath: resolve(values.scenario),
    evidenceDir: resolve(values.evidence),
    port: Number(values.port),
  });
  const ready = {
    ok: true,
    host: modelServer.host,
    port: modelServer.port,
    baseUrl: modelServer.baseUrl,
    scenario: modelServer.scenario.name,
    scenarioSha256: modelServer.scenarioSha256,
    protocol: "openai-completions",
    usage: modelServer.syntheticUsageNote,
  };
  writeFileSync(resolve(values.evidence, "server-ready.json"), `${JSON.stringify(ready, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  const stop = async () => {
    await modelServer.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
