import { it, expect } from 'D:/AI/workspace/pao-dev/PAO/node_modules/vitest/dist/index.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMemoryStore } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/store.ts';
import { registerResource, snapshotResourceFiles } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/resources.ts';
import { freezeValidationPlan } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/validation.ts';
import { runValidationCase } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/runner.ts';
import { evaluateCandidate } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/evaluate.ts';
import { publishCandidate } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/versions.ts';
import { activateCandidate } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/activation.ts';
import { bindTaskResources } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/binding.ts';
import { recordUsed } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/observe.ts';
import { handleRegression } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/evolution/regression.ts';
import { buildSystemPrompt } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/system-prompt.ts';
import { legalPassedChain, seedClassifiedProblem } from 'D:/AI/workspace/pao-dev/PAO/packages/coding-agent/test/pao/fixtures/evolution-legal-chain.ts';

const root = 'D:/AI/workspace/pao-dev/.pao/memory-evolution-audit-20261112/evidence/final-audit';
const evidence: unknown[] = [];
function log(label: string, value: unknown) { evidence.push({label, value}); console.log(label, JSON.stringify(value)); writeFileSync(join(root, 'final-evolution-kernel-results.json'), JSON.stringify(evidence, null, 2)); }
async function setup() {
 const home = mkdtempSync(join(root, 'final-evolution-home-'));
 process.env.PAO_HOME = home;
 const store = openMemoryStore(home, 'readwrite');
 const dir = join(home, 'pao配置/skills/probe'); mkdirSync(dir, {recursive:true});
 writeFileSync(join(dir, 'SKILL.md'), '---\nname: probe\ndescription: probe behavior\n---\nAnswer WRONG\n');
 const resourceId = 'skill:probe';
 registerResource(store, {kind:'skill', name:'probe', paoHome:home});
 const snap = snapshotResourceFiles(store, {resourceId, paoHome:home}); if (!snap.ok) throw Error('snapshot');
 const problemId = seedClassifiedProblem(store, {resourceId, baseVersion:snap.versionId});
 const chain = await legalPassedChain(store, home, {problemId, resourceId, baseVersion:snap.versionId, files:{'SKILL.md':'---\nname: probe\ndescription: probe behavior\n---\nAnswer STILL_WRONG\n'}});
 return {home,store,resourceId,baseVersion:snap.versionId,problemId,...chain};
}
it('缺正常组和保留组仍可发布', async () => {
 const x = await setup(); try {
 const result = await publishCandidate(x.store, {candidateId:x.candidateId,paoHome:x.home});
 log('empty-groups-publish', result); expect(result.ok && 'versionId' in result).toBe(true);
 } finally { x.store.close(); }
});
it('agent 双侧正常完成，即使旧版错误候选正确也只能 incomplete', async () => {
 const x = await setup(); try {
 x.store.db.prepare("UPDATE evolution_candidates SET status='proposed' WHERE candidate_id=?").run(x.candidateId);
 const spec = {caseId:'reproduction-0',group:'reproduction' as const,input:'Reply YES',initialFiles:{},allowedTools:[],acceptance:'Output must equal YES'};
 const results:any = {};
 for (const side of ['baseline','candidate'] as const) {
 const run = await runValidationCase(x.store, {scratchRoot:join(x.home,'scratch'),agentSessionFactory:async()=>({output:side==='baseline'?'NO':'YES',completed:true})}, {validationCase:spec,resourceId:x.resourceId,baseVersion:x.baseVersion,side,candidateId:x.candidateId,testPlanId:x.testPlanId,paoHome:x.home,kind:'agent',loadMethod:'skill-path'});
 if(!run.ok) throw Error(run.error.message); results[side]=run.result;
 }
 const ev = evaluateCandidate(x.store,{candidateId:x.candidateId,testPlanId:x.testPlanId,paoHome:x.home,caseResults:[{caseId:spec.caseId,...results,verdict:'passed'}]});
 log('agent-wrong-to-correct', {results,evaluation:ev}); expect(ev.ok && ev.verdict).toBe('incomplete');
 } finally {x.store.close();}
});
it('三组齐全时 normal/holdout 的错误 agent 答案可评估并发布', async () => {
 const x = await setup(); try {
 const c = {input:'Reply YES',initialFiles:{},allowedTools:[],acceptance:'Output must equal YES'};
 const f = freezeValidationPlan(x.store,{problemId:x.problemId,resourceId:x.resourceId,baseVersion:x.baseVersion,paoHome:x.home,reproduction:[c],normal:[c],holdout:[c]}); if(!f.ok) throw Error(f.error.message);
 x.store.db.prepare("UPDATE evolution_candidates SET status='proposed',test_plan_id=? WHERE candidate_id=?").run(f.testPlanId,x.candidateId);
 const caseResults:any[]=[];
 for(const spec of [...f.plan.reproduction,...f.plan.normal,...f.plan.holdout]) {
 const pair:any = {};
 for(const side of ['baseline','candidate'] as const) {
 const command=spec.group==='reproduction';
 const run=await runValidationCase(x.store,{scratchRoot:join(x.home,'scratch'),processRunner:async()=>({code:side==='baseline'?1:0,stdout:'',stderr:''}),agentSessionFactory:async()=>({output:'NO',completed:true})},{validationCase:spec,resourceId:x.resourceId,baseVersion:x.baseVersion,side,candidateId:x.candidateId,testPlanId:f.testPlanId,paoHome:x.home,kind:command?'command':'agent',verifier:command?{cmd:'node',args:['check.js']}:undefined,loadMethod:'skill-path'});
 if(!run.ok) throw Error(run.error.message); pair[side]=run.result;
 }
 caseResults.push({caseId:spec.caseId,...pair,verdict:'passed'});
 }
 const ev=evaluateCandidate(x.store,{candidateId:x.candidateId,testPlanId:f.testPlanId,paoHome:x.home,caseResults});
 const pub=await publishCandidate(x.store,{candidateId:x.candidateId,paoHome:x.home});
 log('wrong-output-publish',{evaluation:ev,publish:pub}); expect(ev.ok&&ev.verdict).toBe('passed'); expect(pub.ok&&'versionId' in pub).toBe(true);
 } finally{x.store.close();}
});
it('生产空工具集使已加载技能不进入系统提示', () => {
 const opts={cwd:root,skills:[{name:'probe-unique-skill',description:'Unique skill description',filePath:join(root,'SKILL.md'),baseDir:root,source:'test',disableModelInvocation:false}]};
 const without=buildSystemPrompt({...opts,selectedTools:[]}); const withRead=buildSystemPrompt({...opts,selectedTools:['read']});
 log('skill-visibility',{withoutTools:without.includes('probe-unique-skill'),withRead:withRead.includes('probe-unique-skill')});
 expect(without.includes('probe-unique-skill')).toBe(false);expect(withRead.includes('probe-unique-skill')).toBe(true);
});
it('worker 本次失败写 used 后，不需要技能退步证据即回退', async()=>{
 const x=await setup();try{
 const pub=await publishCandidate(x.store,{candidateId:x.candidateId,paoHome:x.home});if(!pub.ok||!('versionId'in pub))throw Error('publish');
 const act=await activateCandidate(x.store,{candidateId:x.candidateId,paoHome:x.home,expectedEffectiveVersion:x.baseVersion});if(!act.ok)throw Error('activate');
 bindTaskResources(x.store,{taskId:'worker-first-run',resourceIds:[x.resourceId]});
 const used=recordUsed(x.store,{resourceId:x.resourceId,taskId:'worker-first-run',receiptRef:'receipt:first-failure',outcome:'failure'});
 const result=handleRegression(x.store,{resourceId:x.resourceId,taskId:'worker-first-run',failureDescription:'测试依赖服务不可用，连接被拒绝',paoHome:x.home});
 log('unrelated-worker-failure',{used,result});expect(result.ok&&result.rolledBack).toBe(true);
 }finally{x.store.close();}
});
