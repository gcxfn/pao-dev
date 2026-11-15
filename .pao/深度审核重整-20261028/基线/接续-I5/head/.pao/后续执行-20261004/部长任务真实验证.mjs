// 用途：正式构建部长任务正常/取消验收；输入：现场快档；输出：独立会话、进程、额度证据。
// 不伪造模型响应。取消在共享账本实际请求增量后触发；费用缺失如实保留。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MinisterHost } from '../../PAO/packages/coding-agent/dist/pao/host/host.js';
const base = dirname(fileURLToPath(import.meta.url));
const project = resolve(base, '../..');
const id = randomUUID();
const evidence = join(base, 'S1-部长任务', id);
mkdirSync(evidence, {recursive:true});
const sessions = join(evidence, '会话');
mkdirSync(sessions);
process.env.PAO_HOME = 'D:\\AI\\workspace\\pao';
const budgetPath = join(base, '真实请求额度.json');
process.env.PAO_REQUEST_BUDGET = JSON.stringify({path:budgetPath,requests:600,concurrency:2});
const budget = () => JSON.parse(readFileSync(budgetPath,'utf8'));
const notices = [];
const host = new MinisterHost({paoHome:process.env.PAO_HOME,握手超时毫秒:30000,通知:text=>notices.push(text)});
const result = {id,started:new Date().toISOString(),budgetBefore:budget(),status:'未完成',notices};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const alive = pid => {try {process.kill(pid,0);return true;} catch(error){if(error.code==='ESRCH') return false;throw error;}};
const sizes = () => Object.fromEntries(readdirSync(sessions).map(name=>[name,statSync(join(sessions,name)).size]));
try {
  const raised = await host.拉起({部门:'验收隔离',项目根:project,脉络:id,参数:[
    '--mode','rpc','--model','快','--no-tools','--no-extensions','-e',join(project,'PAO/packages/coding-agent/dist/pao/index.js'),
    '--no-skills','--no-prompt-templates','--session-dir',sessions,'--session-id',id
  ]});
  assert.equal(raised.ok,true,JSON.stringify(raised));
  result.handle=raised.handle;
  const task={部门:'验收隔离',项目根:project,脉络:id,会话标识:id,超时毫秒:180000};
  result.normal=await host.执行任务({...task,文本:'本项目真实RPC任务验收。不要调用工具，仅回复 PAO_TASK_OK。'});
  assert.equal(result.normal.trim(),'PAO_TASK_OK');
  await assert.rejects(host.执行任务({...task,会话标识:randomUUID(),文本:'不应发出'}),/身份失配/);
  result.wrongIdentity='真实宿主拒绝旧身份，非供应商失败验证';
  const beforeCancel=budget().used;
  const controller=new AbortController();
  const pending=host.执行任务({...task,signal:controller.signal,文本:'这是本项目取消验收的隔离样本。请从一到一千逐行写出中文数字及其阿拉伯数字，每个数字独立一行。'}).then(value=>({unexpectedSuccess:value}),error=>({rejected:String(error)}));
  const deadline=Date.now()+30000;
  while(budget().used===beforeCancel && Date.now()<deadline) await delay(50);
  assert.ok(budget().used>beforeCancel,'取消前未观察到真实模型请求');
  const cancelledAt=Date.now();
  controller.abort();
  result.cancel=await pending;
  result.cancelMilliseconds=Date.now()-cancelledAt;
  assert.ok(result.cancel.rejected,'取消任务意外返回成功');
  await host.stopAll('验收结束');
  result.remaining=host.list();
  assert.equal(result.remaining.length,0);
  assert.equal(alive(raised.handle.pid),false);
  const stoppedSizes=sizes(); const stoppedRequests=budget().used;
  await delay(2500);
  assert.deepEqual(sizes(),stoppedSizes,'停止后会话仍在写入');
  assert.equal(budget().used,stoppedRequests,'停止后继续请求');
  result.noFurtherWork={observedMilliseconds:2500,sessionSizes:stoppedSizes,requests:stoppedRequests,pidAlive:false};
  result.status='正常与取消通过；供应商失败及四退出另验';
} catch(error) {result.status='失败';result.error=String(error);process.exitCode=1;}
finally {
  result.cleanup=await host.stopAll('真实验证 finally 清理');
  result.budgetAfter=budget();result.finished=new Date().toISOString();
  writeFileSync(join(evidence,'结果.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
