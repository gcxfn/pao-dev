/** O01 完成情况复核：模型与嵌入传输为离线夹具，使用实际预算账、业务入口及 SDK。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { requestExtraction } from "../../../PAO/packages/coding-agent/src/pao/memory/extract-model.ts";
import { checkMemoryJobBudget } from "../../../PAO/packages/coding-agent/src/pao/memory/budget.ts";
import { budgetLedgerPath, readBudgetLedger } from "../../../PAO/packages/coding-agent/src/pao/usage/budget-ledger.ts";
import { registerResource, snapshotResourceFiles } from "../../../PAO/packages/coding-agent/src/pao/evolution/resources.ts";
import { declareImprovementIntent, classifyProblem } from "../../../PAO/packages/coding-agent/src/pao/evolution/problems.ts";
import { freezeValidationPlan } from "../../../PAO/packages/coding-agent/src/pao/evolution/validation.ts";
import { proposeCandidate } from "../../../PAO/packages/coding-agent/src/pao/evolution/candidates.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { registerSource } from "../../../PAO/packages/coding-agent/src/pao/memory/sources.ts";
import { embedCurrentMemories, openPersistentMemoryLedger, resolveMemoryOutboundContext } from "../../../PAO/packages/coding-agent/src/pao/memory/runtime-embedding.ts";
import { readMemoryUsage } from "../../../PAO/packages/coding-agent/src/pao/memory/usage-query.ts";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "../../../PAO/packages/ai/src/index.ts";
import { AuthStorage } from "../../../PAO/packages/coding-agent/src/core/auth-storage.ts";
import { createAgentSession } from "../../../PAO/packages/coding-agent/src/core/sdk.ts";
import { SettingsManager } from "../../../PAO/packages/coding-agent/src/core/settings-manager.ts";
import { registerBuiltinMemory } from "../../../PAO/packages/coding-agent/src/pao/memory/tools.ts";
import { readDesktopContextUsage } from "../../../PAO/packages/coding-agent/src/pao/desktop/memory.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../../PAO/packages/coding-agent/test/utilities.ts";
import { createModelRegistry, getModelRuntime } from "../../../PAO/packages/coding-agent/test/model-runtime-test-utils.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const closers: (() => unknown | Promise<unknown>)[] = [];
const resultsPath = join(dir, "o01-rereview-results.json");
const results: any[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")).results : [];
const tier = { provider: "pao", 档位: [{ 名: "快", provider: "test", model: "m", thinkingLevel: "off" }] } as never;
const at = new Date().toISOString();
function home(config: object = { 每日上限: 1, 允许嵌入: true }) {
  const root = mkdtempSync(join(dir, "o01-fixture-")); roots.push(root);
  mkdirSync(join(root, "pao配置"), { recursive: true });
  writeFileSync(join(root, "pao配置", "记忆后台预算.json"), JSON.stringify(config));
  writeFileSync(budgetLedgerPath(root), JSON.stringify({ version: 1, reservations: [], grants: [{
    version: 1, 总预算: 10, 授权时间: at, 余额依据: { 已花: 0, 授权前总预算: 0 }, 授权人: "audit",
  }] }));
  return root;
}
function ok(value: any) { if (!value.ok) throw new Error(JSON.stringify(value)); return value; }
function usage(cost = .02) { return { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
  cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }; }
function registry(reply: string, onRequest: () => void = () => {}) {
  return { find: () => ({}), streamSimple: () => { onRequest(); return { result: async () => ({
    ...fauxAssistantMessage(reply), provider: "test", model: "m", responseModel: "m", usage: usage(),
  }) }; } } as never;
}
function record(id: string, detail: unknown) {
  const previous = results.findIndex(item => item.id === id);
  if (previous !== -1) results.splice(previous, 1);
  results.push({ id, detail });
}
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  writeFileSync(resultsPath, JSON.stringify({ node: process.version, results }, null, 2));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("O01-R1：同批真实重试不覆盖前一次费用", async () => {
  const root = home(); const ledger = SessionManager.inMemory(root);
  const deps = { modelRegistry: registry("not-json"), ledger, paoHome: root, tierConfig: tier,
    outboundProjects: ["audit"], outbound: { projects: { audit: { allowed: true, asOf: "2099-12-31" } } },
    budgetScopeKey: "session:a", budgetAttemptKey: "first-source" };
  const input = { jobId: "retry-job", sourceSessionId: "a", entries: [{ sourceId: "s1", entryId: "e1", eventType: "user", content: "决定" }] };
  ok(await requestExtraction(deps as never, input)); ok(await requestExtraction(deps as never, input));
  const reservations = readBudgetLedger(budgetLedgerPath(root)).reservations;
  const requests = ledger.getEntries().filter(e => e.type === "usage").length;
  const settled = reservations.reduce((sum, r) => sum + (r.已结算费用 ?? 0), 0);
  record("R1", { requests, reservations, settled });
  expect(requests).toBe(2); expect(settled).toBeCloseTo(.04);
});

function candidate(root: string, authorized = false) {
  const store = openMemoryStore(root, "readwrite"); closers.push(() => store.close());
  const skillDir = join(root, "pao配置", "skills", "audit-skill"); mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# audit-skill\n处理输入\n");
  ok(registerResource(store, { kind: "skill", name: "audit-skill", paoHome: root }));
  const resourceId = "skill:audit-skill";
  const { versionId: baseVersion } = ok(snapshotResourceFiles(store, { resourceId, paoHome: root }));
  const declared = ok(declareImprovementIntent(store, { kind: "implementation_defect", action: "modify", summary: "缺验证",
    expectedBehavior: "验证输出", actualBehavior: "只处理输入", evidenceRefs: ["friction:audit"], resourceId, baseVersion }));
  if (!declared.accepted) throw new Error("问题未受理");
  const problemId = declared.problemId; ok(classifyProblem(store, { problemId }));
  const example = { input: "验证输出", initialFiles: {}, allowedTools: [], acceptance: "验证存在" };
  const plan = ok(freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: root,
    reproduction: [example], normal: [example], holdout: [example] }));
  const ledger = SessionManager.inMemory(root);
  let requests = 0;
  const deps = { modelRegistry: registry('{"rationale":"无需修改","edits":[]}', () => requests++),
    ledger, paoHome: root, budgetPaoHome: root, tierConfig: tier,
    ...(authorized ? { outboundProjects: ["audit"], outbound: { projects: { audit: { allowed: true, asOf: "2099-12-31" } } } } : {}) };
  const input = { problemId, resourceId, baseVersion, testPlanId: plan.testPlanId,
    allowedFiles: ["SKILL.md"], devCases: [{ input: "验证输出", failure: "缺少验证" }] };
  return { store, deps, input, requests: () => requests };
}

it("O01-R2：未产生候选的两次付费生成分别结算", async () => {
  const root = home(); const f = candidate(root, true);
  const first = await proposeCandidate(f.store, f.deps, f.input);
  const second = await proposeCandidate(f.store, f.deps, f.input);
  const reservations = readBudgetLedger(budgetLedgerPath(root)).reservations;
  const settled = reservations.reduce((sum, r) => sum + (r.已结算费用 ?? 0), 0);
  record("R2", { first, second, requests: f.requests(), reservations, settled });
  expect(f.requests()).toBe(2); expect(settled).toBeCloseTo(.04);
});

it("O01-R3：没有外发许可时，候选生成不发模型请求", async () => {
  const root = home(); const f = candidate(root);
  const output = await proposeCandidate(f.store, f.deps, f.input);
  record("R3", { output, requests: f.requests() });
  expect(f.requests()).toBe(0);
});

async function embedding(root: string, count: number, failureAt?: number, retry = false) {
  const store = openMemoryStore(root, "readwrite"); closers.push(() => store.close());
  const service = openMemoryService({ paoHome: root, mode: "readwrite" }); closers.push(() => service.close());
  const project = resolveMemoryOutboundContext(root, root).project;
  mkdirSync(join(root, "知识库配置"), { recursive: true });
  writeFileSync(join(root, "知识库配置", "外发许可.json"), JSON.stringify({ projects: { [project]: { allowed: true, asOf: "2099-12-31" } } }));
  vi.stubEnv("PAO_OUTBOUND_CONFIG", ""); vi.stubEnv("EMBED_BASE_URL", "https://offline.invalid/v1");
  vi.stubEnv("EMBED_API_KEY", "audit-fixture"); vi.stubEnv("EMBED_MODEL", "audit-model");
  let requests = 0;
  vi.stubGlobal("fetch", async (_url: unknown, init: any) => {
    requests++;
    if (requests === failureAt) throw new Error("fixture embedding connection lost");
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
  for (let i = 0; i < count; i++) {
    const sourceId = registerSource(store.db, { sessionId: "embedding-session", entryId: `e${i}`, eventType: "user", capturedAt: at });
    ok(await service.createMemory({ kind: "decision", scope: {projectId: "audit-project"}, conclusion: `决定 ${i}`,
      evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [sourceId] }));
  }
  const ledger = openPersistentMemoryLedger(root, "embed-job");
  const deps = { home: root, db: store.db, projectId: "audit-project", executionPath: root,
    ledger, jobId: "embed-job", requestId: "embedding-run", batchSize: 1 };
  let output: unknown; let failure: string | undefined; let retryOutput: unknown;
  try { output = await embedCurrentMemories(deps); }
  catch (error) { if (failureAt === undefined) throw error; failure = String(error); }
  if (retry) retryOutput = await embedCurrentMemories(deps);
  return { output, failure, retryOutput, requests, reservations: readBudgetLedger(budgetLedgerPath(root)).reservations,
    rawUsages: ledger.getEntries().filter(e => e.type === "usage").length,
    aggregate: readMemoryUsage(store, { paoHome: root }) };
}

it("O01-R4：多批嵌入逐请求预留并结算未知费用，聚合不漏批", async () => {
  const result = await embedding(home(), 2); record("R4", result);
  expect(result.requests).toBe(2); expect(result.rawUsages).toBe(2);
  expect(result.reservations).toHaveLength(2);
  expect(result.reservations.every(r => r.status === "unknown")).toBe(true);
  expect(result.aggregate.entries).toHaveLength(2);
});

it("O01-R5：没有待嵌入记忆时不占预算", async () => {
  const result = await embedding(home(), 0); record("R5", result);
  expect(result.requests).toBe(0); expect(result.reservations).toHaveLength(0);
});

it("O01-R6：两个后台作业并行预留不能突破同一日上限", async () => {
  const root = home({ 每日上限: .06 });
  const outputs = await Promise.all(["a", "b"].map(jobId => checkMemoryJobBudget({ paoHome: root,
    jobId, jobKind: "extract", scopeKey: jobId, 金额: .05, 现在: at })));
  record("R6", { outputs, reservations: readBudgetLedger(budgetLedgerPath(root)).reservations });
  expect(outputs.filter(r => r.ok)).toHaveLength(1);
});

it("O01-R7：unlimited 的候选请求完成后正常返回，不结算不存在的预留", async () => {
  const root = home({ unlimited: true }); const f = candidate(root, true);
  let error: string | undefined; let output: unknown;
  try { output = await proposeCandidate(f.store, f.deps, f.input); } catch (e) { error = String(e); }
  record("R7", { requests: f.requests(), output, error });
  expect(f.requests()).toBe(1);
  expect(output).toMatchObject({ ok: true, status: "no_change" });
  expect(error).toBeUndefined();
});

it("O01-R8：真实 SDK 的上下文快照可关联实际模型用量", async () => {
  const root = home(); const sessionDir = join(root, "agent", "sessions", "audit-project");
  const manager = SessionManager.create(root, sessionDir);
  const auth = AuthStorage.inMemory();
  await auth.modify("audit-provider", async () => ({ type: "api_key", key: "audit-fixture" }));
  const modelRegistry = await createModelRegistry(auth, join(root, "models.json"));
  const model = { id: "audit-model", name: "Audit", api: "openai-completions", provider: "audit-provider",
    baseUrl: "https://offline.invalid/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 } as never;
  let payloadCalls = 0;
  modelRegistry.registerProvider("audit-provider", { api: "openai-completions", streamSimple: (requestModel, _context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await options?.onPayload?.({ model: requestModel.id }, requestModel);
      payloadCalls++;
      stream.end({ ...fauxAssistantMessage("回复完成"), api: requestModel.api, provider: requestModel.provider,
        model: requestModel.id, usage: usage() });
    })().catch(error => stream.end({ ...fauxAssistantMessage(""), stopReason: "error", errorMessage: String(error) }));
    return stream;
  } });
  let registration: ReturnType<typeof registerBuiltinMemory> | undefined;
  const extensionsResult = await createTestExtensionsResult([(pi) => {
    registration = registerBuiltinMemory(pi, { paoHome: root });
  }], root);
  const { session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime: getModelRuntime(modelRegistry),
    model, sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ compaction: {enabled: false}, retry: {enabled: false} }),
    resourceLoader: createTestResourceLoader({ extensionsResult }), tools: [] });
  closers.push(async () => { session.dispose(); await registration?.close(); });
  await session.bindExtensions({}); await session.prompt("回答一次"); manager.flush();
  const entries = manager.getEntries();
  const actual = entries.filter(e => e.type === "message" && e.message.role === "assistant").map(e => e.message);
  const displayed = ok(await readDesktopContextUsage({ home: root }));
  record("R8", { actual, displayed, payloadCalls, usageEntries: entries.filter(e => e.type === "usage") });
  expect(payloadCalls).toBe(1);
  expect(actual).toHaveLength(1); expect(displayed.items).toHaveLength(1);
  expect(displayed.items[0].actual?.totalTokens).toBe(10);
});

it("O01-R9：标记用量未返回的默认零 usage 不按零费用结算", async () => {
  const root = home(); const ledger = SessionManager.inMemory(root);
  const response = fauxAssistantMessage("[]");
  const output = await requestExtraction({ modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => response }) } as never,
    ledger, paoHome: root, tierConfig: tier, outboundProjects: ["audit"],
    outbound: { projects: { audit: { allowed: true, asOf: "2099-12-31" } } }, budgetScopeKey: "session:a", budgetAttemptKey: "zero-usage",
  }, { jobId: "zero-usage-job", sourceSessionId: "a", entries: [{ sourceId: "s1", entryId: "e1", eventType: "user", content: "决定" }] });
  const reservations = readBudgetLedger(budgetLedgerPath(root)).reservations;
  record("R9", { output, reservations, usageEntries: ledger.getEntries().filter(e => e.type === "usage") });
  expect(reservations[0].status).toBe("unknown");
});

it("O01-R10：请求抛异常后，用量聚合保留一次未知请求", async () => {
  const root = home(); const ledger = openPersistentMemoryLedger(root, "throw-job");
  const store = openMemoryStore(root, "readwrite"); closers.push(() => store.close());
  const output = await requestExtraction({ modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => { throw new Error("fixture connection lost"); } }) } as never,
    ledger, paoHome: root, tierConfig: tier, outboundProjects: ["audit"],
    outbound: { projects: { audit: { allowed: true, asOf: "2099-12-31" } } }, budgetScopeKey: "session:a", budgetAttemptKey: "throw-attempt",
  }, { jobId: "throw-job", sourceSessionId: "a", entries: [{ sourceId: "s1", entryId: "e1", eventType: "user", content: "决定" }] });
  const aggregate = readMemoryUsage(store, { paoHome: root });
  record("R10", { output, aggregate, reservations: readBudgetLedger(budgetLedgerPath(root)).reservations });
  expect(aggregate.total.unknownCount).toBe(1);
});

it("O01-R11：嵌入作业失败后续作，每次实际请求有独立占额与聚合记录", async () => {
  const result = await embedding(home(), 1, 1, true);
  record("R11", result);
  expect(result.failure).toContain("connection lost");
  expect(result.requests).toBe(2);
  expect(result.reservations).toHaveLength(2);
  expect(result.aggregate.entries).toHaveLength(2);
});

it("O01-R12：嵌入失败按 embed 用途聚合，保留已知的模型与任务归属", async () => {
  const result = await embedding(home(), 1, 1);
  record("R12", result);
  expect(result.failure).toContain("connection lost");
  expect(result.requests).toBe(1);
  expect(result.aggregate.entries).toHaveLength(1);
  expect(result.aggregate.entries[0].kind).toBe("embed");
  expect(result.aggregate.entries[0].model).toBe("audit-model");
});
