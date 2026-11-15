import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openMemoryStore } from "../../../../PAO/packages/coding-agent/dist/pao/memory/store.js";
import { embedCurrentMemories, openPersistentMemoryLedger } from "../../../../PAO/packages/coding-agent/dist/pao/memory/runtime-embedding.js";
import { createFetchUsageObserver } from "../../../../PAO/packages/coding-agent/scripts/memory-acceptance-lib.mjs";
import { runSynonymAcceptance } from "../../../../PAO/packages/coding-agent/scripts/memory-semantic-validation.mjs";
const root = fileURLToPath(new URL(".", import.meta.url));
const runId = process.argv[2];
if (!process.argv.includes("--allow-real") || !/^[a-zA-Z0-9-]+$/.test(runId ?? "")) throw new Error("需要 runId 与 --allow-real");
const directory = join(root, "runs", runId);
if (existsSync(join(directory, "quality-documents.json"))) throw new Error("已有语义证据，不覆盖");
const basic = JSON.parse(readFileSync(join(directory, "basic-scenario.json"), "utf8"));
if (basic.scenario?.id !== "I06" || !Object.values(basic.scenarioEvidence.observations).every(value => value === true)) throw new Error("I06 范围验收尚未全部通过");
process.env.PAO_ENV_FILE = resolve(root, "../../../../PAO/.env");
process.env.PAO_OUTBOUND_CONFIG = join(root, "config/boundary-quality-outbound.json");
const home = join(basic.workRoot, "home");
const scope = basic.scenarioEvidence.identity.main.scope;
const aliases = Object.fromEntries([basic.scenarioEvidence.aliases.memory, basic.scenarioEvidence.aliases.otherMemory].map(entry => [entry.expected, { memoryId: entry.actual, revision: entry.revision }]));
const save = (name, data) => writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + "\n");
save("scope.json", { home, scope });
save("alias-map.json", aliases);
const store = openMemoryStore(home, "readwrite");
const observer = createFetchUsageObserver();
const ledger = openPersistentMemoryLedger(home, `s4-semantic-${runId}`);
const documents = { kind: "real_document_embedding", projects: [], requests: [] };
try {
  for (const identity of [basic.scenarioEvidence.identity.main, basic.scenarioEvidence.identity.other]) {
    const result = await embedCurrentMemories({ home, db: store.db, projectId: identity.scope.projectId, executionPath: identity.scope.executionRoot, ledger, requestId: `document-${runId}-${documents.projects.length}` });
    documents.projects.push({ scope: identity.scope, result });
    if (result.skippedByPolicy) throw new Error(result.reason ?? "未获准嵌入");
  }
} finally {
  documents.requests = observer.records;
  observer.restore();
  ledger.flush();
  store.close();
  save("quality-documents.json", documents);
}
const semantic = await runSynonymAcceptance({ paoHome: home, scope, aliasMap: aliases, executeReal: true, allowRealEmbedding: true, outputPath: join(directory, "semantic-20.json") });
const ownQueries = semantic.queries.filter(query => query.scenarioId === "I06");
const passed = ownQueries.length === 2 && ownQueries.every(query => query.status === "passed" && query.semanticEvidence);
save("main-review.json", { date: "2026-11-10", scenarioId: "I06", status: passed ? "passed" : "partial", core: "passed", criteria: basic.scenarioEvidence.observations, semantic: ownQueries.map(({ id, status, semanticEvidence }) => ({ id, status, semanticEvidence })), source: "真实模型提炼及真实外部嵌入；同名独立项目也有实际提炼与向量，主仓/worktree仍不命中该项目。", cost: "unknown" });
console.log(JSON.stringify({ runId, core: "passed", semantic: ownQueries.map(({ id, status, semanticEvidence }) => ({ id, status, semanticEvidence })) }));
