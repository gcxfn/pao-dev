import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "../../../..");
const desktopRoot = join(projectRoot, "desktop");
const releaseDir = join(desktopRoot, "apps", "desktop", "release", "win-unpacked");
const executablePath = join(releaseDir, "PAO.exe");
const externalNodeModules = join(releaseDir, "resources", "app.asar.unpacked", "node_modules");
const sourceBundle = join(
  externalNodeModules,
  "@pao",
  "coding-agent",
  "dist",
  "bundle",
);
const stamp = new Date()
  .toISOString()
  .replaceAll("-", "")
  .replaceAll(":", "")
  .replace(/\.\d{3}Z$/, "Z");
const diagnosticRoot = join(scriptDir, `cli-startup-${stamp}`);
const bundleDir = join(diagnosticRoot, "bundle");
const stateRoot = join(tmpdir(), `pao-s4-17-diagnostic-${stamp}`);
const iterations = Number.parseInt(process.argv[2] ?? "12", 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? "15000", 10);
const productionWorkspace =
  process.argv[4] ??
  "C:\\Users\\ASUS\\AppData\\Local\\Temp\\pi-gui-workspace-NoDzYL\\s4-17-packaged-memory";
const diagnosticMode = process.argv[5] ?? "detailed";
const fixtureRoot =
  process.argv[6] ?? "C:\\Users\\ASUS\\AppData\\Local\\Temp\\pao-s4-17-packaged-memory-Gt6Nn4";
const providerPath = join(fixtureRoot, "packaged-memory-offline-provider.ts");

if (!Number.isInteger(iterations) || iterations < 1) {
  throw new Error("iterations must be a positive integer");
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
  throw new Error("timeoutMs must be at least 1000");
}
if (!existsSync(productionWorkspace)) {
  throw new Error(`production workspace is missing: ${productionWorkspace}`);
}
if (!existsSync(fixtureRoot)) {
  throw new Error(`production fixture root is missing: ${fixtureRoot}`);
}

const gbrainRequests = [];
const gbrainTrap = createServer((request, response) => {
  gbrainRequests.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
  response.statusCode = 500;
  response.setHeader("connection", "close");
  response.end("S4-17 gbrain trap must not be contacted");
});
await new Promise((resolveListen, rejectListen) => {
  gbrainTrap.once("error", rejectListen);
  gbrainTrap.listen(0, "127.0.0.1", resolveListen);
});
const trapAddress = gbrainTrap.address();
if (!trapAddress || typeof trapAddress === "string") {
  throw new Error("gbrain trap did not expose a TCP port");
}

mkdirSync(diagnosticRoot, { recursive: true });
mkdirSync(stateRoot, { recursive: true });
cpSync(sourceBundle, bundleDir, { recursive: true });
symlinkSync(externalNodeModules, join(diagnosticRoot, "node_modules"), "junction");

const targetChunk = join(bundleDir, "chunks", "chunk-6NFLGH2T.js");
let source = readFileSync(targetChunk, "utf8");

function replaceOnce(search, replacement) {
  const count = source.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`diagnostic patch expected exactly one match, found ${count}: ${search.slice(0, 80)}`);
  }
  source = source.replace(search, replacement);
}

const tracePrelude = `
function __s417ErrorDetails(error) {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
    module: error && typeof error === "object" ? error.module : undefined,
    source: error && typeof error === "object" ? error.source : undefined,
  };
}
function __s417Trace(event, details = {}) {
  process.stderr.write(
    "__S4_17_TRACE__" +
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }) +
      "\\n",
  );
}
`;
if (diagnosticMode !== "clean") {
  source = tracePrelude + source;

  replaceOnce(
    "function createPaoTeardown(){let entries=[],pending2;return{add(resource,release2){if(pending2)throw new Error(`[pao] \\u88C5\\u914D\\u5DF2\\u7ECF\\u7ED3\\u675F,\\u4E0D\\u80FD\\u518D\\u767B\\u8BB0\\u8D44\\u6E90:${resource}`);entries.push({resource,release:release2})},release(){return pending2??=(async()=>{let released=[],errors=[];for(let entry of[...entries].reverse())try{await entry.release(),released.push(entry.resource)}catch(error){errors.push({resource:entry.resource,error})}return{released,errors}})(),pending2}}}",
    "function createPaoTeardown(){let entries=[],pending2;return{add(resource,release2){if(pending2)throw new Error(`[pao] \\u88C5\\u914D\\u5DF2\\u7ECF\\u7ED3\\u675F,\\u4E0D\\u80FD\\u518D\\u767B\\u8BB0\\u8D44\\u6E90:${resource}`);entries.push({resource,release:release2})},release(){return pending2??=(async()=>{let released=[],errors=[];for(let entry of[...entries].reverse()){__s417Trace(\"teardown-begin\",{resource:entry.resource});try{await entry.release();released.push(entry.resource);__s417Trace(\"teardown-end\",{resource:entry.resource})}catch(error){errors.push({resource:entry.resource,error});__s417Trace(\"teardown-error\",{resource:entry.resource,...__s417ErrorDetails(error)})}}return{released,errors}})(),pending2}}}",
  );

  replaceOnce(
    "function paoExtension(pi,options={}){let teardown=createPaoTeardown();try{let record=assemblePaoExtension(pi,options,teardown);recordPaoAssembly(pi,record);return}catch(error){return finalizePaoAssemblyFailure(teardown,toPaoAssemblyFailure(error))}}",
    "function paoExtension(pi,options={}){let teardown=createPaoTeardown();__s417Trace(\"factory-begin\");try{let record=assemblePaoExtension(pi,options,teardown);recordPaoAssembly(pi,record);__s417Trace(\"factory-end\",{registered:record.registered.length,degraded:record.degraded.length});return}catch(error){let failure=toPaoAssemblyFailure(error);__s417Trace(\"factory-error\",{...__s417ErrorDetails(error),failureMessage:failure.message});return(async()=>{__s417Trace(\"cleanup-begin\",{failureMessage:failure.message});try{await finalizePaoAssemblyFailure(teardown,failure)}catch(finalError){__s417Trace(\"cleanup-end\",__s417ErrorDetails(finalError));throw finalError}})()}}",
  );

  replaceOnce(
    "async emit(event){let ctx=this.createContext(),result,shutdownCleanups=[],shutdownEvent;",
    "async emit(event){__s417Trace(\"emit-begin\",{event:event.type});let __s417HookIndex=0,ctx=this.createContext(),result,shutdownCleanups=[],shutdownEvent;",
  );
  replaceOnce(
    "let failures=[];for(let{ext:ext2,handlers}of snapshotEventHandlers(this.extensions,event.type))for(let handler of handlers)try{let handlerResult=await handler(shutdownEvent??event,ctx);if(this.isSessionBeforeEvent(event)&&handlerResult&&(result=handlerResult,result.cancel))return result}catch(err){let message=err instanceof Error?err.message:String(err),stack=err instanceof Error?err.stack:void 0;this.emitError({extensionPath:ext2.path,event:event.type,error:message,stack}),event.type===\"session_shutdown\"&&failures.push({error:err,extensionPath:ext2.path})}if(failures.length)",
    "let failures=[];for(let{ext:ext2,handlers}of snapshotEventHandlers(this.extensions,event.type))for(let handler of handlers){let __s417CurrentHook=__s417HookIndex++;__s417Trace(\"hook-begin\",{event:event.type,extensionPath:ext2.path,index:__s417CurrentHook});try{let handlerResult=await handler(shutdownEvent??event,ctx);__s417Trace(\"hook-end\",{event:event.type,extensionPath:ext2.path,index:__s417CurrentHook});if(this.isSessionBeforeEvent(event)&&handlerResult&&(result=handlerResult,result.cancel))return result}catch(err){let message=err instanceof Error?err.message:String(err),stack=err instanceof Error?err.stack:void 0;__s417Trace(\"hook-error\",{event:event.type,extensionPath:ext2.path,index:__s417CurrentHook,...__s417ErrorDetails(err)});this.emitError({extensionPath:ext2.path,event:event.type,error:message,stack}),event.type===\"session_shutdown\"&&failures.push({error:err,extensionPath:ext2.path})}}if(failures.length)",
  );
  replaceOnce(
    "return result}async emitCacheWarmingDecision(event)",
    "__s417Trace(\"emit-end\",{event:event.type});return result}async emitCacheWarmingDecision(event)",
  );
  replaceOnce(
    "this._applyExtensionBindings(this._extensionRunner),await this._extensionRunner.emit(this._sessionStartEvent),this._extensionRunner.reportUnhandledMcpServers(),await this.extendResourcesFromExtensions(this._sessionStartEvent.reason===\"reload\"?\"reload\":\"startup\")",
    "this._applyExtensionBindings(this._extensionRunner),__s417Trace(\"session-start-emit-begin\",{reason:this._sessionStartEvent.reason}),await this._extensionRunner.emit(this._sessionStartEvent),__s417Trace(\"session-start-emit-complete\",{reason:this._sessionStartEvent.reason}),this._extensionRunner.reportUnhandledMcpServers(),await this.extendResourcesFromExtensions(this._sessionStartEvent.reason===\"reload\"?\"reload\":\"startup\"),__s417Trace(\"session-start-resources-complete\",{reason:this._sessionStartEvent.reason})",
  );
}

if (diagnosticMode === "detailed") {
  replaceOnce(
    "criticalValue=(module,install2)=>{try{return install2()}catch(error){throw toPaoAssemblyFailure(error,{module})}};",
    "criticalValue=(module,install2)=>{__s417Trace(\"critical-begin\",{module});try{const value=install2();__s417Trace(\"critical-end\",{module});return value}catch(error){__s417Trace(\"critical-error\",{module,...__s417ErrorDetails(error)});throw toPaoAssemblyFailure(error,{module})}};",
  );

  replaceOnce(
    "{disposers:[],toolNames:[]};try{registerGuarded(registerFn,guarded),tracker.noteRegistered(module)}catch(error){",
    "{disposers:[],toolNames:[]};__s417Trace(\"register-begin\",{module});try{registerGuarded(registerFn,guarded),tracker.noteRegistered(module),__s417Trace(\"register-end\",{module})}catch(error){__s417Trace(\"register-error\",{module,...__s417ErrorDetails(error)});",
  );

  replaceOnce(
    "async function initializeExtension(factory,extensionPath,resolvedPath,cwd,eventBus,runtime){let extension=createExtension(extensionPath,resolvedPath),load=createExtensionAPI(extension,runtime,cwd,eventBus);try{await factory(load.api),load.commit()}catch(error){throw load.discard(),error}return time(`${extensionPath} factory`,\"extensions\"),extension}",
    "async function initializeExtension(factory,extensionPath,resolvedPath,cwd,eventBus,runtime){let extension=createExtension(extensionPath,resolvedPath),load=createExtensionAPI(extension,runtime,cwd,eventBus);__s417Trace(\"loader-factory-begin\",{extensionPath});try{await factory(load.api),load.commit();__s417Trace(\"loader-factory-end\",{extensionPath})}catch(error){__s417Trace(\"loader-factory-error\",{extensionPath,...__s417ErrorDetails(error)});throw load.discard(),error}return time(`${extensionPath} factory`,\"extensions\"),extension}",
  );

  replaceOnce(
    "async function createAgentSessionServices(options){let cwd=resolvePath(options.cwd)",
    "async function createAgentSessionServices(options){__s417Trace(\"services-begin\");let cwd=resolvePath(options.cwd)",
  );
  replaceOnce(
    "await resourceLoader.reload(options.resourceLoaderReloadOptions);let diagnostics=[],extensionsResult=resourceLoader.getExtensions();",
    "await resourceLoader.reload(options.resourceLoaderReloadOptions),__s417Trace(\"services-resources-complete\");let diagnostics=[],extensionsResult=resourceLoader.getExtensions();",
  );
  replaceOnce(
    "extensionsResult.runtime.pendingProviderRegistrations=[];for(let{provider,extensionPath}of extensionsResult.runtime.pendingNativeProviderRegistrations)",
    "extensionsResult.runtime.pendingProviderRegistrations=[],__s417Trace(\"services-provider-registration-complete\");for(let{provider,extensionPath}of extensionsResult.runtime.pendingNativeProviderRegistrations)",
  );
  replaceOnce(
    "extensionsResult.runtime.pendingNativeProviderRegistrations=[];for(let{definition,extensionPath}of extensionsResult.runtime.pendingVirtualModelRegistrations)",
    "extensionsResult.runtime.pendingNativeProviderRegistrations=[],__s417Trace(\"services-native-registration-complete\");for(let{definition,extensionPath}of extensionsResult.runtime.pendingVirtualModelRegistrations)",
  );
  replaceOnce(
    "return extensionsResult.runtime.pendingVirtualModelRegistrations=[],await modelRuntime.refresh({allowNetwork:!1}),diagnostics.push(...applyExtensionFlagValues(resourceLoader,options.extensionFlagValues)),{cwd,agentDir,modelRuntime,settingsManager,resourceLoader,diagnostics}",
    "return extensionsResult.runtime.pendingVirtualModelRegistrations=[],__s417Trace(\"services-model-refresh-begin\"),await modelRuntime.refresh({allowNetwork:!1}),__s417Trace(\"services-model-refresh-end\"),diagnostics.push(...applyExtensionFlagValues(resourceLoader,options.extensionFlagValues)),__s417Trace(\"services-complete\",{diagnostics:diagnostics.length}),{cwd,agentDir,modelRuntime,settingsManager,resourceLoader,diagnostics}",
  );

  replaceOnce(
    "services2=await createAgentSessionServices({cwd:cwd2,agentDir:agentDir2",
    "services2=await(async()=>{__s417Trace(\"runtime-services-begin\");let value=await createAgentSessionServices({cwd:cwd2,agentDir:agentDir2",
  );
  replaceOnce(
    "extensionFactories}}),{settingsManager:settingsManager2,modelRuntime:modelRuntime2,resourceLoader:resourceLoader2}=services2",
    "extensionFactories}});__s417Trace(\"runtime-services-complete\");return value})(),{settingsManager:settingsManager2,modelRuntime:modelRuntime2,resourceLoader:resourceLoader2}=services2",
  );
  replaceOnce(
    "modelPatterns=parsed.models??settingsManager2.getEnabledModels(),scopedModels=modelPatterns&&modelPatterns.length>0?await resolveModelScope(modelPatterns,modelRuntime2,{signal:AbortSignal.timeout(15e3)}):[],{options:sessionOptions,cliThinkingFromModel,diagnostics:sessionOptionDiagnostics}=buildSessionOptions",
    "modelPatterns=parsed.models??settingsManager2.getEnabledModels(),scopedModels=await(async()=>{__s417Trace(\"runtime-model-scope-begin\",{patterns:modelPatterns});let value=modelPatterns&&modelPatterns.length>0?await resolveModelScope(modelPatterns,modelRuntime2,{signal:AbortSignal.timeout(15e3)}):[];__s417Trace(\"runtime-model-scope-end\",{count:value.length});return value})(),{options:sessionOptions,cliThinkingFromModel,diagnostics:sessionOptionDiagnostics}=buildSessionOptions",
  );
  replaceOnce(
    "diagnostics:sessionOptionDiagnostics}=buildSessionOptions(parsed,scopedModels,sessionManager2.buildSessionContext().messages.length>0,modelRuntime2,settingsManager2);diagnostics.push(...sessionOptionDiagnostics)",
    "diagnostics:sessionOptionDiagnostics}=buildSessionOptions(parsed,scopedModels,sessionManager2.buildSessionContext().messages.length>0,modelRuntime2,settingsManager2);__s417Trace(\"runtime-options-built\",{scopedModels:scopedModels.length,model:sessionOptions.model?.id});diagnostics.push(...sessionOptionDiagnostics)",
  );
  replaceOnce(
    "parsed.apiKey&&(sessionOptions.model?await modelRuntime2.setRuntimeApiKey(sessionOptions.model.provider,parsed.apiKey):diagnostics.push({type:\"error\",message:\"--api-key requires a model to be specified via --model, --provider/--model, or --models\"}));let created=await createAgentSessionFromServices",
    "parsed.apiKey&&(sessionOptions.model?await modelRuntime2.setRuntimeApiKey(sessionOptions.model.provider,parsed.apiKey):diagnostics.push({type:\"error\",message:\"--api-key requires a model to be specified via --model, --provider/--model, or --models\"}));__s417Trace(\"runtime-session-create-begin\");let created=await createAgentSessionFromServices",
  );
  replaceOnce(
    "customTools:sessionOptions.customTools}),cliThinkingOverride=parsed.thinking!==void 0||cliThinkingFromModel",
    "customTools:sessionOptions.customTools});__s417Trace(\"runtime-session-create-complete\",{model:created.session.model?.id});let cliThinkingOverride=parsed.thinking!==void 0||cliThinkingFromModel",
  );
  replaceOnce(
    "{...created,services:services2,diagnostics}};time(\"createRuntime\");let runtime=await createAgentSessionRuntime",
    "(()=>{__s417Trace(\"runtime-create-complete\");return{...created,services:services2,diagnostics}})()};time(\"createRuntime\");__s417Trace(\"runtime-create-agent-begin\");let runtime=await createAgentSessionRuntime",
  );
  replaceOnce(
    "sessionManager});time(\"createAgentSessionRuntime\");let{services,session,modelFallbackMessage}=runtime",
    "sessionManager});__s417Trace(\"runtime-create-agent-complete\");time(\"createAgentSessionRuntime\");let{services,session,modelFallbackMessage}=runtime",
  );
  replaceOnce(
    "else{printTimings();let exitCode=await runPrintMode(runtime",
    "else{printTimings(),__s417Trace(\"print-mode-begin\");let exitCode=await runPrintMode(runtime",
  );
}

writeFileSync(targetChunk, source, "utf8");

const providerId = "packaged-memory-s4-17-offline";
const modelId = "offline-scripted";
const writePrompt = "S4-17_WRITE_MEMORY";
writeFileSync(
  join(stateRoot, "provider-template-unused.ts"),
  String.raw`
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@pao/ai";

const PROVIDER_ID = ${JSON.stringify(providerId)};
const MODEL_ID = ${JSON.stringify(modelId)};
const LOG_PATH = process.env.PACKAGED_MEMORY_PROVIDER_LOG;
const INITIAL_CONCLUSION = "发行验收口令 local-test-token 的初始值为甲。";
const WRITE_PROMPT = ${JSON.stringify(writePrompt)};
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
`,
  "utf8",
);

function sanitizedEnv() {
  const env = { ...process.env };
  const providerOnlyKeys = new Set([
    "ANTHROPIC_OAUTH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_PROFILE",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_GATEWAY_ID",
  ]);
  for (const key of Object.keys(env)) {
    if (key.endsWith("_API_KEY") || providerOnlyKeys.has(key)) delete env[key];
  }
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_PATH",
    "PI_CODING_AGENT_DIR",
    "PAO_CODING_AGENT_DIR",
    "PAO_HOME",
    "PAO_ROLE",
    "PAO_DEPT",
    "PI_PACKAGE_DIR",
    "S4_17_TRACE_LOG",
    "PACKAGED_MEMORY_PROVIDER_LOG",
    "PACKAGED_MEMORY_PROVIDER_PHASE",
  ]) {
    delete env[key];
  }
  return env;
}

const results = [];
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const runRoot = join(stateRoot, `run-${String(iteration).padStart(2, "0")}`);
  const workspace = productionWorkspace;
  const agentDir = join(fixtureRoot, "agent");
  const paoHome = join(fixtureRoot, "pao-home");
  const sessionsDir = join(fixtureRoot, "sessions");
  const providerLogPath = join(fixtureRoot, "provider-events.jsonl");
  const traceLogPath = join(runRoot, "assembly-trace.jsonl");
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(traceLogPath, "", "utf8");

  const args = [
    join(bundleDir, "cli.js"),
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
    providerPath,
    "-e",
    "builtin:pao",
    "--provider",
    providerId,
    "--model",
    modelId,
    "--session-dir",
    sessionsDir,
    "-p",
    writePrompt,
  ];
  const startedAt = Date.now();
  const result = spawnSync(executablePath, args, {
    cwd: workspace,
    env: {
      ...sanitizedEnv(),
      HOME: dirname(workspace),
      USERPROFILE: dirname(workspace),
      PI_CODING_AGENT_DIR: agentDir,
      PAO_CODING_AGENT_DIR: agentDir,
      PAO_HOME: paoHome,
      PI_PACKAGE_DIR: join(externalNodeModules, "@pao", "coding-agent"),
      PAO_DISABLE_BUILTIN_EXTENSION: "0",
      PI_OFFLINE: "1",
      PI_NO_LOCAL_LLM: "1",
      GBRAIN_TOKEN: "LOCAL_TEST_ZERO_COST",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      PACKAGED_MEMORY_PROVIDER_PHASE: "write",
      PACKAGED_MEMORY_PROVIDER_LOG: providerLogPath,
      S4_17_TRACE_LOG: traceLogPath,
    },
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - startedAt;
  const record = {
    iteration,
    status: result.error ? "error" : result.status === 0 ? "ok" : "nonzero",
    code: result.status,
    signal: result.signal,
    error: result.error
      ? { name: result.error.name, message: result.error.message, code: result.error.code }
      : undefined,
    elapsedMs,
    stdout: result.stdout,
    stderr: result.stderr,
    providerEvents: readFileSync(providerLogPath, "utf8"),
    assemblyTrace: readFileSync(traceLogPath, "utf8"),
  };
  writeFileSync(join(runRoot, "result.json"), JSON.stringify(record, null, 2), "utf8");
  results.push(record);
  console.log(
    `${String(iteration).padStart(2, "0")}: ${record.status} code=${String(record.code)} elapsed=${elapsedMs}ms`,
  );
  if (record.status !== "ok") break;
}

writeFileSync(join(diagnosticRoot, "summary.json"), JSON.stringify(results, null, 2), "utf8");
console.log(`diagnosticRoot=${diagnosticRoot}`);
console.log(`stateRoot=${stateRoot}`);
await new Promise((resolveClose) => gbrainTrap.close(resolveClose));
writeFileSync(
  join(diagnosticRoot, "gbrain-trap-requests.json"),
  JSON.stringify(gbrainRequests, null, 2) + "\n",
  "utf8",
);
if (results.some((result) => result.status !== "ok")) process.exitCode = 2;
