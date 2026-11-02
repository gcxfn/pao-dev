// 用途：只读审阅当前源码的临时计划边界；输入为真实注册工具及模拟宿主确认/后台受理面。
// 输出仅在本审阅目录内；不连接真实模型、正式 PAO_HOME，不修改生产源码。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
const root=mkdtempSync(join(here,'隔离样本-'));
const src='file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/';
const {createDept}=await import(src+'dept/scaffold.ts');
const plan=await import(src+'workflow/plan.ts');
const feedback=await import(src+'workflow/plan-feedback.ts');
const {registerPlanTools}=await import(src+'workflow/plan-tools.ts');
const home=join(root,'home'), project=join(root,'project'), other=join(root,'other-project');
mkdirSync(join(home,'pao配置'),{recursive:true});
mkdirSync(project,{recursive:true});mkdirSync(other,{recursive:true});
writeFileSync(join(home,'pao配置','档位.json'),JSON.stringify({档位:[{名:'快',provider:'offline',model:'fake',thinkingLevel:'off'}]}));
await createDept({paoHome:home,名字:'写作部',默认档位:'快'});
const output=[];
const emit=v=>{output.push(v);console.log(JSON.stringify(v));};
function toolsFor(owner='owner-A',onAccept,onConfirm){
 const tools=new Map(); let accepted=0;
 registerPlanTools({registerTool:t=>tools.set(t.name,t),on:()=>{}},{resolvePaoHome:()=>home,resolveProjectRoot:()=>project,resolveOwnerSessionId:()=>owner,
  requestConfirmation:async r=>{if(onConfirm)await onConfirm();return {计划ID:r.计划ID,定义版本:r.定义版本,启动请求ID:r.启动请求ID,来源:'宿主确认回调',时刻:'2026-10-17 00:00'};}},
  {queueReview:()=>{},background:{accept:async()=>{accepted++;if(onAccept)await onAccept();return '模拟后台受理';},waitForAutoChain:async()=>{}}});
 return {tools,accepted:()=>accepted};
}
const registered=toolsFor();
const invoke=async (set,name,p,signal)=>{const r=await set.tools.get(name).execute('audit-call',p,signal);return r.content[0].text;};
const step=(title,requirement=title)=>({title,dept:'写作部',requirement});
let counter=0;
async function create(steps=[step('写初稿')],params={}){
 const text=await invoke(registered,'pao_plan_create',{request_id:`create-${++counter}`,display_name:'隔离审阅',steps,...params});
 const id=/计划ID：(p-[\w-]+)/.exec(text)?.[1];assert.ok(id);return id;
}
// 已取消工具仍形成真实控制文件；后台与确认是明确模拟，未运行任何 Worker。
const canceledId=await create();const canceled=new AbortController();
let releaseConfirm,enteredConfirm;
const confirmEntered=new Promise(resolve=>enteredConfirm=resolve);
const confirmGate=new Promise(resolve=>releaseConfirm=resolve);
const cancellationTools=toolsFor('owner-A',undefined,async()=>{enteredConfirm();await confirmGate;});
const canceledPending=invoke(cancellationTools,'pao_plan_start',{plan_id:canceledId,definition_version:1,start_request_id:'cancel-start'},canceled.signal);
await confirmEntered;canceled.abort();releaseConfirm();
const canceledText=await canceledPending;
const canceledControl=plan.readPlanInstanceIdentity(plan.planExecDir(project,canceledId,'cancel-start'),plan.planRecipeName(canceledId));
assert.ok(canceledControl);emit({case:'取消后启动',abortedDuringConfirmation:true,controlCreated:true,reportedAccepted:canceledText.includes('已受理')});
// 同一计划换启动请求 ID 可产生第二实例。
const twiceId=await create();
await invoke(registered,'pao_plan_start',{plan_id:twiceId,definition_version:1,start_request_id:'start-A'});
await invoke(registered,'pao_plan_start',{plan_id:twiceId,definition_version:1,start_request_id:'start-B'});
const twice=plan.queryTemporaryPlan(project,twiceId).启动;
assert.equal(twice.length,2);assert.notEqual(twice[0].实例,twice[1].实例);
emit({case:'同计划多次启动',instances:twice.map(x=>x.实例),requests:twice.map(x=>x.启动请求ID)});
// 别的主控可改来源 owner-A 的计划；project_root 也可覆盖宿主绑定的 project。
const ownerId=await create();const foreign=toolsFor('owner-B');
await invoke(foreign,'pao_plan_update',{plan_id:ownerId,request_id:'foreign-update',expected_version:1,action:'modify',display_name:'另一个主控改写'});
const modified=plan.readTemporaryPlan(project,ownerId);assert.equal(modified.显示名,'另一个主控改写');
const outsideId=await create([step('写其他项目')],{project_root:other});
assert.ok(plan.readTemporaryPlan(other,outsideId));
emit({case:'会话与项目归属',sourceOwner:modified.来源会话,actor:'owner-B',versionAfter:modified.定义版本,projectOverrideCreated:true});
// 稳定 ID 按位置分配：插入步骤会把旧意见接到另一个任务上。
const idId=await create([step('人物设定'),step('正文初稿')]);
const oldFeedback=await feedback.recordPlanFeedback({项目根:project,计划ID:idId,目标:{类型:'步骤',步骤ID:'s2'},正文:'正文初稿的意见'});
await invoke(registered,'pao_plan_update',{plan_id:idId,request_id:'insert-step',expected_version:1,action:'modify',steps:[step('新增准备'),step('人物设定'),step('正文初稿')]});
const after=plan.readTemporaryPlan(project,idId);assert.equal(after.步骤.find(s=>s.步骤ID===oldFeedback.entry.目标.步骤ID).标题,'人物设定');
emit({case:'插入步骤后意见错绑',feedbackTarget:'s2',before:'正文初稿',after:after.步骤.find(s=>s.步骤ID==='s2').标题});
// 意见状态无需真实宿主投递/改动，模型参数即可设成成功。
const fbId=await create();
await invoke(registered,'pao_plan_feedback',{plan_id:fbId,action:'record',step_id:'s1',text:'修改人物动机',deliver_request_id:'delivery-A'});
const entry=feedback.listPlanFeedback(project,fbId)[0];
await invoke(registered,'pao_plan_feedback',{plan_id:fbId,action:'delivery',feedback_id:entry.意见ID,delivered:true,result:'自述已送达'});
await invoke(registered,'pao_plan_feedback',{plan_id:fbId,action:'apply',feedback_id:entry.意见ID,evidence:'自述已修改'});
assert.equal(feedback.listPlanFeedback(project,fbId)[0].状态,'已应用');
emit({case:'意见状态可信性',status:'已应用',realDeliveryCalls:0,realArtifactChanges:0});
// 写入过的旧定义没有留存；undo 取消整份计划，不是撤回最近修改。
const undoId=await create([step('旧正文要求')]);
await invoke(registered,'pao_plan_update',{plan_id:undoId,request_id:'edit-once',expected_version:1,action:'modify',steps:[step('新正文要求')]});
await invoke(registered,'pao_plan_update',{plan_id:undoId,request_id:'undo-once',expected_version:2,action:'undo'});
const undone=plan.readTemporaryPlan(project,undoId);assert.equal(undone.已撤销,true);assert.equal(undone.步骤[0].标题,'新正文要求');
emit({case:'撤销语义',planCanceled:undone.已撤销,titleStillNew:undone.步骤[0].标题,files:readdirSync(plan.planDir(project,undoId))});
// 工具建议把绝对路径改占位符，但模板发射器始终声明空参数。
const templateId=await create([step('输出正文','在 {项目}/正文.md 写入首章')]);
let templateError;
try{await invoke(registered,'pao_plan_save_template',{plan_id:templateId,definition_version:1,template_name:'参数化小说模板',allow_project_specific_paths:true});}catch(e){templateError=e.message;}
assert.match(templateError??'',/未声明|参数/);
emit({case:'模板参数化',error:templateError});
// 计划查询工具没有交回要求/约束/验收字段，模型无法仅靠 query 恢复这些事实。
const queryId=await create([step('正文','关键要求-不能遗失-7349')]);
const queryText=await invoke(registered,'pao_plan_query',{plan_id:queryId});
assert.equal(queryText.includes('关键要求-不能遗失-7349'),false);
emit({case:'查询恢复信息',hasRequirement:false,actualStoredRequirement:plan.readTemporaryPlan(project,queryId).步骤[0].要求});
// 构造真实可发生的时序：控制文件形成到启动关联落盘之间，有另一主控编辑。
const raceId=await create();
const race=toolsFor('owner-A',async()=>{await plan.modifyTemporaryPlan({项目根:project,计划ID:raceId,请求ID:'during-start',预期定义版本:1,显示名:'启动期间修改成功',已注册部门:['写作部']});});
await invoke(race,'pao_plan_start',{plan_id:raceId,definition_version:1,start_request_id:'race-start'});
const raceDefinition=plan.readTemporaryPlan(project,raceId),raceStart=plan.queryTemporaryPlan(project,raceId).启动[0];
assert.equal(raceDefinition.定义版本,2);assert.equal(raceStart.定义版本,1);
emit({case:'启动编辑竞态',definitionVersion:raceDefinition.定义版本,startedVersion:raceStart.定义版本});
const {opinionInstruction}=await import('file:///D:/AI/workspace/pao-dev/desktop/apps/desktop/src/features/workflow-cards/workflow-cards-model.ts');
const modelPlan={planId:'probe-plan',displayName:'审阅',definitionVersion:1,steps:[{stepId:'s1',title:'首章',dept:'写作部'}]};
const flowOpinion=opinionInstruction(modelPlan,{kind:'flow'},'整体意见');
const fileOpinion=opinionInstruction(modelPlan,{kind:'file',path:'首章.md'},'文件意见');
assert.ok(flowOpinion.includes('步骤ID=）'));
emit({case:'意见指令丢失对象',flowOpinion,fileOpinion});
writeFileSync(join(here,'复现结果.json'),JSON.stringify({date:'2026-10-17',fixture:root,simulation:'宿主确认与后台受理面为模拟；定义、控制、关联、意见均由真实工具写盘',results:output},null,2));
emit({fixture:root});
