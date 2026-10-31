// 用途：按 G2 冻结口径统计业务交接、模型固定手续和可变状态文件种类。
// 输入：显式规范化的运行事件与文件清单；输出：可回链原始证据的 JSON。
// 边界：不读取模型 HTTP 请求数、源码长度或 token；缺证一律返回 unknown。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BUSINESS_HANDOFF_KINDS = new Set(["tool_handoff", "rpc_handoff"]);
const EXCLUDED_HANDOFF_KINDS = new Set(["model_http", "telemetry", "log"]);
const FILE_CATEGORIES = new Set([
  "state",
  "input",
  "config",
  "raw_evidence",
  "derived",
  "business_result",
  "unknown",
]);
const MODEL_FIXED_CATEGORIES = ["启流", "抄身份", "验收", "交付", "交卷", "推流"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compareText(left, right) {
  return left.localeCompare(right);
}

function addIssue(issues, issue) {
  if (!issues.includes(issue)) issues.push(issue);
}

function readEvidence(value) {
  if (!isRecord(value)) return undefined;
  const path = text(value.path);
  const line = Number.isSafeInteger(value.line) && value.line > 0 ? value.line : undefined;
  return path && line ? { path, line } : undefined;
}

function readActor(value) {
  if (!isRecord(value)) return undefined;
  const role = text(value.role);
  const pid = Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
  return role && pid ? { role, pid } : undefined;
}

function readCoverage(coverage, name, issues) {
  const raw = isRecord(coverage) ? coverage[name] : undefined;
  if (!isRecord(raw)) {
    addIssue(issues, `coverage.${name} 缺失`);
    return { complete: false, evidence: null, missing: [`coverage.${name}`] };
  }
  const evidence = readEvidence(raw.evidence);
  const missing = [];
  if (raw.complete !== true) missing.push(`coverage.${name}.complete`);
  if (!evidence) missing.push(`coverage.${name}.evidence`);
  for (const field of missing) addIssue(issues, `${field} 缺失或无效`);
  return {
    complete: raw.complete === true && Boolean(evidence),
    evidence: evidence ?? null,
    missing,
  };
}

function unknown(missing, extras = {}) {
  return { status: "unknown", value: null, missing, ...extras };
}

function measured(value, extras = {}) {
  return { status: "measured", value, ...extras };
}

function createEvidenceIndex() {
  const entries = new Map();
  return {
    add(evidence, recordKey) {
      if (!evidence) return;
      const key = `${evidence.path}\u0000${evidence.line}`;
      const existing = entries.get(key);
      if (existing) {
        if (recordKey && !existing.records.includes(recordKey)) existing.records.push(recordKey);
      } else {
        entries.set(key, { ...evidence, records: recordKey ? [recordKey] : [] });
      }
    },
    list() {
      return [...entries.values()]
        .map((entry) => ({ ...entry, records: [...entry.records].sort(compareText) }))
        .sort((left, right) =>
          left.path === right.path ? left.line - right.line : compareText(left.path, right.path),
        );
    },
  };
}

function collectMissing(value, fields, prefix) {
  for (const [field, present] of Object.entries(fields)) {
    if (!present) value.push(`${prefix}.${field}`);
  }
}

function handoffKey(raw, normalized) {
  const eventId = text(raw.eventId);
  if (eventId) return `event:${eventId}`;
  const traceId = text(raw.traceId);
  if (traceId) return `trace:${traceId}`;
  return [
    "composite",
    normalized.kind,
    normalized.operation.kind,
    normalized.operation.name,
    normalized.businessObject.type,
    normalized.businessObject.id,
    normalized.callId ?? "",
    normalized.sender.role,
    String(normalized.sender.pid),
    normalized.receiver.role,
    String(normalized.receiver.pid),
  ].join("|");
}

function handoffSignature(normalized) {
  return JSON.stringify({
    kind: normalized.kind,
    sender: normalized.sender,
    receiver: normalized.receiver,
    operation: normalized.operation,
    businessObject: normalized.businessObject,
    callId: normalized.callId ?? null,
    retry: normalized.retry,
    retryOf: normalized.retryOf ?? null,
    mapRecall: normalized.mapRecall,
  });
}

function normalizeHandoff(raw) {
  const missing = [];
  const kind = text(raw.kind);
  const sender = readActor(raw.sender);
  const receiver = readActor(raw.receiver);
  const operation = isRecord(raw.operation)
    ? {
        kind: text(raw.operation.kind),
        name: text(raw.operation.name),
      }
    : undefined;
  const businessObject = isRecord(raw.businessObject)
    ? {
        type: text(raw.businessObject.type),
        id:
          typeof raw.businessObject.id === "string" || typeof raw.businessObject.id === "number"
            ? text(String(raw.businessObject.id))
            : undefined,
      }
    : undefined;
  const evidence = readEvidence(raw.evidence);
  collectMissing(missing, {
    kind: Boolean(kind),
    sender,
    receiver,
    operation: Boolean(operation?.kind && operation.name),
    "operation.kind":
      operation?.kind === "tool" || operation?.kind === "rpc" || Boolean(operation?.kind),
    businessObject: Boolean(businessObject?.type && businessObject.id),
    evidence,
  }, "handoff");
  if (operation?.kind && operation.kind !== "tool" && operation.kind !== "rpc") {
    missing.push("handoff.operation.kind");
  }
  if (missing.length > 0) return { ok: false, missing, evidence };

  const retryFlag = raw.retry === true;
  const retryOf = text(raw.retryOf);
  const retryCount = Number.isSafeInteger(raw.retryCount) ? raw.retryCount : 0;
  const normalized = {
    kind,
    sender,
    receiver,
    operation,
    businessObject,
    callId: text(raw.callId),
    retry: retryFlag || Boolean(retryOf) || retryCount > 0,
    retryOf,
    mapRecall: raw.mapRecall === true,
    evidence,
  };
  return {
    ok: true,
    value: {
      ...normalized,
      key: handoffKey(raw, normalized),
      signature: handoffSignature(normalized),
      eventId: text(raw.eventId),
      traceId: text(raw.traceId),
    },
  };
}

function processHandoffs(rawHandoffs, issues, evidenceIndex) {
  const records = new Map();
  const malformed = [];
  if (!Array.isArray(rawHandoffs)) {
    addIssue(issues, "handoffs 不是数组");
    return { records: [], malformed: ["handoffs"], duplicateConflicts: [] };
  }

  rawHandoffs.forEach((raw, index) => {
    if (!isRecord(raw)) {
      malformed.push(`handoffs[${index}]`);
      return;
    }
    const kind = text(raw.kind);
    if (kind && EXCLUDED_HANDOFF_KINDS.has(kind)) {
      const evidence = readEvidence(raw.evidence);
      evidenceIndex.add(evidence, `handoffs[${index}]`);
      return;
    }
    const normalized = normalizeHandoff(raw);
    if (!normalized.ok) {
      malformed.push(...normalized.missing.map((field) => `handoffs[${index}].${field}`));
      evidenceIndex.add(normalized.evidence, `handoffs[${index}]`);
      return;
    }
    evidenceIndex.add(normalized.value.evidence, normalized.value.key);
    const existing = records.get(normalized.value.key);
    if (existing && existing.signature !== normalized.value.signature) {
      malformed.push(`handoffs[${index}].eventId`);
      return;
    }
    if (!existing) records.set(normalized.value.key, normalized.value);
  });

  for (const item of records.values()) {
    if (!BUSINESS_HANDOFF_KINDS.has(item.kind)) {
      malformed.push(`${item.key}.kind`);
    }
  }
  for (const field of malformed) addIssue(issues, `${field} 缺失、无效或冲突`);
  return {
    records: [...records.values()].sort((left, right) => compareText(left.key, right.key)),
    malformed,
    duplicateConflicts: malformed.filter((field) => field.endsWith(".eventId")),
  };
}

function boundaryDimension(ready, records, predicate, missing) {
  const eventKeys = records.filter(predicate).map((item) => item.key).sort(compareText);
  return ready
    ? measured(eventKeys.length, { eventKeys })
    : unknown(missing, { eventKeys });
}

function fixedStepKey(raw) {
  const eventId = text(raw.eventId);
  if (eventId) return `event:${eventId}`;
  const traceId = text(raw.traceId);
  if (traceId) return `trace:${traceId}`;
  const callId = text(raw.callId);
  if (callId) return `call:${callId}`;
  const evidence = readEvidence(raw.evidence);
  return evidence ? `evidence:${evidence.path}:${evidence.line}` : "invalid:missing-key";
}

function processModelFixedSteps(rawSteps, coverage, issues, evidenceIndex) {
  const byCategory = Object.fromEntries(MODEL_FIXED_CATEGORIES.map((category) => [category, []]));
  const items = new Map();
  const malformed = [];
  if (!Array.isArray(rawSteps)) {
    addIssue(issues, "modelFixedSteps 不是数组");
    return { ready: false, items: [], byCategory, missing: ["modelFixedSteps"] };
  }

  rawSteps.forEach((raw, index) => {
    if (!isRecord(raw)) {
      malformed.push(`modelFixedSteps[${index}]`);
      return;
    }
    const category = text(raw.category);
    const evidence = readEvidence(raw.evidence);
    const key = fixedStepKey(raw);
    evidenceIndex.add(evidence, key);
    if (!category || !MODEL_FIXED_CATEGORIES.includes(category) || !evidence || key.startsWith("invalid:")) {
      malformed.push(`modelFixedSteps[${index}]`);
      return;
    }
    const signature = category;
    const existing = items.get(key);
    if (existing && existing.signature !== signature) {
      malformed.push(`modelFixedSteps[${index}]`);
      return;
    }
    if (!existing) {
      items.set(key, {
        key,
        category,
        eventId: text(raw.eventId),
        traceId: text(raw.traceId),
        callId: text(raw.callId),
        evidence,
        signature,
      });
    }
  });

  for (const field of malformed) addIssue(issues, `${field} 缺失、无效或冲突`);
  for (const item of [...items.values()].sort((left, right) => compareText(left.key, right.key))) {
    byCategory[item.category].push(item.key);
  }
  for (const category of MODEL_FIXED_CATEGORIES) byCategory[category].sort(compareText);
  const measuredSteps = [...items.values()].sort((left, right) => compareText(left.key, right.key));
  return {
    ready: coverage.complete && malformed.length === 0,
    items: measuredSteps,
    byCategory,
    missing: [...coverage.missing, ...malformed],
  };
}

function processFiles(rawFiles, coverage, issues, evidenceIndex) {
  const items = new Map();
  const records = [];
  const malformed = [];
  if (!Array.isArray(rawFiles)) {
    addIssue(issues, "files 不是数组");
    return { ready: false, records: [], missing: ["files"] };
  }

  rawFiles.forEach((raw, index) => {
    if (!isRecord(raw)) {
      malformed.push(`files[${index}]`);
      return;
    }
    const path = text(raw.path);
    const category = text(raw.category);
    const kind = text(raw.kind);
    const producer = readActor(raw.producer) ?? null;
    const evidence = readEvidence(raw.evidence);
    evidenceIndex.add(evidence, path ?? `files[${index}]`);
    if (
      !path ||
      !category ||
      !FILE_CATEGORIES.has(category) ||
      !kind ||
      !evidence
    ) {
      malformed.push(`files[${index}]`);
      return;
    }
    const record = { path, category, kind, producer, evidence };
    const signature = JSON.stringify({ path, category, kind });
    const existing = items.get(path);
    if (existing && existing.signature !== signature) {
      malformed.push(`files[${index}].path`);
      return;
    }
    if (!existing) {
      items.set(path, { ...record, signature });
      records.push(record);
    }
  });

  for (const field of malformed) addIssue(issues, `${field} 缺失、无效或冲突`);
  return {
    ready: coverage.complete && malformed.length === 0,
    records: records.sort((left, right) => compareText(left.path, right.path)),
    missing: [...coverage.missing, ...malformed],
  };
}

function fileDimension(ready, records, category, missing) {
  const matching = records.filter((item) => item.category === category);
  const kinds = [...new Set(matching.map((item) => item.kind))].sort(compareText);
  return ready
    ? measured(kinds.length, { kinds, items: matching })
    : unknown(missing, { kinds, items: matching });
}

/**
 * 统计一份已经规范化的实际运行摘录。
 *
 * `handoffs`、`modelFixedSteps` 与 `files` 都必须由采样适配器从原始事件和文件
 * 清单生成。函数不根据工具名猜另一端身份，也不把未知覆盖范围补成 0。
 */
export function measureStructure(input) {
  const issues = [];
  const evidenceIndex = createEvidenceIndex();
  const coverageInput = isRecord(input?.coverage) ? input.coverage : {};
  const handoffCoverage = readCoverage(coverageInput, "handoffs", issues);
  const fixedCoverage = readCoverage(coverageInput, "modelFixedSteps", issues);
  const fileCoverage = readCoverage(coverageInput, "files", issues);
  for (const coverage of [handoffCoverage, fixedCoverage, fileCoverage]) {
    evidenceIndex.add(coverage.evidence, "coverage");
  }

  const handoffs = processHandoffs(input?.handoffs, issues, evidenceIndex);
  const handoffReady = handoffCoverage.complete && handoffs.malformed.length === 0;
  const handoffMissing = [...handoffCoverage.missing, ...handoffs.malformed];
  const crossRole = boundaryDimension(
    handoffReady,
    handoffs.records,
    (item) => item.sender.role !== item.receiver.role,
    handoffMissing,
  );
  const crossProcess = boundaryDimension(
    handoffReady,
    handoffs.records,
    (item) => item.sender.pid !== item.receiver.pid,
    handoffMissing,
  );
  const boundaryKeys = [
    ...new Set([
      ...(crossRole.eventKeys ?? []),
      ...(crossProcess.eventKeys ?? []),
    ]),
  ].sort(compareText);
  const deduplicatedTotal = handoffReady
    ? measured(boundaryKeys.length, { eventKeys: boundaryKeys })
    : unknown(handoffMissing, { eventKeys: boundaryKeys });

  const retries = handoffReady
    ? measured(handoffs.records.filter((item) => item.retry).length, {
        eventKeys: handoffs.records.filter((item) => item.retry).map((item) => item.key),
      })
    : unknown(handoffMissing);
  const mapRecalls = handoffReady
    ? measured(handoffs.records.filter((item) => item.mapRecall).length, {
        eventKeys: handoffs.records.filter((item) => item.mapRecall).map((item) => item.key),
      })
    : unknown(handoffMissing);

  const fixed = processModelFixedSteps(
    input?.modelFixedSteps,
    fixedCoverage,
    issues,
    evidenceIndex,
  );
  const modelFixedSteps = fixed.ready
    ? measured(fixed.items.length, {
        byCategory: fixed.byCategory,
        eventKeys: fixed.items.map((item) => item.key),
      })
    : unknown([...fixedCoverage.missing, "modelFixedSteps[]"], {
        byCategory: fixed.byCategory,
        eventKeys: fixed.items.map((item) => item.key),
      });

  const files = processFiles(input?.files, fileCoverage, issues, evidenceIndex);
  const state = fileDimension(files.ready, files.records, "state", files.missing);
  const immutableInputs = fileDimension(files.ready, files.records, "input", files.missing);
  const configuration = fileDimension(files.ready, files.records, "config", files.missing);
  const rawEvidenceFiles = fileDimension(
    files.ready,
    files.records,
    "raw_evidence",
    files.missing,
  );
  const derivedViews = fileDimension(files.ready, files.records, "derived", files.missing);
  const businessResults = fileDimension(
    files.ready,
    files.records,
    "business_result",
    files.missing,
  );
  const unclassified = fileDimension(files.ready, files.records, "unknown", files.missing);
  if (files.ready && unclassified.items.length > 0) {
    unclassified.status = "unknown";
    unclassified.value = null;
    unclassified.missing = ["files[].category 分类不明"];
  }

  return {
    schema: "pao-g2-structure-measurement-v1",
    sourceCoverage: {
      handoffs: handoffCoverage,
      modelFixedSteps: fixedCoverage,
      files: fileCoverage,
    },
    boundaries: {
      crossRole,
      crossProcess,
      deduplicatedTotal,
      handoffs: handoffs.records.map((item) => ({
        key: item.key,
        sender: item.sender,
        receiver: item.receiver,
        operation: item.operation,
        businessObject: item.businessObject,
        callId: item.callId ?? null,
        retry: item.retry,
        mapRecall: item.mapRecall,
        evidence: item.evidence,
      })),
    },
    retries,
    mapRecalls,
    modelFixedSteps,
    fileKinds: {
      state,
      immutableInputs,
      configuration,
      rawEvidence: rawEvidenceFiles,
      derivedViews,
      businessResults,
      unclassified,
    },
    rawEvidence: evidenceIndex.list(),
    issues: [...new Set(issues)].sort(compareText),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write("用法：node measure-structure.mjs <规范化输入.json>\n");
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(readFileSync(inputPath, "utf8"));
      process.stdout.write(`${JSON.stringify(measureStructure(input), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
