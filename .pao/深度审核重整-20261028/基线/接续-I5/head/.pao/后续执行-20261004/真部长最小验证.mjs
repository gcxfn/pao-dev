// 用途：验证本地构建的真实部长 RPC 与已批准端点。输入：现场快档；输出：本目录 JSON 证据。
// 不加载外部扩展、技能或工具；不写共享记忆；请求共用 600/2 账本。
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MinisterHost } from '../../PAO/packages/coding-agent/dist/pao/host/host.js';

const evidence = dirname(fileURLToPath(import.meta.url));
const project = resolve(evidence, '../..');
const cli = join(project, 'PAO/packages/coding-agent/dist/bundle/cli.js');
const extension = join(project, 'PAO/packages/coding-agent/dist/pao/index.js');
const sessions = join(evidence, '真实部长会话');
mkdirSync(sessions, { recursive: true });
const sessionId = randomUUID();
const budget = join(evidence, '真实请求额度.json');
process.env.PAO_HOME = 'D:\\AI\\workspace\\pao';
process.env.PAO_REQUEST_BUDGET = JSON.stringify({path:budget, requests:600, concurrency:2});
// 从普通 SDK 脚本启动，内核必须自行定位本地 CLI，不能依赖重写宿主 argv。
const host = new MinisterHost({paoHome:process.env.PAO_HOME, 握手超时毫秒:30000});
const result = {sessionId, cli, startedAt:new Date().toISOString(), status:'未验证'};
try {
  const raised = await host.拉起({部门:'验收隔离',项目根:project,参数:[
    '--mode','rpc','--model','快','--no-tools','--no-extensions','-e',extension,
    '--no-skills','--no-prompt-templates','--session-dir',sessions,'--session-id',sessionId
  ]});
  result.start = raised;
  if (!raised.ok) throw new Error(raised.原因);
  if (raised.handle.会话标识 !== sessionId) throw new Error('RPC 会话身份不符');
  const sent = host.注入('验收隔离',project,'这是 PAO 本项目的真实集成验收。不要调用任何工具，只回复 PAO_RPC_OK。');
  if (!sent.ok) throw new Error(sent.原因);
  const deadline = Date.now()+180000;
  while (Date.now()<deadline && (host.热会话('验收隔离',project)?.累计.轮次 ?? 0)<1) {
    if (!host.热会话('验收隔离',project)) throw new Error('请求结束前子进程退出');
    await new Promise(resolveWait=>setTimeout(resolveWait,250));
  }
  const file = readdirSync(sessions).find(name=>name.endsWith(`_${sessionId}.jsonl`));
  if (!file) throw new Error('真实会话 JSONL 未落盘');
  result.sessionFile = join(sessions,file);
  const rows = readFileSync(result.sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const assistant = rows.filter(row=>row.type==='message' && row.message?.role==='assistant').at(-1)?.message;
  if (!assistant) throw new Error('未收到助手终态消息');
  result.output = (assistant.content ?? []).filter(part=>part.type==='text').map(part=>part.text).join('');
  result.stopReason = assistant.stopReason;
  result.usage = assistant.usage;
  result.error = assistant.errorMessage;
  if (result.output.trim()!=='PAO_RPC_OK' || ['error','aborted'].includes(assistant.stopReason)) throw new Error('真实请求结果不符合验收');
  result.status='通过';
} catch(error) {
  result.status='失败'; result.failure=String(error); process.exitCode=1;
} finally {
  result.stopped = await host.stopAll('本轮真实最小验证结束');
  result.remaining = host.list();
  try {result.budget=JSON.parse(readFileSync(budget,'utf8'));} catch(error) {result.budgetReadError=String(error);}
  result.finishedAt=new Date().toISOString();
  writeFileSync(join(evidence,`真部长最小验证-${sessionId}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
