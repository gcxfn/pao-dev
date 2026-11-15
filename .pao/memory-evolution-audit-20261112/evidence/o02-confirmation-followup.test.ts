/** O02 独立业务复核：真实会话来源、校验与提交，模型输出为固定离线响应。 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { requestExtraction } from "../../../PAO/packages/coding-agent/src/pao/memory/extract-model.ts";
import { commitExtractionCandidates } from "../../../PAO/packages/coding-agent/src/pao/memory/extract-commit.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { registerBuiltinMemory } from "../../../PAO/packages/coding-agent/src/pao/memory/tools.ts";
import { assistantMsg, userMsg } from "../../../PAO/packages/coding-agent/test/utilities.ts";
import { fauxAssistantMessage } from "../../../PAO/packages/ai/src/index.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const closers: (() => unknown | Promise<unknown>)[] = [];
const results: unknown[] = [];
function ok(value: any) { if (!value.ok) throw new Error(JSON.stringify(value)); return value; }
function fixture() {
  const root = mkdtempSync(join(dir, "o02-confirmation-followup-")); roots.push(root);
  const store = openMemoryStore(root, "readwrite");
  const service = openMemoryService({ paoHome: root, mode: "readwrite" });
  closers.push(async () => { await service.close(); store.close(); });
  const manager = SessionManager.create(root, join(root, "agent", "sessions"));
  manager.appendMessage(userMsg("讨论数据库方案。")); manager.appendMessage(assistantMsg("开始分析。"));
  const capture = createCapture({ store, paoHome: root }); capture.registerSession(manager.getSessionId(), manager.getSessionFile());
  const scope = { projectId: "o02-independent", sessionId: manager.getSessionId() };
  function source(text: string, role: "user" | "assistant" = "user") {
    const entryId = manager.appendMessage(role === "user" ? userMsg(text) : assistantMsg(text)); manager.flush();
    const event = manager.getEntry(entryId)!;
    const captured = capture.captureCommittedEntry(manager.getSessionId(), event);
    if (!captured.sourceId) throw new Error("来源未采集");
    return { sourceId: captured.sourceId, text,
      ref: { sourceId: captured.sourceId, sessionId: manager.getSessionId(), entryId, eventType: role },
      entry: { sourceId: captured.sourceId, entryId, eventType: role, content: text } };
  }
  return { root, store, service, manager, scope, source };
}
function raw(source: ReturnType<ReturnType<typeof fixture>["source"]>, fields: object = {}) {
  return { kind: "decision", conclusion: "使用 SQLite", conditions: "单机部署", evidenceKind: "user_statement", confirmation: "confirmed",
    sourceIds: [source.sourceId], quotedSpans: [{sourceId: source.sourceId, text: source.text}], ...fields };
}
async function commit(f: ReturnType<typeof fixture>, sources: any[], candidates: any[], relatedMemories: any[] = []) {
  const parsed = ok(await requestExtraction({ ledger: SessionManager.inMemory(f.root),
    tierConfig: { provider: "pao", 档位: [{名:"快",provider:"test",model:"m",thinkingLevel:"off"}] } as never,
    modelRegistry: {find:()=>({}),streamSimple:()=>({result:async()=>fauxAssistantMessage(JSON.stringify(candidates))})} as never,
  }, {jobId:"independent-job",sourceSessionId:f.manager.getSessionId(),entries:sources.map(s=>s.entry),relatedMemories}));
  expect(parsed.rejected).toHaveLength(0); expect(parsed.candidates).toHaveLength(candidates.length);
  return commitExtractionCandidates(f.store,f.service,{jobId:"independent-job",scope:f.scope,
    candidates:parsed.candidates,sourceRefs:sources.map(s=>s.ref),relatedMemories,now:new Date().toISOString()});
}
function saved(f: ReturnType<typeof fixture>) {
  const rows = f.store.db.prepare("SELECT id FROM memories").all() as {id:string}[];
  expect(rows).toHaveLength(1); return f.service.getMemory({id:rows[0].id,includeHistory:true}).then(ok);
}
afterEach(async()=>{
  for(const close of closers.splice(0).reverse()) await close();
  writeFileSync(join(dir,"o02-confirmation-followup-results.json"),JSON.stringify({node:process.version,results},null,2));
  for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});

async function writeTool(f: ReturnType<typeof fixture>, content: string, correctId?: string) {
  const params = { content, ...(correctId === undefined ? {} : { correct_id: correctId }) };
  const message = assistantMsg("保存记忆。");
  message.content = [{ type: "toolCall", id: "remember-followup", name: "pao_memory_write", arguments: params }] as never;
  f.manager.appendMessage(message); f.manager.flush();
  const registered = new Map<string, any>();
  const pi = { registerTool: (tool: any) => registered.set(tool.name, tool), on: () => () => undefined,
    registerCommand: () => undefined } as never;
  const handle = registerBuiltinMemory(pi, { paoHome: f.root }); closers.push(() => handle.close());
  const result = await registered.get("pao_memory_write").execute("remember-followup", params, undefined, undefined,
    { cwd: f.root, sessionManager: f.manager, modelRegistry: { find: () => undefined } });
  expect(result.isError).not.toBe(true);
}
function related(got: any) {
  const m = got.memory;
  return [{ memoryId: m.id, kind: m.kind, currentRevision: m.currentRevision,
    conclusion: m.content.conclusion, conditions: m.content.conditions,
    confirmation: m.content.confirmation, usageState: m.usageState }];
}
it("J1：明确用户纠正经工具修订后，用户实据能使同一 ID 定案", async () => {
  const f = fixture();
  const original = f.source("确认在单机部署时使用 SQLite。");
  await commit(f, [original], [raw(original)]);
  const before = await saved(f);
  const correction = f.source("纠正刚才的决定：单机部署改用 PostgreSQL，已确认，请更新原记忆。");
  await writeTool(f, "使用 PostgreSQL", before.memory.id);
  const afterTool = await saved(f);
  const out = await commit(f, [correction], [raw(correction, { conclusion: "使用 PostgreSQL" })], related(afterTool));
  const got = await saved(f); results.push({ id: "J1", afterTool, out, got, correctionSourceId: correction.sourceId });
  expect(got.memory.id).toBe(before.memory.id);
  expect(got.memory.content.confirmation).toBe("confirmed");
  expect(got.memory.content.evidenceKind).toBe("user_statement");
  expect(got.sourceSummaries.map((s: any) => s.sourceId)).toContain(correction.sourceId);
});
it("J2：工具保存的待定经验获得后续用户明确确认后转正", async () => {
  const f = fixture();
  f.source("先比较数据库方案，尚未定案。");
  await writeTool(f, "使用 SQLite");
  const before = await saved(f);
  Object.assign(f.scope, before.memory.scope);
  const confirmation = f.source("现在明确确认使用 SQLite。");
  const out = await commit(f, [confirmation], [{ kind: "experience", conclusion: "使用 SQLite",
    evidenceKind: "user_statement", confirmation: "confirmed", sourceIds: [confirmation.sourceId],
    quotedSpans: [{ sourceId: confirmation.sourceId, text: confirmation.text }] }], related(before));
  const got = await saved(f); results.push({ id: "J2", before, out, got, confirmationSourceId: confirmation.sourceId });
  expect(got.memory.id).toBe(before.memory.id);
  expect(got.memory.content.confirmation).toBe("confirmed");
  expect(got.sourceSummaries.map((s: any) => s.sourceId)).toContain(confirmation.sourceId);
});
