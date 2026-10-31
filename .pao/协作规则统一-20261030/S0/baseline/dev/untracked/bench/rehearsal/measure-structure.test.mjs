import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";
import { measureStructure } from "./measure-structure.mjs";

// 以下事件和文件记录均为协议模拟，不是真实模型或真实彩排结果。
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "measure-structure.mjs");
const FIXTURE_PARENT =
  "D:\\AI\\workspace\\临时文件夹\\深度审核重整-20261028\\g2-measure-structure";
const cases = [];

mkdirSync(FIXTURE_PARENT, { recursive: true });
afterEach(() => {
  for (const path of cases.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});
after(() => {
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(FIXTURE_PARENT, "case-"));
  cases.push(root);
  return root;
}

function evidence(line = 1) {
  return { path: "raw/events.jsonl", line };
}

function coverage(line = 1) {
  return {
    handoffs: { complete: true, evidence: evidence(line) },
    modelFixedSteps: { complete: true, evidence: evidence(line + 1) },
    files: { complete: true, evidence: evidence(line + 2) },
  };
}

function handoff(overrides = {}) {
  return {
    kind: "tool_handoff",
    eventId: "event-default",
    sender: { role: "main", pid: 100 },
    receiver: { role: "minister", pid: 200 },
    operation: { kind: "tool", name: "pao_submit_receipt" },
    businessObject: { type: "card", id: "card-1" },
    callId: "call-1",
    evidence: evidence(),
    ...overrides,
  };
}

function fileRecord(overrides = {}) {
  return {
    path: "state/control.json",
    category: "state",
    kind: "control-json",
    producer: { role: "minister", pid: 200 },
    evidence: evidence(10),
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    schemaVersion: 1,
    coverage: coverage(),
    handoffs: [],
    modelFixedSteps: [],
    files: [],
    ...overrides,
  };
}

test("模拟：同角色跨进程与跨角色同进程分别计数，去重总量取并集", () => {
  const result = measureStructure(
    input({
      handoffs: [
        handoff({
          eventId: "cross-role-only",
          sender: { role: "main", pid: 10 },
          receiver: { role: "minister", pid: 10 },
        }),
        handoff({
          eventId: "cross-process-only",
          sender: { role: "main", pid: 10 },
          receiver: { role: "main", pid: 20 },
        }),
      ],
    }),
  );

  assert.equal(result.boundaries.crossRole.value, 1);
  assert.equal(result.boundaries.crossProcess.value, 1);
  assert.equal(result.boundaries.deduplicatedTotal.value, 2);
});

test("模拟：同一业务事件同时跨角色和跨进程只计一次，重复记录不按工具名重复计数", () => {
  const same = handoff({
    eventId: "both-boundaries",
    sender: { role: "minister", pid: 100 },
    receiver: { role: "worker", pid: 200 },
  });
  const result = measureStructure(input({ handoffs: [same, structuredClone(same)] }));

  assert.equal(result.boundaries.crossRole.value, 1);
  assert.equal(result.boundaries.crossProcess.value, 1);
  assert.equal(result.boundaries.deduplicatedTotal.value, 1);
});

test("模拟：同工具不同业务对象保留为不同交接", () => {
  const result = measureStructure(
    input({
      handoffs: [
        handoff({ eventId: "card-a", businessObject: { type: "card", id: "card-a" } }),
        handoff({ eventId: "card-b", businessObject: { type: "card", id: "card-b" } }),
      ],
    }),
  );

  assert.equal(result.boundaries.deduplicatedTotal.value, 2);
  assert.deepEqual(
    result.boundaries.handoffs.map((item) => item.businessObject.id),
    ["card-a", "card-b"],
  );
});

test("模拟：重试和地图召回单列，同时仍计入业务交接", () => {
  const result = measureStructure(
    input({
      handoffs: [
        handoff({ eventId: "retry-1", retryOf: "call-0" }),
        handoff({ eventId: "map-recall-1", mapRecall: true }),
      ],
    }),
  );

  assert.equal(result.boundaries.deduplicatedTotal.value, 2);
  assert.deepEqual(result.retries.eventKeys, ["event:retry-1"]);
  assert.deepEqual(result.mapRecalls.eventKeys, ["event:map-recall-1"]);
});

test("模拟：重复事件冲突可见并令边界计数为 unknown，不采用最后一条覆盖", () => {
  const result = measureStructure(
    input({
      handoffs: [
        handoff({ eventId: "conflict", businessObject: { type: "card", id: "card-a" } }),
        handoff({ eventId: "conflict", businessObject: { type: "card", id: "card-b" } }),
      ],
    }),
  );

  assert.equal(result.boundaries.crossRole.status, "unknown");
  assert.equal(result.boundaries.deduplicatedTotal.value, null);
  assert.match(result.issues.join("\n"), /冲突/);
});

test("模拟：缺真实 actor 身份时跨角色和跨进程均为 unknown", () => {
  const invalid = handoff({ eventId: "missing-role", receiver: { pid: 200 } });
  const result = measureStructure(input({ handoffs: [invalid] }));

  assert.equal(result.boundaries.crossRole.status, "unknown");
  assert.equal(result.boundaries.crossProcess.status, "unknown");
  assert.equal(result.boundaries.crossRole.value, null);
  assert.match(result.issues.join("\n"), /receiver/);
});

test("模拟：模型 HTTP 与纯遥测不进入业务交接", () => {
  const result = measureStructure(
    input({
      handoffs: [
        { kind: "model_http", evidence: evidence(20) },
        { kind: "telemetry", evidence: evidence(21) },
      ],
    }),
  );

  assert.equal(result.boundaries.deduplicatedTotal.status, "measured");
  assert.equal(result.boundaries.deduplicatedTotal.value, 0);
  assert.equal(result.boundaries.handoffs.length, 0);
});

test("模拟：模型固定手续按六类计数并去重", () => {
  const categories = ["启流", "抄身份", "验收", "交付", "交卷", "推流"];
  const steps = categories.map((category, index) => ({
    callId: `fixed-${index}`,
    category,
    evidence: evidence(30 + index),
  }));
  steps.push({ ...steps[0] });
  const result = measureStructure(input({ modelFixedSteps: steps }));

  assert.equal(result.modelFixedSteps.value, 6);
  for (const category of categories) {
    assert.equal(result.modelFixedSteps.byCategory[category].length, 1);
  }
});

test("模拟：文件清单分列状态、不可变输入、原始证据和派生视图，状态种类去重", () => {
  const result = measureStructure(
    input({
      files: [
        fileRecord(),
        fileRecord({ path: "state/control-copy.json" }),
        fileRecord({ path: "state/card.md", kind: "card-markdown" }),
        fileRecord({ path: "input/kit.json", category: "input", kind: "kit-json" }),
        fileRecord({ path: "raw/tool.jsonl", category: "raw_evidence", kind: "jsonl" }),
        fileRecord({ path: "views/status.md", category: "derived", kind: "status-markdown" }),
      ],
    }),
  );

  assert.equal(result.fileKinds.state.value, 2);
  assert.deepEqual(result.fileKinds.state.kinds, ["card-markdown", "control-json"]);
  assert.deepEqual(result.fileKinds.immutableInputs.kinds, ["kit-json"]);
  assert.deepEqual(result.fileKinds.rawEvidence.kinds, ["jsonl"]);
  assert.deepEqual(result.fileKinds.derivedViews.kinds, ["status-markdown"]);
});

test("模拟：普通配置和业务成果使用独立语义类别，不并入 state 或 input", () => {
  const result = measureStructure(
    input({
      files: [
        fileRecord({
          path: "config/runtime.json",
          category: "config",
          kind: "runtime-config",
        }),
        fileRecord({
          path: "config/recipe.md",
          category: "config",
          kind: "workflow-recipe",
        }),
        fileRecord({
          path: "project/业务/结果.txt",
          category: "business_result",
          kind: "business-result",
        }),
      ],
    }),
  );

  assert.equal(result.fileKinds.state.value, 0);
  assert.equal(result.fileKinds.immutableInputs.value, 0);
  assert.equal(result.fileKinds.configuration.value, 2);
  assert.deepEqual(result.fileKinds.configuration.kinds, [
    "runtime-config",
    "workflow-recipe",
  ]);
  assert.equal(result.fileKinds.businessResults.value, 1);
  assert.deepEqual(result.fileKinds.businessResults.kinds, ["business-result"]);
  assert.equal(result.fileKinds.unclassified.value, 0);
});

test("模拟：producer 未知不阻断文件种类计数，证据和分类仍保留", () => {
  const result = measureStructure(
    input({
      files: [
        fileRecord({ path: "state/control.json", producer: null }),
        fileRecord({
          path: "state/card.md",
          kind: "card-markdown",
          producer: { role: "worker" },
        }),
      ],
    }),
  );

  assert.equal(result.fileKinds.state.status, "measured");
  assert.equal(result.fileKinds.state.value, 2);
  assert.deepEqual(result.fileKinds.state.kinds, ["card-markdown", "control-json"]);
  assert.ok(result.fileKinds.state.items.every((item) => item.producer === null));
});

test("模拟：分类不明的文件保留在 unknown，不污染已知类别也不补成 state", () => {
  const result = measureStructure(
    input({
      files: [
        fileRecord({ path: "state/control.json", producer: null }),
        fileRecord({
          path: "project/业务/结果.txt",
          category: "unknown",
          kind: "business-io",
          producer: null,
        }),
      ],
    }),
  );

  assert.equal(result.fileKinds.state.status, "measured");
  assert.equal(result.fileKinds.state.value, 1);
  assert.equal(result.fileKinds.unclassified.status, "unknown");
  assert.equal(result.fileKinds.unclassified.value, null);
  assert.deepEqual(result.fileKinds.unclassified.kinds, ["business-io"]);
  assert.deepEqual(result.fileKinds.unclassified.missing, ["files[].category 分类不明"]);
  assert.equal(result.fileKinds.state.items.some((item) => item.category === "unknown"), false);
});

test("模拟：文件类别非法或同路径分类冲突时文件统计仍为 unknown", () => {
  const invalid = measureStructure(
    input({
      files: [fileRecord({ category: "invented-category" })],
    }),
  );
  assert.equal(invalid.fileKinds.state.status, "unknown");
  assert.match(invalid.issues.join("\n"), /files\[0\]/);

  const conflict = measureStructure(
    input({
      files: [
        fileRecord({ path: "state/shared.json", kind: "control-json" }),
        fileRecord({ path: "state/shared.json", kind: "card-markdown" }),
      ],
    }),
  );
  assert.equal(conflict.fileKinds.state.status, "unknown");
  assert.match(conflict.issues.join("\n"), /files\[1\]\.path/);
});

test("模拟：覆盖证据缺失时所有指标为 unknown，空集合也不默认成 0", () => {
  const result = measureStructure({
    schemaVersion: 1,
    coverage: {},
    handoffs: [],
    modelFixedSteps: [],
    files: [],
  });

  assert.equal(result.boundaries.deduplicatedTotal.status, "unknown");
  assert.equal(result.boundaries.deduplicatedTotal.value, null);
  assert.equal(result.modelFixedSteps.status, "unknown");
  assert.equal(result.modelFixedSteps.value, null);
  assert.equal(result.fileKinds.state.status, "unknown");
  assert.equal(result.fileKinds.state.value, null);
  assert.match(result.issues.join("\n"), /coverage\.handoffs/);
  assert.match(result.issues.join("\n"), /coverage\.files/);
});

test("模拟：新旧 schemaVersion 的同格式输入走同一算法", () => {
  const base = input({
    handoffs: [handoff({ eventId: "same-input" })],
    modelFixedSteps: [{ callId: "fixed-same", category: "交付", evidence: evidence(50) }],
    files: [fileRecord()],
  });
  const oldInput = { ...structuredClone(base), schemaVersion: 1 };
  const newInput = { ...structuredClone(base), schemaVersion: 99 };

  assert.deepEqual(measureStructure(oldInput), measureStructure(newInput));
});

test("命令行从工作区夹具读取 JSON 并输出同一结果", () => {
  const root = fixtureRoot();
  const inputPath = join(root, "measure-input.json");
  writeFileSync(inputPath, `${JSON.stringify(input({ handoffs: [handoff()] }), null, 2)}\n`);
  const child = spawnSync(process.execPath, [SCRIPT, inputPath], {
    cwd: resolve(HERE, "../.."),
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.boundaries.deduplicatedTotal.value, 1);
});
