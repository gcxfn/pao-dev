const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'), {DatabaseSync}=require('node:sqlite');
const base=path.resolve('PAO/packages/coding-agent/src/pao');
const cache=new Map();
async function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const mod=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file,'utf8')),{identifier:file});cache.set(file,mod);await mod.link(async(id,ref)=>{if(id==='../memory/sources.ts'){const m=new vm.SyntheticModule(['getSource'],function(){this.setExport('getSource',(db,id)=>db.prepare('SELECT * FROM sources WHERE source_id = ?').get(id))});return m;}if(id.startsWith('.'))return load(path.resolve(path.dirname(ref.identifier),id));const ns=await import(id);return new vm.SyntheticModule(Object.keys(ns),function(){for(const k of Object.keys(ns))this.setExport(k,ns[k])})});return mod;}
(async()=>{const sql=fs.readFileSync(path.join(base,'memory/store.ts'),'utf8').match(/const SCHEMA_SQL = `([\s\S]*?)`;/)[1];
const db=new DatabaseSync(':memory:');db.exec(sql);db.exec('PRAGMA foreign_keys=ON');
const store={db,transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
const at='2026-11-12T00:00:00.000Z';
db.prepare("INSERT INTO evolution_resources(resource_id,kind,relative_root,allowed_ops_json,capability_scope_json,load_method,effective_version,auto_evolution_enabled,registered_at,updated_at) VALUES('skill:a','skill','pao配置/skills/a','[\"edit-content\"]','[]','skill-path','v-base',1,?,?)").run(at,at);
const modules=[];for(const name of ['problems','evaluate','select']){const m=await load(path.join(base,'evolution',name+'.ts'));await m.evaluate();modules.push(m.namespace)}const [probs,ev,sel]=modules;
const intent={kind:'implementation_defect',action:'modify',summary:'real failure',expectedBehavior:'correct output',actualBehavior:'wrong output',evidenceRefs:['friction:card:a'],resourceId:'skill:a',baseVersion:'v-base'};
const p=probs.declareImprovementIntent(store,intent);probs.declareImprovementIntent(store,intent);
console.log(JSON.stringify({case:'same-evidence-replayed',...db.prepare('SELECT occurrence_count FROM evolution_problems WHERE problem_id=?').get(p.problemId)}));
probs.classifyProblem(store,{problemId:p.problemId});const selected=sel.selectImprovement(store,{problemId:p.problemId});console.log(JSON.stringify({case:'select-before-freeze',selection:selected,problem:db.prepare('SELECT status FROM evolution_problems WHERE problem_id=?').get(p.problemId)}));
function evaluate(id,results){db.prepare("INSERT INTO evolution_candidates(candidate_id,problem_id,resource_id,base_version,test_plan_id,diffs_json,rationale,usage_refs_json,status,created_at,updated_at) VALUES(?,?,'skill:a','v-base','tp-frozen','[]','test','[]','proposed',?,?)").run(id,p.problemId,at,at);const r=ev.evaluateCandidate(store,{candidateId:id,testPlanId:'tp-frozen',caseResults:results});console.log(JSON.stringify({case:id,ok:r.ok,verdict:r.verdict,score:r.score?.total,status:db.prepare('SELECT status FROM evolution_candidates WHERE candidate_id=?').get(id)?.status}));}
evaluate('empty-results',[]);
evaluate('missing-normal-and-holdout',[{caseId:'reproduction-0',baseline:{passed:false,exitCode:1},candidate:{passed:true,exitCode:0},verdict:'passed'}]);
evaluate('start-error-as-baseline',[{caseId:'reproduction-0',baseline:{passed:false,exitCode:127,output:'',failureReason:'failureKind=start'},candidate:{passed:true,exitCode:0},verdict:'passed'}]);
evaluate('holdout-is-failed',[{caseId:'reproduction-0',baseline:{passed:false,exitCode:1},candidate:{passed:true,exitCode:0},verdict:'passed'},{caseId:'normal-0',baseline:{passed:true},candidate:{passed:true},verdict:'passed'},{caseId:'holdout-0',baseline:{passed:true},candidate:{passed:false,exitCode:1},verdict:'failed'}]);db.close();})().catch(e=>{console.error(e);process.exitCode=1});
