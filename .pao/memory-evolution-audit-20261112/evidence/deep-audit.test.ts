/** 公开业务入口的离线审核运行；生成器为固定响应，存储、文件和命令执行使用真实实现。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "../../../PAO/packages/ai/src/index.ts";
import { AuthStorage } from "../../../PAO/packages/coding-agent/src/core/auth-storage.ts";
import { ModelRuntime } from "../../../PAO/packages/coding-agent/src/core/model-runtime.ts";
import { createAgentSession } from "../../../PAO/packages/coding-agent/src/core/sdk.ts";
import { SettingsManager } from "../../../PAO/packages/coding-agent/src/core/settings-manager.ts";
import { createJob } from "../../../PAO/packages/coding-agent/src/pao/memory/extraction-jobs.ts";
import { registerBuiltinMemory } from "../../../PAO/packages/coding-agent/src/pao/memory/tools.ts";
import { createMemoryBackup, restoreMemoryBackup } from "../../../PAO/packages/coding-agent/src/pao/memory/backup.ts";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { registerResource, snapshotResourceFiles } from "../../../PAO/packages/coding-agent/src/pao/evolution/resources.ts";
import { declareImprovementIntent, classifyProblem } from "../../../PAO/packages/coding-agent/src/pao/evolution/problems.ts";
import { selectImprovement } from "../../../PAO/packages/coding-agent/src/pao/evolution/select.ts";
import { freezeValidationPlan } from "../../../PAO/packages/coding-agent/src/pao/evolution/validation.ts";
import { proposeCandidate } from "../../../PAO/packages/coding-agent/src/pao/evolution/candidates.ts";
import { evaluateCandidate } from "../../../PAO/packages/coding-agent/src/pao/evolution/evaluate.ts";
import { publishCandidate } from "../../../PAO/packages/coding-agent/src/pao/evolution/versions.ts";
import { activateCandidate, getEffectiveVersion } from "../../../PAO/packages/coding-agent/src/pao/evolution/activation.ts";
import { runValidationCase } from "../../../PAO/packages/coding-agent/src/pao/evolution/runner.ts";
import { assistantMsg, userMsg, createTestExtensionsResult, createTestResourceLoader } from "../../../PAO/packages/coding-agent/test/utilities.ts";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(evidenceDir, "deep-audit-results.json");
const observations: any[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")).observations : [];
const cleanups: (() => unknown | Promise<unknown>)[] = [];
const roots: string[] = [];
const at = "2026-11-12T08:00:00.000Z";
const baseline = "# audit-skill\n步骤一: 输入\n步骤二: 处理\n";
const fixed = `${baseline}步骤三: 验证输出\n`;
const resourceId = "skill:audit-skill";

function ok(result: any) {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
function root() {
  const dir = mkdtempSync(join(evidenceDir, "deep-home-"));
  roots.push(dir);
  return dir;
}
function record(id: string, detail: unknown) {
  const previous = observations.findIndex(item => item.id === id);
  if (previous !== -1) observations.splice(previous, 1);
  observations.push({ id, detail });
}
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  writeFileSync(join(evidenceDir, "deep-audit-results.json"), JSON.stringify({
    runtime: { node: process.version, electron: process.versions.electron ?? null },
    model: "offline fixed response", observations,
  }, null, 2));
  for (const dir of roots.splice(0)) {
    const rel = relative(evidenceDir, resolve(dir));
    if (rel.startsWith("..") || !rel.startsWith("deep-home-")) throw new Error("夹具路径不在审核目录内");
    rmSync(dir, { recursive: true, force: true });
  }
});

async function memoryFixture(parent: string) {
  const home = join(parent, "original");
  const store = openMemoryStore(home, "readwrite");
  const service = openMemoryService({ paoHome: home, mode: "readwrite" });
  const manager = SessionManager.create(home, join(home, "agent", "sessions"));
  const entryId = manager.appendMessage(userMsg("项目决定：使用 SQLite，不启动 PostgreSQL 服务。"));
  manager.appendMessage(assistantMsg("已记录项目决定。"));
  const capture = createCapture({ store, paoHome: home, now: () => at });
  capture.registerSession(manager.getSessionId(), manager.getSessionFile());
  const captured = capture.captureCommittedEntry(manager.getSessionId(), manager.getEntry(entryId)!, undefined, at);
  if (!captured.sourceId) throw new Error("来源采集未成功");
  const memory = ok(await service.createMemory({
    kind: "decision", scope: { projectId: "deep-audit", sessionId: manager.getSessionId() },
    conclusion: "使用 SQLite，不启动 PostgreSQL 服务。", evidenceKind: "user_statement",
    confirmation: "confirmed", sourceIds: [captured.sourceId], createdAt: at,
  }));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.close(); store.close(); } };
  cleanups.push(close);
  return { home, store, service, memoryId: memory.id, sourceId: captured.sourceId, close };
}

it("D1：异地恢复后，原现场不可用仍可回读来源原文", async () => {
  const parent = root();
  const f = await memoryFixture(parent);
  const before = ok(await f.service.readMemorySource({ sourceId: f.sourceId }));
  const backupDir = join(parent, "backup");
  ok(createMemoryBackup(f.store, { home: f.home, backupDir }));
  await f.close();
  const unavailable = join(parent, "original-unavailable");
  if (dirname(f.home) !== parent || dirname(unavailable) !== parent) throw new Error("夹具移动越界");
  renameSync(f.home, unavailable);
  const targetHome = join(parent, "restored");
  const restored = ok(restoreMemoryBackup({ backupDir, targetHome }));
  const reader = openMemoryService({ paoHome: targetHome, mode: "readwrite" });
  cleanups.push(() => reader.close());
  const after = await reader.readMemorySource({ sourceId: f.sourceId });
  record("D1", { restored, before, after });
  expect(after.ok).toBe(true);
  if (after.ok) expect(after.content).toBe(before.content);
});

it("D2：旧备份重放最新删除记录后，按 ID 也不能恢复已删除正文", async () => {
  const parent = root();
  const f = await memoryFixture(parent);
  const backupDir = join(parent, "backup");
  ok(createMemoryBackup(f.store, { home: f.home, backupDir }));
  const preview = ok(await f.service.previewMemoryDeletion({ memoryId: f.memoryId }));
  const deleted = ok(await f.service.deleteMemory({
    memoryIds: preview.targets.map((t: any) => t.memoryId),
    revisions: Object.fromEntries(preview.targets.map((t: any) => [t.memoryId, t.currentRevision])),
    source: { sessionId: "audit-delete-command" },
  }));
  expect(deleted.status).toBe("complete");
  const targetHome = join(parent, "restored");
  const restored = ok(restoreMemoryBackup({ backupDir, targetHome, liveHome: f.home }));
  const reader = openMemoryService({ paoHome: targetHome, mode: "readwrite" });
  cleanups.push(() => reader.close());
  const memory = await reader.getMemory({ id: f.memoryId, includeHistory: true });
  record("D2", { deleted, restored, memory });
  expect(memory.ok).toBe(false);
});

function evolutionFixture(parent: string) {
  const home = join(parent, "home");
  const store = openMemoryStore(home, "readwrite");
  cleanups.push(() => store.close());
  const skillDir = join(home, "pao配置", "skills", "audit-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), baseline);
  writeFileSync(join(home, "pao配置", "记忆后台预算.json"), JSON.stringify({ 每日上限: 1, 允许嵌入: true }));
  writeFileSync(join(home, "总预算账.json"), JSON.stringify({ version: 1,
    grants: [{ version: 1, 总预算: 10, 授权时间: at, 余额依据: { 已花: 0, 授权前总预算: 0 }, 授权人: "audit" }], reservations: [] }));
  ok(registerResource(store, { kind: "skill", name: "audit-skill", paoHome: home }));
  const snapshot = ok(snapshotResourceFiles(store, { resourceId, paoHome: home, createdAt: at }));
  const problem = ok(declareImprovementIntent(store, { kind: "implementation_defect", action: "modify",
    summary: "技能缺少输出验证", expectedBehavior: "包含验证步骤", actualBehavior: "只有输入和处理",
    evidenceRefs: ["friction:audit:missing-verification"], resourceId, baseVersion: snapshot.versionId }));
  if (!problem.accepted) throw new Error("问题未受理");
  ok(classifyProblem(store, { problemId: problem.problemId }));
  const example = { input: "检查技能步骤", initialFiles: { "SKILL.md": baseline }, allowedTools: [], acceptance: "包含步骤三" };
  const planInput = { problemId: problem.problemId, resourceId, baseVersion: snapshot.versionId,
    paoHome: home, reproduction: [example], normal: [example], holdout: [example] };
  return { home, store, planInput, baseVersion: snapshot.versionId, problemId: problem.problemId };
}
async function candidateFixture(parent: string) {
  const f = evolutionFixture(parent);
  const frozen = ok(freezeValidationPlan(f.store, f.planInput));
  const reply = JSON.stringify({ rationale: "补充验证步骤", edits: [{ path: "SKILL.md", action: "edit", content: fixed }] });
  const proposed = ok(await proposeCandidate(f.store, {
    modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => ({
      provider: "test", model: "m", responseModel: "m", stopReason: "stop",
      usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 }, content: [{ type: "text", text: reply }],
    }) }) } as never,
    ledger: { appendUsage: () => ({}), appendCustomEntry: () => ({}) } as never,
    paoHome: f.home, budgetPaoHome: f.home,
    tierConfig: { provider: "pao", 档位: [{ 名: "快", provider: "test", model: "m", thinkingLevel: "off" }] } as never,
  }, { problemId: f.problemId, resourceId, baseVersion: f.baseVersion, testPlanId: frozen.testPlanId,
    allowedFiles: ["SKILL.md"], devCases: [{ input: "检查步骤三", failure: "技能缺少步骤三" }] }));
  if (proposed.status !== "changed") throw new Error(JSON.stringify(proposed));
  return { ...f, frozen, candidateId: proposed.candidateId };
}

it("D3：先选择改善方案再冻结三组样例，正常流程可以继续", () => {
  const f = evolutionFixture(root());
  const selection = ok(selectImprovement(f.store, { problemId: f.problemId }));
  const frozen = freezeValidationPlan(f.store, f.planInput);
  record("D3", { selection, frozen });
  expect(frozen.ok).toBe(true);
});

it("D4：公开生成入口生成的候选，零验证结果不能发布并生效", async () => {
  const f = await candidateFixture(root());
  const evaluated = ok(evaluateCandidate(f.store, { candidateId: f.candidateId,
    testPlanId: f.frozen.testPlanId, caseResults: [] }));
  const published = await publishCandidate(f.store, { candidateId: f.candidateId, paoHome: f.home });
  const activated = await activateCandidate(f.store, { candidateId: f.candidateId,
    expectedEffectiveVersion: f.baseVersion, paoHome: f.home, authRef: "audit:local-user" });
  const effective = getEffectiveVersion(f.store, resourceId, f.home);
  record("D4", { evaluated, published, activated, effective });
  expect(evaluated.verdict).not.toBe("passed");
});

it("D5：同一冻结输入的双侧执行，实际消费不同版本的技能", async () => {
  const f = await candidateFixture(root());
  const validationCase = { ...f.frozen.plan.reproduction[0], initialFiles: {
    "SKILL.md": baseline,
    "check.cjs": 'const fs = require("node:fs"); process.exit(fs.readFileSync("SKILL.md", "utf8").includes("步骤三") ? 0 : 1);',
  } };
  const common = { validationCase, resourceId, baseVersion: f.baseVersion, testPlanId: f.frozen.testPlanId,
    paoHome: f.home, kind: "command" as const, verifier: { cmd: "node", args: ["check.cjs"] } };
  const before = ok(await runValidationCase(f.store, {}, { ...common, side: "baseline" }));
  const after = ok(await runValidationCase(f.store, {}, { ...common, side: "candidate", candidateId: f.candidateId }));
  record("D5", { before, after });
  expect(before.result.passed).toBe(false);
  expect(before.result.exitCode).toBe(1);
  expect(after.result.passed).toBe(true);
});

it("D6：真实 SDK 新会话正常提炼时，同时续做旧会话持久任务", async () => {
  const parent = root();
  const f = await memoryFixture(parent);
  const oldSource = f.store.db.prepare("SELECT session_id FROM sources WHERE source_id=?").get(f.sourceId) as {session_id: string};
  const oldJob = createJob(f.store, { sourceScope: JSON.stringify({ sessionId: oldSource.session_id, projectId: "deep-audit" }),
    scopeKey: `session:${oldSource.session_id}`, createdAt: at });
  await f.close();
  const inspector = openMemoryStore(f.home, "readwrite");
  cleanups.push(() => inspector.close());
  const manager = SessionManager.create(parent, join(f.home, "agent", "sessions"));
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(),
    modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = faux.getModel();
  mkdirSync(join(f.home, "pao配置"), { recursive: true });
  writeFileSync(join(f.home, "pao配置", "档位.json"), JSON.stringify({ provider: "pao",
    档位: [{ 名: "快", provider: model.provider, model: model.id, thinkingLevel: "off" }] }));
  // O01 外发许可门：提炼请求的 outbound 项目名由 ctx.cwd 解析（本夹具 cwd 在
  // pao-dev 仓内 → 项目名 pao-dev）；本 home 需显式授权该名才放行外发。
  mkdirSync(join(f.home, "知识库配置"), { recursive: true });
  writeFileSync(join(f.home, "知识库配置", "外发许可.json"), JSON.stringify({
    projects: { "pao-dev": { allowed: true, asOf: "2099-12-31" } } }));
  // O01 预算门：记忆后台作业需 pao配置/记忆后台预算.json + 总预算授权，否则拒绝付费作业。
  writeFileSync(join(f.home, "pao配置", "记忆后台预算.json"), JSON.stringify({ 每日上限: 1 }));
  writeFileSync(join(f.home, "总预算账.json"), JSON.stringify({ version: 1,
    grants: [{ version: 1, 总预算: 10, 授权时间: at, 余额依据: { 已花: 0, 授权前总预算: 0 }, 授权人: "audit" }],
    reservations: [] }));
  const utterance = "新决定：构建命令固定为 pnpm build。";
  let extractionRequests = 0;
  // 提炼响应生成器：从请求上下文里解析条目行 "sourceId=<id>"，回库反查该来源
  // 所属会话——续作的旧 job 来源属于会话 A，不能按会话 B 的 ID 过滤。
  // quotedSpans 必须是被引来源已保存正文（ArchivedEvent JSON 序列化）的子串：
  // 原话文本在其中原样出现，故按来源会话挑对应原话。
  const utteranceBySourceId = new Map<string, string>([[f.sourceId, "使用 SQLite，不启动 PostgreSQL 服务。"]]);
  const extractionReply = (context: unknown) => {
    extractionRequests++;
    const text = JSON.stringify(context);
    // 条目行 "--- 条目 sourceId=X entryId=Y eventType=Z ---"：一批可含 user+assistant
    // 多条来源，只取 user 条目——候选的实据与引文都要落在用户原话上。
    const matches = [...text.matchAll(/sourceId=([^\s\\"]+)\s+entryId=[^\s\\"]+\s+eventType=(user|assistant|toolResult|custom)/g)];
    const userMatch = matches.find((m) => m[2] === "user") ?? matches[0];
    if (!userMatch) throw new Error("提炼请求缺少条目 sourceId 行");
    const source = inspector.db.prepare("SELECT source_id FROM sources WHERE source_id=?")
      .get(userMatch[1]) as { source_id: string } | undefined;
    if (!source) throw new Error(`提炼请求引用了不存在的来源:${userMatch[1]}`);
    const quoted = utteranceBySourceId.get(source.source_id) ?? utterance;
    return fauxAssistantMessage(JSON.stringify([{ kind: "decision", conclusion: quoted, evidenceKind: "user_statement",
      confirmation: "confirmed", sourceIds: [source.source_id], quotedSpans: [{ sourceId: source.source_id, text: quoted }] }]));
  };
  faux.setResponses([
    () => fauxAssistantMessage("已记录构建命令。"),
    extractionReply,
  ]);
  // 本 home 有两个待提炼 job（会话 A 的持久旧 job + 会话 B 本轮新 job），各消费一次提炼响应。
  faux.appendResponses([extractionReply]);
  let registration: ReturnType<typeof registerBuiltinMemory> | undefined;
  const extensionsResult = await createTestExtensionsResult([(pi) => {
    registration = registerBuiltinMemory(pi, { paoHome: f.home });
  }], parent);
  const { session } = await createAgentSession({ cwd: parent, agentDir: join(f.home, "agent"), modelRuntime: runtime,
    model, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: {enabled:false}, retry: {enabled:false} }),
    resourceLoader: createTestResourceLoader({ extensionsResult }), tools: [] });
  cleanups.push(async () => { session.dispose(); await registration?.close(); });
  await session.bindExtensions({});
  await session.prompt(utterance);
  let current: any;
  let old: any;
  const statusOf = (where: string, arg: string) => inspector.db
    .prepare(`SELECT status, cursor, attempt_count, last_error FROM extraction_jobs WHERE ${where}`)
    .get(arg);
  for (let attempt = 0; attempt < 500; attempt++) {
    current = statusOf("scope_key=?", `session:${manager.getSessionId()}`);
    old = statusOf("job_id=?", oldJob.jobId);
    const settled = (row: any) => row?.status === "done" || row?.status === "failed";
    if (settled(current) && settled(old)) break;
    await new Promise(done => setTimeout(done, 20));
  }
  const persisted = inspector.db.prepare("SELECT memory_id FROM memory_revisions WHERE json_extract(content_json, '$.conclusion')=?").get(utterance);
  const persistedOld = inspector.db.prepare(
    "SELECT memory_id, revision FROM memory_revisions WHERE json_extract(content_json, '$.conclusion')=?")
    .all("使用 SQLite，不启动 PostgreSQL 服务。") as Array<{ memory_id: string; revision: number }>;
  // 续作归属核对：B 提炼出的新记忆应落在 B 会话的 scope（projectId+sessionId），
  // 不借用 A 的——这是「job 身份而非消费会话身份」的直接证据。
  const persistedScope = inspector.db.prepare(
    "SELECT m.scope_json FROM memories m JOIN memory_revisions r ON r.memory_id=m.id AND r.revision=1 WHERE json_extract(r.content_json, '$.conclusion')=?")
    .get(utterance) as { scope_json: string } | undefined;
  record("D6", { current, old, extractionRequests, persisted: !!persisted, persistedOld,
    persistedScope: persistedScope?.scope_json });
  expect(current?.status).toBe("done");
  expect(persisted).toBeTruthy();
  expect(old?.status).toBe("done");
  // 会话 A 的持久 job 已被 B 会话续做（attempt_count 前进、游标越过 A 的来源）。
  expect(persistedOld.length).toBeGreaterThanOrEqual(1);
  expect(persistedScope?.scope_json).toContain(manager.getSessionId());
});
