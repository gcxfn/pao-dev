// 正式CLI零模型控制拒绝验收；不确认人工门，不修改旧运行数据。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {parseRecipe} from '../../PAO/packages/coding-agent/dist/pao/workflow/recipe.js';
import {readControl} from '../../PAO/packages/coding-agent/dist/pao/workflow/control.js';
const base='D:/AI/workspace/pao-dev/.pao/后续执行-20261004';
const prep=JSON.parse(readFileSync(join(base,'三模板-bugfix-real-20261004/准备.json'),'utf8'));
const data=join(prep.work,'.pao/业务验收'),cards=join(data,'卡'),name='业务修复-real-20261004';
const home='D:/AI/workspace/pao',kernel='D:/AI/workspace/pao-dev/PAO/packages/coding-agent';
const recipe=parseRecipe(readFileSync(join(home,'工作流',name+'.md'),'utf8'),join(home,'工作流',name+'.md'));
const flow=readControl(recipe,{cardsDir:cards});
const out=join(base,'S2-正式CLI拒绝-'+randomUUID());mkdirSync(out);mkdirSync(join(out,'私有配置'));
writeFileSync(join(out,'私有配置/auth.json'),'{}');
const snapshot=()=>{const rows=[];const walk=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile())rows.push({path:relative(data,p),sha256:createHash('sha256').update(readFileSync(p)).digest('hex')});}};walk(data);return rows.sort((a,b)=>a.path.localeCompare(b.path));};
const budget=()=>JSON.parse(readFileSync(join(base,'真实请求额度.json'),'utf8'));
const result={started:new Date().toISOString(),before:snapshot(),budgetBefore:budget(),instance:flow.实例,oldOwner:flow.owner,cases:[],events:[],boundary:'真实旧实例/正式CLI；错误实例先拒绝，owner及轮次错参案若停人工门只证明未越门'};
const child=spawn(process.execPath,[join(kernel,'dist/bundle/cli.js'),'--mode','rpc','--model','快','--session-dir',join(out,'会话'),'--no-skills','--no-prompt-templates'],{cwd:prep.work,windowsHide:true,stdio:['pipe','pipe','pipe','ipc'],env:{...process.env,PAO_HOME:home,PAO_ROLE:'main',PAO_CODING_AGENT_DIR:join(out,'私有配置'),PAO_SESSION_BUDGET:JSON.stringify({turns:0}),PAO_REQUEST_BUDGET:JSON.stringify({path:join(base,'真实请求额度.json'),requests:600,concurrency:2}),PAO_PRECOMPACTION:'0',PAO_OUTPUT_PRUNING:'0',PAO_MANAGED_PARENT:'1'}});
result.pid=child.pid;
let buf='',seq=0,stderr='';const pending=new Map();
child.stderr.on('data',c=>stderr+=c);
child.stdout.on('data',c=>{buf+=c;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);let e;try{e=JSON.parse(line)}catch{continue}result.events.push(e);if(e.type==='extension_ui_request')child.stdin.write(JSON.stringify({type:'extension_ui_response',id:e.id,cancelled:true})+'\n');if(e.type==='response'&&pending.has(e.id)){const p=pending.get(e.id);pending.delete(e.id);clearTimeout(p.t);p.resolve(e);}}});
const send=cmd=>new Promise((resolve,reject)=>{const id='deny-'+(++seq);const t=setTimeout(()=>reject(Error('RPC timeout')),20000);pending.set(id,{resolve,t});child.stdin.write(JSON.stringify({...cmd,id})+'\n')});
try{
 await send({type:'get_state'});
 const commands=[{label:'错误实例',params:{动作:'确认',实例:'wrong-'+flow.实例,节点:flow.节点[0].名字,轮次:1}}, {label:'错误原owner（不确认人工门）',params:{动作:'恢复',实例:flow.实例,原owner:'wrong-'+flow.owner,理由:'只验证拒绝，不授权恢复'}}, {label:'错误轮次（不确认人工门）',params:{动作:'确认',实例:flow.实例,节点:flow.节点[0].名字,轮次:flow.节点[0].轮次+100}}];
 for(const c of commands){const from=result.events.length;const response=await send({type:'prompt',message:'/pao flow control '+JSON.stringify({名字:name,卡目录:cards,...c.params})});await new Promise(r=>setTimeout(r,100));const events=result.events.slice(from);const raw=JSON.stringify(events);assert.match(raw,/节点控制实例不匹配|须用户在界面显式确认/);assert.deepEqual(snapshot(),result.before);result.cases.push({...c,response,events});}
 result.status='三案拒绝且旧数据字节不变；后两案停人工门，未验内层owner/轮次';
}catch(e){result.error=String(e);process.exitCode=1}
finally{child.stdin.end();await new Promise((resolve,reject)=>{if(child.exitCode!==null)return resolve();const t=setTimeout(()=>reject(Error('CLI退出超时')),10000);child.once('exit',(code,signal)=>{clearTimeout(t);result.exit={code,signal};resolve();});});result.after=snapshot();result.budgetAfter=budget();result.finished=new Date().toISOString();writeFileSync(join(out,'stderr.txt'),stderr);writeFileSync(join(out,'结果.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,status:result.status,error:result.error,pid:child.pid,budgetBefore:result.budgetBefore.used,budgetAfter:result.budgetAfter.used}));}

