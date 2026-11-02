// 用途：只读审查工作流/卡片问题的隔离复现。输入：当前 fork 源码；输出：本目录独立夹具与控制台结果。
// Worker 为明确模拟，不启动模型；git/card/control 为真实实现。不得用于正式 PAO_HOME。
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { listCards, loadCard, serializeCard } from '../../PAO/packages/coding-agent/src/pao/cards/cardfile.ts';
import { renderHandoff } from '../../PAO/packages/coding-agent/src/pao/cards/handoff.ts';
import { runAutoChain } from '../../PAO/packages/coding-agent/src/pao/workflow/auto.ts';
import { parseRecipe } from '../../PAO/packages/coding-agent/src/pao/workflow/recipe.ts';
import { startWorkflow, parseManifest, manifestPath, confirmWorkflowNode, tickWorkflow } from '../../PAO/packages/coding-agent/src/pao/workflow/driver.ts';
import { WorkerRunner } from '../../PAO/packages/coding-agent/src/pao/worker/runner.ts';
const evidence = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(evidence, 'workflow-fixture-'));
process.env.PAO_HOME = join(root, 'isolated-home');
delete process.env.PAO_ROLE; delete process.env.PAO_DEPT;
mkdirSync(process.env.PAO_HOME);
process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_CONFIG_GLOBAL = 'NUL';
const badDir = join(root, 'bad-cards'); mkdirSync(badDir);
writeFileSync(join(badDir,'卡0001-损坏任务.md'),'不可解析的卡片正文');
console.log('坏卡静默消失', JSON.stringify({ files: 1, visibleCards:listCards(badDir).length, handoff:await renderHandoff(badDir) }));
const git = (cwd,...args) => execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true,encoding:'utf8'});
const repo = join(root,'repo'); mkdirSync(repo);
writeFileSync(join(repo,'seed.txt'),'seed'); git(repo,'init'); git(repo,'add','seed.txt'); git(repo,'commit','--no-gpg-sign','-m','fixture');
class FakeRunner extends WorkerRunner {
  runs=[];
  async run(options) {
    this.runs.push(options);
    return {card_no:options.卡号,attempt:options.尝试号,status:'success',artifact_path:[],summary:'明确模拟无改动读取任务',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,cost:0,turns:1},evidence_path:join(root,'模拟证据.jsonl'),exitCode:0,command:'fake-runner',pid:-1,duration_ms:1};
  }
}
const runner = new FakeRunner();
const recipe = parseRecipe('---\n名字: 上限复现\n自动执行: true\n参数: []\n节点:\n  - 名字: A\n    部门: 测试\n    目标: 检查 A\n    验收: "存在: seed.txt"\n  - 名字: B\n    部门: 测试\n    目标: 检查 B\n    验收: "存在: seed.txt"\n---\n',join(root,'上限复现.md'));
const options={cardsDir:join(repo,'.pao','任务','卡'),counterPath:join(root,'counter.txt'),运行器:runner};
await startWorkflow(recipe,{},options);
const cap=await runAutoChain(recipe,{...options,maxCards:1});
console.log('分叉单次上限',JSON.stringify({configuredMax:1,actualRuns:runner.runs.length,steps:cap.steps,stopReason:cap.stopReason}));
const remainderOptions={...options,cardsDir:join(repo,'.pao','任务余量','卡'),counterPath:join(root,'counter-remainder.txt')};
await startWorkflow(recipe,{},remainderOptions);
const remainderPath=manifestPath(recipe,remainderOptions);
writeFileSync(remainderPath,readFileSync(remainderPath,'utf8').replace('状态: 运行中','状态: 运行中\n已派卡: 49'));
const beforeRemainder=runner.runs.length; await runAutoChain(recipe,remainderOptions);
console.log('默认实例上限',JSON.stringify({defaultCap:50,usedBefore:49,newRuns:runner.runs.length-beforeRemainder,usedAfter:parseManifest(readFileSync(remainderPath,'utf8')).已派卡}));
const denialRecipe=parseRecipe('---\n名字: 拒派计数\n自动执行: true\n参数: []\n节点:\n  - 名字: A\n    部门: 开发\n    目标: 检查\n    验收: "存在: seed.txt"\n---\n',join(root,'拒派计数.md'));
await startWorkflow(denialRecipe,{},options);
const beforeDenials=runner.runs.length;
process.env.PAO_ROLE='部长'; process.env.PAO_DEPT='审查';
for(let i=0;i<3;i++)await runAutoChain(denialRecipe,options);
console.log('拒派仍扣计数',JSON.stringify({newRuns:runner.runs.length-beforeDenials,used:parseManifest(readFileSync(manifestPath(denialRecipe,options),'utf8')).已派卡,cards:listCards(options.cardsDir).map(c=>({id:c.card_no,status:c.frontmatter.status,attempt:c.frontmatter.attempt}))}));
const gateRecipe=parseRecipe('---\n名字: 归属复现\n参数: []\n节点:\n  - 名字: A\n    部门: 开发\n    目标: 门\n    人工确认: true\n    验收: 文件存在\n  - 名字: B\n    部门: 测试\n    目标: 后续\n    depends_on: [A]\n    验收: 文件存在\n---\n',join(root,'归属复现.md'));
const oa={cardsDir:join(root,'gate-A','卡'),workspaceDir:join(root,'gate-A'),counterPath:join(root,'counter-A.txt')};
const ob={cardsDir:join(root,'gate-B','卡'),workspaceDir:join(root,'gate-B'),counterPath:join(root,'counter-B.txt')};
await startWorkflow(gateRecipe,{},oa); await startWorkflow(gateRecipe,{},ob);
// 明确模拟 B 的首卡交付，A 的首卡仍未开始。
const bc=loadCard(ob.cardsDir,1); writeFileSync(bc.path,serializeCard({...bc.frontmatter,status:'delivered'},bc.body));
try { await tickWorkflow(gateRecipe,{...oa,cardsDir:ob.cardsDir}); } catch(e) { console.log('tick拒绝跨目录',e.message); }
const cross=await confirmWorkflowNode(gateRecipe,'A',{...oa,cardsDir:ob.cardsDir});
console.log('confirm未拒绝跨目录',JSON.stringify({report:cross,A:parseManifest(readFileSync(manifestPath(gateRecipe,oa),'utf8')),actualACard:loadCard(oa.cardsDir,1).frontmatter.status,B:listCards(ob.cardsDir).map(c=>({id:c.card_no,goal:c.frontmatter.goal,status:c.frontmatter.status}))}));
console.log('隔离夹具',root);
