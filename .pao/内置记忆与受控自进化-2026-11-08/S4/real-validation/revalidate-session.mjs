import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemblePaoSession, closeRuntime, closeSession, createReadOnlyModelRuntime, isolatedLayout, observeStreamSimple, waitForExtractionJob } from "../../../../PAO/packages/coding-agent/scripts/memory-acceptance-runtime.mjs";
import { SessionManager } from "../../../../PAO/packages/coding-agent/dist/index.js";
import { openMemoryStore } from "../../../../PAO/packages/coding-agent/dist/pao/memory/store.js";

// 在原有真实语料及同一会话上核对当前构建；新请求证据独立保存，不覆盖原始批次。
const directory = fileURLToPath(new URL(".", import.meta.url));
const [previousName, nextName, prompt] = process.argv.slice(2, 5);
if (!process.argv.includes("--allow-real") || ![previousName, nextName].every((name) => typeof name === "string" && /^[a-zA-Z0-9-]+$/.test(name)) || !prompt) throw new Error("用法：node <本文件> <原runId> <新runId> <提示> --allow-real");
const previousRoot = join(directory, "runs", previousName);
const nextRoot = join(directory, "runs", nextName);
if (existsSync(nextRoot)) throw new Error(`结果目录已存在：${nextRoot}`);
const previous = JSON.parse(readFileSync(join(previousRoot, "basic-scenario.json"), "utf8"));
const target = previous.sessions.at(-1);
if (!target?.sessionFile || !existsSync(target.sessionFile)) throw new Error("原实际会话文件不可用");
const layout = isolatedLayout(previousRoot);
Object.assign(process.env, layout.childEnvironment, { PI_NO_LOCAL_LLM: "1", PI_TELEMETRY: "0", PAO_ENV_FILE: resolve(directory, "../../../../PAO/.env"), PAO_OUTBOUND_CONFIG: join(directory, "config/fixture-outbound.json") });
delete process.env.PI_OFFLINE;
mkdirSync(nextRoot, { recursive: true });
const evidence = { scenarioId: previous.scenarioId ?? previous.scenario?.id, kind: "real_same_session_revalidation", corpusRun: previousName, home: layout.home, status: "running", modelRequests: [], sessions: [] };
const persist = () => writeFileSync(join(nextRoot, "basic-scenario.json"), JSON.stringify(evidence, null, 2) + "\n");
persist();
const runtime = await createReadOnlyModelRuntime({ agentDir: layout.agentDir, authPath: "C:/Users/ASUS/.pi/agent/auth.json", modelsPath: "C:/Users/ASUS/.pi/agent/models.json" });
const observer = observeStreamSimple(runtime);
const store = openMemoryStore(layout.home, "readwrite");
let session;
try {
  const manager = SessionManager.open(target.sessionFile);
  const assembled = await assemblePaoSession({ layout, sessionManager: manager, modelRuntime: runtime, model: runtime.getModel("magpie", "group/deepseek"), thinkingLevel: "low", settingsOverrides: { retry: { enabled: false }, compaction: { enabled: false } } });
  session = assembled.session;
  await session.prompt(prompt);
  const extractionJobs = await waitForExtractionJob(store, { executeReal: true, scopeKey: `session:${manager.getSessionId()}`, timeoutMs: 120000, pollIntervalMs: 250, waitForTerminal: true });
  evidence.sessions.push({ actualSessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), extractionJobs });
  evidence.status = "completed_pending_main_review";
} catch (error) {
  evidence.status = "failed";
  evidence.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  evidence.close = await closeSession(session, target.actualSessionId);
  evidence.modelRequests = observer.records;
  observer.restore();
  store.close();
  await closeRuntime(runtime);
  persist();
}
console.log(JSON.stringify({ directory: nextRoot, status: evidence.status, modelRequests: evidence.modelRequests.length, error: evidence.error?.message }));
process.exitCode = evidence.status === "completed_pending_main_review" ? 0 : 1;
