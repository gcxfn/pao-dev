// 用途：只读核对 I5-2 正常链证据；真值来自控制正本、卡、Git、产品日志与进程记录。
// 输入：彩排输出目录；输出：单行 JSON，任一结论不成立时退出码非零。
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const PACKAGE_ROOT = join(REPO_ROOT, "PAO/packages/coding-agent");
const SYNTHETIC_USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function normalizePath(path) {
  return resolve(path).toLocaleLowerCase("en-US");
}

function samePath(left, right) {
  return typeof left === "string" && typeof right === "string" && normalizePath(left) === normalizePath(right);
}

function walkPath(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) files.push(...walkPath(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function aggregateManifest(files) {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path, "en"));
  return sha256(
    ordered
      .map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`)
      .join(""),
  );
}

function verifyManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.roots) || !Array.isArray(manifest.files)) {
    return { ok: false, reason: "清单结构不完整" };
  }
  if (!Number.isFinite(Date.parse(manifest.capturedAt))) {
    return { ok: false, reason: "清单缺少有效采集时间" };
  }
  const actualFiles = [];
  for (const root of manifest.roots) {
    const absoluteRoot = isAbsolute(root.path) ? root.path : resolve(REPO_ROOT, root.path);
    for (const absolute of walkPath(absoluteRoot)) {
      const filePath = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
      if (actualFiles.some((file) => file.path === filePath)) continue;
      actualFiles.push({
        path: filePath,
        bytes: statSync(absolute).size,
        sha256: fileSha256(absolute),
        mtime: statSync(absolute).mtime.toISOString(),
      });
    }
  }
  actualFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const declaredFiles = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const compared = declaredFiles.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    mtime: file.mtime,
  }));
  const aggregateSha256 = aggregateManifest(actualFiles);
  return {
    ok:
      isDeepStrictEqual(compared, actualFiles) &&
      manifest.fileCount === actualFiles.length &&
      manifest.aggregateSha256 === aggregateSha256,
    reason: "文件集合、大小、修改时间、SHA-256 或汇总哈希不一致",
    fileCount: actualFiles.length,
    aggregateSha256,
  };
}

function verifyManifestIdentity(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.roots) || !Array.isArray(manifest.files)) {
    return { ok: false, reason: "清单结构不完整" };
  }
  if (!Number.isFinite(Date.parse(manifest.capturedAt))) {
    return { ok: false, reason: "清单缺少有效采集时间" };
  }
  const validFiles = manifest.files.every(
    (file) =>
      typeof file?.path === "string" &&
      file.path.length > 0 &&
      Number.isInteger(file.bytes) &&
      file.bytes >= 0 &&
      typeof file.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(file.sha256) &&
      Number.isFinite(Date.parse(file.mtime)),
  );
  const paths = manifest.files.map((file) => file?.path);
  const aggregateSha256 = validFiles ? aggregateManifest(manifest.files) : null;
  return {
    ok:
      validFiles &&
      new Set(paths).size === paths.length &&
      manifest.fileCount === manifest.files.length &&
      manifest.aggregateSha256 === aggregateSha256,
    reason: "清单条目不完整、路径重复或汇总哈希不一致",
    fileCount: manifest.files.length,
    aggregateSha256,
    capturedAt: manifest.capturedAt,
  };
}

function parseFrontmatter(path) {
  const text = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${path} 缺少 YAML frontmatter`);
  const yaml = createRequire(join(PACKAGE_ROOT, "package.json"))("yaml");
  return { data: yaml.parse(match[1]), body: text.slice(match[0].length), text };
}

function captureContentTree(projectRoot, scratchRoot) {
  const scratch = join(scratchRoot, `git-index-${randomUUID()}`);
  const indexPath = join(scratch, "index");
  mkdirSync(scratch, { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const runGit = (args) =>
    spawnSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    });
  try {
    const readTree = runGit(["read-tree", "HEAD"]);
    if (readTree.status !== 0) {
      throw new Error(`git read-tree 失败：${(readTree.stderr || readTree.stdout).trim()}`);
    }
    const add = runGit(["add", "-A", "--", ".", ":(exclude).pao"]);
    if (add.status !== 0) {
      throw new Error(`git add -A 失败：${(add.stderr || add.stdout).trim()}`);
    }
    const writeTree = runGit(["write-tree"]);
    if (writeTree.status !== 0) {
      throw new Error(`git write-tree 失败：${(writeTree.stderr || writeTree.stdout).trim()}`);
    }
    return writeTree.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function substitute(value, params) {
  if (typeof value === "string") {
    let result = value;
    for (const [key, replacement] of Object.entries(params)) result = result.replaceAll(`{${key}}`, replacement);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params)]));
  }
  return value;
}

function effectiveRecipeNodes(nodes) {
  return nodes.map((node) => ({
    ...node,
    审核: node.审核 ?? false,
    回边: node.回边 ?? [],
  }));
}

function findCard(cardsDir, ref) {
  const number = /^卡(\d{4})$/.exec(ref)?.[1];
  if (!number || !existsSync(cardsDir)) return null;
  const name = readdirSync(cardsDir).find((entry) => entry.startsWith(`卡${number}-`) && entry.endsWith(".md"));
  return name ? join(cardsDir, name) : null;
}

function listSessionFiles(root) {
  return walkPath(root).filter((path) => path.endsWith(".jsonl"));
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

function collectGitDiffStatus(projectRoot) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git status 失败：${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function allPidStopped(recorded) {
  return Array.isArray(recorded) && recorded.length > 0 && recorded.every((item) => item.stopped === true);
}

export function verifyEvidence(outputDir) {
  const root = resolve(outputDir);
  const required = [
    "run.json",
    "preflight.json",
    "processes.json",
    "pre-shutdown-control.json",
    "pre-shutdown-query.json",
    "model-usage.json",
    "server-close.json",
    "manifests/bundle-manifest.json",
    "manifests/source-manifest.json",
    "manifests/kit-manifest.json",
    "model/requests.jsonl",
    "model/responses.jsonl",
  ];
  const missing = required.filter((name) => !existsSync(join(root, name)));
  if (missing.length > 0) {
    return { ok: false, checks: [], missing, reason: `缺少证据文件：${missing.join(", ")}` };
  }

  const run = readJson(join(root, "run.json"));
  const preflight = readJson(join(root, "preflight.json"));
  const processes = readJson(join(root, "processes.json"));
  const preControlObservation = readJson(join(root, "pre-shutdown-control.json"));
  const query = readJson(join(root, "pre-shutdown-query.json"));
  const modelUsage = readJson(join(root, "model-usage.json"));
  const serverClose = readJson(join(root, "server-close.json"));
  const kitManifest = readJson(join(root, "manifests/kit-manifest.json"));
  const sourceManifest = readJson(join(root, "manifests/source-manifest.json"));
  const bundleManifest = readJson(join(root, "manifests/bundle-manifest.json"));
  const requests = readJsonLines(join(root, "model/requests.jsonl"));
  const responses = readJsonLines(join(root, "model/responses.jsonl"));
  const checks = [];
  const add = (id, ok, details) => checks.push({ id, ok, ...(details === undefined ? {} : { details }) });

  const runRoot = typeof run.runRoot === "string" ? resolve(run.runRoot) : resolve(root, "..");
  const projectRoot =
    typeof run.projectRoot === "string" ? resolve(run.projectRoot) : join(runRoot, "project");
  const kit = readJson(join(REPO_ROOT, "bench/organized-post/kit.json"));
  const scenario = readJson(join(REPO_ROOT, "bench/rehearsal/scenarios/normal.json"));
  const controlPath = join(projectRoot, ".pao", `工作流实例-${kit.workflow.名字}.md`);
  const control = existsSync(controlPath) ? parseFrontmatter(controlPath).data : null;
  const cardsDir = control?.卡目录 ? resolve(control.卡目录) : join(projectRoot, ".pao", "卡");

  const kitVerification = verifyManifest(kitManifest);
  const sourceVerification = verifyManifestIdentity(sourceManifest);
  const bundleVerification = verifyManifest(bundleManifest);
  const currentKitSha256 = fileSha256(join(REPO_ROOT, "bench/organized-post/kit.json"));
  add(
    "frozen-kit-manifest-current",
    kitVerification.ok &&
      preflight.kitSha256 === scenario.kitSha256 &&
      currentKitSha256 === scenario.kitSha256,
    { expectedKitSha256: scenario.kitSha256, actualKitSha256: currentKitSha256, manifest: kitVerification },
  );
  add(
    "source-manifest-identity",
    sourceVerification.ok &&
      preflight.sourceManifestSha256 === sourceManifest.aggregateSha256 &&
      Date.parse(sourceManifest.capturedAt) <= Date.parse(preflight.capturedAt),
    sourceVerification,
  );
  add(
    "bundle-manifest-current",
    bundleVerification.ok && preflight.bundleManifestSha256 === bundleManifest.aggregateSha256,
    bundleVerification,
  );
  add(
    "complete-snapshot-identity",
    preflight.snapshotSha256 ===
      sha256(
        [
          preflight.kitManifestSha256,
          preflight.sourceManifestSha256,
          preflight.bundleManifestSha256,
          preflight.scenarioSha256,
          preflight.cliSha256,
        ].join("\0"),
      ) &&
      preflight.kitManifestSha256 === kitManifest.aggregateSha256 &&
      preflight.bundleFileCount === bundleManifest.fileCount &&
      preflight.sourceFileCount === sourceManifest.fileCount &&
      preflight.kitFileCount === kitManifest.fileCount &&
      Date.parse(kitManifest.capturedAt) <= Date.parse(preflight.capturedAt) &&
      Date.parse(sourceManifest.capturedAt) <= Date.parse(preflight.capturedAt) &&
      Date.parse(bundleManifest.capturedAt) <= Date.parse(preflight.capturedAt),
    {
      snapshotSha256: preflight.snapshotSha256,
      bundleFileCount: bundleManifest.fileCount,
      sourceFileCount: sourceManifest.fileCount,
      kitFileCount: kitManifest.fileCount,
    },
  );

  const expectedRecipe = substitute(kit.workflow, control?.参数 ?? {});
  add(
    "frozen-recipe-matches-kit",
    control?.版本 === 2 &&
      control?.工作流 === kit.workflow.名字 &&
      control?.运行方式 === "无人值守" &&
      isDeepStrictEqual(
        effectiveRecipeNodes(control?.冻结配方?.节点 ?? []),
        effectiveRecipeNodes(expectedRecipe.节点),
      ),
  );
  const departments = Array.isArray(control?.冻结配方?.节点)
    ? control.冻结配方.节点.map((node) => node.部门)
    : [];
  add(
    "four-departments-match-kit",
    isDeepStrictEqual(departments, kit.departments.map((department) => department.name)) &&
      isDeepStrictEqual(control?.冻结配方?.拓扑序, ["侦察", "规划", "实施", "审核"]),
    { actual: departments },
  );

  let currentTree;
  let treeError;
  try {
    currentTree = captureContentTree(projectRoot, join(root, ".verification-tmp"));
  } catch (error) {
    treeError = error instanceof Error ? error.message : String(error);
  }
  const reviewNode = control?.节点?.find((node) => node.名字 === "审核");
  const decision = reviewNode?.判定;
  add(
    "review-pass-bound-to-current-tree",
    !treeError &&
      decision?.结果 === "pass" &&
      samePath(decision?.projectRoot, projectRoot) &&
      typeof decision?.contentTree === "string" &&
      decision.contentTree === currentTree &&
      Array.isArray(decision?.引用) &&
      decision.引用.some((reference) => typeof reference === "string" && reference.startsWith("业务/结果.txt:")),
    {
      reviewedTree: decision?.contentTree ?? null,
      currentTree: currentTree ?? null,
      error: treeError,
    },
  );

  const cardEvidence = (control?.节点 ?? []).map((node) => {
    const cards = (node.卡 ?? []).map((ref) => {
      const path = findCard(cardsDir, ref);
      if (!path) return { ref, path: null, status: null };
      const parsed = parseFrontmatter(path);
      return { ref, path, status: parsed.data?.status ?? null };
    });
    return { node: node.名字, cards };
  });
  const implementationNode = cardEvidence.find((node) => node.node === "实施");
  const auditNode = cardEvidence.find((node) => node.node === "审核");
  add(
    "implementation-and-review-cards-delivered",
    implementationNode?.cards.length === 2 &&
      implementationNode.cards.every((card) => card.path && card.status === "delivered") &&
      auditNode?.cards.length === 1 &&
      auditNode.cards.every((card) => card.path && card.status === "delivered") &&
      cardEvidence
        .filter((node) => node.node !== "实施" && node.node !== "审核")
        .every((node) => node.cards.length === 0),
    cardEvidence,
  );

  const resultPath = join(projectRoot, "业务", "结果.txt");
  let businessResult;
  try {
    businessResult = readFileSync(resultPath, "utf8");
  } catch {
    businessResult = null;
  }
  add("business-result-exact", businessResult === "正常链完成\n", { path: resultPath });

  const dispatchPath = join(projectRoot, ".pao", "派发日志.jsonl");
  const dispatchRows = readJsonLines(dispatchPath);
  const workerSpawns = dispatchRows.filter((row) => row?.type === "pao_worker_process" && row.event === "spawn");
  const workerExits = new Map(
    dispatchRows
      .filter((row) => row?.type === "pao_worker_process" && row.event === "exit")
      .map((row) => [row.执行标识, row]),
  );
  const activationEntries = Array.isArray(processes.activation) ? processes.activation : [];
  const workerEvidence = workerSpawns.map((spawn) => {
    const exit = workerExits.get(spawn.执行标识);
    const activated = activationEntries.find(
      (item) => item.role === "worker" && item.pid === spawn.pid,
    );
    return {
      executionId: spawn.执行标识,
      pid: spawn.pid,
      department: spawn.部门,
      exitCode: exit?.exitCode ?? null,
      stopped: exit?.exitCode === 0 && !pidExists(spawn.pid),
      activationRecorded: activated !== undefined,
    };
  });
  const workerDepartments = new Set(workerEvidence.map((item) => item.department));
  const workerActivations = activationEntries.filter((item) => item.role === "worker");
  add(
    "real-workers-started-and-stopped",
    workerEvidence.length === 3 &&
      workerActivations.length === 3 &&
      new Set(workerEvidence.map((item) => item.executionId)).size === 3 &&
      workerEvidence.every((item) => Number.isInteger(item.pid) && item.stopped) &&
      workerEvidence.every((item) => item.activationRecorded) &&
      workerActivations.every(
        (item) =>
          Number.isInteger(item.pid) &&
          Number.isInteger(item.parent_pid) &&
          typeof item.session_id === "string" &&
          Array.isArray(item.active) &&
          Array.isArray(item.registered) &&
          item.active.includes("pao_submit_receipt") &&
          item.registered.includes("pao_submit_receipt"),
      ) &&
      workerDepartments.has("实施") &&
      workerDepartments.has("审核"),
    { workers: workerEvidence, activations: workerActivations },
  );

  const mainActivations = activationEntries.filter((item) => item.role === "main");
  add(
    "real-main-role-proof",
    mainActivations.length === 1 &&
      mainActivations[0].pid === processes.main?.pid &&
      Number.isInteger(mainActivations[0].parent_pid) &&
      typeof mainActivations[0].session_id === "string" &&
      Array.isArray(mainActivations[0].required_registered) &&
      Array.isArray(mainActivations[0].registered) &&
      Array.isArray(mainActivations[0].active) &&
      mainActivations[0].required_registered.every((name) =>
        mainActivations[0].registered.includes(name),
      ) &&
      ["read", "bash", "edit", "write"].every((name) => !mainActivations[0].active.includes(name)),
    mainActivations,
  );

  const ministerSessionsRoot = join(projectRoot, ".pao", "部长会话");
  const ministerSessionFiles = listSessionFiles(ministerSessionsRoot);
  const auditRows = readJsonLines(join(preflight.isolation.PAO_HOME, "部门", "审查", "监督审计.jsonl"));
  const auditSessions = parseMinisterAudit(auditRows);
  const ministerEvidence = (control?.节点 ?? []).map((node) => {
    const session = node.部长会话;
    const files = ministerSessionFiles.filter((path) => path.endsWith(`_${session}.jsonl`));
    const audit = auditSessions.get(session);
    const activated = activationEntries.filter(
      (item) => item.role === "minister" && item.session_id === session,
    );
    return {
      department: node.名字,
      session,
      sessionFileCount: files.length,
      auditPids: audit?.pids ?? [],
      teardownCount: audit?.teardown.length ?? 0,
      activationPids: activated.map((item) => item.pid),
    };
  });
  add(
    "real-ministers-started-and-stopped",
    ministerEvidence.length === 4 &&
      ministerEvidence.every(
        (item) =>
          typeof item.session === "string" &&
          item.sessionFileCount === 1 &&
          item.auditPids.length >= 1 &&
          item.teardownCount >= 1 &&
          item.activationPids.length >= 1 &&
          item.activationPids.every((pid) => item.auditPids.includes(pid)),
      ),
    ministerEvidence,
  );

  const ministerProcessEvidence = new Map(
    (processes.ministers ?? []).map((item) => [item.session, item]),
  );
  add(
    "recorded-processes-stopped",
    processes.main?.role === "main" &&
      Number.isInteger(processes.main.pid) &&
      processes.main.activationRecorded === true &&
      typeof processes.main.sessionId === "string" &&
      processes.main.exitCode === 0 &&
      processes.main.stopped === true &&
      !pidExists(processes.main.pid) &&
      processes.workers?.length === 3 &&
      processes.workers.every(
        (item) =>
          Number.isInteger(item.pid) &&
          item.exitCode === 0 &&
          item.stopped === true &&
          !pidExists(item.pid),
      ) &&
      processes.ministers?.length === 4 &&
      processes.ministers.every((item) => {
        const observed = ministerProcessEvidence.get(item.session);
        return (
          observed === item &&
          item.pids.length >= 1 &&
          item.pids.every((pid) => item.stoppedPids.includes(pid) && !pidExists(pid))
        );
      }) &&
      processes.allObservedStopped === true,
    {
      main: processes.main,
      workers: processes.workers,
      ministers: processes.ministers,
    },
  );

  const modelErrors = responses.filter((item) => item?.error);
  const expectedRuleIds = scenario.rules.map((rule) => rule.id);
  const matchedRuleIds = responses.map((item) => item?.rule).filter(Boolean);
  const missingRuleIds = expectedRuleIds.filter((id) => !matchedRuleIds.includes(id));
  const decisionCount = responses.filter((item) => item?.rule === "minister-review-decision").length;
  const prohibitedErrors = responses.filter((item) =>
    ["scripted_model_unmatched", "scripted_model_out_of_order", "scripted_model_unknown_tool"].includes(
      item?.error?.type,
    ),
  );
  add(
    "scripted-model-clean-and-ordered",
    modelErrors.length === 0 &&
      missingRuleIds.length === 0 &&
      decisionCount === 1 &&
      prohibitedErrors.length === 0 &&
      responses.filter((item) => item?.rule === "minister-review-decision-post").length === 1 &&
      responses.every(
        (item) =>
          typeof item?.rule === "string" &&
          item.usage?.synthetic === true &&
          item.usage.prompt_tokens === SYNTHETIC_USAGE.prompt_tokens &&
          item.usage.completion_tokens === SYNTHETIC_USAGE.completion_tokens &&
          item.usage.total_tokens === SYNTHETIC_USAGE.total_tokens,
      ),
    { modelErrors, missingRuleIds, decisionCount, prohibitedErrors },
  );
  add(
    "all-three-model-roles-observed",
    ["main", "minister", "worker"].every((role) => requests.some((item) => item.role === role)) &&
      modelUsage.synthetic === true &&
      modelUsage.errorCount === 0 &&
      modelUsage.unmatchedCount === 0 &&
      modelUsage.outOfOrderCount === 0 &&
      modelUsage.unknownToolCount === 0 &&
      modelUsage.requestCount === requests.length &&
      modelUsage.responseCount === responses.length,
    { requestCount: requests.length, responseCount: responses.length },
  );

  const queryText = query?.request?.latestTool?.content;
  add(
    "product-query-completed-before-shutdown",
    query?.prompt === "I5-2-FINAL-QUERY：请调用 pao_query_flow 读取最终状态。" &&
      query?.responseRule === "main-final-query-finished" &&
      query?.request?.matchedRule === "main-final-query-finished" &&
      query?.request?.latestTool?.name === "pao_query_flow" &&
      query?.productQueryText === queryText &&
      typeof queryText === "string" &&
      queryText.includes("工作流「基准开发流水线」状态：completed"),
    { queryText: queryText ?? null },
  );

  const preControl = preControlObservation?.data;
  add(
    "control-completed-before-and-after-shutdown",
    control?.状态 === "已完成" &&
      control?.暂停 === undefined &&
      preControl?.状态 === "已完成" &&
      preControl?.暂停 === undefined &&
      preControlObservation?.completedImmediatelyBeforeQuery === true &&
      preControlObservation?.text === readFileSync(controlPath, "utf8") &&
      preControlObservation?.sha256 === fileSha256(controlPath),
  );

  add(
    "server-loopback-and-closed",
    serverClose.closed === true &&
      serverClose.baseUrl?.startsWith("http://127.0.0.1:") &&
      preflight.model?.baseUrl === serverClose.baseUrl &&
      preflight.model?.api === "openai-completions",
  );

  return {
    ok: checks.every((item) => item.ok),
    checks,
    failedCheckIds: checks.filter((item) => !item.ok).map((item) => item.id),
    controlStatusFromYaml: control?.状态 ?? null,
    currentContentTree: currentTree ?? null,
    gitStatus: currentTree ? collectGitDiffStatus(projectRoot) : null,
    syntheticUsageNote: modelUsage.note,
    limitation: "脚本模型 usage 固定为 1/1/2，仅验证协议与证据形状；不能作为真实 token、费用或性能结论。",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputDir = process.argv[2];
  if (!outputDir) {
    process.stderr.write("用法：node verify-evidence.mjs <彩排输出目录>\n");
    process.exitCode = 2;
  } else {
    try {
      const result = verifyEvidence(outputDir);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, reason: error instanceof Error ? error.message : String(error) })}\n`,
      );
      process.exitCode = 1;
    }
  }
}
