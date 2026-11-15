import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assemblePaoSession, closeRuntime, closeSession, createReadOnlyModelRuntime,
  isolatedLayout, observeStreamSimple, prepareDirectories, waitForExtractionJob,
} from "../../../../PAO/packages/coding-agent/scripts/memory-acceptance-runtime.mjs";
import { SessionManager } from "../../../../PAO/packages/coding-agent/dist/index.js";
import { initializeMemoryConfig, openMemoryService, readProjectContext, resolveMemoryProjectIdentity } from "../../../../PAO/packages/coding-agent/dist/pao/memory/index.js";
import { openMemoryStore } from "../../../../PAO/packages/coding-agent/dist/pao/memory/store.js";
import { readTaskContinuation, saveTaskContinuation } from "../../../../PAO/packages/coding-agent/dist/pao/memory/task-continuation.js";
import { readOpenCommitments } from "../../../../PAO/packages/coding-agent/dist/pao/memory/commitments.js";

// 来源：真实 SDK、当前构建及隔离 SQLite/JSONL；在项目根以唯一 runId 和 --allow-real 执行。
const directory = fileURLToPath(new URL(".", import.meta.url));
const runId = process.argv[2];
if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId) || !process.argv.includes("--allow-real")) {
  throw new Error("用法：node <本文件> <唯一runId> --allow-real");
}
const manifest = JSON.parse(readFileSync(join(directory, "../../S4/packaged-validation/S4-17-passed.json"), "utf8"));
if (manifest.status !== "passed" || manifest.ticket !== "S4-17") throw new Error("S4 发行物前置验收未通过");
const runRoot = join(directory, "runs", runId);
if (existsSync(runRoot)) throw new Error(`结果目录已存在：${runRoot}`);
const layout = isolatedLayout(runRoot);
await prepareDirectories(layout);
Object.assign(process.env, layout.childEnvironment, { PI_NO_LOCAL_LLM: "1", PI_TELEMETRY: "0" });
delete process.env.PI_OFFLINE;
initializeMemoryConfig(layout.home);
writeFileSync(join(layout.home, "pao配置", "档位.json"), readFileSync(join(directory, "../../S4/real-validation/config/validation-tier.json")));
process.env.PAO_ENV_FILE = resolve(directory, "../../../../PAO/.env");
process.env.PAO_OUTBOUND_CONFIG = resolve(directory, "../../S4/real-validation/config/fixture-outbound.json");
const identity = resolveMemoryProjectIdentity(layout.workspace);
const evidence = { kind: "real_model_session_continuation", status: "running", runId, identity, sessions: [], checks: {}, cost: "unknown" };
const persist = () => writeFileSync(join(runRoot, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
persist();
const runtime = await createReadOnlyModelRuntime({ agentDir: layout.agentDir, authPath: "C:/Users/ASUS/.pi/agent/auth.json", modelsPath: "C:/Users/ASUS/.pi/agent/models.json" });
const model = runtime.getModel("magpie", "group/deepseek");
if (!model) throw new Error("未找到 magpie/group/deepseek");
const observer = observeStreamSimple(runtime);
const service = openMemoryService({ paoHome: layout.home, mode: "readwrite" });
const store = openMemoryStore(layout.home, "readwrite");
const opened = [];
const bindingOf = (manager) => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pao-project-session-binding").at(-1)?.data;
const textOf = (request) => {
  const messages = request.payload?.raw?.messages ?? [];
  const system = messages.filter((message) => message.role === "system" || message.role === "developer");
  return system.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
};
const expectedSteps = { A: "核对第一项交付的实际证据位置", B: "列出第二项交付尚缺的输入文件" };
async function createHandle(label, manager) {
  const sessionManager = manager ?? SessionManager.create(layout.workspace, layout.sessionDir);
  const handle = await assemblePaoSession({ layout, sessionManager, modelRuntime: runtime, model, thinkingLevel: "low", settingsOverrides: { retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } } });
  opened.push({ ...handle, sessionManager });
  return { ...handle, sessionManager, label };
}
async function prompt(handle, text) {
  const first = observer.records.length;
  await handle.session.prompt(text);
  const extraction = await waitForExtractionJob(store, { executeReal: true, scopeKey: `session:${handle.sessionManager.getSessionId()}`, timeoutMs: 120000, pollIntervalMs: 250, waitForTerminal: true });
  evidence.sessions.push({ label: handle.label, sessionId: handle.sessionManager.getSessionId(), binding: bindingOf(handle.sessionManager), text, requestIndexes: observer.records.slice(first).map((request) => request.requestIndex), extraction });
  persist();
  return observer.records.slice(first).filter((request) => request.callerSessionId === handle.sessionManager.getSessionId()).at(0) ?? observer.records[first];
}
async function setGoal(handle, conclusion) {
  const first = observer.records.length;
  await handle.session.prompt("/pao goal set " + conclusion);
  const result = await readProjectContext({ paoHome: layout.home, memoryService: service, projectId: identity.projectId, projectRoot: identity.projectRoot });
  if (!result.ok) throw new Error(result.error.message);
  if (result.goal?.content.conclusion !== conclusion) throw new Error("CLI 命令没有保存明确目标");
  evidence.goalCommands ??= [];
  evidence.goalCommands.push({ sessionId: handle.sessionManager.getSessionId(), command: "/pao goal set " + conclusion, modelRequests: observer.records.length - first, memoryId: result.goal.memoryId, revision: result.goal.revision, sourceIds: result.goal.sourceIds });
  evidence.checks.goalCommandsMakeNoModelRequests = evidence.goalCommands.every(command => command.modelRequests === 0);
  return { goalMemoryId: result.goal.memoryId, goalRevision: result.goal.revision, sourceIds: result.goal.sourceIds };
}
try {
  const a = await createHandle("A");
  const b = await createHandle("B");
  evidence.goalBefore = await setGoal(a, "完成当前项目的两项交付，并核对各自实际证据");
  await a.session.prompt("/pao task new");
  await b.session.prompt("/pao task new");
  const taskA = bindingOf(a.sessionManager);
  const taskB = bindingOf(b.sessionManager);
  if (!taskA || !taskB || taskA.taskId === taskB.taskId) throw new Error("A/B 未建立不同的显式任务");
  evidence.tasksBefore = { A: taskA, B: taskB };
  for (const handle of [a, b]) {
    const nextStep = expectedSteps[handle.label];
    await prompt(handle, `当前任务的实际进度：材料已经整理，尚未验收。下一步：${nextStep}。记下一项尚未完成的承诺：${nextStep}。请只确认这些事实，不执行操作。`);
    const source = store.db.prepare("SELECT source_id FROM sources WHERE session_id = ? AND event_type = 'user' ORDER BY captured_at DESC, source_id DESC LIMIT 1").get(handle.sessionManager.getSessionId());
    if (!source) throw new Error(`任务 ${handle.label} 缺少真实用户来源`);
    const task = bindingOf(handle.sessionManager);
    const saved = await saveTaskContinuation({ paoHome: layout.home, memoryService: service, executionRoot: layout.workspace, task: { kind: "session", sessionId: task.sessionId, taskId: task.taskId }, workpoint: { text: "材料已经整理，尚未验收", evidenceKind: "user_statement", evidenceRefs: [source.source_id] }, nextStep: { text: nextStep, evidenceKind: "user_statement", evidenceRefs: [source.source_id] }, sourceIds: [source.source_id] });
    if (!saved.ok) throw new Error(saved.error.message);
  }
  evidence.commitmentsBefore = {};
  for (const [label, task] of Object.entries({ A: taskA, B: taskB })) {
    evidence.commitmentsBefore[label] = await readOpenCommitments({ paoHome: layout.home, projectId: identity.projectId, taskId: task.taskId });
  }
  evidence.checks.actualCommitmentExtractedForA = evidence.commitmentsBefore.A.ok && evidence.commitmentsBefore.A.commitments.length > 0;
  evidence.checks.actualCommitmentExtractedForB = evidence.commitmentsBefore.B.ok && evidence.commitmentsBefore.B.commitments.length > 0;
  evidence.checks.taskIdsDistinct = taskA.taskId !== taskB.taskId && taskA.taskId !== taskA.sessionId && taskB.taskId !== taskB.sessionId;
  const requestA = await prompt(a, "继续当前任务。只说明目前进度和紧接着应做的具体一步，不调用工具或开始执行。");
  const requestB = await prompt(b, "继续当前任务。只说明目前进度和紧接着应做的具体一步，不调用工具或开始执行。");
  evidence.checks.aReceivesOwnNextStep = textOf(requestA).includes(expectedSteps.A);
  evidence.checks.bReceivesOwnNextStep = textOf(requestB).includes(expectedSteps.B);
  evidence.checks.aDoesNotReceiveOtherTaskNextStep = !textOf(requestA).includes(expectedSteps.B);
  evidence.checks.bDoesNotReceiveOtherTaskNextStep = !textOf(requestB).includes(expectedSteps.A);
  evidence.continueAnswers = { A: requestA.output?.text, B: requestB.output?.text };
  evidence.compaction = await a.session.compact();
  const sessionFile = a.sessionManager.getSessionFile();
  evidence.closeBeforeRestart = await closeSession(a.session, a.sessionManager.getSessionId());
  opened.splice(opened.findIndex((handle) => handle.session === a.session), 1);
  evidence.goalAfter = await setGoal(b, "当前项目先核对第二项交付的输入，再继续第一项证据核查");
  const reopened = await createHandle("A-reopened", SessionManager.open(sessionFile));
  const requestAfter = await prompt(reopened, "继续原任务。按当前项目目标说明这个任务的实际下一步，仅作说明，不执行操作。");
  evidence.taskAfterRestart = bindingOf(reopened.sessionManager);
  evidence.continueAnswerAfterRestart = requestAfter.output?.text;
  evidence.checks.restartKeepsTaskId = evidence.taskAfterRestart?.taskId === taskA.taskId;
  evidence.checks.currentGoalVisible = textOf(requestAfter).includes("当前项目先核对第二项交付的输入");
  evidence.checks.currentGoalExactRevisionVisible = textOf(requestAfter).includes(`${evidence.goalAfter.goalMemoryId} rev-${evidence.goalAfter.goalRevision}`);
  evidence.checks.exactNextStepAfterRestart = textOf(requestAfter).includes(expectedSteps.A);
  evidence.continuationAfter = await readTaskContinuation({ paoHome: layout.home, memoryService: service, projectId: identity.projectId, taskId: taskA.taskId });
  const cards = join(layout.workspace, ".pao", "卡");
  evidence.checks.noCardsCreated = !existsSync(cards) || readdirSync(cards).length === 0;
  evidence.status = Object.values(evidence.checks).every(Boolean) ? "completed_pending_main_review" : "failed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  for (const handle of opened) await closeSession(handle.session, handle.sessionManager.getSessionId());
  await service.close();
  store.close();
  observer.restore();
  await closeRuntime(runtime);
  writeFileSync(join(runRoot, "model-requests.json"), JSON.stringify(observer.records, null, 2) + "\n");
  persist();
}
console.log(JSON.stringify({ runRoot, status: evidence.status, checks: evidence.checks, error: evidence.error?.message }));
process.exitCode = evidence.status === "completed_pending_main_review" ? 0 : 1;
