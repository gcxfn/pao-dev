// 用途：把一次 PAO 彩排运行的真实日志整理为 G2 统一计数组件的输入。
// 输入：显式 runRoot；输出：可回链文件行号的候选、缺证项和 measureStructure 结果。
// 边界：只读原始日志，不猜测角色、PID、业务对象或计数覆盖范围。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { measureStructure } from "./measure-structure.mjs";

const FIXED_STEP_TOOLS = new Map([
  ["pao_start_flow", "启流"],
  ["pao_verify_card", "验收"],
  ["pao_deliver_card", "交卷"],
  ["pao_push_flow", "推流"],
]);
const NON_FIXED_JUDGMENT_TOOLS = new Map([
  [
    "pao_submit_decision",
    {
      classification: "professional_judgment",
      reason: "pass/change/reject 与双轴证据是审核专业判断，不属于可消除的模型固定手续。",
    },
  ],
  [
    "pao_minister_review_worker",
    {
      classification: "professional_judgment",
      reason:
        "部长依据人话句、普通偏差与机械证据提交 pass/hold，属于专业判断；机械项已由自动链先验，不能计作可消除的固定手续。",
    },
  ],
]);
const MINISTER_OUTPUT_TOOLS = new Map([
  [
    "pao_minister_save_node_map",
    {
      category: "地图",
      operation: "minister.node_map",
    },
  ],
  [
    "pao_minister_submit_cards",
    {
      category: "交卡",
      operation: "minister.cards",
    },
  ],
  [
    "pao_breakdown_done",
    {
      category: "拆解结束信号",
      operation: "minister.breakdown_done",
    },
  ],
  [
    "pao_submit_decision",
    {
      category: "最终判定",
      operation: "minister.decision",
    },
  ],
  [
    "pao_minister_review_worker",
    {
      category: "普通偏差判断",
      operation: "minister.worker_review",
    },
  ],
  [
    "pao_minister_rework_cards",
    {
      category: "返工卡",
      operation: "minister.rework_cards",
    },
  ],
  [
    "pao_request_ruling",
    {
      category: "请求裁定",
      operation: "minister.request_ruling",
    },
  ],
]);
const PROMPT_IDENTITY_FIELDS = new Set([
  "instance",
  "instance_id",
  "node",
  "round",
  "card",
  "card_id",
  "card_ref",
  "attempt",
  "request_id",
]);
// 当前产品没有“只转抄身份、没有任何业务判断或动作”的独立工具。
// 保留显式规则入口，避免把普通工具参数里出现身份字段误判成“抄身份”。
const IDENTITY_COPY_TOOL_RULES = new Map();
const RENAMED_DIFF_STATUSES = new Set(["R", "C"]);
const SKIPPED_INVENTORY_DIRS = new Set([".git", ".tmp", "node_modules", "worktree-baselines.git"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function messageText(content) {
  if (typeof content === "string") return text(content);
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((part) => isRecord(part) && part.type === "text")
    .map((part) => text(part.text))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function labeledValue(value, label) {
  return new RegExp(`^${label}[:：]\\s*(.+?)\\s*$`, "m").exec(value)?.[1]?.trim();
}

function labeledInteger(value, label) {
  const raw = labeledValue(value, label);
  return /^\d+$/.test(raw ?? "") ? Number(raw) : undefined;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function rootRelative(root, path) {
  const result = toPosix(relative(root, path));
  return result || ".";
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const result = resolve(value);
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function readBuffer(path) {
  const data = readFileSync(path);
  return path.endsWith(".gz") ? gunzipSync(data) : data;
}

export function readJsonLines(path) {
  const content = readBuffer(path).toString("utf8");
  const records = [];
  for (const [index, raw] of content.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    try {
      records.push({ line: index + 1, raw, value: JSON.parse(raw) });
    } catch (error) {
      records.push({
        line: index + 1,
        raw,
        value: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}

function readJson(path) {
  try {
    return JSON.parse(readBuffer(path).toString("utf8"));
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function listDirectories(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(path, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function listFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(path, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function walkFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_INVENTORY_DIRS.has(entry.name)) stack.push(path);
      } else if (entry.isFile()) {
        result.push(path);
      }
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function evidence(path, line) {
  return { path: toPosix(path), line };
}

function sourceEvidence(root, path, line) {
  return evidence(rootRelative(root, path), line);
}

function addUnknown(unknown, value) {
  const signature = JSON.stringify(value);
  if (!unknown.some((item) => JSON.stringify(item) === signature)) unknown.push(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableValue(value[key])]),
  );
}

function signature(value) {
  return JSON.stringify(stableValue(value));
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { epoch: value, iso: new Date(value).toISOString() };
  }
  if (typeof value === "string") {
    const epoch = Date.parse(value);
    if (Number.isFinite(epoch)) return { epoch, iso: new Date(epoch).toISOString() };
  }
  return undefined;
}

function readRunState(root, unknown, sources) {
  const path = resolve(root, "evidence", "run.json");
  if (!existsSync(path)) {
    addUnknown(unknown, {
      domain: "run_state",
      missing: ["evidence/run.json"],
      evidence: null,
    });
    return { ok: undefined, syntheticUsage: undefined, value: null };
  }
  const value = readJson(path);
  sources.push({
    path: "evidence/run.json",
    lineCount: 1,
    purpose: "run-state",
  });
  if (!isRecord(value) || value.parseError || typeof value.ok !== "boolean") {
    addUnknown(unknown, {
      domain: "run_state",
      missing: ["run.ok"],
      evidence: sourceEvidence(root, path, 1),
    });
  }
  return {
    ok: value?.ok,
    syntheticUsage: value?.syntheticUsage,
    syntheticUsageNote: text(value?.syntheticUsageNote),
    error: text(value?.error),
    value: isRecord(value) ? value : null,
  };
}

function readControl(root, unknown, sources) {
  const directory = resolve(root, "project", ".pao");
  const paths = listFiles(directory).filter(
    (path) => basename(path).startsWith("工作流实例-") && path.endsWith(".md"),
  );
  if (paths.length !== 1) {
    addUnknown(unknown, {
      domain: "control_instance",
      missing: ["project/.pao/工作流实例-*.md"],
      observed: paths.map((path) => rootRelative(root, path)),
      evidence: paths[0] ? sourceEvidence(root, paths[0], 1) : null,
    });
    return null;
  }
  const path = paths[0];
  const lines = readBuffer(path).toString("utf8").split(/\r?\n/);
  const field = (name) => {
    for (const [index, line] of lines.entries()) {
      const match = new RegExp(`^${name}:\\s*(.+?)\\s*$`).exec(line);
      if (match) return { value: match[1], line: index + 1 };
    }
    return undefined;
  };
  const instance = field("实例");
  const owner = field("owner");
  const status = field("状态");
  sources.push({
    path: rootRelative(root, path),
    lineCount: lines.length,
    purpose: "control-instance",
  });
  if (!instance || !owner) {
    addUnknown(unknown, {
      domain: "control_instance",
      missing: [!instance && "实例", !owner && "owner"].filter(Boolean),
      evidence: sourceEvidence(root, path, instance?.line ?? owner?.line ?? 1),
    });
  }
  return {
    path,
    instance: instance?.value,
    owner: owner?.value,
    status: status?.value,
    evidence: sourceEvidence(root, path, instance?.line ?? owner?.line ?? 1),
  };
}

function readActivations(root, unknown, sources) {
  const path = resolve(root, "evidence", "tool-activation.jsonl");
  if (!existsSync(path)) {
    addUnknown(unknown, {
      domain: "actor_activation",
      missing: ["evidence/tool-activation.jsonl"],
      evidence: null,
    });
    return [];
  }
  const records = readJsonLines(path);
  const activations = [];
  for (const record of records) {
    if (!isRecord(record.value)) {
      addUnknown(unknown, {
        domain: "actor_activation",
        missing: ["JSONL 行可解析"],
        evidence: sourceEvidence(root, path, record.line),
        detail: record.error,
      });
      continue;
    }
    const value = record.value;
    const pid = positiveInteger(value.pid);
    const role = text(value.role);
    const sessionId = text(value.session_id);
    const timestamp = parseTimestamp(value.at);
    if (!pid || !role || !sessionId || !timestamp) {
      addUnknown(unknown, {
        domain: "actor_activation",
        missing: [
          !pid && "pid",
          !role && "role",
          !sessionId && "session_id",
          !timestamp && "at",
        ].filter(Boolean),
        evidence: sourceEvidence(root, path, record.line),
      });
      continue;
    }
    activations.push({
      role,
      pid,
      parentPid: positiveInteger(value.parent_pid) ?? null,
      sessionId,
      timestamp,
      evidence: sourceEvidence(root, path, record.line),
    });
  }
  sources.push({
    path: "evidence/tool-activation.jsonl",
    lineCount: records.length,
    purpose: "actor-activations",
  });
  return activations;
}

function readDismissals(root, unknown, sources) {
  const auditRoot = resolve(root, "pao-home", "部门");
  if (!existsSync(auditRoot)) return [];
  const files = walkFiles(auditRoot).filter((path) => basename(path) === "监督审计.jsonl");
  const result = [];
  for (const path of files) {
    const records = readJsonLines(path);
    for (const record of records) {
      if (!isRecord(record.value) || record.value["动作"] !== "散场") continue;
      const target = text(record.value["目标"]);
      const pid = positiveInteger(Number(/pid\s+(\d+)/i.exec(target ?? "")?.[1]));
      const sessionId = /会话\s+([^)]+)\)/.exec(target ?? "")?.[1];
      const timestamp = parseTimestamp(record.value["时间"]);
      if (!pid || !sessionId || !timestamp) {
        addUnknown(unknown, {
          domain: "actor_dismissal",
          missing: [
            !pid && "pid",
            !sessionId && "session_id",
            !timestamp && "时间",
          ].filter(Boolean),
          evidence: sourceEvidence(root, path, record.line),
        });
        continue;
      }
      result.push({
        pid,
        sessionId,
        timestamp,
        evidence: sourceEvidence(root, path, record.line),
      });
    }
    sources.push({
      path: rootRelative(root, path),
      lineCount: records.length,
      purpose: "actor-dismissals",
    });
  }
  return result;
}

function readWorkerExecutions(root, unknown, sources) {
  const directory = resolve(root, "project", ".pao", "执行映射");
  const paths = listFiles(directory).filter((path) => path.endsWith(".jsonl"));
  const executions = new Map();
  for (const path of paths) {
    const records = readJsonLines(path);
    const values = records.filter((record) => isRecord(record.value));
    const executionId = text(values[0]?.value?.["执行标识"]) ?? basename(path, ".jsonl");
    if (!executionId) continue;
    const existing = executions.get(executionId);
    if (existing) {
      addUnknown(unknown, {
        domain: "worker_execution",
        missing: ["执行标识唯一"],
        evidence: sourceEvidence(root, path, 1),
        executionId,
      });
      existing.conflict = true;
      continue;
    }
    const start = values.find((record) => text(record.value["状态"]) === "启动");
    const running = values.find((record) => text(record.value["状态"]) === "运行中");
    const final = [...values].reverse().find((record) => {
      const status = text(record.value["状态"]);
      return status === "success" || status === "failed" || status === "canceled";
    });
    executions.set(executionId, {
      executionId,
      path,
      records,
      start,
      running,
      final,
      conflict: false,
    });
    sources.push({
      path: rootRelative(root, path),
      lineCount: records.length,
      purpose: "worker-execution-binding",
    });
  }
  return executions;
}

function readDispatch(root, unknown, sources) {
  const path = resolve(root, "project", ".pao", "派发日志.jsonl");
  if (!existsSync(path)) {
    addUnknown(unknown, {
      domain: "worker_dispatch",
      missing: ["project/.pao/派发日志.jsonl"],
      evidence: null,
    });
    return new Map();
  }
  const records = readJsonLines(path);
  const groups = new Map();
  for (const record of records) {
    if (!isRecord(record.value)) {
      addUnknown(unknown, {
        domain: "worker_dispatch",
        missing: ["JSONL 行可解析"],
        evidence: sourceEvidence(root, path, record.line),
        detail: record.error,
      });
      continue;
    }
    const value = record.value;
    if (value.type !== "pao_worker_process") continue;
    const executionId = text(value["执行标识"]);
    if (!executionId) {
      addUnknown(unknown, {
        domain: "worker_dispatch",
        missing: ["执行标识"],
        evidence: sourceEvidence(root, path, record.line),
      });
      continue;
    }
    const group = groups.get(executionId) ?? [];
    group.push({ ...record, value });
    groups.set(executionId, group);
  }
  sources.push({
    path: rootRelative(root, path),
    lineCount: records.length,
    purpose: "worker-process-lifecycle",
  });
  return groups;
}

function readWorkerEvidence(root, evidencePath, unknown) {
  if (!evidencePath || !existsSync(evidencePath)) {
    return { missing: ["证据路径存在"], records: [] };
  }
  if (!isWithin(root, evidencePath)) {
    return { missing: ["证据路径位于 runRoot 内"], records: [] };
  }
  const records = readJsonLines(evidencePath);
  if (records.length === 0) return { missing: ["worker evidence 非空"], records: [] };
  const header = records[0];
  const trailer = records.at(-1);
  if (!isRecord(header.value) || header.value.type !== "pao_worker_live") {
    return { missing: ["worker evidence 首行 pao_worker_live"], records };
  }
  if (!isRecord(trailer.value) || trailer.value.type !== "pao_worker_evidence") {
    return { missing: ["worker evidence 尾行 pao_worker_evidence"], records };
  }
  return { missing: [], records, header, trailer };
}

function chooseActivations(activations, criteria) {
  return activations.filter(
    (item) =>
      (!criteria.sessionId || item.sessionId === criteria.sessionId) &&
      item.pid === criteria.pid &&
      (!criteria.role || item.role === criteria.role),
  );
}

function chooseSingleActivation(activations, criteria, unknown, domain, context) {
  const matches = chooseActivations(activations, criteria);
  if (matches.length === 1) return matches[0];
  addUnknown(unknown, {
    domain,
    missing: [
      matches.length === 0 && "role/pid/session_id",
      matches.length > 1 && "唯一 role/pid/session_id",
    ].filter(Boolean),
    evidence: matches[0]?.evidence ?? null,
    context,
  });
  return null;
}

function chooseMainActivation(activations, unknown, domain, context) {
  const matches = activations.filter((item) => item.role === "main");
  if (matches.length === 1) return matches[0];
  addUnknown(unknown, {
    domain,
    missing: [
      matches.length === 0 ? "主控 activation" : "唯一主控 activation",
    ],
    evidence: matches[0]?.evidence ?? null,
    context,
  });
  return null;
}

function validateWorkerExecution(root, execution, spawn, activations, unknown) {
  const executionId = text(spawn["执行标识"]);
  const cardPath = text(spawn["卡路径"]);
  const attempt = positiveInteger(spawn["尝试"]);
  const ownerPid = positiveInteger(spawn["父进程"]);
  const workerPid = positiveInteger(spawn.pid);
  const missing = [];
  if (!executionId) missing.push("执行标识");
  if (!cardPath) missing.push("卡路径");
  if (!attempt) missing.push("尝试");
  if (!ownerPid) missing.push("父进程");
  if (!workerPid) missing.push("pid");
  if (!execution || execution.conflict) missing.push("唯一执行映射");
  if (missing.length > 0) return { missing };

  const start = execution.start?.value;
  const running = execution.running?.value;
  const final = execution.final?.value;
  if (!start || !running || !final) missing.push("启动/运行中/最终执行映射");
  if (start) {
    if (text(start["执行标识"]) !== executionId) missing.push("执行映射.执行标识");
    if (!samePath(text(start["卡路径"]), cardPath)) missing.push("执行映射.卡路径");
    if (positiveInteger(start["尝试"]) !== attempt) missing.push("执行映射.尝试");
    if (positiveInteger(start.ownerPid) !== ownerPid) missing.push("执行映射.ownerPid");
  }
  if (running) {
    if (positiveInteger(running.pid) !== workerPid) missing.push("执行映射.pid");
  }
  if (final && positiveInteger(final.pid) !== workerPid) missing.push("执行映射.final.pid");

  const sender = chooseSingleActivation(
    activations,
    { pid: ownerPid, role: "main" },
    unknown,
    "handoff_sender_identity",
    { executionId },
  );
  const receiver = chooseSingleActivation(
    activations,
    { pid: workerPid, sessionId: executionId, role: "worker" },
    unknown,
    "handoff_receiver_identity",
    { executionId },
  );
  if (!sender) missing.push("sender.role/pid");
  if (!receiver) missing.push("receiver.role/pid");
  if (receiver && receiver.parentPid !== ownerPid) {
    missing.push("worker activation.parent_pid 等于主控 PID");
  }

  const evidencePath = text(final?.["证据路径"]);
  const workerEvidence = readWorkerEvidence(root, evidencePath, unknown);
  missing.push(...workerEvidence.missing);
  const header = workerEvidence.header?.value;
  const trailer = workerEvidence.trailer?.value;
  if (header) {
    if (text(header["执行标识"]) !== executionId) missing.push("worker header.执行标识");
    if (!samePath(text(header["卡路径"]), cardPath)) missing.push("worker header.卡路径");
    if (positiveInteger(header["尝试"]) !== attempt) missing.push("worker header.尝试");
    if (positiveInteger(header.pid) !== workerPid) missing.push("worker header.pid");
  }
  if (trailer) {
    if (text(trailer["执行标识"]) !== executionId) missing.push("worker trailer.执行标识");
    if (!samePath(text(trailer["卡路径"]), cardPath)) missing.push("worker trailer.卡路径");
    if (positiveInteger(trailer["尝试"]) !== attempt) missing.push("worker trailer.尝试");
  }

  const sessionPath = text(final?.["会话路径"]);
  if (!sessionPath || !existsSync(sessionPath)) {
    missing.push("worker session 路径存在");
  } else if (!basename(sessionPath).includes(executionId)) {
    missing.push("worker session 文件名.执行标识");
  }

  if (missing.length > 0) return { missing: [...new Set(missing)] };
  return {
    missing: [],
    sender,
    receiver,
    evidencePath,
    sessionPath,
    records: workerEvidence.records,
    header,
    trailer,
    start,
    running,
    final,
  };
}

function cardToken(cardPath) {
  const name = basename(cardPath, ".md");
  return /^卡\d+/.exec(name)?.[0] ?? name;
}

function readCardReceipt(
  root,
  cardPath,
  attempt,
  evidencePath,
  executionId,
  expectedResult,
  unknown,
) {
  if (!cardPath || !existsSync(cardPath)) {
    return { missing: ["卡文件存在"] };
  }
  if (!isWithin(root, cardPath)) {
    return { missing: ["卡路径位于 runRoot 内"] };
  }
  const lines = readBuffer(cardPath).toString("utf8").split(/\r?\n/);
  const headings = [];
  for (const [index, line] of lines.entries()) {
    const match = /^##\s+回执\s+尝试(\d+)\b/.exec(line);
    if (match && Number(match[1]) === attempt) headings.push({ line: index + 1, text: line });
  }
  if (headings.length !== 1) {
    addUnknown(unknown, {
      domain: "worker_to_main",
      missing: [
        headings.length === 0
          ? `卡面回执 尝试${attempt}`
          : `唯一卡面回执 尝试${attempt}`,
      ],
      evidence: { path: rootRelative(root, cardPath), line: 1 },
      context: { executionId, attempt },
    });
    return { missing: ["唯一卡面回执"] };
  }
  const heading = headings[0];
  let endLine = lines.length;
  for (let index = heading.line; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      endLine = index;
      break;
    }
  }
  const block = lines.slice(heading.line - 1, endLine);
  const resultLineIndex = block.findIndex((line) => /^-\s+result[:：]\s*/.test(line));
  const evidenceLineIndex = block.findIndex((line) => /^-\s+evidence[:：]\s*/.test(line));
  const usageLineIndex = block.findIndex((line) => /^-\s+usage[:：]\s*/.test(line));
  const result = resultLineIndex >= 0
    ? /^-\s+result[:：]\s*(.+?)\s*$/.exec(block[resultLineIndex])?.[1]
    : undefined;
  const evidenceLine = evidenceLineIndex >= 0 ? block[evidenceLineIndex] : undefined;
  const usageLine = usageLineIndex >= 0 ? block[usageLineIndex] : undefined;
  const fieldJson = (line) => {
    const raw = /^-\s+[^:：]+[:：]\s*(.+?)\s*$/.exec(line ?? "")?.[1];
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const receiptEvidence = fieldJson(evidenceLine);
  const receiptUsage = fieldJson(usageLine);
  const missing = [];
  if (!result) missing.push("卡面回执.result");
  if (expectedResult && result !== expectedResult) {
    missing.push("卡面回执.result 等于成功工具参数");
  }
  if (
    !Array.isArray(receiptEvidence) ||
    !receiptEvidence.some((item) => samePath(text(item), evidencePath))
  ) {
    missing.push("卡面回执.evidence 指向当前 worker evidence");
  }
  if (!isRecord(receiptUsage) || text(receiptUsage.run_id) !== executionId) {
    missing.push("卡面回执.usage.run_id 等于执行标识");
  }
  if (missing.length > 0) {
    addUnknown(unknown, {
      domain: "worker_to_main",
      missing,
      evidence: {
        path: rootRelative(root, cardPath),
        line: heading.line + Math.max(resultLineIndex, evidenceLineIndex, usageLineIndex, 0),
      },
      context: { executionId, attempt },
    });
    return { missing };
  }
  return {
    missing: [],
    result,
    heading: {
      path: rootRelative(root, cardPath),
      line: heading.line,
    },
    resultEvidence: {
      path: rootRelative(root, cardPath),
      line: heading.line + resultLineIndex,
    },
    evidenceEvidence: {
      path: rootRelative(root, cardPath),
      line: heading.line + evidenceLineIndex,
    },
    usageEvidence: {
      path: rootRelative(root, cardPath),
      line: heading.line + usageLineIndex,
    },
  };
}

function pairWorkerReceiptEvents(root, evidencePath, records, unknown, executionId) {
  const starts = new Map();
  const ends = new Map();
  const conflicts = new Set();
  for (const record of records) {
    if (!isRecord(record.value)) continue;
    const value = record.value;
    if (
      value.type !== "tool_execution_start" &&
      value.type !== "tool_execution_end"
    ) {
      continue;
    }
    const callId = text(value.toolCallId);
    if (!callId) {
      addUnknown(unknown, {
        domain: "worker_to_main",
        missing: ["tool execution toolCallId"],
        evidence: sourceEvidence(root, evidencePath, record.line),
        context: { executionId, type: value.type },
      });
      continue;
    }
    const item = {
      callId,
      toolName: text(value.toolName),
      value,
      line: record.line,
      evidence: sourceEvidence(root, evidencePath, record.line),
      signature: signature(value),
    };
    const map = value.type === "tool_execution_start" ? starts : ends;
    const existing = map.get(callId);
    if (existing) {
      if (existing.signature !== item.signature) {
        conflicts.add(`${value.type}:${callId}`);
        addUnknown(unknown, {
          domain: "worker_to_main",
          missing: ["同一 toolCallId 的执行事件内容一致"],
          evidence: { first: existing.evidence, conflicting: item.evidence },
          context: { executionId, callId, type: value.type },
        });
      }
    } else {
      map.set(callId, item);
    }
  }
  const successful = [];
  const excluded = [];
  for (const [callId, start] of starts) {
    if (start.toolName !== "pao_submit_receipt") continue;
    const end = ends.get(callId);
    if (!end) {
      excluded.push({
        callId,
        reason: "缺少配对的 tool_execution_end",
        evidence: start.evidence,
      });
      continue;
    }
    if (end.toolName !== start.toolName) {
      excluded.push({
        callId,
        reason: "start/end toolName 不一致",
        evidence: { start: start.evidence, end: end.evidence },
      });
      continue;
    }
    if (conflicts.has(`tool_execution_start:${callId}`) || conflicts.has(`tool_execution_end:${callId}`)) {
      excluded.push({
        callId,
        reason: "重复执行事件冲突",
        evidence: { start: start.evidence, end: end.evidence },
      });
      continue;
    }
    const isError =
      end.value.isError === true || end.value.result?.isError === true;
    if (isError) {
      excluded.push({
        callId,
        reason: "tool_execution_end 报错",
        evidence: { start: start.evidence, end: end.evidence },
      });
      continue;
    }
    successful.push({ callId, start, end });
  }
  for (const [callId, end] of ends) {
    if (end.toolName !== "pao_submit_receipt") continue;
    if (!starts.has(callId)) {
      excluded.push({
        callId,
        reason: "缺少配对的 tool_execution_start",
        evidence: end.evidence,
      });
    }
  }
  return { successful, excluded };
}

function collectWorkerReceipt(
  root,
  validated,
  activations,
  control,
  unknown,
) {
  const executionId = text(validated.start["执行标识"]);
  const cardPath = text(validated.start["卡路径"]);
  const attempt = positiveInteger(validated.start["尝试"]);
  const pairs = pairWorkerReceiptEvents(
    root,
    validated.evidencePath,
    validated.records,
    unknown,
    executionId,
  );
  if (pairs.successful.length !== 1) {
    const missing = [
      pairs.successful.length === 0
        ? "一次成功的 pao_submit_receipt start/end 配对"
        : "唯一成功的 pao_submit_receipt start/end 配对",
    ];
    addUnknown(unknown, {
      domain: "worker_to_main",
      missing,
      evidence:
        pairs.excluded[0]?.evidence ??
        sourceEvidence(root, validated.evidencePath, validated.header.line),
      context: { executionId },
    });
    return { ok: false, excluded: pairs.excluded, missing };
  }
  const receipt = pairs.successful[0];
  const receiptArgs = isRecord(receipt.start.value.args)
    ? receipt.start.value.args
    : {};
  const expectedResult = text(receiptArgs.result);
  const cardReceipt = readCardReceipt(
    root,
    cardPath,
    attempt,
    validated.evidencePath,
    executionId,
    expectedResult,
    unknown,
  );
  if (cardReceipt.missing.length > 0) {
    return {
      ok: false,
      excluded: pairs.excluded,
      missing: cardReceipt.missing,
    };
  }
  const main = chooseSingleActivation(
    activations,
    { role: "main", pid: validated.sender.pid },
    unknown,
    "worker_to_main_receiver",
    { executionId },
  );
  if (!main) {
    return {
      ok: false,
      excluded: pairs.excluded,
      missing: ["主控接收者 role/pid/session_id"],
    };
  }
  const card = cardToken(cardPath);
  return {
    ok: true,
    excluded: pairs.excluded,
    candidate: {
      eventId: `worker-receipt:${executionId}:${receipt.callId}`,
      kind: "tool_handoff",
      chain: "worker_to_main",
      sender: { role: validated.receiver.role, pid: validated.receiver.pid },
      receiver: { role: main.role, pid: main.pid },
      senderSessionId: validated.receiver.sessionId,
      receiverSessionId: main.sessionId,
      operation: { kind: "tool", name: "worker.pao_submit_receipt" },
      businessObject: {
        type: "worker_receipt",
        id: `${control?.instance ?? "run-unknown"}|${card}|attempt-${attempt}|execution-${executionId}`,
      },
      callId: receipt.callId,
      retry: false,
      mapRecall: false,
      evidence: receipt.end.evidence,
      actorEvidence: {
        sender: validated.receiver.evidence,
        receiver: main.evidence,
      },
      invocationEvidence: receipt.start.evidence,
      resultEvidence: receipt.end.evidence,
      workerHeaderEvidence: sourceEvidence(
        root,
        validated.evidencePath,
        validated.header.line,
      ),
      workerTrailerEvidence: sourceEvidence(
        root,
        validated.evidencePath,
        validated.trailer.line,
      ),
      cardReceiptEvidence: {
        heading: cardReceipt.heading,
        result: cardReceipt.resultEvidence,
        evidence: cardReceipt.evidenceEvidence,
        usage: cardReceipt.usageEvidence,
      },
      derivation: {
        kind: "source_constrained_inference",
        source:
          "PAO/packages/coding-agent/src/pao/worker/runner.ts:1145-1153; PAO/packages/coding-agent/src/pao/workflow/auto.ts:624-675",
        reason:
          "worker evidence 直接记录成功的 pao_submit_receipt start/end；卡面宿主回执绑定同一 evidence 与 executionId；主控是唯一 ownerPid。进程 exit 仅作生命周期证据，不能单独形成该交接。",
      },
      cardPath,
      attempt,
      runId: executionId,
      exitCode: cardReceipt.result === "success"
        ? Number.isSafeInteger(validated.trailer.exitCode)
          ? validated.trailer.exitCode
          : null
        : null,
    },
  };
}

function collectHandoffs(
  root,
  dispatchGroups,
  executions,
  activations,
  control,
  unknown,
  observations,
) {
  const candidates = [];
  const workerReceipts = [];
  const excludedWorkerReceipts = [];
  let workerToMainComplete = true;
  for (const [executionId, lifecycle] of [...dispatchGroups.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const spawns = lifecycle.filter((record) => record.value.event === "spawn");
    if (spawns.length !== 1) {
      addUnknown(unknown, {
        domain: "worker_dispatch",
        missing: [spawns.length === 0 ? "spawn 事件" : "唯一 spawn 事件"],
        evidence: lifecycle[0]
          ? sourceEvidence(root, resolve(root, "project", ".pao", "派发日志.jsonl"), lifecycle[0].line)
          : null,
        context: { executionId },
      });
      workerToMainComplete = false;
      continue;
    }
    const spawn = spawns[0];
    const execution = executions.get(executionId);
    const validated = validateWorkerExecution(
      root,
      execution,
      spawn.value,
      activations,
      unknown,
    );
    if (validated.missing.length > 0) {
      addUnknown(unknown, {
        domain: "worker_dispatch",
        missing: validated.missing,
        evidence: sourceEvidence(
          root,
          resolve(root, "project", ".pao", "派发日志.jsonl"),
          spawn.line,
        ),
        context: { executionId },
      });
      workerToMainComplete = false;
      continue;
    }
    const cardPath = text(spawn.value["卡路径"]);
    const attempt = positiveInteger(spawn.value["尝试"]);
    const executionIdValue = text(spawn.value["执行标识"]);
    const businessId = [
      control?.instance ?? "run-unknown",
      cardToken(cardPath),
      `attempt-${attempt}`,
      `execution-${executionIdValue}`,
    ].join("|");
    candidates.push({
      kind: "tool_handoff",
      sender: { role: validated.sender.role, pid: validated.sender.pid },
      receiver: { role: validated.receiver.role, pid: validated.receiver.pid },
      senderSessionId: validated.sender.sessionId,
      receiverSessionId: validated.receiver.sessionId,
      operation: { kind: "tool", name: "pao_worker_process.spawn" },
      businessObject: { type: "worker_card_attempt", id: businessId },
      callId: executionIdValue,
      retry: false,
      mapRecall: false,
      evidence: sourceEvidence(
        root,
        resolve(root, "project", ".pao", "派发日志.jsonl"),
        spawn.line,
      ),
      actorEvidence: {
        sender: validated.sender.evidence,
        receiver: validated.receiver.evidence,
      },
      executionEvidence: {
        binding: sourceEvidence(root, execution.path, execution.final.line),
        workerHeader: sourceEvidence(root, validated.evidencePath, validated.header.line),
        workerTrailer: sourceEvidence(root, validated.evidencePath, validated.trailer.line),
        session: { path: rootRelative(root, validated.sessionPath), line: 1 },
      },
      lifecycleEvents: lifecycle.map((record) => ({
        event: text(record.value.event),
        time: text(record.value.time),
        evidence: sourceEvidence(
          root,
          resolve(root, "project", ".pao", "派发日志.jsonl"),
          record.line,
        ),
      })),
      cardPath,
      attempt,
      runId: executionIdValue,
      instance: control?.instance,
      executionRoot: text(spawn.value["执行根"]),
      exitCode:
        Number.isSafeInteger(validated.trailer.exitCode) ? validated.trailer.exitCode : null,
    });
    const receipt = collectWorkerReceipt(
      root,
      validated,
      activations,
      control,
      unknown,
    );
    if (receipt.ok) {
      workerReceipts.push(receipt.candidate);
      candidates.push(receipt.candidate);
    } else {
      workerToMainComplete = false;
    }
    excludedWorkerReceipts.push(
      ...receipt.excluded.map((item) => ({
        ...item,
        executionId,
      })),
    );
  }
  observations.handoffCoverageReason =
    "派发日志证明主控到 worker 的 spawn；worker 结果必须同时具备成功的 pao_submit_receipt start/end、宿主卡面回执、执行绑定与主控身份。进程 exit 只作生命周期证据。";
  return {
    candidates,
    workerReceipts,
    excludedWorkerReceipts,
    workerToMainCoverage: {
      complete: workerToMainComplete,
      evidence:
        workerReceipts[0]?.evidence ??
        candidates[0]?.evidence ??
        null,
      candidateCount: workerReceipts.length,
    },
  };
}

function sessionFiles(root) {
  return [
    resolve(root, "sessions"),
    resolve(root, "project", ".pao", "部长会话"),
    resolve(root, "project", ".pao", "worker会话"),
  ]
    .filter((path) => existsSync(path))
    .flatMap((path) => walkFiles(path).filter((file) => file.endsWith(".jsonl")));
}

function parseSession(root, path, unknown, sources) {
  const records = readJsonLines(path);
  const session = records.find(
    (record) => isRecord(record.value) && record.value.type === "session",
  )?.value;
  const sessionId = text(session?.id);
  if (!sessionId) {
    addUnknown(unknown, {
      domain: "role_session",
      missing: ["session.id"],
      evidence: sourceEvidence(root, path, 1),
    });
  }
  const calls = [];
  const userMessages = [];
  const results = new Map();
  for (const record of records) {
    if (!isRecord(record.value)) {
      addUnknown(unknown, {
        domain: "role_session",
        missing: ["JSONL 行可解析"],
        evidence: sourceEvidence(root, path, record.line),
        detail: record.error,
      });
      continue;
    }
    if (record.value.type !== "message") continue;
    const message = record.value.message;
    if (!isRecord(message)) continue;
    const timestamp =
      parseTimestamp(record.value.timestamp) ?? parseTimestamp(message.timestamp);
    if (message.role === "user") {
      const content = messageText(message.content);
      if (!content) {
        addUnknown(unknown, {
          domain: "role_session_user_message",
          missing: ["用户消息文本"],
          evidence: sourceEvidence(root, path, record.line),
        });
        continue;
      }
      userMessages.push({
        sessionId,
        file: path,
        content,
        timestamp,
        evidence: sourceEvidence(root, path, record.line),
      });
      continue;
    }
    if (message.role === "toolResult" && text(message.toolCallId)) {
      const callId = text(message.toolCallId);
      const result = {
        toolName: text(message.toolName),
        isError: message.isError === true,
        content: messageText(message.content),
        details: isRecord(message.details) ? message.details : null,
        structuredContent: isRecord(message.structuredContent)
          ? message.structuredContent
          : null,
        timestamp,
        line: record.line,
        evidence: sourceEvidence(root, path, record.line),
        signature: signature({
          toolName: message.toolName ?? null,
          isError: message.isError ?? null,
          content: message.content ?? null,
          details: message.details ?? null,
          structuredContent: message.structuredContent ?? null,
        }),
        conflict: false,
      };
      const existing = results.get(callId);
      if (existing) {
        if (existing.signature !== result.signature) {
          existing.conflict = true;
          result.conflict = true;
          addUnknown(unknown, {
            domain: "role_session_tool_result",
            missing: ["同一 toolCallId 的 toolResult 内容一致"],
            evidence: {
              first: existing.evidence,
              conflicting: result.evidence,
            },
            context: { sessionId, callId },
          });
        }
      } else {
        results.set(callId, result);
      }
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "toolCall") continue;
      const callId = text(part.id);
      const toolName = text(part.name);
      if (!callId || !toolName) {
        addUnknown(unknown, {
          domain: "role_session_tool_call",
          missing: [!callId && "toolCall.id", !toolName && "toolCall.name"].filter(Boolean),
          evidence: sourceEvidence(root, path, record.line),
        });
        continue;
      }
      calls.push({
        sessionId,
        file: path,
        callId,
        toolName,
        arguments: isRecord(part.arguments) ? part.arguments : {},
        timestamp,
        evidence: sourceEvidence(root, path, record.line),
        signature: signature({
          toolName,
          arguments: part.arguments ?? null,
        }),
      });
    }
  }
  sources.push({
    path: rootRelative(root, path),
    lineCount: records.length,
    purpose: "role-session",
    sessionId,
  });
  return { path, sessionId, calls, results, userMessages, recordCount: records.length };
}

function chooseActorForTime(
  activations,
  dismissals,
  criteria,
  timestamp,
  unknown,
  domain,
  context,
) {
  const sameSession = activations
    .filter(
      (item) =>
        item.sessionId === criteria.sessionId &&
        (!criteria.role || item.role === criteria.role) &&
        (!criteria.pid || item.pid === criteria.pid),
    )
    .sort((left, right) => left.timestamp.epoch - right.timestamp.epoch);
  if (sameSession.length === 0) {
    addUnknown(unknown, {
      domain,
      missing: ["真实 role/pid/session_id"],
      evidence: null,
      context,
    });
    return null;
  }
  if (!timestamp) {
    if (sameSession.length === 1) return sameSession[0];
    addUnknown(unknown, {
      domain,
      missing: ["事件时间以区分同 session 的多个 PID"],
      evidence: null,
      context,
    });
    return null;
  }
  const before = sameSession.filter((item) => item.timestamp.epoch <= timestamp.epoch);
  if (before.length === 0) {
    addUnknown(unknown, {
      domain,
      missing: ["事件时间之前且有效的 activation"],
      evidence: sameSession[0].evidence,
      context,
    });
    return null;
  }
  const latestEpoch = before.at(-1).timestamp.epoch;
  const latest = before.filter((item) => item.timestamp.epoch === latestEpoch);
  if (latest.length !== 1) {
    addUnknown(unknown, {
      domain,
      missing: ["同一时刻唯一 activation"],
      evidence: latest[0]?.evidence ?? null,
      context,
    });
    return null;
  }
  const actor = latest[0];
  const actorDismissals = dismissals
    .filter((item) => item.pid === actor.pid && item.sessionId === actor.sessionId)
    .sort((left, right) => left.timestamp.epoch - right.timestamp.epoch);
  const dismissalBeforeEvent = actorDismissals.find(
    (item) => item.timestamp.epoch <= timestamp.epoch,
  );
  if (dismissalBeforeEvent) {
    addUnknown(unknown, {
      domain,
      missing: ["事件时仍有效的 role/pid/session_id"],
      evidence: dismissalBeforeEvent.evidence,
      context,
    });
    return null;
  }
  const previous = before.filter(
    (item) => item.pid !== actor.pid && item.timestamp.epoch < actor.timestamp.epoch,
  );
  for (const prior of previous) {
    const priorDismissed = dismissals.some(
      (item) =>
        item.pid === prior.pid &&
        item.sessionId === prior.sessionId &&
        item.timestamp.epoch <= actor.timestamp.epoch,
    );
    if (!priorDismissed) {
      addUnknown(unknown, {
        domain,
        missing: ["同 session 旧 PID 散场记录以区分重开"],
        evidence: {
          previousActivation: prior.evidence,
          latestActivation: actor.evidence,
        },
        context,
      });
      return null;
    }
  }
  return {
    ...actor,
    dismissalEvidence: actorDismissals.at(-1)?.evidence ?? null,
  };
}

function chooseActorForCall(activations, dismissals, call, unknown) {
  return chooseActorForTime(
    activations,
    dismissals,
    { role: undefined, sessionId: call.sessionId },
    call.timestamp,
    unknown,
    "model_fixed_step_actor",
    { sessionId: call.sessionId, callId: call.callId },
  );
}

function buildSessionIndex(root, sessions, activations, unknown) {
  const byId = new Map();
  const duplicates = [];
  for (const session of sessions) {
    if (!session.sessionId) continue;
    const existing = byId.get(session.sessionId);
    if (existing) {
      duplicates.push(session.sessionId);
      addUnknown(unknown, {
        domain: "role_session",
        missing: ["同一 session_id 只对应一份会话文件"],
        evidence: {
          first: { path: rootRelative(root, existing.path), line: 1 },
          duplicate: { path: rootRelative(root, session.path), line: 1 },
        },
        context: { sessionId: session.sessionId },
      });
      continue;
    }
    byId.set(session.sessionId, session);
  }
  const activationSessionIds = [
    ...new Set(activations.map((item) => item.sessionId).filter(Boolean)),
  ];
  const missingActivationSessions = activationSessionIds.filter((id) => !byId.has(id));
  for (const sessionId of missingActivationSessions) {
    addUnknown(unknown, {
      domain: "role_session",
      missing: ["activation.session_id 对应会话文件"],
      evidence: activations.find((item) => item.sessionId === sessionId)?.evidence ?? null,
      context: { sessionId },
    });
  }
  const sessionsWithoutActivation = [...byId.values()]
    .filter(
      (session) =>
        !activations.some((item) => item.sessionId === session.sessionId),
    )
    .map((session) => session.sessionId);
  for (const sessionId of sessionsWithoutActivation) {
    addUnknown(unknown, {
      domain: "role_session",
      missing: ["会话文件对应 activation"],
      evidence: {
        path: rootRelative(root, byId.get(sessionId).path),
        line: 1,
      },
      context: { sessionId },
    });
  }
  const emptySessions = [...byId.values()]
    .filter((session) => !session.recordCount)
    .map((session) => session.sessionId);
  const complete =
    byId.size > 0 &&
    byId.size === sessions.length &&
    duplicates.length === 0 &&
    missingActivationSessions.length === 0 &&
    sessionsWithoutActivation.length === 0 &&
    emptySessions.length === 0;
  const firstSession = [...byId.values()][0];
  return {
    complete,
    byId,
    duplicates,
    missingActivationSessions,
    sessionsWithoutActivation,
    emptySessions,
    evidence: firstSession
      ? { path: rootRelative(root, firstSession.path), line: 1 }
      : null,
  };
}

function roleForSession(activations, sessionId) {
  const roles = [
    ...new Set(
      activations
        .filter((item) => item.sessionId === sessionId)
        .map((item) => item.role)
        .filter(Boolean),
    ),
  ];
  return roles.length === 1 ? roles[0] : undefined;
}

function ministerPromptKind(content) {
  if (/^工作流 worker 结果[:：]/m.test(content)) return "worker_result";
  if (content.includes("全部卡已经执行")) return "final_review";
  if (/^实例[:：]/m.test(content) && /^节点[:：]/m.test(content)) return "initial_task";
  return undefined;
}

function ministerSessionContext(session) {
  let instance;
  let node;
  let round;
  for (const message of session.userMessages) {
    instance ??= labeledValue(message.content, "实例");
    node ??= labeledValue(message.content, "节点");
    round ??= labeledInteger(message.content, "轮次");
    const workerHeader =
      /^工作流 worker 结果[:：][^/\r\n]+\/([^\s\r\n]+)\s+第(\d+)轮/m.exec(
        message.content,
      );
    if (workerHeader) {
      node ??= workerHeader[1];
      round ??= Number(workerHeader[2]);
    }
  }
  return {
    instance,
    node,
    round: positiveInteger(round),
  };
}

function promptBusinessObject(kind, content, context) {
  const instance = labeledValue(content, "实例") ?? context.instance;
  const node = labeledValue(content, "节点") ?? context.node;
  const round = labeledInteger(content, "轮次") ?? context.round;
  if (kind === "worker_result") {
    const card = /卡[:：]\s*([^；;\r\n]+)/.exec(content)?.[1]?.trim();
    const attemptRaw = /尝试[:：]\s*(\d+)/.exec(content)?.[1];
    const attempt = positiveInteger(Number(attemptRaw));
    return {
      missing: [
        !instance && "instance",
        !node && "node",
        !round && "round",
        !card && "card",
        !attempt && "attempt",
      ].filter(Boolean),
      value: {
        type: "minister_worker_result_prompt",
        id: `${instance}|${node}|round-${round}|card-${card}|attempt-${attempt}`,
      },
    };
  }
  const suffix = kind === "final_review" ? "final-review" : "task";
  return {
    missing: [
      !instance && "instance",
      !node && "node",
      !round && "round",
    ].filter(Boolean),
    value: {
      type: kind === "final_review" ? "minister_final_review_prompt" : "minister_task_prompt",
      id: `${instance}|${node}|round-${round}|${suffix}`,
    },
  };
}

function collectMainToMinisterPrompts(
  root,
  sessions,
  sessionIndex,
  activations,
  dismissals,
  unknown,
) {
  const candidates = [];
  const excluded = [];
  let complete = sessionIndex.complete;
  const main = chooseMainActivation(
    activations,
    unknown,
    "main_to_minister_sender",
    { chain: "main_to_minister_prompt" },
  );
  if (!main) complete = false;
  for (const session of sessions) {
    const role = roleForSession(activations, session.sessionId);
    if (role !== "minister") continue;
    const context = ministerSessionContext(session);
    for (const message of session.userMessages) {
      const promptKind = ministerPromptKind(message.content);
      if (!promptKind) {
        complete = false;
        addUnknown(unknown, {
          domain: "main_to_minister_prompt",
          missing: ["可分类的部长任务 prompt"],
          evidence: message.evidence,
          context: { sessionId: session.sessionId },
        });
        continue;
      }
      const receiver = chooseActorForTime(
        activations,
        dismissals,
        { role: "minister", sessionId: session.sessionId },
        message.timestamp,
        unknown,
        "main_to_minister_receiver",
        { sessionId: session.sessionId, line: message.evidence.line },
      );
      if (!receiver || !main) {
        complete = false;
        excluded.push({
          promptKind,
          evidence: message.evidence,
          reason: "缺少可配对的主控发送者或部长接收者身份",
        });
        continue;
      }
      if (receiver.parentPid !== main.pid) {
        complete = false;
        addUnknown(unknown, {
          domain: "main_to_minister_receiver",
          missing: ["部长 activation.parent_pid 等于主控 PID"],
          evidence: receiver.evidence,
          context: {
            sessionId: session.sessionId,
            mainPid: main.pid,
            receiverPid: receiver.pid,
            parentPid: receiver.parentPid,
          },
        });
        excluded.push({
          promptKind,
          evidence: message.evidence,
          reason: "部长 parent_pid 与主控 PID 不匹配",
        });
        continue;
      }
      const businessObject = promptBusinessObject(promptKind, message.content, context);
      if (businessObject.missing.length > 0) {
        complete = false;
        addUnknown(unknown, {
          domain: "main_to_minister_business_object",
          missing: businessObject.missing,
          evidence: message.evidence,
          context: { sessionId: session.sessionId },
        });
        continue;
      }
      candidates.push({
        eventId: `prompt:${session.sessionId}:${message.evidence.line}`,
        kind: "tool_handoff",
        chain: "main_to_minister_prompt",
        sender: { role: main.role, pid: main.pid },
        receiver: { role: receiver.role, pid: receiver.pid },
        senderSessionId: main.sessionId,
        receiverSessionId: receiver.sessionId,
        operation: {
          kind: "rpc",
          name:
            promptKind === "worker_result"
              ? "host_bridge.worker_result_prompt"
              : promptKind === "final_review"
                ? "host_bridge.final_review_prompt"
                : "host_bridge.minister_task_prompt",
        },
        businessObject: businessObject.value,
        callId: null,
        retry: false,
        mapRecall: false,
        promptKind,
        evidence: message.evidence,
        actorEvidence: {
          sender: main.evidence,
          receiver: receiver.evidence,
          previousDismissal: receiver.dismissalEvidence,
        },
        sessionEvidence: {
          sender: { path: rootRelative(root, sessionIndex.byId.get(main.sessionId)?.path ?? ""), line: 1 },
          receiver: { path: rootRelative(root, session.path), line: 1 },
        },
        derivation: {
          kind: "source_constrained_inference",
          source: "PAO/packages/coding-agent/src/pao/workflow/host-bridge.ts:867-967",
          reason:
            "接收 session 的用户消息直接记录投递内容；发送者是唯一主控 activation，接收者按事件时间、activation.parent_pid 和散场记录映射；源码只在该路径向部长 executeTask 投递 prompt。",
        },
      });
    }
  }
  return {
    candidates,
    excluded,
    coverage: {
      complete,
      evidence: candidates[0]?.evidence ?? sessionIndex.evidence,
      candidateCount: candidates.length,
      excludedCount: excluded.length,
    },
  };
}

function ministerOutputBusinessObject(call, result, context) {
  const base = `${context.instance}|${context.node}|round-${context.round}`;
  if (call.toolName === "pao_minister_save_node_map") {
    const mapRef = /pao-map:\/\/[^\s]+/.exec(result.content ?? "")?.[0];
    return {
      missing: mapRef ? [] : ["结果中的 pao-map:// 地图引用"],
      value: { type: "node_map", id: mapRef },
    };
  }
  if (call.toolName === "pao_minister_submit_cards") {
    const cards = /已排队[:：]\s*([^\r\n]+)/.exec(result.content ?? "")?.[1]?.trim();
    return {
      missing: cards ? [] : ["成功结果中的已排队卡号"],
      value: { type: "cards", id: `${base}|cards-${cards}` },
    };
  }
  if (call.toolName === "pao_breakdown_done") {
    return {
      missing: context.instance && context.node && context.round
        ? []
        : ["instance/node/round"],
      value: { type: "breakdown_signal", id: `${base}|breakdown-done` },
    };
  }
  if (call.toolName === "pao_submit_decision") {
    const decision = text(call.arguments.result);
    return {
      missing: decision ? [] : ["arguments.result"],
      value: { type: "minister_decision", id: `${base}|decision-${decision}` },
    };
  }
  if (call.toolName === "pao_minister_review_worker") {
    const requestId = text(call.arguments.request_id);
    return {
      missing: requestId ? [] : ["arguments.request_id"],
      value: { type: "worker_review", id: `${base}|review-${requestId}` },
    };
  }
  if (call.toolName === "pao_minister_rework_cards") {
    const cardRef = text(call.arguments.card_ref) ?? text(call.arguments.card_id);
    return {
      missing: cardRef ? [] : ["arguments.card_ref"],
      value: { type: "rework_cards", id: `${base}|rework-${cardRef}` },
    };
  }
  if (call.toolName === "pao_request_ruling") {
    const requestId = text(call.arguments.request_id);
    return {
      missing: requestId ? [] : ["arguments.request_id"],
      value: { type: "ruling_request", id: `${base}|ruling-${requestId}` },
    };
  }
  return {
    missing: ["可识别的部长业务输出语义"],
    value: { type: "unknown", id: `${base}|${call.callId}` },
  };
}

function collectMinisterToMain(
  root,
  sessions,
  sessionIndex,
  activations,
  dismissals,
  unknown,
) {
  const candidates = [];
  const excluded = [];
  const conflicts = new Set();
  const callsByKey = new Map();
  for (const session of sessions) {
    if (roleForSession(activations, session.sessionId) !== "minister") continue;
    for (const call of session.calls) {
      const key = `${session.sessionId}\u0000${call.callId}`;
      const existing = callsByKey.get(key);
      if (existing) {
        if (existing.signature !== call.signature) conflicts.add(key);
        continue;
      }
      callsByKey.set(key, call);
    }
  }
  let complete = sessionIndex.complete && conflicts.size === 0;
  const main = chooseMainActivation(
    activations,
    unknown,
    "minister_to_main_receiver",
    { chain: "minister_to_main" },
  );
  if (!main) complete = false;
  for (const [key, call] of callsByKey) {
    const output = MINISTER_OUTPUT_TOOLS.get(call.toolName);
    if (!output) continue;
    if (conflicts.has(key)) {
      complete = false;
      addUnknown(unknown, {
        domain: "minister_to_main_call",
        missing: ["同一 toolCallId 内容一致"],
        evidence: call.evidence,
        context: { sessionId: call.sessionId, callId: call.callId },
      });
      continue;
    }
    const session = sessionIndex.byId.get(call.sessionId);
    const result = session?.results.get(call.callId);
    if (!result) {
      complete = false;
      excluded.push({
        category: output.category,
        callId: call.callId,
        evidence: call.evidence,
        reason: "缺少配对的 toolResult",
      });
      continue;
    }
    if (result.conflict) {
      complete = false;
      excluded.push({
        category: output.category,
        callId: call.callId,
        evidence: { call: call.evidence, result: result.evidence },
        reason: "toolResult 重复且内容冲突",
      });
      continue;
    }
    if (result.isError) {
      excluded.push({
        category: output.category,
        callId: call.callId,
        evidence: { call: call.evidence, result: result.evidence },
        reason: "toolResult 报错，不是成功业务交接",
      });
      continue;
    }
    if (result.toolName && result.toolName !== call.toolName) {
      complete = false;
      excluded.push({
        category: output.category,
        callId: call.callId,
        evidence: { call: call.evidence, result: result.evidence },
        reason: "toolCall/toolResult 的 toolName 不一致",
      });
      continue;
    }
    const sender = chooseActorForTime(
      activations,
      dismissals,
      { role: "minister", sessionId: call.sessionId },
      call.timestamp,
      unknown,
      "minister_to_main_sender",
      { sessionId: call.sessionId, callId: call.callId },
    );
    if (!sender || !main) {
      complete = false;
      excluded.push({
        category: output.category,
        callId: call.callId,
        evidence: { call: call.evidence, result: result.evidence },
        reason: "缺少可配对的部长发送者或主控接收者身份",
      });
      continue;
    }
    if (sender.parentPid !== main.pid) {
      complete = false;
      addUnknown(unknown, {
        domain: "minister_to_main_sender",
        missing: ["部长 activation.parent_pid 等于主控 PID"],
        evidence: sender.evidence,
        context: {
          sessionId: call.sessionId,
          ministerPid: sender.pid,
          mainPid: main.pid,
          parentPid: sender.parentPid,
        },
      });
      continue;
    }
    const context = ministerSessionContext(session);
    const businessObject = ministerOutputBusinessObject(call, result, context);
    if (businessObject.missing.length > 0) {
      complete = false;
      addUnknown(unknown, {
        domain: "minister_to_main_business_object",
        missing: businessObject.missing,
        evidence: { call: call.evidence, result: result.evidence },
        context: { sessionId: call.sessionId, callId: call.callId },
      });
      continue;
    }
    candidates.push({
      eventId: `minister-output:${call.sessionId}:${call.callId}`,
      kind: "tool_handoff",
      chain: "minister_to_main",
      sender: { role: sender.role, pid: sender.pid },
      receiver: { role: main.role, pid: main.pid },
      senderSessionId: sender.sessionId,
      receiverSessionId: main.sessionId,
      operation: { kind: "tool", name: output.operation },
      businessObject: businessObject.value,
      callId: call.callId,
      retry: false,
      mapRecall: false,
      outputCategory: output.category,
      toolName: call.toolName,
      evidence: result.evidence,
      actorEvidence: {
        sender: sender.evidence,
        receiver: main.evidence,
        previousDismissal: sender.dismissalEvidence,
      },
      invocationEvidence: call.evidence,
      resultEvidence: result.evidence,
      derivation: {
        kind: "source_constrained_inference",
        source: "PAO/packages/coding-agent/src/pao/workflow/host-bridge.ts:467-508,960-986",
        reason:
          "部长会话记录成功 toolCall/toolResult；主控 activation 与部长 parent_pid 唯一配对。源码只在部长执行后读取控制正本并继续消费地图、交卡、拆解信号或判定。",
      },
    });
  }
  return {
    candidates,
    excluded,
    coverage: {
      complete,
      evidence: candidates[0]?.evidence ?? sessionIndex.evidence,
      candidateCount: candidates.length,
      excludedCount: excluded.length,
    },
  };
}

function fixedStepCategory(call) {
  const direct = FIXED_STEP_TOOLS.get(call.toolName);
  if (direct) return direct;
  if (call.toolName === "pao_change_status") {
    const status =
      text(call.arguments.new_status) ??
      text(call.arguments.newStatus) ??
      text(call.arguments.status);
    if (status === "delivered") return "交付";
  }
  return undefined;
}

function identityCopyCategory(call) {
  const rule = IDENTITY_COPY_TOOL_RULES.get(call.toolName);
  if (!rule) return undefined;
  const keys = Object.keys(call.arguments);
  const allowed = new Set([...PROMPT_IDENTITY_FIELDS, ...(rule.allowedFields ?? [])]);
  const hasRequired = [...rule.requiredFields].every((field) =>
    Object.hasOwn(call.arguments, field),
  );
  const onlyIdentity = keys.length > 0 && keys.every((key) => allowed.has(key));
  return hasRequired && onlyIdentity ? "抄身份" : undefined;
}

function businessIdentity(call, instance) {
  const args = call.arguments;
  const cardId =
    text(args.card_id) ??
    text(args.cardId) ??
    text(args.card_ref) ??
    text(args.cardRef) ??
    text(args.card);
  const id =
    cardId ??
    text(args.instance) ??
    text(args.runId) ??
    text(args.name) ??
    instance ??
    call.sessionId;
  return {
    type: cardId ? "card" : "operation",
    id,
  };
}

function collectFixedSteps(
  root,
  sessions,
  activations,
  dismissals,
  control,
  sessionsComplete,
  unknown,
  observations,
) {
  const callsByKey = new Map();
  const conflicts = new Set();
  let coverageComplete = sessionsComplete;
  for (const session of sessions) {
    for (const call of session.calls) {
      const key = `${session.sessionId}\u0000${call.callId}`;
      const existing = callsByKey.get(key);
      if (existing) {
        if (existing.signature !== call.signature) {
          conflicts.add(key);
          coverageComplete = false;
          addUnknown(unknown, {
            domain: "role_session_tool_call",
            missing: ["同一 toolCallId 内容一致"],
            evidence: call.evidence,
            context: {
              sessionId: session.sessionId,
              callId: call.callId,
              firstEvidence: existing.evidence,
            },
          });
        }
        continue;
      }
      callsByKey.set(key, call);
    }
  }

  const candidates = [];
  const unclassified = [];
  const excludedJudgment = [];
  for (const [key, call] of callsByKey) {
    if (conflicts.has(key)) continue;
    const result = sessions.find((item) => item.sessionId === call.sessionId)?.results.get(
      call.callId,
    );
    const judgmentExclusion = NON_FIXED_JUDGMENT_TOOLS.get(call.toolName);
    if (judgmentExclusion) {
      const evidence = result
        ? { call: call.evidence, result: result.evidence }
        : { call: call.evidence };
      excludedJudgment.push({
        eventId: `${call.sessionId}:${call.callId}`,
        callId: call.callId,
        sessionId: call.sessionId,
        toolName: call.toolName,
        completed: Boolean(result && !result.isError),
        classification: judgmentExclusion.classification,
        reason: judgmentExclusion.reason,
        missing: judgmentExclusion.missing ?? [],
        evidence,
      });
      if (judgmentExclusion.classification === "unknown") {
        addUnknown(unknown, {
          domain: "model_fixed_step_classification",
          missing: judgmentExclusion.missing,
          evidence,
          context: {
            sessionId: call.sessionId,
            callId: call.callId,
            toolName: call.toolName,
          },
        });
      }
      continue;
    }
    const category = fixedStepCategory(call) ?? identityCopyCategory(call);
    if (!category) {
      unclassified.push({
        toolName: call.toolName,
        callId: call.callId,
        sessionId: call.sessionId,
        completed: Boolean(result && !result.isError),
        evidence: call.evidence,
      });
      continue;
    }
    if (!result) {
      coverageComplete = false;
      unclassified.push({
        toolName: call.toolName,
        callId: call.callId,
        sessionId: call.sessionId,
        completed: false,
        missing: ["配对的 toolResult"],
        evidence: call.evidence,
      });
      continue;
    }
    if (result.conflict) {
      coverageComplete = false;
      unclassified.push({
        toolName: call.toolName,
        callId: call.callId,
        sessionId: call.sessionId,
        completed: false,
        missing: ["重复且冲突的 toolResult"],
        evidence: { call: call.evidence, result: result.evidence },
      });
      continue;
    }
    if (result.isError) {
      unclassified.push({
        toolName: call.toolName,
        callId: call.callId,
        sessionId: call.sessionId,
        completed: false,
        missing: ["成功的 toolResult"],
        evidence: { call: call.evidence, result: result.evidence },
      });
      continue;
    }
    if (result.toolName && result.toolName !== call.toolName) {
      coverageComplete = false;
      unclassified.push({
        toolName: call.toolName,
        callId: call.callId,
        sessionId: call.sessionId,
        completed: false,
        missing: ["toolCall/toolResult 的 toolName 一致"],
        evidence: { call: call.evidence, result: result.evidence },
      });
      continue;
    }
    const actor = chooseActorForCall(activations, dismissals, call, unknown);
    if (!actor) {
      coverageComplete = false;
      continue;
    }
    const businessObject = businessIdentity(call, control?.instance);
    candidates.push({
      eventId: `${call.sessionId}:${call.callId}`,
      callId: call.callId,
      category,
      actor: { role: actor.role, pid: actor.pid },
      businessObject,
      toolName: call.toolName,
      evidence: call.evidence,
      actorEvidence: actor.evidence,
      resultEvidence: result.evidence,
    });
  }
  observations.identityCopyRule = {
    definition:
      "仅统计没有独立业务判断或动作、唯一作用是把宿主已提供的 instance/node/round/card/attempt/request_id 原样转抄到下一成功工具调用的手续。",
    currentToolMappings: [...IDENTITY_COPY_TOOL_RULES.keys()],
    exclusions: [
      "pao_submit_decision",
      "pao_minister_review_worker",
      "启流/验收/交付/交卷/推流等已有明确类别",
      "仅参数里出现身份字段的普通工具调用",
    ],
    completeSessionNoMatchCountsAsZero: true,
  };
  observations.modelFixedStepCoverageReason =
    "只识别角色会话里有真实 actor 且成功配对的明确固定手续；pao_submit_decision 与 pao_minister_review_worker 作为专业判断保留事件但不计收益，pao_query_flow 等轮询不归入六类。身份字段出现本身不等于抄身份；完整会话中没有符合冻结规则的调用时可计 0。";
  return {
    candidates,
    unclassified,
    excludedJudgment,
    coverageComplete,
    evidence: candidates[0]?.evidence ?? sessions[0]?.calls[0]?.evidence ?? null,
  };
}

function readRpcExecutions(root, observations) {
  const path = resolve(root, "evidence", "rpc-stdout.jsonl");
  if (!existsSync(path)) return;
  const records = readJsonLines(path);
  const starts = new Map();
  const ends = new Map();
  for (const record of records) {
    if (!isRecord(record.value)) continue;
    const callId = text(record.value.toolCallId);
    if (!callId) continue;
    if (record.value.type === "tool_execution_start") {
      starts.set(callId, {
        toolName: text(record.value.toolName),
        line: record.line,
      });
    } else if (record.value.type === "tool_execution_end") {
      ends.set(callId, {
        toolName: text(record.value.toolName),
        line: record.line,
      });
    }
  }
  const unmatched = [...starts.entries()]
    .filter(([callId]) => !ends.has(callId))
    .map(([callId, value]) => ({
      callId,
      toolName: value.toolName,
      evidence: sourceEvidence(root, path, value.line),
    }));
  observations.rpcToolExecutions = {
    path: rootRelative(root, path),
    starts: starts.size,
    ends: ends.size,
    unmatched,
    classification: "tool-execution-telemetry",
    reason: "事件只有主控执行端，没有接收角色、PID 和业务对象，不能直接作为业务交接。",
  };
}

function countLines(path) {
  if (!existsSync(path)) return undefined;
  const data = readBuffer(path).toString("utf8");
  let count = 0;
  for (const line of data.split(/\r?\n/)) {
    if (line.trim()) count += 1;
  }
  return count;
}

function collectExcludedSources(root, observations) {
  const requests = resolve(root, "evidence", "model", "requests.jsonl");
  if (existsSync(requests)) {
    observations.excludedSources ??= [];
    observations.excludedSources.push({
      kind: "model_http_request",
      path: rootRelative(root, requests),
      count: countLines(requests),
      evidence: sourceEvidence(root, requests, 1),
      classification: "protocol_request",
      reason: "模型 HTTP 请求是协议活动；没有接收业务角色/PID，不能直接等同于业务交接。",
    });
  }
  const responses = resolve(root, "evidence", "model", "responses.jsonl");
  if (existsSync(responses)) {
    observations.excludedSources.push({
      kind: "model_http_response",
      path: rootRelative(root, responses),
      count: countLines(responses),
      evidence: sourceEvidence(root, responses, 1),
      classification: "protocol_request",
      reason: "模型 HTTP 响应只记录协议回环，不证明业务交接。",
    });
  }
}

function classifyFile(rel) {
  const lower = rel.toLowerCase();
  const tailPao = lower.match(/(?:^|\/)\.pao\/(.+)$/)?.[1] ?? "";
  const pao = lower.startsWith("project/.pao/") ? lower.slice("project/.pao/".length) : tailPao;
  if (pao.startsWith("输入快照/attempts/")) {
    return { category: "input", kind: "attempt-input" };
  }
  if (pao.startsWith("输入快照/brief/")) {
    return { category: "input", kind: "worker-brief" };
  }
  if (pao.startsWith("输入快照/map/")) {
    return { category: "input", kind: "node-map" };
  }
  if (pao.startsWith("卡/") && pao.endsWith(".md")) {
    return { category: "state", kind: "card-markdown" };
  }
  if (/^工作流实例-.+\.md$/.test(pao)) {
    return { category: "state", kind: "workflow-instance" };
  }
  if (/^基线\/卡\d+-尝试\d+-基线\.json$/.test(pao)) {
    return { category: "input", kind: "attempt-baseline" };
  }
  if (pao.startsWith("基线/")) return { category: "state", kind: "legacy-baseline" };
  if (pao.startsWith("execution-contexts/")) {
    return { category: "input", kind: "execution-context" };
  }
  if (pao.startsWith("执行映射/")) return { category: "state", kind: "execution-map" };
  if (pao.startsWith("执行根守卫/")) return { category: "state", kind: "execution-root-guard" };
  if (pao === "共享锁") return { category: "state", kind: "shared-lock" };
  if (pao === "执行锁") return { category: "state", kind: "execution-lock" };
  if (pao === "卡号.txt") return { category: "state", kind: "card-number" };
  if (pao === "黑板.md") return { category: "state", kind: "blackboard" };
  if (pao === "四指标账.txt") return { category: "raw_evidence", kind: "workflow-metrics-ledger" };
  if (pao.startsWith("判定包/")) return { category: "derived", kind: "decision-pack" };
  if (pao === "派发日志.jsonl") {
    return { category: "raw_evidence", kind: "dispatch-log" };
  }
  if (pao.startsWith("worker-evidence/")) {
    return {
      category: "raw_evidence",
      kind: pao.endsWith(".stderr.log")
        ? "worker-evidence-stderr"
        : "worker-evidence-jsonl",
    };
  }
  if (pao.startsWith("worker会话/")) {
    return { category: "raw_evidence", kind: "worker-session" };
  }
  if (pao.startsWith("部长会话/")) {
    return { category: "raw_evidence", kind: "minister-session" };
  }
  if (pao.startsWith("部长留证/")) {
    return { category: "raw_evidence", kind: "minister-exit-record" };
  }
  if (rel === "evidence/tool-activation.jsonl") {
    return { category: "raw_evidence", kind: "tool-activation" };
  }
  if (rel === "evidence/rpc-stdout.jsonl") {
    return { category: "raw_evidence", kind: "rpc-stdout" };
  }
  if (rel === "evidence/rpc-stderr.log") {
    return { category: "raw_evidence", kind: "rpc-stderr" };
  }
  if (rel.startsWith("evidence/model/")) {
    return { category: "raw_evidence", kind: "model-protocol-jsonl" };
  }
  if (rel.startsWith("sessions/")) {
    return { category: "raw_evidence", kind: "main-session" };
  }
  if (rel.startsWith("evidence/")) {
    return { category: "raw_evidence", kind: "harness-evidence" };
  }
  if (rel.startsWith("pao-home/部门/") && rel.endsWith("监督审计.jsonl")) {
    return { category: "raw_evidence", kind: "supervision-audit" };
  }
  if (rel === "worktree-state/pao-worktree-host.json") {
    return { category: "state", kind: "worktree-host" };
  }
  if (/^worktree-state\/worktrees\/project\/[^/]+\/\.git$/.test(rel)) {
    return { category: "state", kind: "worktree-git-pointer" };
  }
  if (/^worktree-state\/worktrees\/project\/[^/]+\/业务\/输入\.txt$/.test(rel)) {
    return { category: "input", kind: "business-input" };
  }
  if (/^worktree-state\/worktrees\/project\/[^/]+\/业务\/结果\.txt$/.test(rel)) {
    return { category: "business_result", kind: "business-result" };
  }
  if (rel.startsWith("worktree-state/worktrees/")) {
    return classifyFile(rel.slice("worktree-state/worktrees/".length));
  }
  if (rel === ".git") {
    return { category: "state", kind: "worktree-git-pointer" };
  }
  if (rel === "agent-dir/auth.json") {
    return { category: "state", kind: "auth-store" };
  }
  if (rel === "agent-dir/models-store.json") {
    return { category: "state", kind: "models-store" };
  }
  if (rel === "agent-dir/models.json") {
    return { category: "config", kind: "model-config" };
  }
  if (rel.startsWith("agent-dir/")) {
    if (rel.startsWith("agent-dir/extensions/") && rel.endsWith(".js")) {
      return { category: "config", kind: "extension-config" };
    }
    return { category: "unknown", kind: "agent-config-or-store" };
  }
  if (rel === "pao-home/部门/注册表.md") {
    return { category: "state", kind: "department-registry" };
  }
  const deptFile = rel.match(/^pao-home\/部门\/[^/]+\/(.+)$/);
  if (deptFile) {
    if (deptFile[1] === "配方.md") {
      return { category: "config", kind: "dept-recipe" };
    }
    if (/^交接\/[^/]+\.md$/.test(deptFile[1])) {
      return { category: "derived", kind: "minister-handoff-view" };
    }
    if (deptFile[1] === "知识库/索引.md") {
      return { category: "state", kind: "knowledge-facade" };
    }
    if (/^知识库\/(?:导览|教训|评测|做法)\/子索引\.md$/.test(deptFile[1])) {
      return { category: "derived", kind: "knowledge-index" };
    }
  }
  if (/^pao-home\/工作流\/[^/]+\.md$/.test(rel)) {
    return { category: "config", kind: "workflow-recipe" };
  }
  if (rel === "pao-home/用量账.jsonl") {
    return { category: "state", kind: "usage-ledger" };
  }
  if (rel === "pao-home/主控记忆/MEMORY.md") {
    return { category: "state", kind: "resident-memory" };
  }
  if (rel === "pao-home/pao配置/保温.json") {
    return { category: "config", kind: "host-runtime-config" };
  }
  if (rel === "pao-home/pao配置/档位.json") {
    return { category: "config", kind: "routing-config" };
  }
  if (rel.startsWith("pao-home/")) {
    return { category: "unknown", kind: "pao-home-config-or-state" };
  }
  if (rel === "project/业务/输入.txt") {
    return { category: "input", kind: "business-input" };
  }
  if (rel === "project/业务/结果.txt") {
    return { category: "business_result", kind: "business-result" };
  }
  if (rel.startsWith("project/业务/")) {
    return { category: "unknown", kind: "business-io" };
  }
  if (rel === "verification-independent.json") {
    return { category: "raw_evidence", kind: "independent-verification" };
  }
  return { category: "unknown", kind: "unclassified" };
}

function collectFiles(root, unknown) {
  const paths = walkFiles(root);
  const files = [];
  for (const path of paths) {
    const rel = rootRelative(root, path);
    const classification = classifyFile(rel);
    const size = statSync(path).size;
    files.push({
      path: rel,
      category: classification.category,
      kind: classification.kind,
      producer: null,
      evidence: { path: rel, line: 1 },
      bytes: size,
    });
    if (classification.category === "unknown") {
      addUnknown(unknown, {
        domain: "file_classification",
        missing: ["冻结运行清单中的明确事实类别"],
        evidence: { path: rel, line: 1 },
        file: rel,
        observedKind: classification.kind,
      });
    }
  }
  return {
    files,
    inventory: {
      method: "只读递归列出冻结 runRoot 内的普通文件；不跟随符号链接",
      complete: paths.length > 0,
      fileCount: files.length,
      excludedDirectoryNames: [...SKIPPED_INVENTORY_DIRS].sort((left, right) =>
        left.localeCompare(right),
      ),
      evidence: files[0]?.evidence ?? null,
    },
  };
}

function collectDiffStatusEvidence(root, observations) {
  // Git porcelain 的路径字段只在 R/C 状态带 “原路径 -> 新路径”；普通文件名可能合法包含该文本。
  const candidates = walkFiles(root).filter(
    (path) => basename(path) === "git-status.txt" || basename(path) === "status.txt",
  );
  observations.renamedPathRule = {
    rule: "仅 Git porcelain 的 R/C 状态解析 old -> new；其他状态保留完整路径。",
    evidence: candidates[0] ? sourceEvidence(root, candidates[0], 1) : null,
  };
}

function toMeasureInput(handoffs, fixedSteps, files, fileInventory, coverage) {
  return {
    schemaVersion: 1,
    coverage: {
      handoffs: {
        complete: coverage.handoffs.complete,
        evidence: coverage.handoffs.evidence,
      },
      modelFixedSteps: {
        complete: coverage.modelFixedSteps.complete,
        evidence: coverage.modelFixedSteps.evidence,
      },
      files: {
        complete: fileInventory.complete,
        evidence: fileInventory.evidence,
      },
    },
    handoffs: handoffs.map((item) => ({
      eventId: item.eventId,
      kind: item.kind,
      sender: item.sender,
      receiver: item.receiver,
      senderSessionId: item.senderSessionId,
      receiverSessionId: item.receiverSessionId,
      operation: item.operation,
      businessObject: item.businessObject,
      callId: item.callId,
      retry: item.retry,
      mapRecall: item.mapRecall,
      evidence: item.evidence,
    })),
    modelFixedSteps: fixedSteps.map((item) => ({
      eventId: item.eventId,
      callId: item.callId,
      category: item.category,
      evidence: item.evidence,
    })),
    files: files.map((item) => ({
      path: item.path,
      category: item.category,
      kind: item.kind,
      producer: item.producer,
      evidence: item.evidence,
    })),
  };
}

/**
 * 读取一个显式 runRoot，并返回可直接交给 measureStructure 的候选输入。
 *
 * 该函数不会把 actor 启动、HTTP 请求或工具执行遥测自动升级成业务交接，
 * 也不会从卡正文或文本回执猜另一侧身份。
 */
export function collectStructure({ runRoot }) {
  if (!text(runRoot)) throw new Error("runRoot 必须是非空绝对路径");
  const root = resolve(runRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`runRoot 不存在或不是目录：${root}`);
  }

  const unknown = [];
  const sources = [];
  const observations = {
    simulatedProtocolIsNotHandoff: true,
    excludedSources: [],
  };
  const runState = readRunState(root, unknown, sources);
  const control = readControl(root, unknown, sources);
  const activations = readActivations(root, unknown, sources);
  const dismissals = readDismissals(root, unknown, sources);
  const executions = readWorkerExecutions(root, unknown, sources);
  const dispatchGroups = readDispatch(root, unknown, sources);
  const workerCollection = collectHandoffs(
    root,
    dispatchGroups,
    executions,
    activations,
    control,
    unknown,
    observations,
  );
  const sessions = sessionFiles(root).map((path) =>
    parseSession(root, path, unknown, sources),
  );
  const sessionIndex = buildSessionIndex(root, sessions, activations, unknown);
  const mainToMinister = collectMainToMinisterPrompts(
    root,
    sessions,
    sessionIndex,
    activations,
    dismissals,
    unknown,
  );
  const ministerToMain = collectMinisterToMain(
    root,
    sessions,
    sessionIndex,
    activations,
    dismissals,
    unknown,
  );
  const fixed = collectFixedSteps(
    root,
    sessions,
    activations,
    dismissals,
    control,
    sessionIndex.complete,
    unknown,
    observations,
  );
  const handoffs = [
    ...workerCollection.candidates,
    ...mainToMinister.candidates,
    ...ministerToMain.candidates,
  ];
  const fileCollection = collectFiles(root, unknown);
  const files = fileCollection.files;
  readRpcExecutions(root, observations);
  collectExcludedSources(root, observations);
  collectDiffStatusEvidence(root, observations);

  const handoffCoverage = {
    complete:
      sessionIndex.complete &&
      workerCollection.workerToMainCoverage.complete &&
      mainToMinister.coverage.complete &&
      ministerToMain.coverage.complete,
    evidence:
      handoffs[0]?.evidence ??
      sessionIndex.evidence ??
      control?.evidence ??
      null,
  };
  const fixedStepCoverage = {
    complete: sessionIndex.complete && fixed.coverageComplete,
    evidence:
      fixed.candidates[0]?.evidence ??
      fixed.evidence ??
      sessionIndex.evidence ??
      null,
  };
  const input = toMeasureInput(
    handoffs,
    fixed.candidates,
    files,
    fileCollection.inventory,
    {
      handoffs: handoffCoverage,
      modelFixedSteps: fixedStepCoverage,
    },
  );
  const measurement = measureStructure(input);
  observations.runOk = runState.ok;
  observations.syntheticUsage = runState.syntheticUsage;
  observations.syntheticUsageNote = runState.syntheticUsageNote;
  observations.runError = runState.error ?? null;
  observations.normalComparisonEligible =
    runState.ok === true && runState.syntheticUsage === true;
  observations.formalCoverage = {
    handoffs: handoffCoverage.complete,
    modelFixedSteps: fixedStepCoverage.complete,
    files: fileCollection.inventory.complete,
    reason:
      "交接覆盖要求角色会话完整、每个部长 prompt 和成功部长输出均可映射、每个 worker 都有有效宿主回执；固定手续覆盖要求完整角色会话及明确成功配对。身份不明或配对缺失会显式保留 unknown，不用可识别子集冒充 complete。",
  };
  observations.handoffCoverage = {
    complete: handoffCoverage.complete,
    evidence: handoffCoverage.evidence,
    chains: {
      main_to_worker: {
        complete: workerCollection.workerToMainCoverage.complete,
        candidateCount: workerCollection.candidates.filter(
          (item) => item.operation.name === "pao_worker_process.spawn",
        ).length,
      },
      main_to_minister_prompt: mainToMinister.coverage,
      minister_to_main: ministerToMain.coverage,
      worker_to_main_receipt: workerCollection.workerToMainCoverage,
    },
  };
  observations.fixedStepCoverage = {
    complete: fixedStepCoverage.complete,
    evidence: fixedStepCoverage.evidence,
    candidateCount: fixed.candidates.length,
  };
  observations.fileInventory = fileCollection.inventory;

  return {
    schema: "pao-g2-structure-collection-v1",
    runRoot: root,
    runStatus: {
      ok: runState.ok,
      syntheticUsage: runState.syntheticUsage,
      error: runState.error ?? null,
    },
    control,
    input,
    measurement,
    candidates: {
      handoffs,
      modelFixedSteps: fixed.candidates,
      files,
    },
    observations: {
      ...observations,
      roleSessions: {
        complete: sessionIndex.complete,
        count: sessionIndex.byId.size,
        duplicates: sessionIndex.duplicates,
        missingActivationSessions: sessionIndex.missingActivationSessions,
        sessionsWithoutActivation: sessionIndex.sessionsWithoutActivation,
        emptySessions: sessionIndex.emptySessions,
        evidence: sessionIndex.evidence,
      },
      excludedMainToMinisterPrompts: mainToMinister.excluded,
      excludedMinisterToMainOutputs: ministerToMain.excluded,
      excludedWorkerReceipts: workerCollection.excludedWorkerReceipts,
      unclassifiedToolCalls: fixed.unclassified,
      excludedJudgmentEvents: fixed.excludedJudgment,
      actorActivations: activations.map((item) => ({
        role: item.role,
        pid: item.pid,
        parentPid: item.parentPid,
        sessionId: item.sessionId,
        at: item.timestamp.iso,
        evidence: item.evidence,
      })),
    },
    unknown,
    sources,
  };
}

export function collectStructureInput(options) {
  return collectStructure(options).input;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const runRoot = process.argv[2];
  if (!runRoot) {
    process.stderr.write("用法：node collect-structure.mjs <runRoot> [规范化输出.json]\n");
    process.exitCode = 2;
  } else {
    try {
      const output = collectStructure({ runRoot });
      const json = `${JSON.stringify(output, null, 2)}\n`;
      const outputPath = process.argv[3];
      if (outputPath) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(resolve(outputPath), json, "utf8");
      } else {
        process.stdout.write(json);
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
