import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";
import { collectStructure } from "./collect-structure.mjs";

// 以下夹具均为协议模拟，不是真实模型或真实彩排结果。
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "collect-structure.mjs");
const FIXTURE_PARENT =
  "D:\\AI\\workspace\\pao-dev\\.pao\\深度审核重整-20261028\\G2-计数器\\fixtures\\collect-structure";
const cases = [];

mkdirSync(FIXTURE_PARENT, { recursive: true });
afterEach(() => {
  for (const path of cases.splice(0)) rmSync(path, { recursive: true, force: true });
});
after(() => {
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(FIXTURE_PARENT, "case-"));
  cases.push(root);
  return root;
}

function write(path, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function jsonl(path, values) {
  write(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function activation(role, pid, sessionId, at, parentPid = null) {
  return {
    role,
    pid,
    parent_pid: parentPid,
    session_id: sessionId,
    activated: [],
    active: [],
    registered: [],
    required_registered: [],
    at,
  };
}

function createRun({
  root = fixtureRoot(),
  executionId = "run-1",
  cardNo = "卡0001",
  attempt = 1,
  mainPid = 100,
  workerPid = 200,
  withWorker = true,
  withReceipt = false,
  receiptError = false,
  receiptUnfinished = false,
  evidenceMismatch = false,
} = {}) {
  const project = join(root, "project");
  const pao = join(project, ".pao");
  const cardPath = join(pao, "卡", `${cardNo}-演示卡.md`);
  const workerEvidencePath = join(
    pao,
    "worker-evidence",
    `${cardNo}-尝试${attempt}-${executionId}.live.jsonl`,
  );
  const workerSessionPath = join(pao, "worker会话", `session-${executionId}.jsonl`);
  const time = "2026-10-30T00:00:01.000Z";
  jsonl(join(root, "evidence", "tool-activation.jsonl"), [
    activation("main", mainPid, "main-session", "2026-10-30T00:00:00.000Z", 1),
    activation("worker", workerPid, executionId, time, mainPid),
  ]);
  write(
    join(root, "evidence", "run.json"),
    `${JSON.stringify({
      ok: true,
      runRoot: root,
      syntheticUsage: true,
      syntheticUsageNote: "协议模拟用量",
    })}\n`,
  );
  write(
    join(pao, "工作流实例-演示流水线.md"),
    `---\n版本: 2\n实例: instance-1\nowner: main-session\n状态: 已完成\n---\n`,
  );
  const cardReceipt = withReceipt
    ? [
        "",
        `## 回执 尝试${attempt}`,
        "- result: success",
        `- evidence: ${JSON.stringify([workerEvidencePath])}`,
        `- usage: ${JSON.stringify({ run_id: executionId })}`,
        "",
      ].join("\n")
    : "";
  write(cardPath, `---\nattempt: ${attempt}\n---\n${cardReceipt}`);
  jsonl(join(pao, "派发日志.jsonl"), [
    {
      type: "pao_worker_process",
      event: "prepare",
      执行标识: executionId,
      卡路径: cardPath,
      尝试: attempt,
      父进程: mainPid,
    },
    {
      type: "pao_worker_process",
      event: "spawn-request",
      执行标识: executionId,
      卡路径: cardPath,
      尝试: attempt,
      父进程: mainPid,
    },
    {
      type: "pao_worker_process",
      event: "spawn",
      执行标识: executionId,
      卡路径: cardPath,
      尝试: attempt,
      执行根: project,
      父进程: mainPid,
      pid: workerPid,
      部门: "实施",
    },
    {
      type: "pao_worker_process",
      event: "exit",
      执行标识: executionId,
      pid: workerPid,
      exitCode: 0,
    },
  ]);
  jsonl(join(pao, "执行映射", `${executionId}.jsonl`), [
    {
      任务根: project,
      卡路径: cardPath,
      尝试: attempt,
      执行标识: executionId,
      executionRoot: project,
      ownerPid: mainPid,
      状态: "启动",
    },
    {
      pid: workerPid,
      任务根: project,
      卡路径: cardPath,
      尝试: attempt,
      执行标识: executionId,
      executionRoot: project,
      ownerPid: mainPid,
      状态: "运行中",
    },
    {
      pid: workerPid,
      exitCode: 0,
      会话路径: workerSessionPath,
      证据路径: workerEvidencePath,
      任务根: project,
      卡路径: cardPath,
      尝试: attempt,
      执行标识: executionId,
      executionRoot: project,
      ownerPid: mainPid,
      状态: "success",
    },
  ]);
  write(
    workerSessionPath,
    `${JSON.stringify({
      type: "session",
      id: executionId,
      timestamp: time,
    })}\n`,
  );
  if (withWorker) {
    const values = [
      {
        type: "pao_worker_live",
        卡号: cardNo.slice(2),
        卡路径: evidenceMismatch ? join(pao, "卡", "卡9999-错配.md") : cardPath,
        尝试: attempt,
        执行标识: executionId,
        pid: workerPid,
      },
    ];
    if (withReceipt) {
      values.push({
        type: "tool_execution_start",
        toolCallId: `receipt-${executionId}`,
        toolName: "pao_submit_receipt",
        args: {
          result: "success",
          artifact_path: [],
          summary: "协议模拟回执",
        },
      });
      if (!receiptUnfinished) {
        values.push({
          type: "tool_execution_end",
          toolCallId: `receipt-${executionId}`,
          toolName: "pao_submit_receipt",
          result: { content: [{ type: "text", text: "已提交" }] },
          isError: receiptError,
        });
      }
    }
    values.push({
        type: "pao_worker_evidence",
        卡号: cardNo.slice(2),
        卡路径: evidenceMismatch ? join(pao, "卡", "卡9999-错配.md") : cardPath,
        尝试: attempt,
        执行标识: executionId,
        exitCode: 0,
    });
    jsonl(workerEvidencePath, values);
  }
  return {
    root,
    project,
    pao,
    executionId,
    cardPath,
    workerPid,
    mainPid,
    workerEvidencePath,
    workerSessionPath,
  };
}

function addSession(root, { id, firstTool, calls, results }) {
  const path = join(root, "sessions", `${id}.jsonl`);
  const values = [
    { type: "session", id, timestamp: "2026-10-30T00:00:00.000Z" },
    ...calls.map((call, index) => ({
      type: "message",
      timestamp: call.at ?? `2026-10-30T00:00:0${index + 1}.100Z`,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: call.id,
            name: call.name ?? firstTool,
            arguments: call.arguments ?? {},
          },
        ],
      },
    })),
    ...results.map((result) => ({
      type: "message",
      timestamp: result.at ?? "2026-10-30T00:00:09.000Z",
      message: {
        role: "toolResult",
        toolCallId: result.id,
        toolName: result.name ?? firstTool,
        isError: result.isError ?? false,
      },
    })),
  ];
  jsonl(path, values);
  return path;
}

function writeRichSession(path, id, entries) {
  const values = [{ type: "session", id, timestamp: "2026-10-30T00:00:00.000Z" }];
  for (const entry of entries) {
    if (entry.user) {
      values.push({
        type: "message",
        timestamp: entry.at,
        message: { role: "user", content: entry.user },
      });
    } else if (entry.call) {
      values.push({
        type: "message",
        timestamp: entry.at,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", ...entry.call }],
        },
      });
    } else if (entry.result) {
      values.push({
        type: "message",
        timestamp: entry.at,
        message: {
          role: "toolResult",
          toolCallId: entry.result.id,
          toolName: entry.result.name,
          isError: entry.result.isError ?? false,
          content: entry.result.content ?? "",
        },
      });
    }
  }
  jsonl(path, values);
}

function createFullChainRun() {
  const fixture = createRun({ withReceipt: true });
  const instance = "instance-1";
  const sessionsRoot = join(fixture.pao, "部长会话", instance);
  const scoutSession = "scout-session";
  const planSession = "plan-session";
  const implSession = "impl-session";
  const reviewSession = "review-session";
  const scoutPid = 300;
  const planPid = 301;
  const implPid = 302;
  const reviewOldPid = 303;
  const reviewNewPid = 304;

  jsonl(join(fixture.root, "evidence", "tool-activation.jsonl"), [
    activation("main", fixture.mainPid, "main-session", "2026-10-30T00:00:00.000Z", 1),
    activation("worker", fixture.workerPid, fixture.executionId, "2026-10-30T00:00:01.000Z", fixture.mainPid),
    activation("minister", scoutPid, scoutSession, "2026-10-30T00:00:02.000Z", fixture.mainPid),
    activation("minister", planPid, planSession, "2026-10-30T00:00:03.000Z", fixture.mainPid),
    activation("minister", implPid, implSession, "2026-10-30T00:00:04.000Z", fixture.mainPid),
    activation("minister", reviewOldPid, reviewSession, "2026-10-30T00:00:10.000Z", fixture.mainPid),
    activation("minister", reviewNewPid, reviewSession, "2026-10-30T00:00:21.000Z", fixture.mainPid),
  ]);
  jsonl(join(fixture.root, "pao-home", "部门", "审查", "监督审计.jsonl"), [
    {
      时间: "2026-10-30T00:00:20.500Z",
      动作: "散场",
      目标: `部长会话〔审核@project〕(pid ${reviewOldPid},会话 ${reviewSession})`,
      原因: "协议模拟节点重开",
    },
  ]);
  addSession(fixture.root, {
    id: "main-session",
    firstTool: "pao_start_flow",
    calls: [
      {
        id: "start-call",
        name: "pao_start_flow",
        arguments: { name: "模拟流水线" },
        at: "2026-10-30T00:00:01.100Z",
      },
      {
        id: "query-call",
        name: "pao_query_flow",
        arguments: { instance, card: "卡0001" },
        at: "2026-10-30T00:00:02.100Z",
      },
    ],
    results: [
      { id: "start-call", name: "pao_start_flow", content: "已受理" },
      { id: "query-call", name: "pao_query_flow", content: "running" },
    ],
  });
  writeRichSession(join(sessionsRoot, "scout.jsonl"), scoutSession, [
    {
      at: "2026-10-30T00:00:02.100Z",
      user: `实例:${instance}\n节点:侦察\n轮次:1\n目标:侦察`,
    },
    {
      at: "2026-10-30T00:00:02.200Z",
      call: { id: "scout-map", name: "pao_minister_save_node_map", arguments: {} },
    },
    {
      at: "2026-10-30T00:00:02.300Z",
      result: {
        id: "scout-map",
        name: "pao_minister_save_node_map",
        content: "pao-map://map-scout",
      },
    },
    {
      at: "2026-10-30T00:00:02.400Z",
      call: { id: "scout-done", name: "pao_breakdown_done", arguments: {} },
    },
    {
      at: "2026-10-30T00:00:02.500Z",
      result: { id: "scout-done", name: "pao_breakdown_done", content: "已结束" },
    },
  ]);
  writeRichSession(join(sessionsRoot, "plan.jsonl"), planSession, [
    {
      at: "2026-10-30T00:00:03.100Z",
      user: `实例:${instance}\n节点:规划\n轮次:1\n目标:规划`,
    },
    {
      at: "2026-10-30T00:00:03.200Z",
      call: { id: "plan-map", name: "pao_minister_save_node_map", arguments: {} },
    },
    {
      at: "2026-10-30T00:00:03.300Z",
      result: {
        id: "plan-map",
        name: "pao_minister_save_node_map",
        content: "pao-map://map-plan",
      },
    },
    {
      at: "2026-10-30T00:00:03.400Z",
      call: { id: "plan-done", name: "pao_breakdown_done", arguments: {} },
    },
    {
      at: "2026-10-30T00:00:03.500Z",
      result: { id: "plan-done", name: "pao_breakdown_done", content: "已结束" },
    },
  ]);
  writeRichSession(join(sessionsRoot, "impl.jsonl"), implSession, [
    {
      at: "2026-10-30T00:00:04.100Z",
      user: `实例:${instance}\n节点:实施\n轮次:1\n目标:实施`,
    },
    {
      at: "2026-10-30T00:00:04.200Z",
      call: { id: "impl-cards", name: "pao_minister_submit_cards", arguments: { cards: [] } },
    },
    {
      at: "2026-10-30T00:00:04.300Z",
      result: {
        id: "impl-cards",
        name: "pao_minister_submit_cards",
        content: "已排队:卡0001、卡0002",
      },
    },
    {
      at: "2026-10-30T00:00:04.400Z",
      call: { id: "impl-done", name: "pao_breakdown_done", arguments: {} },
    },
    {
      at: "2026-10-30T00:00:04.500Z",
      result: { id: "impl-done", name: "pao_breakdown_done", content: "已结束" },
    },
    {
      at: "2026-10-30T00:00:08.000Z",
      user: "工作流 worker 结果：模拟/实施 第1轮\n卡：卡0001；尝试：1；结果：success",
    },
    {
      at: "2026-10-30T00:00:09.000Z",
      user: "工作流 worker 结果：模拟/实施 第1轮\n卡：卡0002；尝试：1；结果：success",
    },
  ]);
  writeRichSession(join(sessionsRoot, "review.jsonl"), reviewSession, [
    {
      at: "2026-10-30T00:00:10.100Z",
      user: `实例:${instance}\n节点:审核\n轮次:1\n目标:审核`,
    },
    {
      at: "2026-10-30T00:00:10.200Z",
      call: { id: "review-map-failed", name: "pao_minister_save_node_map", arguments: {} },
    },
    {
      at: "2026-10-30T00:00:10.300Z",
      result: {
        id: "review-map-failed",
        name: "pao_minister_save_node_map",
        isError: true,
        content: "地图失败",
      },
    },
    {
      at: "2026-10-30T00:00:11.000Z",
      call: { id: "review-cards", name: "pao_minister_submit_cards", arguments: { cards: [] } },
    },
    {
      at: "2026-10-30T00:00:11.100Z",
      result: {
        id: "review-cards",
        name: "pao_minister_submit_cards",
        content: "已排队:卡0003",
      },
    },
    {
      at: "2026-10-30T00:00:12.000Z",
      call: { id: "review-done", name: "pao_breakdown_done", arguments: {} },
    },
    {
      at: "2026-10-30T00:00:12.100Z",
      result: { id: "review-done", name: "pao_breakdown_done", content: "已结束" },
    },
    {
      at: "2026-10-30T00:00:14.000Z",
      user: "工作流 worker 结果：模拟/审核 第1轮\n卡：卡0003；尝试：1；结果：success",
    },
    {
      at: "2026-10-30T00:00:22.000Z",
      user: `实例:${instance}\n节点:审核\n轮次:1\n全部卡已经执行，请提交最终判定`,
    },
    {
      at: "2026-10-30T00:00:23.000Z",
      call: {
        id: "review-decision",
        name: "pao_submit_decision",
        arguments: { result: "pass", reason: "独立判断" },
      },
    },
    {
      at: "2026-10-30T00:00:23.100Z",
      result: { id: "review-decision", name: "pao_submit_decision", content: "已记录" },
    },
  ]);

  return {
    ...fixture,
    instance,
    reviewSession,
    reviewOldPid,
    reviewNewPid,
  };
}

test("模拟：同一 spawn 的 prepare/request/exit 生命周期只产生一条业务交接", () => {
  const fixture = createRun();
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(output.candidates.handoffs.length, 1);
  assert.deepEqual(output.candidates.handoffs[0].sender, { role: "main", pid: 100 });
  assert.deepEqual(output.candidates.handoffs[0].receiver, { role: "worker", pid: 200 });
  assert.equal(output.candidates.handoffs[0].lifecycleEvents.length, 4);
  assert.equal(output.input.handoffs.length, 1);
  assert.equal(output.measurement.boundaries.deduplicatedTotal.status, "unknown");
});

test("模拟：同工具不同卡保留为不同业务交接，不能按工具名合并", () => {
  const first = createRun();
  const second = createRun({
    root: fixtureRoot(),
    executionId: "run-2",
    cardNo: "卡0002",
    workerPid: 201,
  });
  const files = new Map();
  const firstDispatch = join(first.pao, "派发日志.jsonl");
  const secondDispatch = join(second.pao, "派发日志.jsonl");
  files.set(
    firstDispatch,
    [
      ...readLines(firstDispatch),
      ...readLines(secondDispatch).map((line) => {
        const value = JSON.parse(line);
        if (typeof value["卡路径"] === "string") {
          value["卡路径"] = value["卡路径"].replace(second.root, first.root);
        }
        return JSON.stringify(value);
      }),
    ],
  );
  write(firstDispatch, `${files.get(firstDispatch).join("\n")}\n`);
  write(
    join(first.pao, "执行映射", "run-2.jsonl"),
    rewriteJsonlPaths(join(second.pao, "执行映射", "run-2.jsonl"), second.root, first.root),
  );
  write(
    join(first.root, "evidence", "tool-activation.jsonl"),
    `${readFileText(join(first.root, "evidence", "tool-activation.jsonl")).trim()}\n${JSON.stringify(
      activation("worker", 201, "run-2", "2026-10-30T00:00:01.000Z", 100),
    )}\n`,
  );
  write(
    join(first.pao, "worker-evidence", "卡0002-尝试1-run-2.live.jsonl"),
    rewriteJsonlPaths(
      join(second.pao, "worker-evidence", "卡0002-尝试1-run-2.live.jsonl"),
      second.root,
      first.root,
    ),
  );
  write(
    join(first.pao, "worker会话", "session-run-2.jsonl"),
    readFileText(join(second.pao, "worker会话", "session-run-2.jsonl")),
  );

  const output = collectStructure({ runRoot: first.root });
  assert.equal(output.candidates.handoffs.length, 2, JSON.stringify(output.unknown));
  assert.equal(
    new Set(output.candidates.handoffs.map((item) => item.businessObject.id)).size,
    2,
  );
  assert.equal(
    new Set(output.candidates.handoffs.map((item) => item.operation.name)).size,
    1,
  );
});

test("模拟：重复上下文的同一 toolCallId 只计一次，不同卡保留不同固定手续", () => {
  const fixture = createRun();
  const calls = [
    {
      id: "call-a",
      name: "pao_change_status",
      arguments: { card_id: "卡0001", new_status: "delivered" },
    },
    {
      id: "call-a",
      name: "pao_change_status",
      arguments: { card_id: "卡0001", new_status: "delivered" },
    },
    {
      id: "call-b",
      name: "pao_change_status",
      arguments: { card_id: "卡0002", new_status: "delivered" },
    },
  ];
  addSession(fixture.root, {
    id: "main-session",
    firstTool: "pao_change_status",
    calls,
    results: [
      { id: "call-a", name: "pao_change_status" },
      { id: "call-b", name: "pao_change_status" },
    ],
  });
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(output.candidates.modelFixedSteps.length, 2);
  assert.equal(
    new Set(output.candidates.modelFixedSteps.map((item) => item.businessObject.id)).size,
    2,
  );
  assert.equal(
    output.candidates.modelFixedSteps.filter((item) => item.callId === "call-a").length,
    1,
  );
});

test("模拟：未成功配对或失败的固定手续调用不计数", () => {
  const fixture = createRun();
  addSession(fixture.root, {
    id: "main-session",
    firstTool: "pao_start_flow",
    calls: [
      { id: "failed-start", name: "pao_start_flow", arguments: { name: "失败流" } },
      { id: "unfinished-start", name: "pao_start_flow", arguments: { name: "未结束流" } },
    ],
    results: [
      { id: "failed-start", name: "pao_start_flow", isError: true },
    ],
  });
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(output.candidates.modelFixedSteps.length, 0);
  assert.equal(
    output.observations.unclassifiedToolCalls.filter((item) =>
      item.missing?.includes("配对的 toolResult"),
    ).length,
    1,
  );
  assert.equal(
    output.observations.unclassifiedToolCalls.filter((item) =>
      item.missing?.includes("成功的 toolResult"),
    ).length,
    1,
  );
});

test("模拟：专业判断保留事件但不计入可消除固定手续", () => {
  const fixture = createRun();
  addSession(fixture.root, {
    id: "main-session",
    calls: [
      {
        id: "decision-call",
        name: "pao_submit_decision",
        arguments: {
          result: "pass",
          reason: "逐项核对证据后作出专业判断",
          references: ["业务/结果.txt:1"],
        },
      },
      {
        id: "review-call",
        name: "pao_minister_review_worker",
        arguments: {
          request_id: "review-1",
          card_ref: "卡0001",
          attempt: 1,
          result: "pass",
          basis: "逐项核对普通偏差",
        },
      },
    ],
    results: [
      { id: "decision-call", name: "pao_submit_decision" },
      { id: "review-call", name: "pao_minister_review_worker" },
    ],
  });
  const output = collectStructure({ runRoot: fixture.root });
  const excluded = output.observations.excludedJudgmentEvents;

  assert.equal(output.candidates.modelFixedSteps.length, 0);
  assert.equal(output.input.modelFixedSteps.length, 0);
  assert.equal(excluded.length, 2);
  assert.equal(
    excluded.find((item) => item.toolName === "pao_submit_decision")?.classification,
    "professional_judgment",
  );
  const review = excluded.find((item) => item.toolName === "pao_minister_review_worker");
  assert.equal(review?.classification, "professional_judgment");
  assert.deepEqual(review?.missing, []);
  assert.equal(
    output.unknown.some(
      (item) =>
        item.domain === "model_fixed_step_classification" &&
        item.missing.includes("客观审核类型字段"),
    ),
    false,
  );
});

test("模拟：身份字段本身不计抄身份，明确交付类别只计一次", () => {
  const fixture = createRun();
  addSession(fixture.root, {
    id: "main-session",
    firstTool: "pao_change_status",
    calls: [
      {
        id: "identity-only",
        name: "pao_change_status",
        arguments: {
          instance: "instance-1",
          node: "实施",
          round: 1,
          card: "卡0001",
          attempt: 1,
          request_id: "request-1",
        },
      },
      {
        id: "delivery-with-identity",
        name: "pao_change_status",
        arguments: {
          instance: "instance-1",
          node: "实施",
          round: 1,
          card: "卡0001",
          attempt: 1,
          request_id: "request-2",
          new_status: "delivered",
        },
      },
    ],
    results: [
      { id: "identity-only", name: "pao_change_status" },
      { id: "delivery-with-identity", name: "pao_change_status" },
    ],
  });
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(output.candidates.modelFixedSteps.length, 1);
  assert.equal(output.candidates.modelFixedSteps[0].category, "交付");
  assert.equal(output.measurement.modelFixedSteps.value, 1);
  assert.equal(output.measurement.modelFixedSteps.byCategory["交付"].length, 1);
  assert.equal(output.measurement.modelFixedSteps.byCategory["抄身份"].length, 0);
  assert.deepEqual(output.observations.identityCopyRule.currentToolMappings, []);
  assert.equal(
    output.observations.unclassifiedToolCalls.some(
      (item) => item.callId === "identity-only",
    ),
    true,
  );
});

test("模拟：worker 头尾身份错配时拒绝交接并给出精确缺证", () => {
  const fixture = createRun({ evidenceMismatch: true });
  const output = collectStructure({ runRoot: fixture.root });
  const workerUnknown = output.unknown.find((item) => item.domain === "worker_dispatch");

  assert.equal(output.candidates.handoffs.length, 0);
  assert.ok(workerUnknown);
  assert.ok(workerUnknown.missing.includes("worker header.卡路径"));
  assert.ok(workerUnknown.missing.includes("worker trailer.卡路径"));
});

test("模拟：没有 worker 证据时不从派发日志推断成功，明确 unknown", () => {
  const fixture = createRun({ withWorker: false });
  const output = collectStructure({ runRoot: fixture.root });
  const workerUnknown = output.unknown.find((item) => item.domain === "worker_dispatch");

  assert.equal(output.candidates.handoffs.length, 0);
  assert.ok(workerUnknown.missing.includes("证据路径存在"));
  assert.equal(output.measurement.boundaries.crossRole.value, null);
});

test("模拟：成功样本三条业务链按真实角色、PID、业务对象和源行采集", () => {
  const fixture = createFullChainRun();
  const output = collectStructure({ runRoot: fixture.root });
  const handoffs = output.candidates.handoffs;
  const workerReceipt = handoffs.find(
    (item) => item.operation.name === "worker.pao_submit_receipt",
  );
  const workerSpawn = handoffs.find(
    (item) => item.operation.name === "pao_worker_process.spawn",
  );
  const finalPrompt = handoffs.find(
    (item) =>
      item.chain === "main_to_minister_prompt" &&
      item.promptKind === "final_review",
  );
  const reviewBreakdown = handoffs.find(
    (item) =>
      item.chain === "minister_to_main" &&
      item.outputCategory === "拆解结束信号" &&
      item.sender.pid === fixture.reviewOldPid,
  );
  const decision = handoffs.find(
    (item) => item.chain === "minister_to_main" && item.outputCategory === "最终判定",
  );

  assert.equal(handoffs.length, 19, JSON.stringify(output.unknown));
  assert.deepEqual(workerReceipt?.sender, { role: "worker", pid: fixture.workerPid });
  assert.deepEqual(workerReceipt?.receiver, { role: "main", pid: fixture.mainPid });
  assert.equal(workerSpawn?.senderSessionId, "main-session");
  assert.equal(workerSpawn?.receiverSessionId, fixture.executionId);
  assert.equal(workerReceipt?.derivation.kind, "source_constrained_inference");
  assert.deepEqual(workerReceipt?.evidence, {
    path: `project/.pao/worker-evidence/卡0001-尝试1-${fixture.executionId}.live.jsonl`,
    line: 3,
  });
  assert.deepEqual(finalPrompt?.receiver, {
    role: "minister",
    pid: fixture.reviewNewPid,
  });
  assert.deepEqual(finalPrompt?.evidence, {
    path: `project/.pao/部长会话/instance-1/review.jsonl`,
    line: 10,
  });
  assert.equal(finalPrompt?.derivation.kind, "source_constrained_inference");
  assert.deepEqual(reviewBreakdown?.sender, {
    role: "minister",
    pid: fixture.reviewOldPid,
  });
  assert.deepEqual(decision?.sender, {
    role: "minister",
    pid: fixture.reviewNewPid,
  });
  assert.deepEqual(decision?.evidence, {
    path: "project/.pao/部长会话/instance-1/review.jsonl",
    line: 12,
  });
  assert.equal(decision?.derivation.kind, "source_constrained_inference");
  assert.equal(
    handoffs.filter((item) => item.chain === "main_to_minister_prompt").length,
    8,
  );
  assert.equal(
    handoffs.filter((item) => item.chain === "minister_to_main").length,
    9,
  );
  assert.deepEqual(
    [...new Set(
      handoffs
        .filter((item) => item.chain === "minister_to_main")
        .map((item) => item.outputCategory),
    )].sort(),
    ["交卡", "地图", "拆解结束信号", "最终判定"].sort(),
  );
  assert.deepEqual(
    handoffs
      .filter((item) => item.chain === "main_to_minister_prompt")
      .reduce((counts, item) => {
        counts[item.promptKind] = (counts[item.promptKind] ?? 0) + 1;
        return counts;
      }, {}),
    {
      initial_task: 4,
      worker_result: 3,
      final_review: 1,
    },
  );
  assert.equal(
    handoffs.filter((item) => item.operation.name === "pao_worker_process.spawn").length,
    1,
  );
  assert.equal(output.observations.excludedMinisterToMainOutputs.length, 1);
  assert.match(
    output.observations.excludedMinisterToMainOutputs[0].reason,
    /报错/,
  );
  assert.equal(output.observations.roleSessions.complete, true);
  assert.equal(output.observations.handoffCoverage.complete, true);
  assert.equal(output.input.coverage.handoffs.complete, true);
  assert.equal(output.input.coverage.modelFixedSteps.complete, true);
  assert.equal(output.measurement.modelFixedSteps.byCategory["启流"].length, 1);
  assert.equal(output.measurement.modelFixedSteps.byCategory["抄身份"].length, 0);
  assert.equal(
    output.observations.unclassifiedToolCalls.some(
      (item) => item.toolName === "pao_query_flow",
    ),
    true,
  );
  assert.equal(output.measurement.boundaries.deduplicatedTotal.value, 19);
});

test("模拟：审核同 session 重开缺少旧 PID 散场时保持 unknown，不把可识别子集标 complete", () => {
  const fixture = createFullChainRun();
  rmSync(join(fixture.root, "pao-home", "部门", "审查", "监督审计.jsonl"), {
    force: true,
  });
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(
    output.candidates.handoffs.some(
      (item) =>
        item.chain === "main_to_minister_prompt" &&
        item.promptKind === "final_review",
    ),
    false,
  );
  assert.ok(
    output.observations.excludedMainToMinisterPrompts.some(
      (item) => item.promptKind === "final_review",
    ),
  );
  assert.equal(output.observations.handoffCoverage.complete, false);
  assert.equal(output.input.coverage.handoffs.complete, false);
  assert.equal(output.measurement.boundaries.deduplicatedTotal.status, "unknown");
  assert.ok(
    output.unknown.some(
      (item) =>
        item.domain === "main_to_minister_receiver" &&
        item.missing.includes("同 session 旧 PID 散场记录以区分重开"),
    ),
  );
});

test("模拟：worker 只有 spawn/exit 生命周期时不能冒充结果已回传主控", () => {
  const fixture = createRun();
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(
    output.candidates.handoffs.some(
      (item) => item.operation.name === "worker.pao_submit_receipt",
    ),
    false,
  );
  assert.equal(output.observations.handoffCoverage.chains.worker_to_main_receipt.complete, false);
  assert.ok(
    output.unknown.some(
      (item) =>
        item.domain === "worker_to_main" &&
        item.missing.includes("一次成功的 pao_submit_receipt start/end 配对"),
    ),
  );
});

test("模拟：worker 回执 tool_execution_end 报错时不形成成功交接", () => {
  const fixture = createRun({ withReceipt: true, receiptError: true });
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(
    output.candidates.handoffs.some(
      (item) => item.operation.name === "worker.pao_submit_receipt",
    ),
    false,
  );
  assert.ok(
    output.observations.excludedWorkerReceipts.some((item) => item.reason === "tool_execution_end 报错"),
  );
});

test("模拟：worker 回执缺少 tool_execution_end 时保持不完整", () => {
  const fixture = createRun({ withReceipt: true, receiptUnfinished: true });
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(
    output.candidates.handoffs.some(
      (item) => item.operation.name === "worker.pao_submit_receipt",
    ),
    false,
  );
  assert.ok(
    output.observations.excludedWorkerReceipts.some(
      (item) => item.reason === "缺少配对的 tool_execution_end",
    ),
  );
});

test("模拟：同一 worker toolCallId 的重复执行事件冲突时不采用最后一条", () => {
  const fixture = createRun({ withReceipt: true });
  const values = readLines(fixture.workerEvidencePath).map((line) => JSON.parse(line));
  values.splice(2, 0, {
    type: "tool_execution_start",
    toolCallId: `receipt-${fixture.executionId}`,
    toolName: "pao_submit_receipt",
    args: {
      result: "failed",
      summary: "冲突的第二份开始事件",
    },
  });
  jsonl(fixture.workerEvidencePath, values);
  const output = collectStructure({ runRoot: fixture.root });

  assert.equal(
    output.candidates.handoffs.some(
      (item) => item.operation.name === "worker.pao_submit_receipt",
    ),
    false,
  );
  assert.ok(
    output.observations.excludedWorkerReceipts.some(
      (item) => item.reason === "重复执行事件冲突",
    ),
  );
});

test("模拟：HTTP 请求与 actor 启动只作排除来源，不冒充业务交接", () => {
  const fixture = createRun();
  jsonl(join(fixture.root, "evidence", "model", "requests.jsonl"), [
    { request: 1 },
    { request: 2 },
    { request: 3 },
  ]);
  const output = collectStructure({ runRoot: fixture.root });
  const http = output.observations.excludedSources.find(
    (item) => item.kind === "model_http_request",
  );

  assert.equal(http.count, 3);
  assert.equal(output.candidates.handoffs.length, 1);
  assert.equal(output.observations.actorActivations.length, 2);
  assert.equal(output.observations.simulatedProtocolIsNotHandoff, true);
});

test("模拟：文件按冻结清单分类，producer 未知不影响已知事实种类", () => {
  const fixture = createRun();
  write(join(fixture.pao, "输入快照", "attempts", "attempt.json"), "{}\n");
  write(join(fixture.pao, "判定包", "decision.md"), "# 判定\n");
  write(join(fixture.project, "业务", "其他.txt"), "unknown\n");
  const output = collectStructure({ runRoot: fixture.root });
  const byKind = new Map(output.candidates.files.map((item) => [item.kind, item]));

  assert.equal(byKind.get("card-markdown").category, "state");
  assert.equal(byKind.get("attempt-input").category, "input");
  assert.equal(byKind.get("decision-pack").category, "derived");
  assert.equal(byKind.get("business-io").category, "unknown");
  assert.ok(output.candidates.files.every((item) => item.producer === null));
  assert.equal(output.measurement.fileKinds.state.status, "measured");
  assert.ok(output.measurement.fileKinds.state.kinds.includes("card-markdown"));
  assert.equal(output.measurement.fileKinds.immutableInputs.status, "measured");
  assert.ok(output.measurement.fileKinds.immutableInputs.kinds.includes("attempt-input"));
  assert.equal(output.measurement.fileKinds.derivedViews.status, "measured");
  assert.ok(output.measurement.fileKinds.derivedViews.kinds.includes("decision-pack"));
  assert.equal(output.measurement.fileKinds.unclassified.status, "unknown");
  assert.ok(output.measurement.fileKinds.unclassified.kinds.includes("business-io"));
  assert.equal(output.input.coverage.files.complete, true);
  assert.equal(output.observations.formalCoverage.files, true);
  assert.ok(output.observations.fileInventory.fileCount >= output.candidates.files.length);
  assert.equal(output.unknown.some((item) => item.domain === "file_producer"), false);
  const classification = output.unknown.find(
    (item) =>
      item.domain === "file_classification" &&
      item.file === "project/业务/其他.txt",
  );
  assert.deepEqual(classification?.missing, ["冻结运行清单中的明确事实类别"]);
});

test("模拟：G2-5 剩余文件按真实生产契约分类，worktree 副本仍分别保留", () => {
  const fixture = createRun();
  write(join(fixture.root, "agent-dir", "auth.json"), "{}\n");
  write(join(fixture.root, "agent-dir", "models-store.json"), "{}\n");
  write(join(fixture.root, "agent-dir", "models.json"), "{}\n");
  write(join(fixture.root, "agent-dir", "extensions", "benchmark-organization.js"), "\n");
  write(join(fixture.root, "pao-home", "部门", "规划", "交接", "project-1234abcd.md"), "\n");
  write(join(fixture.root, "pao-home", "部门", "规划", "配方.md"), "\n");
  write(join(fixture.root, "pao-home", "部门", "规划", "知识库", "索引.md"), "\n");
  write(
    join(fixture.root, "pao-home", "部门", "规划", "知识库", "教训", "子索引.md"),
    "\n",
  );
  write(join(fixture.root, "pao-home", "部门", "注册表.md"), "\n");
  write(join(fixture.root, "pao-home", "工作流", "基准开发流水线.md"), "\n");
  write(join(fixture.root, "pao-home", "用量账.jsonl"), "\n");
  write(join(fixture.root, "pao-home", "主控记忆", "MEMORY.md"), "\n");
  write(join(fixture.root, "pao-home", "pao配置", "保温.json"), "{}\n");
  write(join(fixture.root, "pao-home", "pao配置", "档位.json"), "{}\n");
  write(join(fixture.project, "业务", "输入.txt"), "same input\n");
  write(join(fixture.project, "业务", "结果.txt"), "same result\n");
  write(join(fixture.root, "verification-independent.json"), "{}\n");
  const worktree = join(fixture.root, "worktree-state", "worktrees", "project", "pao-worktree");
  write(join(worktree, ".git"), "gitdir: elsewhere\n");
  write(join(worktree, "业务", "输入.txt"), "same input\n");
  write(join(worktree, "业务", "结果.txt"), "same result\n");

  const output = collectStructure({ runRoot: fixture.root });
  const files = new Map(output.candidates.files.map((item) => [item.path, item]));
  const expected = new Map([
    ["agent-dir/auth.json", ["state", "auth-store"]],
    ["agent-dir/models-store.json", ["state", "models-store"]],
    ["agent-dir/models.json", ["config", "model-config"]],
    ["agent-dir/extensions/benchmark-organization.js", ["config", "extension-config"]],
    ["pao-home/部门/规划/交接/project-1234abcd.md", ["derived", "minister-handoff-view"]],
    ["pao-home/部门/规划/配方.md", ["config", "dept-recipe"]],
    ["pao-home/部门/规划/知识库/索引.md", ["state", "knowledge-facade"]],
    ["pao-home/部门/规划/知识库/教训/子索引.md", ["derived", "knowledge-index"]],
    ["pao-home/部门/注册表.md", ["state", "department-registry"]],
    ["pao-home/工作流/基准开发流水线.md", ["config", "workflow-recipe"]],
    ["pao-home/用量账.jsonl", ["state", "usage-ledger"]],
    ["pao-home/主控记忆/MEMORY.md", ["state", "resident-memory"]],
    ["pao-home/pao配置/保温.json", ["config", "host-runtime-config"]],
    ["pao-home/pao配置/档位.json", ["config", "routing-config"]],
    ["project/业务/输入.txt", ["input", "business-input"]],
    ["project/业务/结果.txt", ["business_result", "business-result"]],
    ["verification-independent.json", ["raw_evidence", "independent-verification"]],
    [
      "worktree-state/worktrees/project/pao-worktree/.git",
      ["state", "worktree-git-pointer"],
    ],
    [
      "worktree-state/worktrees/project/pao-worktree/业务/输入.txt",
      ["input", "business-input"],
    ],
    [
      "worktree-state/worktrees/project/pao-worktree/业务/结果.txt",
      ["business_result", "business-result"],
    ],
  ]);

  for (const [path, [category, kind]] of expected) {
    assert.ok(files.has(path), path);
    assert.equal(files.get(path).category, category, path);
    assert.equal(files.get(path).kind, kind, path);
  }
  assert.equal(files.get("project/业务/输入.txt").bytes, files.get(
    "worktree-state/worktrees/project/pao-worktree/业务/输入.txt",
  ).bytes);
  assert.equal(files.get("project/业务/结果.txt").bytes, files.get(
    "worktree-state/worktrees/project/pao-worktree/业务/结果.txt",
  ).bytes);
  assert.equal(output.measurement.fileKinds.configuration.value, 6);
  assert.equal(output.measurement.fileKinds.businessResults.value, 1);
});

test("模拟：相似路径和无生产契约的知识库区域保持未知", () => {
  const fixture = createRun();
  const paths = [
    "agent-dir/auth.json.backup",
    "agent-dir/nested/auth.json",
    "pao-home/部门/规划/知识库/待验证/子索引.md",
    "pao-home/部门/规划/知识库/归档/子索引.md",
    "pao-home/部门/规划/知识库/自定义/子索引.md",
    "pao-home/部门/规划/知识库/索引-旧版.md",
    "pao-home/工作流/自定义.json",
    "project/业务/未知输出.txt",
    "worktree-state/worktrees/project/pao-worktree/业务/未知输出.txt",
  ];
  for (const path of paths) write(join(fixture.root, path), "模拟未知文件\n");
  const output = collectStructure({ runRoot: fixture.root });
  const files = new Map(output.candidates.files.map((item) => [item.path, item]));
  for (const path of paths) assert.equal(files.get(path)?.category, "unknown", path);
});

test("模拟：冻结尝试输入和追加指标证据不计作可变控制状态，旧基线单列", () => {
  const fixture = createRun();
  const cases = [
    ["project/.pao/基线/卡0001-尝试1-基线.json", "input", "attempt-baseline"],
    ["project/.pao/基线/卡0001-基线.txt", "state", "legacy-baseline"],
    ["project/.pao/execution-contexts/card-0001-attempt-1.json", "input", "execution-context"],
    ["project/.pao/四指标账.txt", "raw_evidence", "workflow-metrics-ledger"],
  ];
  for (const [path] of cases) write(join(fixture.root, path), "模拟契约文件\n");
  const output = collectStructure({ runRoot: fixture.root });
  const files = new Map(output.candidates.files.map((item) => [item.path, item]));
  for (const [path, category, kind] of cases) {
    assert.equal(files.get(path)?.category, category, path);
    assert.equal(files.get(path)?.kind, kind, path);
  }
});

test("命令行读取显式 runRoot 并输出统一输入", () => {
  const fixture = createRun();
  const child = spawnSync(process.execPath, [SCRIPT, fixture.root], {
    cwd: resolve(HERE, "../.."),
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.schema, "pao-g2-structure-collection-v1");
  assert.equal(output.candidates.handoffs.length, 1);
});

function readLines(path) {
  return readFileText(path)
    .split(/\r?\n/)
    .filter(Boolean);
}

function readFileText(path) {
  return readFileSync(path, "utf8");
}

function rewriteJsonlPaths(path, fromRoot, toRoot) {
  return `${readLines(path)
    .map((line) =>
      JSON.stringify(
        JSON.parse(line, (_key, value) =>
          typeof value === "string" ? value.replaceAll(fromRoot, toRoot) : value,
        ),
      ),
    )
    .join("\n")}\n`;
}
