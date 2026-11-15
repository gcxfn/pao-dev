import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 从同目录 runs 的原始证据生成 run-summary.json；在项目根执行 node <本文件>。
const root = dirname(fileURLToPath(import.meta.url));
const read = (path) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
const sumKnown = (records, field) => {
  const values = records.map((record) => record?.[field]);
  const known = values.filter((value) => typeof value === "number");
  return { knownTotal: known.reduce((sum, value) => sum + value, 0), unknownCount: values.length - known.length };
};
const runs = [];
for (const name of readdirSync(join(root, "runs")).filter((name) => name.startsWith("real-")).sort()) {
  const directory = join(root, "runs", name);
  const basic = read(join(directory, "basic-scenario.json"));
  const review = read(join(directory, "main-review.json"));
  const semantic = read(join(directory, "semantic-20.json"));
  const beforeDocuments = read(join(directory, "semantic-before-documents.json"));
  const external = read(join(directory, "external-usage.json"));
  const documents = read(join(directory, "quality-documents.json"));
  let requests = basic?.modelRequests ?? basic?.sessions?.flatMap((session) => session.modelRequests ?? []) ?? basic?.scenarioEvidence?.extractions?.flatMap((entry) => entry.request.modelRequests ?? []) ?? [];
  if (!basic) {
    requests = ["extraction-initial-model.json", "extraction-stale-model.json"]
      .flatMap((name) => { const record = read(join(directory, name)); return record?.modelInvoked ? [{ output: { usage: record.usage } }] : []; });
  }
  if (requests.length === 0) {
    requests = (external?.records ?? []).filter((record) => record.kind === "model_or_other" && /\/(?:chat\/completions|responses)(?:[?#]|$)/.test(record.url ?? ""));
  }
  const usages = requests.map((request) => request.output?.usage);
  const embeddings = [
    ...(external?.records ?? []).filter((record) => record.kind === "embedding"),
    ...(documents?.requests ?? []).filter((record) => record.kind === "embedding"),
    ...(beforeDocuments?.queries ?? []).flatMap((query) => query.usage?.embedding ?? []),
    ...(semantic?.queries ?? []).flatMap((query) => query.usage?.embedding ?? []),
  ];
  // I04 的文档嵌入有持久 attempt 账及成功向量，未启用 fetch observer；不捏造 HTTP 状态或 token。
  const ledger = read(join(directory, "ledger-session.json"));
  const embedding = read(join(directory, "embedding.json"));
  if (!external && !documents && embedding?.enabled && embedding.mode === "real") {
    const attempts = (ledger?.entries ?? []).filter((entry) => entry.customType === "pao-memory-embedding-attempt");
    for (const attempt of attempts) embeddings.push({ ...attempt.data, success: embedding[attempt.data.phase?.startsWith("r1") ? "r1" : "r2"]?.embedded > 0, basis: "embedding.json 的 r1/r2 成功结果与持久 attempt 对应", status: "success_status_unknown" });
  }
  const scenarioId = basic?.scenarioId ?? basic?.scenario?.id ?? /^real-(I\d+)/.exec(name)?.[1] ?? "unknown";
  const queries = (semantic?.queries ?? []).filter((query) => query.scenarioId === scenarioId);
  runs.push({
    name, scenarioId, executionStatus: basic?.status ?? "stale_scenario_evidence",
    mainReview: review?.status ?? "pending", modelRequests: requests.length,
    tokens: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"].map((field) => [field, sumKnown(usages, field)])),
    embeddingRequests: embeddings.length,
    embeddingSuccesses: embeddings.filter((record) => record.success === true || (record.status >= 200 && record.status < 300)).length,
    embeddingTokens: sumKnown(embeddings.map((record) => record.usage), "total_tokens"),
    localFailureQueryRequests: read(join(directory, "fallback-frozen-queries.json"))?.requests?.length ?? 0,
    semanticQueries: queries.map(({ queryId, id, status, semanticEvidence }) => ({ id: queryId ?? id, status, semanticEvidence })),
    cost: "unknown",
  });
}
const scenarioReviews = Array.from({ length: 10 }, (_, index) => {
  const scenarioId = `I${String(index + 1).padStart(2, "0")}`;
  const acceptedRuns = runs.filter((run) => run.scenarioId === scenarioId && run.mainReview === "passed").map((run) => run.name);
  return { scenarioId, status: acceptedRuns.length ? "passed" : "incomplete", acceptedRuns };
});
const semanticPassed = new Set(runs.flatMap((run) => run.semanticQueries).filter((query) => query.status === "passed" && query.semanticEvidence).map((query) => query.id)).size;
const summary = {
  source: "runs 原始请求及验收证据；由 summarize-runs.mjs 生成",
  status: scenarioReviews.every((review) => review.status === "passed") && semanticPassed === 20 ? "passed" : "incomplete",
  cost: "unknown",
  pricingNote: "未获得可核实的供应商结算金额；SDK 默认零费用不作为免费证据。",
  scenarioReviews,
  runs,
  totals: {
    modelRequests: runs.reduce((sum, run) => sum + run.modelRequests, 0),
    embeddingRequests: runs.reduce((sum, run) => sum + run.embeddingRequests, 0),
    actualScenarioSemanticQueriesPassed: semanticPassed,
  },
};
writeFileSync(join(root, "run-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary.totals));
