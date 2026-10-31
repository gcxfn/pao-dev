// 用途：用固定 kit、真实产品 CLI、真实 Git 与回环脚本模型运行隔离正常链。
// 输入：可选 --output；输出：运行、模型、控制正本、进程和核验证据。
// 边界：不构建、不联网、不访问正式 PAO_HOME、不使用 Docker 或真实模型。
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { verifyEvidence } from "./verify-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const WORKSPACE_TEMP = resolve(REPO_ROOT, "../临时文件夹/PAO彩排-20261030");
const NODE = process.execPath;
const CLI = join(REPO_ROOT, "PAO/packages/coding-agent/dist/bundle/cli.js");
const SOURCE_ROOT = join(REPO_ROOT, "PAO");
const PACKAGE_ROOT = join(REPO_ROOT, "PAO/packages/coding-agent");
const KIT = join(REPO_ROOT, "bench/organized-post/kit.json");
const SETUP = join(REPO_ROOT, "bench/organized-post/setup.mjs");
const SCENARIO = join(REPO_ROOT, "bench/rehearsal/scenarios/normal.json");
const PROVIDER = "harbor-endpoint";
const MODEL = "minimax-code/MiniMax-M3.1-Flash";
const THINKING = "high";
const WORKFLOW = "基准开发流水线";
const SYNTHETIC_USAGE_NOTE =
  "固定模拟用量：每次回环 HTTP 响应只记 1 个输入单位、1 个输出单位；不是真实 token、费用或性能。";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1} 不是合法 JSONL：${error instanceof Error ? error.message : error}`);
    }
  });
}

function isolatedEnv(runRoot, evidenceDir) {
  const home = join(runRoot, "home");
  const temp = join(runRoot, ".tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const passthrough = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "ComSpec",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
  ];
  const env = {};
  for (const key of passthrough) if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
    PAO_HOME: join(runRoot, "pao-home"),
    PAO_CODING_AGENT_DIR: join(runRoot, "agent-dir"),
    PAO_WORKTREE_STATE_ROOT: join(runRoot, "worktree-state"),
    PAO_RUN_MODE: "unattended",
    PI_OFFLINE: "1",
    PI_NO_LOCAL_LLM: "1",
    PI_TELEMETRY: "0",
    PAO_BENCH_ORG_ACTIVATION_LOG: join(evidenceDir, "tool-activation.jsonl"),
  };
}

function writeModelsConfig(agentDir, baseUrl) {
  writeJson(join(agentDir, "models.json"), {
    providers: {
      [PROVIDER]: {
        baseUrl,
        api: "openai-completions",
        apiKey: "benchmark-local-scripted-not-a-credential",
        models: [
          {
            id: MODEL,
            name: "回环脚本模型（固定模拟）",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    },
  });
}

function runSetup(env, paoHome, agentDir, setupEvidence, project, bindingPath) {
  const result = spawnSync(
    NODE,
    [SETUP, SOURCE_ROOT, KIT, paoHome, agentDir, setupEvidence, project, bindingPath],
    { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120000, windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      [
        `setup.mjs 失败，退出码 ${result.status ?? "null"}`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  writeJson(join(setupEvidence, "setup-process.json"), {
    command: [NODE, SETUP, SOURCE_ROOT, KIT, paoHome, agentDir, setupEvidence, project, bindingPath],
    exitCode: result.status,
    stdout: result.stdout?.trim(),
    stderr: result.stderr?.trim(),
  });
}

function loadYaml() {
  return createRequire(join(PACKAGE_ROOT, "package.json"))("yaml");
}

function readControl(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error(`控制正本缺少 frontmatter：${path}`);
  const { parse } = loadYaml();
  return parse(match[1]);
}

function stopTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`],
    { windowsHide: true },
  );
  return result.status === 0;
}

async function startMain(env, project, sessionId, sessionDir, stdoutPath, stderrPath) {
  const args = [
    CLI,
    "--mode",
    "rpc",
    "--provider",
    PROVIDER,
    "--model",
    MODEL,
    "--thinking",
    THINKING,
    "--session-id",
    sessionId,
    "--session-dir",
    sessionDir,
    "--offline",
    "--no-approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
  ];
  const child = spawn(NODE, args, {
    cwd: project,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  writeJson(join(dirname(stdoutPath), "main-command.json"), {
    command: NODE,
    args,
    pid: child.pid,
    cwd: project,
  });
  const stdoutStream = createInterface({ input: child.stdout });
  const events = [];
  let stdoutBuffer = "";
  const stdoutClosed = new Promise((resolveClose) => stdoutStream.once("close", resolveClose));
  stdoutStream.on("line", (line) => {
    appendFileSync(stdoutPath, `${line}\n`, "utf8");
    try {
      const event = JSON.parse(line);
      events.push(event);
    } catch (error) {
      events.push({ type: "invalid_json_stdout", line, error: error instanceof Error ? error.message : String(error) });
    }
    stdoutBuffer += `${line}\n`;
    if (stdoutBuffer.length > 262144) stdoutBuffer = stdoutBuffer.slice(-131072);
  });
  child.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk));
  const exited = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error: error.message, code: null, signal: null }));
    child.once("exit", (code, signal) => resolveExit({ code, signal, error: null }));
  });
  return { child, events, exited, stdoutClosed, stdout: () => stdoutBuffer };
}

function sendRpc(child, command) {
  child.stdin.write(`${JSON.stringify(command)}\n`, "utf8");
}

async function sendPromptAndWaitForPreflight(rpc, command) {
  sendRpc(rpc.child, command);
  const response = await waitFor(
    () => rpc.events.find((event) => event.type === "response" && event.id === command.id),
    10000,
    50,
  );
  if (response.success !== true || response.command !== "prompt") {
    throw new Error(`RPC prompt 未被产品接受：${JSON.stringify(response)}`);
  }
  return response;
}

async function waitFor(predicate, timeoutMs, intervalMs, signal) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw signal.reason ?? new Error("等待已取消");
    const value = await predicate();
    if (value) return value;
    await new Promise((waitResolve) => setTimeout(waitResolve, intervalMs));
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

function settleWithTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolveSettled, rejectSettled) => {
    const timer = setTimeout(() => {
      try {
        resolveSettled(onTimeout());
      } catch (error) {
        rejectSettled(error);
      }
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveSettled(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectSettled(error);
      },
    );
  });
}

function walkFiles(path) {
  if (!existsSync(path)) throw new Error(`清单根不存在：${path}`);
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error(`清单根既不是文件也不是目录：${path}`);
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function aggregateManifest(files) {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path, "en"));
  return createHash("sha256")
    .update(ordered.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""))
    .digest("hex");
}

function captureManifest(outputPath, rootPaths) {
  const files = new Map();
  for (const rootPath of rootPaths) {
    const absoluteRoot = resolve(REPO_ROOT, rootPath);
    for (const absolute of walkFiles(absoluteRoot)) {
      const filePath = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
      if (files.has(filePath)) continue;
      const stat = statSync(absolute);
      files.set(filePath, {
        path: filePath,
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
        sha256: sha256File(absolute),
      });
    }
  }
  const rows = [...files.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    roots: rootPaths.map((path) => ({ path: path.replaceAll("\\", "/") })),
    fileCount: rows.length,
    aggregateSha256: aggregateManifest(rows),
    files: rows,
  };
  writeJson(outputPath, manifest);
  return manifest;
}

function copyTreeSummary(source, root) {
  if (!existsSync(source)) return [];
  return walkFiles(source).map((absolute) => ({
    path: relative(root, absolute),
    bytes: statSync(absolute).size,
  }));
}

function isWithin(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function parseMinisterAudit(rows) {
  const sessions = new Map();
  for (const row of rows) {
    if (row?.动作 !== "散场" || typeof row.目标 !== "string") continue;
    const session = /会话\s+([0-9a-f-]{36})/i.exec(row.目标)?.[1];
    const pid = /pid\s+(\d+)/i.exec(row.目标)?.[1];
    const department = /部长会话〔([^@]+)@/.exec(row.目标)?.[1];
    if (!session || !pid || !department) continue;
    const record = sessions.get(session) ?? { session, department, pids: [], teardown: [] };
    const numericPid = Number(pid);
    if (!record.pids.includes(numericPid)) record.pids.push(numericPid);
    record.teardown.push(row);
    sessions.set(session, record);
  }
  return sessions;
}

async function main() {
  const args = parseArgs({
    options: {
      output: { type: "string" },
    },
    allowPositionals: false,
  }).values;
  const runId = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const runRoot = resolve(args.output ?? join(WORKSPACE_TEMP, `I5-2-${runId}`));
  if (!isWithin(WORKSPACE_TEMP, runRoot)) {
    throw new Error(`运行目录必须位于工作区临时父目录 ${WORKSPACE_TEMP}`);
  }
  if (existsSync(runRoot) && readdirSync(runRoot).length > 0) {
    throw new Error(`运行目录必须为空，拒绝复用可能含旧证据的目录：${runRoot}`);
  }
  const project = join(runRoot, "project");
  const evidenceDir = join(runRoot, "evidence");
  const setupEvidence = join(evidenceDir, "setup");
  const modelEvidence = join(evidenceDir, "model");
  const manifestsDir = join(evidenceDir, "manifests");
  const sessionDir = join(runRoot, "sessions");
  for (const directory of [
    project,
    join(project, "业务"),
    join(project, ".pao", "卡"),
    evidenceDir,
    setupEvidence,
    modelEvidence,
    manifestsDir,
    sessionDir,
    WORKSPACE_TEMP,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(project, "业务", "输入.txt"), "隔离离线正常链输入\n", "utf8");
  const env = isolatedEnv(runRoot, evidenceDir);
  for (const key of ["PAO_HOME", "PAO_CODING_AGENT_DIR", "PAO_WORKTREE_STATE_ROOT"]) {
    mkdirSync(env[key], { recursive: true });
  }
  const sourceManifest = captureManifest(join(manifestsDir, "source-manifest.json"), [
    "PAO/packages/coding-agent/src/pao",
    "PAO/packages/coding-agent/src/main.ts",
    "PAO/packages/coding-agent/src/rpc-entry.ts",
    "PAO/packages/coding-agent/src/modes/rpc/rpc-mode.ts",
    "PAO/packages/ai/src/api/openai-completions.ts",
  ]);
  const bundleManifest = captureManifest(join(manifestsDir, "bundle-manifest.json"), [
    "PAO/packages/coding-agent/dist/bundle",
  ]);
  const kitManifest = captureManifest(join(manifestsDir, "kit-manifest.json"), [
    "bench/organized-post",
    "bench/rehearsal/scenarios/normal.json",
  ]);
  const cliSha256 = sha256File(CLI);
  const scenarioSha256 = sha256File(SCENARIO);
  const snapshotSha256 = createHash("sha256")
    .update(
      [
        kitManifest.aggregateSha256,
        sourceManifest.aggregateSha256,
        bundleManifest.aggregateSha256,
        scenarioSha256,
        cliSha256,
      ].join("\0"),
    )
    .digest("hex");
  const preflight = {
    runRoot,
    project,
    workspaceTempRoot: WORKSPACE_TEMP,
    cliPath: CLI,
    cliSha256,
    cliMtime: statSync(CLI).mtime.toISOString(),
    bundleArtifactMtime: bundleManifest.files
      .map((file) => file.mtime)
      .sort()
      .at(-1),
    bundleManifestSha256: bundleManifest.aggregateSha256,
    bundleFileCount: bundleManifest.fileCount,
    sourceManifestSha256: sourceManifest.aggregateSha256,
    sourceFileCount: sourceManifest.fileCount,
    kitManifestSha256: kitManifest.aggregateSha256,
    kitFileCount: kitManifest.fileCount,
    snapshotSha256,
    capturedAt: new Date().toISOString(),
    kitPath: KIT,
    kitSha256: sha256File(KIT),
    scenarioPath: SCENARIO,
    scenarioSha256,
    node: NODE,
    nodeVersion: process.version,
    git: spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim(),
    isolation: {
      PAO_HOME: env.PAO_HOME,
      PAO_CODING_AGENT_DIR: env.PAO_CODING_AGENT_DIR,
      PAO_WORKTREE_STATE_ROOT: env.PAO_WORKTREE_STATE_ROOT,
      PAO_RUN_MODE: env.PAO_RUN_MODE,
      PI_OFFLINE: env.PI_OFFLINE,
      PI_NO_LOCAL_LLM: env.PI_NO_LOCAL_LLM,
      providerEnvFromParent: Object.keys(process.env).filter((key) => /(?:API_KEY|AUTH_TOKEN|ACCESS_KEY)$/.test(key)),
    },
  };

  const startedAt = new Date();
  const suiteStarted = Date.now();
  const scenario = JSON.parse(readFileSync(SCENARIO, "utf8"));
  if (scenario.kitSha256 !== preflight.kitSha256) throw new Error("场景冻结的 kit 哈希与当前 kit 不一致");
  const { createScriptedModelServer } = await import(
    pathToFileURL(join(HERE, "scripted-model-server.mjs")).href
  );
  const server = await createScriptedModelServer({
    scenarioPath: SCENARIO,
    evidenceDir: modelEvidence,
    port: 0,
  });
  writeModelsConfig(env.PAO_CODING_AGENT_DIR, server.baseUrl);
  preflight.model = {
    provider: PROVIDER,
    id: MODEL,
    api: "openai-completions",
    host: server.host,
    port: server.port,
    baseUrl: server.baseUrl,
    scenarioSha256: server.scenarioSha256,
    syntheticUsage: true,
    syntheticUsageNote: server.syntheticUsageNote,
  };
  writeJson(join(evidenceDir, "preflight.json"), preflight);
  const bindingPath = join(evidenceDir, "binding.json");
  writeJson(bindingPath, {
    provider: PROVIDER,
    model: MODEL,
    model_name: `${PROVIDER}/${MODEL}`,
    selected_model_name: `${PROVIDER}/${MODEL}`,
    thinking: THINKING,
  });

  let child = null;
  let mainExit = null;
  let runResult;
  let runRecord;
  try {
    runSetup(env, env.PAO_HOME, env.PAO_CODING_AGENT_DIR, setupEvidence, project, bindingPath);
    const sessionId = `i5-2-${randomUUID()}`;
    const rpc = await startMain(
      env,
      project,
      sessionId,
      sessionDir,
      join(evidenceDir, "rpc-stdout.jsonl"),
      join(evidenceDir, "rpc-stderr.log"),
    );
    child = rpc.child;
    await sendPromptAndWaitForPreflight(rpc, {
      id: "i5-2-prompt",
      type: "prompt",
      message:
        "执行隔离正常链：在 业务/结果.txt 写入且仅写入一行“正常链完成”，使用真实工具自测。必须走产品部门工作流，完成后报告。",
    });
    const controlPath = join(project, ".pao", `工作流实例-${WORKFLOW}.md`);
    const timeoutMs = scenario.timeoutMs ?? 600000;
    const finalControl = await waitFor(
      () => {
        const control = readControl(controlPath);
        return control && (control.状态 === "已完成" || control.状态 === "挂起") ? control : null;
      },
      timeoutMs,
      500,
    );
    if (finalControl.状态 !== "已完成") {
      throw new Error(`控制正本未完成：状态=${finalControl.状态}，停因=${finalControl.暂停 ?? finalControl.停链原因 ?? "无"}`);
    }
    const controlCompletedRaw = readFileSync(controlPath, "utf8");
    const finalQueryPrompt = "I5-2-FINAL-QUERY：请调用 pao_query_flow 读取最终状态。";
    const finalQueryId = `i5-2-final-query-${randomUUID()}`;
    await sendPromptAndWaitForPreflight(rpc, {
      id: finalQueryId,
      type: "prompt",
      message: finalQueryPrompt,
      streamingBehavior: "followUp",
    });
    const finalQueryEvidence = await waitFor(
      () => {
        const responsesNow = readJsonLines(join(modelEvidence, "responses.jsonl"));
        const requestsNow = readJsonLines(join(modelEvidence, "requests.jsonl"));
        const response = responsesNow.find((item) => item.rule === "main-final-query-finished");
        const request = requestsNow.find((item) => item.matchedRule === "main-final-query-finished");
        return response && request ? { response, request } : null;
      },
      120000,
      100,
    );
    if (finalQueryEvidence.response.error) {
      throw new Error(`最终查询响应错误：${JSON.stringify(finalQueryEvidence.response.error)}`);
    }
    const queryText = finalQueryEvidence.request.latestTool?.content;
    if (
      finalQueryEvidence.request.latestTool?.name !== "pao_query_flow" ||
      typeof queryText !== "string" ||
      !queryText.includes("工作流「基准开发流水线」状态：completed")
    ) {
      throw new Error(`最终查询未得到产品 completed：${String(queryText)}`);
    }
    const controlBeforeShutdown = readFileSync(controlPath, "utf8");
    const controlBeforeShutdownData = readControl(controlPath);
    writeJson(join(evidenceDir, "pre-shutdown-control.json"), {
      path: controlPath,
      capturedAt: new Date().toISOString(),
      sha256: sha256File(controlPath),
      text: controlBeforeShutdown,
      data: controlBeforeShutdownData,
      completedImmediatelyBeforeQuery: controlCompletedRaw === controlBeforeShutdown,
    });
    writeJson(join(evidenceDir, "pre-shutdown-query.json"), {
      prompt: finalQueryPrompt,
      rpcId: finalQueryId,
      responseRule: finalQueryEvidence.response.rule,
      responseAt: finalQueryEvidence.response.at,
      request: {
        requestId: finalQueryEvidence.request.requestId,
        matchedRule: finalQueryEvidence.request.matchedRule,
        latestTool: finalQueryEvidence.request.latestTool,
      },
      productQueryText: queryText,
    });
    if (controlBeforeShutdownData?.状态 !== "已完成" || controlBeforeShutdownData?.暂停 !== undefined) {
      throw new Error(
        `最终查询后控制正本状态变化：状态=${controlBeforeShutdownData?.状态}，暂停=${controlBeforeShutdownData?.暂停 ?? "无"}`,
      );
    }
    child.stdin.end();
    mainExit = await settleWithTimeout(rpc.exited, 30000, () => {
      throw new Error("关闭 stdin 后主控 30 秒未退出");
    });
    await settleWithTimeout(rpc.stdoutClosed, 3000, () => ({ timeout: true }));
    const responses = readJsonLines(join(modelEvidence, "responses.jsonl"));
    const requests = readJsonLines(join(modelEvidence, "requests.jsonl"));
    const activation = readJsonLines(env.PAO_BENCH_ORG_ACTIVATION_LOG);
    const errors = responses.filter((item) => item.error);
    const matched = responses.filter((item) => typeof item.rule === "string" && !item.error);
    const expectedRuleIds = scenario.rules.map((rule) => rule.id);
    const matchedIds = new Set(matched.map((item) => item.rule));
    const missingRules = expectedRuleIds.filter((id) => !matchedIds.has(id));
    const roles = [...new Set(activation.map((item) => item.role))];
    const expectedRoles = ["main", "minister", "worker"];
    const missingRoles = expectedRoles.filter((role) => !roles.includes(role));
    const modelUsage = {
      synthetic: true,
      note: SYNTHETIC_USAGE_NOTE,
      requestCount: requests.length,
      responseCount: responses.length,
      matchedRuleCount: matched.length,
      errorCount: errors.length,
      unmatchedCount: responses.filter((item) => item.error?.type === "scripted_model_unmatched").length,
      outOfOrderCount: responses.filter((item) => item.error?.type === "scripted_model_out_of_order").length,
      unknownToolCount: responses.filter((item) => item.error?.type === "scripted_model_unknown_tool").length,
      ministerDecisionCount: responses.filter((item) => item.rule === "minister-review-decision").length,
    };
    writeJson(join(evidenceDir, "model-usage.json"), modelUsage);
    const controlRaw = readControl(controlPath);
    const reviewNode = controlRaw.节点.find((node) => node.名字 === "审核");
    const hadReviewPass = reviewNode?.判定?.结果 === "pass" && typeof reviewNode.判定.contentTree === "string";
    writeJson(join(evidenceDir, "final-control.json"), {
      controlPath,
      capturedAt: new Date().toISOString(),
      sha256: sha256File(controlPath),
      raw: controlRaw,
      rawStatus: controlRaw.状态,
      status: controlRaw.状态 === "已完成" ? "completed" : controlRaw.状态 === "挂起" ? "hold" : "running",
      review: {
        submitted: hadReviewPass,
        result: reviewNode?.判定?.结果 ?? null,
        contentTree: reviewNode?.判定?.contentTree ?? null,
        references: reviewNode?.判定?.引用 ?? [],
      },
    });

    const dispatchRows = readJsonLines(join(project, ".pao", "派发日志.jsonl"));
    const workerSpawns = dispatchRows.filter(
      (row) => row?.type === "pao_worker_process" && row.event === "spawn",
    );
    const workerExits = new Map(
      dispatchRows
        .filter((row) => row?.type === "pao_worker_process" && row.event === "exit")
        .map((row) => [row.执行标识, row]),
    );
    const workers = workerSpawns.map((spawn) => {
      const exit = workerExits.get(spawn.执行标识);
      const sessionProof = activation.find((item) => item.role === "worker" && item.pid === spawn.pid);
      return {
        executionId: spawn.执行标识,
        pid: spawn.pid,
        parentPid: sessionProof?.parent_pid ?? null,
        sessionId: sessionProof?.session_id ?? null,
        department: spawn.部门,
        exitCode: exit?.exitCode ?? null,
        signalCode: exit?.signalCode ?? null,
        stopped: exit?.exitCode === 0 && !pidExists(spawn.pid),
      };
    });

    const auditRows = readJsonLines(join(env.PAO_HOME, "部门", "审查", "监督审计.jsonl"));
    const auditSessions = parseMinisterAudit(auditRows);
    const ministers = (controlRaw.节点 ?? []).map((node) => {
      const session = node.部长会话;
      const sessionProof = activation.filter(
        (item) => item.role === "minister" && item.session_id === session,
      );
      const audit = auditSessions.get(session);
      const pids = [
        ...new Set([
          ...sessionProof.map((item) => item.pid).filter(Number.isInteger),
          ...(audit?.pids ?? []),
        ]),
      ];
      return {
        department: node.名字,
        session,
        activationPids: sessionProof.map((item) => item.pid),
        auditPids: audit?.pids ?? [],
        pids,
        stoppedPids: pids.filter((pid) => !pidExists(pid)),
        teardownCount: audit?.teardown.length ?? 0,
      };
    });
    const mainSessionProof = activation.find((item) => item.role === "main" && item.pid === child.pid);
    const main = {
      role: "main",
      pid: child.pid,
      parentPid: mainSessionProof?.parent_pid ?? null,
      sessionId: mainSessionProof?.session_id ?? null,
      exitCode: mainExit?.code ?? null,
      signalCode: mainExit?.signal ?? null,
      activationRecorded: mainSessionProof !== undefined,
      stopped: mainExit?.code === 0 && !pidExists(child.pid),
    };
    const allObservedStopped =
      main.stopped &&
      workers.length > 0 &&
      workers.every((item) => item.stopped) &&
      ministers.length > 0 &&
      ministers.every((item) => item.pids.length > 0 && item.stoppedPids.length === item.pids.length);
    writeJson(join(evidenceDir, "processes.json"), {
      main,
      workers,
      ministers,
      activation,
      roles,
      teardownRows: auditRows.filter((row) => row?.动作 === "散场"),
      allObservedStopped,
    });
    writeJson(join(evidenceDir, "rule-completion.json"), {
      expectedRuleIds,
      matchedRuleIds: [...matchedIds],
      missingRuleIds: missingRules,
      roles,
      missingRoles,
      decisionCount: modelUsage.ministerDecisionCount,
    });
    const portClosed = await (async () => {
      await server.close();
      try {
        const response = await fetch(`${server.baseUrl}/health`, { signal: AbortSignal.timeout(500) });
        return !response.ok;
      } catch {
        return true;
      }
    })();
    writeJson(join(evidenceDir, "server-close.json"), {
      baseUrl: server.baseUrl,
      port: server.port,
      closed: portClosed,
    });
    const run = {
      kind: "I5-2 同 kit 隔离正常链；脚本模型仅回环",
      ok: false,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - suiteStarted,
      runRoot,
      projectRoot: project,
      sourcePath: PACKAGE_ROOT,
      cliSha256: preflight.cliSha256,
      cliMtime: preflight.cliMtime,
      bundleArtifactMtime: preflight.bundleArtifactMtime,
      bundleManifestSha256: bundleManifest.aggregateSha256,
      sourceManifestSha256: sourceManifest.aggregateSha256,
      kitManifestSha256: kitManifest.aggregateSha256,
      bundleFileCount: bundleManifest.fileCount,
      sourceFileCount: sourceManifest.fileCount,
      kitFileCount: kitManifest.fileCount,
      snapshotSha256,
      kitSha256: preflight.kitSha256,
      scenarioSha256: preflight.scenarioSha256,
      controlPath,
      sessionId,
      syntheticUsage: true,
      syntheticUsageNote: SYNTHETIC_USAGE_NOTE,
    };
    runRecord = run;
    writeJson(join(evidenceDir, "run.json"), run);
    runResult = verifyEvidence(evidenceDir);
    run.ok = runResult.ok;
    run.verifiedAt = new Date().toISOString();
    writeJson(join(evidenceDir, "run.json"), run);
    writeJson(join(evidenceDir, "verification.json"), runResult);
    process.stdout.write(`${JSON.stringify(runResult)}\n`);
    if (!runResult.ok) process.exitCode = 1;
  } catch (error) {
    const failure = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      mainStdoutTail: child ? readJsonLines(join(evidenceDir, "rpc-stdout.jsonl")).slice(-20) : [],
      modelRequestTail: readJsonLines(join(modelEvidence, "requests.jsonl")).slice(-10),
      modelResponseTail: readJsonLines(join(modelEvidence, "responses.jsonl")).slice(-10),
      activationTail: readJsonLines(env.PAO_BENCH_ORG_ACTIVATION_LOG).slice(-20),
      artifactFiles: copyTreeSummary(evidenceDir, runRoot),
    };
    writeJson(join(evidenceDir, "failure.json"), failure);
    writeJson(join(evidenceDir, "run.json"), runRecord ?? {
      ok: false,
      runRoot,
      error: failure.message,
      cliSha256,
      bundleManifestSha256: bundleManifest.aggregateSha256,
      sourceManifestSha256: sourceManifest.aggregateSha256,
      kitManifestSha256: kitManifest.aggregateSha256,
      bundleFileCount: bundleManifest.fileCount,
      sourceFileCount: sourceManifest.fileCount,
      kitFileCount: kitManifest.fileCount,
      snapshotSha256,
      kitSha256: sha256File(KIT),
      scenarioSha256: sha256File(SCENARIO),
      syntheticUsage: true,
    });
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  } finally {
    if (child && !pidExists(child.pid)) {
      mainExit ??= { code: child.exitCode, signal: child.signalCode, error: null };
    } else if (child) {
      try {
        child.stdin.end();
        await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
        if (pidExists(child.pid)) stopTree(child.pid);
      } catch (error) {
        appendFileSync(join(evidenceDir, "cleanup-errors.log"), `${String(error)}\n`, "utf8");
      }
      mainExit = await Promise.race([
        (async () => {
          while (pidExists(child.pid)) await new Promise((resolveWait) => setTimeout(resolveWait, 200));
          return { code: child.exitCode, signal: child.signalCode, error: null };
        })(),
        new Promise((resolveWait) => setTimeout(() => resolveWait({ timeout: true }), 15000)),
      ]);
    }
    try {
      await server.close();
    } catch (error) {
      appendFileSync(join(evidenceDir, "cleanup-errors.log"), `关闭模型服务：${String(error)}\n`, "utf8");
    }
    if (existsSync(join(evidenceDir, "processes.json")) && mainExit) {
      const processesPath = join(evidenceDir, "processes.json");
      const processes = JSON.parse(readFileSync(processesPath, "utf8"));
      processes.main.exitCode = mainExit.code ?? processes.main.exitCode;
      processes.main.signalCode = mainExit.signal ?? processes.main.signalCode;
      processes.main.stopped =
        processes.main.exitCode === 0 && Number.isInteger(processes.main.pid) && !pidExists(processes.main.pid);
      processes.allObservedStopped =
        processes.main.stopped &&
        processes.workers?.every((item) => item.stopped) === true &&
        processes.ministers?.every(
          (item) => item.pids.length > 0 && item.stoppedPids.length === item.pids.length,
        ) === true;
      writeJson(processesPath, processes);
    }
  }
  if (!runResult?.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
