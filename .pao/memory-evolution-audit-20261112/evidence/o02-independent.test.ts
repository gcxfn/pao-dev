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
  const root = mkdtempSync(join(dir, "o02-independent-")); roots.push(root);
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
  writeFileSync(join(dir,"o02-independent-results.json"),JSON.stringify({node:process.version,results},null,2));
  for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});

it("I1：同一批讨论后明确确认，最终应保留确认及其来源",async()=>{
  const f=fixture(); const proposal=f.source("可以考虑 SQLite，但先不定。"); const confirmed=f.source("现在确认使用 SQLite，单机部署。");
  const out=await commit(f,[proposal,confirmed],[raw(proposal,{confirmation:"tentative"}),raw(confirmed)]);
  const got=await saved(f); results.push({id:"I1",out,got});
  expect(got.memory.content.confirmation).toBe("confirmed");
  expect(got.sourceSummaries.map((s:any)=>s.sourceId)).toContain(confirmed.sourceId);
});

it("I2：同批同结论的新条件进入重议，不能按纯重复丢弃",async()=>{
  const f=fixture(); const original=f.source("单机部署时使用 SQLite。"); const changed=f.source("部署改成多机，重新讨论 SQLite 的适用条件。");
  const out=await commit(f,[original,changed],[raw(original),raw(changed,{conditions:"多机部署"})]);
  const got=await saved(f); results.push({id:"I2",out,got});
  expect(got.memory.content.needsReDiscussion).toBe(true);
  expect(got.sourceSummaries.map((s:any)=>s.sourceId)).toContain(changed.sourceId);
});

it("I3：只有助手工具调用，不能自动成为已确认的用户陈述",async()=>{
  const f=fixture(); f.manager.appendMessage(userMsg("请比较数据库方案，目前还没有最终选择。"));
  const call=assistantMsg("我推测使用 SQLite 更适合，暂未得到用户确认。");
  call.content=[{type:"toolCall",id:"remember-inference",name:"pao_memory_write",arguments:{content:"我推测使用 SQLite 更适合"}}] as never;
  f.manager.appendMessage(call); f.manager.flush();
  const tools=new Map<string,any>();
  const pi={registerTool:(tool:any)=>tools.set(tool.name,tool),on:()=>()=>undefined,registerCommand:()=>undefined} as never;
  const registration=registerBuiltinMemory(pi,{paoHome:f.root}); closers.push(()=>registration.close());
  const out=await tools.get("pao_memory_write").execute("remember-inference",{content:"我推测使用 SQLite 更适合"},undefined,undefined,
    {cwd:f.root,sessionManager:f.manager,modelRegistry:{find:()=>undefined}});
  if(out.isError){results.push({id:"I3",out});return;}
  const got=await saved(f); results.push({id:"I3",out,got});
  expect(got.memory.content.confirmation).not.toBe("confirmed");
});

it("I4：模型推断的条件变化不自动重议用户已确认决定",async()=>{
  const f=fixture(); const original=f.source("确认在单机部署时使用 SQLite。");
  await commit(f,[original],[raw(original)]); const before=await saved(f);
  const guess=f.source("我猜多机部署也可以使用 SQLite。","assistant");
  const out=await commit(f,[guess],[raw(guess,{conditions:"多机部署",evidenceKind:"model_inference",confirmation:"tentative"})],
    [{memoryId:before.memory.id,kind:before.memory.kind,currentRevision:before.memory.currentRevision,
      conclusion:before.memory.content.conclusion,conditions:before.memory.content.conditions,
      confirmation:before.memory.content.confirmation,usageState:before.memory.usageState}]);
  const got=await saved(f); results.push({id:"I4",out,got});
  expect(got.memory.content.needsReDiscussion).not.toBe(true);
  expect(got.memory.currentRevision).toBe(before.memory.currentRevision);
});
