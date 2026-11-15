import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'D:/AI/workspace/pao-dev/PAO/node_modules/vitest/dist/index.js';
import { fauxAssistantMessage, fauxToolCall } from 'D:/AI/workspace/pao-dev/PAO/packages/ai/src/index.ts';
import { SessionManager } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/session-manager.ts';
import { createWriteToolDefinition } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/tools/write.ts';
import { createCard, loadCard } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/index.ts';
import { registerCardTools } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/tools.ts';
import { registerDeliveryTools } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/delivery.ts';
import { registerVerifierTools } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/cards/verifier.ts';
import { makeRegisterReceiptArtifacts, makeRegisterDeliveryArtifacts } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/artifact-registration.ts';
import { registerBuiltinMemory } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/tools.ts';
import { openMemoryStore } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/store.ts';
import { registerResource, snapshotResourceFiles } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/resources.ts';
import { ensureTaskBindings } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/host-mount.ts';

const evidence = 'D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit';
const script = "const fs=require('node:fs'); const n=Number(process.argv[2]); const result={input:n,answer:n*7+3}; fs.writeFileSync(process.argv[3],JSON.stringify(result)); console.log(JSON.stringify(result));\n";

async function host(home: string, project: string, sessions: string, id: string) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const pi: any = {registerTool: (t: any) => tools.set(t.name,t), registerCommand() {}, sendMessage() {}, appendEntry() {}, getAllTools: () => [...tools.values()], on: (n: string, h: any) => { handlers.set(n,[...(handlers.get(n)??[]),h]); return () => {}; }};
  const registration = registerBuiltinMemory(pi,{paoHome:home});
  const cardsDir=join(project,'.pao','卡');
  mkdirSync(cardsDir,{recursive:true});
  const deps={pi,registration:()=>registration,paoHome:()=>home};
  registerCardTools(pi,{resolveCardsDir:()=>cardsDir,registerReceiptArtifacts:makeRegisterReceiptArtifacts(deps)});
  registerDeliveryTools(pi,{resolveCardsDir:()=>cardsDir,registerDeliveryArtifacts:makeRegisterDeliveryArtifacts(deps)});
  registerVerifierTools(pi,{resolveCardsDir:()=>cardsDir});
  tools.set('write',createWriteToolDefinition(project));
  const sm=SessionManager.create(project,sessions,{id});
  const ctx:any={cwd:project,sessionManager:sm};
  let seq=0;
  async function run(name:string,args:any) {
    const toolCallId=`${id}-${++seq}`;
    sm.appendMessage(fauxAssistantMessage([fauxToolCall(name,args,{id:toolCallId})],{timestamp:Date.now()}));
    const result=await tools.get(name).execute(toolCallId,args,undefined,undefined,ctx);
    sm.appendMessage({role:'toolResult',toolCallId,toolName:name,content:result.content,details:result.details,isError:result.isError??false,timestamp:Date.now()});
    if(result.isError) throw new Error(JSON.stringify(result));
    return result.content.map((x:any)=>x.text??'').join('\n');
  }
  async function card(goal:string,acceptance='完成') {
    await createCard(cardsDir,{目标:goal,部门:'核心机制',验收:acceptance,创建:'2026-11-15 10:00'});
    const no=loadCard(cardsDir,goal.includes('生产')?1:goal.includes('浏览')?3:2).card_no;
    await run('pao_change_status',{cards_dir:cardsDir,card_ref:no,operator:'审核',new_status:'in_progress'});
    return no;
  }
  return {run,card,cardsDir,sm,registration,handlers,ctx,close:()=>registration.close()};
}

for(const kind of ['managed','git']) test(`O08 ${kind} 真实登记、跨任务确切回读与 node 执行`,async()=>{
 const root=mkdtempSync(join(evidence,`final-hosts-${kind}-`));
 const home=join(root,'home'), project=join(root,'project'), sessions=join(root,'sessions');
 for(const p of [home,project,sessions]) mkdirSync(p,{recursive:true});
 process.env.PAO_HOME=home;
 const git=(args:string[])=>execFileSync('git',args,{cwd:project,encoding:'utf8',windowsHide:true});
 if(kind==='git') {git(['init','--quiet']);git(['config','user.name','Audit']);git(['config','user.email','audit@local']);writeFileSync(join(project,'baseline.txt'),'baseline\n');git(['add','-A']);git(['commit','-qm','基线']);}
 const producer=await host(home,project,sessions,`${kind}-producer`);
 const events:any={kind,root,mode:'离线工具边界集成；直接驱动已注册真实工具，无模型、无真实 CLI/Electron 进程'};
 try {
  await producer.card('生产可执行成果','存在: compute.cjs');
  await producer.run('write',{path:'compute.cjs',content:script});
  events.producerReceipt=await producer.run('pao_submit_receipt',{cards_dir:producer.cardsDir,card_ref:1,attempt:1,result:'完成',summary:'compute.cjs 已写入',artifact_path:['compute.cjs']});
  expect(events.producerReceipt).toContain('成果已登记');
  if(kind==='git') {
    events.verify=await producer.run('pao_verify_card',{cards_dir:producer.cardsDir,card_ref:1,operator:'审核'});
    expect(events.verify).toContain('全过自动交付');
    events.delivery=await producer.run('pao_deliver_card',{cards_dir:producer.cardsDir,card_ref:1});
    expect(events.delivery).toContain('交卷成果已登记');
  }
 } finally {await producer.close();}
 const store=openMemoryStore(home,'readwrite');
 const row:any=store.db.prepare('SELECT * FROM artifact_versions WHERE source_tool_name = ?').get(kind==='git'?'pao_deliver_card':'pao_submit_receipt');
 expect(row).toBeDefined(); expect(JSON.parse(row.location_json).kind).toBe(kind);
 events.version=row;
 events.sources=store.db.prepare('SELECT * FROM sources').all();
 expect(events.sources.some((s:any)=>s.session_id===`${kind}-producer`&&s.event_type.startsWith('toolcall:'))).toBe(true);
 // 改写工作树，后续只能从登记的版本取得原脚本。
 writeFileSync(join(project,'compute.cjs'),"throw new Error('working tree must not be executed');\n");
 const consumer=await host(home,project,sessions,`${kind}-consumer`);
 try {
  await consumer.card('复用已登记脚本');
  events.resolved=await consumer.run('pao_memory_resolve_artifact',{version_id:row.version_id});
  expect(events.resolved).toContain(script.trim());
  expect(store.db.prepare('SELECT * FROM artifact_uses').all()).toHaveLength(0);
  const body=events.resolved.split('正文:\n')[1]?.split('\n说明:')[0];
  expect(body).toBe(script);
  await consumer.run('write',{path:'reused.cjs',content:body});
  const output=join(project,'result.json');
  const execution=spawnSync(process.execPath,[join(project,'reused.cjs'),'11',output],{cwd:project,encoding:'utf8',windowsHide:true});
  events.execution={command:[process.execPath,'reused.cjs','11',output],exitCode:execution.status,stdout:execution.stdout,stderr:execution.stderr};
  expect(execution.error).toBeUndefined();expect(execution.status).toBe(0);
  expect(JSON.parse(readFileSync(output,'utf8'))).toEqual({input:11,answer:80});
  consumer.sm.appendMessage({role:'toolResult',toolCallId:`${kind}-node-execution`,toolName:'audit-node',content:[{type:'text',text:JSON.stringify(events.execution)}],isError:execution.status!==0,timestamp:Date.now()});
  events.consumerReceipt=await consumer.run('pao_submit_receipt',{cards_dir:consumer.cardsDir,card_ref:2,attempt:1,result:execution.status===0?'完成':'失败',summary:`node exit=${execution.status}; stdout=${execution.stdout.trim()}`,artifact_path:['result.json']});
  expect(events.consumerReceipt).toContain('回执已追加');
  events.uses=store.db.prepare('SELECT * FROM artifact_uses WHERE version_id=?').all(row.version_id);
  expect(events.uses).toHaveLength(1);expect(events.uses[0].session_id).toBe(`${kind}-consumer`);
  expect(events.uses[0].task_id).not.toBe(row.origin_task_id);
 } finally {await consumer.close();}
 // 负例：另一任务仅浏览，随后交无关回执，绝不执行脚本。
 const browser=await host(home,project,sessions,`${kind}-browser`);
 try {
  await browser.card('浏览成果后完成无关任务');
  await browser.run('pao_memory_resolve_artifact',{version_id:row.version_id});
  events.usesAfterBrowse=store.db.prepare('SELECT * FROM artifact_uses WHERE version_id=?').all(row.version_id);
  expect(events.usesAfterBrowse).toHaveLength(1);
  await browser.run('pao_submit_receipt',{cards_dir:browser.cardsDir,card_ref:3,attempt:1,result:'完成',summary:'仅浏览脚本；本任务完成无关文字整理，未执行或复用脚本'});
  events.usesAfterUnrelatedReceipt=store.db.prepare('SELECT * FROM artifact_uses WHERE version_id=?').all(row.version_id);
  events.browseMisattributed=events.usesAfterUnrelatedReceipt.length!==events.usesAfterBrowse.length;
  expect(events.browseMisattributed).toBe(true);
 } finally {await browser.close();store.close();writeFileSync(join(root,'final-hosts-result.json'),JSON.stringify(events,null,2));}
},60000);

test('不同项目同号卡的真实回执登记身份',async()=>{
 const root=mkdtempSync(join(evidence,'final-hosts-project-identity-'));
 const home=join(root,'home'),sessions=join(root,'sessions');
 mkdirSync(home,{recursive:true});mkdirSync(sessions,{recursive:true});process.env.PAO_HOME=home;
 const result:any={root,projects:[]};
 for(const name of ['alpha','beta']) {
  const project=join(root,name);mkdirSync(project,{recursive:true});
  const git=(args:string[])=>execFileSync('git',args,{cwd:project,windowsHide:true});
  git(['init','--quiet']);writeFileSync(join(project,'baseline.txt'),name);
  git(['add','-A']);git(['-c','user.name=Audit','-c','user.email=audit@local','commit','-qm','基线']);
  const fx=await host(home,project,sessions,`identity-${name}`);
  try {
   await fx.card(`生产 ${name}`,'存在: output.cjs');
   await fx.run('write',{path:'output.cjs',content:`console.log('${name}');\n`});
   const receipt=await fx.run('pao_submit_receipt',{cards_dir:fx.cardsDir,card_ref:1,attempt:1,result:'完成',summary:`${name} 脚本已写`,artifact_path:['output.cjs']});
   result.projects.push({name,project,receipt});expect(receipt).toContain('成果已登记');
  } finally {await fx.close();}
 }
 const store=openMemoryStore(home,'readonly');
 try {
  result.artifacts=store.db.prepare('SELECT * FROM artifacts').all();
  result.versions=store.db.prepare('SELECT * FROM artifact_versions').all();
  result.refs=store.db.prepare('SELECT * FROM artifact_refs').all();
  expect(result.versions).toHaveLength(2);
  expect(new Set(result.versions.map((v:any)=>v.artifact_id)).size).toBe(2);
  for(const name of ['alpha','beta']) {
   const version=result.versions.find((v:any)=>v.origin_task_id.includes(`/${name}/`));
   expect(version).toBeDefined();
   const artifact=result.artifacts.find((a:any)=>a.artifact_id===version.artifact_id);
   expect(artifact.project_id.replaceAll('\\','/')).toContain(`/${name}`);
   expect(result.refs.some((r:any)=>r.version_id===version.version_id&&r.owner_id===version.origin_task_id)).toBe(true);
  }
 } finally {store.close();writeFileSync(join(root,'final-hosts-result.json'),JSON.stringify(result,null,2));}
});

test('宿主跳过 template-file 后 settled 仍记录 used',async()=>{
 const root=mkdtempSync(join(evidence,'final-hosts-skipped-use-'));
 const home=join(root,'home'),project=join(root,'project'),sessions=join(root,'sessions');
 for(const p of [home,project,sessions,join(home,'工作流')])mkdirSync(p,{recursive:true});process.env.PAO_HOME=home;
 writeFileSync(join(home,'工作流','example.md'),'# 未装载模板\n');
 const store=openMemoryStore(home,'readwrite');
 expect(registerResource(store,{kind:'template',name:'example',paoHome:home}).ok).toBe(true);
 expect(snapshotResourceFiles(store,{resourceId:'template:example',paoHome:home}).ok).toBe(true);
 const fx=await host(home,project,sessions,'template-unmounted');
 const result:any={root};
 try {
  result.mount=ensureTaskBindings(store,{taskId:'template-unmounted',paoHome:home});
  expect(result.mount.mounted).toHaveLength(0);expect(result.mount.skipped).toHaveLength(1);
  // 仅触发生产扩展的 settled 观察处理器；不制造资源加载或发布过程。
  for(const handler of fx.handlers.get('agent_settled')??[]) await handler({type:'agent_settled'},fx.ctx);
  result.observations=store.db.prepare('SELECT * FROM evolution_observations').all();
  expect(result.observations.some((o:any)=>o.resource_id==='template:example'&&o.action==='used')).toBe(true);
 } finally {await fx.close();store.close();writeFileSync(join(root,'final-hosts-result.json'),JSON.stringify(result,null,2));}
});

test('worker 显式资源清单随后被 CLI 全量 ensure 扩大',()=>{
 const root=mkdtempSync(join(evidence,'final-hosts-worker-list-'));
 const home=join(root,'home');mkdirSync(home,{recursive:true});process.env.PAO_HOME=home;
 const store=openMemoryStore(home,'readwrite');const result:any={root};
 try {
  for(const name of ['requested','unrelated']) {
   const dir=join(home,'pao配置','skills',name);mkdirSync(dir,{recursive:true});
   writeFileSync(join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`);
   expect(registerResource(store,{kind:'skill',name,paoHome:home}).ok).toBe(true);
   expect(snapshotResourceFiles(store,{resourceId:`skill:${name}`,paoHome:home}).ok).toBe(true);
  }
  result.dispatch=ensureTaskBindings(store,{taskId:'worker',paoHome:home,resourceIds:['skill:requested']});
  expect(result.dispatch.mounted.map((x:any)=>x.resourceId)).toEqual(['skill:requested']);
  // main.ts createRuntime 对同一 worker sessionId 调用的缺省口径。
  result.cli=ensureTaskBindings(store,{taskId:'worker',paoHome:home});
  expect(result.cli.mounted.map((x:any)=>x.resourceId).sort()).toEqual(['skill:requested','skill:unrelated']);
 } finally {store.close();writeFileSync(join(root,'final-hosts-result.json'),JSON.stringify(result,null,2));}
});
